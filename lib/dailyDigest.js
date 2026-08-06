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

export async function gatherDigestFacts({ stGet, stPageAll, supabase, tenantId, dateStr }) {
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
  const closeRate = {
    presented: presentedJobs.size,
    sold: [...presentedJobs].filter(j => soldJobIds.has(j)).length,
    byTrade: {},
  }
  closeRate.rate = closeRate.presented ? closeRate.sold / closeRate.presented : null
  for (const t of TRADES) {
    const p = presentedByTrade[t]?.size || 0
    const s = [...(presentedByTrade[t] || [])].filter(j => soldJobsByTrade[t]?.has(j)).length
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
    const presented = [...jobs].filter(j => presentedJobs.has(j)).length
    const soldJobs = [...jobs].filter(j => soldJobIds.has(j)).length
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
  const callCenter = { answered: 0, abandoned: 0, avgWaitSec: null, avgTalkSec: null, bookedByCsr: 0, qaAvg: null, qaCount: 0, outboundDials: 0, byRep: [] }
  try {
    const [{ data: tasks }, { data: bookings }, { data: evals }, { data: logs }] = await Promise.all([
      supabase.from('call_tasks').select('*').gte('queued_at', startIso).lt('queued_at', endIso),
      supabase.from('andi_bookings').select('csr_name, profile_id').gte('booked_at', startIso).lt('booked_at', endIso),
      supabase.from('call_evaluations').select('rep, pct').gte('created_at', startIso).lt('created_at', endIso),
      supabase.from('call_logs').select('rep, outcome').gte('created_at', startIso).lt('created_at', endIso),
    ])
    const answered = (tasks || []).filter(t => t.state === 'answered' || t.answered_at)
    callCenter.answered = answered.length
    callCenter.abandoned = (tasks || []).filter(t => t.abandoned).length
    const waits = answered.map(t => Number(t.wait_seconds)).filter(n => Number.isFinite(n))
    const talks = answered.map(t => Number(t.talk_seconds)).filter(n => Number.isFinite(n))
    callCenter.avgWaitSec = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null
    callCenter.avgTalkSec = talks.length ? Math.round(talks.reduce((a, b) => a + b, 0) / talks.length) : null
    callCenter.bookedByCsr = (bookings || []).length
    const ev = (evals || []).filter(e => e.pct != null)
    callCenter.qaCount = ev.length
    callCenter.qaAvg = ev.length ? Math.round(ev.reduce((a, e) => a + Number(e.pct), 0) / ev.length) : null
    callCenter.outboundDials = (logs || []).length

    const byRep = new Map()
    for (const t of answered) {
      const n = t.agent_name || 'Unknown'
      const cur = byRep.get(n) || { name: n, answered: 0, booked: 0, qa: [] }
      cur.answered++; byRep.set(n, cur)
    }
    for (const b of (bookings || [])) {
      const n = b.csr_name || 'Unknown'
      const cur = byRep.get(n) || { name: n, answered: 0, booked: 0, qa: [] }
      cur.booked++; byRep.set(n, cur)
    }
    for (const e of ev) {
      const cur = byRep.get(e.rep) || { name: e.rep, answered: 0, booked: 0, qa: [] }
      cur.qa.push(Number(e.pct)); byRep.set(e.rep, cur)
    }
    callCenter.byRep = [...byRep.values()].map(r => ({
      name: r.name, answered: r.answered, booked: r.booked,
      bookRate: r.answered ? r.booked / r.answered : null,
      qa: r.qa.length ? Math.round(r.qa.reduce((a, b) => a + b, 0) / r.qa.length) : null,
    })).sort((a, b) => b.answered - a.answered)
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
        system: `You are the operations analyst for Awesome Home Services (HVAC, plumbing, electrical, garage doors — Colorado Springs), writing the "what actually matters" section of the owner's morning digest. You get yesterday's numbers as JSON. Rules: only cite numbers present in the data — never invent or estimate. Each insight names the number AND what to do about it. Prefer the non-obvious: a department whose close rate contradicts its sales, a tech whose average ticket is carrying (or sinking) their team, a marketing channel spending calls without booking, a call-center gap. If something looks like a data gap rather than a business problem, say so plainly instead of drawing a false conclusion. No fluff, no congratulations, no restating the tables.`,
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
    return out ? { headline: out.headline, insights: (out.insights || []).slice(0, 6) } : []
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
      ${card('Sales sold', money(f.sales.total), `${f.sales.count} estimate${f.sales.count === 1 ? '' : 's'}`)}
      ${card('Revenue', money(f.revenue.total), `${f.revenue.count} invoices`)}
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

    ${section('Call center', `
      <table style="width:100%;border-collapse:separate;border-spacing:8px 0"><tr>
        ${card('Calls answered', String(f.callCenter.answered), f.callCenter.abandoned ? `${f.callCenter.abandoned} abandoned` : 'none abandoned')}
        ${card('Booked by CSRs', String(f.callCenter.bookedByCsr), f.callCenter.answered ? `${pct(f.callCenter.bookedByCsr / f.callCenter.answered)} of answered` : '')}
        ${card('Avg wait', f.callCenter.avgWaitSec == null ? '—' : `${f.callCenter.avgWaitSec}s`, f.callCenter.avgTalkSec ? `${Math.round(f.callCenter.avgTalkSec / 60)}m avg talk` : '')}
        ${card('Call QA', f.callCenter.qaAvg == null ? '—' : `${f.callCenter.qaAvg}%`, `${f.callCenter.qaCount} scored`)}
      </tr></table>
      ${f.callCenter.byRep.length ? `<div style="margin-top:12px">${table(['CSR', 'Answered', 'Booked', 'Book rate', 'QA'],
        f.callCenter.byRep.map(r => [esc(r.name), String(r.answered), String(r.booked), r.answered ? pct(r.bookRate) : '—', r.qa == null ? '—' : `${r.qa}%`]))}</div>` : ''}`)}

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
