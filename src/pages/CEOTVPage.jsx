import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useWallboard } from '../lib/useDailyReload'
import { fmtTime, fmtDate } from '../lib/denver'
import WeatherStrip from '../components/WeatherStrip'

// CEO board (/tv/ceo) — Brandyn's office TV, in the same visual language as
// the department boards: pulse-mark header, period strip, ranking tables,
// feed. Adds the executive layer: run-rate pacing, job-matched true GM, the
// month's revenue-per-day and leads-per-day against budget and goal, leads +
// opportunities vs goal, and money left on the table.
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
      <div style={{ fontSize: big ? 30 : 24, fontWeight:800, color, letterSpacing:-1, lineHeight:1.05, fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>{value}</div>
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

function Panel({ title, accent, children, style }) {
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderTop:`3px solid ${accent}`, borderRadius:14, padding:'12px 18px', minWidth:0, minHeight:0, display:'flex', flexDirection:'column', overflow:'hidden', ...style }}>
      <div style={{ fontSize:12, fontWeight:800, letterSpacing:1.4, color:accent, textTransform:'uppercase', marginBottom:10, whiteSpace:'nowrap' }}>{title}</div>
      {children}
    </div>
  )
}

function PeriodPanel({ title, d, accent }) {
  return (
    <Panel title={title} accent={accent}>
      {d ? (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:'10px 10px' }}>
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

// Today's Activity kinds.
const FEED_STYLE = {
  booked:     { tag:'BOOKED', color:C.blue },
  bonus:      { tag:'BONUS',  color:'#F0B429' },
  sale:       { tag:'SALE',   color:C.green },
  review:     { tag:'5★',     color:C.amber },
  membership: { tag:'CLUB',   color:C.purple },
  invoice:    { tag:'REV',    color:'#39C5CF' },
}
const fmtK = (n) => n == null ? '—' : Math.abs(n) >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1000 ? '$' + Math.round(n / 1000) + 'k' : '$' + Math.round(n)
const signPct = (v) => v == null || !isFinite(v) ? '—' : (v >= 0 ? '+' : '−') + Math.abs(Math.round(v * 100)) + '%'

// This month, day by day. Top: revenue per day as bars, each with a white tick
// at that day's share of the month budget (weekday full, Saturday half,
// Sunday none) — green = hit, amber = within 80%, red = short. Remaining days
// are outlined at what's now needed per day. Bottom: leads per day vs goal.
function MonthCharts({ month, budget, need, leadGoal, aspect }) {
  const n = month.length
  if (!n) return null
  const W = 1000, L = 6, R = 6
  const H = Math.max(300, Math.round(W * (aspect || 0.36)))
  const band = (W - L - R) / n, bw = band * 0.62
  const x = (i) => L + band * (i + 0.5)
  const room = H - 30 - 48 - 24
  const RT = 30, RH = Math.round(room * 0.64)
  const LT = RT + RH + 48, LH = room - RH
  const perDay = budget?.perDay || 0
  const targetOf = (p) => p.w * (p.future && need > 0 ? need : perDay)
  const revTop = Math.max(1, ...month.map(p => Math.max(p.rev || 0, targetOf(p)))) * 1.16
  const ry = (v) => RT + RH * (1 - v / revTop)
  const leadTop = Math.max(leadGoal, ...month.map(p => p.leads || 0)) * 1.22
  const lyy = (v) => LT + LH * (1 - v / leadTop)
  const k = (v) => Math.round(v / 1000)
  const revCol = (p) => {
    const t = targetOf(p)
    if (!t) return '#3A4452'
    const r = (p.rev || 0) / t
    return r >= 0.98 ? C.green : r >= 0.8 ? C.amber : C.red
  }
  const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay()
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', height:'100%' }} preserveAspectRatio="xMidYMid meet">
      <text x={L} y={14} fontSize="12" fontWeight="800" fill={C.muted} letterSpacing="1">REVENUE PER DAY ($K)</text>
      <text x={W - R} y={14} fontSize="11" fill={C.dim} textAnchor="end">white tick = day's budget · outlined = needed per day to hit budget</text>
      <line x1={L} x2={W - R} y1={RT + RH} y2={RT + RH} stroke={C.border} />
      {month.map((p, i) => {
        const t = targetOf(p)
        if (p.future) {
          if (!t) return null
          return (
            <g key={`r${i}`}>
              <rect x={x(i) - bw / 2} y={ry(t)} width={bw} height={RT + RH - ry(t)} rx="2" fill="none" stroke="#4A5563" strokeDasharray="3 3" />
              <text x={x(i)} y={ry(t) - 5} fontSize="10" fill={C.dim} textAnchor="middle">{k(t)}</text>
            </g>
          )
        }
        if (p.rev == null) return null
        const col = revCol(p)
        return (
          <g key={`r${i}`}>
            {p.today && t ? <rect x={x(i) - bw / 2} y={ry(t)} width={bw} height={RT + RH - ry(t)} rx="2" fill="none" stroke={C.blue} strokeDasharray="3 3" /> : null}
            <rect x={x(i) - bw / 2} y={ry(p.rev)} width={bw} height={Math.max(1, RT + RH - ry(p.rev))} rx="2" fill={p.today ? C.blue : col} opacity={p.today ? 0.85 : 1} />
            {t && !p.today ? <line x1={x(i) - bw / 2 - 3} x2={x(i) + bw / 2 + 3} y1={ry(t)} y2={ry(t)} stroke="#E6EDF3" strokeWidth="2.2" /> : null}
            <text x={x(i)} y={Math.min(ry(p.rev), t ? ry(t) : ry(p.rev)) - 5} fontSize="11" fontWeight="800" fill={p.today ? C.blue : C.text} textAnchor="middle">{k(p.rev)}</text>
          </g>
        )
      })}

      <text x={L} y={LT - 14} fontSize="12" fontWeight="800" fill={C.muted} letterSpacing="1">LEADS PER DAY</text>
      <line x1={L} x2={W - R} y1={LT + LH} y2={LT + LH} stroke={C.border} />
      <line x1={L} x2={W - R} y1={lyy(leadGoal)} y2={lyy(leadGoal)} stroke={C.amber} strokeWidth="1.6" strokeDasharray="6 5" />
      <text x={W - R} y={lyy(leadGoal) - 5} fontSize="11" fontWeight="800" fill={C.amber} textAnchor="end">goal {leadGoal}</text>
      {month.map((p, i) => p.future || p.leads == null ? null : (
        <g key={`l${i}`}>
          <rect x={x(i) - bw / 2} y={lyy(p.leads)} width={bw} height={Math.max(1, LT + LH - lyy(p.leads))} rx="2"
            fill={p.today ? C.blue : p.leads >= leadGoal ? C.green : '#3B6FB6'} opacity={p.today ? 0.85 : 1} />
          <text x={x(i)} y={lyy(p.leads) - 4} fontSize="10.5" fontWeight="700" fill={C.text} textAnchor="middle">{p.leads}</text>
        </g>
      ))}

      {month.map((p, i) => (
        <text key={`x${i}`} x={x(i)} y={H - 6} fontSize="10.5" textAnchor="middle"
          fill={p.today ? C.blue : [0, 6].includes(dow(p.d)) ? '#4A525C' : C.dim} fontWeight={p.today ? 800 : 500}>
          {Number(p.d.slice(8))}
        </text>
      ))}
    </svg>
  )
}

// Height ÷ width of an element, kept current as it resizes.
function useAspect(ref) {
  const [aspect, setAspect] = useState(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect
      if (width > 0 && height > 0) setAspect(+(height / width).toFixed(3))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return aspect
}

// The board is laid out on a fixed 1920×1080 canvas and scaled to the screen,
// so the office TV (Fire TV Silk reports ~960×540 CSS px) shows exactly what a
// laptop shows. A narrow reflow used to push the rankings and feed off-screen.
const DESIGN_W = 1920, DESIGN_H = 1080

export default function CEOTVPage() {
  const navigate = useNavigate()
  const [co, setCo] = useState(null)
  const [csr, setCsr] = useState(null)
  const [ceo, setCeo] = useState(null)
  const [err, setErr] = useState(null)
  const [denied, setDenied] = useState(false)
  // Today's Activity stream: ServiceTitan bookings (60 s, via /api/tv/ceo),
  // sales every 2 min, reviews/clubs every 5 — the Call Center board's cadence.
  const [sales, setSales] = useState([])
  const [wins, setWins] = useState({ reviews: [], memberships: [], bonus: null })
  const seenRef = useRef(new Map())
  const mountedAt = useRef(Date.now())
  const [time, setTime] = useState(new Date())
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  const scale = Math.min(vp.w / DESIGN_W, vp.h / DESIGN_H)

  const rootRef = useRef(null)
  const chartRef = useRef(null)
  const chartAspect = useAspect(chartRef)
  const { isFull, toggleFull } = useWallboard(rootRef)

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
    const loadSales = () => fetch('/api/tv/sales-today').then(r => r.json()).then(d => setSales(d.sales || [])).catch(() => {})
    const loadWins = () => fetch('/api/tv/wins-today').then(r => r.json())
      .then(d => setWins({ reviews: d.reviews || [], memberships: d.memberships || [], bonus: d.bonus || null })).catch(() => {})
    loadSales(); loadWins()
    const ts = setInterval(loadSales, 2 * 60_000)
    const tw = setInterval(loadWins, 5 * 60_000)
    return () => { clearInterval(ts); clearInterval(tw) }
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
  const stream = useMemo(() => [
    ...(ceo?.booked || []).map(b => ({ id: b.id, kind: 'booked', at: b.at,
      line: `${b.csr || 'A CSR'} booked a call`,
      sub: [b.jobType, b.job ? `#${b.job}` : null].filter(Boolean).join(' · ') })),
    ...sales.map(x => ({ id: x.id, kind: 'sale', at: x.soldOn, line: `${x.tech} sold ${fmtMoney(x.amount)}`, sub: x.what, big: x.amount >= 5000 })),
    ...wins.reviews.map(x => ({ id: x.id, kind: 'review', at: x.at, line: `${x.tech || 'The team'} earned a 5★ review`, sub: `${x.author} on ${x.platform}` })),
    ...wins.memberships.map(x => ({ id: x.id, kind: 'membership', at: x.at, line: `${x.seller} sold a membership`, sub: x.type })),
    ...(wins.bonus ? [{ id: wins.bonus.id, kind: 'bonus', at: wins.bonus.at, line: 'Opportunity Watch bonus unlocked', sub: `$${Number(wins.bonus.pool).toFixed(0)} pool ${wins.bonus.n != null ? `split ${wins.bonus.n} ways` : '— pays tonight to everyone working today'}` }] : []),
    // Closed revenue has no faster source than the company board's day tier.
    ...(co?.feed || []).filter(f => f.kind === 'invoice').map(f => ({ id: `inv-${f.at}-${f.amount}`, kind: 'invoice', at: f.at,
      line: `${f.who || 'The team'} closed ${fmtMoney(f.amount)} in revenue`, sub: f.text || '' })),
  ].filter(x => x.at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 40), [ceo, sales, wins, co])
  // Anything that arrives after the first load gets a brief highlight.
  for (const it of stream) if (!seenRef.current.has(it.id)) seenRef.current.set(it.id, Date.now())
  const isFresh = (id) => {
    const t = seenRef.current.get(id)
    return t - mountedAt.current > 20_000 && Date.now() - t < 45_000
  }
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
  // Month health: share of budget banked vs share of the month's selling days gone.
  const pctBudget = budget && mtdRev != null ? mtdRev / budget.amount : null
  const pctTime = budget ? (budget.effMonth - budget.effLeft) / budget.effMonth : null
  const onPace = pctBudget != null && pctTime != null && pctBudget >= pctTime

  const cell = (v, isMax, fmt = fmtN, color) => (
    <td style={{ padding:'6px 7px', textAlign:'right', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap',
      fontWeight: isMax ? 800 : 500, color: isMax ? (color || C.text) : C.muted, fontSize: isMax ? 16 : 15 }}>
      {fmt(v)}
    </td>
  )
  const th = (label, right = true) => (
    <th style={{ padding:'4px 7px', textAlign: right ? 'right' : 'left', fontSize:10, fontWeight:700, letterSpacing:1, color:C.dim, textTransform:'uppercase', whiteSpace:'nowrap' }}>{label}</th>
  )
  const feedRow = (key, kind, line, sub, fresh) => {
    const st = FEED_STYLE[kind] || FEED_STYLE.sale
    return (
      <div key={key} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 18px', borderBottom:`1px solid ${C.border}55`,
        background: fresh ? `${st.color}1A` : 'transparent', boxShadow: fresh ? `inset 3px 0 0 ${st.color}` : 'none', animation: fresh ? 'ceo-pop .8s ease-out' : 'none' }}>
        <span style={{ fontSize:10, fontWeight:800, letterSpacing:.8, color:st.color, background:`${st.color}1A`, border:`1px solid ${st.color}55`, borderRadius:6, padding:'3px 7px', flexShrink:0 }}>{st.tag}</span>
        <div style={{ minWidth:0, flex:1 }}>
          <div style={{ fontSize:14, fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{line}</div>
          <div style={{ fontSize:11.5, color:C.dim, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', marginTop:1 }}>{sub}</div>
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
    <div ref={rootRef} style={{ width:'100vw', height:'100vh', background:C.bg, overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center' }}>
    <div style={{ width:DESIGN_W, height:DESIGN_H, zoom:scale, flexShrink:0, boxSizing:'border-box', color:C.text, padding:'14px 20px', display:'flex', flexDirection:'column', gap:12, overflow:'hidden', fontFamily:'inherit' }}>

      {/* Header — same construction as the department boards */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:16, flexShrink:0, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <span className="pulse-mark" style={{ width:40, height:40, borderRadius:11, background:'#0b0c0f', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 6px 18px rgba(255,117,31,.15)', flexShrink:0 }}>
            <svg width="26" height="26" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
              <polyline points="9,32 19,32 25,17 33,47 40,26 45,32 55,32" fill="none" stroke="#ff751f" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          <span style={{ fontSize:21, fontWeight:800, letterSpacing:.3, whiteSpace:'nowrap' }}>CEO</span>
          <span style={{ fontSize:12, color:C.muted, letterSpacing:1, textTransform:'uppercase' }}>Executive board</span>
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
          <WeatherStrip dark />
          {co?.updatedAt && <span style={{ fontSize:11, color:C.dim, whiteSpace:'nowrap' }}>Updated {timeAgo(co.updatedAt)}</span>}
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
            <div style={{ fontSize:30, fontWeight:800, letterSpacing:-1, color:C.blue, fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>
              {fmtTime(time, { hour:'2-digit', minute:'2-digit', second:'2-digit' })}
            </div>
            <div style={{ fontSize:12, color:C.muted }}>{fmtDate(time, { weekday:'long', month:'long', day:'numeric' })}</div>
          </div>
        </div>
      </div>

      {/* Daily / Monthly / Yearly strip — identical to the company board */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:12, flexShrink:0 }}>
        <PeriodPanel title="Today" d={co?.daily} accent={C.green} />
        <PeriodPanel title="This month" d={co?.monthly} accent={CEO_COLOR} />
        <PeriodPanel title="This year" d={co?.yearly} accent={C.blue} />
      </div>

      {/* Executive strip: pacing · true GM · call center */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:12, flexShrink:0 }}>
        <Panel title="Pacing — run rate" accent={C.blue}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:'10px 8px' }}>
            <Stat big label="Year lands" value={fmtMoneyC(slow?.pacing?.yearProj)} color={C.blue} />
            <Stat label="vs last year" value={slow?.pacing?.yoy != null ? (slow.pacing.yoy >= 0 ? '+' : '') + slow.pacing.yoy + '%' : '—'} color={C.green} />
            <Stat label="Month lands" value={fmtMoneyC(slow?.pacing?.monthProj)} color={C.blue} />
            <Stat label="Last year total" value={fmtMoneyC(slow?.pacing?.prevYearTotal)} />
          </div>
        </Panel>
        <Panel title={`True GM — ${gm?.month || 'month'}`} accent={C.amber}>
          <div style={{ display:'grid', gridTemplateColumns:'1.15fr 1fr 1fr', gap:'10px 8px', alignItems:'center' }}>
            {/* Company spans both rows as the headline; the four trades sit 2×2 beside it. */}
            <div style={{ gridRow:'1 / span 2', minWidth:0 }}>
              <div style={{ fontSize:58, fontWeight:800, color:gmCol(gm?.company), letterSpacing:-2, lineHeight:1, fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>
                {gm?.company != null ? gm.company + '%' : '—'}
              </div>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:1, color:C.muted, textTransform:'uppercase', marginTop:6 }}>Company</div>
            </div>
            {['HVAC', 'Plumbing', 'Electrical', 'Garage Doors'].map(t => (
              <Stat key={t} label={t === 'Garage Doors' ? 'Garage' : t} value={gm?.byTrade?.[t] != null ? gm.byTrade[t] + '%' : '—'} color={gmCol(gm?.byTrade?.[t])} />
            ))}
          </div>
        </Panel>
        <Panel title="Call center — today" accent={C.green}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:'10px 8px' }}>
            <Stat big label="Booking rate" value={fast?.booking?.pct != null ? fast.booking.pct + '%' : '—'} color={C.green} />
            <Stat label="Booked / lead calls" value={`${fmtN(fast?.booking?.booked)} / ${fmtN(fast?.booking?.leadCalls)}`} />
            <Stat label="CSR outbounds" value={fmtN(fast?.csrOutbounds)} color={C.blue} />
            <Stat label="Missed lead calls" value={fmtN(fast?.missed)} color={fast?.missed ? C.red : C.muted} />
          </div>
        </Panel>
      </div>

      {/* Month chart + leads & opportunities + rankings (left) · live feed (right).
          The row grows to its content so auto-fit sees any overflow; the feed
          is absolutely placed so its length never sets the row height. */}
      <div style={{ display:'flex', gap:12, flex:'1 1 0', minHeight:0 }}>
        <div style={{ flex:1.65, display:'flex', flexDirection:'column', gap:12, minWidth:0, minHeight:0 }}>
          <div style={{ display:'flex', gap:12, flex:'1 1 0', minHeight:0 }}>
            <Panel title={`${fmtDate(time, { month:'long' })} — revenue & leads per day vs budget`} accent={C.green} style={{ flex:2.4 }}>
              {budget && mtdRev != null && (
                <div style={{ display:'flex', gap:22, flexWrap:'wrap', alignItems:'baseline', marginTop:-4, marginBottom:6, fontSize:13, color:C.muted }}>
                  <span>Budget <b style={{ color:C.text }}>{fmtMoneyC(budget.amount)}</b></span>
                  <span>MTD <b style={{ color:C.text }}>{fmtMoneyC(mtdRev)}</b></span>
                  <span><b style={{ color: onPace ? C.green : C.amber }}>{Math.round(pctBudget * 100)}% of budget</b> with {Math.round(pctTime * 100)}% of the month gone</span>
                  {need > 0
                    ? <span>Need <b style={{ color: need > budget.perDay ? C.red : C.green }}>{fmtK(need)}/day</b> · {budget.effLeft} selling days left</span>
                    : <b style={{ color:C.green }}>Budget hit</b>}
                </div>
              )}
              <div ref={chartRef} style={{ flex:1, minHeight:0 }}>
                {daily?.ready
                  ? <MonthCharts month={daily.month} budget={budget} need={need} leadGoal={leadGoal} aspect={chartAspect} />
                  : <div style={{ color:C.dim, fontSize:13 }}>Building this month's daily history — first load takes a few minutes…</div>}
              </div>
            </Panel>
            <Panel title="Leads & opportunities — today" accent={C.amber} style={{ flex:1 }}>
              <div style={{ display:'flex', alignItems:'baseline', gap:10 }}>
                <Stat big label={`Leads · goal ${leadGoal}`} value={fmtN(leadsToday)} color={(leadsToday || 0) >= leadGoal ? C.green : C.amber} />
              </div>
              <div style={{ height:9, borderRadius:5, background:C.panel2, margin:'8px 0' }}>
                <div style={{ height:'100%', width:`${leadPct}%`, borderRadius:5, background: leadPct >= 100 ? C.green : C.amber }} />
              </div>
              <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
                {['HVAC', 'Plumbing', 'Electrical', 'Garage Doors'].map(t => <Stat key={t} label={TRADE_SHORT[t]} value={fmtN(fast?.leadsByTrade?.[t] || 0)} />)}
              </div>

              <div style={{ borderTop:`1px solid ${C.border}`, margin:'12px 0 10px' }} />
              <div style={{ display:'flex', alignItems:'baseline', gap:18 }}>
                <Stat big label={oppGoal ? `Opportunities · goal ${oppGoal}` : 'Opportunities · closed day'} value={fmtN(oppTotal)} color={oppCol} />
                {ceo?.week?.opps != null && <Stat label={`This week · goal ${ceo.week.oppsGoal}`} value={fmtN(ceo.week.opps)} color={C.purple} />}
              </div>
              <div style={{ height:9, borderRadius:5, background:C.panel2, margin:'8px 0' }}>
                <div style={{ height:'100%', width:`${oppPct}%`, borderRadius:5, background:oppCol }} />
              </div>
              <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
                {['HVAC', 'Plumbing', 'Electrical'].map(t => <Stat key={t} label={TRADE_SHORT[t]} value={fmtN(fast?.opps?.byTrade?.[t] || 0)} />)}
                <Stat label="GAR · not in goal" value={fmtN(fast?.opps?.byTrade?.['Garage Doors'] || 0)} color={C.muted} />
              </div>

              <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8, marginTop:'auto', paddingTop:12, borderTop:`1px solid ${C.border}` }}>
                <Stat label="Leads 30-day avg" value={daily?.leads?.avg30 != null ? daily.leads.avg30.toFixed(1) : '—'} />
                <Stat label="vs goal" value={signPct(daily?.leads?.vsGoal)} color={(daily?.leads?.vsGoal ?? 0) >= 0 ? C.green : C.red} />
                <Stat label="vs last year" value={signPct(daily?.leads?.vsLy)} color={(daily?.leads?.vsLy ?? 0) >= 0 ? C.green : C.red} />
              </div>
            </Panel>
          </div>
          <div style={{ display:'flex', gap:12, flexShrink:0 }}>
          <Panel title={`Top 5 techs — ${fmtDate(time, { month:'long' })} · composite score`} accent={C.green} style={{ flex:1 }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead><tr>{th('#', false)}{th('Technician', false)}{th('Score')}{th('Sold')}{th('Avg')}{th('Close')}{th('5★')}{th('Clubs')}{th('YTD')}</tr></thead>
              <tbody>
                {techs.map((x, i) => (
                  <tr key={x.id || i} style={{ borderBottom:`1px solid ${C.border}`, background: i === 0 ? `${CEO_COLOR}14` : 'transparent' }}>
                    <td style={{ padding:'5px 4px', width:30 }}><RankBadge i={i} /></td>
                    <td style={{ padding:'5px 6px', fontWeight:700, whiteSpace:'nowrap', fontSize:15 }}>
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
          <Panel title={`Top 5 CSRs — ${fmtDate(time, { month:'long' })} · composite score`} accent={C.blue} style={{ flex:1 }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead><tr>{th('#', false)}{th('CSR', false)}{th('Score')}{th('Booked')}{th('Book %')}{th('Calls')}{th('Outb.')}{th('Clubs')}{th('QA')}</tr></thead>
              <tbody>
                {csrs.map((x, i) => (
                  <tr key={x.name} style={{ borderBottom:`1px solid ${C.border}`, background: i === 0 ? `${C.blue}12` : 'transparent' }}>
                    <td style={{ padding:'5px 4px', width:30 }}><RankBadge i={i} /></td>
                    <td style={{ padding:'5px 6px', fontWeight:700, fontSize:15, whiteSpace:'nowrap' }}>{x.name}</td>
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
        </div>

        <div style={{ flex:.62, minWidth:320, display:'flex', flexDirection:'column', minHeight:0 }}>
          {/* Live feed — the company board's feed, with money left on the table pinned on top */}
          <div style={{ flex:1, position:'relative', minHeight:0 }}>
            <div style={{ position:'absolute', inset:0, background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, overflow:'hidden', display:'flex', flexDirection:'column' }}>
              <div style={{ padding:'13px 18px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
                <span style={{ fontSize:15, fontWeight:800, letterSpacing:.5 }}>Today's Activity</span>
                <span style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6, fontSize:10, fontWeight:800, letterSpacing:1.2, color:C.green }}>
                  <span style={{ width:8, height:8, borderRadius:'50%', background:C.green, animation:'wr-pulse 1.5s infinite' }} />LIVE
                </span>
              </div>
              <div style={{ flex:1, overflow:'hidden', padding:'4px 0 8px' }}>
                {stream.map(it => feedRow(it.id, it.kind, it.line, [it.sub, timeAgo(it.at)].filter(Boolean).join(' · '), isFresh(it.id)))}
                {!stream.length && (
                  <div style={{ padding:24, textAlign:'center', color:C.dim, fontSize:13 }}>Nothing yet today — first win lands here.</div>
                )}
              </div>
            </div>
          </div>

        </div>
      </div>
      <style>{`
        @keyframes wr-pulse { 0%,100%{opacity:1} 50%{opacity:.25} }
        @keyframes ceo-pop { from { transform: translateX(14px); opacity: 0 } to { transform: none; opacity: 1 } }
      `}</style>
    </div>
    </div>
  )
}
