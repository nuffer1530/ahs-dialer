import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { sb } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthContext'
import { useData } from '../../lib/DataContext'
import { useIsMobile } from '../../lib/useIsMobile'
import { useOpenLeads } from '../../lib/useOpenLeads'
import { isDone, isCallbackDueToday } from '../../lib/utils'
import { panel, eyebrow, mono, ToneChip, Ring } from '../ui'
import { Icon } from '../shell/icons'
import { scoreMonth, rateKpi, fmtKpi, LevelChip, LevelPips, LEVELS } from '../ScorecardsPanel'

// Home for the phones and the board (Sep 2026). CSRs get "your day": shift,
// today's numbers, where the 3-day board needs bookings, their queue, the
// month's scorecard, latest call review and what's coming up. Dispatchers get
// the Command Center's headline (decisions, revenue, coverage) plus their own
// shift. Owners, admins and ops managers keep the business Home.
// Data: /api/home/me (+ /api/dispatch/center for dispatchers).

const money = (n) => `$${Math.round(n || 0).toLocaleString('en-US')}`
const cents = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`)
const DAY = ['Today', 'Tomorrow']
const KIND = { partial: ['Finish move', 'red'], place: ['Place', 'amber'], reassign: ['Reassign', 'red'], swap: ['Swap', 'amber'], techout: ['Tech out', 'red'], late: ['Running late', 'red'] }
const STATUS_TONE = { under: 'red', warn: 'amber', good: 'green', none: 'gray' }

const t12 = (t) => {
  if (!t) return ''
  const [h, m] = String(t).split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}
const weekday = (ymd, opts = { weekday: 'long' }) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' }) : '')
const dayLabel = (i, ymd) => DAY[i] || weekday(ymd)
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' }) : '')
const mmss = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`)
const firstName = (n) => String(n || '').split(/[\s@]/)[0]
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t)
const greeting = () => {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', hour12: false }).format(new Date()))
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

async function getJSON(url) {
  const { data: { session } } = await sb.auth.getSession()
  const r = await fetch(url, { headers: { Authorization: `Bearer ${session?.access_token}` } })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

// One zone of the "today" strip — same look as the business Home's.
function Kpi({ label, value, sub, tone, first, isMobile }) {
  return (
    <div style={{ padding: '15px 18px', minWidth: 0, borderLeft: first || isMobile ? 'none' : '1px solid var(--border)', borderTop: isMobile && !first ? '1px solid var(--border)' : 'none' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ ...mono, fontSize: 26, fontWeight: 600, letterSpacing: '-.03em', marginTop: 6, color: tone ? `var(--tone-${tone}-tx)` : 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
    </div>
  )
}

function Section({ title, sub, link, onGo, children, style }) {
  return (
    <section style={{ ...panel, borderRadius: 18, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, ...style }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h3 className="disp" style={{ margin: 0, fontSize: 17, fontWeight: 700, letterSpacing: '-.01em' }}>{title}</h3>
        {sub && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sub}</span>}
        {link && (
          <a href={link[1]} onClick={(e) => { e.preventDefault(); onGo(link[1]) }}
            style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none', whiteSpace: 'nowrap' }}>{link[0]} →</a>
        )}
      </div>
      {children}
    </section>
  )
}

const Empty = ({ children }) => <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>{children}</div>

// Where the board needs bookings, one row per day with a chip per trade.
function BoardNeeds({ board }) {
  if (!board) return <Empty>The 3-day board isn’t loaded yet.</Empty>
  const byDay = [0, 1, 2].map(i => board.needs.filter(n => n.day === i))
  if (!board.needs.length) return <Empty>Every trade is at target for the next three days.</Empty>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {byDay.map((items, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr)', gap: 10, alignItems: 'center' }}>
          <div style={{ lineHeight: 1.2 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{dayLabel(i, board.dates[i])}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{weekday(board.dates[i], { month: 'short', day: 'numeric' })}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {items.length ? items.map(n => n.oppWatch ? (
              <ToneChip key={n.trade} tone="purple" title="Board is full — keep booking strong calls, dispatch will make room">{n.trade} · full, book strong calls</ToneChip>
            ) : (
              <ToneChip key={n.trade} tone={STATUS_TONE[n.status] || 'amber'} title={`${n.pct}% booked`}>{n.trade} · {n.needed} needed</ToneChip>
            )) : <span style={{ fontSize: 12.5, color: 'var(--tone-green-tx)', fontWeight: 600 }}>All at target</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function ComingUp({ me }) {
  const rows = [
    ...(me.upcoming || []).map(s => ({ key: `s${s.date}`, date: s.date, text: s.start ? `${t12(s.start)} – ${t12(s.end)}` : (s.dayType || 'Scheduled').replace(/_/g, ' '), chip: null })),
    ...(me.pto || []).map(p => ({ key: `p${p.date}${p.kind}`, date: p.date, text: `${p.kind ? cap(p.kind.replace(/_/g, ' ')) : 'Time off'}${p.end_date && p.end_date !== p.date ? ` through ${weekday(p.end_date, { month: 'short', day: 'numeric' })}` : ''}`, chip: p.status })),
  ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6)
  if (!rows.length) return <Empty>No shifts or time off on the books for the next week.</Empty>
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map((r, i) => (
        <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 13 }}>
          <span style={{ width: 92, flexShrink: 0, fontWeight: 600 }}>{weekday(r.date, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
          <span style={{ ...(r.chip ? {} : mono), flex: 1, minWidth: 0 }}>{r.text}</span>
          {r.chip && <ToneChip small tone={r.chip === 'approved' ? 'green' : r.chip === 'denied' ? 'red' : 'amber'}>{r.chip}</ToneChip>}
        </div>
      ))}
    </div>
  )
}

// The Command Center's queue, top few cards; any card opens the Command Center.
function NextUp({ center, go, max = 4 }) {
  const cards = center?.queue?.cards || []
  if (!center) return <div className="skel" style={{ height: 120, borderRadius: 12 }} />
  if (!cards.length) return <Empty>Nothing needs a decision right now. New bookings and late techs show up here as they happen.</Empty>
  return cards.slice(0, max).map((c, i) => {
    const k = KIND[c.kind] || [c.kind, 'gray']
    return (
      <a key={c.key || i} href="/dispatch" onClick={(e) => { e.preventDefault(); go('/dispatch') }} className="lift-hover"
        style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px', borderRadius: 12, border: '1px solid var(--border)', color: 'inherit', textDecoration: 'none' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
          <ToneChip small tone={k[1]}>{k[0]}</ToneChip>
          {c.actBy && <span style={{ ...mono, fontWeight: 600, color: 'var(--text-secondary)' }}>act by {clock(c.actBy)}</span>}
          {c.upside > 0 && <span style={{ ...mono, marginLeft: 'auto', fontWeight: 600, color: 'var(--tone-green-tx)' }}>+{money(c.upside)}</span>}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{c.title}</span>
        {c.why && <span style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>{c.why}</span>}
      </a>
    )
  })
}

// 3-day coverage: booked % of capacity per trade, toned like the board.
function Coverage({ cov }) {
  if (!cov?.board) return <div className="skel" style={{ height: 120, borderRadius: 12 }} />
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) repeat(3, 64px)', gap: '6px 8px', alignItems: 'center', fontSize: 13 }}>
      <span />
      {[0, 1, 2].map(i => <span key={i} style={{ fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center' }}>{i < 2 ? DAY[i] : weekday(cov.dates?.[2], { weekday: 'short' })}</span>)}
      {cov.board.map(r => [
        <span key={r.trade} style={{ fontWeight: 600 }}>{r.trade}</span>,
        ...r.days.slice(0, 3).map((d, i) => (
          <span key={r.trade + i} style={{ textAlign: 'center' }}>
            <ToneChip small tone={d.oppWatch ? 'purple' : STATUS_TONE[d.status] || 'gray'} title={d.needed > 0 ? `${d.needed} calls needed` : 'At target'}>{d.pct}%</ToneChip>
          </span>
        )),
      ])}
    </div>
  )
}

const AGENT_DOT = { Available: '#1FA36B', Inbound: '#1FA36B', 'On Call': '#F2600C', 'Wrap Up': '#7657F0', Break: '#9AA0A6', Lunch: '#9AA0A6' }
const since = (iso) => {
  if (!iso) return ''
  const sec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
  return sec < 3600 ? `${Math.floor(sec / 60)}m` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

// Every CSR's day from ServiceTitan lead calls, with their live status.
function FloorTable({ reps, goal, thr, isMobile }) {
  if (!reps?.length) return <Empty>No CSRs yet.</Empty>
  const kpi = { id: 'booking_pct', unit: '%' }
  const cols = isMobile ? 'minmax(0, 1fr) 64px 64px' : 'minmax(0, 1fr) 84px 92px 76px'
  const head = { fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', textAlign: 'right', paddingBottom: 2 }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', fontSize: 13 }}>
      <span style={{ ...head, textAlign: 'left' }}>CSR</span>
      <span style={head}>Booked</span>
      <span style={head}>Booking</span>
      {!isMobile && <span style={head}>Outbound</span>}
      {reps.map(r => {
        const off = !r.status || r.status === 'Offline'
        const lv = r.pct != null ? rateKpi(kpi, r.pct, thr || { exceeds: 90, meets: goal, improvement: 75 }) : null
        // No column gap — the row rule runs unbroken; numbers keep their room via padding.
        const cell = { padding: '8px 0 8px 10px', borderTop: '1px solid var(--border)', alignSelf: 'stretch', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }
        return [
          <span key={r.id + 'n'} style={{ ...cell, paddingLeft: 0, justifyContent: 'flex-start', gap: 9, minWidth: 0, opacity: off ? 0.55 : 1 }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, flexShrink: 0, background: AGENT_DOT[r.status] || 'var(--border-strong)' }} />
            <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
            <span style={{ fontSize: 11.5, color: r.status === 'On Call' ? 'var(--accent)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>{off ? 'offline' : `${r.status}${r.since ? ` · ${since(r.since)}` : ''}`}</span>
          </span>,
          <span key={r.id + 'b'} style={{ ...cell, ...mono, textAlign: 'right' }}>{r.leadCalls ? `${r.booked}/${r.leadCalls}` : '—'}</span>,
          <span key={r.id + 'p'} style={{ ...cell, textAlign: 'right' }}>
            {r.pct != null ? <ToneChip small tone={lv ? LEVELS[lv].tone : 'gray'}>{r.pct}%</ToneChip> : <span style={{ color: 'var(--text-muted)' }}>{r.linked ? '—' : 'not linked'}</span>}
          </span>,
          !isMobile && <span key={r.id + 'o'} style={{ ...cell, ...mono, textAlign: 'right' }}>{r.outbounds ?? '—'}</span>,
        ]
      })}
    </div>
  )
}

export default function MyDayHome({ dispatcher, manager }) {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const { profile } = useAuth()
  const { contacts = [], campaigns = [] } = useData() || {}
  const openLeads = useOpenLeads()
  const [me, setMe] = useState(null)
  const [center, setCenter] = useState(null)
  const [err, setErr] = useState('')
  const [granted, setGranted] = useState([])   // campaign ids this rep may dial (csr_campaigns), in priority order

  useEffect(() => {
    if (!profile?.id) return
    sb.from('csr_campaigns').select('campaign_id, priority').eq('profile_id', profile.id).eq('active', true)
      .then(({ data }) => setGranted((data || []).sort((a, b) => a.priority - b.priority).map(r => r.campaign_id)))
  }, [profile?.id])

  useEffect(() => {
    let dead = false
    const load = () => {
      getJSON(`/api/home/me${manager ? '?manager=1' : ''}`).then(d => { if (!dead) { setMe(d); setErr('') } }).catch(e => { if (!dead) setErr(e.message) })
      if (dispatcher) getJSON('/api/dispatch/center?day=0').then(d => { if (!dead) setCenter(d) }).catch(() => {})
    }
    load()
    const t = setInterval(load, manager ? 60_000 : dispatcher ? 90_000 : 120_000)
    return () => { dead = true; clearInterval(t) }
  }, [dispatcher, manager])

  // The rep's queue, from the contacts already in memory. Campaigns = the
  // ones granted to them (csr_campaigns), marked on when switched on in the
  // dialer's queue selector.
  const queue = useMemo(() => {
    const mine = profile?.name || profile?.email
    const on = Array.isArray(profile?.active_campaign_ids) ? profile.active_campaign_ids : []
    const camps = granted.map(id => {
      const c = campaigns.find(x => x.id === id)
      const left = contacts.filter(x => x.campaign_id === id && !isDone(x) && (!x.claimed_by || x.claimed_by === mine)).length
      return c ? { id, name: c.name, left, on: on.includes(id) } : null
    }).filter(Boolean)
    const callbacks = contacts.filter(x => x.claimed_by === mine && !isDone(x) && isCallbackDueToday(x)).length
    return { camps, callbacks }
  }, [contacts, campaigns, profile, granted])

  if (err && !me) return <div style={{ padding: 40, color: 'var(--danger)', fontSize: 13 }}>Couldn’t load Home: {err}</div>
  if (!me) {
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? 12 : '22px 26px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="skel" style={{ height: 180, borderRadius: 18 }} />
        <div className="skel" style={{ height: 104, borderRadius: 18 }} />
        <div className="skel" style={{ height: 260, borderRadius: 18 }} />
      </div>
    )
  }

  const go = (to) => navigate(to)
  const s = me.stats || {}
  const st = s.st
  const month = scoreMonth(me.month?.actuals, me.month?.attendance, me.month?.weights, me.month?.thresholds)
  const bookKpi = month.kpis.find(k => k.id === 'booking_pct')
  const qaKpi = month.kpis.find(k => k.id === 'call_quality')
  const goal = (me.month?.thresholds?.booking_pct?.meets) ?? 80
  const thr = { ...(me.month?.thresholds || {}) }
  const bookLevel = st?.pct != null ? rateKpi(bookKpi, st.pct, thr.booking_pct || { exceeds: 90, meets: 80, improvement: 75 }) : null
  const shift = me.shift
  const topNeed = (me.board?.needs || []).filter(n => !n.oppWatch && n.day <= 1).sort((a, b) => b.needed - a.needed)[0]

  // ── Call center & dispatch manager view ─────────────────────────────────
  if (manager) {
    const m = me.manager || {}
    const board = center?.board, cards = center?.queue?.cards || []
    const rev = board?.dayRevenue
    const first = cards.find(c => c.actBy)
    const team = s.team
    const missed = team ? team.leadCalls - team.booked : null
    const low = (m.reps || []).filter(r => r.leadCalls >= 5 && r.pct != null && r.pct < goal).sort((a, b) => a.pct - b.pct)[0]
    const headline = !center ? `${greeting()}, ${firstName(me.name)}.`
      : cards.length ? `${cards.length} call${cards.length === 1 ? ' needs' : 's need'} a decision${first ? ` — first by ${clock(first.actBy)}` : ''}.`
      : team?.pct != null ? (team.pct >= goal ? `Board is clean and the floor is booking ${team.pct}%.` : `Board is clean; booking is at ${team.pct}%, ${goal - team.pct} points under goal.`)
      : 'Board is clean — nothing needs you.'
    const body = [
      team?.leadCalls ? `The floor has booked ${team.booked} of ${team.leadCalls} lead calls today (${team.pct}%) against ${goal}%.` : 'No lead calls on the floor yet today.',
      low ? `Lowest so far: ${firstName(low.name)} at ${low.pct}% (${low.booked} of ${low.leadCalls}).` : '',
      rev ? `${money(rev.expected)} expected from today’s board; ${money(rev.soldToday)} sold so far.` : '',
      topNeed ? `${topNeed.trade} needs ${topNeed.needed} more call${topNeed.needed === 1 ? '' : 's'} ${topNeed.day === 0 ? 'today' : 'tomorrow'}.` : '',
    ].filter(Boolean).join(' ')
    const teamLv = team?.pct != null ? rateKpi(bookKpi, team.pct, thr.booking_pct || { exceeds: 90, meets: goal, improvement: 75 }) : null
    const kpis = [
      { label: 'Needs a decision', value: center ? String(cards.length) : '—', sub: center ? (cards.length ? `+${money(center.queue?.atStake)} expected if acted on` : 'Board is clean') : 'Loading the board…', tone: cards.length ? 'red' : undefined },
      { label: 'Booking today', value: team?.pct != null ? `${team.pct}%` : '—', sub: team ? `${team.booked} of ${team.leadCalls} lead calls · goal ${goal}%` : `goal ${goal}%`, tone: teamLv ? LEVELS[teamLv].tone : undefined },
      { label: 'Not booked', value: missed != null ? String(missed) : '—', sub: 'lead calls today', tone: missed ? 'amber' : undefined },
      { label: 'Expected revenue', value: rev ? money(rev.expected) : '—', sub: rev ? `${rev.opportunityCalls} opportunity calls` : '' },
      { label: 'Sold so far', value: rev ? money(rev.soldToday) : '—', sub: rev ? `${money(rev.invoicedToday)} invoiced` : '' },
      { label: 'Techs out', value: center ? String((center.techOut || []).length) : '—', sub: (center?.techOut || []).map(t => t.name || t.techName).filter(Boolean).slice(0, 2).join(', ') || 'Everyone’s in' },
    ]
    const onFloor = (m.floor?.agents || []).length
    const needsYou = [
      ...(m.pto || []).map(p => ({ key: `pto${p.profile_id}${p.date}`, icon: 'user', tone: 'blue', title: `${p.name} · ${weekday(p.date, { month: 'short', day: 'numeric' })}${p.end_date && p.end_date !== p.date ? `–${weekday(p.end_date, { month: 'short', day: 'numeric' })}` : ''}`, sub: `${cap(String(p.kind || 'time off').replace(/_/g, ' '))} request`, to: '/mypage?tab=time-off' })),
      openLeads ? { key: 'leads', icon: 'phone', tone: 'amber', title: `${openLeads} paid lead${openLeads === 1 ? '' : 's'} waiting`, sub: 'First to open one claims it', to: '/' } : null,
    ].filter(Boolean)
    return (
      <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
        <div style={{ padding: isMobile ? '12px 12px 24px' : '20px 26px 96px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1480 }}>
          <section style={{ ...panel, borderRadius: 18, padding: isMobile ? '18px 18px' : '22px 26px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ ...eyebrow, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--signal)' }} />
              Call center & dispatch · {weekday(me.today, { weekday: 'long', month: 'short', day: 'numeric' })}
              <span style={{ marginLeft: isMobile ? 0 : 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--tone-green-tx)', textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: '#1FA36B', boxShadow: '0 0 0 3px rgba(31,163,107,.18)' }} />
                {onFloor} on the floor{m.floor?.queued ? ` · ${m.floor.queued} waiting (${mmss(m.floor.longestWaitSec)})` : ''}
              </span>
            </div>
            <h2 className="disp" style={{ margin: 0, fontSize: isMobile ? 24 : 30, lineHeight: 1.14, fontWeight: 700, letterSpacing: '-.025em', textWrap: 'balance' }}>{headline}</h2>
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: 'var(--text-secondary)', maxWidth: 720 }}>{body}</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
              <a href="/dispatch" onClick={(e) => { e.preventDefault(); go('/dispatch') }} className="btn primary" style={{ borderRadius: 99, height: 38, padding: '0 16px', fontSize: 13 }}>
                Open Command Center <Icon name="arrowRight" size={14} />
              </a>
              <a href="/live" onClick={(e) => { e.preventDefault(); go('/live') }} className="btn" style={{ borderRadius: 99, height: 38, padding: '0 16px', fontSize: 13 }}>Live floor</a>
              <a href="/callboard" onClick={(e) => { e.preventDefault(); go('/callboard') }} className="btn" style={{ borderRadius: 99, height: 38, padding: '0 16px', fontSize: 13 }}>3-day board</a>
            </div>
          </section>

          <section aria-label="Today" style={{ ...panel, borderRadius: 18, display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : `repeat(${kpis.length}, minmax(0, 1fr))` }}>
            {kpis.map((k, i) => <Kpi key={k.label} {...k} first={i === 0} isMobile={isMobile} />)}
          </section>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 1.25fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
            <Section title="The floor today" sub="ServiceTitan lead calls" link={['Live', '/live']} onGo={go}>
              <FloorTable reps={m.reps} goal={goal} thr={thr.booking_pct} isMobile={isMobile} />
            </Section>
            <Section title="Next up" sub={cards.length > 3 ? `${cards.length - 3} more` : null} link={['Command Center', '/dispatch']} onGo={go}>
              <NextUp center={center} go={go} max={3} />
            </Section>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 1.25fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
            <Section title="Coverage" sub="booked % of capacity" link={['3-day board', '/callboard']} onGo={go}>
              <Coverage cov={center?.coverage} />
            </Section>
            <Section title="Needs you" sub={needsYou.length ? `${needsYou.length} item${needsYou.length === 1 ? '' : 's'}` : null}>
              {needsYou.length ? needsYou.map((n, i) => (
                <a key={n.key} href={n.to} onClick={(e) => { e.preventDefault(); go(n.to) }}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: i ? 10 : 0, borderTop: i ? '1px solid var(--border)' : 'none', color: 'inherit', textDecoration: 'none' }}>
                  <span style={{ width: 32, height: 32, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `var(--tone-${n.tone}-bg)`, color: `var(--tone-${n.tone}-tx)` }}>
                    <Icon name={n.icon} size={16} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0, lineHeight: 1.3 }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{n.title}</span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>{n.sub}</span>
                  </span>
                  <Icon name="arrowRight" size={15} style={{ color: 'var(--text-muted)' }} />
                </a>
              )) : <Empty>Nothing waiting on you — no time-off requests or unclaimed paid leads.</Empty>}
            </Section>
          </div>
        </div>
      </div>
    )
  }

  // ── Dispatcher view ─────────────────────────────────────────────────────
  if (dispatcher) {
    const board = center?.board, cards = center?.queue?.cards || []
    const rev = board?.dayRevenue
    const calls = board?.calls || []
    const cov = center?.coverage
    const first = cards.find(c => c.actBy)
    const kpis = [
      { label: 'Needs a decision', value: center ? String(cards.length) : '—', sub: center ? (cards.length ? `+${money(center.queue?.atStake)} expected if acted on` : 'Board is clean') : 'Loading the board…', tone: cards.length ? 'red' : undefined },
      { label: 'Expected revenue', value: rev ? money(rev.expected) : '—', sub: rev ? `${rev.opportunityCalls} opportunity calls` : '' },
      { label: 'Sold so far', value: rev ? money(rev.soldToday) : '—', sub: rev ? `${money(rev.invoicedToday)} invoiced` : '' },
      { label: 'On the board', value: board ? String(calls.length) : '—', sub: board ? `${calls.filter(c => c.status === 'Done').length} done · ${(board.techsToday || []).filter(t => t.onShift).length} techs on shift` : '' },
      { label: 'Techs out', value: center ? String((center.techOut || []).length) : '—', sub: (center?.techOut || []).map(t => t.name || t.techName).filter(Boolean).slice(0, 2).join(', ') || 'Everyone’s in' },
    ]
    return (
      <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
        <div style={{ padding: isMobile ? '12px 12px 24px' : '20px 26px 96px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1480 }}>
          <section style={{ ...panel, borderRadius: 18, padding: isMobile ? '18px 18px' : '22px 26px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ ...eyebrow, display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--signal)' }} />
              Dispatch · {weekday(me.today, { weekday: 'long', month: 'short', day: 'numeric' })}{shift?.start ? ` · your shift ${t12(shift.start)} – ${t12(shift.end)}` : ''}
            </div>
            <h2 className="disp" style={{ margin: 0, fontSize: isMobile ? 24 : 30, lineHeight: 1.14, fontWeight: 700, letterSpacing: '-.025em', textWrap: 'balance' }}>
              {!center ? `${greeting()}, ${firstName(me.name)}.` : cards.length ? `${cards.length} call${cards.length === 1 ? ' needs' : 's need'} a decision${first ? ` — first by ${clock(first.actBy)}` : ''}.` : 'Board is clean — nothing needs you.'}
            </h2>
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: 'var(--text-secondary)', maxWidth: 640 }}>
              {rev ? `${money(rev.expected)} expected from today’s board; ${money(rev.soldToday)} sold so far.` : 'Reading today’s board from ServiceTitan…'}
              {topNeed ? ` ${topNeed.trade} needs ${topNeed.needed} more call${topNeed.needed === 1 ? '' : 's'} ${topNeed.day === 0 ? 'today' : 'tomorrow'}.` : ''}
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
              <a href="/dispatch" onClick={(e) => { e.preventDefault(); go('/dispatch') }} className="btn primary" style={{ borderRadius: 99, height: 38, padding: '0 16px', fontSize: 13 }}>
                Open Command Center <Icon name="arrowRight" size={14} />
              </a>
              <a href="/callboard" onClick={(e) => { e.preventDefault(); go('/callboard') }} className="btn" style={{ borderRadius: 99, height: 38, padding: '0 16px', fontSize: 13 }}>3-day board</a>
            </div>
          </section>

          <section aria-label="Today" style={{ ...panel, borderRadius: 18, display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : `repeat(${kpis.length}, minmax(0, 1fr))` }}>
            {kpis.map((k, i) => <Kpi key={k.label} {...k} first={i === 0} isMobile={isMobile} />)}
          </section>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
            <Section title="Next up" sub={cards.length > 4 ? `${cards.length - 4} more in the Command Center` : null} link={['Command Center', '/dispatch']} onGo={go}>
              <NextUp center={center} go={go} />
            </Section>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
              <Section title="Coverage" sub="booked % of capacity" link={['3-day board', '/callboard']} onGo={go}>
                <Coverage cov={cov} />
              </Section>
              <Section title="Your week" link={['My schedule', '/mypage?tab=my-schedule']} onGo={go}>
                <ComingUp me={me} />
              </Section>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── CSR view ────────────────────────────────────────────────────────────
  const onShiftNow = (() => {
    if (!shift?.start || !shift?.end) return null
    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Denver', hour: '2-digit', minute: '2-digit' }).format(new Date())
    return hm < shift.start.slice(0, 5) ? 'before' : hm < shift.end.slice(0, 5) ? 'on' : 'after'
  })()
  const lines = []
  if (st?.leadCalls) lines.push(`You’ve booked ${st.booked} of ${st.leadCalls} lead call${st.leadCalls === 1 ? '' : 's'} today — ${st.pct}%${s.team?.pct != null ? `; the team is at ${s.team.pct}%` : ''}.`)
  else if (onShiftNow === 'before') lines.push(`Your shift starts at ${t12(shift.start)}.`)
  else if (onShiftNow === 'on') lines.push(`You’re on until ${t12(shift.end)}${shift.lunchStart ? `, lunch at ${t12(shift.lunchStart)}` : ''}.`)
  if (s.rank && st?.booked) lines.push(`That’s #${s.rank.place} of ${s.rank.of} on bookings so far.`)
  if (topNeed) lines.push(`${topNeed.trade} needs ${topNeed.needed} more call${topNeed.needed === 1 ? '' : 's'} ${topNeed.day === 0 ? 'today' : 'tomorrow'} — offer it first when a customer is flexible.`)

  const kpis = [
    { label: 'Booked today', value: st ? String(st.booked) : '—', sub: st ? `of ${st.leadCalls} lead calls in ServiceTitan` : s.stMapped ? 'Waiting on ServiceTitan' : 'Not linked to ServiceTitan yet', tone: st?.booked ? 'green' : undefined },
    { label: 'Booking rate', value: st?.pct != null ? `${st.pct}%` : '—', sub: `goal ${goal}%${s.team?.pct != null ? ` · team ${s.team.pct}%` : ''}`, tone: bookLevel ? LEVELS[bookLevel].tone : undefined },
    // ServiceTitan's count; Andi's own dialer is listed beside it, not added (a call could be in both).
    st ? { label: 'Outbound calls', value: String(st.outbounds), sub: s.dials ? `in ServiceTitan · ${s.dials} dialed in Andi` : 'in ServiceTitan today' }
      : { label: 'Outbound dials', value: String(s.dials ?? 0), sub: `${s.dialBooked || 0} booked from the dialer` },
    s.handled ? { label: 'Answered in Andi', value: String(s.handled), sub: s.avgTalkSec != null ? `avg talk ${mmss(s.avgTalkSec)}` : 'today' } : null,
    me.pay ? { label: 'Earned today', value: cents(me.pay.today), sub: `${cents(me.pay.week)} this week`, tone: me.pay.today > 0 ? 'green' : undefined } : null,
  ].filter(Boolean)

  const qaLevel = me.eval?.pct != null ? rateKpi(qaKpi, Math.round(me.eval.pct), thr.call_quality || { exceeds: 95, meets: 90, improvement: 85 }) : null

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
      <div style={{ padding: isMobile ? '12px 12px 24px' : '20px 26px 96px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1480 }}>

        {/* Greeting + today's read, booking ring on the right */}
        <section style={{ ...panel, borderRadius: 18, overflow: 'hidden', display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) 300px' }}>
          <div style={{ padding: isMobile ? '18px 18px' : '22px 26px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ ...eyebrow, display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--signal)' }} />
              {weekday(me.today, { weekday: 'long', month: 'short', day: 'numeric' })}
              {shift?.start ? ` · shift ${t12(shift.start)} – ${t12(shift.end)}` : shift ? ` · ${String(shift.dayType || 'scheduled').replace(/_/g, ' ')}` : ' · no shift scheduled'}
            </div>
            <h2 className="disp" style={{ margin: 0, fontSize: isMobile ? 24 : 30, lineHeight: 1.14, fontWeight: 700, letterSpacing: '-.025em' }}>
              {greeting()}, {firstName(me.name)}.
            </h2>
            {lines.length > 0 && <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: 'var(--text-secondary)', maxWidth: 640 }}>{lines.join(' ')}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
              {!isMobile && (
                <a href="/" onClick={(e) => { e.preventDefault(); go('/') }} className="btn primary" style={{ borderRadius: 99, height: 38, padding: '0 16px', fontSize: 13 }}>
                  Open the dialer <Icon name="arrowRight" size={14} />
                </a>
              )}
              <a href="/mypage?tab=stats" onClick={(e) => { e.preventDefault(); go('/mypage?tab=stats') }} className="btn" style={{ borderRadius: 99, height: 38, padding: '0 16px', fontSize: 13 }}>My stats</a>
            </div>
          </div>
          <div style={{ background: 'var(--surface-2)', borderLeft: isMobile ? 'none' : '1px solid var(--border)', borderTop: isMobile ? '1px solid var(--border)' : 'none', padding: isMobile ? '16px 18px' : '20px 22px', display: 'flex', alignItems: 'center', gap: 16 }}>
            <Ring pct={st?.pct ?? 0} size={isMobile ? 76 : 92} stroke={8} tone={bookLevel ? LEVELS[bookLevel].tone : 'gray'}>
              <div style={{ ...mono, fontSize: isMobile ? 19 : 22, fontWeight: 600, color: bookLevel ? `var(--tone-${LEVELS[bookLevel].tone}-tx)` : 'var(--text-muted)' }}>
                {st?.pct != null ? <>{st.pct}<span style={{ fontSize: 12 }}>%</span></> : '—'}
              </div>
            </Ring>
            <div style={{ minWidth: 0, lineHeight: 1.4 }}>
              <div style={eyebrow}>Booking today</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{st?.leadCalls ? `${st.booked} booked · ${st.unbooked} not` : 'No lead calls yet'}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Meets at {goal}%</div>
            </div>
          </div>
        </section>

        {/* Today */}
        <section aria-label="Today" style={{ ...panel, borderRadius: 18, display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : `repeat(${kpis.length}, minmax(0, 1fr))` }}>
          {kpis.map((k, i) => <Kpi key={k.label} {...k} first={i === 0} isMobile={isMobile} />)}
        </section>

        {/* Where to book + your queue */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          <Section title="Where we need bookings" sub="open slots on the 3-day board" link={['3-day board', '/callboard']} onGo={go}>
            <BoardNeeds board={me.board} />
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>When a customer is flexible on the day, offer these first. “Full” still books strong calls — dispatch makes room.</div>
          </Section>
          <Section title="Your queue" link={isMobile ? null : ['Open the dialer', '/']} onGo={go}>
            {[
              { icon: 'phone', label: 'Paid leads waiting', value: openLeads, sub: 'First to open one claims it', tone: openLeads ? 'amber' : null },
              { icon: 'refresh', label: 'Callbacks due today', value: queue.callbacks, sub: 'On leads you’ve claimed', tone: queue.callbacks ? 'amber' : null },
              ...queue.camps.map(c => ({ icon: 'calls', label: c.name, value: c.left, sub: c.on ? 'left to work · switched on' : 'left to work · switch it on in the dialer', tone: c.on ? 'blue' : null })),
            ].map((r, i) => (
              <div key={r.label + i} style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: i ? 10 : 0, borderTop: i ? '1px solid var(--border)' : 'none' }}>
                <span style={{ width: 32, height: 32, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `var(--tone-${r.tone || 'gray'}-bg)`, color: `var(--tone-${r.tone || 'gray'}-tx)` }}>
                  <Icon name={r.icon} size={16} />
                </span>
                <span style={{ flex: 1, minWidth: 0, lineHeight: 1.3 }}>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>{r.sub}</span>
                </span>
                <span style={{ ...mono, fontSize: 20, fontWeight: 600 }}>{r.value}</span>
              </div>
            ))}
            {!queue.camps.length && <Empty>No outbound campaigns assigned to you.</Empty>}
          </Section>
        </div>

        {/* Month + latest review + coming up */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(3, minmax(0, 1fr))', gap: 16, alignItems: 'start' }}>
          <Section title="Your month" sub="scorecard" link={['My scorecard', '/mypage?tab=scorecard']} onGo={go}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <Ring pct={month.score == null ? 0 : (month.score / 4) * 100} size={64} stroke={6} tone={month.level ? LEVELS[month.level].tone : 'gray'}>
                <div style={{ ...mono, fontSize: 15, fontWeight: 600, color: month.level ? `var(--tone-${LEVELS[month.level].tone}-tx)` : 'var(--text-muted)' }}>{month.score == null ? '—' : month.score.toFixed(2)}</div>
              </Ring>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <LevelChip level={month.level} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>out of 4.00 · 3.00 meets</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {month.kpis.filter(k => k.weight > 0).map((k, i) => (
                <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>{k.short}</span>
                  <span style={{ ...mono, fontWeight: 600 }}>{k.value == null ? '—' : fmtKpi(k, k.value)}</span>
                  <LevelPips level={k.rating} />
                </div>
              ))}
            </div>
          </Section>

          <Section title="Latest call review" link={['My call evals', '/mypage?tab=call-evals']} onGo={go}>
            {me.eval ? (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ ...mono, fontSize: 32, fontWeight: 600, letterSpacing: '-.03em', color: qaLevel ? `var(--tone-${LEVELS[qaLevel].tone}-tx)` : 'var(--text-primary)' }}>{Math.round(me.eval.pct)}</span>
                  <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>/ 100 · {me.eval.contact_name || 'call'} · {weekday(String(me.eval.call_at || '').slice(0, 10), { month: 'short', day: 'numeric' })}</span>
                </div>
                {me.eval.summary && (
                  <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)', display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{me.eval.summary}</div>
                )}
              </>
            ) : <Empty>No calls reviewed yet. Reviews land here as calls are scored.</Empty>}
          </Section>

          <Section title="Coming up" link={['My schedule', '/mypage?tab=my-schedule']} onGo={go}>
            <ComingUp me={me} />
            {me.pay && (
              <a href="/mypage?tab=commissions" onClick={(e) => { e.preventDefault(); go('/mypage?tab=commissions') }}
                style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)', textDecoration: 'none', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                Pay this month <span style={{ ...mono, fontWeight: 600, color: 'var(--text-primary)' }}>{cents(me.pay.month)}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontWeight: 600 }}>My pay →</span>
              </a>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}
