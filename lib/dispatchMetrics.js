// Dispatch for Profit — tech performance scoring from ServiceTitan.
//
// Every definition here was validated against 45 days of live AHS data before
// being written; the notes record what the data actually does, not what the
// API docs imply.
//
// ── ServiceTitan traps (all verified, do not "simplify" away) ────────────────
//  - appointment-assignments: jobIds AND date filters are IGNORED. Only
//    appointmentIds works, batched ~50 per call. Asking for a date range
//    silently returns 2024 data.
//  - appointments: startsOnOrAfter works; startsOnOrBefore is IGNORED.
//
// ── Metric definitions and why ──────────────────────────────────────────────
//  - OPPORTUNITY CLOSE RATE: opportunities WON ÷ opportunities RUN, where one
//    opportunity is one JOB — not one estimate. Techs present good/better/best,
//    ~2.15 options per opportunity company-wide (up to 3.0 for the sales team),
//    so counting estimates in the denominator understates close rate by ~2.5x:
//    it showed Joseph Friel at 21.7% against ServiceTitan's reported 54%.
//    Reconciled against ST's Sales report to within a few points.
//  - AVERAGE SALE: total sold ÷ opportunities WON — the mean per won job, which
//    is ServiceTitan's own definition. Matching it matters more than being
//    statistically prettier: a board that disagrees with the report leadership
//    already reads gets ignored. (Reconciles: Korey White exact, Anthony 0.1%.)
//    Emphatically NOT invoice totals. Sales techs sell the system and the
//    INSTALL CREW'S job carries the invoice, so an invoice-based ticket showed
//    Joseph Friel at $89 while he had actually sold $437k. Invoices measure who
//    collects, not who sells.
//  - EXPECTED VALUE per opportunity = close rate × average sale. This is the
//    ranking spine. Close rate and average sale MULTIPLY (revenue =
//    opportunities × close × sale); weighting them as independent additive
//    terms ranked a 64%-close/$279 tech above a 22%-close/$9,116 tech, i.e.
//    it would have benched the highest earner on the board.
//  - MEMBERSHIP: memberships.soldById ÷ jobs. NOT invoice.membershipId — that
//    flags "customer IS a member", not "a membership was SOLD here", and
//    scored every tech at 0%.
//
// GROUPING: technician.team ("HVAC - Sales", "HVAC - Service", "Plumbing -
// Install"...), which is how the ServiceTitan dispatch board is laid out and how
// dispatch actually thinks. NOT the job's business unit: the HVAC sales team and
// HVAC service team share businessUnitId 2323039, so a BU grouping benchmarks
// closers who sell $9k systems against service techs doing $250 repairs — which
// tiered two of the top three earners in the company as red/yellow.
//
// Recency weighting: a 45-day window is needed for sample size (at 15 days only
// ~27 tech-groups clear a 10-job floor, vs 53 at 45 days), but dispatch cares
// about current form — so jobs decay with a 21-day half-life.

// Benches that get no batting order:
//  - Install crews deliver work that was already sold, so close rate and
//    average sale measure nothing about them.
//  - Apprentices are learning, not competing for high-value dispatch — scoring
//    them against journeymen would be unfair and useless in equal measure.
//  - Leadership are managers, not a dispatch bench.
//  - Unassigned is a data gap, not a team.
export const NON_DISPATCH_TEAM = /install|apprentice|leadership|unassigned/i

const HALF_LIFE_DAYS = 21
const MIN_JOBS = 10          // below this a tech is 'unranked', never 'red'
// expectedValue dominates because it is the profit question. closeRate is kept
// as a smaller efficiency term (don't burn opportunities), membership as the
// recurring-revenue term.
export const DEFAULT_WEIGHTS = { expectedValue: 60, closeRate: 20, membership: 20 }

const nameOf = (v) => (v && typeof v === 'object' ? v.name : v)

function recencyWeight(iso, now = Date.now()) {
  const t = Date.parse(String(iso || ''))
  if (Number.isNaN(t)) return 1
  const days = Math.max(0, (now - t) / 864e5)
  return Math.pow(0.5, days / HALF_LIFE_DAYS)
}

const median = (arr) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// z-score within a peer group; sd of 0 (everyone identical) must not divide.
function zScores(rows, key) {
  const vals = rows.map(r => r[key])
  const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1)
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length || 1)) || 1
  return rows.map(r => (r[key] - mean) / sd)
}

/**
 * @param data {{ jobs, assignments, estimates, memberships, businessUnits }}
 *   Note: invoices are deliberately NOT an input here — they measure who
 *   collected, not who sold. They feed computeZipValue only.
 * @param weights {{expectedValue, closeRate, membership}} relative weights
 */
export function computeBattingOrder(data, weights = DEFAULT_WEIGHTS, opts = {}) {
  const { jobs = [], assignments = [], estimates = [], memberships = [], technicians = [] } = data
  const minJobs = opts.minJobs ?? MIN_JOBS
  const now = opts.now ?? Date.now()

  // Team, not business unit — sales and service share a BU (verified: HVAC
  // Sales and HVAC Service are both businessUnitId 2323039).
  const teamOf = new Map(technicians.map(t => [t.id, (t.team || 'Unassigned').trim()]))
  const jobById = new Map(jobs.map(j => [j.id, j]))

  // job → tech (assignments are the only link; a job can have several, last wins)
  const techOfJob = new Map()
  for (const a of assignments) {
    if (a?.jobId && a?.technicianId) {
      techOfJob.set(a.jobId, { id: a.technicianId, name: a.technicianName || String(a.technicianId) })
    }
  }

  // group = tech × business unit
  const groups = new Map()
  const keyOf = (techId, team) => `${techId}|${team}`
  const touch = (techId, techName, team) => {
    const k = keyOf(techId, team)
    if (!groups.has(k)) {
      groups.set(k, { techId, techName, businessUnit: team, jobsRaw: 0, jobsW: 0, oppsW: 0, wonW: 0, options: 0, revenue: 0, wonRaw: 0 })
    }
    return groups.get(k)
  }

  const groupOfJob = new Map()
  for (const [jobId, tech] of techOfJob) {
    const j = jobById.get(jobId)
    if (!j) continue
    const team = teamOf.get(tech.id) || 'Unassigned'
    const g = touch(tech.id, tech.name, team)
    g.jobsRaw += 1
    g.jobsW += recencyWeight(j.completedOn, now)
    groupOfJob.set(jobId, g)
  }

  // One opportunity = one JOB, however many options were presented on it.
  const optionsByJob = new Map()
  for (const e of estimates) {
    if (!e?.jobId) continue
    if (!optionsByJob.has(e.jobId)) optionsByJob.set(e.jobId, [])
    optionsByJob.get(e.jobId).push(e)
  }
  for (const [jobId, options] of optionsByJob) {
    const g = groupOfJob.get(jobId)
    if (!g) continue
    const w = recencyWeight(options[0].createdOn, now)
    g.oppsW += w
    g.options += options.length
    const won = options.filter(o => nameOf(o.status) === 'Sold')
    if (won.length) {
      g.wonW += w
      g.wonRaw += 1
      g.revenue += won.reduce((a, o) => a + Number(o.subtotal || 0), 0)
    }
  }

  // memberships attach to the SELLER, not to a job — they carry no jobId.
  const memByTech = new Map()
  for (const m of memberships) {
    const sb = m?.soldById
    if (!sb) continue
    memByTech.set(sb, (memByTech.get(sb) || 0) + recencyWeight(m.createdOn, now))
  }

  const all = [...groups.values()].map(g => ({
    techId: g.techId,
    techName: g.techName,
    businessUnit: g.businessUnit,
    jobs: g.jobsRaw,
    opportunities: Math.round(g.oppsW),
    closeRate: g.oppsW ? (g.wonW / g.oppsW) * 100 : 0,
    avgSale: g.wonRaw ? g.revenue / g.wonRaw : 0,
    optionsPerOpp: g.oppsW ? g.options / g.oppsW : 0,
    membershipPct: g.jobsW ? ((memByTech.get(g.techId) || 0) / g.jobsW) * 100 : 0,
    totalSold: g.revenue,
  })).map(r => ({ ...r, expectedValue: (r.closeRate / 100) * r.avgSale }))

  // Rank within each business unit — that is the dispatch decision ("who for
  // this HVAC service call"), and comparing an install tech's ticket to a
  // service tech's would be meaningless.
  const ranked = []
  const byBU = new Map()
  for (const r of all) {
    if (NON_DISPATCH_TEAM.test(r.businessUnit)) continue
    if (!byBU.has(r.businessUnit)) byBU.set(r.businessUnit, [])
    byBU.get(r.businessUnit).push(r)
  }

  for (const [bu, rows] of byBU) {
    const eligible = rows.filter(r => r.jobs >= minJobs)
    const thin = rows.filter(r => r.jobs < minJobs)

    // Unranked, explicitly NOT red: branding a new hire low-tier on 3 jobs is
    // how a tool like this loses the team's trust.
    for (const r of thin) ranked.push({ ...r, score: null, tier: 'unranked', rank: null })

    if (eligible.length === 0) continue
    if (eligible.length === 1) {
      ranked.push({ ...eligible[0], score: 0, tier: 'yellow', rank: 1 })
      continue
    }

    const ze = zScores(eligible, 'expectedValue')
    const zc = zScores(eligible, 'closeRate')
    const zm = zScores(eligible, 'membershipPct')
    const scored = eligible.map((r, i) => ({
      ...r,
      score: (weights.expectedValue * ze[i] + weights.closeRate * zc[i] + weights.membership * zm[i]) / 100,
    })).sort((a, b) => b.score - a.score)

    // Relative curve WITH an absolute floor: being least-bad on a weak bench
    // shouldn't earn green and send your worst closer to a $20k opportunity.
    const greenCount = Math.max(1, Math.round(scored.length * 0.3))
    const redCount = Math.max(1, Math.round(scored.length * 0.2))
    scored.forEach((r, i) => {
      let tier = i < greenCount ? 'green' : (i >= scored.length - redCount ? 'red' : 'yellow')
      if (tier === 'green' && r.score <= 0) tier = 'yellow'   // the floor
      ranked.push({ ...r, tier, rank: i + 1 })
    })
  }

  return ranked
}

// Zip value from real invoice history, so "high-opportunity area" is grounded
// in what work there actually bills rather than assumption.
export function computeZipValue(invoices) {
  const byZip = new Map()
  for (const inv of invoices) {
    const zip = String(inv?.customerAddress?.zip || inv?.locationAddress?.zip || '').trim().slice(0, 5)
    const total = Number(inv.total || 0)
    if (!zip || total <= 0) continue
    if (!byZip.has(zip)) byZip.set(zip, [])
    byZip.get(zip).push(total)
  }
  const rows = [...byZip.entries()]
    .filter(([, v]) => v.length >= 5)          // 5-job floor: one big install isn't a market
    .map(([zip, v]) => ({ zip, avgTicket: median(v), jobCount: v.length }))
  if (!rows.length) return []
  const sorted = [...rows].sort((a, b) => b.avgTicket - a.avgTicket)
  const hi = Math.max(1, Math.round(sorted.length * 0.25))
  const lo = Math.max(1, Math.round(sorted.length * 0.25))
  return sorted.map((r, i) => ({
    ...r,
    tier: i < hi ? 'high' : (i >= sorted.length - lo ? 'low' : 'mid'),
  }))
}
