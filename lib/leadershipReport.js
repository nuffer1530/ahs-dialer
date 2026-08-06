// ── Weekly Leadership Report: the meeting agenda, generated ─────────────────
//
// Replaces the hand-entered "Weekly Leadership Agenda" spreadsheet. Every
// metric uses the definitions calibrated against that sheet in Jul 2026
// (sold estimates = sales, invoice subTotals = revenue, telecom callType =
// booking %, presented jobs = opportunities), so the generated numbers
// reconcile with what leadership already trusts.
//
// A "week" is Monday→Sunday in Denver, keyed by its Sunday (weekEnd), matching
// the W/E dates the old sheet used. Degrades cleanly: any section that fails
// to fetch is omitted, never fatal.

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
const r0 = (n) => Math.round(Number(n) || 0)

// Denver-local day boundaries for YYYY-MM-DD, as UTC ISO (DST-safe).
function denverDayBounds(dateStr) {
  const noonUtc = new Date(`${dateStr}T18:00:00Z`)
  const denverHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', hour: '2-digit', hour12: false,
  }).format(noonUtc))
  const offset = 18 - denverHour
  const start = new Date(`${dateStr}T00:00:00Z`)
  start.setUTCHours(offset)
  const end = new Date(start.getTime() + 24 * 3600_000)
  return { startIso: start.toISOString(), endIso: end.toISOString(), offset }
}

const shiftDate = (dateStr, days) => {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Most recent COMPLETED week's Sunday, in Denver. On a Monday this is
// yesterday; mid-week it's the Sunday just past.
export function latestCompletedSunday() {
  const todayDenver = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())
  const dow = new Date(`${todayDenver}T12:00:00Z`).getUTCDay()   // 0=Sun
  return shiftDate(todayDenver, dow === 0 ? -7 : -dow)
}

const DEFAULT_BUDGETS = {
  weeklySalesGoal: 350000,
  monthlyRevenueTarget: 1375920,
  dept: {
    HVAC: { budget: 210000, conv: 0.7, gm: 0.5, labor: 0.25, rev: 195000 },
    Plumbing: { budget: 110000, conv: 0.7, gm: 0.56, labor: 0.25, rev: 100000 },
    Electrical: { budget: 80000, conv: 0.7, gm: 0.6, labor: 0.25, rev: 75000 },
    'Garage Doors': { budget: 30000, conv: 0.7, gm: 0.6, labor: 0.25, rev: 25000 },
  },
  kpi: { booking: 0.8, clubs: 15, reviews: 20, close: 0.7, gm: 0.55 },
}

// Burden factors from the Aug 2026 ADP TotalSource analysis: field burden
// multiplier includes taxes/WC/admin fee/benefits; poolUplift is actual field
// payroll ÷ commission-implied labor (fallback top-ups, shop/meeting/warranty
// time, spiffs). Overridable via app_settings 'labor_burden' with no deploy.
const DEFAULT_BURDEN = { fieldBurden: 1.243, poolUplift: 1.331, officeWeeklyCost: 38985, commissionRate: 0.18 }

async function settingsJson(supabase, key, fallback) {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle()
    if (data?.value) return { ...fallback, ...JSON.parse(data.value) }
  } catch {}
  return fallback
}

export async function gatherWeeklyFacts({ stGet, stPageAll, supabase, tenantId, weekEnd }) {
  const weekStart = shiftDate(weekEnd, -6)
  const { startIso } = denverDayBounds(weekStart)
  const { endIso } = denverDayBounds(weekEnd)
  const pWeekEnd = shiftDate(weekEnd, -7)
  const pWeekStart = shiftDate(weekEnd, -13)
  const { startIso: pStartIso } = denverDayBounds(pWeekStart)
  const { endIso: pEndIso } = denverDayBounds(pWeekEnd)
  const trendStart = shiftDate(weekEnd, -41)                     // 6 weeks incl. this one
  const { startIso: trendIso } = denverDayBounds(trendStart)
  const monthStart = `${weekEnd.slice(0, 7)}-01`
  const { startIso: monthIso } = denverDayBounds(monthStart)
  // Same-aligned week last year (−364 keeps the weekday), for seasonal trades.
  const yoyEnd = shiftDate(weekEnd, -364)
  const yoyStart = shiftDate(yoyEnd, -6)
  const { startIso: yoyStartIso } = denverDayBounds(yoyStart)
  const { endIso: yoyEndIso } = denverDayBounds(yoyEnd)
  // Prior month, same day-count (MTD apples to apples).
  const pmStart = (() => { const d = new Date(`${monthStart}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10) })()
  const pmDayCap = new Date(Number(pmStart.slice(0, 4)), Number(pmStart.slice(5, 7)), 0).getDate()
  const pmEnd = `${pmStart.slice(0, 7)}-${String(Math.min(Number(weekEnd.slice(8, 10)), pmDayCap)).padStart(2, '0')}`
  const { startIso: pmStartIso } = denverDayBounds(pmStart)
  const { endIso: pmEndIso } = denverDayBounds(pmEnd)

  const safe = (p, fallback) => p.then(r => r).catch(e => { console.warn('leadership fetch:', e.message); return fallback })

  const [estSold6w, estCreated, estCreatedPrior, invWeek, invPrior, invMtd, telecom, telecomPrior,
    memberships, membershipsPrior, reviews, reviewsPrior, appts, spiffRows] = await Promise.all([
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${trendIso}&soldBefore=${endIso}&pageSize=500&page=${pg}`, 15000), []),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?createdOnOrAfter=${startIso}&createdBefore=${endIso}&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?createdOnOrAfter=${pStartIso}&createdBefore=${pEndIso}&pageSize=500&page=${pg}`, 6000), []),
    // Invoice dates are date-only in ST — bound on calendar days.
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${weekStart}T00:00:00Z&invoicedOnBefore=${weekEnd}T23:59:59Z&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${pWeekStart}T00:00:00Z&invoicedOnBefore=${pWeekEnd}T23:59:59Z&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${monthStart}T00:00:00Z&invoicedOnBefore=${weekEnd}T23:59:59Z&pageSize=500&page=${pg}`, 12000), []),
    safe(stPageAll(pg => `/telecom/v2/tenant/${tenantId}/calls?createdOnOrAfter=${startIso}&createdBefore=${endIso}&pageSize=500&page=${pg}`, 12000), []),
    safe(stPageAll(pg => `/telecom/v2/tenant/${tenantId}/calls?createdOnOrAfter=${pStartIso}&createdBefore=${pEndIso}&pageSize=500&page=${pg}`, 12000), []),
    safe(stPageAll(pg => `/memberships/v2/tenant/${tenantId}/memberships?createdOnOrAfter=${startIso}&createdBefore=${endIso}&pageSize=500&page=${pg}`, 2000), []),
    safe(stPageAll(pg => `/memberships/v2/tenant/${tenantId}/memberships?createdOnOrAfter=${pStartIso}&createdBefore=${pEndIso}&pageSize=500&page=${pg}`, 2000), []),
    safe(stGet(`/marketingreputation/v2/tenant/${tenantId}/reviews?fromDate=${weekStart}&toDate=${weekEnd}&pageSize=200`).then(d => d?.data || []), []),
    safe(stGet(`/marketingreputation/v2/tenant/${tenantId}/reviews?fromDate=${pWeekStart}&toDate=${pWeekEnd}&pageSize=200`).then(d => d?.data || []), []),
    safe(stPageAll(pg => `/jpm/v2/tenant/${tenantId}/appointments?startsOnOrAfter=${startIso}&pageSize=500&page=${pg}`, 6000), []),
    safe(supabase.from('job_type_spiffs').select('st_job_type_id, name, category').then(r => r.data || []), []),
  ])
  const [estYoy, invYoy, estPm, invPm] = await Promise.all([
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${yoyStartIso}&soldBefore=${yoyEndIso}&pageSize=500&page=${pg}`, 4000), []),
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${yoyStart}T00:00:00Z&invoicedOnBefore=${yoyEnd}T23:59:59Z&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${pmStartIso}&soldBefore=${pmEndIso}&pageSize=500&page=${pg}`, 8000), []),
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${pmStart}T00:00:00Z&invoicedOnBefore=${pmEnd}T23:59:59Z&pageSize=500&page=${pg}`, 12000), []),
  ])

  const budgets = await settingsJson(supabase, 'leadership_budgets', DEFAULT_BUDGETS)
  const burden = await settingsJson(supabase, 'labor_burden', DEFAULT_BURDEN)
  const catByName = new Map(spiffRows.map(r => [r.name, r.category]))
  const catById = new Map(spiffRows.map(r => [String(r.st_job_type_id), { name: r.name, category: r.category }]))

  const inWeek = (iso) => { const t = Date.parse(iso || ''); return !Number.isNaN(t) && t >= Date.parse(startIso) && t < Date.parse(endIso) }

  // ── Sales: sold estimates this week (from the 6-week pull) ────────────────
  const sold6w = estSold6w.filter(e => (e.status || {}).name === 'Sold')
  const soldWeek = sold6w.filter(e => inWeek(e.soldOn))
  const soldJobIds = new Set(soldWeek.map(e => e.jobId).filter(Boolean))
  const soldByTech = new Map()
  const byTrade = {}
  for (const t of TRADES) byTrade[t] = { sales: 0, estimates: 0, revenue: 0, presented: new Set(), soldJobs: new Set(), unpaid: 0, commBase: 0 }
  let salesTotal = 0, salesCount = 0
  for (const e of soldWeek) {
    const amt = Number(e.subtotal) || 0
    salesTotal += amt; salesCount++
    const t = tradeOf(e.businessUnitName)
    if (t) { byTrade[t].sales += amt; byTrade[t].estimates++ }
    if (e.soldBy) {
      const cur = soldByTech.get(e.soldBy) || { amount: 0, count: 0 }
      cur.amount += amt; cur.count++
      soldByTech.set(e.soldBy, cur)
    }
  }

  // ── Opportunities = jobs where an estimate was presented (matches sheet) ──
  const presentedJobs = new Set(estCreated.map(e => e.jobId).filter(Boolean))
  for (const e of estCreated) {
    const t = tradeOf(e.businessUnitName)
    if (t && e.jobId) byTrade[t].presented.add(e.jobId)
  }
  for (const e of soldWeek) {
    const t = tradeOf(e.businessUnitName)
    if (t && e.jobId) byTrade[t].soldJobs.add(e.jobId)
  }
  const presentedPrior = new Set(estCreatedPrior.map(e => e.jobId).filter(Boolean))
  const presentedPriorByTrade = {}
  for (const e of estCreatedPrior) {
    const t = tradeOf(e.businessUnitName)
    if (t && e.jobId) (presentedPriorByTrade[t] = presentedPriorByTrade[t] || new Set()).add(e.jobId)
  }

  // ── Revenue + collections + commissionable base ───────────────────────────
  let revenueTotal = 0, unpaidTotal = 0, commBaseTotal = 0
  for (const i of invWeek) {
    const amt = Number(i.subTotal) || 0
    const t = tradeOf((i.businessUnit || {}).name)
    const paid = (Number(i.balance) || 0) === 0
    revenueTotal += amt
    if (t) byTrade[t].revenue += amt
    if (!paid) { unpaidTotal += amt; if (t) byTrade[t].unpaid += amt }
    const cat = catByName.get((i.job || {}).type)
    if (paid && (cat === 'repair' || cat === 'other')) {
      commBaseTotal += amt
      if (t) byTrade[t].commBase += amt
    }
  }

  // ── Department scorecard ──────────────────────────────────────────────────
  const scorecard = TRADES.map(t => {
    const d = byTrade[t]
    const cfg = budgets.dept[t] || {}
    const opps = d.presented.size
    const soldJobs = [...d.presented].filter(j => d.soldJobs.has(j)).length
    const close = opps ? soldJobs / opps : null
    const avgSale = d.estimates ? d.sales / d.estimates : null
    // Same formula the sheet used: conversion gap × opps × avg sale.
    const missedSales = (close != null && avgSale && cfg.conv) ? Math.max(0, (cfg.conv - close) * opps * avgSale) : null
    // Opps NEEDED to hit budget at this week's actual close rate and ticket.
    const oppsNeeded = (close && avgSale) ? budgets.dept[t].budget / (close * avgSale) : null
    // True burdened labor from the commission model (see DEFAULT_BURDEN).
    const trueLabor = d.commBase * burden.commissionRate * burden.poolUplift * burden.fieldBurden
    return {
      trade: t,
      sales: r0(d.sales), budget: cfg.budget || 0, variance: r0(d.sales - (cfg.budget || 0)),
      revenue: r0(d.revenue), revTarget: cfg.rev || 0,
      estimates: d.estimates, opps, soldJobs,
      closeRate: close, convTarget: cfg.conv || null,
      avgSale: avgSale != null ? r0(avgSale) : null,
      missedSales: missedSales != null ? r0(missedSales) : null,
      oppsNeeded: oppsNeeded != null ? Math.ceil(oppsNeeded) : null,
      unpaid: r0(d.unpaid),
      commBase: r0(d.commBase),
      trueLabor: r0(trueLabor),
      trueLaborPct: d.revenue ? trueLabor / d.revenue : null,
      laborTarget: cfg.labor || null,
      gmTarget: cfg.gm || null,
    }
  })

  // ── KPIs with week-over-week ──────────────────────────────────────────────
  const bookStats = (calls) => {
    let booked = 0, unbooked = 0
    for (const c of calls) {
      const lc = c.leadCall || c
      if ((lc.direction || '') !== 'Inbound') continue
      if (lc.callType === 'Booked') booked++
      else if (lc.callType === 'Unbooked') unbooked++
    }
    const total = booked + unbooked
    return { booked, unbooked, total, rate: total ? booked / total : null }
  }
  const bk = bookStats(telecom), bkP = bookStats(telecomPrior)
  const fiveStar = reviews.filter(r => Number(r.rating || r.reviewRating) >= 5).length
  const fiveStarPrior = reviewsPrior.filter(r => Number(r.rating || r.reviewRating) >= 5).length
  const closeAll = presentedJobs.size ? [...presentedJobs].filter(j => soldJobIds.has(j)).length / presentedJobs.size : null
  const soldPriorJobs = new Set(sold6w.filter(e => {
    const t = Date.parse(e.soldOn || '')
    return !Number.isNaN(t) && t >= Date.parse(pStartIso) && t < Date.parse(pEndIso)
  }).map(e => e.jobId).filter(Boolean))
  const closePrior = presentedPrior.size ? [...presentedPrior].filter(j => soldPriorJobs.has(j)).length / presentedPrior.size : null

  const kpis = [
    { kpi: 'Booking %', thisWk: bk.rate, lastWk: bkP.rate, goal: budgets.kpi.booking, fmt: 'pct' },
    { kpi: 'Lead Volume', thisWk: bk.total, lastWk: bkP.total, goal: null, fmt: 'int' },
    { kpi: 'Clubs Sold', thisWk: memberships.length, lastWk: membershipsPrior.length, goal: budgets.kpi.clubs, fmt: 'int' },
    { kpi: '5 Star Reviews', thisWk: fiveStar, lastWk: fiveStarPrior, goal: budgets.kpi.reviews, fmt: 'int' },
    { kpi: 'Close Rate', thisWk: closeAll, lastWk: closePrior, goal: budgets.kpi.close, fmt: 'pct' },
  ]

  // ── 6-week sales trend ────────────────────────────────────────────────────
  const trend = []
  for (let w = 5; w >= 0; w--) {
    const we = shiftDate(weekEnd, -7 * w)
    const ws = shiftDate(we, -6)
    const { startIso: s } = denverDayBounds(ws)
    const { endIso: e2 } = denverDayBounds(we)
    let amt = 0
    for (const e of sold6w) {
      const t = Date.parse(e.soldOn || '')
      if (!Number.isNaN(t) && t >= Date.parse(s) && t < Date.parse(e2)) amt += Number(e.subtotal) || 0
    }
    trend.push({ weekEnd: we, sales: r0(amt), goal: budgets.weeklySalesGoal, hit: amt >= budgets.weeklySalesGoal })
  }

  // ── Technicians: jobs run, sold, close, callbacks → composite ─────────────
  const weekAppts = appts.filter(a => inWeek(a.start) && a.status !== 'Canceled')
  const techJobs = new Map()
  try {
    const ids = weekAppts.map(a => a.id).filter(Boolean)
    const apptById = new Map(weekAppts.map(a => [a.id, a]))
    for (let i = 0; i < ids.length; i += 50) {
      const r = await stGet(`/dispatch/v2/tenant/${tenantId}/appointment-assignments?appointmentIds=${ids.slice(i, i + 50).join(',')}&pageSize=200`)
      for (const asg of (r?.data || [])) {
        if (asg.active === false) continue
        const appt = apptById.get(asg.appointmentId)
        if (!appt?.jobId) continue
        if (!techJobs.has(asg.technicianId)) techJobs.set(asg.technicianId, new Set())
        techJobs.get(asg.technicianId).add(appt.jobId)
      }
    }
  } catch (e) { console.warn('leadership assignments:', e.message) }

  const techNames = new Map()
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

  // Callback / warranty / no-charge flags per job, via job type.
  const jobFlags = new Map()   // jobId -> label
  try {
    const ranIds = [...new Set([...techJobs.values()].flatMap(s => [...s]))]
    for (let i = 0; i < ranIds.length; i += 50) {
      const r = await stGet(`/jpm/v2/tenant/${tenantId}/jobs?ids=${ranIds.slice(i, i + 50).join(',')}&pageSize=50`)
      for (const j of (r?.data || [])) {
        const info = catById.get(String(j.jobTypeId))
        if (!info) continue
        if (/callback|warranty|recall|concern/i.test(info.name)) jobFlags.set(j.id, info.name)
      }
    }
  } catch (e) { console.warn('leadership job flags:', e.message) }

  let technicians = []
  for (const [techId, jobs] of techJobs) {
    const info = techNames.get(String(techId)) || {}
    const s = soldByTech.get(techId) || { amount: 0, count: 0 }
    const presented = [...jobs].filter(j => presentedJobs.has(j)).length
    const soldJobs = [...jobs].filter(j => soldJobIds.has(j)).length
    const callbacks = [...jobs].filter(j => jobFlags.has(j)).length
    technicians.push({
      name: info.name || `Tech ${techId}`, tier: info.tier || null,
      jobsRan: jobs.size, presented, soldJobs,
      closeRate: presented ? soldJobs / presented : null,
      soldAmount: r0(s.amount),
      avgTicket: s.count ? r0(s.amount / s.count) : 0,
      dollarsPerOpp: presented ? r0(s.amount / presented) : null,
      callbacks,
    })
  }
  // Composite: revenue carries 40%, close rate 30%, $/opportunity 30% — so a
  // tech run on cheap calls isn't buried, and a lucky one-ticket week doesn't
  // auto-win. Only techs with 3+ presented opportunities are scored.
  const scored = technicians.filter(t => t.presented >= 3)
  const maxRev = Math.max(1, ...scored.map(t => t.soldAmount))
  const maxDpo = Math.max(1, ...scored.map(t => t.dollarsPerOpp || 0))
  for (const t of technicians) {
    t.score = t.presented >= 3
      ? Math.round(100 * (0.4 * t.soldAmount / maxRev + 0.3 * Math.min(1, t.closeRate || 0) + 0.3 * (t.dollarsPerOpp || 0) / maxDpo))
      : null
  }
  technicians.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.soldAmount - a.soldAmount)

  // ── CSRs straight from ServiceTitan: every inbound lead call carries the
  // agent who took it, so answered/booked/rate come from the same telecom data
  // as booking %. Andi's AI QA score is folded in when the name matches.
  let csrs = []
  try {
    const csrMap = new Map()
    for (const c of telecom) {
      const lc = c.leadCall || c
      if ((lc.direction || '') !== 'Inbound' || !['Booked', 'Unbooked'].includes(lc.callType)) continue
      const name = ((lc.agent || {}).name || 'Unknown').trim()
      const cur = csrMap.get(name) || { name, answered: 0, booked: 0 }
      cur.answered++
      if (lc.callType === 'Booked') cur.booked++
      csrMap.set(name, cur)
    }
    const evalByRep = new Map()
    try {
      const { data: evals } = await supabase.from('call_evaluations').select('rep, pct').gte('created_at', startIso).lt('created_at', endIso)
      for (const e of (evals || [])) {
        if (e.pct == null || !e.rep) continue
        const k = e.rep.trim().toLowerCase()
        if (!evalByRep.has(k)) evalByRep.set(k, [])
        evalByRep.get(k).push(Number(e.pct))
      }
    } catch {}
    csrs = [...csrMap.values()].map(r => {
      const qaList = evalByRep.get(r.name.toLowerCase()) || []
      return {
        name: r.name, answered: r.answered, booked: r.booked,
        bookRate: r.answered ? r.booked / r.answered : null,
        qa: qaList.length ? Math.round(qaList.reduce((a, b) => a + b, 0) / qaList.length) : null,
        evals: qaList.length,
      }
    })
    const eligible = csrs.filter(c => c.answered >= 10)
    const maxBooked = Math.max(1, ...eligible.map(c => c.booked))
    for (const c of csrs) {
      c.score = c.answered >= 10
        ? Math.round(100 * (0.4 * c.booked / maxBooked + 0.3 * Math.min(1, c.bookRate || 0) + 0.3 * (c.qa ?? 70) / 100))
        : null
    }
    csrs.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.booked - a.booked)
  } catch (e) { console.warn('leadership csrs:', e.message) }

  // ── Marketing channels, with WoW movement ─────────────────────────────────
  const campaignMap = (calls) => {
    const m = new Map()
    for (const c of calls) {
      const lc = c.leadCall || c
      if ((lc.direction || '') !== 'Inbound' || !['Booked', 'Unbooked'].includes(lc.callType)) continue
      const name = (lc.campaign || {}).name || 'Unattributed'
      const cur = m.get(name) || { name, calls: 0, booked: 0 }
      cur.calls++; if (lc.callType === 'Booked') cur.booked++
      m.set(name, cur)
    }
    return m
  }
  const campWeek = campaignMap(telecom), campPrior = campaignMap(telecomPrior)
  const marketing = [...campWeek.values()].map(c => ({
    ...c,
    rate: c.calls ? c.booked / c.calls : null,
    priorCalls: campPrior.get(c.name)?.calls || 0,
    deltaCalls: c.calls - (campPrior.get(c.name)?.calls || 0),
  })).sort((a, b) => b.calls - a.calls).slice(0, 12)

  // ── True labor & the hidden pool (company level) ──────────────────────────
  const impliedComm = commBaseTotal * burden.commissionRate
  const estFieldGross = impliedComm * burden.poolUplift
  const labor = {
    commBase: r0(commBaseTotal),
    impliedCommissions: r0(impliedComm),
    estFieldGross: r0(estFieldGross),                       // before burden
    estFieldBurdened: r0(estFieldGross * burden.fieldBurden),
    officeWeeklyCost: r0(burden.officeWeeklyCost),
    totalBurdened: r0(estFieldGross * burden.fieldBurden + burden.officeWeeklyCost),
    laborPctOfRevenue: revenueTotal ? (estFieldGross * burden.fieldBurden + burden.officeWeeklyCost) / revenueTotal : null,
    hiddenPool: r0(estFieldGross - impliedComm),
    factors: burden,
  }

  // ── Month to date ─────────────────────────────────────────────────────────
  let mtdSales = 0, mtdRevenue = 0
  const mtdSalesByTrade = {}, mtdRevByTrade = {}
  for (const e of sold6w) {
    const t2 = Date.parse(e.soldOn || '')
    if (Number.isNaN(t2) || t2 < Date.parse(monthIso) || t2 >= Date.parse(endIso)) continue
    const amt = Number(e.subtotal) || 0
    mtdSales += amt
    const t = tradeOf(e.businessUnitName)
    if (t) mtdSalesByTrade[t] = (mtdSalesByTrade[t] || 0) + amt
  }
  for (const i of invMtd) {
    const amt = Number(i.subTotal) || 0
    mtdRevenue += amt
    const t = tradeOf((i.businessUnit || {}).name)
    if (t) mtdRevByTrade[t] = (mtdRevByTrade[t] || 0) + amt
  }
  const dayOfMonth = Number(weekEnd.slice(8, 10))
  const daysInMonth = new Date(Number(weekEnd.slice(0, 4)), Number(weekEnd.slice(5, 7)), 0).getDate()
  const mtd = {
    sales: r0(mtdSales), revenue: r0(mtdRevenue),
    salesByTrade: Object.fromEntries(Object.entries(mtdSalesByTrade).map(([k, v]) => [k, r0(v)])),
    revenueByTrade: Object.fromEntries(Object.entries(mtdRevByTrade).map(([k, v]) => [k, r0(v)])),
    target: budgets.monthlyRevenueTarget,
    pacedTarget: r0(budgets.monthlyRevenueTarget * dayOfMonth / daysInMonth),
    projected: dayOfMonth ? r0(mtdRevenue / dayOfMonth * daysInMonth) : null,
    dayOfMonth, daysInMonth,
  }

  // ── YoY (same-aligned week last year) + MoM (MTD vs same day-count) ──────
  const sumSold = (arr) => arr.filter(e => (e.status || {}).name === 'Sold').reduce((a, e) => a + (Number(e.subtotal) || 0), 0)
  const sumSoldByTrade = (arr) => {
    const m = {}
    for (const e of arr) {
      if ((e.status || {}).name !== 'Sold') continue
      const t = tradeOf(e.businessUnitName)
      if (t) m[t] = (m[t] || 0) + (Number(e.subtotal) || 0)
    }
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, r0(v)]))
  }
  const sumInv = (arr) => arr.reduce((a, i) => a + (Number(i.subTotal) || 0), 0)
  const yoySales = sumSold(estYoy), yoyRev = sumInv(invYoy)
  const pmSales = sumSold(estPm), pmRev = sumInv(invPm)
  const compare = {
    yoyWeek: {
      weekEnd: yoyEnd,
      sales: r0(yoySales), revenue: r0(yoyRev),
      salesByTrade: sumSoldByTrade(estYoy),
      salesDelta: yoySales ? (salesTotal - yoySales) / yoySales : null,
      revenueDelta: yoyRev ? (revenueTotal - yoyRev) / yoyRev : null,
    },
    priorMonthMtd: {
      range: `${pmStart}..${pmEnd}`,
      sales: r0(pmSales), revenue: r0(pmRev),
      salesDelta: pmSales ? (mtdSales - pmSales) / pmSales : null,
      revenueDelta: pmRev ? (mtdRevenue - pmRev) / pmRev : null,
    },
  }

  return {
    weekEnd, weekStart,
    compare,
    totals: {
      sales: r0(salesTotal), estimates: salesCount, revenue: r0(revenueTotal),
      salesGoal: budgets.weeklySalesGoal, hitGoal: salesTotal >= budgets.weeklySalesGoal,
      unpaid: r0(unpaidTotal),
      opps: presentedJobs.size, closeRate: closeAll,
      booking: bk, priorBooking: bkP,
    },
    scorecard, kpis, trend, technicians, csrs, marketing, labor, mtd,
    callbacks: {
      total: [...jobFlags.keys()].length,
      byType: [...jobFlags.values()].reduce((a, n) => (a[n] = (a[n] || 0) + 1, a), {}),
    },
    generatedAt: new Date().toISOString(),
  }
}

// ── AI: exec summary, action items, coaching callouts ───────────────────────
export async function generateAgendaAI(facts, anthropicKey) {
  if (!anthropicKey) return null
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 1100,
        system: `You are the operations analyst for Awesome Home Services (HVAC, plumbing, electrical, garage doors — Colorado Springs), writing the AI section of the owner's WEEKLY leadership meeting agenda. You get the week's numbers as JSON: department scorecard vs budgets, KPIs with week-over-week, technician and CSR leaderboards, marketing channels with WoW movement, opportunities ran vs needed (oppsNeeded = what it would have taken to hit budget at that close rate and ticket), true burdened labor, and callbacks.

You also get comparison baselines in \`compare\`: yoyWeek (the same-aligned week last year — sales/revenue with byTrade) and priorMonthMtd (month-to-date vs the same day-count of last month). Pick whichever basis is most meaningful for each point — YoY for seasonal trades like HVAC, WoW for execution changes, MoM for pace — and NAME the basis in the line ("HVAC sales down 18% vs this week last year"). Don't force every point through week-over-week.

Your reader is an operations manager scanning this in 60 seconds before the meeting. Write SHORT. Highlights are one line each, number first, no dependent clauses. Action items are imperative sentences a manager can assign as-is ("Coach X on Y — closed 2 of 9"), max ~15 words each, grouped under the department they belong to. Use oppsNeeded vs opps to distinguish lead-flow problems from conversion problems. Only cite numbers present in the data — never invent. If a number looks like a data gap, skip it rather than guessing. No fluff, no filler, no restating the tables.`,
        tools: [{
          name: 'submit_agenda',
          description: 'Submit the weekly meeting agenda analysis',
          input_schema: {
            type: 'object',
            properties: {
              headline: { type: 'string', description: 'One sentence: the single most important thing about the week, with its number.' },
              highlights: { type: 'array', items: { type: 'string' }, description: '3-5 one-line top highlights, number first. The best and worst of the week.' },
              actionsByDept: {
                type: 'array',
                description: 'Action items grouped by department. Only include departments that need action this week. Use dept names: HVAC, Plumbing, Electrical, Garage Doors, Call Center, Marketing, Company. Marketing owns channel-level moves (a channel booking poorly, call volume shifts); Call Center owns CSR booking behavior.',
                items: {
                  type: 'object',
                  properties: {
                    dept: { type: 'string' },
                    actions: { type: 'array', items: { type: 'string' }, description: '1-3 short imperative actions, each with the number that justifies it.' },
                  },
                  required: ['dept', 'actions'],
                },
              },
            },
            required: ['headline', 'highlights', 'actionsByDept'],
          },
        }],
        tool_choice: { type: 'tool', name: 'submit_agenda' },
        messages: [{ role: 'user', content: `This week's numbers:\n${JSON.stringify(facts).slice(0, 28000)}` }],
      }),
    })
    if (!r.ok) return null
    const out = (await r.json())?.content?.find(c => c.type === 'tool_use')?.input
    if (!out) return null
    return {
      headline: out.headline,
      highlights: (out.highlights || []).slice(0, 5),
      actionsByDept: (out.actionsByDept || []).slice(0, 6)
        .map(d => ({ dept: d.dept, actions: (d.actions || []).slice(0, 3) })),
    }
  } catch (e) {
    console.warn('leadership AI:', e.message)
    return null
  }
}

// ── Email / print HTML ──────────────────────────────────────────────────────
const C = { ink: '#0F172A', mute: '#64748B', line: '#E2E8F0', good: '#15803D', bad: '#B91C1C', warn: '#B45309', accent: '#1A5C8A' }

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

const signed = (n, fmtFn = money) => n == null ? '—'
  : `<span style="color:${n >= 0 ? C.good : C.bad};font-weight:700">${n >= 0 ? '+' : ''}${fmtFn(n)}</span>`

export function renderLeadershipHtml(facts, ai, notes = {}) {
  const f = facts
  const weekLabel = `${new Date(`${f.weekStart}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${new Date(`${f.weekEnd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`

  const scoreRows = f.scorecard.map(d => [
    esc(d.trade),
    money(d.sales),
    money(d.budget),
    signed(d.variance),
    money(d.revenue),
    money(d.revTarget),
    d.closeRate != null ? `${pct(d.closeRate)}${d.convTarget ? ` <span style="color:${C.mute};font-size:11px">/ ${pct(d.convTarget)}</span>` : ''}` : '—',
    d.avgSale != null ? money(d.avgSale) : '—',
    String(d.opps),
    d.missedSales ? `<span style="color:${C.bad}">${money(d.missedSales)}</span>` : '—',
  ])
  const totals = f.totals
  scoreRows.push([
    '<b>AWESOME</b>', `<b>${money(totals.sales)}</b>`, `<b>${money(f.scorecard.reduce((a, d) => a + d.budget, 0))}</b>`,
    signed(totals.sales - f.scorecard.reduce((a, d) => a + d.budget, 0)),
    `<b>${money(totals.revenue)}</b>`, `<b>${money(f.scorecard.reduce((a, d) => a + d.revTarget, 0))}</b>`,
    pct(totals.closeRate), '—', `<b>${String(totals.opps)}</b>`,
    money(f.scorecard.reduce((a, d) => a + (d.missedSales || 0), 0)),
  ])

  const kpiRows = f.kpis.map(k => {
    const fmtV = (v) => v == null ? '—' : (k.fmt === 'pct' ? pct(v) : String(v))
    const delta = (k.thisWk != null && k.lastWk != null) ? k.thisWk - k.lastWk : null
    const goalHit = k.goal != null && k.thisWk != null && k.thisWk >= k.goal
    return [
      esc(k.kpi), fmtV(k.thisWk), fmtV(k.lastWk),
      delta == null ? '—' : `<span style="color:${delta >= 0 ? C.good : C.bad};font-weight:700">${delta >= 0 ? '+' : ''}${k.fmt === 'pct' ? `${Math.round(delta * 100)}pt` : Math.round(delta)}</span>`,
      k.goal == null ? '—' : `${fmtV(k.goal)} ${k.thisWk != null ? (goalHit ? '✓' : '✗') : ''}`,
    ]
  })

  const oppRows = f.scorecard.map(d => [
    esc(d.trade), String(d.opps),
    d.oppsNeeded != null ? String(d.oppsNeeded) : '—',
    d.oppsNeeded != null ? signed(d.opps - d.oppsNeeded, (n) => String(Math.round(Math.abs(n)))) : '—',
    d.oppsNeeded != null ? (d.opps >= d.oppsNeeded ? `<span style="color:${C.good}">had the opps</span>` : `<span style="color:${C.bad}">lead-flow gap</span>`) : '—',
  ])

  const trendRows = f.trend.map(t => [
    esc(new Date(`${t.weekEnd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })),
    money(t.sales), money(t.goal),
    t.hit ? `<span style="color:${C.good};font-weight:700">YES</span>` : `<span style="color:${C.bad};font-weight:700">NO</span>`,
  ])

  const topTechs = f.technicians.filter(t => t.score != null).slice(0, 5)
  const bottomTechs = f.technicians.filter(t => t.score != null).slice(-3).reverse()
  const techRow = (t) => [
    esc(t.name), t.score != null ? String(t.score) : '—', money(t.soldAmount),
    t.closeRate != null ? pct(t.closeRate) : '—',
    t.dollarsPerOpp != null ? money(t.dollarsPerOpp) : '—',
    String(t.jobsRan),
    t.callbacks ? `<span style="color:${C.warn};font-weight:700">${t.callbacks}</span>` : '0',
  ]
  const topCsrs = f.csrs.filter(c => c.score != null).slice(0, 5)
  const bottomCsrs = f.csrs.filter(c => c.score != null).slice(-2).reverse()
  const csrRow = (c) => [
    esc(c.name), c.score != null ? String(c.score) : '—', String(c.booked), String(c.answered),
    c.bookRate != null ? pct(c.bookRate) : '—', c.qa != null ? `${c.qa}%` : '—',
  ]

  const aiHighlights = ai ? (ai.highlights || ai.summary || []) : []
  const aiHtml = ai ? `
    <div style="background:#F0F6FB;border-left:4px solid ${C.accent};border-radius:8px;padding:14px 16px">
      ${ai.headline ? `<div style="font-size:14px;font-weight:800;color:${C.ink};margin-bottom:10px">${esc(ai.headline)}</div>` : ''}
      ${aiHighlights.length ? `<div style="font-size:11px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${C.mute};margin:0 0 6px">Top highlights</div>
        ${aiHighlights.map(s => `<div style="font-size:13px;color:${C.ink};line-height:1.55;margin-bottom:4px">• ${esc(s)}</div>`).join('')}` : ''}
      ${(ai.actionsByDept || []).length ? `<div style="font-size:11px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${C.mute};margin:12px 0 6px">Action items by department</div>
        ${ai.actionsByDept.map(d => `
          <div style="margin-bottom:7px">
            <div style="font-size:12.5px;font-weight:800;color:${C.ink}">${esc(d.dept)}</div>
            ${(d.actions || []).map(a => `<div style="font-size:13px;color:${C.ink};line-height:1.5;padding-left:10px">→ ${esc(a)}</div>`).join('')}
          </div>`).join('')}` : ''}
      ${(!ai.actionsByDept && (ai.actionItems || []).length) ? `<div style="font-size:11px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${C.mute};margin:12px 0 6px">Action items</div>
        ${ai.actionItems.map(a => `<div style="font-size:13px;color:${C.ink};line-height:1.5;margin-bottom:5px">→ ${esc(a.action)}${a.owner ? ` <span style="color:${C.mute};font-size:11.5px">(${esc(a.owner)})</span>` : ''}</div>`).join('')}` : ''}
    </div>` : ''

  const list = (items, mark = '○') => (items || []).filter(Boolean).length
    ? (items || []).filter(Boolean).map(x => `<div style="font-size:13px;line-height:1.7">${mark} ${esc(typeof x === 'string' ? x : JSON.stringify(x))}</div>`).join('')
    : `<div style="font-size:12px;color:${C.mute}">—</div>`

  const topicsRows = (notes.topics || []).filter(t => t.topic).map((t, i) => [String(i + 1), esc(t.topic), esc(t.owner || '')])
  const projectRows = (notes.projects || []).filter(p => p.project).map(p => [
    esc(p.project), esc(p.owner || ''), esc(p.status || ''), esc(p.target || ''), esc(p.notes || ''),
  ])

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:860px;margin:0 auto;color:${C.ink};padding:8px">
    <div style="font-size:20px;font-weight:800">Weekly Leadership Agenda</div>
    <div style="font-size:13px;color:${C.mute};margin-bottom:16px">Week of ${esc(weekLabel)}</div>

    ${(notes.quote || notes.icebreaker || notes.positive) ? section('Quote · Ice breaker · Positive news', `
      ${notes.quote ? `<div style="font-size:13px;line-height:1.6"><b>Quote:</b> ${esc(notes.quote)}</div>` : ''}
      ${notes.icebreaker ? `<div style="font-size:13px;line-height:1.6"><b>Ice breaker:</b> ${esc(notes.icebreaker)}</div>` : ''}
      ${notes.positive ? `<div style="font-size:13px;line-height:1.6"><b>Positive news:</b> ${esc(notes.positive)}</div>` : ''}`) : ''}

    <table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-top:18px"><tr>
      ${card('Wk Sales', money(f.totals.sales), `goal ${money(f.totals.salesGoal)} — ${f.totals.hitGoal ? 'HIT' : 'MISS'}`)}
      ${card('Wk Revenue', money(f.totals.revenue), `${money(f.totals.unpaid)} not yet collected`)}
      ${card('Close Rate', pct(f.totals.closeRate), `${f.totals.opps} opportunities`)}
      ${card('MTD Revenue', money(f.mtd.revenue), `pace ${money(f.mtd.pacedTarget)} · proj ${money(f.mtd.projected)}`)}
    </tr></table>

    ${ai ? section('The week, read by AI', aiHtml) : ''}

    ${section('Department scorecard', table(
      ['Dept', 'Wk Sales', 'Budget', 'Var', 'Wk Rev', 'Rev Tgt', 'Close / Tgt', 'Avg Sale', 'Opps', 'Missed $'], scoreRows))}

    ${section('Company KPIs (WoW)', table(['KPI', 'This Wk', 'Last Wk', 'Δ', 'Goal'], kpiRows))}

    ${section('Opportunities: ran vs needed', `
      <div style="font-size:11.5px;color:${C.mute};margin-bottom:8px">"Needed" = opportunities required to hit budget at this week's actual close rate and average sale. Short = the leads weren't there; surplus + a miss = conversion problem.</div>
      ${table(['Dept', 'Ran', 'Needed', 'Diff', 'Verdict'], oppRows)}`)}

    ${section('True labor (burdened)', `
      <table style="width:100%;border-collapse:separate;border-spacing:8px 0"><tr>
        ${card('Field labor (true)', money(f.labor.estFieldBurdened), `${money(f.labor.impliedCommissions)} commissions + hidden pool + burden`)}
        ${card('Office labor', money(f.labor.officeWeeklyCost), 'burdened weekly baseline')}
        ${card('All-in labor %', pct(f.labor.laborPctOfRevenue), 'of week revenue · target 25% field')}
        ${card('Hidden pool', money(f.labor.hiddenPool), 'field pay not tied to any job')}
      </tr></table>
      <div style="font-size:11px;color:${C.mute};margin-top:8px">Model: paid commissionable revenue × ${Math.round(f.labor.factors.commissionRate * 100)}% × ${f.labor.factors.poolUplift} pool uplift × ${f.labor.factors.fieldBurden} ADP burden${notes.fieldPayrollActual ? ` — <b>overridden with actual ADP field gross ${money(notes.fieldPayrollActual)}</b>` : ''}. ST sees only the commissions.</div>`)}

    ${topTechs.length ? section('Top technicians', table(['Tech', 'Score', 'Sold', 'Close', '$/Opp', 'Jobs', 'Callbacks'], topTechs.map(techRow))) : ''}
    ${bottomTechs.length ? section('Techs needing attention', `
      <div style="font-size:11.5px;color:${C.mute};margin-bottom:8px">Lowest composite among techs with 3+ opportunities — a coaching list, not a wall of shame.</div>
      ${table(['Tech', 'Score', 'Sold', 'Close', '$/Opp', 'Jobs', 'Callbacks'], bottomTechs.map(techRow))}`) : ''}

    ${topCsrs.length ? section('Top CSRs', table(['CSR', 'Score', 'Booked', 'Answered', 'Book rate', 'QA'], topCsrs.map(csrRow))) : ''}
    ${bottomCsrs.length ? section('CSRs needing attention', table(['CSR', 'Score', 'Booked', 'Answered', 'Book rate', 'QA'], bottomCsrs.map(csrRow))) : ''}

    ${f.marketing.length ? section('Marketing channels', table(['Channel', 'Lead calls', 'Booked', 'Rate', 'vs last wk'],
      f.marketing.map(m => [esc(m.name), String(m.calls), String(m.booked), pct(m.rate),
        m.deltaCalls === 0 ? '—' : `<span style="color:${m.deltaCalls > 0 ? C.good : C.bad}">${m.deltaCalls > 0 ? '+' : ''}${m.deltaCalls}</span>`]))) : ''}

    ${section('6-week sales trend', table(['W/E', 'Sales', 'Goal', 'Hit?'], trendRows))}

    ${topicsRows.length ? section('Discussion topics', table(['#', 'Topic', 'Owner'], topicsRows)) : ''}
    ${projectRows.length ? section('Ongoing projects', table(['Project', 'Owner', 'Status', 'Target', 'Notes'], projectRows)) : ''}

    ${section('Wins this week', list(notes.wins, '✓'))}
    ${section('Watch-outs / risks', list(notes.watchouts, '⚠'))}
    ${section('Commitments for next week', list(notes.commitments, '☐'))}
    ${notes.notesText ? section('Notes & key takeaways', `<div style="font-size:13px;line-height:1.6;white-space:pre-wrap">${esc(notes.notesText)}</div>`) : ''}

    <div style="margin-top:26px;padding-top:12px;border-top:1px solid ${C.line};font-size:11px;color:${C.mute};line-height:1.6">
      Sales = estimates marked Sold · Revenue = invoiced subtotals · Opportunities = jobs with an estimate presented ·
      Booking % excludes Excused/NotLead/Abandoned · True labor uses the ADP TotalSource burden model (Aug 2026).
    </div>
  </div>`
}

export async function buildLeadershipReport(deps) {
  const facts = await gatherWeeklyFacts(deps)
  const ai = await generateAgendaAI(facts, deps.anthropicKey)
  return { facts, ai }
}
