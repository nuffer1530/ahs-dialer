import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useWallboard } from '../lib/useDailyReload'
import { fmtTime, fmtDate } from '../lib/denver'
import WeatherStrip from '../components/WeatherStrip'

// CEO board (/tv/ceo) — Brandyn's office TV, in the same visual language as
// the department boards: pulse-mark header, period strip, ranking tables,
// feed. Adds the executive layer: run-rate pacing, job-matched true GM,
// opportunities and leads vs goal, the 30-day revenue/leads chart against the
// month's budget pace, money left on the table, and the channel watchdog.
const C = {
  bg:'#0B0F14', panel:'#141A21', panel2:'#1B222B', border:'#252E38',
  text:'#E6EDF3', muted:'#8B949E', dim:'#6E7681',
  green:'#3FB950', blue:'#58A6FF', amber:'#D29922', red:'#F85149', purple:'#BC8CFF', orange:'#F0883E',
}
const CEO_COLOR = '#FF751F'
const DEPT_LINKS = [
  { key:'company', label:'Company' }, { key:'hvac', label:'HVAC' }, { key:'plumbing', label:'Plumbing' },
  { key:'electrical', label:'Electrical' }, { key:'garage', label:'Garage Doors' },
]
const TRADE_SHORT = { 'HVAC':'HVAC', 'Plumbing':'PLB', 'Electrical':'ELE', 'Garage Doors':'GAR' }

const fmtMoney = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString()
const fmtMoneyC = (n) => n == null ? '—'
  : Math.abs(n) >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M'
  : '$' + Math.round(n).toLocaleString()
const fmtPct = (n) => n == null ? '—' : Math.round(n * 100) + '%'
const fmtN = (n) => n == null ? '—' : Number(n).toLocaleString()
const timeAgo = (iso) => {
  if (!iso) return ''
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000))
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function Stat({ label, value, color = C.text, big }) {
  return (
    <div style={{ minWidth:0 }}>
      <div style={{ fontSize: big ? 'clamp(18px, 2.3vw, 30px)' : 'clamp(15px, 1.9vw, 24px)', fontWeight:800, color, letterSpacing:-1, lineHeight:1.05, fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>{value}</div>
      <div style={{ fontSize:10, fontWeight:700, letterSpacing:1, color:C.muted, textTransform:'uppercase', marginTop:4 }}>{label}</div>
    </div>
  )
}

const MEDALS = ['#F0B429', '#B8BEC7', '#CD7F32']
function RankBadge({ i }) {
  const medal = MEDALS[i]
  if (!medal) return <span style={{ color:C.dim, fontWeight:800, fontSize:15 }}>{i + 1}</span>
  return (
    <span style={{ display:'inline-flex', alignItems:'center', justifyContent:'center', width:26, height:26, borderRadius:'50%',
      background:`${medal}1F`, border:`1.5px solid ${medal}`, color:medal, fontWeight:800, fontSize:13, boxShadow:`0 0 10px ${medal}33` }}>
      {i + 1}
    </span>
  )
}

function Panel({ title, accent, compact, children, style }) {
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderTop:`3px solid ${accent}`, borderRadius:14, padding: compact ? '9px 14px' : '14px 18px', minWidth:0, minHeight:0, display:'flex', flexDirection:'column', overflow:'hidden', ...style }}>
      <div style={{ fontSize: compact ? 11 : 12, fontWeight:800, letterSpacing:1.4, color:accent, textTransform:'uppercase', marginBottom: compact ? 7 : 12, whiteSpace:'nowrap' }}>{title}</div>
      {children}
    </div>
  )
}

function PeriodPanel({ title, d, accent, compact }) {
  return (
    <Panel title={title} accent={accent} compact={compact}>
      {d ? (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap: compact ? '8px 8px' : '12px 10px' }}>
          <Stat label="Jobs ran" value={fmtN(d.jobsRan)} />
          <Stat label="Sales" value={fmtMoneyC(d.sales)} color={C.green} />
          <Stat label="Revenue" value={fmtMoneyC(d.revenue)} color={C.blue} />
          <Stat label="Close rate" value={fmtPct(d.closeRate)} color={C.amber} />
          <Stat label="5★ reviews" value={fmtN(d.fiveStar)} color={C.amber} />
          <Stat label="Memberships" value={fmtN(d.memberships)} color={C.purple} />
        </div>
      ) : (
        <div style={{ color:C.dim, fontSize:13, padding:'18px 0' }}>Loading…</div>
      )}
    </Panel>
  )
}

// Company-board feed kinds, plus the two "left on the table" kinds.
const FEED_STYLE = {
  sale:       { tag:'SALE',   color:C.green },
  review:     { tag:'5★',     color:C.amber },
  membership: { tag:'CLUB',   color:C.purple },
  invoice:    { tag:'REV',    color:C.blue },
  missed:     { tag:'MISSED', color:C.red },
  quote:      { tag:'QUOTE',  color:C.amber },
}
const WATCH_STYLE = {
  dark:    { tag:'DARK',    color:C.red },
  fading:  { tag:'FADING',  color:C.amber },
  surging: { tag:'SURGING', color:C.green },
}
const fmtK = (n) => n == null ? '—' : Math.abs(n) >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1000 ? '$' + Math.round(n / 1000) + 'k' : '$' + Math.round(n)
const signPct = (v) => v == null || !isFinite(v) ? '—' : (v >= 0 ? '+' : '−') + Math.abs(Math.round(v * 100)) + '%'

// Last 30 days: daily revenue (line, labeled), leads (bars, labeled) and the
// month's budget pace (dashed). Today is the hollow point, still filling in.
function DailyChart({ series, budget }) {
  const n = series.length
  if (!n || series.filter(p => p.rev != null).length < 5) return <div style={{ color:C.dim, fontSize:13 }}>Building 30 days of history — first load takes a few minutes…</div>
  const W = 1000, H = 250, L = 10, R = 10, T = 22, B = 30
  const band = (W - L - R) / n
  const x = (i) => L + band * (i + 0.5)
  const PH = H - T - B
  const top = Math.max(...series.map(p => p.rev || 0), budget?.perDay || 0) * 1.16 || 1
  const y = (v) => T + PH * (1 - v / top)
  const maxLeads = Math.max(1, ...series.map(p => p.leads || 0))
  const barH = (v) => (v / maxLeads) * PH * 0.34
  const pts = series.map((p, i) => p.rev == null ? null : { i, v: p.rev, today: p.today }).filter(Boolean)
  const closed = pts.filter(p => !p.today)
  const todayPt = pts.find(p => p.today)
  const line = closed.map(p => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay()
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', height:'100%' }} preserveAspectRatio="xMidYMid meet">
      <line x1={L} y1={T + PH} x2={W - R} y2={T + PH} stroke={C.border} />
      {series.map((p, i) => p.leads == null ? null : (
        <g key={`b${i}`}>
          <rect x={x(i) - band * 0.3} y={T + PH - barH(p.leads)} width={band * 0.6} height={barH(p.leads)} rx="2"
            fill={p.today ? 'none' : '#2A3A55'} stroke={p.today ? '#5B7BB0' : 'none'} strokeDasharray={p.today ? '3 2' : undefined} />
          <text x={x(i)} y={T + PH - barH(p.leads) + (barH(p.leads) > 15 ? 11 : -3)} fontSize="9.5" fill="#8FA6CC" textAnchor="middle" fontWeight="700">{p.leads}</text>
        </g>
      ))}
      {budget?.perDay ? <>
        <line x1={L} x2={W - R} y1={y(budget.perDay)} y2={y(budget.perDay)} stroke={C.amber} strokeWidth="1.6" strokeDasharray="6 5" />
        <text x={L + 2} y={y(budget.perDay) - 5} fontSize="11" fill={C.amber} fontWeight="800">budget pace {fmtK(budget.perDay)}/day</text>
      </> : null}
      <polyline points={line} fill="none" stroke={C.green} strokeWidth="2.6" strokeLinejoin="round" />
      {closed.map(p => (
        <g key={`p${p.i}`}>
          <circle cx={x(p.i)} cy={y(p.v)} r="3" fill={C.green} />
          <text x={x(p.i)} y={y(p.v) - 7} fontSize="10" fill={C.text} textAnchor="middle" fontWeight="700">{Math.round(p.v / 1000)}</text>
        </g>
      ))}
      {todayPt && closed.length ? <>
        <line x1={x(closed[closed.length - 1].i)} y1={y(closed[closed.length - 1].v)} x2={x(todayPt.i)} y2={y(todayPt.v)} stroke={C.green} strokeWidth="2" strokeDasharray="3 3" />
        <circle cx={x(todayPt.i)} cy={y(todayPt.v)} r="4.5" fill={C.panel} stroke={C.green} strokeWidth="2" />
        <text x={x(todayPt.i) - 2} y={y(todayPt.v) - 8} fontSize="10" fill="#7EE2A8" textAnchor="end" fontWeight="800">so far {Math.round(todayPt.v / 1000)}</text>
      </> : null}
      {series.map((p, i) => (
        <text key={`x${i}`} x={x(i)} y={H - 10} fontSize="9.5" textAnchor="middle"
          fill={p.today ? C.text : [0, 6].includes(dow(p.d)) ? '#4A525C' : C.dim} fontWeight={p.today ? 800 : 500}>
          {p.d.slice(8) === '01' || i === 0 ? `${Number(p.d.slice(5, 7))}/${Number(p.d.slice(8))}` : Number(p.d.slice(8))}
        </text>
      ))}
    </svg>
  )
}

export default function CEOTVPage() {
  const navigate = useNavigate()
  const [co, setCo] = useState(null)
  const [csr, setCsr] = useState(null)
  const [ceo, setCeo] = useState(null)
  const [err, setErr] = useState(null)
  const [denied, setDenied] = useState(false)
  const [time, setTime] = useState(new Date())
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1150)
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 1150)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  const rootRef = useRef(null)
  const { isFull, toggleFull } = useWallboard(rootRef)
  // Auto-fit: when the board is taller than the screen, zoom it down so every
  // row — including all five CSRs — is visible with no scrolling.
  const [fit, setFit] = useState(1)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const t = setTimeout(() => {
      const need = el.scrollHeight, have = el.clientHeight
      if (need > have + 2) setFit(f => Math.max(0.55, +((f * have) / need * 0.99).toFixed(3)))
    }, 300)
    return () => clearTimeout(t)
  }, [narrow, co, ceo, csr, fit])

  const load = useCallback(async () => {
    try {
      const { data: { session } } = await sb.auth.getSession()
      if (!session) return
      const h = { headers: { Authorization: `Bearer ${session.access_token}` } }
      const [r1, r2] = await Promise.all([fetch('/api/tv/department/company', h), fetch('/api/tv/ceo', h)])
      if (r1.ok) setCo(await r1.json())
      if (r2.ok) { setCeo(await r2.json()); setErr(null) }
      else if (r2.status === 403) setDenied(true)
      else setErr(true)
    } catch { setErr(true) }
  }, [])
  const loadCsr = useCallback(async () => {
    try {
      const { data: { session } } = await sb.auth.getSession()
      if (!session) return
      const r = await fetch('/api/tv/csr-month', { headers: { Authorization: `Bearer ${session.access_token}` } })
      if (r.ok) setCsr(await r.json())
    } catch {}
  }, [])
  useEffect(() => {
    load(); loadCsr()
    const t1 = setInterval(load, 60_000)
    const t2 = setInterval(loadCsr, 5 * 60_000)
    const t3 = setInterval(() => setTime(new Date()), 1000)
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3) }
  }, [load, loadCsr])

  const fast = ceo?.fast, slow = ceo?.slow, daily = ceo?.daily, goals = ceo?.goals
  const gm = slow?.gm
  const techs = (co?.techs || []).slice(0, 5)
  const techMax = useMemo(() => {
    const m = {}
    for (const c of ['score', 'sold', 'avgTicket', 'closeRate', 'fiveStar', 'memberships']) m[c] = Math.max(0, ...techs.map(x => Number(x[c]) || 0))
    m.ytdSold = Math.max(0, ...techs.map(x => Number(x.ytd?.sold) || 0))
    return m
  }, [techs])
  const csrs = useMemo(() => {
    const list = (csr?.csrs || []).map(r => ({ ...r, rate: r.leadCalls > 0 ? r.booked / r.leadCalls : 0 }))
    const mb = Math.max(1, ...list.map(r => r.booked)), mr = Math.max(0.01, ...list.map(r => r.rate)), mq = Math.max(1, ...list.map(r => r.qa || 0))
    for (const r of list) r.score = Math.round(100 * (0.5 * r.booked / mb + 0.3 * r.rate / mr + 0.2 * (r.qa || 0) / mq))
    return list.sort((a, b) => b.score - a.score).slice(0, 5)
  }, [csr])
  const csrMax = useMemo(() => {
    const m = {}
    for (const c of ['score', 'booked', 'rate', 'leadCalls', 'outbound', 'clubs', 'qa']) m[c] = Math.max(0, ...csrs.map(x => Number(x[c]) || 0))
    return m
  }, [csrs])
  const leaks = fast?.leaks
  const oppGoal = goals?.oppsToday ?? 33
  const oppTotal = fast?.opps?.total
  const oppPct = oppGoal > 0 && oppTotal != null ? Math.min(100, Math.round(oppTotal / oppGoal * 100)) : 0
  const oppCol = oppGoal === 0 ? C.muted : oppPct >= 100 ? C.green : oppPct >= 70 ? C.amber : C.red
  const leadGoal = goals?.leadsPerDay ?? 43
  const leadsToday = fast?.leads
  const leadPct = leadsToday != null ? Math.min(100, Math.round(leadsToday / leadGoal * 100)) : 0
  const gmCol = (v) => v == null ? C.dim : v >= 50 ? C.green : v >= 42 ? C.amber : C.red
  const budget = daily?.budget
  const mtdRev = co?.monthly?.revenue
  const need = budget && mtdRev != null && budget.effLeft > 0 ? (budget.amount - mtdRev) / budget.effLeft : null

  const cell = (v, isMax, fmt = fmtN, color) => (
    <td style={{ padding: narrow ? '4px 8px' : '6px 9px', textAlign:'right', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap',
      fontWeight: isMax ? 800 : 500, color: isMax ? (color || C.text) : C.muted,
      fontSize: isMax ? 'clamp(13px, 1.4vw, 16px)' : 'clamp(12px, 1.3vw, 14px)' }}>
      {fmt(v)}
    </td>
  )
  const th = (label, right = true) => (
    <th style={{ padding: narrow ? '4px 8px' : '5px 9px', textAlign: right ? 'right' : 'left', fontSize:10, fontWeight:700, letterSpacing:1, color:C.dim, textTransform:'uppercase', whiteSpace:'nowrap' }}>{label}</th>
  )
  const feedRow = (key, kind, line, sub) => {
    const st = FEED_STYLE[kind] || FEED_STYLE.sale
    return (
      <div key={key} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 16px', borderBottom:`1px solid ${C.border}55` }}>
        <span style={{ fontSize:10, fontWeight:800, letterSpacing:.8, color:st.color, background:`${st.color}1A`, border:`1px solid ${st.color}55`, borderRadius:6, padding:'3px 7px', flexShrink:0 }}>{st.tag}</span>
        <div style={{ minWidth:0, flex:1 }}>
          <div style={{ fontSize:13, fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{line}</div>
          <div style={{ fontSize:11, color:C.dim, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{sub}</div>
        </div>
      </div>
    )
  }

  if (denied) {
    return (
      <div style={{ height:'100vh', background:C.bg, color:C.text, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:10 }}>
        <div style={{ fontSize:20, fontWeight:800 }}>This board is leadership-only</div>
        <div style={{ color:C.muted, fontSize:14 }}>Log the TV in with an allowed account, or open a department board instead.</div>
      </div>
    )
  }

  return (
    <div ref={rootRef} style={{ height:`calc(100vh / ${fit})`, minHeight:`calc(100vh / ${fit})`, zoom: fit, boxSizing:'border-box', background:C.bg, color:C.text, padding: narrow ? '10px 14px' : '14px 20px', display:'flex', flexDirection:'column', gap: narrow ? 10 : 12, overflow:'auto', fontFamily:'inherit' }}>

      {/* Header — same construction as the department boards */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:16, flexShrink:0, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <span className="pulse-mark" style={{ width: narrow ? 34 : 40, height: narrow ? 34 : 40, borderRadius:11, background:'#0b0c0f', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 6px 18px rgba(255,117,31,.15)', flexShrink:0 }}>
            <svg width="26" height="26" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
              <polyline points="9,32 19,32 25,17 33,47 40,26 45,32 55,32" fill="none" stroke="#ff751f" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          <span style={{ fontSize: narrow ? 18 : 21, fontWeight:800, letterSpacing:.3, whiteSpace:'nowrap' }}>CEO</span>
          {!narrow && <span style={{ fontSize:12, color:C.muted, letterSpacing:1, textTransform:'uppercase' }}>Executive board</span>}
          {!isFull && (
            <div style={{ display:'flex', gap:6, marginLeft:10, flexWrap:'wrap' }}>
              <button style={{ background:C.panel2, border:`1px solid ${CEO_COLOR}`, color:C.text, borderRadius:8, padding:'6px 12px', fontSize:12, fontWeight:700, cursor:'default' }}>CEO</button>
              {DEPT_LINKS.map(t => (
                <button key={t.key} onClick={() => navigate(`/tv/${t.key}`)}
                  style={{ background:'transparent', border:`1px solid ${C.border}`, color:C.dim, borderRadius:8, padding:'6px 12px', fontSize:12, fontWeight:700, cursor:'pointer' }}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:16, marginLeft:'auto', justifyContent:'flex-end', flexWrap:'wrap' }}>
          <div style={{ zoom: narrow ? .8 : 1 }}><WeatherStrip dark /></div>
          {co?.updatedAt && <span style={{ fontSize: narrow ? 10 : 11, color:C.dim, whiteSpace:'nowrap' }}>Updated {timeAgo(co.updatedAt)}</span>}
          {err && <span style={{ fontSize:11, color:C.red }}>Refresh failed — retrying</span>}
          <button onClick={toggleFull} title={isFull ? 'Exit fullscreen' : 'Fullscreen'}
            style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:8, color:C.muted, cursor:'pointer', padding:'8px 10px', display:'flex', alignItems:'center' }}>
            {isFull ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 3v3a3 3 0 01-3 3H3M15 3v3a3 3 0 003 3h3M9 21v-3a3 3 0 00-3-3H3M15 21v-3a3 3 0 013-3h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 9V5a2 2 0 012-2h4M21 9V5a2 2 0 00-2-2h-4M3 15v4a2 2 0 002 2h4M21 15v4a2 2 0 01-2 2h-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            )}
          </button>
          <div style={{ textAlign:'right' }}>
            <div style={{ fontSize: narrow ? 19 : 'clamp(20px, 2.4vw, 30px)', fontWeight:800, letterSpacing:-1, color:C.blue, fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>
              {fmtTime(time, { hour:'2-digit', minute:'2-digit', second:'2-digit' })}
            </div>
            <div style={{ fontSize:12, color:C.muted }}>{fmtDate(time, { weekday:'long', month:'long', day:'numeric' })}</div>
          </div>
        </div>
      </div>

      {/* Daily / Monthly / Yearly strip — identical to the company board */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap: narrow ? 10 : 12, flexShrink:0 }}>
        <PeriodPanel title="Today" d={co?.daily} accent={C.green} compact={narrow} />
        <PeriodPanel title="This month" d={co?.monthly} accent={CEO_COLOR} compact={narrow} />
        <PeriodPanel title="This year" d={co?.yearly} accent={C.blue} compact={narrow} />
      </div>

      {/* Executive strip: pacing · true GM · call center · opportunities */}
      <div style={{ display:'grid', gridTemplateColumns: narrow ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: narrow ? 10 : 12, flexShrink:0 }}>
        <Panel title="Pacing — run rate" accent={C.blue} compact={narrow}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:'10px 8px' }}>
            <Stat big label="Year lands" value={fmtMoneyC(slow?.pacing?.yearProj)} color={C.blue} />
            <Stat label="vs last year" value={slow?.pacing?.yoy != null ? (slow.pacing.yoy >= 0 ? '+' : '') + slow.pacing.yoy + '%' : '—'} color={C.green} />
            <Stat label="Month lands" value={fmtMoneyC(slow?.pacing?.monthProj)} color={C.blue} />
            <Stat label="Last year total" value={fmtMoneyC(slow?.pacing?.prevYearTotal)} />
          </div>
        </Panel>
        <Panel title={`True GM — ${gm?.month || 'month'}`} accent={C.amber} compact={narrow}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:'10px 8px' }}>
            <Stat big label="Company" value={gm?.company != null ? gm.company + '%' : '—'} color={gmCol(gm?.company)} />
            {['HVAC', 'Plumbing', 'Electrical', 'Garage Doors'].map(t => (
              <Stat key={t} label={t === 'Garage Doors' ? 'Garage' : t} value={gm?.byTrade?.[t] != null ? gm.byTrade[t] + '%' : '—'} color={gmCol(gm?.byTrade?.[t])} />
            ))}
          </div>
        </Panel>
        <Panel title="Call center — today" accent={C.green} compact={narrow}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:'10px 8px' }}>
            <Stat big label="Booking rate" value={fast?.booking?.pct != null ? fast.booking.pct + '%' : '—'} color={C.green} />
            <Stat label="Booked / lead calls" value={`${fmtN(fast?.booking?.booked)} / ${fmtN(fast?.booking?.leadCalls)}`} />
            <Stat label="CSR outbounds" value={fmtN(fast?.csrOutbounds)} color={C.blue} />
            <Stat label="Missed lead calls" value={fmtN(leaks?.missedCount)} color={leaks?.missedCount ? C.red : C.muted} />
          </div>
        </Panel>
        <Panel title={oppGoal ? `Opportunities — goal ${oppGoal} today` : 'Opportunities — closed day'} accent={C.purple} compact={narrow}>
          <div style={{ display:'flex', alignItems:'baseline', gap:18 }}>
            <Stat big label="Ran today · 3 trades" value={fmtN(oppTotal)} color={oppCol} />
            {ceo?.week?.opps != null && <Stat label={`This week · goal ${ceo.week.oppsGoal}`} value={fmtN(ceo.week.opps)} color={C.purple} />}
          </div>
          <div style={{ height:9, borderRadius:5, background:C.panel2, margin:'8px 0' }}>
            <div style={{ height:'100%', width:`${oppPct}%`, borderRadius:5, background:oppCol }} />
          </div>
          <div style={{ display:'flex', gap:16 }}>
            {['HVAC', 'Plumbing', 'Electrical'].map(t => <Stat key={t} label={TRADE_SHORT[t]} value={fmtN(fast?.opps?.byTrade?.[t] || 0)} />)}
            <Stat label="GAR · not in goal" value={fmtN(fast?.opps?.byTrade?.['Garage Doors'] || 0)} color={C.muted} />
          </div>
        </Panel>
      </div>

      {/* Chart + leads + rankings (left) · live feed + channel watch (right).
          The row grows to its content so auto-fit sees any overflow; the feed
          is absolutely placed so its length never sets the row height. */}
      <div style={{ display:'flex', flexDirection: narrow ? 'column' : 'row', gap: narrow ? 10 : 12, flex:'1 0 auto' }}>
        <div style={{ flex:1.65, display:'flex', flexDirection:'column', gap: narrow ? 10 : 12, minWidth:0 }}>
          <div style={{ display:'flex', gap: narrow ? 10 : 12, flex:'1 1 auto', minHeight: 270 }}>
            <Panel title="Last 30 days — revenue $k (line) · leads (bars) · budget pace (dashed)" accent={C.green} compact={narrow} style={{ flex:2.5 }}>
              {budget && mtdRev != null && (
                <div style={{ fontSize:12, color:C.muted, marginTop:-4, marginBottom:4 }}>
                  {fmtDate(time, { month:'long' })} budget <b style={{ color:C.text }}>{fmtMoneyC(budget.amount)}</b> · MTD <b style={{ color:C.text }}>{fmtMoneyC(mtdRev)}</b> ·{' '}
                  {need > 0
                    ? <>need <b style={{ color: need > budget.perDay ? C.red : C.green }}>{fmtK(need)}</b> per business day the rest of the month</>
                    : <b style={{ color:C.green }}>budget hit — {fmtK(-need * budget.effLeft)} over</b>}
                </div>
              )}
              <div style={{ flex:1, minHeight:0 }}><DailyChart series={daily?.series || []} budget={budget} /></div>
            </Panel>
            <Panel title="Leads — today vs goal" accent={C.amber} compact={narrow} style={{ flex:1 }}>
              <Stat big label={`Leads today · goal ${leadGoal}`} value={fmtN(leadsToday)} color={(leadsToday || 0) >= leadGoal ? C.green : C.amber} />
              <div style={{ height:9, borderRadius:5, background:C.panel2, margin:'10px 0' }}>
                <div style={{ height:'100%', width:`${leadPct}%`, borderRadius:5, background: leadPct >= 100 ? C.green : C.amber }} />
              </div>
              <div style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
                {['HVAC', 'Plumbing', 'Electrical', 'Garage Doors'].map(t => <Stat key={t} label={TRADE_SHORT[t]} value={fmtN(fast?.leadsByTrade?.[t] || 0)} />)}
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8, marginTop:'auto', paddingTop:12, borderTop:`1px solid ${C.border}` }}>
                <Stat label="30-day avg" value={daily?.leads?.avg30 != null ? daily.leads.avg30.toFixed(1) : '—'} />
                <Stat label="vs goal" value={signPct(daily?.leads?.vsGoal)} color={(daily?.leads?.vsGoal ?? 0) >= 0 ? C.green : C.red} />
                <Stat label="vs last year" value={signPct(daily?.leads?.vsLy)} color={(daily?.leads?.vsLy ?? 0) >= 0 ? C.green : C.red} />
              </div>
            </Panel>
          </div>
          <Panel title={`Top 5 techs — ${fmtDate(time, { month:'long' })} · composite score`} accent={C.green} compact={narrow} style={{ flexShrink:0 }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead><tr>{th('#', false)}{th('Technician', false)}{th('Score')}{th('Sold')}{th('Avg ticket')}{th('Close')}{th('5★')}{th('Clubs')}{th('YTD sold')}</tr></thead>
              <tbody>
                {techs.map((x, i) => (
                  <tr key={x.id || i} style={{ borderBottom:`1px solid ${C.border}`, background: i === 0 ? `${CEO_COLOR}14` : 'transparent' }}>
                    <td style={{ padding:'3px 8px', width:30 }}><RankBadge i={i} /></td>
                    <td style={{ padding:'3px 8px', fontWeight:700, whiteSpace:'nowrap', fontSize:'clamp(12px, 1.4vw, 15px)' }}>
                      {x.name}{x.trade && <span style={{ marginLeft:8, fontSize:10, fontWeight:800, letterSpacing:.8, color:C.dim }}>{TRADE_SHORT[x.trade] || x.trade}</span>}
                    </td>
                    {cell(x.score, x.score === techMax.score, fmtN, CEO_COLOR)}
                    {cell(x.sold, x.sold === techMax.sold, fmtMoney, C.green)}
                    {cell(x.avgTicket, x.avgTicket === techMax.avgTicket, fmtMoney)}
                    {cell(x.closeRate, x.closeRate === techMax.closeRate, fmtPct, C.amber)}
                    {cell(x.fiveStar, x.fiveStar === techMax.fiveStar, fmtN, C.amber)}
                    {cell(x.memberships, x.memberships === techMax.memberships, fmtN, C.purple)}
                    {cell(x.ytd?.sold, (x.ytd?.sold || 0) === techMax.ytdSold, fmtMoneyC, C.green)}
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title={`Top 5 CSRs — ${fmtDate(time, { month:'long' })} · composite score`} accent={C.blue} compact={narrow} style={{ flexShrink:0 }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead><tr>{th('#', false)}{th('CSR', false)}{th('Score')}{th('Booked')}{th('Book rate')}{th('Lead calls')}{th('Outbounds')}{th('Clubs')}{th('QA')}</tr></thead>
              <tbody>
                {csrs.map((x, i) => (
                  <tr key={x.name} style={{ borderBottom:`1px solid ${C.border}`, background: i === 0 ? `${C.blue}12` : 'transparent' }}>
                    <td style={{ padding:'3px 8px', width:30 }}><RankBadge i={i} /></td>
                    <td style={{ padding:'3px 8px', fontWeight:700, fontSize:'clamp(12px, 1.4vw, 15px)', whiteSpace:'nowrap' }}>{x.name}</td>
                    {cell(x.score, x.score === csrMax.score, fmtN, C.blue)}
                    {cell(x.booked, x.booked === csrMax.booked, fmtN, C.green)}
                    {cell(x.rate, x.rate === csrMax.rate, fmtPct, C.amber)}
                    {cell(x.leadCalls, x.leadCalls === csrMax.leadCalls)}
                    {cell(x.outbound ?? null, (x.outbound || 0) === csrMax.outbound && csrMax.outbound > 0, fmtN, C.blue)}
                    {cell(x.clubs, x.clubs === csrMax.clubs, fmtN, C.purple)}
                    {cell(x.qa, x.qa != null && x.qa === csrMax.qa, (v) => v == null ? '—' : Number(v).toFixed(1), C.amber)}
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>

        <div style={{ flex:.62, minWidth: narrow ? 0 : 300, display:'flex', flexDirection:'column', gap: narrow ? 10 : 12 }}>
          {/* Live feed — the company board's feed, with money left on the table pinned on top */}
          <div style={{ flex:1, position:'relative', minHeight: narrow ? 380 : 0 }}>
            <div style={{ position:'absolute', inset:0, background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, overflow:'hidden', display:'flex', flexDirection:'column' }}>
              <div style={{ padding:'13px 18px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
                <span style={{ fontSize:13, fontWeight:700, letterSpacing:.5 }}>Today in Company</span>
                <div style={{ marginLeft:'auto', width:7, height:7, borderRadius:'50%', background:C.green, animation:'wr-pulse 1.5s infinite' }} />
              </div>
              <div style={{ flex:1, overflow:'hidden', padding:'4px 0 8px' }}>
                {leaks && (leaks.missedCount > 0 || leaks.quoteCount > 0) && (
                  <div style={{ background:`${C.red}0A`, borderBottom:`1px solid ${C.border}` }}>
                    <div style={{ padding:'8px 16px 2px', fontSize:10, fontWeight:800, letterSpacing:1.2, color:C.red, textTransform:'uppercase' }}>
                      Left on the table · {leaks.missedCount} missed · {leaks.quoteCount} open quotes {fmtK(leaks.quoteAmt)}
                    </div>
                    {(leaks.missed || []).slice(0, 4).map((m, i) => feedRow(`m${i}`, 'missed',
                      `Missed lead — ${m.who}`,
                      [m.reason, m.trade ? TRADE_SHORT[m.trade] : null, m.channel, m.csr ? `took: ${m.csr}` : null, timeAgo(m.at)].filter(Boolean).join(' · ')))}
                    {(leaks.quotes || []).slice(0, 3).map((q, i) => feedRow(`q${i}`, 'quote',
                      `${fmtMoney(q.amount)} open — ${q.title}`,
                      [q.trade ? TRADE_SHORT[q.trade] : null, q.job ? `#${q.job}` : null, timeAgo(q.at)].filter(Boolean).join(' · ')))}
                  </div>
                )}
                {(co?.feed || []).map((f, i) => feedRow(`f${i}`, f.kind,
                  <>
                    {f.kind === 'sale' && `${f.who || 'The team'} sold ${fmtMoney(f.amount)}`}
                    {f.kind === 'review' && `${f.who || 'The team'} earned a 5★ review`}
                    {f.kind === 'membership' && `${f.who || 'The team'} sold a membership`}
                    {f.kind === 'invoice' && `${f.who || 'The team'} closed ${fmtMoney(f.amount)} in revenue`}
                  </>,
                  [f.text, timeAgo(f.at)].filter(Boolean).join(' · ')))}
                {!(co?.feed || []).length && !leaks?.missedCount && (
                  <div style={{ padding:24, textAlign:'center', color:C.dim, fontSize:13 }}>Nothing yet today — first win lands here.</div>
                )}
              </div>
            </div>
          </div>

          {/* Channel watchdog: last 3 days vs each channel's 8-week normal */}
          <Panel title="Channel watch — last 3 days vs normal" accent={C.red} compact={narrow} style={{ flexShrink:0 }}>
            {!daily?.watchReady ? (
              <div style={{ color:C.dim, fontSize:12 }}>Building 8 weeks of channel history…</div>
            ) : !(daily?.channels || []).length ? (
              <div style={{ color:C.muted, fontSize:12 }}>All channels are within their normal range.</div>
            ) : daily.channels.map((c, i) => {
              const st = WATCH_STYLE[c.kind]
              return (
                <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'5px 0', borderBottom: i < daily.channels.length - 1 ? `1px solid ${C.border}55` : 'none' }}>
                  <span style={{ fontSize:10, fontWeight:800, letterSpacing:.8, color:st.color, background:`${st.color}1A`, border:`1px solid ${st.color}55`, borderRadius:6, padding:'3px 7px', flexShrink:0, minWidth:58, textAlign:'center' }}>{st.tag}</span>
                  <div style={{ minWidth:0, flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{c.name}</div>
                    <div style={{ fontSize:11, color:C.dim }}>{c.recent} lead calls in 3 days · normally ~{c.normal}</div>
                  </div>
                </div>
              )
            })}
          </Panel>
        </div>
      </div>
      <style>{`@keyframes wr-pulse { 0%,100%{opacity:1} 50%{opacity:.25} }`}</style>
    </div>
  )
}
