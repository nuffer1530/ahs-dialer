import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useWallboard } from '../lib/useDailyReload'
import { fmtTime, fmtDate } from '../lib/denver'
import WeatherStrip from '../components/WeatherStrip'

// CEO board (/tv/ceo) — Brandyn's office TV, in the same visual language as
// the department boards: pulse-mark header, period strip, ranking tables,
// feed chips. Adds the executive layer: run-rate pacing, job-matched true GM,
// opportunities and leads vs goal, weekly trend lines, and a rich live feed.
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

const FEED_STYLE = {
  sold:      { tag:'SOLD',   color:C.green },
  booked:    { tag:'BOOKED', color:C.blue },
  missed:    { tag:'MISSED', color:C.red },
  quote:     { tag:'QUOTE',  color:C.amber },
  invoice:   { tag:'REV',    color:'#39C5CF' },
  review:    { tag:'5★',     color:C.amber },
  lowreview: { tag:'REVIEW', color:C.red },
  club:      { tag:'CLUB',   color:C.purple },
}

// Weekly trends: 13 closed weeks + this week's pace, the same weeks last year
// dashed behind, and a goal line where one exists. Weekly (not daily) buckets
// strip out day-of-week noise so direction is readable from across the room.
const fmtK = (n) => n == null ? '—' : Math.abs(n) >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1000 ? '$' + Math.round(n / 1000) + 'k' : '$' + Math.round(n)
const md = (d) => d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : ''

function Delta({ v, label }) {
  if (v == null || !isFinite(v)) return null
  const up = v >= 0
  return (
    <span style={{ fontSize:11, fontWeight:800, color: up ? C.green : C.red, background: `${up ? C.green : C.red}14`, border:`1px solid ${up ? C.green : C.red}44`, borderRadius:6, padding:'1px 6px', whiteSpace:'nowrap' }}>
      {up ? '▲' : '▼'} {Math.abs(Math.round(v * 100))}% <span style={{ color:C.muted, fontWeight:600 }}>{label}</span>
    </span>
  )
}

function MiniTrend({ title, color, weeks, field, fmt, goal }) {
  const n = weeks.length
  const vals = weeks.map(w => (w.current ? null : (w[field] ?? null)))
  const lys = weeks.map(w => w.ly?.[field] ?? null)
  const cur = weeks[n - 1]
  const pace = cur?.pace?.[field] ?? null
  let lastIdx = -1
  vals.forEach((v, i) => { if (v != null) lastIdx = i })
  const have = vals.filter(v => v != null)
  if (have.length < 3) return <div style={{ color:C.dim, fontSize:12, padding:8 }}>{title}: building history…</div>
  const last = vals[lastIdx]
  const prior4 = vals.slice(Math.max(0, lastIdx - 4), lastIdx).filter(v => v != null)
  const avg4 = prior4.length ? prior4.reduce((a, b) => a + b, 0) / prior4.length : null
  const lyLast = lys[lastIdx]
  const W = 330, H = 150, L = 8, R = 10, T = 18, B = 20
  const top = Math.max(...have, ...lys.filter(v => v != null), pace || 0, goal || 0) * 1.14 || 1
  const x = (i) => L + i * (W - L - R) / (n - 1)
  const y = (v) => T + (H - T - B) * (1 - v / top)
  const pts = vals.map((v, i) => v == null ? null : [x(i), y(v)]).filter(Boolean)
  const lyPts = lys.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(' ')
  let maxI = -1, minI = -1
  vals.forEach((v, i) => {
    if (v == null) return
    if (maxI < 0 || v > vals[maxI]) maxI = i
    if (minI < 0 || v < vals[minI]) minI = i
  })
  const labelAt = (i, below) => {
    const v = vals[i]
    const ax = Math.min(W - 4, Math.max(20, x(i)))
    return <text key={`l${i}`} x={ax} y={below ? y(v) + 14 : y(v) - 7} fontSize="11" fontWeight="800" fill={i === lastIdx ? C.text : C.muted} textAnchor={i === lastIdx ? 'end' : 'middle'}>{fmt(v)}</text>
  }
  return (
    <div style={{ minWidth:0, display:'flex', flexDirection:'column' }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:8, flexWrap:'wrap' }}>
        <span style={{ fontSize:11, fontWeight:800, letterSpacing:1, color, textTransform:'uppercase' }}>{title}</span>
        <span style={{ fontSize:'clamp(15px, 1.6vw, 21px)', fontWeight:800, fontVariantNumeric:'tabular-nums' }}>{fmt(last)}</span>
        <span style={{ fontSize:10, color:C.dim }}>wk of {md(weeks[lastIdx]?.mon)}</span>
      </div>
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', margin:'4px 0 2px' }}>
        <Delta v={avg4 ? last / avg4 - 1 : null} label="vs 4-wk avg" />
        <Delta v={lyLast ? last / lyLast - 1 : null} label="vs last yr" />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', flex:1, minHeight:0 }} preserveAspectRatio="none">
        {goal ? <>
          <line x1={L} x2={W - R} y1={y(goal)} y2={y(goal)} stroke={C.amber} strokeWidth="1.4" strokeDasharray="5 4" />
          <text x={L + 2} y={y(goal) - 4} fontSize="10" fill={C.amber} fontWeight="700">goal {fmt(goal)}</text>
        </> : null}
        {lyPts && <polyline points={lyPts} fill="none" stroke={C.dim} strokeWidth="1.6" strokeDasharray="4 4" />}
        <polyline points={pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')} fill="none" stroke={color} strokeWidth="2.6" strokeLinejoin="round" />
        {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="2.6" fill={color} />)}
        {pace != null && lastIdx >= 0 && <>
          <line x1={x(lastIdx)} y1={y(last)} x2={x(n - 1)} y2={y(pace)} stroke={color} strokeWidth="2" strokeDasharray="3 3" />
          <circle cx={x(n - 1)} cy={y(pace)} r="4" fill={C.panel} stroke={color} strokeWidth="2" />
          <text x={x(n - 1) - 2} y={y(pace) + (pace > last ? -8 : 15)} fontSize="10.5" fill={color} fontWeight="800" textAnchor="end">pace {fmt(pace)}</text>
        </>}
        {maxI >= 0 && maxI !== lastIdx && labelAt(maxI, false)}
        {minI >= 0 && minI !== lastIdx && minI !== maxI && labelAt(minI, true)}
        {labelAt(lastIdx, last < (vals[lastIdx - 1] ?? last))}
        {[0, Math.floor((n - 2) / 2), n - 2].map(i => <text key={`x${i}`} x={x(i)} y={H - 4} fontSize="10" fill={C.dim} textAnchor={i === 0 ? 'start' : 'middle'}>{md(weeks[i]?.end)}</text>)}
        <text x={x(n - 1)} y={H - 4} fontSize="10" fill={C.dim} textAnchor="end">now</text>
      </svg>
    </div>
  )
}

function TrendPanel({ trend, compact }) {
  const weeks = trend?.weeks || []
  const ready = (trend?.ready || 0) >= 4
  return (
    <Panel title="Trends — weekly, last 13 weeks · dashed gray = same weeks last year · hollow dot = this week's pace" accent={C.orange} compact={compact} style={{ flex:'1 1 auto', minHeight:230 }}>
      {ready ? (
        <div style={{ flex:1, minHeight:0, display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:18 }}>
          <MiniTrend title="Revenue" color={C.blue} weeks={weeks} field="rev" fmt={fmtK} />
          <MiniTrend title="Sales" color={C.green} weeks={weeks} field="sales" fmt={fmtK} />
          <MiniTrend title="Leads" color={C.amber} weeks={weeks} field="leads" fmt={fmtN} goal={trend?.goals?.leadsWeek} />
          <MiniTrend title="Opportunities" color={C.purple} weeks={weeks} field="opps" fmt={fmtN} goal={trend?.goals?.oppsWeek} />
        </div>
      ) : (
        <div style={{ color:C.dim, fontSize:13 }}>Building trend history — the first load pulls 28 weeks from ServiceTitan (a few minutes); after that it's cached and only the current week refreshes.</div>
      )}
    </Panel>
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
      if (need > have + 4) setFit(f => Math.max(0.55, +((f * have) / need).toFixed(3)))
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

  const fast = ceo?.fast, slow = ceo?.slow, trend = ceo?.trend, goals = ceo?.goals
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
  const feed = fast?.feed || []
  const sum = fast?.summary
  const oppGoal = goals?.oppsToday ?? 33
  const oppTotal = fast?.opps?.total
  const oppPct = oppGoal > 0 && oppTotal != null ? Math.min(100, Math.round(oppTotal / oppGoal * 100)) : 0
  const oppCol = oppGoal === 0 ? C.muted : oppPct >= 100 ? C.green : oppPct >= 70 ? C.amber : C.red
  const curWeek = trend?.weeks?.[trend.weeks.length - 1]
  const leadGoal = goals?.leadsPerDay ?? 43
  const gmCol = (v) => v == null ? C.dim : v >= 50 ? C.green : v >= 42 ? C.amber : C.red

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
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:'10px 8px' }}>
            <Stat big label="Company" value={gm?.company != null ? gm.company + '%' : '—'} color={gmCol(gm?.company)} />
            <Stat label="HVAC" value={gm?.byTrade?.HVAC != null ? gm.byTrade.HVAC + '%' : '—'} color={gmCol(gm?.byTrade?.HVAC)} />
            <Stat label="Plumbing" value={gm?.byTrade?.Plumbing != null ? gm.byTrade.Plumbing + '%' : '—'} color={gmCol(gm?.byTrade?.Plumbing)} />
            <Stat label="Electrical" value={gm?.byTrade?.Electrical != null ? gm.byTrade.Electrical + '%' : '—'} color={gmCol(gm?.byTrade?.Electrical)} />
          </div>
        </Panel>
        <Panel title="Call center — today" accent={C.green} compact={narrow}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:'10px 8px' }}>
            <Stat big label="Booking rate" value={fast?.booking?.pct != null ? fast.booking.pct + '%' : '—'} color={C.green} />
            <Stat label="Booked / lead calls" value={`${fmtN(fast?.booking?.booked)} / ${fmtN(fast?.booking?.leadCalls)}`} />
            <Stat label="CSR outbounds" value={fmtN(fast?.csrOutbounds)} color={C.blue} />
            <Stat label={`Leads · goal ${leadGoal}`} value={fmtN(fast?.leads)} color={(fast?.leads || 0) >= leadGoal ? C.green : C.amber} />
          </div>
        </Panel>
        <Panel title={oppGoal ? `Opportunities — goal ${oppGoal} today` : 'Opportunities — closed day'} accent={C.purple} compact={narrow}>
          <div style={{ display:'flex', alignItems:'baseline', gap:14 }}>
            <Stat big label="Ran today · 3 trades" value={fmtN(oppTotal)} color={oppCol} />
            {curWeek?.opps != null && <Stat label={`This week · goal ${trend?.goals?.oppsWeek ?? ''}`} value={fmtN(curWeek.opps)} color={C.purple} />}
          </div>
          <div style={{ height:9, borderRadius:5, background:C.panel2, margin:'8px 0' }}>
            <div style={{ height:'100%', width:`${oppPct}%`, borderRadius:5, background:oppCol }} />
          </div>
          <div style={{ display:'flex', gap:14 }}>
            {['HVAC', 'Plumbing', 'Electrical'].map(t => <Stat key={t} label={TRADE_SHORT[t]} value={fmtN(fast?.opps?.byTrade?.[t] || 0)} />)}
          </div>
        </Panel>
      </div>

      {/* Trends + rankings (left) · live feed (right). The row grows to its
          content so auto-fit can see overflow; the feed is absolutely placed
          so its length never sets the row height. */}
      <div style={{ display:'flex', flexDirection: narrow ? 'column' : 'row', gap: narrow ? 10 : 12, flex:'1 0 auto' }}>
        <div style={{ flex:1.65, display:'flex', flexDirection:'column', gap: narrow ? 10 : 12, minWidth:0 }}>
          <TrendPanel trend={trend} compact={narrow} />
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

        {/* Live feed — who did what, on which job, in which trade, when */}
        <div style={{ flex:.62, minWidth: narrow ? 0 : 300, position:'relative', minHeight: narrow ? 420 : 0 }}>
          <Panel title="Today — live" accent={C.green} compact={narrow} style={{ position:'absolute', inset:0 }}>
            {sum && (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:'8px 10px', paddingBottom:10, marginBottom:6, borderBottom:`1px solid ${C.border}` }}>
                <Stat label={`Sold · ${fmtK(sum.soldAmt)}`} value={fmtN(sum.sold)} color={C.green} />
                <Stat label="Booked" value={fmtN(sum.booked)} color={C.blue} />
                <Stat label="Missed" value={fmtN(sum.missed)} color={sum.missed ? C.red : C.muted} />
                <Stat label={`Open quotes · ${fmtK(sum.quoteAmt)}`} value={fmtN(sum.quotes)} color={C.amber} />
                <Stat label="Clubs" value={fmtN(sum.clubs)} color={C.purple} />
                <Stat label="5★ reviews" value={fmtN(sum.fiveStar)} color={C.amber} />
              </div>
            )}
            <div style={{ flex:1, minHeight:0, overflow:'hidden' }}>
              {feed.map((f, i) => {
                const st = FEED_STYLE[f.kind] || FEED_STYLE.sold
                return (
                  <div key={i} style={{ padding:'6px 0', borderBottom:`1px solid ${C.border}`, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, minWidth:0 }}>
                      <span style={{ fontSize:9, fontWeight:800, letterSpacing:.6, color:st.color, border:`1px solid ${st.color}55`, background:`${st.color}14`, borderRadius:5, padding:'2px 6px', flexShrink:0, minWidth:44, textAlign:'center' }}>{st.tag}</span>
                      {f.amount != null && <b style={{ color:st.color, fontSize:'clamp(12px, 1.2vw, 14px)', fontVariantNumeric:'tabular-nums', flexShrink:0 }}>{fmtMoney(f.amount)}</b>}
                      <span style={{ fontSize:'clamp(11px, 1.1vw, 13px)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', flex:1, minWidth:0 }}>{f.title}</span>
                      <span style={{ fontSize:10, color:C.dim, flexShrink:0, fontVariantNumeric:'tabular-nums' }}>{f.at ? fmtTime(f.at, { hour:'numeric', minute:'2-digit' }) : ''}</span>
                    </div>
                    <div style={{ fontSize:10.5, color:C.muted, marginTop:2, paddingLeft:52, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                      {[f.who, f.trade ? TRADE_SHORT[f.trade] || f.trade : null, f.sub].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                )
              })}
              {!feed.length && <div style={{ color:C.dim, fontSize:13 }}>{fast ? 'Quiet so far today…' : 'Loading today…'}</div>}
            </div>
            <div style={{ fontSize:9.5, color:C.dim, marginTop:6, lineHeight:1.5 }}>
              Opps goal 33/day = 2027 $20.5M plan ÷ 281 effective days (Sat = ½) ÷ ~$2,224/opp (+6% price, 70% close) · 3 trades, ex-garage · Leads = new demand jobs (Meghan's definition) · GM = revenue − job POs − ADP-burdened field labor
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
