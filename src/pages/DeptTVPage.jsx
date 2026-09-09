import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useDailyReload } from '../lib/useDailyReload'

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
  { key:'hvac', label:'HVAC', color:'#F0883E' },
  { key:'plumbing', label:'Plumbing', color:'#58A6FF' },
  { key:'electrical', label:'Electrical', color:'#D29922' },
  { key:'garage', label:'Garage Doors', color:'#BC8CFF' },
]

const fmtMoney = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString()
const fmtPct = (n) => n == null ? '—' : Math.round(n * 100) + '%'
const fmtN = (n) => n == null ? '—' : Number(n).toLocaleString()
const timeAgo = (iso) => {
  if (!iso) return ''
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000))
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString([], { month:'short', day:'numeric' })
}

function Stat({ label, value, color = C.text, big }) {
  return (
    <div style={{ minWidth:0 }}>
      <div style={{ fontSize: big ? 30 : 24, fontWeight:800, color, letterSpacing:-1, lineHeight:1.05, fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>{value}</div>
      <div style={{ fontSize:10, fontWeight:700, letterSpacing:1, color:C.muted, textTransform:'uppercase', marginTop:4 }}>{label}</div>
    </div>
  )
}

function PeriodPanel({ title, d, accent }) {
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderTop:`3px solid ${accent}`, borderRadius:14, padding:'14px 18px', minWidth:0 }}>
      <div style={{ fontSize:12, fontWeight:800, letterSpacing:1.4, color:accent, textTransform:'uppercase', marginBottom:12 }}>{title}</div>
      {d ? (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:'14px 12px' }}>
          <Stat label="Jobs ran" value={fmtN(d.jobsRan)} />
          <Stat label="Sales" value={fmtMoney(d.sales)} color={C.green} />
          <Stat label="Revenue" value={fmtMoney(d.revenue)} color={C.blue} />
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

const FEED_STYLE = {
  sale:       { tag:'SALE', color:C.green },
  review:     { tag:'5★',   color:C.amber },
  membership: { tag:'CLUB', color:C.purple },
}

export default function DeptTVPage() {
  const { trade: tradeParam } = useParams()
  const navigate = useNavigate()
  const trade = TRADES.find(t => t.key === tradeParam) || TRADES[0]

  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [time, setTime] = useState(new Date())
  const [isFull, setIsFull] = useState(false)
  const rootRef = useRef(null)
  useDailyReload()

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
      // Server caches fill tier by tier on a cold start — poll fast until whole.
      const whole = j && j.daily && j.monthly && j.yearly
      t = setTimeout(tick, whole ? 5 * 60_000 : 30_000)
    }
    t = setTimeout(tick, 30_000)
    return () => clearTimeout(t)
  }, [load])
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    const onFs = () => setIsFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen?.()
    else rootRef.current?.requestFullscreen?.()
  }

  const techs = data?.techs || []
  const installers = data?.installers || []
  // Installer bests: highest wins everywhere except callback %, where lowest wins.
  const instBest = useMemo(() => ({
    score: Math.max(0, ...installers.map(x => x.score || 0)),
    efficiency: Math.max(0, ...installers.map(x => x.efficiency || 0)),
    callbackPct: installers.length ? Math.min(...installers.map(x => x.callbackPct || 0)) : 0,
    revenue: Math.max(0, ...installers.map(x => x.revenue || 0)),
    fiveStar: Math.max(0, ...installers.map(x => x.fiveStar || 0)),
  }), [installers])
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
    <td style={{ padding:'10px 12px', textAlign:'right', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap',
      fontWeight: isMax ? 800 : 500, color: isMax ? (color || C.text) : C.muted, fontSize: isMax ? 17 : 15 }}>
      {fmt(v)}
    </td>
  )

  const th = (label, right = true) => (
    <th style={{ padding:'9px 12px', textAlign: right ? 'right' : 'left', fontSize:10, fontWeight:700, letterSpacing:1, color:C.dim, textTransform:'uppercase', whiteSpace:'nowrap' }}>{label}</th>
  )

  return (
    <div ref={rootRef} style={{ position:'fixed', inset:0, background:C.bg, color:C.text, padding:'16px 20px', display:'flex', flexDirection:'column', gap:14, overflow:'auto', zIndex:50, fontFamily:'inherit' }}>
      {/* Header: mark + dept + switcher | updated | fullscreen + clock */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:16, flexShrink:0, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <span className="pulse-mark" style={{ width:40, height:40, borderRadius:11, background:'#0b0c0f', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 6px 18px rgba(255,117,31,.15)' }}>
            <svg width="26" height="26" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
              <polyline points="9,32 19,32 25,17 33,47 40,26 45,32 55,32" fill="none" stroke="#ff751f" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          <span style={{ fontSize:21, fontWeight:800, letterSpacing:.3 }}>{trade.label}</span>
          <span style={{ fontSize:12, color:C.muted, letterSpacing:1, textTransform:'uppercase' }}>Department board</span>
          <div style={{ display:'flex', gap:6, marginLeft:10 }}>
            {TRADES.map(t => (
              <button key={t.key} onClick={() => navigate(`/tv/${t.key}`)}
                style={{ background: t.key === trade.key ? C.panel2 : 'transparent', border:`1px solid ${t.key === trade.key ? t.color : C.border}`,
                  color: t.key === trade.key ? C.text : C.dim, borderRadius:8, padding:'6px 12px', fontSize:12, fontWeight:700, cursor:'pointer' }}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          {data?.updatedAt && (
            <span style={{ fontSize:11, color:C.dim }}>Updated {timeAgo(data.updatedAt)}</span>
          )}
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
            <div style={{ fontSize:30, fontWeight:800, letterSpacing:-1, color:C.blue, fontVariantNumeric:'tabular-nums' }}>
              {time.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}
            </div>
            <div style={{ fontSize:12, color:C.muted }}>{time.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' })}</div>
          </div>
        </div>
      </div>

      {/* Daily / Monthly / Yearly strip */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:14, flexShrink:0 }}>
        <PeriodPanel title="Today" d={data?.daily} accent={C.green} />
        <PeriodPanel title="This month" d={data?.monthly} accent={trade.color} />
        <PeriodPanel title="This year" d={data?.yearly} accent={C.blue} />
      </div>

      {/* Tech ranking + live feed */}
      <div style={{ display:'flex', gap:14, flex:1, minHeight:0, alignItems:'stretch' }}>
        <div style={{ flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:14 }}>
        <div style={{ flex:3, background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, overflow:'hidden', display:'flex', flexDirection:'column', minWidth:0, minHeight:0 }}>
          <div style={{ padding:'13px 18px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'baseline', gap:10, flexShrink:0 }}>
            <span style={{ fontSize:13, fontWeight:700, letterSpacing:.5 }}>Service ranking — {time.toLocaleDateString([], { month:'long' })}</span>
            <span style={{ fontSize:11, color:C.dim }}>ranked by composite score · bold = best in column</span>
          </div>
          <div style={{ flex:1, overflow:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr style={{ borderBottom:`1px solid ${C.border}`, position:'sticky', top:0, background:C.panel }}>
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
                    <td style={{ padding:'10px 12px', color: i === 0 ? trade.color : C.dim, fontWeight:800, fontSize:15 }}>{i + 1}</td>
                    <td style={{ padding:'10px 12px', fontWeight:700, fontSize:15, whiteSpace:'nowrap' }}>{x.name}</td>
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
                  <tr><td colSpan={11} style={{ padding:24, textAlign:'center', color:C.dim, fontSize:13 }}>
                    {data ? 'No tech activity yet this month.' : 'Loading the month…'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Installer ranking — Efficiency 40 / Callback% 30 / Revenue 20 / 5-star 10 */}
        <div style={{ flex:2, background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, overflow:'hidden', display:'flex', flexDirection:'column', minWidth:0, minHeight:0 }}>
          <div style={{ padding:'13px 18px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'baseline', gap:10, flexShrink:0 }}>
            <span style={{ fontSize:13, fontWeight:700, letterSpacing:.5 }}>Install ranking — {time.toLocaleDateString([], { month:'long' })}</span>
            <span style={{ fontSize:11, color:C.dim }}>efficiency = time given vs time taken · callback % lower is better</span>
          </div>
          <div style={{ flex:1, overflow:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr style={{ borderBottom:`1px solid ${C.border}`, position:'sticky', top:0, background:C.panel }}>
                  {th('#', false)}
                  {th('Team / Installer', false)}
                  {th('Score')}
                  {th('Efficiency')}
                  {th('Callback %')}
                  {th('Revenue')}
                  {th('5★')}
                  {th('Installs')}
                </tr>
              </thead>
              <tbody>
                {installers.map((x, i) => (
                  <tr key={x.id} style={{ borderBottom:`1px solid ${C.border}`, background: i === 0 ? `${trade.color}14` : 'transparent' }}>
                    <td style={{ padding:'10px 12px', color: i === 0 ? trade.color : C.dim, fontWeight:800, fontSize:15 }}>{i + 1}</td>
                    <td style={{ padding:'10px 12px', fontWeight:700, fontSize:15, whiteSpace:'nowrap' }}>{x.name}</td>
                    {cell(x.score, x.score === instBest.score && instBest.score > 0, fmtN, trade.color)}
                    {cell(x.efficiency, x.efficiency === instBest.efficiency && instBest.efficiency > 0, fmtPct, C.green)}
                    {cell(x.callbackPct, x.callbackPct === instBest.callbackPct, fmtPct, C.amber)}
                    {cell(x.revenue, x.revenue === instBest.revenue && instBest.revenue > 0, fmtMoney, C.blue)}
                    {cell(x.fiveStar, x.fiveStar === instBest.fiveStar && instBest.fiveStar > 0, fmtN, C.amber)}
                    {cell(x.installs, false)}
                  </tr>
                ))}
                {!installers.length && (
                  <tr><td colSpan={8} style={{ padding:20, textAlign:'center', color:C.dim, fontSize:13 }}>
                    {data ? 'No completed installs yet this month.' : 'Loading the month…'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        </div>

        {/* Dept live feed */}
        <div style={{ width:330, flexShrink:0, background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, overflow:'hidden', display:'flex', flexDirection:'column' }}>
          <div style={{ padding:'13px 18px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
            <span style={{ fontSize:13, fontWeight:700, letterSpacing:.5 }}>Today in {trade.label}</span>
            <div style={{ marginLeft:'auto', width:7, height:7, borderRadius:'50%', background:C.green, animation:'wr-pulse 1.5s infinite' }} />
          </div>
          <div style={{ flex:1, overflow:'auto', padding:'8px 0' }}>
            {(data?.feed || []).map((f, i) => {
              const s = FEED_STYLE[f.kind] || FEED_STYLE.sale
              return (
                <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 16px', borderBottom:`1px solid ${C.border}55` }}>
                  <span style={{ fontSize:10, fontWeight:800, letterSpacing:.8, color:s.color, background:`${s.color}1A`, border:`1px solid ${s.color}55`, borderRadius:6, padding:'3px 7px', flexShrink:0 }}>{s.tag}</span>
                  <div style={{ minWidth:0, flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                      {f.kind === 'sale' && `${f.who || 'The team'} sold ${fmtMoney(f.amount)}`}
                      {f.kind === 'review' && `${f.who || 'The team'} earned a 5★ review`}
                      {f.kind === 'membership' && `${f.who || 'The team'} sold a membership`}
                    </div>
                    <div style={{ fontSize:11, color:C.dim }}>{[f.text, timeAgo(f.at)].filter(Boolean).join(' · ')}</div>
                  </div>
                </div>
              )
            })}
            {!(data?.feed || []).length && (
              <div style={{ padding:24, textAlign:'center', color:C.dim, fontSize:13 }}>Nothing yet today — first win lands here.</div>
            )}
          </div>
        </div>
      </div>
      <style>{`@keyframes wr-pulse { 0%,100%{opacity:1} 50%{opacity:.25} }`}</style>
    </div>
  )
}
