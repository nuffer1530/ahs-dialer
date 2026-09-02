// ── Morning digest: what happened at AHS yesterday ──────────────────────────
//
// One email, 7 AM Denver, built from ServiceTitan (money, techs, marketing)
// and Andi (call center, QA, dispatch behavior). Every ST query here uses the
// definitions calibrated against the Weekly Leadership sheet in Jul 2026 —
// sold estimates for sales, invoice subTotals for revenue, telecom callType
// for booking % — so these numbers reconcile with what leadership already
// reviews rather than inventing a parallel truth.
//
// Degrades cleanly: any section that fails to fetch is omitted, never fatal.

const TRADES = ['HVAC', 'Plumbing', 'Electrical', 'Garage Doors']
const tradeOf = (name) => {
  const n = (name || '').toLowerCase()
  if (n.includes('hvac')) return 'HVAC'
  if (n.includes('plumb')) return 'Plumbing'
  if (n.includes('electric')) return 'Electrical'
  if (n.includes('garage')) return 'Garage Doors'
  return null
}
const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString()}`
const pct = (n) => (n == null ? '—' : `${Math.round(Number(n) * 100)}%`)
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))

// Denver-local day boundaries for a given YYYY-MM-DD, returned as UTC ISO.
function denverDayBounds(dateStr) {
  // Denver is UTC-6 (MDT) or UTC-7 (MST); derive the real offset for that date
  // instead of hardcoding, so this stays right across DST.
  const noonUtc = new Date(`${dateStr}T18:00:00Z`)
  const denverHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', hour: '2-digit', hour12: false,
  }).format(noonUtc))
  const offset = 18 - denverHour            // 6 for MDT, 7 for MST
  const start = new Date(`${dateStr}T00:00:00Z`)
  start.setUTCHours(offset)
  const end = new Date(start.getTime() + 24 * 3600_000)
  return { startIso: start.toISOString(), endIso: end.toISOString(), offset }
}

export async function gatherDigestFacts({ stGet, stPageAll, supabase, tenantId, dateStr, getBoard3Day }) {
  const { startIso, endIso } = denverDayBounds(dateStr)
  // Invoice dates are date-only in ST — bound them on the calendar day.
  const invFrom = `${dateStr}T00:00:00Z`
  const invTo = `${dateStr}T23:59:59Z`

  const safe = (p, fallback) => p.then(r => r).catch(e => { console.warn('digest fetch:', e.message); return fallback })

  const [estSold, estCreated, invoices, appts, telecom, memberships, reviews] = await Promise.all([
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${startIso}&soldBefore=${endIso}&pageSize=500&page=${pg}`, 4000), []),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?createdOnOrAfter=${startIso}&createdBefore=${endIso}&pageSize=500&page=${pg}`, 4000), []),
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${invFrom}&invoicedOnBefore=${invTo}&pageSize=500&page=${pg}`, 4000), []),
    safe(stPageAll(pg => `/jpm/v2/tenant/${tenantId}/appointments?startsOnOrAfter=${startIso}&pageSize=500&page=${pg}`, 3000), []),
    safe(stPageAll(pg => `/telecom/v2/tenant/${tenantId}/calls?createdOnOrAfter=${startIso}&createdBefore=${endIso}&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/memberships/v2/tenant/${tenantId}/memberships?createdOnOrAfter=${startIso}&createdBefore=${endIso}&pageSize=500&page=${pg}`, 2000), []),
    safe(stGet(`/marketingreputation/v2/tenant/${tenantId}/reviews?fromDate=${dateStr}&toDate=${dateStr}&pageSize=200`).then(d => d?.data || []), []),
  ])

  // ── Sales (sold estimates) ────────────────────────────────────────────────
  const sold = estSold.filter(e => (e.status || {}).name === 'Sold')
  const sales = { total: 0, count: 0, byTrade: {} }
  const soldJobIds = new Set()
  const soldByTech = new Map()
  for (const e of sold) {
    const t = tradeOf(e.businessUnitName)
    const amt = Number(e.subtotal) || 0
    sales.total += amt; sales.count++
    if (t) sales.byTrade[t] = (sales.byTrade[t] || 0) + amt
    if (e.jobId) soldJobIds.add(e.jobId)
    const tech = e.soldBy
    if (tech) {
      const cur = soldByTech.get(tech) || { amount: 0, count: 0, jobs: new Set() }
      cur.amount += amt; cur.count++
      if (e.jobId) cur.jobs.add(e.jobId)
      soldByTech.set(tech, cur)
    }
  }

  // ── Close rate: of jobs where an estimate was presented, how many sold ────
  const presentedJobs = new Set(estCreated.map(e => e.jobId).filter(Boolean))
  const presentedByTrade = {}, soldJobsByTrade = {}
  for (const e of estCreated) {
    const t = tradeOf(e.businessUnitName)
    if (t && e.jobId) (presentedByTrade[t] = presentedByTrade[t] || new Set()).add(e.jobId)
  }
  for (const e of sold) {
    const t = tradeOf(e.businessUnitName)
    if (t && e.jobId) (soldJobsByTrade[t] = soldJobsByTrade[t] || new Set()).add(e.jobId)
  }
  const withEstActivity = new Set([...presentedJobs, ...soldJobIds])
  const closeRate = {
    presented: withEstActivity.size,
    sold: soldJobIds.size,
    byTrade: {},
  }
  closeRate.rate = closeRate.presented ? closeRate.sold / closeRate.presented : null
  for (const t of TRADES) {
    const act = new Set([...(presentedByTrade[t] || []), ...(soldJobsByTrade[t] || [])])
    const p = act.size
    const s = soldJobsByTrade[t]?.size || 0
    closeRate.byTrade[t] = { presented: p, sold: s, rate: p ? s / p : null }
  }

  // ── Revenue (invoiced) ────────────────────────────────────────────────────
  const revenue = { total: 0, count: invoices.length, byTrade: {} }
  for (const i of invoices) {
    const t = tradeOf((i.businessUnit || {}).name)
    const amt = Number(i.subTotal) || 0
    revenue.total += amt
    if (t) revenue.byTrade[t] = (revenue.byTrade[t] || 0) + amt
  }

  // ── Technicians: jobs run yesterday, sold $, close rate ───────────────────
  const dayAppts = appts.filter(a => {
    const t = Date.parse(a.start || '')
    return !Number.isNaN(t) && t >= Date.parse(startIso) && t < Date.parse(endIso) && a.status !== 'Canceled'
  })
  const techJobs = new Map()   // techId -> Set(jobId)
  try {
    const ids = dayAppts.map(a => a.id).filter(Boolean)
    for (let i = 0; i < ids.length; i += 50) {
      const r = await stGet(`/dispatch/v2/tenant/${tenantId}/appointment-assignments?appointmentIds=${ids.slice(i, i + 50).join(',')}&pageSize=200`)
      for (const asg of (r?.data || [])) {
        if (asg.active === false) continue
        const appt = dayAppts.find(a => a.id === asg.appointmentId)
        if (!appt?.jobId) continue
        if (!techJobs.has(asg.technicianId)) techJobs.set(asg.technicianId, new Set())
        techJobs.get(asg.technicianId).add(appt.jobId)
      }
    }
  } catch (e) { console.warn('digest assignments:', e.message) }

  let techNames = new Map()
  try {
    const { data } = await supabase.from('dispatch_tech_scores').select('tech_id, tech_name, tier, business_unit')
    for (const r of (data || [])) techNames.set(String(r.tech_id), { name: r.tech_name, tier: r.tier, bu: r.business_unit })
  } catch {}
  try {
    const t = await stGet(`/settings/v2/tenant/${tenantId}/technicians?active=true&pageSize=500`)
    for (const x of (t?.data || [])) {
      const prev = techNames.get(String(x.id)) || {}
      techNames.set(String(x.id), { ...prev, name: x.name || prev.name })
    }
  } catch {}

  const technicians = []
  for (const [techId, jobs] of techJobs) {
    const info = techNames.get(String(techId)) || {}
    const s = soldByTech.get(techId) || { amount: 0, count: 0, jobs: new Set() }
    // Denominator = jobs with ANY estimate activity today (presented OR
    // sold). Selling a follow-up presented on an earlier day used to count
    // in the numerator only — Clayton closed 2 off 1 new presentation and
    // the digest printed a 200% close.
    const soldJobsSet = new Set([...jobs].filter(j => soldJobIds.has(j)))
    const withActivity = new Set([...jobs].filter(j => presentedJobs.has(j) || soldJobsSet.has(j)))
    const presented = withActivity.size
    const soldJobs = soldJobsSet.size
    technicians.push({
      name: info.name || `Tech ${techId}`,
      tier: info.tier || null,
      jobsRan: jobs.size,
      presented,
      soldJobs,
      closeRate: presented ? soldJobs / presented : null,
      soldAmount: Math.round(s.amount),
      avgTicket: s.count ? Math.round(s.amount / s.count) : 0,
    })
  }
  technicians.sort((a, b) => b.soldAmount - a.soldAmount)

  // ── Marketing: which campaigns rang, and did they book? ───────────────────
  const campaigns = new Map()
  let inboundTotal = 0, bookedTotal = 0, unbookedTotal = 0
  for (const c of telecom) {
    const lc = c.leadCall || c
    if ((lc.direction || '') !== 'Inbound') continue
    const type = lc.callType || ''
    if (!['Booked', 'Unbooked'].includes(type)) continue
    inboundTotal++
    if (type === 'Booked') bookedTotal++; else unbookedTotal++
    const name = (lc.campaign || {}).name || 'Unattributed'
    const cur = campaigns.get(name) || { name, calls: 0, booked: 0 }
    cur.calls++; if (type === 'Booked') cur.booked++
    campaigns.set(name, cur)
  }
  const marketing = {
    leadCalls: inboundTotal,
    booked: bookedTotal,
    bookingRate: inboundTotal ? bookedTotal / inboundTotal : null,
    campaigns: [...campaigns.values()]
      .map(c => ({ ...c, rate: c.calls ? c.booked / c.calls : null }))
      .sort((a, b) => b.calls - a.calls).slice(0, 10),
  }

  // ── Call center + dispatch (Andi's own records) ───────────────────────────
  // Call-center stats come from ST TELECOM, not Andi — until the whole team
  // works through Andi, its tables only see a fraction of the calls. ST's
  // agent field attributes every call regardless of which system took it.
  // Only QA scores + coaching come from Andi (they exist nowhere else).
  const callCenter = { leadCalls: 0, totalInbound: 0, nonLead: 0, abandoned: 0, avgTalkSec: null, bookedByCsr: 0, bookingPct: null, qaAvg: null, qaCount: 0, outboundDials: 0, byRep: [], voicemails: 0, coaching: [] }
  try {
    const durSec = (d) => {  // ST duration: "00:01:36.7020000"
      const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(d || ''))
      return m ? Math.round(+m[1] * 3600 + +m[2] * 60 + +m[3]) : null
    }
    // One name per person: ST agents mapped to an Andi profile show under
    // their Andi name, so this table, the coaching cards, and the eval tab
    // all agree on who's who.
    const [{ data: stMaps }, { data: profRows }] = await Promise.all([
      supabase.from('csr_st_users').select('profile_id, st_user_id'),
      supabase.from('profiles').select('id, name, email'),
    ])
    const profName = new Map((profRows || []).map(p => [p.id, p.name || p.email]))
    const andiName = new Map((stMaps || []).map(m => [String(m.st_user_id), profName.get(m.profile_id)]).filter(x => x[1]))

    // "Calls taken" = LEAD calls only (Booked + Unbooked). NotLead (spam/robo)
    // and Excused (non-lead) are the bulk of inbound volume but aren't calls
    // the team is measured on — they're shown only as context. Outbound is
    // fully separate. (Per Brittany, Aug 2026: the old "answered" counted every
    // inbound ring incl. junk, ~12x the real lead count.)
    const byRep = new Map()
    const rep = (n) => {
      const cur = byRep.get(n) || { name: n, leadCalls: 0, booked: 0, unbooked: 0, inbound: 0, outbound: 0, talks: [] }
      byRep.set(n, cur); return cur
    }
    const talks = []
    let booked = 0, unbooked = 0
    for (const c of telecom) {
      const lc = c.leadCall || c
      const agentId = String((lc.agent || {}).id || (lc.createdBy || {}).id || '')
      const agent = andiName.get(agentId) || (lc.agent || {}).name || (lc.createdBy || {}).name || null
      if ((lc.direction || '') === 'Outbound') { if (agent) rep(agent).outbound++; callCenter.outboundDials++; continue }
      if ((lc.direction || '') !== 'Inbound') continue
      if (lc.callType === 'Abandoned') { callCenter.abandoned++; continue }
      if (!agent) continue
      const r = rep(agent)
      r.inbound++; callCenter.totalInbound++
      const isLead = lc.callType === 'Booked' || lc.callType === 'Unbooked'
      if (!isLead) { r.nonLead = (r.nonLead || 0) + 1; callCenter.nonLead++; continue }
      r.leadCalls++; callCenter.leadCalls++
      const s = durSec(lc.duration)
      if (s != null) { r.talks.push(s); talks.push(s) }
      if (lc.callType === 'Booked') { r.booked++; booked++ }
      else { r.unbooked++; unbooked++ }
    }
    callCenter.bookedByCsr = booked
    callCenter.bookingPct = (booked + unbooked) ? booked / (booked + unbooked) : null
    callCenter.avgTalkSec = talks.length ? Math.round(talks.reduce((a, b) => a + b, 0) / talks.length) : null
    callCenter.byRep = [...byRep.values()].map(r => ({
      name: r.name, leadCalls: r.leadCalls, booked: r.booked, inbound: r.inbound,
      bookRate: (r.booked + r.unbooked) ? r.booked / (r.booked + r.unbooked) : null,
      avgTalkSec: r.talks.length ? Math.round(r.talks.reduce((a, b) => a + b, 0) / r.talks.length) : null,
      outbound: r.outbound,
    })).filter(r => r.leadCalls || r.inbound).sort((a, b) => b.leadCalls - a.leadCalls || b.inbound - a.inbound)
    // Outbound-only callers are mostly field techs phoning customers — real
    // activity, but not the CSR table. Summarize instead of listing.
    const obOnly = [...byRep.values()].filter(r => !r.inbound && r.outbound)
    callCenter.outboundOnly = { people: obOnly.length, calls: obOnly.reduce((a, r) => a + r.outbound, 0) }

    // Evals belong to the day of the CALL, not the day the score was written:
    // the nightly ST sweep scores yesterday's calls at ~2 AM today, so a
    // created_at window on the report day missed every sweep eval (the email
    // showed "0 evals" beside 40 scored calls). Join through the recordings
    // registry by call_sid, and union in same-day created rows (live Andi
    // evals) as a safety net.
    const { data: recs } = await supabase.from('call_recordings')
      .select('call_sid, rep, direction, duration, st_job_id')
      .gte('call_started_at', startIso).lt('call_started_at', endIso).limit(3000)
    const daySids = [...new Set((recs || []).map(r => r.call_sid).filter(Boolean))]
    let evals = []
    for (let i = 0; i < daySids.length; i += 200) {
      const { data } = await supabase.from('call_evaluations')
        .select('id, rep, pct, summary, scores').in('call_sid', daySids.slice(i, i + 200))
      if (data?.length) evals = evals.concat(data)
    }
    const { data: evCreated } = await supabase.from('call_evaluations')
      .select('id, rep, pct, summary, scores').gte('created_at', startIso).lt('created_at', endIso)
    const seenEv = new Set(evals.map(e => e.id))
    for (const e of (evCreated || [])) if (!seenEv.has(e.id)) evals.push(e)

    callCenter.voicemails = (recs || []).filter(r => r.direction === 'voicemail').length
    const ev = (evals || []).filter(e => e.pct != null)
    callCenter.qaCount = ev.length
    callCenter.qaAvg = ev.length ? Math.round(ev.reduce((a, e) => a + Number(e.pct), 0) / ev.length) : null

    // ── Per-CSR coaching from the QA evaluations: which rubric criteria are
    // they actually losing points on, and where are they strong? This is the
    // pattern a manager would only see by reading every eval by hand.
    const perCsr = new Map()
    for (const e of (evals || [])) {
      const name = e.rep || 'Unknown'
      const cur = perCsr.get(name) || { name, scores: [], crit: new Map(), talkSecs: [], recCount: 0, recBooked: 0 }
      cur.scores.push(Number(e.pct))
      for (const it of ((e.scores || {}).items || [])) {
        if (!it.applicable) continue
        const c = cur.crit.get(it.criterion) || { criterion: it.criterion, earned: 0, max: 0, misses: 0, n: 0 }
        c.earned += Number(it.earned) || 0
        c.max += Number(it.max) || 0
        c.n++
        if ((Number(it.earned) || 0) < (Number(it.max) || 0)) c.misses++
        cur.crit.set(it.criterion, c)
      }
      perCsr.set(name, cur)
    }
    for (const r of (recs || [])) {
      if (r.direction !== 'inbound' || !r.rep) continue
      const cur = perCsr.get(r.rep) || { name: r.rep, scores: [], crit: new Map(), talkSecs: [], recCount: 0, recBooked: 0 }
      cur.recCount++
      if (r.st_job_id) cur.recBooked++
      if (Number.isFinite(Number(r.duration))) cur.talkSecs.push(Number(r.duration))
      perCsr.set(r.rep, cur)
    }
    callCenter.coaching = [...perCsr.values()].map(c => {
      const crits = [...c.crit.values()].filter(x => x.max > 0)
      const withRate = crits.map(x => ({ ...x, rate: x.earned / x.max }))
      return {
        name: c.name,
        qa: c.scores.length ? Math.round(c.scores.reduce((a, b) => a + b, 0) / c.scores.length) : null,
        evals: c.scores.length,
        callsRecorded: c.recCount,
        bookedFromCalls: c.recBooked,
        callBookRate: c.recCount ? c.recBooked / c.recCount : null,
        avgTalkSec: c.talkSecs.length ? Math.round(c.talkSecs.reduce((a, b) => a + b, 0) / c.talkSecs.length) : null,
        weakest: withRate.filter(x => x.rate < 1).sort((a, b) => a.rate - b.rate).slice(0, 3)
          .map(x => ({ criterion: x.criterion, rate: Math.round(x.rate * 100), missedOn: x.misses, of: x.n })),
        strongest: withRate.filter(x => x.rate === 1 && x.n >= 1).slice(0, 2).map(x => x.criterion),
      }
    }).filter(c => c.evals > 0 || c.callsRecorded > 0)
      .sort((a, b) => (b.qa ?? -1) - (a.qa ?? -1))
  } catch (e) { console.warn('digest call center:', e.message) }

  const dispatch = {
    jobsRan: dayAppts.length,
    techsWorked: techJobs.size,
    jobsPerTech: techJobs.size ? Math.round((dayAppts.length / techJobs.size) * 10) / 10 : null,
    canceled: appts.filter(a => {
      const t = Date.parse(a.start || '')
      return a.status === 'Canceled' && !Number.isNaN(t) && t >= Date.parse(startIso) && t < Date.parse(endIso)
    }).length,
  }

  // ── Money left behind: jobs that ran and produced nothing ────────────────
  const ranJobIds = new Set()
  for (const jobs of techJobs.values()) for (const j of jobs) ranJobIds.add(j)
  const ranWithEstimate = [...ranJobIds].filter(j => presentedJobs.has(j))
  const openEstimates = estCreated.filter(e => (e.status || {}).name !== 'Sold')
  const leftBehind = {
    jobsRan: ranJobIds.size,
    noEstimateWritten: [...ranJobIds].filter(j => !presentedJobs.has(j)).length,
    presentedNotSold: ranWithEstimate.filter(j => !soldJobIds.has(j)).length,
    openEstimateValue: Math.round(openEstimates.reduce((a, e) => a + (Number(e.subtotal) || 0), 0)),
    openEstimateCount: openEstimates.length,
  }

  // ── Unbooked lead calls: real people who called and didn't book ──────────
  const unbookedByCampaign = new Map()
  for (const c of telecom) {
    const lc = c.leadCall || c
    if ((lc.direction || '') !== 'Inbound' || lc.callType !== 'Unbooked') continue
    const n = (lc.campaign || {}).name || 'Unattributed'
    unbookedByCampaign.set(n, (unbookedByCampaign.get(n) || 0) + 1)
  }
  const unbooked = {
    total: [...unbookedByCampaign.values()].reduce((a, b) => a + b, 0),
    byCampaign: [...unbookedByCampaign.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5),
  }

  // ── Week-over-week: same weekday last week, so a number has context ──────
  let priorWeek = null
  try {
    const prevDate = new Date(`${dateStr}T12:00:00Z`)
    prevDate.setUTCDate(prevDate.getUTCDate() - 7)
    const pStr = prevDate.toISOString().slice(0, 10)
    const { startIso: pStart, endIso: pEnd } = denverDayBounds(pStr)
    const [pSold, pInv] = await Promise.all([
      safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${pStart}&soldBefore=${pEnd}&pageSize=500&page=${pg}`, 3000), []),
      safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${pStr}T00:00:00Z&invoicedOnBefore=${pStr}T23:59:59Z&pageSize=500&page=${pg}`, 3000), []),
    ])
    const pSales = pSold.filter(e => (e.status || {}).name === 'Sold').reduce((a, e) => a + (Number(e.subtotal) || 0), 0)
    const pRev = pInv.reduce((a, i) => a + (Number(i.subTotal) || 0), 0)
    priorWeek = {
      date: pStr,
      sales: Math.round(pSales), revenue: Math.round(pRev),
      salesDelta: pSales ? (sales.total - pSales) / pSales : null,
      revenueDelta: pRev ? (revenue.total - pRev) / pRev : null,
    }
  } catch (e) { console.warn('digest prior week:', e.message) }

  // ── Today's board: what the morning actually needs to act on ─────────────
  let todayBoard = null
  if (typeof getBoard3Day === 'function') {
    try {
      const b3 = await getBoard3Day()
      todayBoard = (b3?.board || []).map(t => {
        const d = (t.days || [])[0] || {}
        return { trade: t.trade, booked: d.calls, capacity: d.capacity, needed: d.needed, pct: d.pct }
      })
    } catch (e) { console.warn('digest board:', e.message) }
  }

  // ── Reviews ───────────────────────────────────────────────────────────────
  const fiveStar = reviews.filter(r => Number(r.rating || r.reviewRating) >= 5).length

  // ── Month to date + pace against budget ──────────────────────────────────
  let mtd = null
  try {
    const monthStart = `${dateStr.slice(0, 7)}-01`
    const { startIso: mStart } = denverDayBounds(monthStart)
    const [mSold, mInv] = await Promise.all([
      safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${mStart}&soldBefore=${endIso}&pageSize=500&page=${pg}`, 8000), []),
      safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${monthStart}T00:00:00Z&invoicedOnBefore=${invTo}&pageSize=500&page=${pg}`, 8000), []),
    ])
    let mSales = 0, mRev = 0
    for (const e of mSold) if ((e.status || {}).name === 'Sold') mSales += Number(e.subtotal) || 0
    for (const i of mInv) mRev += Number(i.subTotal) || 0

    let budget = { monthlyRevenueTarget: 1375920, weeklyDeptBudget: { HVAC: 210000, Plumbing: 110000, Electrical: 80000, 'Garage Doors': 30000 } }
    try {
      const { data } = await supabase.from('app_settings').select('value').eq('key', 'digest_budgets').maybeSingle()
      if (data?.value) budget = { ...budget, ...JSON.parse(data.value) }
    } catch {}

    const day = Number(dateStr.slice(8, 10))
    const daysInMonth = new Date(Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)), 0).getDate()
    const expected = budget.monthlyRevenueTarget * (day / daysInMonth)
    mtd = {
      daysElapsed: day, daysInMonth,
      sales: Math.round(mSales), revenue: Math.round(mRev),
      revenueTarget: budget.monthlyRevenueTarget,
      pacedTarget: Math.round(expected),
      variancePct: expected ? (mRev - expected) / expected : null,
      projectedMonth: day ? Math.round(mRev / day * daysInMonth) : null,
    }
  } catch (e) { console.warn('digest mtd:', e.message) }

  return {
    date: dateStr,
    sales: { ...sales, total: Math.round(sales.total), byTrade: Object.fromEntries(Object.entries(sales.byTrade).map(([k, v]) => [k, Math.round(v)])) },
    closeRate,
    revenue: { ...revenue, total: Math.round(revenue.total), byTrade: Object.fromEntries(Object.entries(revenue.byTrade).map(([k, v]) => [k, Math.round(v)])) },
    technicians, dispatch, callCenter, marketing,
    reviews: { total: reviews.length, fiveStar },
    memberships: memberships.length,
    membershipAttach: dispatch.jobsRan ? memberships.length / dispatch.jobsRan : null,
    leftBehind, unbooked, priorWeek, todayBoard,
    mtd,
  }
}

// ── AI insights: what a sharp GM would notice in these numbers ──────────────
async function generateInsights(facts, anthropicKey) {
  if (!anthropicKey) return []
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 900,
        system: `You are the operations analyst for Awesome Home Services (HVAC, plumbing, electrical, garage doors — Colorado Springs), writing the "what actually matters" section of the owner's morning digest. You get yesterday's numbers as JSON. Rules: only cite numbers present in the data — never invent or estimate. Each insight names the number AND what to do about it. Prefer the non-obvious: a department whose close rate contradicts its sales, a tech whose average ticket is carrying (or sinking) their team, a marketing channel spending calls without booking, jobs that ran and produced nothing (leftBehind), a call-center gap. If something looks like a data gap rather than a business problem, say so plainly instead of drawing a false conclusion. No fluff, no congratulations, no restating the tables.

Also write CSR coaching. callCenter.coaching holds each CSR's QA average and the exact rubric criteria they lost points on (weakest, with how often they missed each). For each CSR with evaluations, give ONE specific thing to praise and ONE thing to coach, naming the behavior and its number — e.g. "missed email capture on 4 of 5 calls." Coaching must be about the behavior, never the person. If a CSR has fewer than 3 evaluations, say the sample is thin rather than drawing a conclusion.`,
        tools: [{
          name: 'submit_insights',
          description: 'Submit the morning insights',
          input_schema: {
            type: 'object',
            properties: {
              headline: { type: 'string', description: 'One sentence: the single most important thing about yesterday.' },
              insights: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', description: 'The insight, with its number, one or two sentences.' },
                    action: { type: 'string', description: 'The concrete next step for today.' },
                  },
                  required: ['text', 'action'],
                },
              },
              csrCoaching: {
                type: 'array',
                description: 'One entry per CSR who had evaluations or recorded calls yesterday.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    working: { type: 'string', description: 'What they did well, with the number.' },
                    coach: { type: 'string', description: 'The one behavior to coach, with how often it was missed.' },
                  },
                  required: ['name', 'working', 'coach'],
                },
              },
            },
            required: ['headline', 'insights'],
          },
        }],
        tool_choice: { type: 'tool', name: 'submit_insights' },
        messages: [{ role: 'user', content: `Yesterday's numbers:\n${JSON.stringify(facts).slice(0, 24000)}` }],
      }),
    })
    if (!r.ok) return []
    const out = (await r.json())?.content?.find(c => c.type === 'tool_use')?.input
    return out ? { headline: out.headline, insights: (out.insights || []).slice(0, 6), csrCoaching: (out.csrCoaching || []).slice(0, 8) } : []
  } catch (e) {
    console.warn('digest insights:', e.message)
    return []
  }
}

// ── Email HTML ──────────────────────────────────────────────────────────────
const C = { ink: '#0F172A', mute: '#64748B', line: '#E2E8F0', good: '#15803D', bad: '#B91C1C', warn: '#B45309', accent: '#ff751f' }

const card = (label, value, sub) => `
  <td style="padding:14px 16px;border:1px solid ${C.line};border-radius:10px;vertical-align:top">
    <div style="font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:${C.mute}">${esc(label)}</div>
    <div style="font-size:24px;font-weight:800;color:${C.ink};line-height:1.15;margin-top:4px">${esc(value)}</div>
    ${sub ? `<div style="font-size:11px;color:${C.mute};margin-top:3px">${esc(sub)}</div>` : ''}
  </td>`

const section = (title, inner) => `
  <div style="margin:26px 0 0">
    <div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${C.mute};border-bottom:2px solid ${C.line};padding-bottom:6px;margin-bottom:12px">${esc(title)}</div>
    ${inner}
  </div>`

const table = (headers, rows) => `
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr>${headers.map((h, i) => `<th style="text-align:${i ? 'right' : 'left'};padding:6px 8px;border-bottom:1px solid ${C.line};font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:${C.mute}">${esc(h)}</th>`).join('')}</tr>
    ${rows.map(r => `<tr>${r.map((c, i) => `<td style="text-align:${i ? 'right' : 'left'};padding:7px 8px;border-bottom:1px solid ${C.line};${i === 0 ? 'font-weight:600' : ''}">${c}</td>`).join('')}</tr>`).join('')}
  </table>`

export function renderDigestHtml(f, ai) {
  const dayLabel = new Date(`${f.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })

  const tradeRows = TRADES.map(t => {
    const cr = f.closeRate.byTrade[t] || {}
    return [
      esc(t),
      money(f.sales.byTrade[t] || 0),
      money(f.revenue.byTrade[t] || 0),
      cr.presented ? `${pct(cr.rate)} <span style="color:${C.mute};font-size:11px">(${cr.sold}/${cr.presented})</span>` : '—',
    ]
  })

  const top = f.technicians.filter(t => t.soldAmount > 0).slice(0, 5)
  const bottom = f.technicians.filter(t => t.presented >= 2).slice(-3).reverse()

  const insightHtml = ai?.insights?.length ? `
    <div style="background:#FFF7ED;border-left:4px solid ${C.accent};border-radius:8px;padding:14px 16px;margin-top:8px">
      ${ai.headline ? `<div style="font-size:14px;font-weight:800;color:${C.ink};margin-bottom:10px">${esc(ai.headline)}</div>` : ''}
      ${ai.insights.map(i => `
        <div style="margin-bottom:10px">
          <div style="font-size:13px;color:${C.ink};line-height:1.5">${esc(i.text)}</div>
          <div style="font-size:12px;color:${C.accent};font-weight:600;margin-top:2px">→ ${esc(i.action)}</div>
        </div>`).join('')}
    </div>` : ''

  const mtdHtml = f.mtd ? `
    <table style="width:100%;border-collapse:separate;border-spacing:8px 0"><tr>
      ${card('MTD Revenue', money(f.mtd.revenue), `day ${f.mtd.daysElapsed} of ${f.mtd.daysInMonth}`)}
      ${card('Pace target', money(f.mtd.pacedTarget), 'where we should be')}
      ${card('Variance', `${f.mtd.variancePct >= 0 ? '+' : ''}${pct(f.mtd.variancePct)}`, f.mtd.variancePct >= 0 ? 'ahead of pace' : 'behind pace')}
      ${card('Projected month', money(f.mtd.projectedMonth), `target ${money(f.mtd.revenueTarget)}`)}
    </tr></table>` : ''

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:720px;margin:0 auto;color:${C.ink};padding:8px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:2px">
      <span style="font-size:19px;font-weight:800">Yesterday at AHS</span>
    </div>
    <div style="font-size:13px;color:${C.mute};margin-bottom:18px">${esc(dayLabel)}</div>

    <table style="width:100%;border-collapse:separate;border-spacing:8px 0"><tr>
      ${card('Sales sold', money(f.sales.total), f.priorWeek?.salesDelta != null
        ? `${f.priorWeek.salesDelta >= 0 ? '+' : ''}${pct(f.priorWeek.salesDelta)} vs last ${new Date(`${f.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}`
        : `${f.sales.count} estimates`)}
      ${card('Revenue', money(f.revenue.total), f.priorWeek?.revenueDelta != null
        ? `${f.priorWeek.revenueDelta >= 0 ? '+' : ''}${pct(f.priorWeek.revenueDelta)} vs last week`
        : `${f.revenue.count} invoices`)}
      ${card('Close rate', pct(f.closeRate.rate), `${f.closeRate.sold} of ${f.closeRate.presented} presented`)}
      ${card('Jobs run', String(f.dispatch.jobsRan), `${f.dispatch.techsWorked} techs · ${f.dispatch.jobsPerTech ?? '—'}/tech`)}
    </tr></table>

    ${ai?.insights?.length ? section('Key insights', insightHtml) : ''}

    ${section('By department', table(['Department', 'Sales', 'Revenue', 'Close rate'], tradeRows))}

    ${f.mtd ? section('Month to date', mtdHtml) : ''}

    ${top.length ? section('Top performers', table(['Technician', 'Sold', 'Avg ticket', 'Close', 'Jobs'],
      top.map(t => [esc(t.name), money(t.soldAmount), money(t.avgTicket), t.presented ? pct(t.closeRate) : '—', String(t.jobsRan)]))) : ''}

    ${bottom.length ? section('Needs attention', `
      <div style="font-size:11.5px;color:${C.mute};margin-bottom:8px">Techs who had at least 2 estimates presented and sold the least — coaching list, not a scoreboard.</div>
      ${table(['Technician', 'Sold', 'Close', 'Presented', 'Jobs'],
        bottom.map(t => [esc(t.name), money(t.soldAmount), t.presented ? pct(t.closeRate) : '—', String(t.presented), String(t.jobsRan)]))}`) : ''}

    ${section('Call center — inbound', `
      <table style="width:100%;border-collapse:separate;border-spacing:8px 0"><tr>
        ${card('Lead calls', String(f.callCenter.leadCalls), `of ${f.callCenter.totalInbound} inbound${f.callCenter.abandoned ? ` · ${f.callCenter.abandoned} abandoned` : ''}`)}
        ${card('Booked', String(f.callCenter.bookedByCsr), f.callCenter.bookingPct == null ? '' : `${pct(f.callCenter.bookingPct)} of leads`)}
        ${card('Avg talk', f.callCenter.avgTalkSec == null ? '—' : `${Math.round(f.callCenter.avgTalkSec / 60)}m`, 'on lead calls')}
        ${card('Call QA', f.callCenter.qaAvg == null ? '—' : `${f.callCenter.qaAvg}%`, `${f.callCenter.qaCount} scored in Andi`)}
      </tr></table>
      ${f.callCenter.byRep.length ? `<div style="margin-top:12px">${table(['CSR', 'Lead calls', 'Booked', 'Book rate', 'Total inbound', 'Outbound'],
        f.callCenter.byRep.map(r => [esc(r.name), String(r.leadCalls), String(r.booked), r.bookRate == null ? '—' : pct(r.bookRate), String(r.inbound), String(r.outbound)]))}</div>` : ''}
      <div style="font-size:11px;color:${C.mute};margin-top:8px">Lead calls = Booked + Unbooked (the calls the team is measured on); "total inbound" also includes non-lead calls (spam / robocalls / non-lead), excluded from lead counts. Per-CSR from ServiceTitan call records; QA from Andi evaluations (calls taken in Andi only, for now).${f.callCenter.outboundOnly?.people ? ` ${f.callCenter.outboundOnly.calls} more outbound calls by ${f.callCenter.outboundOnly.people} field/other staff not shown.` : ''}</div>`)}

    ${section('Call center — outbound', `
      <table style="width:100%;border-collapse:separate;border-spacing:8px 0"><tr>
        ${card('Outbound dials', String(f.callCenter.outboundDials), f.callCenter.outboundOnly?.calls ? `+${f.callCenter.outboundOnly.calls} by field staff` : 'CSR outbound')}
        ${card('Voicemails', String(f.callCenter.voicemails ?? 0), 'inbound voicemails')}
      </tr></table>
      <div style="font-size:11px;color:${C.mute};margin-top:8px">Outbound is CSR follow-up dialing — separate from lead calls above. Per-CSR outbound is in the inbound table's last column.</div>`)}

    ${(ai?.csrCoaching?.length || f.callCenter.coaching.length) ? section('CSR coaching', `
      ${ai?.csrCoaching?.length ? ai.csrCoaching.map(c => `
        <div style="border:1px solid ${C.line};border-radius:9px;padding:11px 13px;margin-bottom:8px">
          <div style="font-size:13px;font-weight:700;color:${C.ink};margin-bottom:5px">${esc(c.name)}</div>
          <div style="font-size:12.5px;color:${C.good};line-height:1.5">✓ ${esc(c.working)}</div>
          <div style="font-size:12.5px;color:${C.warn};line-height:1.5;margin-top:3px">→ ${esc(c.coach)}</div>
        </div>`).join('') : ''}
      ${f.callCenter.coaching.length ? `<div style="margin-top:10px">${table(['CSR', 'QA avg', 'Evals', 'Calls', 'Booked', 'Most-missed'],
        f.callCenter.coaching.map(c => [
          esc(c.name),
          c.qa == null ? '—' : `${c.qa}%`,
          String(c.evals),
          String(c.callsRecorded),
          c.callsRecorded ? `${c.bookedFromCalls} (${pct(c.callBookRate)})` : '—',
          c.weakest.length ? `<span style="font-size:11.5px;color:${C.mute}">${esc(c.weakest[0].criterion)} — ${c.weakest[0].missedOn}/${c.weakest[0].of}</span>` : '—',
        ]))}</div>` : ''}`) : ''}

    ${section('Money left behind', `
      <table style="width:100%;border-collapse:separate;border-spacing:8px 0"><tr>
        ${card('No estimate written', String(f.leftBehind.noEstimateWritten), `of ${f.leftBehind.jobsRan} jobs run`)}
        ${card('Presented, not sold', String(f.leftBehind.presentedNotSold), 'still winnable')}
        ${card('Open estimate value', money(f.leftBehind.openEstimateValue), `${f.leftBehind.openEstimateCount} open`)}
        ${card('Unbooked calls', String(f.unbooked.total), 'people who called and didn’t book')}
      </tr></table>
      ${f.unbooked.byCampaign.length ? `<div style="font-size:11.5px;color:${C.mute};margin-top:10px">Unbooked by channel: ${f.unbooked.byCampaign.map(c => `${esc(c.name)} (${c.count})`).join(' · ')} — these are callable today.</div>` : ''}`)}

    ${f.todayBoard?.length ? section('Today’s board', `
      <div style="font-size:11.5px;color:${C.mute};margin-bottom:8px">What the floor needs to fill before the day gets away.</div>
      ${table(['Trade', 'Booked', 'Capacity', 'Calls needed'],
        f.todayBoard.map(t => [
          esc(t.trade), String(t.booked ?? '—'), String(t.capacity ?? '—'),
          t.needed > 0 ? `<span style="color:${C.bad};font-weight:700">${t.needed}</span>` : `<span style="color:${C.good}">full</span>`,
        ]))}`) : ''}

    ${section('Marketing', `
      <table style="width:100%;border-collapse:separate;border-spacing:8px 0"><tr>
        ${card('Lead calls', String(f.marketing.leadCalls), 'booked + unbooked')}
        ${card('Booked', String(f.marketing.booked), pct(f.marketing.bookingRate) + ' booking rate')}
        ${card('5★ reviews', String(f.reviews.fiveStar), `${f.reviews.total} total`)}
        ${card('Memberships', String(f.memberships), 'sold yesterday')}
      </tr></table>
      ${f.marketing.campaigns.length ? `<div style="margin-top:12px">${table(['Campaign', 'Calls', 'Booked', 'Rate'],
        f.marketing.campaigns.map(c => [esc(c.name), String(c.calls), String(c.booked), pct(c.rate)]))}</div>` : ''}`)}

    <div style="margin-top:26px;padding-top:12px;border-top:1px solid ${C.line};font-size:11px;color:${C.mute};line-height:1.6">
      Sales = estimates marked Sold in ServiceTitan · Revenue = invoiced subtotals · Close rate = jobs sold ÷ jobs where an estimate was presented ·
      Call center + QA from Andi. Reply to this email with anything you want added or changed.
    </div>
  </div>`
}

export async function buildDailyDigest(deps) {
  const facts = await gatherDigestFacts(deps)
  const ai = await generateInsights(facts, deps.anthropicKey)
  const label = new Date(`${facts.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const subject = `AHS ${label}: ${money(facts.sales.total)} sold · ${money(facts.revenue.total)} revenue · ${pct(facts.closeRate.rate)} close`
  return { subject, html: renderDigestHtml(facts, ai), facts, ai }
}
