import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useIsMobile } from '../lib/useIsMobile'
import { useOpenLeads } from '../lib/useOpenLeads'
import { Segmented, eyebrow, panel } from '../components/ui'
import { Icon } from '../components/shell/icons'
import { useAuth } from '../lib/AuthContext'
import MyDayHome from '../components/home/MyDayHome'
import { briefFor, BriefBody } from '../components/home/MorningBrief'

// Home (redesign stage 2): the landing page for owners, admins and
// operations managers (CSRs and dispatchers get components/home/MyDayHome).
// Everything on it comes from /api/home, which reuses what Andi already computes — the TV month cache (sold, close,
// opportunities, clubs), the 3-day board (capacity), the CEO board's live
// tier (booking today), Field Pro, PTO and the LT agenda's coaching focus.
// Ops managers see their own trades and no call center.

const TRADE_COLOR = { HVAC: '#2F6FEB', Plumbing: '#0E8F80', Electrical: '#C98100', 'Garage Doors': '#7657F0' }
const STATUS_TONE = { Available: '#1FA36B', Inbound: '#1FA36B', 'On Call': '#F2600C', 'Wrap Up': '#7657F0', Break: '#9AA0A6', Lunch: '#9AA0A6' }
const mono = { fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', letterSpacing: '-.01em' }
// Departments table: trade · sold · close · opps/day · Field Pro · 3-day capacity.
const COLS = '150px 92px 116px 128px 64px minmax(156px, 1fr)'
const money = (n) => `$${Math.round(n || 0).toLocaleString('en-US')}`
const kMoney = (n) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e4 ? `$${Math.round(n / 1000)}k` : money(n))
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const fpTone = (v) => (v == null ? 'var(--text-muted)' : v >= 80 ? 'var(--tone-green-tx)' : v >= 50 ? 'var(--tone-amber-tx)' : 'var(--tone-red-tx)')

async function fetchHome() {
  const { data: { session } } = await sb.auth.getSession()
  const r = await fetch('/api/home', { headers: { Authorization: `Bearer ${session?.access_token}` } })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

// Cumulative sold vs the straight-line plan, with today's gap and where this
// pace ends the month.
function PaceChart({ series, plan, daysInMonth, dayOfMonth, label }) {
  const W = 420, H = 150, L = 22, R = 12, T = 18, Bm = 26
  const last = series[series.length - 1]?.v || 0
  const projected = dayOfMonth ? Math.round(last / dayOfMonth * daysInMonth) : 0
  const top = Math.max(plan, projected, last, 1) * 1.04
  const x = (d) => L + ((d - 1) / Math.max(1, daysInMonth - 1)) * (W - L - R)
  const y = (v) => T + (1 - v / top) * (H - T - Bm)
  const pts = series.map(p => `${x(p.d).toFixed(1)},${y(p.v).toFixed(1)}`)
  const planToday = plan * dayOfMonth / daysInMonth
  const gap = last - planToday
  const tx = x(dayOfMonth)
  const pctOfPlan = planToday ? last / planToday - 1 : 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Sales pace · {label}</span>
        <span style={{ ...mono, fontSize: 12, fontWeight: 600, color: gap >= 0 ? 'var(--tone-green-tx)' : 'var(--tone-red-tx)' }}>
          {pctOfPlan >= 0 ? '+' : '−'}{Math.abs(Math.round(pctOfPlan * 100))}% vs plan
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" style={{ display: 'block', maxWidth: 460 }}
        aria-label={`Sold ${kMoney(last)} by day ${dayOfMonth}, against ${kMoney(planToday)} planned to date; this pace ends the month at ${kMoney(projected)} of ${kMoney(plan)}.`}>
        {[0.5, 1].map(f => <line key={f} x1={L} x2={W - R} y1={y(plan * f)} y2={y(plan * f)} stroke="var(--border)" strokeDasharray="2 4" />)}
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="var(--border)" />
        <text x={W - R} y={y(plan) - 5} textAnchor="end" fontSize="10" fill="var(--text-muted)" style={mono}>{kMoney(plan)} plan</text>
        <line x1={x(1)} y1={y(0)} x2={x(daysInMonth)} y2={y(plan)} stroke="var(--text-muted)" strokeOpacity=".7" strokeWidth="1.5" strokeDasharray="4 4" />
        {pts.length > 1 && <path d={`M${pts.join(' L')} L${x(series[series.length - 1].d).toFixed(1)},${y(0)} L${x(series[0].d).toFixed(1)},${y(0)} Z`} fill="var(--signal)" fillOpacity=".1" />}
        {pts.length > 1 && <path d={`M${pts.join(' L')}`} fill="none" stroke="var(--signal)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
        {dayOfMonth < daysInMonth && <path d={`M${tx},${y(last)} L${x(daysInMonth)},${y(projected)}`} fill="none" stroke="var(--signal)" strokeWidth="2" strokeDasharray="3 4" strokeLinecap="round" />}
        <line x1={tx} x2={tx} y1={y(Math.max(last, planToday))} y2={y(Math.min(last, planToday))} stroke={gap >= 0 ? 'var(--tone-green-tx)' : 'var(--tone-red-tx)'} strokeWidth="2" />
        <circle cx={tx} cy={y(last)} r="4.5" fill="var(--surface)" stroke="var(--signal)" strokeWidth="2.5" />
        <text x={tx - 8} y={y(Math.max(last, planToday)) - 6} textAnchor="end" fontSize="11" fontWeight="600" fill={gap >= 0 ? 'var(--tone-green-tx)' : 'var(--tone-red-tx)'} style={mono}>
          {gap >= 0 ? '+' : '−'}{kMoney(Math.abs(gap))}
        </text>
        <text x={L} y={H - 8} fontSize="10" fill="var(--text-muted)" style={mono}>1</text>
        <text x={tx} y={H - 8} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--text-primary)" style={mono}>Today</text>
        <text x={W - R} y={H - 8} textAnchor="end" fontSize="10" fill="var(--text-muted)" style={mono}>{daysInMonth}</text>
      </svg>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-secondary)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 14, height: 3, borderRadius: 2, background: 'var(--signal)' }} />Sold</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 14, borderTop: '2px dashed var(--text-muted)' }} />Plan</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 14, borderTop: '2px dotted var(--signal)' }} />At this pace: <b style={mono}>{kMoney(projected)}</b></span>
      </div>
    </div>
  )
}

function Kpi({ label, value, delta, good, sub, bar, first, isMobile }) {
  return (
    <div style={{ padding: '15px 18px', minWidth: 0, borderLeft: first || isMobile ? 'none' : '1px solid var(--border)', borderTop: isMobile && !first ? '1px solid var(--border)' : 'none' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
        <span style={{ ...mono, fontSize: 26, fontWeight: 600, letterSpacing: '-.03em' }}>{value}</span>
        {delta && <span style={{ ...mono, fontSize: 12, fontWeight: 600, color: good ? 'var(--tone-green-tx)' : 'var(--tone-red-tx)' }}>{delta}</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
      {bar != null && (
        <div style={{ height: 4, borderRadius: 99, background: 'var(--surface-2)', marginTop: 10, overflow: 'hidden' }}>
          <div style={{ width: `${Math.max(2, Math.min(100, bar))}%`, height: '100%', borderRadius: 99, background: good ? 'var(--tone-green-tx)' : 'var(--signal)' }} />
        </div>
      )}
    </div>
  )
}

const NEED_ICON = { coaching: 'team', reengage: 'refresh', pto: 'user', capacity: 'alert', leads: 'phone' }
const NEED_TONE = { reengage: 'amber', pto: 'blue', capacity: 'red', leads: 'amber' }

function Need({ n, onGo }) {
  if (n.kind === 'coaching') {
    return (
      <article style={{ background: 'var(--rail-bg)', color: '#fff', border: '1px solid var(--rail-line)', borderRadius: 16, padding: '15px 16px', display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: '#F2994A' }}>Coaching focus · biggest upside</div>
        <div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.35 }}>{n.title}</div>
        {n.sub && <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--rail-text)' }}>{n.sub}</div>}
        {n.detail && <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--rail-muted)' }}>{n.detail}</div>}
        <a href={n.to} onClick={(e) => { e.preventDefault(); onGo(n.to) }} style={{ alignSelf: 'flex-start', marginTop: 2, fontSize: 12.5, fontWeight: 700, color: '#F2994A', textDecoration: 'none' }}>Open the plan →</a>
      </article>
    )
  }
  const tone = NEED_TONE[n.kind] || 'gray'
  return (
    <a href={n.to} onClick={(e) => { e.preventDefault(); onGo(n.to) }} className="lift-hover"
      style={{ ...panel, borderRadius: 16, padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center', color: 'inherit', textDecoration: 'none' }}>
      <span style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `var(--tone-${tone}-bg)`, color: `var(--tone-${tone}-tx)` }}>
        <Icon name={NEED_ICON[n.kind] || 'arrowRight'} size={17} />
      </span>
      <span style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{n.title}</span>
        {n.sub && <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.sub}</span>}
      </span>
      <Icon name="arrowRight" size={15} style={{ color: 'var(--text-muted)' }} />
    </a>
  )
}

const since = (iso) => {
  if (!iso) return ''
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
  return s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// Owners, admins and operations managers get the business Home below; CSRs
// and dispatchers get their own day (components/home/MyDayHome). Call center
// managers — and an admin or dispatcher with profiles.home_view =
// 'dispatch_manager' (Brittany) — get the call center & dispatch manager view.
export default function HomePage() {
  const { profile, isAdmin, isOpsManager, isDispatcher, isCallCenterManager } = useAuth()
  if (isCallCenterManager || ((isAdmin || isDispatcher) && profile?.home_view === 'dispatch_manager')) return <MyDayHome dispatcher manager />
  if (isAdmin || isOpsManager) return <BusinessHome />
  return <MyDayHome dispatcher={isDispatcher} />
}

function BusinessHome() {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const openLeads = useOpenLeads()
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [scope, setScope] = useState('all')
  const [, tick] = useState(0)
  // "Needs you" sits beside the departments only when there's room for both.
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1380px)').matches)
  useEffect(() => {
    const mq = window.matchMedia?.('(min-width: 1380px)')
    if (!mq) return
    const on = () => setWide(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])

  useEffect(() => {
    let dead = false
    const load = () => fetchHome().then(d => { if (!dead) { setData(d); setErr('') } }).catch(e => { if (!dead) setErr(e.message) })
    load()
    const t = setInterval(load, 120_000)
    const s = setInterval(() => tick(v => v + 1), 15_000)   // floor timers
    return () => { dead = true; clearInterval(t); clearInterval(s) }
  }, [])
  useEffect(() => { if (data && data.trades.length === 1) setScope(data.trades[0]) }, [data?.trades?.length])   // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(() => {
    if (!data) return null
    const rows = scope === 'all' ? data.tradeRows : data.tradeRows.filter(r => r.trade === scope)
    const sold = rows.reduce((a, r) => a + r.sold, 0)
    const plan = scope === 'all' ? data.plan.month : (data.plan.byTrade[scope] || 0)
    const opps = rows.reduce((a, r) => a + r.opps, 0), closed = rows.reduce((a, r) => a + r.closed, 0)
    const oppsGoal = rows.reduce((a, r) => a + (r.oppsGoal || 0), 0)
    const clubs = rows.reduce((a, r) => a + r.clubs, 0)
    const series = data.pace.map(p => ({ d: p.day, v: scope === 'all' ? p.total : (p.byTrade[scope] || 0) }))
    const pacedPlan = plan * data.dayOfMonth / data.daysInMonth
    return { rows, sold, plan, pacedPlan, closeRate: opps ? closed / opps : null, opps, closed, oppsPerDay: data.effDays ? opps / data.effDays : null, oppsGoal, clubs, series }
  }, [data, scope])

  const needs = useMemo(() => {
    const list = [...(data?.needs || [])]
    if (openLeads > 0 && data?.role !== 'ops_manager') list.splice(list[0]?.kind === 'coaching' ? 1 : 0, 0, { kind: 'leads', title: `${openLeads} paid lead${openLeads === 1 ? '' : 's'} waiting`, sub: 'First to open it claims it', to: '/' })
    return list
  }, [data, openLeads])

  if (err && !data) return <div style={{ padding: 40, color: 'var(--danger)', fontSize: 13 }}>Couldn’t load Home: {err}</div>
  if (!data || !view) {
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? 12 : '22px 26px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="skel" style={{ height: 200, borderRadius: 18 }} />
        <div className="skel" style={{ height: 104, borderRadius: 18 }} />
        <div className="skel" style={{ height: 320, borderRadius: 18 }} />
      </div>
    )
  }

  const scopes = data.trades.length > 1 ? [['all', data.allTrades ? 'Company' : 'Both'], ...data.trades.map(t => [t, t === 'Garage Doors' ? 'Garage' : t])] : null
  const updated = new Date(data.asOf).toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' })
  const paceGood = view.sold >= view.pacedPlan
  const showCallCenter = !!data.floor && scope === 'all'
  const leverTo = data.isOwner ? '/leadership' : '/team'
  // Morning brief for what's on screen: the company (owner, all trades), the
  // ops manager's set, or the one trade picked in the scope switch.
  const briefKey = scope === 'all' ? (data.allTrades ? 'company' : `trades:${[...data.trades].sort().join('+')}`) : `trades:${scope}`
  const { brief: morningBrief, pending: briefPending } = briefFor(data.morning, briefKey)
  const inScope = (t) => (scope === 'all' ? data.trades.includes(t) : t === scope)
  const coachRows = (data.coach || []).filter(c => inScope(c.trade))
  const glanceTrades = (scope === 'all' ? data.trades : [scope]).filter(t => data.glance?.[t]?.count)
  const TV_SLUG = { HVAC: 'hvac', Plumbing: 'plumbing', Electrical: 'electrical', 'Garage Doors': 'garage' }
  const co = data.company
  const kpis = [
    { label: 'Sold this month', value: kMoney(view.sold), delta: view.plan ? `${Math.round(view.sold / view.plan * 100)}%` : null, good: paceGood, sub: `of the ${kMoney(view.plan)} plan · day ${data.dayOfMonth} of ${data.daysInMonth}`, bar: view.plan ? view.sold / view.plan * 100 : null },
    { label: 'Close rate', value: pct(view.closeRate), delta: view.closeRate != null ? `${view.closeRate >= data.goals.close ? '+' : '−'}${Math.abs(Math.round((view.closeRate - data.goals.close) * 100))} pts` : null, good: (view.closeRate ?? 0) >= data.goals.close, sub: `${view.closed} of ${view.opps} opportunities · goal ${pct(data.goals.close)}`, bar: view.closeRate != null ? view.closeRate * 100 : null },
    showCallCenter && data.floor.booking?.pct != null
      ? { label: 'Booking rate · today', value: `${data.floor.booking.pct}%`, delta: null, good: data.floor.booking.pct / 100 >= data.goals.booking, sub: `${data.floor.booking.booked} of ${data.floor.booking.leadCalls} lead calls · goal ${pct(data.goals.booking)}`, bar: data.floor.booking.pct }
      : null,
    { label: 'Opportunities per day', value: view.oppsPerDay == null ? '—' : view.oppsPerDay.toFixed(1), delta: view.oppsGoal && view.oppsPerDay != null ? `${view.oppsPerDay >= view.oppsGoal ? '+' : '−'}${Math.abs(view.oppsPerDay - view.oppsGoal).toFixed(1)}` : null, good: view.oppsPerDay >= view.oppsGoal, sub: `this month · goal ${view.oppsGoal || '—'}`, bar: view.oppsGoal ? view.oppsPerDay / view.oppsGoal * 100 : null },
    { label: 'Clubs sold', value: String(view.clubs), delta: null, good: true, sub: 'service techs · this month', bar: null },
  ].filter(Boolean)

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
      <div style={{ padding: isMobile ? '12px 12px 24px' : '20px 26px 96px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1480 }}>

        {scopes && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ overflowX: 'auto', maxWidth: '100%' }}><Segmented value={scope} onChange={setScope} options={scopes} /></div>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: isMobile ? 0 : 'auto' }}>Updated {updated}</span>
          </div>
        )}

        {/* Brief + pace */}
        <section style={{ ...panel, borderRadius: 18, overflow: 'hidden', display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(360px, 460px)' }}>
          <div style={{ padding: isMobile ? '18px 18px' : '22px 26px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ ...eyebrow, display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--signal)' }} />
              {morningBrief
                ? <>Morning brief · {new Date(`${data.morning.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}’s results</>
                : <>{new Date(`${data.today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} brief · {updated}</>}
            </div>
            <h2 className="disp" style={{ margin: 0, fontSize: isMobile ? 24 : 30, lineHeight: 1.14, fontWeight: 700, letterSpacing: '-.025em', maxWidth: 680, textWrap: 'balance' }}>
              {morningBrief ? morningBrief.headline : scope === 'all' ? data.brief.headline : `${scope} is ${kMoney(Math.abs(view.sold - view.pacedPlan))} ${view.sold >= view.pacedPlan ? 'ahead of' : 'behind'} its plan for ${data.monthName}.`}
            </h2>
            {morningBrief ? <BriefBody brief={morningBrief} coachTo={leverTo} onGo={navigate} isMobile={isMobile} /> : briefPending && (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Writing this morning’s brief from yesterday’s numbers…</div>
            )}
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: 'var(--text-secondary)', maxWidth: 620, display: morningBrief ? 'none' : undefined }}>
              {scope === 'all' ? data.brief.body : (() => {
                const r = view.rows[0]
                return r ? `Sold ${kMoney(r.sold)} of ${kMoney(r.plan)}. Closing ${pct(r.closeRate)} of ${r.opps} opportunities against ${pct(r.closeGoal)}${r.fieldPro?.lowestStep ? `; the lowest Field Pro step is ${r.fieldPro.lowestStep.step} (${r.fieldPro.lowestStep.score}/100)` : ''}.` : ''
              })()}
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
              {data.brief.lever && (
                <a href={leverTo} onClick={(e) => { e.preventDefault(); navigate(leverTo) }} className="btn primary" style={{ borderRadius: 99, height: 38, padding: '0 16px', fontSize: 13 }}>
                  Open the coaching plan <Icon name="arrowRight" size={14} />
                </a>
              )}
              <a href="/callboard" onClick={(e) => { e.preventDefault(); navigate('/callboard') }} className="btn" style={{ borderRadius: 99, height: 38, padding: '0 16px', fontSize: 13 }}>3-day board</a>
            </div>
          </div>
          <div style={{ background: 'var(--surface-2)', borderLeft: isMobile ? 'none' : '1px solid var(--border)', borderTop: isMobile ? '1px solid var(--border)' : 'none', padding: isMobile ? '16px 18px' : '18px 22px' }}>
            <PaceChart series={view.series} plan={view.plan} daysInMonth={data.daysInMonth} dayOfMonth={data.dayOfMonth} label={scope === 'all' ? data.monthName : scope} />
          </div>
        </section>

        {/* Key numbers */}
        <section aria-label="Month to date" style={{ ...panel, borderRadius: 18, display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : `repeat(${kpis.length}, minmax(0, 1fr))` }}>
          {kpis.map((k, i) => <Kpi key={k.label} {...k} first={i === 0} isMobile={isMobile} />)}
        </section>

        {/* The company, for context — ops managers see their own trades above. */}
        {!data.allTrades && co && (
          <section aria-label="Company" style={{ ...panel, borderRadius: 18, padding: isMobile ? '12px 16px' : '12px 20px', display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 22, flexWrap: 'wrap' }}>
            <span style={{ ...eyebrow }}>Company · {data.monthName}</span>
            <span style={{ fontSize: 13.5 }}>
              <span style={{ ...mono, fontWeight: 600 }}>{kMoney(co.sold)}</span> sold of {kMoney(co.plan)}
              <span style={{ ...mono, marginLeft: 6, fontWeight: 600, color: co.sold >= co.pacedPlan ? 'var(--tone-green-tx)' : 'var(--tone-red-tx)' }}>
                {co.sold >= co.pacedPlan ? '+' : '−'}{kMoney(Math.abs(co.sold - co.pacedPlan))} vs pace
              </span>
            </span>
            <span style={{ fontSize: 13.5 }}>
              Close <span style={{ ...mono, fontWeight: 600, color: (co.closeRate ?? 0) >= co.closeGoal ? 'var(--tone-green-tx)' : 'var(--tone-red-tx)' }}>{pct(co.closeRate)}</span>
              <span style={{ color: 'var(--text-muted)' }}> · goal {pct(co.closeGoal)}</span>
            </span>
            {co.oppsPerDay != null && (
              <span style={{ fontSize: 13.5 }}>
                <span style={{ ...mono, fontWeight: 600 }}>{co.oppsPerDay.toFixed(1)}</span> opps/day<span style={{ color: 'var(--text-muted)' }}>{co.oppsGoal ? ` · goal ${co.oppsGoal}` : ''}</span>
              </span>
            )}
          </section>
        )}

        {/* Departments + Needs you */}
        <div style={{ display: 'grid', gridTemplateColumns: wide && !isMobile ? 'minmax(0, 1fr) 320px' : 'minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          <section style={{ ...panel, borderRadius: 18, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '15px 20px 11px', flexWrap: 'wrap' }}>
              <h3 className="disp" style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{view.rows.length > 1 ? 'Departments' : view.rows[0]?.trade}</h3>
              <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>month to date · capacity from the 3-day board</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 720 }}>
                <div className="mgrid" style={{ display: 'grid', gridTemplateColumns: COLS, gap: '0 12px', padding: '8px 18px', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', ...eyebrow, fontSize: 10.5 }}>
                  <span>Trade</span><span style={{ textAlign: 'right' }}>Sold</span><span>Close rate</span><span>Opps / day</span><span>Field Pro</span>
                  <span>Booked · {(view.rows[0]?.capacity || []).map(c => c.label).join(' / ') || 'next 3 days'}</span>
                </div>
                {view.rows.map(r => {
                  const under = r.oppsGoal && r.oppsPerDay != null && r.oppsPerDay < r.oppsGoal
                  return (
                    <div key={r.trade} className="mgrid" style={{ display: 'grid', gridTemplateColumns: COLS, gap: '0 12px', alignItems: 'center', padding: '0 18px', minHeight: 58, borderBottom: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ width: 9, height: 28, borderRadius: 4, background: TRADE_COLOR[r.trade] }} />
                        <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
                          <span style={{ fontSize: 14, fontWeight: 600 }}>{r.trade}</span>
                          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{r.techs} service tech{r.techs === 1 ? '' : 's'}</span>
                        </span>
                      </div>
                      <span style={{ ...mono, textAlign: 'right', fontSize: 14, fontWeight: 600 }}>{money(r.sold)}</span>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        <span style={{ ...mono, fontSize: 13.5, fontWeight: 600, color: r.closeRate != null && r.closeRate < r.closeGoal ? 'var(--tone-red-tx)' : 'var(--text-primary)' }}>{pct(r.closeRate)} <span style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--text-muted)' }}>{r.closed}/{r.opps}</span></span>
                        <div style={{ height: 4, borderRadius: 99, background: 'var(--surface-2)', position: 'relative' }}>
                          <div style={{ width: `${Math.min(100, (r.closeRate || 0) * 100)}%`, height: '100%', borderRadius: 99, background: TRADE_COLOR[r.trade] }} />
                          <div title={`Goal ${pct(r.closeGoal)}`} style={{ position: 'absolute', left: `${r.closeGoal * 100}%`, top: -3, width: 2, height: 10, borderRadius: 1, background: 'var(--text-primary)' }} />
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ ...mono, fontSize: 13.5, fontWeight: 600 }}>{r.oppsPerDay == null ? '—' : r.oppsPerDay.toFixed(1)}</span>
                        <span style={{ ...mono, fontSize: 12, color: 'var(--text-muted)' }}>/ {r.oppsGoal || '—'}</span>
                        {r.oppsGoal ? <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 99, padding: '2px 8px', background: `var(--tone-${under ? 'amber' : 'green'}-bg)`, color: `var(--tone-${under ? 'amber' : 'green'}-tx)` }}>{under ? 'short' : 'on goal'}</span> : null}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }} title={r.fieldPro?.lowestStep ? `Lowest step: ${r.fieldPro.lowestStep.step} (${r.fieldPro.lowestStep.score}/100)` : undefined}>
                        <span style={{ ...mono, fontSize: 15, fontWeight: 600, color: fpTone(r.fieldPro?.score) }}>{r.fieldPro?.score ?? '—'}</span>
                        {r.fieldPro && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>/100</span>}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }} className="mgrid">
                        {(r.capacity.length ? r.capacity : [null, null, null]).slice(0, 3).map((c, i) => {
                          const p = c?.pct ?? null
                          const fill = p == null ? 'transparent' : p >= 90 ? 'var(--tone-green-bd)' : p >= 70 ? 'var(--tone-amber-bd)' : 'var(--tone-red-bd)'
                          return (
                            <div key={i} title={c ? `${c.label}: ${c.calls} booked of ${Math.round(c.capacity)}${c.needed ? ` · ${c.needed} needed` : ''}` : 'Loading'}
                              style={{ height: 24, borderRadius: 7, background: 'var(--surface-2)', position: 'relative', overflow: 'hidden' }}>
                              <div style={{ position: 'absolute', inset: 0, width: `${Math.min(100, p || 0)}%`, background: fill }} />
                              <span style={{ ...mono, position: 'absolute', left: 7, top: 4, fontSize: 11, fontWeight: 600 }}>{p == null ? '—' : `${p}%`}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '11px 20px', fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 2, height: 10, borderRadius: 1, background: 'var(--text-primary)' }} />close-rate goal</span>
              <span>Field Pro = Siro in-home call score</span>
              <span style={{ ...mono, marginLeft: 'auto' }}>{money(view.sold)} · {view.closed} of {view.opps} closed</span>
            </div>
          </section>

          <section aria-label="Needs you" style={{ display: 'grid', gridTemplateColumns: wide || isMobile ? 'minmax(0, 1fr)' : 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10, alignContent: 'start', alignItems: 'start' }}>
            <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '0 4px' }}>
              <h3 className="disp" style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Needs you</h3>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{needs.length ? `${needs.length} item${needs.length === 1 ? '' : 's'}` : ''}</span>
            </div>
            {needs.length ? needs.map((n, i) => <Need key={i} n={n} onGo={navigate} />) : (
              <div style={{ ...panel, borderRadius: 16, padding: '18px 16px', fontSize: 13, color: 'var(--text-muted)' }}>Nothing waiting on you right now.</div>
            )}
          </section>
        </div>

        {/* Coach this week + the techs at a glance */}
        {(coachRows.length > 0 || glanceTrades.length > 0) && (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
            <section style={{ ...panel, borderRadius: 18, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <h3 className="disp" style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Coach this week</h3>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>below goal close, biggest gap first</span>
                <a href="/team" onClick={(e) => { e.preventDefault(); navigate('/team') }} style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}>Coaching & evals →</a>
              </div>
              {coachRows.length ? coachRows.map((c, i) => (
                <a key={c.id} href="/team" onClick={(e) => { e.preventDefault(); navigate('/team') }} className="lift-hover"
                  style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '10px 12px', borderRadius: 12, border: '1px solid var(--border)', color: 'inherit', textDecoration: 'none' }}>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{c.name}</span>
                    {data.trades.length > 1 && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{c.trade}</span>}
                    <span style={{ ...mono, marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: 'var(--tone-red-tx)' }}>≈ {kMoney(c.gap)} left</span>
                  </span>
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                    Closing <b style={{ ...mono, fontWeight: 600 }}>{pct(c.closeRate)}</b> of {c.opps} opportunities vs {pct(c.closeGoal)} · avg ticket {kMoney(c.avgTicket)}
                  </span>
                  {(c.steps?.length > 0 || c.fieldPro != null) && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      Field Pro {c.fieldPro != null ? <b style={{ ...mono, fontWeight: 600, color: fpTone(c.fieldPro) }}>{c.fieldPro}</b> : '—'}
                      {c.steps?.length ? ` · weakest: ${c.steps.map(s => `${s.step} ${s.score}`).join(', ')}` : c.fieldProCalls === 0 ? ' · no recordings this month' : ''}
                    </span>
                  )}
                </a>
              )) : <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Every tech with 5+ opportunities is at or above their close goal this month.</div>}
            </section>

            <section style={{ ...panel, borderRadius: 18, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <h3 className="disp" style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Your techs</h3>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>this month · top 3 and the lowest</span>
              </div>
              {glanceTrades.map(t => {
                const g = data.glance[t]
                const row = (x, rank, low) => (
                  <div key={x.id} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) 58px 52px 44px', gap: 8, alignItems: 'center', fontSize: 13, padding: '5px 0', borderTop: low ? '1px dashed var(--border)' : 'none', marginTop: low ? 4 : 0 }}>
                    <span style={{ ...mono, fontSize: 11.5, color: low ? 'var(--tone-red-tx)' : 'var(--text-muted)' }}>{low ? 'low' : rank}</span>
                    <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.name}</span>
                    <span style={{ ...mono, textAlign: 'right' }}>{kMoney(x.sold)}</span>
                    <span style={{ ...mono, textAlign: 'right', color: 'var(--text-secondary)' }}>{pct(x.closeRate)}</span>
                    <span style={{ ...mono, textAlign: 'right', color: fpTone(x.fieldPro) }}>{x.fieldPro ?? '—'}</span>
                  </div>
                )
                return (
                  <div key={t}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{t}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{g.count} techs · sold · close · Field Pro</span>
                      <a href={`/tv/${TV_SLUG[t]}`} onClick={(e) => { e.preventDefault(); navigate(`/tv/${TV_SLUG[t]}`) }} style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}>TV →</a>
                    </div>
                    {g.top.map((x, i) => row(x, i + 1, false))}
                    {g.low && row(g.low, null, true)}
                  </div>
                )
              })}
              <a href="/team" onClick={(e) => { e.preventDefault(); navigate('/team') }} style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}>All scorecards →</a>
            </section>
          </div>
        )}

        {/* Live floor */}
        {data.floor && (
          <section aria-label="Live floor" style={{ ...panel, borderRadius: 18, padding: isMobile ? '14px 16px' : '14px 20px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 150 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 700, color: 'var(--tone-green-tx)' }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: '#1FA36B', boxShadow: '0 0 0 3px rgba(31,163,107,.18)' }} />Live floor
              </span>
              <span style={{ ...mono, fontSize: 14, fontWeight: 600 }}>{data.floor.queued} waiting{data.floor.queued ? ` · ${Math.floor(data.floor.longestWaitSec / 60)}:${String(data.floor.longestWaitSec % 60).padStart(2, '0')} longest` : ''}</span>
              {data.floor.booking && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Booked today: {data.floor.booking.booked} of {data.floor.booking.leadCalls}</span>}
            </div>
            {!isMobile && <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)' }} />}
            <div style={{ display: 'flex', gap: 8, flex: 1, minWidth: 0, overflowX: 'auto', paddingBottom: 2 }}>
              {data.floor.agents.length ? data.floor.agents.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 12px 5px 5px', borderRadius: 99, background: 'var(--surface-2)', border: '1px solid var(--border)', flexShrink: 0 }}>
                  <span style={{ position: 'relative', width: 28, height: 28, borderRadius: 99, background: 'var(--border)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {String(a.name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()}
                    <span style={{ position: 'absolute', right: -1, bottom: -1, width: 9, height: 9, borderRadius: 99, background: STATUS_TONE[a.status] || '#9AA0A6', border: '2px solid var(--surface-2)' }} />
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{String(a.name || '').split(/\s+/)[0]}</span>
                    <span style={{ ...mono, fontSize: 11.5, color: a.status === 'On Call' ? 'var(--accent)' : 'var(--text-muted)' }}>{a.status}{a.since ? ` · ${since(a.since)}` : ''}</span>
                  </span>
                </div>
              )) : <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nobody’s signed in on the phones.</span>}
            </div>
            <a href="/warroom" onClick={(e) => { e.preventDefault(); navigate('/warroom') }} className="btn" style={{ borderRadius: 99, flexShrink: 0 }}>
              <Icon name="tv" size={14} /> Put on TV
            </a>
          </section>
        )}
      </div>
    </div>
  )
}
