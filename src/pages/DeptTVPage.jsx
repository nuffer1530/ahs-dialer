import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useWallboard } from '../lib/useDailyReload'
import { fmtTime, fmtDate, bookedForLabel } from '../lib/denver'
import WeatherStrip from '../components/WeatherStrip'

// Department TV board — one per trade, hung in each manager's office.
// Daily / Monthly / Yearly department strip up top, the month's tech ranking
// (composite score) with YTD numbers below, and a dept-specific live feed.
// Data comes from /api/tv/department/:trade (ST-backed, tiered caches), so the
// board refreshes itself; ST can't stream, hence the "updated" stamp.

const C = {
  bg:'#0B0F14', panel:'#141A21', panel2:'#1B222B', border:'#252E38',
  text:'#E6EDF3', muted:'#8B949E', dim:'#6E7681',
  green:'#3FB950', blue:'#58A6FF', amber:'#D29922', red:'#F85149', purple:'#BC8CFF', orange:'#F0883E',
}

const TRADES = [
  { key:'company', label:'Company', color:'#FF751F' },
  { key:'hvac', label:'HVAC', color:'#F0883E' },
  { key:'plumbing', label:'Plumbing', color:'#58A6FF' },
  { key:'electrical', label:'Electrical', color:'#D29922' },
  { key:'garage', label:'Garage Doors', color:'#BC8CFF' },
]
const TRADE_SHORT = { 'HVAC':'HVAC', 'Plumbing':'PLB', 'Electrical':'ELE', 'Garage Doors':'GAR' }

const fmtMoney = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString()
// Strip stats on TV browsers (Fire TV Silk ≈ 960px CSS viewport) get tight
// columns — millions go compact so cells never overflow into each other.
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
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return fmtDate(iso, { month:'short', day:'numeric' })
}

function Stat({ label, value, color = C.text, big }) {
  return (
    <div style={{ minWidth:0 }}>
      <div style={{ fontSize: big ? 30 : 26, fontWeight:800, color, letterSpacing:-1, lineHeight:1.05, fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>{value}</div>
      <div style={{ fontSize:11, fontWeight:700, letterSpacing:1, color:C.muted, textTransform:'uppercase', marginTop:4 }}>{label}</div>
    </div>
  )
}

// Gold / silver / bronze chips for the podium; plain dim number below that.
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

function PeriodPanel({ title, d, accent, compact }) {
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderTop:`3px solid ${accent}`, borderRadius:14, padding: compact ? '9px 14px' : '14px 18px', minWidth:0 }}>
      <div style={{ fontSize: compact ? 11 : 12, fontWeight:800, letterSpacing:1.4, color:accent, textTransform:'uppercase', marginBottom: compact ? 7 : 12 }}>{title}</div>
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
    </div>
  )
}

// The board is laid out on a fixed 1920×1080 canvas and scaled to the screen
// (the CEO board's approach). The department TVs report ~960 CSS px, which
// used to force a one-line ticker for the feed; on the canvas the ranking and
// a full Live Activity panel sit side by side on every screen (Brandyn, Sep 24).
const DESIGN_W = 1920, DESIGN_H = 1080
const FEED_ROW_H = 64

const FEED_STYLE = {
  sale:       { tag:'SALE', color:C.green },
  review:     { tag:'5★',   color:C.amber },
  membership: { tag:'CLUB', color:C.purple },
  invoice:    { tag:'REV',  color:C.blue },
  booked:     { tag:'BOOKED', color:'#22D3EE' },
}

export default function DeptTVPage() {
  const { trade: tradeParam } = useParams()
  const navigate = useNavigate()
  const trade = TRADES.find(t => t.key === tradeParam) || TRADES[0]

  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [time, setTime] = useState(new Date())
  const rootRef = useRef(null)
  // Scale the 1920×1080 canvas to whatever box the page actually has (the
  // sidebar may be showing on a desktop; the wall TVs are full screen).
  const [box, setBox] = useState({ w: DESIGN_W, h: DESIGN_H })
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const scale = Math.max(0.2, Math.min(box.w / DESIGN_W, box.h / DESIGN_H))
  // Wall look survives reloads; the page updates itself when a build lands.
  const { isFull, toggleFull } = useWallboard(rootRef)

  // Live Activity shows exactly the rows that fit — nobody scrolls a wall TV.
  const feedRef = useRef(null)
  const [feedH, setFeedH] = useState(0)
  useEffect(() => {
    const el = feedRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setFeedH(e.contentRect.height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const feedFits = feedH ? Math.max(1, Math.floor(feedH / FEED_ROW_H)) : 10

  const load = useCallback(async () => {
    try {
      // useAuth exposes user/profile but not the session — get the token here.
      const { data: { session } } = await sb.auth.getSession()
      if (!session?.access_token) throw new Error('no session')
      const r = await fetch(`/api/tv/department/${trade.key}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      setData(j); setErr(null)
      return j
    } catch (e) { setErr(e.message); return null }
  }, [trade.key])

  useEffect(() => { setData(null); load() }, [load])
  useEffect(() => {
    let t
    const tick = async () => {
      const j = await load()
      // Server caches fill tier by tier on a cold start — poll fast until
      // whole; after that every 2 min so bookings land on the feed promptly.
      const whole = j && j.daily && j.monthly && j.yearly
      t = setTimeout(tick, whole ? 2 * 60_000 : 30_000)
    }
    t = setTimeout(tick, 30_000)
    return () => clearTimeout(t)
  }, [load])
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  // Company board shows the top 10 service techs; trade boards show everyone.
  const techs = useMemo(() => {
    const all = data?.techs || []
    return trade.key === 'company' ? all.slice(0, 10) : all
  }, [data, trade.key])
  // Bold each column's best — "a bold on the numbers who are the highest".
  const maxes = useMemo(() => {
    const cols = ['score','sold','avgTicket','closeRate','fiveStar','memberships']
    const m = {}
    for (const c of cols) m[c] = Math.max(0, ...techs.map(x => Number(x[c]) || 0))
    m.ytdSold = Math.max(0, ...techs.map(x => Number(x.ytd?.sold) || 0))
    m.ytdFive = Math.max(0, ...techs.map(x => Number(x.ytd?.fiveStar) || 0))
    m.ytdMem = Math.max(0, ...techs.map(x => Number(x.ytd?.memberships) || 0))
    return m
  }, [techs])
  const cell = (v, isMax, fmt = fmtN, color) => (
    <td style={{ padding:'11px 12px', textAlign:'right', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap',
      fontWeight: isMax ? 800 : 500, color: isMax ? (color || C.text) : C.muted, fontSize: isMax ? 19 : 17 }}>
      {fmt(v)}
    </td>
  )
  const th = (label, right = true) => (
    <th style={{ padding:'10px 12px', textAlign: right ? 'right' : 'left', fontSize:11.5, fontWeight:700, letterSpacing:1, color:C.dim, textTransform:'uppercase', whiteSpace:'nowrap' }}>{label}</th>
  )

  // Live Activity — the CEO / Call Center treatment: tag, one line, detail.
  const feed = useMemo(() => (data?.feed || []).map(f => ({
    ...f,
    key: f.id || `${f.kind}-${f.at}-${f.who || ''}-${f.amount ?? f.text ?? ''}`,
    line: f.kind === 'sale' ? `${f.who || 'The team'} sold ${fmtMoney(f.amount)}`
      : f.kind === 'review' ? `${f.who || 'The team'} earned a 5★ review`
      : f.kind === 'membership' ? `${f.who || 'The team'} sold a membership`
      : f.kind === 'invoice' ? `${f.who || 'The team'} closed ${fmtMoney(f.amount)} in revenue`
      : f.kind === 'booked' ? `${f.who || 'A CSR'} booked a call ${bookedForLabel(f.apptStart, f.onHold)}`.trim()
      : (f.text || ''),
  })), [data])
  // Anything that arrives after the board loads gets a brief highlight.
  const seenRef = useRef(new Map())
  const mountedAt = useRef(Date.now())
  const isFresh = (key) => {
    const m = seenRef.current
    if (!m.has(key)) m.set(key, Date.now())
    const first = m.get(key)
    return first - mountedAt.current > 5_000 && Date.now() - first < 3 * 60_000
  }

  return (
    <div ref={rootRef} style={{ width:'100%', height:'100vh', background:C.bg, overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center' }}>
    <div style={{ width:DESIGN_W, height:DESIGN_H, zoom:scale, flexShrink:0, boxSizing:'border-box', color:C.text, padding:'16px 20px', display:'flex', flexDirection:'column', gap:14, overflow:'hidden', fontFamily:'inherit' }}>
      {/* Header: mark + dept + switcher | weather · updated · fullscreen · clock */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:16, flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <span className="pulse-mark" style={{ width:44, height:44, borderRadius:12, background:'#0b0c0f', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 6px 18px rgba(255,117,31,.15)', flexShrink:0 }}>
            <svg width="28" height="28" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
              <polyline points="9,32 19,32 25,17 33,47 40,26 45,32 55,32" fill="none" stroke="#ff751f" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          <span style={{ fontSize:26, fontWeight:800, letterSpacing:.3, whiteSpace:'nowrap' }}>{trade.label}</span>
          <span style={{ fontSize:12, color:C.muted, letterSpacing:1, textTransform:'uppercase' }}>Department board</span>
          {/* Fullscreen is wall-TV mode: just the department, time, and date. */}
          {!isFull && (
            <div style={{ display:'flex', gap:6, marginLeft:10 }}>
              {TRADES.map(t => (
                <button key={t.key} onClick={() => navigate(`/tv/${t.key}`)}
                  style={{ background: t.key === trade.key ? C.panel2 : 'transparent', border:`1px solid ${t.key === trade.key ? t.color : C.border}`,
                    color: t.key === trade.key ? C.text : C.dim, borderRadius:8, padding:'6px 12px', fontSize:12, fontWeight:700, cursor:'pointer' }}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:18, marginLeft:'auto', justifyContent:'flex-end' }}>
          <WeatherStrip dark />
          {data?.updatedAt && (
            <span style={{ fontSize:12, color:C.dim, whiteSpace:'nowrap' }}>Updated {timeAgo(data.updatedAt)}</span>
          )}
          {err && <span style={{ fontSize:12, color:C.red }}>Refresh failed — retrying</span>}
          <button onClick={toggleFull} title={isFull ? 'Exit fullscreen' : 'Fullscreen'}
            style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:8, color:C.muted, cursor:'pointer', padding:'8px 10px', display:'flex', alignItems:'center' }}>
            {isFull ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 3v3a3 3 0 01-3 3H3M15 3v3a3 3 0 003 3h3M9 21v-3a3 3 0 00-3-3H3M15 21v-3a3 3 0 013-3h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 9V5a2 2 0 012-2h4M21 9V5a2 2 0 00-2-2h-4M3 15v4a2 2 0 002 2h4M21 15v4a2 2 0 01-2 2h-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            )}
          </button>
          <div style={{ textAlign:'right' }}>
            <div style={{ fontSize:32, fontWeight:800, letterSpacing:-1, color:C.blue, fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>
              {fmtTime(time, { hour:'2-digit', minute:'2-digit', second:'2-digit' })}
            </div>
            <div style={{ fontSize:13, color:C.muted }}>{fmtDate(time, { weekday:'long', month:'long', day:'numeric' })}</div>
          </div>
        </div>
      </div>

      {/* Daily / Monthly / Yearly strip */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:14, flexShrink:0 }}>
        <PeriodPanel title="Today" d={data?.daily} accent={C.green} />
        <PeriodPanel title="This month" d={data?.monthly} accent={trade.color} />
        <PeriodPanel title="This year" d={data?.yearly} accent={C.blue} />
      </div>

      {/* Tech ranking | Live Activity */}
      <div style={{ display:'flex', gap:14, flex:1, minHeight:0, alignItems:'stretch' }}>
        <div style={{ flex:1, background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, overflow:'hidden', display:'flex', flexDirection:'column', minWidth:0, minHeight:0 }}>
          <div style={{ padding:'13px 18px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'baseline', gap:10, flexShrink:0 }}>
            <span style={{ fontSize:16, fontWeight:700, letterSpacing:.5 }}>
              {trade.key === 'company' ? 'Top 10 service techs' : 'Service ranking'} — {fmtDate(time, { month:'long' })}
            </span>
            <span style={{ fontSize:12, color:C.dim }}>ranked by composite score · bold = best in column</span>
          </div>
          <div style={{ flex:1, overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr style={{ borderBottom:`1px solid ${C.border}`, background:C.panel }}>
                  {th('#', false)}
                  {th('Technician', false)}
                  {th('Score')}
                  {th('Sold')}
                  {th('Avg ticket')}
                  {th('Close rate')}
                  {th('5★')}
                  {th('Clubs')}
                  {th('YTD sold')}
                  {th('YTD 5★')}
                  {th('YTD clubs')}
                </tr>
              </thead>
              <tbody>
                {techs.map((x, i) => (
                  <tr key={x.id} style={{ borderBottom:`1px solid ${C.border}`, background: i === 0 ? `${trade.color}14` : 'transparent' }}>
                    <td style={{ padding:'9px 14px' }}><RankBadge i={i} /></td>
                    <td style={{ padding:'11px 12px', fontWeight:700, fontSize:20, whiteSpace:'nowrap' }}>
                      {x.name}
                      {x.trade && <span style={{ marginLeft:8, fontSize:11, fontWeight:800, letterSpacing:.8, color:C.dim }}>{TRADE_SHORT[x.trade] || x.trade}</span>}
                    </td>
                    {cell(x.score, x.score === maxes.score && maxes.score > 0, fmtN, trade.color)}
                    {cell(x.sold, x.sold === maxes.sold && maxes.sold > 0, fmtMoney, C.green)}
                    {cell(x.avgTicket, x.avgTicket === maxes.avgTicket && maxes.avgTicket > 0, fmtMoney)}
                    {cell(x.closeRate, x.closeRate === maxes.closeRate && maxes.closeRate > 0, fmtPct, C.amber)}
                    {cell(x.fiveStar, x.fiveStar === maxes.fiveStar && maxes.fiveStar > 0, fmtN, C.amber)}
                    {cell(x.memberships, x.memberships === maxes.memberships && maxes.memberships > 0, fmtN, C.purple)}
                    {cell(x.ytd?.sold, (x.ytd?.sold || 0) === maxes.ytdSold && maxes.ytdSold > 0, fmtMoney, C.green)}
                    {cell(x.ytd?.fiveStar, (x.ytd?.fiveStar || 0) === maxes.ytdFive && maxes.ytdFive > 0, fmtN, C.amber)}
                    {cell(x.ytd?.memberships, (x.ytd?.memberships || 0) === maxes.ytdMem && maxes.ytdMem > 0, fmtN, C.purple)}
                  </tr>
                ))}
                {!techs.length && (
                  <tr><td colSpan={11} style={{ padding:24, textAlign:'center', color:C.dim, fontSize:15 }}>
                    {data ? 'No tech activity yet this month.' : 'Loading the month…'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ width:500, flexShrink:0, background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, overflow:'hidden', display:'flex', flexDirection:'column' }}>
          <div style={{ padding:'13px 18px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
            <span style={{ fontSize:16 }}>⚡</span>
            <span style={{ fontSize:15, fontWeight:800, letterSpacing:.6 }}>LIVE ACTIVITY</span>
            <span style={{ fontSize:12, color:C.dim }}>{trade.key === 'company' ? 'all trades' : trade.label} · today</span>
            <div style={{ marginLeft:'auto', width:8, height:8, borderRadius:'50%', background:C.green, animation:'wr-pulse 1.5s infinite' }} />
          </div>
          <div ref={feedRef} style={{ flex:1, minHeight:0, overflow:'hidden' }}>
            {feed.slice(0, feedFits).map(f => {
              const st = FEED_STYLE[f.kind] || FEED_STYLE.sale
              const fresh = isFresh(f.key)
              return (
                <div key={f.key} style={{ height:FEED_ROW_H, boxSizing:'border-box', display:'flex', alignItems:'center', gap:12, padding:'0 18px', borderBottom:`1px solid ${C.border}55`,
                  background: fresh ? `${st.color}1A` : 'transparent', boxShadow: fresh ? `inset 3px 0 0 ${st.color}` : 'none', animation: fresh ? 'dept-pop .8s ease-out' : 'none' }}>
                  <span style={{ fontSize:11, fontWeight:800, letterSpacing:.8, color:st.color, background:`${st.color}1A`, border:`1px solid ${st.color}55`, borderRadius:6, padding:'3px 7px', flexShrink:0 }}>{st.tag}</span>
                  <div style={{ minWidth:0, flex:1 }}>
                    <div style={{ fontSize:16, fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{f.line}</div>
                    <div style={{ fontSize:13, color:C.dim, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', marginTop:2 }}>{[f.text, timeAgo(f.at)].filter(Boolean).join(' · ')}</div>
                  </div>
                </div>
              )
            })}
            {!feed.length && (
              <div style={{ padding:28, textAlign:'center', color:C.dim, fontSize:15 }}>Nothing yet today — first win lands here.</div>
            )}
          </div>
        </div>
      </div>
      <style>{`
        @keyframes wr-pulse { 0%,100%{opacity:1} 50%{opacity:.25} }
        @keyframes dept-pop { from { transform: translateX(14px); opacity: 0 } to { transform: none; opacity: 1 } }
      `}</style>
    </div>
    </div>
  )
}
