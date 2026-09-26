// Morning brief on Home (Sep 2026). Each manager's Home opens with yesterday
// and today for their own scope — a department (or an ops manager's pair of
// trades), the whole company, or the call center & dispatch — written once
// each morning from the same facts as the owner's 7 AM digest and saved in
// home_briefs (keyed by the facts' date + scope). Home reads the saved copy;
// nothing here sends email.
//
// deps: { supabase, anthropicKey, gatherFacts(dateStr) → digest facts,
//         techTradeOf(stTechId) → trade | null,
//         monthByTrade() → { [trade]: { sold, plan, closeRate, closeGoal, opps, oppsPerDay, oppsGoal } },
//         coaching(ym) → fieldPro.coachingEvidence }

export const BRIEF_TRADES = ['HVAC', 'Plumbing', 'Electrical', 'Garage Doors']

// 'company' | 'call_center' | 'trades:Electrical+Garage Doors'
export const scopeKey = (s) => (s.kind === 'trades' ? `trades:${[...s.trades].sort().join('+')}` : s.kind)
export const scopeFromKey = (k) => (String(k).startsWith('trades:') ? { kind: 'trades', trades: k.slice(7).split('+').filter(t => BRIEF_TRADES.includes(t)) } : { kind: k })

const normKey = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100)

// The slice of yesterday's facts one scope's brief is written from — small
// enough to send whole, and nothing from outside the scope.
function sliceFor(scope, f, ctx) {
  const board = f.todayBoard || []
  const fp = f.fieldPro || null
  if (scope.kind === 'trades') {
    const inScope = (t) => scope.trades.includes(t)
    const techs = (f.technicians || []).map(t => ({ ...t, trade: ctx.techTradeOf(t.id) })).filter(t => inScope(t.trade))
    const fpTech = (name) => ctx.coach?.techs?.[normKey(name)] || null
    return {
      date: f.date, scope: scope.trades.join(' + '),
      departments: scope.trades.map(t => ({
        trade: t,
        yesterday: { sold: f.sales?.byTrade?.[t] || 0, revenue: f.revenue?.byTrade?.[t] || 0, close: f.closeRate?.byTrade?.[t] || null },
        monthToDate: ctx.month?.[t] || null,
        todayBoard: board.find(b => b.trade === t || (t === 'Garage Doors' && b.trade === 'Garage Door')) || null,
        fieldProMonth: ctx.coach?.byTrade?.[t] ? {
          score: ctx.coach.byTrade[t].score, lowestSteps: (ctx.coach.byTrade[t].lowestSteps || []).slice(0, 3),
          stepWinLift: (ctx.coach.byTrade[t].stepWinLift || []).slice(0, 3),
        } : null,
      })),
      techniciansYesterday: techs.slice(0, 14).map(t => ({
        name: t.name, trade: t.trade, jobsRan: t.jobsRan, presented: t.presented, soldJobs: t.soldJobs,
        closeRate: r2(t.closeRate), sold: t.soldAmount, avgTicket: t.avgTicket,
        fieldProMonth: fpTech(t.name) ? { score: fpTech(t.name).score, weakestSteps: fpTech(t.name).lowestSteps } : null,
      })),
      fieldProYesterday: fp ? {
        byTech: (fp.byTech || []).filter(x => inScope(x.trade)).slice(0, 12),
        notRecording: (fp.notRecording || []).filter(x => inScope(ctx.techTradeOf(x.id))).map(x => x.name),
      } : null,
    }
  }
  if (scope.kind === 'call_center') {
    const cc = f.callCenter || {}
    return {
      date: f.date, scope: 'Call center & dispatch',
      callCenter: {
        leadCalls: cc.leadCalls, totalInbound: cc.totalInbound, abandoned: cc.abandoned, bookingPct: cc.bookingPct,
        bookedByCsr: cc.bookedByCsr, avgTalkSec: cc.avgTalkSec, qaAvg: cc.qaAvg, qaCount: cc.qaCount,
        outboundDials: cc.outboundDials, voicemails: cc.voicemails,
        byRep: (cc.byRep || []).slice(0, 12), coaching: (cc.coaching || []).slice(0, 10),
      },
      unbookedLeadCalls: f.unbooked || null,
      marketing: f.marketing ? { ...f.marketing, campaigns: (f.marketing.campaigns || []).slice(0, 8) } : null,
      dispositionCorrections: f.dispositions ? { count: f.dispositions.count, booked: f.dispositions.booked, excused: f.dispositions.excused } : null,
      dispatch: f.dispatch || null,
      todayBoard: board,
      reengage: fp?.reengage || null,
    }
  }
  // company
  const techs = [...(f.technicians || [])]
  return {
    date: f.date, scope: 'Company',
    sales: f.sales ? { total: f.sales.total, count: f.sales.count, byTrade: f.sales.byTrade } : null,
    revenue: f.revenue ? { total: f.revenue.total, byTrade: f.revenue.byTrade } : null,
    closeRate: f.closeRate || null,
    priorWeekSameDay: f.priorWeek || null,
    monthToDate: { revenue: f.mtd || null, byTrade: ctx.month || null },
    callCenter: f.callCenter ? { leadCalls: f.callCenter.leadCalls, bookingPct: f.callCenter.bookingPct, qaAvg: f.callCenter.qaAvg } : null,
    leftBehind: f.leftBehind || null, reviews: f.reviews || null, memberships: f.memberships,
    topTechs: techs.slice(0, 3).map(t => ({ name: t.name, sold: t.soldAmount, closeRate: r2(t.closeRate), trade: ctx.techTradeOf(t.id) })),
    todayBoard: board,
    fieldPro: fp ? { reengage: fp.reengage, monthByTrade: fp.monthByTrade } : null,
  }
}

const FOCUS = {
  trades: 'an operations manager who runs these field departments (technicians, sales in the home, close rate, Field Pro in-home call scores). Their levers: coaching techs, ride-alongs, who runs which calls, following up quoted-not-sold work.',
  call_center: 'the call center & dispatch manager (CSRs booking inbound lead calls, outbound campaigns, QA on calls, and the dispatch board). Their levers: CSR coaching on specific call behaviors, callbacks on unbooked leads, filling open board slots, dispatch decisions.',
  company: 'the owner. Cover the whole company in a few lines: which department carried or sank yesterday, month pace, and the single lever that matters most.',
}

async function writeBrief(scope, slice, anthropicKey, attempt = 1) {
  if (!anthropicKey) throw new Error('No Anthropic key')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 90_000)
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: attempt === 1 ? 1500 : 3000,
        system: `You write the morning brief at the top of a manager's home screen in Andi, the operating system for Awesome Home Services (HVAC, plumbing, electrical, garage doors — Colorado Springs). The reader is ${FOCUS[scope.kind]}

You get yesterday's numbers for their scope as JSON (plus month-to-date and today's 3-day-board capacity where present). Rules:
- Only cite numbers present in the data; never invent, estimate or extrapolate. Put the number first.
- SHORT. The whole brief is read in five seconds on a phone. Fragments, not sentences: "HVAC sold $81k, close 49%". No filler words, no "yesterday", no hedging, no restating every field.
- Prefer what they can act on today: a tech or CSR to coach, a board gap to fill, quoted work to follow up, a channel not booking.
- Coaching is about a behavior, never the person. A sample under 3 (calls, recordings, opportunities) is thin — say so rather than conclude.
- If a number looks like a data gap rather than a business problem, say that plainly.
- Yesterday can be a weekend or a light day; say so if the volume is too small to read into.`,
        tools: [{
          name: 'submit_brief',
          description: 'Submit the morning brief',
          input_schema: {
            type: 'object',
            properties: {
              headline: { type: 'string', description: 'The one thing that matters most, number first. 12 words max.' },
              yesterday: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Up to 3 takeaways, each a fragment of 8 words max with its number, e.g. "Plumbing $88k sold, 84% close".' },
              today: { type: 'array', items: { type: 'string' }, maxItems: 2, description: 'Up to 2 actions, each 8 words max, e.g. "Call back Foust\'s two quotes ($5.9k)".' },
              coach: {
                type: 'object',
                description: 'The one person to coach first. Omit if there is no evidence.',
                properties: {
                  who: { type: 'string', description: 'First and last name.' },
                  focus: { type: 'string', description: 'The behavior or step, 5 words max, e.g. "Price presentation — 23/100".' },
                },
                required: ['who', 'focus'],
              },
            },
            required: ['headline', 'yesterday', 'today'],
          },
        }],
        tool_choice: { type: 'tool', name: 'submit_brief' },
        messages: [{ role: 'user', content: `Scope: ${slice.scope}. Yesterday = ${slice.date}.${attempt > 1 ? ' Your last answer ran too long — every string must be much shorter.' : ''}\n\n${JSON.stringify(slice).slice(0, 24000)}` }],
      }),
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d?.error?.message || `Anthropic ${r.status}`)
    let out = (d.content || []).find(c => c.type === 'tool_use')?.input
    // It sometimes nests the answer one level down ({ brief: {...} }).
    if (out && typeof out.headline !== 'string') {
      const inner = Object.values(out).find(v => v && typeof v === 'object' && !Array.isArray(v) && typeof v.headline === 'string')
      if (inner) out = inner
    }
    // The model writes fields in any order — a cut-off answer can be missing
    // the headline. Retry once, shorter.
    if (!out || typeof out.headline !== 'string') {
      if (attempt === 1) return writeBrief(scope, slice, anthropicKey, 2)
      throw new Error(`No brief returned (stop: ${d.stop_reason}, got: ${Object.keys(out || {}).join(',') || 'nothing'})`)
    }
    // The model sometimes returns a list as one string — normalize (see the
    // leadership report's aiList): never let a field render as a raw array.
    // Word caps as a backstop — the model doesn't always hold its limits.
    const words = (t, n) => { const w = String(t || '').replace(/\.$/, '').trim().split(/\s+/); return w.length > n ? w.slice(0, n).join(' ').replace(/[,;:—–-]+$/, '') + '…' : w.join(' ') }
    const list = (v, n) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\n+/) : []).map(x => words(String(x).replace(/^[-•\s]+/, ''), 11)).filter(Boolean).slice(0, n)
    const c = out.coach && typeof out.coach === 'object' && out.coach.who ? { who: words(out.coach.who, 4), focus: words(out.coach.focus, 8) } : null
    return { v: 2, headline: words(out.headline, 15), yesterday: list(out.yesterday, 3), today: list(out.today, 2), coach: c }
  } finally { clearTimeout(timer) }
}

export function createHomeBriefs(deps) {
  const { supabase } = deps
  const inflight = new Map()   // `${date}|${key}` → Promise
  const failedAt = new Map()   // `${date}|${key}` → ms — wait 10 min before retrying a failure

  async function read(dateStr, keys) {
    if (!keys.length) return {}
    const { data } = await supabase.from('home_briefs').select('scope, brief, created_at').eq('date', dateStr).in('scope', keys)
    return Object.fromEntries((data || []).filter(r => r.brief?.v === 2).map(r => [r.scope, { ...r.brief, writtenAt: r.created_at }]))
  }

  // Write one scope's brief for the facts' date if it isn't saved yet.
  function ensure(dateStr, key) {
    const id = `${dateStr}|${key}`
    if (inflight.has(id)) return inflight.get(id)
    if (Date.now() - (failedAt.get(id) || 0) < 10 * 60_000) return Promise.resolve(null)
    const p = (async () => {
      const have = await read(dateStr, [key])
      if (have[key]) return have[key]
      const scope = scopeFromKey(key)
      if (scope.kind === 'trades' && !scope.trades.length) return null
      const facts = await deps.gatherFacts(dateStr)
      const ctx = { techTradeOf: deps.techTradeOf, month: deps.monthByTrade?.() || null, coach: await deps.coaching?.(dateStr.slice(0, 7)).catch(() => null) }
      const brief = await writeBrief(scope, sliceFor(scope, facts, ctx), deps.anthropicKey)
      await supabase.from('home_briefs').upsert({ date: dateStr, scope: key, brief }, { onConflict: 'date,scope' })
      console.log(`HOME BRIEF: ${dateStr} ${key} — ${brief.headline}`)
      return brief
    })().catch(e => { failedAt.set(id, Date.now()); console.warn(`home brief ${key}:`, e.message); return null })
      .finally(() => setTimeout(() => inflight.delete(id), 60_000))
    inflight.set(id, p)
    return p
  }

  // Saved briefs for these scopes; any missing ones start writing in the
  // background (the next Home refresh picks them up).
  async function forScopes(dateStr, keys) {
    const have = await read(dateStr, keys).catch(() => ({}))
    for (const k of keys) if (!have[k]) ensure(dateStr, k)
    // A scope that just failed isn't "being written" — Home shows its normal
    // header until a brief exists.
    const recentlyFailed = (k) => Date.now() - (failedAt.get(`${dateStr}|${k}`) || 0) < 10 * 60_000
    return { date: dateStr, briefs: have, pending: keys.filter(k => !have[k] && !recentlyFailed(k)) }
  }

  // Morning warm: every scope a manager lands on, one at a time.
  async function warm(dateStr, keys) {
    for (const k of keys) await ensure(dateStr, k)
  }

  return { forScopes, ensure, warm, read }
}
