// ── Per-department daily brief ───────────────────────────────────────────────
//
// One trade's yesterday, as structured JSON + AI insights, for a department
// leader. Consumed by the leader's own ChatGPT/Claude (via a token-scoped
// endpoint) so they can blend it with their personal brief. Same ST metric
// definitions as the morning digest and leadership report, so numbers agree.

const TRADE_KEYS = { HVAC: 'hvac', Plumbing: 'plumb', Electrical: 'electric', 'Garage Doors': 'garage' }
const tradeMatches = (trade, buName) => (buName || '').toLowerCase().includes(TRADE_KEYS[trade] || '\0')
const r0 = (n) => Math.round(Number(n) || 0)

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
  const [estSold, estCreated, appts, spiffRows, bus] = await Promise.all([
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?soldAfter=${w.startIso}&soldBefore=${w.endIso}&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/sales/v2/tenant/${tenantId}/estimates?createdOnOrAfter=${w.startIso}&createdBefore=${w.endIso}&pageSize=500&page=${pg}`, 6000), []),
    safe(stPageAll(pg => `/jpm/v2/tenant/${tenantId}/appointments?startsOnOrAfter=${w.startIso}&pageSize=500&page=${pg}`, 6000), []),
    safe(supabase.from('job_type_spiffs').select('st_job_type_id, category').then(r => r.data || []), []),
    safe(stGet(`/settings/v2/tenant/${tenantId}/business-units?pageSize=200`).then(d => d?.data || []), []),
  ])
  const buTrade = new Map(bus.map(b => [String(b.id), tradeMatches(trade, b.name)]))
  const catById = new Map(spiffRows.map(r => [String(r.st_job_type_id), r.category]))

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

  // job -> category + trade, for the ran jobs
  const ranIds = [...new Set([...techJobs.values()].flatMap(s => [...s]))]
  const jobCat = new Map(), jobTrade = new Map()
  for (let i = 0; i < ranIds.length; i += 50) {
    try {
      const r = await stGet(`/jpm/v2/tenant/${tenantId}/jobs?ids=${ranIds.slice(i, i + 50).join(',')}&pageSize=50`)
      for (const j of (r?.data || [])) { jobCat.set(j.id, catById.get(String(j.jobTypeId)) || null); jobTrade.set(j.id, buTrade.get(String(j.businessUnitId)) || false) }
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
    })
  }
  techs.sort((a, b) => (a.closeRate ?? 2) - (b.closeRate ?? 2))
  return {
    department: trade, window: `${w.fromDate} to ${w.toDate}`, days: w.days,
    note: 'Close rate = jobs sold / sales-opportunity jobs the tech ran (excludes maintenance/callbacks). Techs with few opportunities have noisy rates.',
    technicians: techs,
  }
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
