// ServiceTitan's "Sales" close rate — the Close Rate / Sales Opportunities
// numbers on ST's Technician Scorecard and Business Unit dashboards, which is
// the figure Brandyn compares Andi against ("Electrical 72.2%", "Garage 64.3%").
//
// Reverse-engineered Sep 20 2026 against ST's own "Sales Per Technician"
// dashboard report for the week of Sep 14–20: all 21 techs reproduced exactly
// (Garage 14 opps / 9 closed = 64.3%, Electrical 36 / 26 = 72.2%). The rules:
//
//   CLOSED  — a Completed job (job-type class ≠ Callback) whose active Sold
//             estimates, taken in soldOn order, first reach the job type's
//             sold threshold ($90 on every type here) on an estimate whose
//             soldOn falls inside the window. Credited to THAT estimate's
//             soldBy — the tech who crossed the line. An add-on sale on a job
//             that already crossed earlier is Total Sales, not a new close
//             (Jason's $816 on an install closed two weeks earlier didn't
//             count); a $0 "sold" estimate credits nobody.
//   OPPS    — closed jobs, plus jobs COMPLETED inside the window (status
//             Completed, class ≠ Callback) whose job TYPE is not No Charge and
//             which are either not marked No Charge themselves or have sold
//             estimates at/over the threshold. Each such job is one
//             opportunity for the tech on its FIRST appointment assignment;
//             ride-alongs get nothing (Tanner 0/0 beside Korey). A no-charge
//             job somebody else closed is still an unsold opp for its primary
//             (Nick on the job Korey came back and sold).
//   NOT     — installs (no-charge types, no estimates of their own), follow-ups
//             and callbacks with revenue but no sold estimate, ride-alongs,
//             canceled jobs, jobs still in progress.
//
// Invoice dollars never enter it. The old "$89 invoice converts" rule was a
// coincidence that happened to match one trade for one week.
export const SOLD_THRESHOLD = 90
export const NON_SALES_CLASSES = new Set(['Callback'])
export const LOOKBACK_DAYS = 120   // earlier sales on the same job decide whether an in-window sale is the first crossing

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))

let _jobTypes = { at: 0, map: new Map() }
export async function loadJobTypes({ stGet, tenantId }) {
  if (Date.now() - _jobTypes.at < 6 * 3600_000 && _jobTypes.map.size) return _jobTypes.map
  const map = new Map()
  for (let page = 1; page <= 10; page++) {
    const d = await stGet(`/jpm/v2/tenant/${tenantId}/job-types?pageSize=500&page=${page}`)
    for (const t of (d?.data || [])) {
      map.set(String(t.id), { name: t.name || '', class: t.class || null, noCharge: !!t.noCharge, soldThreshold: Number(t.soldThreshold) > 0 ? Number(t.soldThreshold) : SOLD_THRESHOLD })
    }
    if (!d?.hasMore) break
  }
  if (map.size) _jobTypes = { at: Date.now(), map }
  return map
}

// Pull everything the rule needs for [startIso, endIso). `primary: false`
// skips the per-job first-assignment lookup (one call per 50 jobs) — use it
// for department-only rollups over big windows (the TV year tier), where
// opps then attribute by the job's business unit instead of a tech.
export async function fetchSalesCloseInputs({ stGet, stPageAll, tenantId, startIso, endIso, primary = true, capMul = 1, log = (m) => console.warn(m) }) {
  const lookbackIso = new Date(Date.parse(startIso) - LOOKBACK_DAYS * 864e5).toISOString()
  const safe = (p, fallback, what) => p.then(r => r).catch(e => { log(`salesClose ${what}: ${e.message}`); return fallback })
  const [completed, soldEst, jobTypes] = await Promise.all([
    safe(stPageAll(pg => `/jpm/v2/tenant/${tenantId}/jobs?completedOnOrAfter=${startIso}&completedBefore=${endIso}&pageSize=500&page=${pg}`, 6000 * capMul), [], 'completed jobs'),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${lookbackIso}&soldBefore=${endIso}&pageSize=500&page=${pg}`, 8000 * capMul), [], 'sold estimates'),
    safe(loadJobTypes({ stGet, tenantId }), new Map(), 'job types'),
  ])
  const jobs = new Map()
  for (const j of completed) jobs.set(j.id, j)
  const sold = soldEst.filter(e => e.active !== false && (e.status || {}).name === 'Sold' && e.soldOn && e.jobId)
  // Jobs that sold inside the window but completed outside it (or aren't in
  // the completed pull) — needed for status/type/first-appointment.
  const inWin = (iso) => iso >= startIso && iso < endIso
  const missing = [...new Set(sold.filter(e => inWin(e.soldOn) && !jobs.has(e.jobId)).map(e => e.jobId))]
  for (const ids of chunk(missing, 50)) {
    const r = await safe(stGet(`/jpm/v2/tenant/${tenantId}/jobs?ids=${ids.join(',')}&pageSize=50`), null, 'sold-job lookup')
    for (const j of (r?.data || [])) jobs.set(j.id, j)
  }
  // Primary tech = first assignment (lowest id, active) on the job's first appointment.
  const primaryTech = new Map()
  if (primary) {
    const apptJob = new Map()
    for (const j of jobs.values()) if (j.firstAppointmentId) apptJob.set(j.firstAppointmentId, j.id)
    for (const ids of chunk([...apptJob.keys()], 50)) {
      const r = await safe(stGet(`/dispatch/v2/tenant/${tenantId}/appointment-assignments?appointmentIds=${ids.join(',')}&pageSize=200`), null, 'assignments')
      const rows = (r?.data || []).filter(a => a.active !== false && a.technicianId).sort((a, b) => a.id - b.id)
      for (const a of rows) {
        const jid = apptJob.get(a.appointmentId)
        if (jid && !primaryTech.has(jid)) primaryTech.set(jid, a.technicianId)
      }
    }
  }
  return { startIso, endIso, jobs, sold, jobTypes, primaryTech, hasPrimary: primary }
}

// Score one window (defaults to the fetched one; pass a narrower window to
// reuse one fetch for this week AND last week).
export function computeSalesClose(inputs, win = {}) {
  const startIso = win.startIso || inputs.startIso, endIso = win.endIso || inputs.endIso
  const { jobs, sold, jobTypes, primaryTech } = inputs
  const inWin = (iso) => iso >= startIso && iso < endIso
  const typeOf = (j) => jobTypes.get(String(j?.jobTypeId)) || { class: null, noCharge: false, soldThreshold: SOLD_THRESHOLD }
  const salesJob = (j) => j && j.jobStatus === 'Completed' && !NON_SALES_CLASSES.has(typeOf(j).class)

  const byJob = new Map()   // jobId -> sold estimates, soldOn ascending
  for (const e of sold) { if (!byJob.has(e.jobId)) byJob.set(e.jobId, []); byJob.get(e.jobId).push(e) }
  const closed = new Map()      // jobId -> { techId, soldOn, amount }
  for (const [jid, list] of byJob) {
    list.sort((a, b) => a.soldOn.localeCompare(b.soldOn))
    const j = jobs.get(jid)
    const th = typeOf(j).soldThreshold
    let cum = 0
    for (const e of list) {
      if (e.soldOn >= endIso) break
      cum += Number(e.subtotal) || 0
      if (cum < th) continue
      if (inWin(e.soldOn) && salesJob(j) && e.soldBy) closed.set(jid, { techId: e.soldBy, soldOn: e.soldOn, amount: cum })
      break
    }
  }
  const byTech = new Map()   // techId -> { opps: Set, closed: Set }
  const techRow = (t) => { const k = String(t); if (!byTech.has(k)) byTech.set(k, { opps: new Set(), closed: new Set() }); return byTech.get(k) }
  const unattributed = new Set()   // completed-in-window opps with no primary tech (primary:false pulls)
  const oppJobs = new Set()
  for (const [jid, c] of closed) { const r = techRow(c.techId); r.closed.add(jid); r.opps.add(jid); oppJobs.add(jid) }
  for (const j of jobs.values()) {
    if (!salesJob(j) || !j.completedOn || !inWin(j.completedOn)) continue
    const t = typeOf(j)
    if (t.noCharge) continue
    if (j.noCharge && !closed.has(j.id)) continue   // no-charge job somebody closed this window (validated rule)
    oppJobs.add(j.id)
    const tech = primaryTech.get(j.id)
    if (tech) techRow(tech).opps.add(j.id)
    else if (!inputs.hasPrimary) unattributed.add(j.id)
    else if (closed.has(j.id)) techRow(closed.get(j.id).techId).opps.add(j.id)   // no assignment on file: the closer owns it
  }
  return { byTech, closed, oppJobs, unattributed, jobs }
}

// Sum a result into { opps, closed, rate } — for everyone, or by a tech/job
// grouping. `groupOfTech(techId, job)` returns the bucket for one tech-opp
// (null = skip); `groupOfJob(job)` buckets unattributed opps (primary:false).
export function rollupSalesClose(result, { groupOfTech = () => 'all', groupOfJob = () => 'all' } = {}) {
  const out = {}
  const row = (g) => { if (g == null) return null; if (!out[g]) out[g] = { opps: 0, closed: 0, rate: null }; return out[g] }
  for (const [tech, r] of result.byTech) {
    for (const jid of r.opps) {
      const g = row(groupOfTech(tech, result.jobs.get(jid), jid)); if (!g) continue
      g.opps++; if (r.closed.has(jid)) g.closed++
    }
  }
  for (const jid of result.unattributed) { const g = row(groupOfJob(result.jobs.get(jid), jid)); if (g) g.opps++ }
  for (const g of Object.values(out)) g.rate = g.opps ? g.closed / g.opps : null
  return out
}

export const techStats = (result, techId) => {
  const r = result.byTech.get(String(techId))
  const opps = r ? r.opps.size : 0, closed = r ? r.closed.size : 0
  return { opps, closed, rate: opps ? closed / opps : null }
}
