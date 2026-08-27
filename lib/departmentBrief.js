// ── Per-department daily brief ───────────────────────────────────────────────
//
// One trade's yesterday, as structured JSON + AI insights, for a department
// leader. Consumed by the leader's own ChatGPT/Claude (via a token-scoped
// endpoint) so they can blend it with their personal brief. Same ST metric
// definitions as the morning digest and leadership report, so numbers agree.

const TRADE_KEYS = { HVAC: 'hvac', Plumbing: 'plumb', Electrical: 'electric', 'Garage Doors': 'garage' }
const ALL_TRADES = ['HVAC', 'Plumbing', 'Electrical', 'Garage Doors']
// 'ALL' matches every business unit — used by the owner-scoped token.
const tradeMatches = (trade, buName) => trade === 'ALL' ? true : (buName || '').toLowerCase().includes(TRADE_KEYS[trade] || '\0')
const tradeOfBU = (buName) => { const n = (buName || '').toLowerCase(); return ALL_TRADES.find(t => n.includes(TRADE_KEYS[t])) || null }
const r0 = (n) => Math.round(Number(n) || 0)

// Normalize a department query param to a canonical trade or 'ALL'.
export function normalizeDept(s) {
  const q = String(s || '').toLowerCase().trim()
  if (!q || q === 'all' || q === 'company' || q === 'everything') return 'ALL'
  if (q.includes('hvac')) return 'HVAC'
  if (q.includes('plumb')) return 'Plumbing'
  if (q.includes('electric')) return 'Electrical'
  if (q.includes('garage')) return 'Garage Doors'
  return 'ALL'
}

function denverDayBounds(dateStr) {
  const noonUtc = new Date(`${dateStr}T18:00:00Z`)
  const denverHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: '2-digit', hour12: false }).format(noonUtc))
  const offset = 18 - denverHour
  const start = new Date(`${dateStr}T00:00:00Z`); start.setUTCHours(offset)
  const end = new Date(start.getTime() + 24 * 3600_000)
  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

export async function gatherDepartmentFacts({ stGet, stPageAll, supabase, tenantId, trade, dateStr }) {
  const { startIso, endIso } = denverDayBounds(dateStr)
  const invFrom = `${dateStr}T00:00:00Z`, invTo = `${dateStr}T23:59:59Z`
  const monthStart = `${dateStr.slice(0, 7)}-01`
  const { startIso: mStart } = denverDayBounds(monthStart)
  const safe = (p, f) => p.then(r => r).catch(e => { console.warn('deptbrief:', e.message); return f })

  const [estSold, estCreated, invoices, memberships, mSold, mInv] = await Promise.all([
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${startIso}&soldBefore=${endIso}&pageSize=500&page=${pg}`, 4000), []),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?createdOnOrAfter=${startIso}&createdBefore=${endIso}&pageSize=500&page=${pg}`, 4000), []),
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${invFrom}&invoicedOnBefore=${invTo}&pageSize=500&page=${pg}`, 4000), []),
    safe(stPageAll(pg => `/memberships/v2/tenant/${tenantId}/memberships?createdOnOrAfter=${startIso}&createdBefore=${endIso}&pageSize=500&page=${pg}`, 2000), []),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${mStart}&soldBefore=${endIso}&pageSize=500&page=${pg}`, 8000), []),
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${monthStart}T00:00:00Z&invoicedOnBefore=${invTo}&pageSize=500&page=${pg}`, 8000), []),
  ])

  // ── Sales (sold estimates in this trade) ─────────────────────────────────
  const sold = estSold.filter(e => (e.status || {}).name === 'Sold' && tradeMatches(trade, e.businessUnitName))
  const salesTotal = sold.reduce((a, e) => a + (Number(e.subtotal) || 0), 0)
  const soldJobIds = new Set(sold.map(e => e.jobId).filter(Boolean))

  // ── Close rate: presented vs sold jobs in this trade ─────────────────────
  const presentedTrade = new Set(estCreated.filter(e => tradeMatches(trade, e.businessUnitName)).map(e => e.jobId).filter(Boolean))
  const soldPresented = [...presentedTrade].filter(j => soldJobIds.has(j)).length
  const closeRate = presentedTrade.size ? soldPresented / presentedTrade.size : null

  // ── Revenue (invoiced in this trade) ─────────────────────────────────────
  const revTrade = invoices.filter(i => tradeMatches(trade, (i.businessUnit || {}).name))
  const revenueTotal = revTrade.reduce((a, i) => a + (Number(i.subTotal) || 0), 0)

  // ── Top sellers in this trade (soldBy → tech name) ───────────────────────
  const byTech = new Map()
  for (const e of sold) {
    if (!e.soldBy) continue
    const c = byTech.get(e.soldBy) || { amount: 0, count: 0 }
    c.amount += Number(e.subtotal) || 0; c.count++
    byTech.set(e.soldBy, c)
  }
  const names = new Map()
  try {
    const { data } = await supabase.from('dispatch_tech_scores').select('tech_id, tech_name')
    for (const r of (data || [])) names.set(String(r.tech_id), r.tech_name)
  } catch {}
  try {
    const t = await stGet(`/settings/v2/tenant/${tenantId}/technicians?pageSize=500&active=any`)
    for (const x of (t?.data || [])) if (!names.has(String(x.id))) names.set(String(x.id), x.name)
  } catch {}
  const topSellers = [...byTech.entries()]
    .map(([id, c]) => ({ name: names.get(String(id)) || `Tech ${id}`, sold: r0(c.amount), count: c.count, avg: r0(c.amount / c.count) }))
    .sort((a, b) => b.sold - a.sold).slice(0, 6)

  // ── Money left behind: open (unsold) estimates in this trade ─────────────
  const openTrade = estCreated.filter(e => tradeMatches(trade, e.businessUnitName) && (e.status || {}).name !== 'Sold')
  const openValue = openTrade.reduce((a, e) => a + (Number(e.subtotal) || 0), 0)

  // ── Memberships in this trade ────────────────────────────────────────────
  const clubTrade = memberships.filter(m => true) // dept attribution needs BU lookup; keep company count minimal
  const clubsCompany = memberships.length

  // ── MTD pace for this trade ──────────────────────────────────────────────
  const mtdSales = mSold.filter(e => (e.status || {}).name === 'Sold' && tradeMatches(trade, e.businessUnitName)).reduce((a, e) => a + (Number(e.subtotal) || 0), 0)
  const mtdRevenue = mInv.filter(i => tradeMatches(trade, (i.businessUnit || {}).name)).reduce((a, i) => a + (Number(i.subTotal) || 0), 0)
  let budget = null
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'digest_budgets').maybeSingle()
    const b = data?.value ? JSON.parse(data.value) : null
    const wk = b?.weeklyDeptBudget?.[trade]
    if (wk) budget = wk * 52 / 12   // weekly dept budget → monthly
  } catch {}

  return {
    trade, date: dateStr,
    sales: { total: r0(salesTotal), count: sold.length, avg: sold.length ? r0(salesTotal / sold.length) : 0 },
    closeRate: closeRate == null ? null : Math.round(closeRate * 100) / 100,
    opportunities: presentedTrade.size, sold: soldPresented,
    revenue: { total: r0(revenueTotal), invoices: revTrade.length },
    topSellers,
    moneyLeftBehind: { openEstimates: openTrade.length, openValue: r0(openValue) },
    memberships: clubsCompany,
    mtd: {
      sales: r0(mtdSales), revenue: r0(mtdRevenue),
      monthlyBudget: budget ? r0(budget) : null,
      pacePct: budget ? Math.round((mtdRevenue / (budget * (Number(dateStr.slice(8, 10)) / new Date(Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)), 0).getDate()))) * 100) : null,
    },
  }
}

async function generateInsights(facts, anthropicKey) {
  if (!anthropicKey) return null
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 700,
        system: `You are the operations analyst for the ${facts.trade} department at Awesome Home Services (Colorado Springs home services). You get yesterday's ${facts.trade} numbers as JSON. Write 2-4 short insights for the ${facts.trade} department manager reading this in their morning brief — number first, one line each, the non-obvious read (a close rate that contradicts sales, a seller carrying or sinking the day, money left on the table in open estimates, MTD pace). Each insight ends with a concrete action for today. Only cite numbers present in the data. No fluff, no restating the tables.`,
        tools: [{ name: 'submit', description: 'Submit brief insights', input_schema: { type: 'object', properties: {
          headline: { type: 'string', description: 'One sentence on yesterday for this department.' },
          insights: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, action: { type: 'string' } }, required: ['text', 'action'] } },
        }, required: ['headline', 'insights'] } }],
        tool_choice: { type: 'tool', name: 'submit' },
        messages: [{ role: 'user', content: JSON.stringify(facts).slice(0, 12000) }],
      }),
    })
    if (!r.ok) return null
    const out = (await r.json())?.content?.find(c => c.type === 'tool_use')?.input
    return out ? { headline: out.headline, insights: (out.insights || []).slice(0, 4) } : null
  } catch (e) { console.warn('deptbrief insights:', e.message); return null }
}

export async function buildDepartmentBrief(deps) {
  const facts = await gatherDepartmentFacts(deps)
  const ai = await generateInsights(facts, deps.anthropicKey)
  return { department: facts.trade, date: facts.date, generatedAt: new Date().toISOString(), metrics: facts, insights: ai }
}

// ── Company overview: every trade broken out + company totals (owner) ───────
export async function buildCompanyOverview({ stGet, stPageAll, supabase, tenantId, anthropicKey, period }) {
  const w = periodWindow(period)
  const safe = (p, f) => p.then(r => r).catch(e => { console.warn('company:', e.message); return f })
  const invDate = (iso) => iso.slice(0, 10)
  const [estSold, estCreated, invoices, memberships, reviews, pSold, pInv] = await Promise.all([
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${w.startIso}&soldBefore=${w.endIso}&pageSize=500&page=${pg}`, 8000), []),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?createdOnOrAfter=${w.startIso}&createdBefore=${w.endIso}&pageSize=500&page=${pg}`, 8000), []),
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${invDate(w.startIso)}T00:00:00Z&invoicedOnBefore=${w.toDate}T23:59:59Z&pageSize=500&page=${pg}`, 8000), []),
    safe(stPageAll(pg => `/memberships/v2/tenant/${tenantId}/memberships?createdOnOrAfter=${w.startIso}&createdBefore=${w.endIso}&pageSize=500&page=${pg}`, 3000), []),
    safe(stGet(`/marketingreputation/v2/tenant/${tenantId}/reviews?fromDate=${w.fromDate}&toDate=${w.toDate}&pageSize=200`).then(d => d?.data || []), []),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${w.priorStartIso}&soldBefore=${w.priorEndIso}&pageSize=500&page=${pg}`, 8000), []),
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${invDate(w.priorStartIso)}T00:00:00Z&invoicedOnBefore=${invDate(w.priorEndIso)}T23:59:59Z&pageSize=500&page=${pg}`, 8000), []),
  ])
  const blank = () => ({ sales: 0, soldCount: 0, revenue: 0, presented: new Set(), soldJobs: new Set() })
  const byTrade = Object.fromEntries(ALL_TRADES.map(t => [t, blank()]))
  for (const e of estSold) {
    if ((e.status || {}).name !== 'Sold') continue
    const t = tradeOfBU(e.businessUnitName); if (!t) continue
    byTrade[t].sales += Number(e.subtotal) || 0; byTrade[t].soldCount++
    if (e.jobId) byTrade[t].soldJobs.add(e.jobId)
  }
  for (const e of estCreated) { const t = tradeOfBU(e.businessUnitName); if (t && e.jobId) byTrade[t].presented.add(e.jobId) }
  for (const i of invoices) { const t = tradeOfBU((i.businessUnit || {}).name); if (t) byTrade[t].revenue += Number(i.subTotal) || 0 }
  const departments = ALL_TRADES.map(t => {
    const d = byTrade[t]
    const soldPres = [...d.presented].filter(j => d.soldJobs.has(j)).length
    return { department: t, sales: r0(d.sales), soldCount: d.soldCount, revenue: r0(d.revenue),
             avgTicket: d.soldCount ? r0(d.sales / d.soldCount) : 0,
             opportunities: d.presented.size, closeRate: d.presented.size ? Math.round(soldPres / d.presented.size * 100) / 100 : null }
  })
  const companySales = departments.reduce((a, d) => a + d.sales, 0)
  const companyRevenue = departments.reduce((a, d) => a + d.revenue, 0)
  const pSales = pSold.filter(e => (e.status || {}).name === 'Sold').reduce((a, e) => a + (Number(e.subtotal) || 0), 0)
  const pRev = pInv.reduce((a, i) => a + (Number(i.subTotal) || 0), 0)
  const facts = {
    period: w.label, window: `${w.fromDate} to ${w.toDate}`,
    company: { sales: r0(companySales), revenue: r0(companyRevenue),
               memberships: memberships.length, fiveStarReviews: reviews.filter(r => Number(r.rating || r.reviewRating) >= 5).length,
               vsPriorPeriod: { salesDeltaPct: pSales ? Math.round((companySales - pSales) / pSales * 100) : null, revenueDeltaPct: pRev ? Math.round((companyRevenue - pRev) / pRev * 100) : null } },
    departments,
  }
  const ai = await generateInsights({ trade: 'the whole company', ...facts }, anthropicKey)
  return { scope: 'company', ...facts, insights: ai, generatedAt: new Date().toISOString() }
}

// ── Receivables / AR: unpaid invoices, aged, by department (owner) ──────────
export async function buildReceivables({ stPageAll, tenantId, trade, days }) {
  const w = periodWindow(String(Math.min(Math.max(Number(days) || 120, 30), 180)))
  const inv = await stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${w.fromDate}T00:00:00Z&invoicedOnBefore=${w.toDate}T23:59:59Z&pageSize=500&page=${pg}`, 12000).catch(() => [])
  const now = Date.now()
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }
  const byTrade = {}
  const open = []
  for (const i of inv) {
    const bal = Number(i.balance) || 0
    if (bal <= 0) continue
    if (trade !== 'ALL' && !tradeMatches(trade, (i.businessUnit || {}).name)) continue
    const age = i.invoiceDate ? Math.round((now - Date.parse(i.invoiceDate)) / 86400000) : 0
    const b = age <= 30 ? '0-30' : age <= 60 ? '31-60' : age <= 90 ? '61-90' : '90+'
    buckets[b] += bal
    const t = tradeOfBU((i.businessUnit || {}).name) || 'Other'
    byTrade[t] = (byTrade[t] || 0) + bal
    open.push({ jobNumber: (i.job || {}).number, customer: (i.customer || {}).name, balance: r0(bal), ageDays: age, invoiceDate: (i.invoiceDate || '').slice(0, 10), department: t })
  }
  open.sort((a, b) => b.balance - a.balance)
  return {
    scope: trade === 'ALL' ? 'company' : trade, window: `${w.fromDate} to ${w.toDate}`,
    totalOutstanding: r0(Object.values(buckets).reduce((a, b) => a + b, 0)),
    aging: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, r0(v)])),
    byDepartment: Object.fromEntries(Object.entries(byTrade).map(([k, v]) => [k, r0(v)])),
    openInvoices: open.length, largest: open.slice(0, 25),
  }
}

// Denver date N days ago (inclusive window start), and now.
function windowBounds(days) {
  const clamp = Math.min(Math.max(Number(days) || 7, 1), 45)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())
  const start = new Date(`${today}T12:00:00Z`); start.setUTCDate(start.getUTCDate() - (clamp - 1))
  const startStr = start.toISOString().slice(0, 10)
  const { startIso } = denverDayBounds(startStr)
  return { startIso, endIso: new Date().toISOString(), days: clamp, fromDate: startStr, toDate: today }
}

const SALES_OPP_CATS = new Set(['repair', 'other', 'free_estimate'])

// ── Per-technician performance for one trade over a window ───────────────────
export async function buildTechnicianPerformance({ stGet, stPageAll, supabase, tenantId, trade, days }) {
  const w = windowBounds(days)
  const safe = (p, f) => p.then(r => r).catch(e => { console.warn('techperf:', e.message); return f })
  const [estSold, estCreated, appts, spiffRows, bus, memberships] = await Promise.all([
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${w.startIso}&soldBefore=${w.endIso}&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?createdOnOrAfter=${w.startIso}&createdBefore=${w.endIso}&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/jpm/v2/tenant/${tenantId}/appointments?startsOnOrAfter=${w.startIso}&pageSize=500&page=${pg}`, 6000), []),
    safe(supabase.from('job_type_spiffs').select('st_job_type_id, name, category').then(r => r.data || []), []),
    safe(stGet(`/settings/v2/tenant/${tenantId}/business-units?pageSize=200`).then(d => d?.data || []), []),
    safe(stPageAll(pg => `/memberships/v2/tenant/${tenantId}/memberships?createdOnOrAfter=${w.startIso}&createdBefore=${w.endIso}&pageSize=500&page=${pg}`, 3000), []),
  ])
  const buTrade = new Map(bus.map(b => [String(b.id), tradeMatches(trade, b.name)]))
  const catById = new Map(spiffRows.map(r => [String(r.st_job_type_id), r.category]))
  const nameById = new Map(spiffRows.map(r => [String(r.st_job_type_id), r.name]))
  const isCallback = (jobTypeId) => /callback|warranty|recall|concern/i.test(nameById.get(String(jobTypeId)) || '')
  // memberships sold per technician (soldById)
  const clubByTech = new Map()
  for (const m of memberships) if (m.soldById) clubByTech.set(m.soldById, (clubByTech.get(m.soldById) || 0) + 1)

  const presented = new Set(estCreated.filter(e => tradeMatches(trade, e.businessUnitName)).map(e => e.jobId).filter(Boolean))
  const soldJobs = new Set(estSold.filter(e => (e.status || {}).name === 'Sold' && tradeMatches(trade, e.businessUnitName)).map(e => e.jobId).filter(Boolean))
  const soldByTech = new Map()
  for (const e of estSold) {
    if ((e.status || {}).name !== 'Sold' || !tradeMatches(trade, e.businessUnitName) || !e.soldBy) continue
    const c = soldByTech.get(e.soldBy) || { amount: 0, count: 0 }
    c.amount += Number(e.subtotal) || 0; c.count++; soldByTech.set(e.soldBy, c)
  }

  // appointments -> assignments -> tech -> jobs (names come on the assignment)
  const inWin = appts.filter(a => { const t = Date.parse(a.start || ''); return !Number.isNaN(t) && t >= Date.parse(w.startIso) && a.status !== 'Canceled' })
  const apptById = new Map(inWin.map(a => [a.id, a]))
  const techJobs = new Map(), techName = new Map()
  try {
    const ids = inWin.map(a => a.id).filter(Boolean)
    for (let i = 0; i < ids.length; i += 50) {
      const r = await stGet(`/dispatch/v2/tenant/${tenantId}/appointment-assignments?appointmentIds=${ids.slice(i, i + 50).join(',')}&pageSize=200`)
      for (const asg of (r?.data || [])) {
        if (asg.active === false) continue
        const appt = apptById.get(asg.appointmentId); if (!appt?.jobId) continue
        if (!techJobs.has(asg.technicianId)) techJobs.set(asg.technicianId, new Set())
        techJobs.get(asg.technicianId).add(appt.jobId)
        if (asg.technicianName) techName.set(asg.technicianId, asg.technicianName)
      }
    }
  } catch (e) { console.warn('techperf assign:', e.message) }

  // job -> category + trade + callback flag, for the ran jobs
  const ranIds = [...new Set([...techJobs.values()].flatMap(s => [...s]))]
  const jobCat = new Map(), jobTrade = new Map(), jobCallback = new Map()
  for (let i = 0; i < ranIds.length; i += 50) {
    try {
      const r = await stGet(`/jpm/v2/tenant/${tenantId}/jobs?ids=${ranIds.slice(i, i + 50).join(',')}&pageSize=50`)
      for (const j of (r?.data || [])) { jobCat.set(j.id, catById.get(String(j.jobTypeId)) || null); jobTrade.set(j.id, buTrade.get(String(j.businessUnitId)) || false); jobCallback.set(j.id, isCallback(j.jobTypeId)) }
    } catch {}
  }

  const techs = []
  for (const [id, jobs] of techJobs) {
    const tradeJobs = [...jobs].filter(j => jobTrade.get(j))
    if (!tradeJobs.length) continue
    const opp = tradeJobs.filter(j => { const c = jobCat.get(j); return c == null || SALES_OPP_CATS.has(c) })
    const p = opp.filter(j => presented.has(j)).length
    const s = opp.filter(j => soldJobs.has(j)).length
    const sold = soldByTech.get(id) || { amount: 0, count: 0 }
    techs.push({
      technician: techName.get(id) || `Tech ${id}`,
      jobsRan: tradeJobs.length, opportunities: p, sold: s,
      closeRate: p ? Math.round(s / p * 100) / 100 : null,
      soldDollars: r0(sold.amount), avgTicket: sold.count ? r0(sold.amount / sold.count) : 0,
      callbacks: tradeJobs.filter(j => jobCallback.get(j)).length,
      membershipsSold: clubByTech.get(id) || 0,
    })
  }
  techs.sort((a, b) => (a.closeRate ?? 2) - (b.closeRate ?? 2))
  return {
    department: trade, window: `${w.fromDate} to ${w.toDate}`, days: w.days,
    note: 'Close rate = jobs sold / sales-opportunity jobs the tech ran (excludes maintenance/callbacks). Techs with few opportunities have noisy rates.',
    technicians: techs,
  }
}

// Resolve a period keyword or N-day count into a window + the equal-length
// window immediately before it (for week-over-week style comparisons).
function periodWindow(period) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())
  const dayBounds = (s) => denverDayBounds(s)
  const shift = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const nowIso = new Date().toISOString()
  let start, end = nowIso, label, days
  const p = String(period || 'yesterday').toLowerCase()
  if (/^\d+$/.test(p)) { days = Math.min(Math.max(Number(p), 1), 90); start = shift(today, -(days - 1)); label = `last ${days} days` }
  else if (p === 'today') { start = today; days = 1; label = 'today' }
  else if (p === 'week' || p === 'thisweek' || p === '7days') { days = 7; start = shift(today, -6); label = 'last 7 days' }
  else if (p === 'month' || p === 'mtd') { start = `${today.slice(0, 7)}-01`; days = Number(today.slice(8, 10)); label = 'month to date' }
  else if (p === 'yesterday') { start = shift(today, -1); end = dayBounds(today).startIso; days = 1; label = 'yesterday' }
  else { start = shift(today, -1); end = dayBounds(today).startIso; days = 1; label = 'yesterday' }
  const { startIso } = dayBounds(start)
  // prior equal-length window
  const priorEndStr = start
  const priorStartStr = shift(start, -days)
  return { startIso, endIso: end, label, days, fromDate: start, toDate: today,
           priorStartIso: dayBounds(priorStartStr).startIso, priorEndIso: dayBounds(priorEndStr).startIso }
}

// ── Flexible period summary (yesterday / today / week / month / N days) ──────
export async function buildPeriodSummary({ stGet, stPageAll, supabase, tenantId, anthropicKey, trade, period }) {
  const w = periodWindow(period)
  const safe = (p, f) => p.then(r => r).catch(e => { console.warn('summary:', e.message); return f })
  const invDate = (iso) => iso.slice(0, 10)
  const [estSold, estCreated, invoices, memberships, reviews, pSold, pInv] = await Promise.all([
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${w.startIso}&soldBefore=${w.endIso}&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?createdOnOrAfter=${w.startIso}&createdBefore=${w.endIso}&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${invDate(w.startIso)}T00:00:00Z&invoicedOnBefore=${w.toDate}T23:59:59Z&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/memberships/v2/tenant/${tenantId}/memberships?createdOnOrAfter=${w.startIso}&createdBefore=${w.endIso}&pageSize=500&page=${pg}`, 3000), []),
    safe(stGet(`/marketingreputation/v2/tenant/${tenantId}/reviews?fromDate=${w.fromDate}&toDate=${w.toDate}&pageSize=200`).then(d => d?.data || []), []),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${w.priorStartIso}&soldBefore=${w.priorEndIso}&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${invDate(w.priorStartIso)}T00:00:00Z&invoicedOnBefore=${invDate(w.priorEndIso)}T23:59:59Z&pageSize=500&page=${pg}`, 6000), []),
  ])
  const sold = estSold.filter(e => (e.status || {}).name === 'Sold' && tradeMatches(trade, e.businessUnitName))
  const salesTotal = sold.reduce((a, e) => a + (Number(e.subtotal) || 0), 0)
  const soldJobIds = new Set(sold.map(e => e.jobId).filter(Boolean))
  const presented = new Set(estCreated.filter(e => tradeMatches(trade, e.businessUnitName)).map(e => e.jobId).filter(Boolean))
  const soldPresented = [...presented].filter(j => soldJobIds.has(j)).length
  const revTrade = invoices.filter(i => tradeMatches(trade, (i.businessUnit || {}).name))
  const revenueTotal = revTrade.reduce((a, i) => a + (Number(i.subTotal) || 0), 0)
  const openTrade = estCreated.filter(e => tradeMatches(trade, e.businessUnitName) && !['Sold', 'Dismissed'].includes((e.status || {}).name))
  // reviews attributed to trade via tech -> business unit
  let techBU = new Map()
  try { const { data } = await supabase.from('dispatch_tech_scores').select('tech_id, business_unit'); for (const r of (data || [])) techBU.set(String(r.tech_id), r.business_unit) } catch {}
  const fiveStar = reviews.filter(r => Number(r.rating || r.reviewRating) >= 5 && tradeMatches(trade, techBU.get(String(r.technicianId)))).length
  const pSales = pSold.filter(e => (e.status || {}).name === 'Sold' && tradeMatches(trade, e.businessUnitName)).reduce((a, e) => a + (Number(e.subtotal) || 0), 0)
  const pRev = pInv.filter(i => tradeMatches(trade, (i.businessUnit || {}).name)).reduce((a, i) => a + (Number(i.subTotal) || 0), 0)

  const facts = {
    trade, period: w.label, window: `${w.fromDate} to ${w.toDate}`,
    sales: { total: r0(salesTotal), count: sold.length, avgTicket: sold.length ? r0(salesTotal / sold.length) : 0 },
    revenue: { total: r0(revenueTotal), invoices: revTrade.length },
    closeRate: presented.size ? Math.round(soldPresented / presented.size * 100) / 100 : null,
    opportunities: presented.size, soldJobs: soldPresented,
    membershipsSoldCompany: memberships.length, fiveStarReviews: fiveStar,
    moneyLeftBehind: { openEstimates: openTrade.length, openValue: r0(openTrade.reduce((a, e) => a + (Number(e.subtotal) || 0), 0)) },
    vsPriorPeriod: { salesDeltaPct: pSales ? Math.round((salesTotal - pSales) / pSales * 100) : null, revenueDeltaPct: pRev ? Math.round((revenueTotal - pRev) / pRev * 100) : null },
  }
  const ai = await generateInsights(facts, anthropicKey)
  return { department: trade, ...facts, insights: ai, generatedAt: new Date().toISOString() }
}

// ── Sales/revenue trend over N days (or weeks) ───────────────────────────────
export async function buildTrend({ stPageAll, tenantId, trade, days, interval }) {
  const w = periodWindow(String(Math.min(Math.max(Number(days) || 30, 2), 90)))
  const byDay = (iso) => {
    const dt = new Date(iso.replace('Z', '+00:00')); dt.setUTCHours(dt.getUTCHours() - 6)
    return dt.toISOString().slice(0, 10)
  }
  const [sold, inv] = await Promise.all([
    stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${w.startIso}&soldBefore=${w.endIso}&pageSize=500&page=${pg}`, 8000).catch(() => []),
    stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${w.fromDate}T00:00:00Z&invoicedOnBefore=${w.toDate}T23:59:59Z&pageSize=500&page=${pg}`, 8000).catch(() => []),
  ])
  const bucket = {}
  const key = (dstr) => {
    if ((interval || 'day') === 'week') { const d = new Date(`${dstr}T12:00:00Z`); return d.toISOString().slice(0, 10).slice(0, 8) + String(Math.ceil(d.getUTCDate() / 7)) } // rough weekly
    return dstr
  }
  for (const e of sold) if ((e.status || {}).name === 'Sold' && tradeMatches(trade, e.businessUnitName)) {
    const k = key(byDay(e.soldOn || w.startIso)); (bucket[k] = bucket[k] || { sales: 0, revenue: 0 }).sales += Number(e.subtotal) || 0
  }
  for (const i of inv) if (tradeMatches(trade, (i.businessUnit || {}).name)) {
    const k = key((i.invoiceDate || '').slice(0, 10)); if (k) (bucket[k] = bucket[k] || { sales: 0, revenue: 0 }).revenue += Number(i.subTotal) || 0
  }
  const series = Object.entries(bucket).sort().map(([k, v]) => ({ period: k, sales: r0(v.sales), revenue: r0(v.revenue) }))
  return { department: trade, window: `${w.fromDate} to ${w.toDate}`, interval: interval || 'day', series }
}

// ── Lead sources for the trade (approximate — attributed by campaign BU) ─────
export async function buildLeadSources({ stPageAll, tenantId, trade, days }) {
  const w = periodWindow(String(Math.min(Math.max(Number(days) || 14, 1), 90)))
  const calls = await stPageAll(pg => `/telecom/v2/tenant/${tenantId}/calls?createdOnOrAfter=${w.startIso}&createdBefore=${w.endIso}&pageSize=500&page=${pg}`, 10000).catch(() => [])
  const chan = new Map()
  let lead = 0, booked = 0
  for (const c of calls) {
    const lc = c.leadCall || c
    if ((lc.direction || '') !== 'Inbound' || !['Booked', 'Unbooked'].includes(lc.callType)) continue
    const camp = lc.campaign || {}
    if (!tradeMatches(trade, camp.businessUnit)) continue   // approximate trade attribution
    lead++; if (lc.callType === 'Booked') booked++
    const name = camp.name || 'Unattributed'
    const cur = chan.get(name) || { channel: name, calls: 0, booked: 0 }
    cur.calls++; if (lc.callType === 'Booked') cur.booked++; chan.set(name, cur)
  }
  const channels = [...chan.values()].map(c => ({ ...c, bookingRate: c.calls ? Math.round(c.booked / c.calls * 100) / 100 : null }))
    .sort((a, b) => b.calls - a.calls)
  return {
    department: trade, window: `${w.fromDate} to ${w.toDate}`,
    note: 'Trade attribution is by the tracking campaign\'s business unit; calls without a trade-tagged campaign are excluded.',
    leadCalls: lead, booked, bookingRate: lead ? Math.round(booked / lead * 100) / 100 : null, channels,
  }
}

// ── Recent jobs / customer lookup for the trade ──────────────────────────────
export async function buildRecentJobs({ stPageAll, tenantId, trade, days, customer, status }) {
  const w = periodWindow(String(Math.min(Math.max(Number(days) || 14, 1), 90)))
  const inv = await stPageAll(pg => `/accounting/v2/tenant/${tenantId}/invoices?invoicedOnOrAfter=${w.fromDate}T00:00:00Z&invoicedOnBefore=${w.toDate}T23:59:59Z&pageSize=500&page=${pg}`, 8000).catch(() => [])
  const cq = (customer || '').trim().toLowerCase()
  const rows = []
  for (const i of inv) {
    if (!tradeMatches(trade, (i.businessUnit || {}).name)) continue
    const cust = (i.customer || {}).name || ''
    if (cq && !cust.toLowerCase().includes(cq)) continue
    const j = i.job || {}
    rows.push({ jobNumber: j.number || null, jobType: j.type || null, customer: cust,
                value: r0(i.subTotal), invoiceDate: (i.invoiceDate || '').slice(0, 10),
                balance: r0(i.balance), paid: (Number(i.balance) || 0) === 0 })
  }
  rows.sort((a, b) => (b.invoiceDate || '').localeCompare(a.invoiceDate || '') || b.value - a.value)
  return { department: trade, window: `${w.fromDate} to ${w.toDate}`,
           filteredByCustomer: customer || null, jobCount: rows.length, jobs: rows.slice(0, 50) }
}

// ── Open (unsold) estimates worth following up, for one trade ────────────────
export async function buildOpenEstimates({ stGet, stPageAll, tenantId, trade, days, minValue }) {
  const w = windowBounds(days || 21)
  const min = Number(minValue) || 0
  const est = await stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?createdOnOrAfter=${w.startIso}&createdBefore=${w.endIso}&pageSize=500&page=${pg}`, 8000).catch(() => [])
  const open = est.filter(e => tradeMatches(trade, e.businessUnitName)
    && !['Sold', 'Dismissed'].includes((e.status || {}).name) && (Number(e.subtotal) || 0) >= min)

  // enrich with job number + customer name (batched)
  const jobIds = [...new Set(open.map(e => e.jobId).filter(Boolean))]
  const jobInfo = new Map(), custName = new Map()
  const custIds = new Set()
  for (let i = 0; i < jobIds.length; i += 50) {
    try {
      const r = await stGet(`/jpm/v2/tenant/${tenantId}/jobs?ids=${jobIds.slice(i, i + 50).join(',')}&pageSize=50`)
      for (const j of (r?.data || [])) { jobInfo.set(j.id, { number: j.jobNumber, customerId: j.customerId }); if (j.customerId) custIds.add(j.customerId) }
    } catch {}
  }
  const cids = [...custIds]
  for (let i = 0; i < cids.length; i += 50) {
    try {
      const r = await stGet(`/crm/v2/tenant/${tenantId}/customers?ids=${cids.slice(i, i + 50).join(',')}&pageSize=50`)
      for (const c of (r?.data || [])) custName.set(c.id, c.name)
    } catch {}
  }
  const now = Date.now()
  const rows = open.map(e => {
    const ji = jobInfo.get(e.jobId) || {}
    const ageDays = e.createdOn ? Math.round((now - Date.parse(e.createdOn)) / 86400000) : null
    return {
      estimate: e.name, value: r0(e.subtotal), ageDays,
      jobNumber: ji.number || null, customer: custName.get(ji.customerId) || null,
      soldBy: null, status: (e.status || {}).name,
    }
  }).sort((a, b) => b.value - a.value)
  return {
    department: trade, window: `${w.fromDate} to ${w.toDate}`, days: w.days,
    openEstimateCount: rows.length, totalOpenValue: r0(rows.reduce((a, r) => a + r.value, 0)),
    estimates: rows.slice(0, 40),
  }
}
