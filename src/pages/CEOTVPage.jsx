import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useWallboard } from '../lib/useDailyReload'
import { fmtTime, fmtDate } from '../lib/denver'
import WeatherStrip from '../components/WeatherStrip'

// CEO board (/tv/ceo) — Brandyn's office TV, in the same visual language as
// the department boards: pulse-mark header, period strip, ranking tables,
// feed chips. Adds the executive layer: run-rate pacing, true burdened GM,
// opportunities-vs-goal, lead calls, Path-of-the-Year chart.
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
  sale:       { tag:'SALE', color:C.green },
  review:     { tag:'5★',   color:C.amber },
  membership: { tag:'CLUB', color:C.purple },
  invoice:    { tag:'REV',  color:C.blue },
}

// Path of the Year: monthly bars, booked → projected, prior-year dots.
function YearChart({ slow }) {
  if (!slow?.months) return <div style={{ color:C.dim, fontSize:13 }}>Building the year — the first load pulls 20 months of history…</div>
  const now = new Date()
  const curY = now.getFullYear(), curM = now.getMonth() + 1
  const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0)
  const bars = []
  for (let m = 1; m <= 12; m++) {
    const actual = m < curM ? sum(slow.months[ym(curY, m)]) : m === curM ? sum(slow.mtd) : 0
    const proj = m >= curM ? (slow.projMonths?.[ym(curY, m)] || 0) : 0
    bars.push({ m, actual, proj, prior: sum(slow.months[ym(curY - 1, m)]) })
  }
  const mx = Math.max(...bars.map(b => Math.max(b.actual, b.proj, b.prior)), 1) * 1.22
  const W = 1000, H = 232, BW = 54, GAP = (W - 60 - 12 * BW) / 11
  const x = (i) => 40 + i * (BW + GAP)
  const y = (v) => 198 - (v / mx) * 168
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', height:'100%' }} preserveAspectRatio="xMidYMid meet">
      <line x1="30" y1="198" x2={W - 5} y2="198" stroke={C.border} />
      {bars.map((b, i) => (
        <g key={b.m}>
          {b.m < curM && b.actual > 0 && <>
            <rect x={x(i)} y={y(b.actual)} width={BW} height={198 - y(b.actual)} fill={C.green} rx="3" />
            <text x={x(i) + BW / 2} y={y(b.actual) - 6} fontSize="12" fill={C.text} textAnchor="middle" fontWeight="700" fontVariantNumeric="tabular-nums">{Math.round(b.actual / 1000)}</text>
          </>}
          {b.m === curM && <>
            {b.actual > 0 && <rect x={x(i)} y={y(b.actual)} width={BW} height={198 - y(b.actual)} fill={C.green} rx="3" />}
            {b.proj > b.actual && <rect x={x(i)} y={y(b.proj)} width={BW} height={y(b.actual) - y(b.proj)} fill={`${C.green}44`} stroke={C.green} strokeDasharray="4 3" rx="3" />}
            <text x={x(i) + BW / 2} y={y(Math.max(b.proj, b.actual)) - 6} fontSize="12" fill="#7EE2A8" textAnchor="middle" fontWeight="700">→{Math.round(Math.max(b.proj, b.actual) / 1000)}</text>
          </>}
          {b.m > curM && b.proj > 0 && <>
            <rect x={x(i)} y={y(b.proj)} width={BW} height={198 - y(b.proj)} fill={C.panel2} stroke={C.blue} strokeDasharray="4 3" rx="3" />
            <text x={x(i) + BW / 2} y={y(b.proj) - 6} fontSize="12" fill="#8FC1FF" textAnchor="middle" fontWeight="700">{Math.round(b.proj / 1000)}</text>
          </>}
          {b.prior > 0 && <circle cx={x(i) + BW / 2} cy={y(b.prior)} r="4" fill={C.dim} />}
          <text x={x(i) + BW / 2} y="216" fontSize="11" fill={C.muted} textAnchor="middle">{names[b.m - 1]}</text>
        </g>
      ))}
      <g>
        <rect x={W - 252} y="6" width="247" height="42" rx="9" fill={C.panel2} stroke={C.blue} />
        <text x={W - 128} y="24" fontSize="14" fill="#8FC1FF" textAnchor="middle" fontWeight="800">
          YEAR LANDS: {fmtMoneyC(slow.pacing?.yearProj)} ({slow.pacing?.yoy >= 0 ? '+' : ''}{slow.pacing?.yoy}%)
        </text>
        <text x={W - 128} y="40" fontSize="10.5" fill={C.muted} textAnchor="middle">solid = booked · dashed = projected · dots = last year · $k</text>
      </g>
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
  const [fit, setFit] = useState(1)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const t = setTimeout(() => {
      const need = el.scrollHeight, have = el.clientHeight
      if (need > have + 4) setFit(f => Math.max(0.6, +((f * have) / need).toFixed(3)))
    }, 250)
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

  const fast = ceo?.fast, slow = ceo?.slow
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
  const csrMax = useMemo(() => ({
    score: Math.max(0, ...csrs.map(x => x.score || 0)), booked: Math.max(0, ...csrs.map(x => x.booked || 0)),
    rate: Math.max(0, ...csrs.map(x => x.rate || 0)), leadCalls: Math.max(0, ...csrs.map(x => x.leadCalls || 0)),
    clubs: Math.max(0, ...csrs.map(x => x.clubs || 0)), qa: Math.max(0, ...csrs.map(x => x.qa || 0)),
  }), [csrs])
  const feed = (co?.feed || []).slice(0, 8)
  const oppGoal = fast?.opps?.goal || 33
  const oppPct = fast?.opps ? Math.min(100, Math.round(fast.opps.total / oppGoal * 100)) : 0
  const gmCol = (v) => v == null ? C.dim : v >= 50 ? C.green : v >= 42 ? C.amber : C.red

  const cell = (v, isMax, fmt = fmtN, color) => (
    <td style={{ padding: narrow ? '4px 8px' : '7px 9px', textAlign:'right', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap',
      fontWeight: isMax ? 800 : 500, color: isMax ? (color || C.text) : C.muted,
      fontSize: isMax ? 'clamp(13px, 1.4vw, 16px)' : 'clamp(12px, 1.3vw, 14px)' }}>
      {fmt(v)}
    </td>
  )
  const th = (label, right = true) => (
    <th style={{ padding: narrow ? '5px 8px' : '7px 9px', textAlign: right ? 'right' : 'left', fontSize:10, fontWeight:700, letterSpacing:1, color:C.dim, textTransform:'uppercase', whiteSpace:'nowrap' }}>{label}</th>
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
            <Stat label="Booked / leads" value={`${fmtN(fast?.booking?.booked)} / ${fmtN(fast?.booking?.leadCalls)}`} />
            <Stat label="CSR outbounds" value={fmtN(fast?.csrOutbounds)} color={C.blue} />
            <Stat label="Lead calls · goal" value={`${fmtN(fast?.leads?.total)} / ${fast?.leads?.goal || 43}`} color={(fast?.leads?.total || 0) >= (fast?.leads?.goal || 43) ? C.green : C.amber} />
          </div>
        </Panel>
        <Panel title={`Opportunities — goal ${oppGoal}`} accent={C.purple} compact={narrow}>
          <Stat big label="Ran today" value={fmtN(fast?.opps?.total)} color={oppPct >= 100 ? C.green : oppPct >= 70 ? C.amber : C.red} />
          <div style={{ height:9, borderRadius:5, background:C.panel2, margin:'8px 0' }}>
            <div style={{ height:'100%', width:`${oppPct}%`, borderRadius:5, background: oppPct >= 100 ? C.green : oppPct >= 70 ? C.amber : C.red }} />
          </div>
          <div style={{ display:'flex', gap:14 }}>
            {['HVAC', 'Plumbing', 'Electrical'].map(t => <Stat key={t} label={TRADE_SHORT[t]} value={fmtN(fast?.opps?.byTrade?.[t] || 0)} />)}
          </div>
        </Panel>
      </div>

      {/* The year + rankings + feed */}
      <div style={{ display:'flex', flexDirection: narrow ? 'column' : 'row', gap: narrow ? 10 : 12, flex:1, minHeight:0 }}>
        <div style={{ flex:1.6, display:'flex', flexDirection:'column', gap: narrow ? 10 : 12, minWidth:0 }}>
          <Panel title="The year — booked → projected" accent={CEO_COLOR} compact={narrow} style={{ flex:1.1, minHeight:170 }}>
            <div style={{ flex:1, minHeight:0 }}><YearChart slow={slow} /></div>
          </Panel>
          <Panel title={`Top 5 techs — ${fmtDate(time, { month:'long' })}`} accent={C.green} compact={narrow} style={{ flex:1.2 }}>
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
          <Panel title={`Top 5 CSRs — ${fmtDate(time, { month:'long' })}`} accent={C.blue} compact={narrow} style={{ flex:1 }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead><tr>{th('#', false)}{th('CSR', false)}{th('Score')}{th('Booked')}{th('Book rate')}{th('Lead calls')}{th('Clubs')}{th('QA')}</tr></thead>
              <tbody>
                {csrs.map((x, i) => (
                  <tr key={x.name} style={{ borderBottom:`1px solid ${C.border}`, background: i === 0 ? `${C.blue}12` : 'transparent' }}>
                    <td style={{ padding:'3px 8px', width:30 }}><RankBadge i={i} /></td>
                    <td style={{ padding:'3px 8px', fontWeight:700, fontSize:'clamp(12px, 1.4vw, 15px)', whiteSpace:'nowrap' }}>{x.name}</td>
                    {cell(x.score, x.score === csrMax.score, fmtN, C.blue)}
                    {cell(x.booked, x.booked === csrMax.booked, fmtN, C.green)}
                    {cell(x.rate, x.rate === csrMax.rate, fmtPct, C.amber)}
                    {cell(x.leadCalls, x.leadCalls === csrMax.leadCalls)}
                    {cell(x.clubs, x.clubs === csrMax.clubs, fmtN, C.purple)}
                    {cell(x.qa, x.qa != null && x.qa === csrMax.qa, (v) => v == null ? '—' : Number(v).toFixed(1), C.amber)}
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>

        {/* Live feed — same chips as the department boards */}
        <div style={{ flex:.55, minWidth: narrow ? 0 : 250, display:'flex' }}>
          <Panel title="Today — live" accent={C.green} compact={narrow} style={{ flex:1 }}>
            <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column', gap:2 }}>
              {feed.map((f, i) => {
                const s = FEED_STYLE[f.kind] || FEED_STYLE.sale
                return (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 0', borderBottom:`1px solid ${C.border}`, minWidth:0 }}>
                    <span style={{ fontSize:9, fontWeight:800, letterSpacing:.6, color:s.color, border:`1px solid ${s.color}55`, background:`${s.color}14`, borderRadius:5, padding:'2px 6px', flexShrink:0 }}>{s.tag}</span>
                    <span style={{ fontSize:'clamp(11px, 1.1vw, 13px)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                      {f.kind === 'sale' && <><b style={{ color:C.green }}>{fmtMoney(f.amount)}</b>{f.who ? ` — ${f.who}` : ''}</>}
                      {f.kind === 'review' && <>{f.who}{f.text ? ` ${f.text}` : ''}</>}
                      {f.kind === 'membership' && <>{f.who || 'Club sold'}</>}
                      {f.kind === 'invoice' && <><b style={{ color:C.blue }}>{fmtMoney(f.amount)}</b>{f.who ? ` — ${f.who}` : ''}</>}
                    </span>
                  </div>
                )
              })}
              {!feed.length && <div style={{ color:C.dim, fontSize:13 }}>Quiet so far today…</div>}
            </div>
            <div style={{ fontSize:9.5, color:C.dim, marginTop:6, lineHeight:1.5 }}>
              GM = revenue − POs − burdened field labor · pacing = run rate × last year's seasonality · opps goal 33/effective day
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
