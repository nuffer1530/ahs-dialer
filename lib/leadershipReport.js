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

// The Sunday that ends the CURRENT (in-progress) week.
export function upcomingSunday() {
  return shiftDate(latestCompletedSunday(), 7)
}

const DEFAULT_BUDGETS = {
  weeklySalesGoal: 350000,
  monthlySalesTarget: 1516667,   // weekly goal × 52 ÷ 12 — override per month on the page
  annualSalesTarget: 18200000,   // weekly goal × 52 — override on the page
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
  // An in-progress week (weekEnd is next Sunday) has data only through today —
  // every pacing/day-count/comparison window uses asOf so partial weeks read
  // honestly instead of diluting rates with days that haven't happened.
  const todayDenver = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())
  const asOf = weekEnd > todayDenver ? todayDenver : weekEnd
  const partial = asOf !== weekEnd
  const monthStart = `${asOf.slice(0, 7)}-01`
  const { startIso: monthIso } = denverDayBounds(monthStart)
  // Same-aligned week last year (−364 keeps the weekday), for seasonal trades.
  // A partial week compares against the same partial slice of last year.
  const yoyStart = shiftDate(weekStart, -364)
  const yoyEnd = shiftDate(asOf, -364)
  const { startIso: yoyStartIso } = denverDayBounds(yoyStart)
  const { endIso: yoyEndIso } = denverDayBounds(yoyEnd)
  // Prior month, same day-count (MTD apples to apples).
  const pmStart = (() => { const d = new Date(`${monthStart}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10) })()
  const pmDayCap = new Date(Number(pmStart.slice(0, 4)), Number(pmStart.slice(5, 7)), 0).getDate()
  const pmEnd = `${pmStart.slice(0, 7)}-${String(Math.min(Number(asOf.slice(8, 10)), pmDayCap)).padStart(2, '0')}`
  const { startIso: pmStartIso } = denverDayBounds(pmStart)
  const { endIso: pmEndIso } = denverDayBounds(pmEnd)

  const safe = (p, fallback) => p.then(r => r).catch(e => { console.warn('leadership fetch:', e.message); return fallback })

  let [estSold6w, estCreated, estCreatedPrior, invWeek, invPrior, invMtd, telecom, telecomPrior,
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

  // Brandyn's counting rule (Aug 2026): the KPI row counts ALL clubs including
  // complimentary; the department scorecard counts only SOLD (non-comp) clubs.
  const membershipsAll = memberships
  const membershipsPriorAll = membershipsPrior
  try {
    const mt = await stGet(`/memberships/v2/tenant/${tenantId}/membership-types?pageSize=200`)
    const compIds = new Set((mt?.data || []).filter(t => /complimentary/i.test(t.name || '')).map(t => t.id))
    if (compIds.size) {
      const before = memberships.length
      memberships = memberships.filter(m => !compIds.has(m.membershipTypeId))
      membershipsPrior = membershipsPrior.filter(m => !compIds.has(m.membershipTypeId))
      if (before !== memberships.length) console.log(`leadership: excluded ${before - memberships.length} complimentary memberships`)
    }
  } catch (e) { console.warn('leadership membership types:', e.message) }
  // YTD sales: soldAfter implies sold-only, so a full-year pull stays small.
  const yearStart = `${asOf.slice(0, 4)}-01-01`
  const { startIso: yearIso } = denverDayBounds(yearStart)
  const [estYoy, invYoy, estPm, invPm] = await Promise.all([
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${yoyStartIso}&soldBefore=${yoyEndIso}&pageSize=500&page=${pg}`, 4000), []),
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${yoyStart}T00:00:00Z&invoicedOnBefore=${yoyEnd}T23:59:59Z&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${pmStartIso}&soldBefore=${pmEndIso}&pageSize=500&page=${pg}`, 8000), []),
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${pmStart}T00:00:00Z&invoicedOnBefore=${pmEnd}T23:59:59Z&pageSize=500&page=${pg}`, 12000), []),
  ])
  // YTD sales is the one huge pull (10k+ estimates with items arrays) —
  // aggregate page-by-page and discard, instead of holding it all in memory.
  // Accumulating it froze the event loop badly enough to 502 the whole app.
  let ytdSalesRaw = 0
  const ytdByTradeRaw = {}
  try {
    for (let pg = 1; pg <= 60; pg++) {
      const d = await stGet(`/sales/v2/tenant/${tenantId}/estimates?soldAfter=${yearIso}&soldBefore=${endIso}&pageSize=500&page=${pg}`)
      for (const e of (d?.data || [])) {
        if ((e.status || {}).name !== 'Sold') continue
        const amt = Number(e.subtotal) || 0
        ytdSalesRaw += amt
        const t = tradeOf(e.businessUnitName)
        if (t) ytdByTradeRaw[t] = (ytdByTradeRaw[t] || 0) + amt
      }
      if (!d?.hasMore) break
    }
  } catch (e) { console.warn('leadership ytd:', e.message) }

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
      const cur = soldByTech.get(e.soldBy) || { amount: 0, count: 0, trades: {} }
      cur.amount += amt; cur.count++
      if (t) cur.trades[t] = (cur.trades[t] || 0) + 1
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
    // Commission basis is the job being completed/billed, NOT the customer
    // having paid — a Monday-morning report saw last week's big installs as
    // unpaid and priced Electrical's labor at 4% of revenue (real: ~24%).
    if (cat === 'repair' || cat === 'other') {
      commBaseTotal += amt
      if (t) byTrade[t].commBase += amt
    }
  }

  // Labor is reported one week BACK: the current week's payroll doesn't exist
  // yet and its invoices haven't settled, so same-week labor was noise
  // (Brandyn: "we will never have the same weekly labor"). Prior week is real.
  const lwRevByTrade = {}, lwCommByTrade = {}
  let lwRevTotal = 0, lwCommTotal = 0
  for (const t of TRADES) { lwRevByTrade[t] = 0; lwCommByTrade[t] = 0 }
  for (const i of invPrior) {
    const amt = Number(i.subTotal) || 0
    const t = tradeOf((i.businessUnit || {}).name)
    lwRevTotal += amt
    if (t) lwRevByTrade[t] += amt
    const cat = catByName.get((i.job || {}).type)
    if (cat === 'repair' || cat === 'other') {
      lwCommTotal += amt
      if (t) lwCommByTrade[t] += amt
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
    // True burdened labor from the commission model (see DEFAULT_BURDEN) —
    // computed on LAST week's billed jobs against LAST week's revenue.
    const lwRev = lwRevByTrade[t] || 0
    const trueLabor = (lwCommByTrade[t] || 0) * burden.commissionRate * burden.poolUplift * burden.fieldBurden
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
      trueLaborPct: lwRev ? trueLabor / lwRev : null,
      lwRevenue: r0(lwRev),
      laborTarget: cfg.labor || null,
      gmTarget: cfg.gm || null,
      callbacks: 0,   // filled in below once flagged jobs are mapped to BUs
      fiveStar: 0,    // reviews attributed via technicianId → tech's BU (~2/3 match)
      clubs: 0,       // memberships by businessUnitId
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
    { kpi: 'Clubs Sold (all)', thisWk: membershipsAll.length, lastWk: membershipsPriorAll.length, goal: budgets.kpi.clubs, fmt: 'int' },
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
      techNames.set(String(x.id), { ...prev, name: x.name || prev.name, buId: x.businessUnitId })
    }
  } catch {}

  // ── Opportunity capacity: how many opps the floor could actually have run.
  // Techs with WORKING shifts (not TimeOff) that week × the board's
  // calls-per-tech per trade — same knobs the 3-day board uses. "Needed 150"
  // is fantasy if the trucks cap out at 60; the gap splits into leads we
  // could have taken vs a staffing ceiling.
  const oppCapacity = {}
  try {
    const bus2 = await stGet(`/settings/v2/tenant/${tenantId}/business-units?pageSize=200`)
    const buTrade2 = new Map((bus2?.data || []).map(b => [String(b.id), tradeOf(b.name)]))
    let cptCfg = {}
    try {
      const { data: cptRow } = await supabase.from('app_settings').select('value').eq('key', 'board_calls_per_tech').maybeSingle()
      cptCfg = JSON.parse(cptRow?.value || '{}')
    } catch {}
    const cpt = (trade) => Number(cptCfg[trade]) || 3
    const sh = await stPageAll(pg => `/dispatch/v2/tenant/${tenantId}/technician-shifts?startsOnOrAfter=${weekStart}T06:00:00Z&endsOnOrBefore=${shiftDate(weekEnd, 1)}T06:00:00Z&pageSize=500&page=${pg}`, 3000)
    const seen = new Set()   // tech|localDay, working shifts only
    for (const x of (sh || [])) {
      if (String(x.shiftType || '') !== 'Normal') continue
      const info = techNames.get(String(x.technicianId))
      const trade = info?.buId != null ? buTrade2.get(String(info.buId)) : null
      if (!trade) continue
      const day = String(x.start || '').slice(0, 10)
      const key = `${x.technicianId}|${day}`
      if (seen.has(key)) continue
      seen.add(key)
      oppCapacity[trade] = (oppCapacity[trade] || 0) + cpt(trade)
    }
    for (const row of scorecard) {
      if (oppCapacity[row.trade] != null) {
        row.oppCapacity = oppCapacity[row.trade]
        row.oppsCouldRun = Math.max(0, row.oppCapacity - row.opps)
      }
    }
  } catch (e) { console.warn('leadership capacity:', e.message) }

  // Callback / warranty / no-charge flags per job, via job type — and each ran
  // job's category, so tech opp counts can exclude non-sales visits.
  const jobFlags = new Map()   // jobId -> { name, buId }
  const jobCat = new Map()     // jobId -> category (null when type unmapped)
  try {
    const ranIds = [...new Set([...techJobs.values()].flatMap(s => [...s]))]
    for (let i = 0; i < ranIds.length; i += 50) {
      const r = await stGet(`/jpm/v2/tenant/${tenantId}/jobs?ids=${ranIds.slice(i, i + 50).join(',')}&pageSize=50`)
      for (const j of (r?.data || [])) {
        const info = catById.get(String(j.jobTypeId))
        jobCat.set(j.id, info?.category || null)
        if (!info) continue
        if (/callback|warranty|recall|concern/i.test(info.name)) jobFlags.set(j.id, { name: info.name, buId: j.businessUnitId })
      }
    }
  } catch (e) { console.warn('leadership job flags:', e.message) }

  // Per-department attribution passes: callbacks (flagged job → BU), clubs
  // (membership businessUnitId), and 5★ reviews (technicianId → tech's BU).
  // Review/club counts that can't be attributed still show in company totals —
  // the dept columns can sum short of the company number, honestly.
  try {
    const bus = await stGet(`/settings/v2/tenant/${tenantId}/business-units?pageSize=200`)
    const buTrade = new Map((bus?.data || []).map(b => [String(b.id), tradeOf(b.name)]))
    const rowOf = (trade) => scorecard.find(r => r.trade === trade)
    for (const { buId } of jobFlags.values()) {
      const row = rowOf(buTrade.get(String(buId)))
      if (row) row.callbacks++
    }
    for (const m of memberships) {
      const row = rowOf(buTrade.get(String(m.businessUnitId)))
      if (row) row.clubs++
    }
    for (const rv of reviews) {
      if (Number(rv.rating || rv.reviewRating) < 5 || !rv.technicianId) continue
      const info = techNames.get(String(rv.technicianId))
      const row = rowOf(tradeOf(info?.bu))
      if (row) row.fiveStar++
    }
  } catch (e) { console.warn('leadership dept attribution:', e.message) }

  // A tech's opportunity = a ran job with an estimate AND a sales-shaped job
  // type. Maintenance tune-ups auto-generate option sheets, which doubled
  // denominators and halved close rates vs what ST's own dashboard shows
  // (Logan Frazier: 46% here vs 92% in ST, same 11 sold jobs). Unmapped job
  // types still count — hiding them would flatter, not clarify.
  // NOTE: dept-level scorecard opps deliberately stay estimate-presented-only;
  // that definition is calibrated to the leadership sheet.
  const SALES_OPP_CATS = new Set(['repair', 'other', 'free_estimate'])
  let technicians = []
  for (const [techId, jobs] of techJobs) {
    const info = techNames.get(String(techId)) || {}
    const s = soldByTech.get(techId) || { amount: 0, count: 0, trades: {} }
    const oppJobs = [...jobs].filter(j => { const c = jobCat.get(j); return c == null || SALES_OPP_CATS.has(c) })
    const presented = oppJobs.filter(j => presentedJobs.has(j)).length
    const soldJobs = oppJobs.filter(j => soldJobIds.has(j)).length
    const callbacks = [...jobs].filter(j => jobFlags.has(j)).length
    // Trade: the tech's business unit when we have it, else whatever trade
    // they sold the most in this week.
    const soldTrade = Object.entries(s.trades || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || null
    technicians.push({
      name: info.name || `Tech ${techId}`, tier: info.tier || null,
      trade: tradeOf(info.bu) || soldTrade,
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
    // ST agent → Andi profile name, so "Steven Pierrette" (telecom) and
    // "steven.pierrette" (his evals) are the same row instead of a QA blank.
    const [{ data: csrStMaps }, { data: csrProfs }] = await Promise.all([
      supabase.from('csr_st_users').select('profile_id, st_user_id'),
      supabase.from('profiles').select('id, name, email'),
    ])
    const csrProfName = new Map((csrProfs || []).map(x => [x.id, x.name || x.email]))
    const csrAndiName = new Map((csrStMaps || []).map(m => [String(m.st_user_id), csrProfName.get(m.profile_id)]).filter(x => x[1]))
    // Lead calls = Booked + Unbooked only (the calls CSRs are measured on).
    // NotLead/Excused (spam/non-lead) count only toward "total inbound" context,
    // and outbound is tracked separately — matching the daily digest exactly.
    const csrMap = new Map()
    const csrRep = (name) => {
      const cur = csrMap.get(name) || { name, leadCalls: 0, booked: 0, inbound: 0, outbound: 0 }
      csrMap.set(name, cur); return cur
    }
    for (const c of telecom) {
      const lc = c.leadCall || c
      const name = (csrAndiName.get(String((lc.agent || {}).id || '')) || (lc.agent || {}).name || 'Unknown').trim()
      if ((lc.direction || '') === 'Outbound') { csrRep(name).outbound++; continue }
      if ((lc.direction || '') !== 'Inbound' || lc.callType === 'Abandoned') continue
      const cur = csrRep(name)
      cur.inbound++
      if (!['Booked', 'Unbooked'].includes(lc.callType)) continue
      cur.leadCalls++
      if (lc.callType === 'Booked') cur.booked++
    }
    // Evals belong to the week their CALL happened — the nightly sweep writes
    // scores at ~2 AM the NEXT day, so a created_at window drops the last
    // day's evals. Join by call_sid through the recordings registry, with
    // created-in-window rows unioned in as a safety net.
    const evalByRep = new Map()
    try {
      const { data: wkRecs } = await supabase.from('call_recordings').select('call_sid')
        .eq('direction', 'inbound').gte('call_started_at', startIso).lt('call_started_at', endIso).limit(3000)
      const wkSids = [...new Set((wkRecs || []).map(r => r.call_sid).filter(Boolean))]
      let evals = []
      for (let i = 0; i < wkSids.length; i += 200) {
        const { data } = await supabase.from('call_evaluations').select('id, rep, pct').in('call_sid', wkSids.slice(i, i + 200))
        if (data?.length) evals = evals.concat(data)
      }
      const { data: evWin } = await supabase.from('call_evaluations').select('id, rep, pct').gte('created_at', startIso).lt('created_at', endIso)
      const seen = new Set(evals.map(e => e.id))
      for (const e of (evWin || [])) if (!seen.has(e.id)) evals.push(e)
      for (const e of evals) {
        if (e.pct == null || !e.rep) continue
        const k = e.rep.trim().toLowerCase()
        if (!evalByRep.has(k)) evalByRep.set(k, [])
        evalByRep.get(k).push(Number(e.pct))
      }
    } catch {}
    csrs = [...csrMap.values()].map(r => {
      const qaList = evalByRep.get(r.name.toLowerCase()) || []
      return {
        name: r.name, leadCalls: r.leadCalls, booked: r.booked, inbound: r.inbound, outbound: r.outbound,
        bookRate: r.leadCalls ? r.booked / r.leadCalls : null,
        qa: qaList.length ? Math.round(qaList.reduce((a, b) => a + b, 0) / qaList.length) : null,
        evals: qaList.length,
      }
    }).filter(c => c.leadCalls || c.inbound)
    const eligible = csrs.filter(c => c.leadCalls >= 10)
    const maxBooked = Math.max(1, ...eligible.map(c => c.booked))
    for (const c of csrs) {
      c.score = c.leadCalls >= 10
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

  // ── Marketing money: spend (ST campaign costs), attributed revenue
  // (invoices → job → campaign), CPL and ROAS per channel. Spend is entered
  // monthly per campaign (dailyCost) — prorated to the week (× 7 days).
  const spendByName = new Map()
  const junkByName = new Map()
  const revByName = new Map()
  const jobsByName = new Map()
  try {
    const wkMid = new Date(`${weekStart}T12:00:00Z`)
    const [costRows, campRows] = await Promise.all([
      safe(stPageAll(pg => `/marketing/v2/tenant/${tenantId}/costs?year=${wkMid.getUTCFullYear()}&month=${wkMid.getUTCMonth() + 1}&pageSize=200&page=${pg}`, 2000), []),
      safe(stPageAll(pg => `/marketing/v2/tenant/${tenantId}/campaigns?pageSize=200&page=${pg}`, 2000), []),
    ])
    const campName = new Map(campRows.map(c => [c.id, c.name]))
    for (const r of costRows) {
      const n = campName.get(r.campaignId)
      if (n) spendByName.set(n, (spendByName.get(n) || 0) + (Number(r.dailyCost) || 0) * 7)
    }
    for (const c of telecom) {
      const lc = c.leadCall || c
      if ((lc.direction || '') !== 'Inbound') continue
      if (['Booked', 'Unbooked'].includes(lc.callType)) continue
      const n = (lc.campaign || {}).name
      if (n) junkByName.set(n, (junkByName.get(n) || 0) + 1)
    }
    const invJobIds = [...new Set(invWeek.map(i => (i.job || {}).id).filter(Boolean))]
    const jobCamp = new Map()
    for (let i = 0; i < invJobIds.length; i += 50) {
      const r = await stGet(`/jpm/v2/tenant/${tenantId}/jobs?ids=${invJobIds.slice(i, i + 50).join(',')}&pageSize=50`)
      for (const j of (r?.data || [])) if (j.campaignId) jobCamp.set(j.id, campName.get(j.campaignId))
    }
    for (const i of invWeek) {
      const n = jobCamp.get((i.job || {}).id)
      if (n) revByName.set(n, (revByName.get(n) || 0) + (Number(i.subTotal) || 0))
    }
    const wkJobs = await safe(stPageAll(pg => `/jpm/v2/tenant/${tenantId}/jobs?createdOnOrAfter=${startIso}&createdBefore=${endIso}&pageSize=500&page=${pg}`, 3000), [])
    for (const j of wkJobs) {
      const n = campName.get(j.campaignId)
      if (n) jobsByName.set(n, (jobsByName.get(n) || 0) + 1)
    }
  } catch (e) { console.warn('leadership marketing money:', e.message) }

  const mktNames = new Set([...campWeek.keys(), ...spendByName.keys()])
  const marketing = [...mktNames].map(name => {
    const c = campWeek.get(name) || { calls: 0, booked: 0 }
    const spend = spendByName.get(name) || 0
    const revenue = revByName.get(name) || 0
    const jobs = jobsByName.get(name) || 0
    const junk = junkByName.get(name) || 0
    return {
      name, calls: c.calls, booked: c.booked,
      rate: c.calls ? c.booked / c.calls : null,
      priorCalls: campPrior.get(name)?.calls || 0,
      deltaCalls: c.calls - (campPrior.get(name)?.calls || 0),
      junk, junkPct: (c.calls + junk) ? junk / (c.calls + junk) : null,
      jobs, revenue: r0(revenue),
      avgTicket: jobs && revenue ? r0(revenue / jobs) : null,
      spend: r0(spend),
      cpl: spend && c.calls ? r0(spend / c.calls) : null,
      roas: spend ? Math.round(revenue / spend * 10) / 10 : null,
    }
  }).filter(m => m.calls || m.spend >= 100 || m.revenue)
    .sort((a, b) => (b.spend - a.spend) || (b.calls - a.calls)).slice(0, 16)

  // ── True labor & the hidden pool (company level) ──────────────────────────
  const impliedComm = lwCommTotal * burden.commissionRate
  const estFieldGross = impliedComm * burden.poolUplift
  const labor = {
    weekEnd: pWeekEnd,
    commBase: r0(lwCommTotal),
    impliedCommissions: r0(impliedComm),
    estFieldGross: r0(estFieldGross),                       // before burden
    estFieldBurdened: r0(estFieldGross * burden.fieldBurden),
    officeWeeklyCost: r0(burden.officeWeeklyCost),
    totalBurdened: r0(estFieldGross * burden.fieldBurden + burden.officeWeeklyCost),
    laborPctOfRevenue: lwRevTotal ? (estFieldGross * burden.fieldBurden + burden.officeWeeklyCost) / lwRevTotal : null,
    hiddenPool: r0(estFieldGross - impliedComm),
    factors: burden,
    source: 'model',
  }

  // Uploaded ADP invoice for this week beats the model: real gross + real
  // burden per employee, attributed to departments via the benefits mapping.
  try {
    const adpAll = await settingsJson(supabase, 'adp_payroll_actuals', {})
    const adp = adpAll[pWeekEnd]
    if (adp?.totals?.cost) {
      labor.source = 'adp'
      labor.actual = adp
      labor.estFieldBurdened = adp.totals.field.cost
      labor.officeWeeklyCost = adp.totals.office.cost
      labor.totalBurdened = adp.totals.cost
      labor.laborPctOfRevenue = lwRevTotal ? adp.totals.cost / lwRevTotal : null
      labor.hiddenPool = r0(Math.max(0, adp.totals.field.gross - impliedComm))
      for (const row of scorecard) {
        const t = adp.byTrade?.[row.trade]
        if (t?.cost) {
          row.trueLabor = t.cost
          row.trueLaborPct = row.lwRevenue ? t.cost / row.lwRevenue : null
          row.laborSource = 'adp'
        }
      }
    }
  } catch (e) { console.warn('leadership adp actuals:', e.message) }

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
  const dayOfMonth = Number(asOf.slice(8, 10))
  const daysInMonth = new Date(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)), 0).getDate()
  const mtd = {
    sales: r0(mtdSales), revenue: r0(mtdRevenue),
    salesByTrade: Object.fromEntries(Object.entries(mtdSalesByTrade).map(([k, v]) => [k, r0(v)])),
    revenueByTrade: Object.fromEntries(Object.entries(mtdRevByTrade).map(([k, v]) => [k, r0(v)])),
    target: budgets.monthlyRevenueTarget,
    pacedTarget: r0(budgets.monthlyRevenueTarget * dayOfMonth / daysInMonth),
    projected: dayOfMonth ? r0(mtdRevenue / dayOfMonth * daysInMonth) : null,
    salesTarget: budgets.monthlySalesTarget,
    salesPaced: r0((budgets.monthlySalesTarget || 0) * dayOfMonth / daysInMonth),
    salesProjected: dayOfMonth ? r0(mtdSales / dayOfMonth * daysInMonth) : null,
    dayOfMonth, daysInMonth,
  }

  // ── Year to date: sales pacing against the annual target ─────────────────
  const ytdSales = ytdSalesRaw
  const ytdSalesByTrade = ytdByTradeRaw
  const dayOfYear = Math.round((Date.parse(`${asOf}T12:00:00Z`) - Date.parse(`${yearStart}T12:00:00Z`)) / 86400000) + 1
  const daysInYear = Number(asOf.slice(0, 4)) % 4 === 0 ? 366 : 365
  const ytd = {
    sales: r0(ytdSales),
    salesByTrade: Object.fromEntries(Object.entries(ytdSalesByTrade).map(([k, v]) => [k, r0(v)])),
    target: budgets.annualSalesTarget,
    pacedTarget: r0((budgets.annualSalesTarget || 0) * dayOfYear / daysInYear),
    projected: dayOfYear ? r0(ytdSales / dayOfYear * daysInYear) : null,
    dayOfYear, daysInYear,
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
    weekEnd, weekStart, asOf, partial,
    compare,
    totals: {
      sales: r0(salesTotal), estimates: salesCount, revenue: r0(revenueTotal),
      salesGoal: budgets.weeklySalesGoal, hitGoal: salesTotal >= budgets.weeklySalesGoal,
      unpaid: r0(unpaidTotal),
      opps: presentedJobs.size, closeRate: closeAll,
      booking: bk, priorBooking: bkP,
      clubsSold: memberships.length,      // non-comp — matches the scorecard column
      clubsAll: membershipsAll.length,    // incl. complimentary — matches the KPI row
    },
    scorecard, kpis, trend, technicians, csrs, marketing, labor, mtd, ytd,
    callbacks: {
      total: [...jobFlags.keys()].length,
      byType: [...jobFlags.values()].reduce((a, v) => (a[v.name] = (a[v.name] || 0) + 1, a), {}),
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
        system: `You are the operations analyst for Awesome Home Services (HVAC, plumbing, electrical, garage doors — Colorado Springs), writing the AI section of the owner's WEEKLY leadership meeting agenda. You get the week's numbers as JSON: department scorecard vs budgets, KPIs with week-over-week, technician and CSR leaderboards, marketing channels with weekly spend/CPL/ROAS (revenue = this week's invoices attributed to the channel's jobs; flag channels where spend is high and ROAS is under 1x, and channels with high junkPct), opportunities ran vs needed (oppsNeeded = what it would have taken to hit budget at that close rate and ticket; oppCapacity = how many the scheduled trucks could physically run that week — when oppsNeeded exceeds oppCapacity the gap is STAFFING, not marketing), true burdened labor, and callbacks.

\`mtd\` and \`ytd\` carry monthly and yearly sales/revenue pacing (paced target = budget prorated to today); cite pace when a department or the company is meaningfully ahead or behind. Scorecard rows carry callbacks — callback/warranty jobs run in that department this week. ALL labor/trueLabor figures cover the PRIOR week (labor.weekEnd), because payroll and invoice settlement lag — never present them as this week's cost. If labor.source is "adp", trueLabor figures are ACTUAL payroll from the uploaded ADP invoice, not a model — treat labor %-of-revenue findings as hard numbers then.

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
    // The model occasionally emits a string where the schema says array —
    // .slice() silently tolerates that and the page then dies on .map().
    const arr = (v) => Array.isArray(v) ? v : (v ? [String(v)] : [])
    return {
      headline: out.headline,
      highlights: arr(out.highlights).slice(0, 5).map(String),
      actionsByDept: arr(out.actionsByDept).slice(0, 6)
        .filter(d => d && typeof d === 'object')
        .map(d => ({ dept: String(d.dept || ''), actions: arr(d.actions).slice(0, 3).map(String) })),
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

// Green = goal hit · yellow = within 90% · red = clearly missed.
const goalSpan = (val, goal, text) => {
  if (val == null || !goal) return text
  const c = val >= goal ? C.good : val >= goal * 0.9 ? C.warn : C.bad
  return `<span style="color:${c};font-weight:700">${text}</span>`
}

export function renderLeadershipHtml(facts, ai, notes = {}) {
  const f = facts
  const weekLabel = `${new Date(`${f.weekStart}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${new Date(`${f.weekEnd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`

  const scoreRows = f.scorecard.map(d => [
    esc(d.trade),
    money(d.sales),
    money(d.budget),
    signed(d.variance),
    goalSpan(d.revenue, d.revTarget, money(d.revenue)),
    money(d.revTarget),
    d.closeRate != null ? `${goalSpan(d.closeRate, d.convTarget || 0.7, pct(d.closeRate))}${d.convTarget ? ` <span style="color:${C.mute};font-size:11px">/ ${pct(d.convTarget)}</span>` : ''}` : '—',
    d.avgSale != null ? money(d.avgSale) : '—',
    String(d.opps),
    d.missedSales ? `<span style="color:${C.bad}">${money(d.missedSales)}</span>` : '—',
    String(d.fiveStar || 0),
    String(d.clubs || 0),
    d.callbacks ? `<span style="color:${C.warn};font-weight:700">${d.callbacks}</span>` : '0',
  ])
  const totals = f.totals
  scoreRows.push([
    '<b>AWESOME</b>', `<b>${money(totals.sales)}</b>`, `<b>${money(f.scorecard.reduce((a, d) => a + d.budget, 0))}</b>`,
    signed(totals.sales - f.scorecard.reduce((a, d) => a + d.budget, 0)),
    `<b>${goalSpan(totals.revenue, f.scorecard.reduce((a, d) => a + d.revTarget, 0), money(totals.revenue))}</b>`,
    `<b>${money(f.scorecard.reduce((a, d) => a + d.revTarget, 0))}</b>`,
    goalSpan(totals.closeRate, 0.7, pct(totals.closeRate)), '—', `<b>${String(totals.opps)}</b>`,
    money(f.scorecard.reduce((a, d) => a + (d.missedSales || 0), 0)),
    `<b>${String(f.kpis.find(k => k.kpi === '5 Star Reviews')?.thisWk ?? f.scorecard.reduce((a, d) => a + (d.fiveStar || 0), 0))}</b>`,
    `<b>${String(f.totals.clubsSold ?? f.scorecard.reduce((a, d) => a + (d.clubs || 0), 0))}</b>`,
    `<b>${String(f.scorecard.reduce((a, d) => a + (d.callbacks || 0), 0))}</b>`,
  ])

  const kpiRows = f.kpis.map(k => {
    const fmtV = (v) => v == null ? '—' : (k.fmt === 'pct' ? pct(v) : String(v))
    const delta = (k.thisWk != null && k.lastWk != null) ? k.thisWk - k.lastWk : null
    const goalHit = k.goal != null && k.thisWk != null && k.thisWk >= k.goal
    return [
      esc(k.kpi), goalSpan(k.thisWk, k.goal, fmtV(k.thisWk)), fmtV(k.lastWk),
      delta == null ? '—' : `<span style="color:${delta >= 0 ? C.good : C.bad};font-weight:700">${delta >= 0 ? '+' : ''}${k.fmt === 'pct' ? `${Math.round(delta * 100)}pt` : Math.round(delta)}</span>`,
      k.goal == null ? '—' : `${fmtV(k.goal)} ${k.thisWk != null ? (goalHit ? '✓' : '✗') : ''}`,
    ]
  })

  const oppRows = f.scorecard.map(d => {
    const cap = d.oppCapacity
    const atTarget = (d.convTarget && d.avgSale) ? Math.ceil(d.budget / (d.convTarget * d.avgSale)) : null
    let verdict = '—'
    if (d.oppsNeeded != null) {
      if (d.opps >= d.oppsNeeded) verdict = d.sales >= d.budget
        ? `<span style="color:${C.good}">✓ on budget</span>`
        : `<span style="color:${C.bad}">fix: closing — the calls were there</span>`
      else if (cap == null) verdict = `<span style="color:${C.bad}">fix: book more calls</span>`
      else if (d.oppsNeeded <= cap) verdict = `<span style="color:${C.bad}">fix: book ${Math.min(d.oppsNeeded - d.opps, Math.max(0, cap - d.opps))} more — trucks had room</span>`
      else verdict = `<span style="color:${C.bad}">fix: capacity — trucks max at ${cap}; needs ${d.oppsNeeded} at this close rate</span>`
        + (atTarget != null && atTarget <= cap ? `<br><span style="color:${C.mute};font-size:11px">or: at the ${Math.round(d.convTarget * 100)}% target close, ~${atTarget} calls would do it</span>` : '')
    }
    return [
      esc(d.trade), String(d.opps),
      d.oppsNeeded != null ? String(d.oppsNeeded) : '—',
      cap != null ? String(cap) : '—',
      d.oppsNeeded != null ? signed(d.opps - d.oppsNeeded, (n) => String(Math.round(Math.abs(n)))) : '—',
      verdict,
    ]
  })

  const trendRows = f.trend.map(t => [
    esc(new Date(`${t.weekEnd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })),
    money(t.sales), money(t.goal),
    t.hit ? `<span style="color:${C.good};font-weight:700">YES</span>` : `<span style="color:${C.bad};font-weight:700">NO</span>`,
  ])

  // Top 3 + lowest per department (lowest only when the dept has >3 scored).
  const techsByDept = ['HVAC', 'Plumbing', 'Electrical', 'Garage Doors'].map(trade => {
    const scored = f.technicians.filter(t => t.score != null && t.trade === trade)
    return { trade, top: scored.slice(0, 3), lowest: scored.length > 3 ? scored[scored.length - 1] : null }
  }).filter(g => g.top.length)
  const techRow = (t) => [
    esc(t.name), t.score != null ? String(t.score) : '—', money(t.soldAmount),
    t.closeRate != null ? pct(t.closeRate) : '—',
    t.dollarsPerOpp != null ? money(t.dollarsPerOpp) : '—',
    String(t.jobsRan),
    t.callbacks ? `<span style="color:${C.warn};font-weight:700">${t.callbacks}</span>` : '0',
  ]
  const scoredCsrs = f.csrs.filter(c => c.score != null)
  const topCsrs = scoredCsrs.slice(0, 3)
  const bottomCsrs = scoredCsrs.length > 3 ? [scoredCsrs[scoredCsrs.length - 1]] : []
  const csrRow = (c) => [
    esc(c.name), c.score != null ? String(c.score) : '—', String(c.booked), String(c.leadCalls),
    c.bookRate != null ? pct(c.bookRate) : '—', String(c.inbound ?? '—'), String(c.outbound ?? 0),
    c.qa != null ? `${c.qa}%` : '—',
  ]

  const aiHighlights = [ai?.highlights, ai?.summary].map(v => Array.isArray(v) ? v : []).find(v => v.length) || []
  const aiActions = Array.isArray(ai?.actionsByDept) ? ai.actionsByDept.filter(d => d && Array.isArray(d.actions)) : []
  const aiHtml = ai ? `
    <div style="background:#F0F6FB;border-left:4px solid ${C.accent};border-radius:8px;padding:14px 16px">
      ${ai.headline ? `<div style="font-size:14px;font-weight:800;color:${C.ink};margin-bottom:10px">${esc(ai.headline)}</div>` : ''}
      ${aiHighlights.length ? `<div style="font-size:11px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${C.mute};margin:0 0 6px">Top highlights</div>
        ${aiHighlights.map(s => `<div style="font-size:13px;color:${C.ink};line-height:1.55;margin-bottom:4px">• ${esc(s)}</div>`).join('')}` : ''}
      ${aiActions.length ? `<div style="font-size:11px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${C.mute};margin:12px 0 6px">Action items by department</div>
        ${aiActions.map(d => `
          <div style="margin-bottom:7px">
            <div style="font-size:12.5px;font-weight:800;color:${C.ink}">${esc(d.dept)}</div>
            ${(d.actions || []).map(a => `<div style="font-size:13px;color:${C.ink};line-height:1.5;padding-left:10px">→ ${esc(a)}</div>`).join('')}
          </div>`).join('')}` : ''}
      ${(!aiActions.length && Array.isArray(ai.actionItems) && ai.actionItems.length) ? `<div style="font-size:11px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${C.mute};margin:12px 0 6px">Action items</div>
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
    </tr></table>
    ${(() => {
      const b = notes.budgets || {}
      const mSales = Number(b.monthSales) || f.mtd.salesTarget || 0
      const mRev = Number(b.monthRevenue) || f.mtd.target || 0
      const ySales = Number(b.yearSales) || (f.ytd && f.ytd.target) || 0
      return `<table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-top:8px"><tr>
        ${card('MTD Sales', money(f.mtd.sales), `budget ${money(mSales)} · proj ${money(f.mtd.salesProjected)}`)}
        ${card('MTD Revenue', money(f.mtd.revenue), `budget ${money(mRev)} · proj ${money(f.mtd.projected)}`)}
        ${f.ytd ? card('YTD Sales', money(f.ytd.sales), `target ${money(ySales)} · proj ${money(f.ytd.projected)}`) : ''}
      </tr></table>`
    })()}

    ${ai ? section('The week, read by AI', aiHtml) : ''}

    ${section('Department scorecard', table(
      ['Dept', 'Wk Sales', 'Budget', 'Var', 'Wk Rev', 'Rev Tgt', 'Close / Tgt', 'Avg Sale', 'Opps', 'Missed $', '5★', 'Clubs', 'Callbacks'], scoreRows))}

    ${section('Company KPIs (WoW)', table(['KPI', 'This Wk', 'Last Wk', 'Δ', 'Goal'], kpiRows))}

    ${section('Opportunities: ran vs needed', `
      <div style="font-size:11.5px;color:${C.mute};margin-bottom:8px">"Needed" = budget ÷ (this week's actual close rate × average sale) — a soft closing week INFLATES it. A huge Needed number doesn't mean "get that many calls"; it means the close rate is the real fix.</div>
      ${table(['Dept', 'Ran', 'Needed', 'Capacity', 'Diff', 'Verdict'], oppRows)}`)}

    ${section(`Last week's true labor (burdened) — wk ending ${f.labor.weekEnd}`, `
      <table style="width:100%;border-collapse:separate;border-spacing:8px 0"><tr>
        ${card('LW field labor (true)', money(f.labor.estFieldBurdened), `${money(f.labor.impliedCommissions)} commissions + hidden pool + burden`)}
        ${card('LW office labor', money(f.labor.officeWeeklyCost), 'burdened weekly baseline')}
        ${card('LW all-in labor %', pct(f.labor.laborPctOfRevenue), "of last week's revenue · target 25% field")}
        ${card('LW hidden pool', money(f.labor.hiddenPool), 'field pay not tied to any job')}
      </tr></table>
      <div style="font-size:11px;color:${C.mute};margin-top:8px">Model: paid commissionable revenue × ${Math.round(f.labor.factors.commissionRate * 100)}% × ${f.labor.factors.poolUplift} pool uplift × ${f.labor.factors.fieldBurden} ADP burden${notes.fieldPayrollActual ? ` — <b>overridden with actual ADP field gross ${money(notes.fieldPayrollActual)}</b>` : ''}. ST sees only the commissions.</div>`)}

    ${techsByDept.length ? section('Technicians — top 3 + lowest per department', techsByDept.map(g => `
      <div style="font-size:12.5px;font-weight:800;color:${C.accent};margin:10px 0 4px">${esc(g.trade)}</div>
      ${table(['Tech', 'Score', 'Sold', 'Close', '$/Opp', 'Jobs', 'Callbacks'],
        [...g.top.map(techRow), ...(g.lowest ? [techRow(g.lowest).map((c, i) => i === 0 ? `<span style="color:${C.bad};font-weight:700">${c}</span>` : c)] : [])])}`).join('')) : ''}

    ${topCsrs.length ? section('CSRs — top 3 + lowest', table(['CSR', 'Score', 'Booked', 'Lead calls', 'Book rate', 'Total inbound', 'Outbound', 'QA'],
      [...topCsrs.map(csrRow), ...bottomCsrs.map(c => csrRow(c).map((x, i) => i === 0 ? `<span style="color:${C.bad};font-weight:700">${x}</span>` : x))])) : ''}

    ${f.marketing.length ? section('Marketing channels — spend vs return (spend prorated to the week)', table(['Channel', 'Spend', 'Leads', 'Booked', 'Rate', 'Jobs', 'Revenue', 'CPL', 'ROAS'],
      f.marketing.map(m => [esc(m.name),
        m.spend ? money(m.spend) : '—',
        String(m.calls), String(m.booked), m.rate == null ? '—' : pct(m.rate),
        String(m.jobs), m.revenue ? money(m.revenue) : '—',
        m.cpl != null ? money(m.cpl) : '—',
        m.roas == null ? '—' : `<span style="color:${m.roas >= 3 ? C.good : m.roas >= 1 ? C.warn : C.bad};font-weight:700">${m.roas}x</span>`]))) : ''}

    ${section('6-week sales trend', table(['W/E', 'Sales', 'Goal', 'Hit?'], trendRows))}

    ${topicsRows.length ? section('Discussion topics', table(['#', 'Topic', 'Owner'], topicsRows)) : ''}
    ${projectRows.length ? section('Rocks', table(['Rock', 'Owner', 'Status', 'Due', 'Progress this week'], projectRows)) : ''}

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
