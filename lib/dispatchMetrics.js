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
//  - CONVERSION: estimates on the tech's jobs that are Sold ÷ all estimates on
//    those jobs. NOT estimate.soldBy — that field only exists on sold
//    estimates, so it can produce a numerator with no denominator (every tech
//    would score 100%). The tech is resolved job → appointment → assignment.
//  - AVG TICKET: the MEDIAN of non-zero invoice totals. Two corrections, both
//    from real data: 54% of invoices are $0 (warranty/callback/no-charge) and
//    averaging them in crushed the number; and non-zero tickets are ~20x
//    skewed (median $89 vs mean $1,735, max $44,891), so a mean ranks by who
//    happened to catch one install.
//  - MEMBERSHIP: memberships.soldById ÷ jobs. NOT invoice.membershipId — that
//    flags "customer IS a member", not "a membership was SOLD here", and
//    scored every tech at 0%.
//
// Recency weighting: a 45-day window is needed for sample size (at 15 days only
// ~27 tech-groups clear a 10-job floor, vs 53 at 45 days), but dispatch cares
// about current form — so jobs decay with a 21-day half-life.

const HALF_LIFE_DAYS = 21
const MIN_JOBS = 10          // below this a tech is 'unranked', never 'red'
export const DEFAULT_WEIGHTS = { conversion: 50, avgTicket: 30, membership: 20 }

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
 * @param data {{ jobs, assignments, estimates, invoices, memberships, businessUnits }}
 * @param weights {{conversion, avgTicket, membership}} percentages
 */
export function computeBattingOrder(data, weights = DEFAULT_WEIGHTS, opts = {}) {
  const { jobs = [], assignments = [], estimates = [], invoices = [], memberships = [], businessUnits = [] } = data
  const minJobs = opts.minJobs ?? MIN_JOBS
  const now = opts.now ?? Date.now()

  const buName = new Map(businessUnits.map(b => [b.id, b.name || '']))
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
  const keyOf = (techId, bu) => `${techId}|${bu}`
  const touch = (techId, techName, bu) => {
    const k = keyOf(techId, bu)
    if (!groups.has(k)) {
      groups.set(k, { techId, techName, businessUnit: bu, jobsRaw: 0, jobsW: 0, estW: 0, soldW: 0, tickets: [] })
    }
    return groups.get(k)
  }

  const groupOfJob = new Map()
  for (const [jobId, tech] of techOfJob) {
    const j = jobById.get(jobId)
    if (!j) continue
    const bu = buName.get(j.businessUnitId) || 'Unassigned'
    const g = touch(tech.id, tech.name, bu)
    g.jobsRaw += 1
    g.jobsW += recencyWeight(j.completedOn, now)
    groupOfJob.set(jobId, g)
  }

  for (const e of estimates) {
    const g = groupOfJob.get(e?.jobId)
    if (!g) continue
    const w = recencyWeight(e.createdOn, now)
    g.estW += w
    if (nameOf(e.status) === 'Sold') g.soldW += w
  }

  for (const inv of invoices) {
    const g = groupOfJob.get(inv?.job?.id)
    if (!g) continue
    const total = Number(inv.total || 0)
    if (total > 0) g.tickets.push(total)   // $0 = no-charge, not a ticket
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
    conversion: g.estW ? (g.soldW / g.estW) * 100 : 0,
    avgTicket: median(g.tickets),
    membershipPct: g.jobsW ? ((memByTech.get(g.techId) || 0) / g.jobsW) * 100 : 0,
  }))

  // Rank within each business unit — that is the dispatch decision ("who for
  // this HVAC service call"), and comparing an install tech's ticket to a
  // service tech's would be meaningless.
  const ranked = []
  const byBU = new Map()
  for (const r of all) {
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

    const zc = zScores(eligible, 'conversion')
    const za = zScores(eligible, 'avgTicket')
    const zm = zScores(eligible, 'membershipPct')
    const scored = eligible.map((r, i) => ({
      ...r,
      score: (weights.conversion * zc[i] + weights.avgTicket * za[i] + weights.membership * zm[i]) / 100,
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
