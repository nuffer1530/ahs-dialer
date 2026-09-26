import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useWallboard } from '../lib/useDailyReload'
import { fmtTime, fmtDate, bookedForLabel } from '../lib/denver'
import { shortName } from '../lib/utils'
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
function RankBadge({ i, k = 1 }) {
  const medal = MEDALS[i]
  if (!medal) return <span style={{ color:C.dim, fontWeight:800, fontSize:15 * k }}>{i + 1}</span>
  return (
    <span style={{ display:'inline-flex', alignItems:'center', justifyContent:'center', width:26 * k, height:26 * k, borderRadius:'50%',
      background:`${medal}1F`, border:`1.5px solid ${medal}`, color:medal, fontWeight:800, fontSize:13 * k, boxShadow:`0 0 10px ${medal}33` }}>
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
// Shared wall TVs: the TV on one board's link cycles through these boards,
// one minute each (Brandyn, Sep 24: the Electrical TV also shows Garage Doors).
const ROTATIONS = { electrical: ['electrical', 'garage'] }
const ROTATE_MS = 60_000
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
  const baseTrade = TRADES.find(t => t.key === tradeParam) || TRADES[0]

  // One cached payload per board, so a rotation swap shows the other trade's
  // numbers instantly instead of flashing "Loading…".
  const [dataBy, setDataBy] = useState({})
  const [err, setErr] = useState(null)
  const [rotIdx, setRotIdx] = useState(0)
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
  // Rotation runs only in the wall look (the TV), never while someone is
  // browsing the board on a desktop and using the trade buttons.
  const rotateKeys = isFull ? (ROTATIONS[baseTrade.key] || null) : null
  const trade = rotateKeys ? (TRADES.find(t => t.key === rotateKeys[rotIdx % rotateKeys.length]) || baseTrade) : baseTrade
  const data = dataBy[trade.key] || null
  const rotSig = rotateKeys ? rotateKeys.join(',') : ''
  useEffect(() => {
    if (!rotSig) return
    const id = setInterval(() => setRotIdx(i => i + 1), ROTATE_MS)
    return () => clearInterval(id)
  }, [rotSig])

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
  // Both panels size their rows to FILL their space (Brandyn, Sep 24: a
  // 7-tech roster and a short morning feed left half the TV blank).
  const tableRef = useRef(null)
  const [tableH, setTableH] = useState(0)
  useEffect(() => {
    const el = tableRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setTableH(e.contentRect.height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Every board this screen shows (one, or the rotation's set).
  const loadKeys = rotSig || baseTrade.key
  const load = useCallback(async () => {
    try {
      // useAuth exposes user/profile but not the session — get the token here.
      const { data: { session } } = await sb.auth.getSession()
      if (!session?.access_token) throw new Error('no session')
      const got = await Promise.all(loadKeys.split(',').map(async (key) => {
        const r = await fetch(`/api/tv/department/${key}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return [key, await r.json()]
      }))
      setDataBy(prev => ({ ...prev, ...Object.fromEntries(got) })); setErr(null)
      // "Whole" (slow poll) only once every board has all three tiers.
      return got.every(([, j]) => j && j.daily && j.monthly && j.yearly) ? got[0][1] : { partial: true }
    } catch (e) { setErr(e.message); return null }
  }, [loadKeys])

  useEffect(() => { load() }, [load])
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
    const cols = ['score','sold','avgTicket','closeRate','fiveStar','memberships','fieldPro']
    const m = {}
    for (const c of cols) m[c] = Math.max(0, ...techs.map(x => Number(x[c]) || 0))
    m.ytdSold = Math.max(0, ...techs.map(x => Number(x.ytd?.sold) || 0))
    m.ytdFive = Math.max(0, ...techs.map(x => Number(x.ytd?.fiveStar) || 0))
    m.ytdMem = Math.max(0, ...techs.map(x => Number(x.ytd?.memberships) || 0))
    return m
  }, [techs])
  const cell = (v, isMax, fmt = fmtN, color) => (
    <td style={{ padding:`0 ${Math.round(12 * k)}px`, textAlign:'right', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap',
      fontWeight: isMax ? 800 : 500, color: isMax ? (color || C.text) : C.muted, fontSize: (isMax ? 19 : 17) * k }}>
      {fmt(v)}
    </td>
  )
  const th = (label, right = true) => (
    <th style={{ height:TH_H, boxSizing:'border-box', padding:`0 ${Math.round(12 * k)}px`, textAlign: right ? 'right' : 'left', fontSize:11.5 * Math.min(k, 1.2), fontWeight:700, letterSpacing:1, color:C.dim, textTransform:'uppercase', whiteSpace:'nowrap' }}>{label}</th>
  )

  // Live Activity — the CEO / Call Center treatment: tag, one line, detail.
  const feed = useMemo(() => (data?.feed || []).map(f => ({
    ...f,
    key: f.id || `${f.kind}-${f.at}-${f.who || ''}-${f.amount ?? f.text ?? ''}`,
    line: f.kind === 'sale' ? `${shortName(f.who) || 'The team'} sold ${fmtMoney(f.amount)}`
      : f.kind === 'review' ? `${shortName(f.who) || 'The team'} earned a 5★ review`
      : f.kind === 'membership' ? `${shortName(f.who) || 'The team'} sold a membership`
      : f.kind === 'invoice' ? `${shortName(f.who) || 'The team'} closed ${fmtMoney(f.amount)} in revenue`
      : f.kind === 'booked' ? `${shortName(f.who) || 'A CSR'} booked a call ${bookedForLabel(f.apptStart, f.onHold)}`.trim()
      : (f.text || ''),
  })), [data])
  // Ranking rows: split the panel evenly; type grows with the row (capped so
  // the 12 columns still fit the width).
  const TH_H = 44, BASE_ROW = 52
  const rowH = techs.length && tableH ? Math.max(44, Math.min(118, (tableH - TH_H) / techs.length)) : BASE_ROW
  // …and never wider than the panel: if the 12 columns overflow, step the
  // type down until they fit (re-checked whenever the board resizes).
  const [kW, setKW] = useState(1.35)
  useEffect(() => { setKW(1.35) }, [trade.key, box.w, box.h])
  const k = Math.max(0.85, Math.min(kW, rowH / BASE_ROW))
  useEffect(() => {
    const wrap = tableRef.current, t = wrap?.querySelector('table')
    if (wrap && t && t.scrollWidth > wrap.clientWidth + 1) setKW(Math.max(0.8, +(k * wrap.clientWidth / t.scrollWidth - 0.01).toFixed(3)))
  })
  // Feed rows: at the base height when the day is busy (show what fits);
  // when there are only a few, stretch them and their type to fill.
  const feedAtBase = feedH ? Math.max(1, Math.floor(feedH / FEED_ROW_H)) : 10
  const feedRowH = feed.length && feed.length <= feedAtBase && feedH ? Math.min(148, Math.floor(feedH / feed.length)) : FEED_ROW_H
  const feedFits = feed.length <= feedAtBase ? feed.length : feedAtBase
  const fk = Math.max(1, Math.min(1.25, feedRowH / FEED_ROW_H))
  // The headline stays on ONE line (short names keep "…booked a call for
  // Wed 10/28" whole); tall rows let the detail line wrap to two.
  const feedLines = feedRowH >= 90 ? 2 : 1

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
          {rotateKeys ? (
            <span style={{ display:'flex', gap:6, marginLeft:4 }}>
              {rotateKeys.map(key => {
                const t2 = TRADES.find(t => t.key === key)
                const on = key === trade.key
                return (
                  <span key={key} style={{ fontSize:11, fontWeight:800, letterSpacing:1, textTransform:'uppercase', padding:'3px 9px', borderRadius:999,
                    border:`1px solid ${on ? t2?.color : C.border}`, color: on ? C.text : C.dim, background: on ? `${t2?.color}22` : 'transparent' }}>{t2?.label}</span>
                )
              })}
            </span>
          ) : (
            <span style={{ fontSize:12, color:C.muted, letterSpacing:1, textTransform:'uppercase' }}>Department board</span>
          )}
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
          <div ref={tableRef} style={{ flex:1, minHeight:0, overflow:'hidden' }}>
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
                  {th('Field Pro')}
                  {th('YTD sold')}
                  {th('YTD 5★')}
                  {th('YTD clubs')}
                </tr>
              </thead>
              <tbody>
                {techs.map((x, i) => (
                  <tr key={x.id} style={{ height:rowH, borderBottom:`1px solid ${C.border}`, background: i === 0 ? `${trade.color}14` : 'transparent' }}>
                    <td style={{ padding:`0 ${Math.round(14 * k)}px` }}><RankBadge i={i} k={k} /></td>
                    <td style={{ padding:`0 ${Math.round(12 * k)}px`, fontWeight:700, fontSize:20 * k, whiteSpace:'nowrap' }}>
                      {x.name}
                      {x.trade && <span style={{ marginLeft:8, fontSize:11 * k, fontWeight:800, letterSpacing:.8, color:C.dim }}>{TRADE_SHORT[x.trade] || x.trade}</span>}
                    </td>
                    {cell(x.score, x.score === maxes.score && maxes.score > 0, fmtN, trade.color)}
                    {cell(x.sold, x.sold === maxes.sold && maxes.sold > 0, fmtMoney, C.green)}
                    {cell(x.avgTicket, x.avgTicket === maxes.avgTicket && maxes.avgTicket > 0, fmtMoney)}
                    {cell(x.closeRate, x.closeRate === maxes.closeRate && maxes.closeRate > 0, fmtPct, C.amber)}
                    {cell(x.fiveStar, x.fiveStar === maxes.fiveStar && maxes.fiveStar > 0, fmtN, C.amber)}
                    {cell(x.memberships, x.memberships === maxes.memberships && maxes.memberships > 0, fmtN, C.purple)}
                    {/* Field Pro (Siro) month score, 0–100; "—" = no recorded calls this month (counts as 0 in the score). */}
                    {cell(x.fieldProCalls ? x.fieldPro : null, !!x.fieldProCalls && x.fieldPro === maxes.fieldPro && maxes.fieldPro > 0, fmtN, C.blue)}
                    {cell(x.ytd?.sold, (x.ytd?.sold || 0) === maxes.ytdSold && maxes.ytdSold > 0, fmtMoney, C.green)}
                    {cell(x.ytd?.fiveStar, (x.ytd?.fiveStar || 0) === maxes.ytdFive && maxes.ytdFive > 0, fmtN, C.amber)}
                    {cell(x.ytd?.memberships, (x.ytd?.memberships || 0) === maxes.ytdMem && maxes.ytdMem > 0, fmtN, C.purple)}
                  </tr>
                ))}
                {!techs.length && (
                  <tr><td colSpan={12} style={{ padding:24, textAlign:'center', color:C.dim, fontSize:15 }}>
                    {data ? 'No tech activity yet this month.' : 'Loading the month…'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ width:560, flexShrink:0, background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, overflow:'hidden', display:'flex', flexDirection:'column' }}>
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
                <div key={f.key} style={{ height:feedRowH, boxSizing:'border-box', overflow:'hidden', display:'flex', alignItems:'center', gap:12 * fk, padding:'0 18px', borderBottom:`1px solid ${C.border}55`,
                  background: fresh ? `${st.color}1A` : 'transparent', boxShadow: fresh ? `inset 3px 0 0 ${st.color}` : 'none', animation: fresh ? 'dept-pop .8s ease-out' : 'none' }}>
                  <span style={{ fontSize:11 * fk, fontWeight:800, letterSpacing:.8, color:st.color, background:`${st.color}1A`, border:`1px solid ${st.color}55`, borderRadius:6, padding:`${3 * fk}px ${7 * fk}px`, flexShrink:0 }}>{st.tag}</span>
                  <div style={{ minWidth:0, flex:1 }}>
                    <div style={{ fontSize:16 * fk, fontWeight:700, lineHeight:1.2, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{f.line}</div>
                    <div style={feedLines > 1
                      ? { fontSize:13 * fk, color:C.dim, lineHeight:1.25, display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden', marginTop:2 * fk }
                      : { fontSize:13 * fk, color:C.dim, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', marginTop:2 * fk }}>{[f.text, timeAgo(f.at)].filter(Boolean).join(' · ')}</div>
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
