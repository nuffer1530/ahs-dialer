import { useState, useEffect, useMemo, useRef } from 'react'
import WeatherStrip from '../components/WeatherStrip'
import { sb } from '../lib/supabase'
import { useData } from '../lib/DataContext'
import { inboundStats, outboundStats, fmtSecs, SERVICE_LEVEL_SECONDS, SERVICE_LEVEL_TARGET } from '../lib/analytics'
import { INTERACTION_COLORS } from '../lib/constants'
import Avatar from '../components/Avatar'
import { useWallboard } from '../lib/useDailyReload'
import { bookedForLabel } from '../lib/denver'
import { fmtTime, fmtDate, denverStartOfToday } from '../lib/denver'

// Call-centre wallboard — a modern "Simon board" for the floor TV. Everything
// real-time: inbound queue health, live calls, the leaderboard (rows slide when
// someone takes the lead), agent presence, and a live activity feed.

// TV-bright dark palette.
const C = {
  bg:'#0B0F14', panel:'#141A21', panel2:'#1B222B', border:'#252E38',
  text:'#E6EDF3', muted:'#8B949E', dim:'#6E7681',
  green:'#3FB950', blue:'#58A6FF', amber:'#D29922', red:'#F85149', purple:'#BC8CFF', orange:'#F0883E',
}
const STATUS_COLORS = {
  'Available':C.green, 'On Call':C.blue, 'Wrap Up':C.amber,
  'Break':C.purple, 'Lunch':C.orange, 'Offline':C.dim, 'Huddle':C.purple,
}
const STATUS_ORDER = { 'On Call':0, 'Available':1, 'Wrap Up':2, 'Break':3, 'Lunch':4, 'Huddle':5, 'Offline':9 }
const OUTCOME_COLORS = {
  'Booked':C.green, 'No Answer':C.amber, 'Voicemail':C.purple,
  'Not Interested':C.red, 'DNC':'#8B2E24', 'Bad Data':C.dim,
}
const ROW_H = 74

const startOfToday = () => denverStartOfToday()   // Denver midnight, whatever zone the TV stick is on
const fmtWait = (s) => s == null ? '—' : s < 60 ? `${s}s` : `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`
const timeSince = (iso) => {
  if (!iso) return '—'
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s/60)}m`
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`
}

// `compact` = a Fire TV-class viewport (~960 CSS px): labels stay on one line
// and the numbers shrink so eight tiles share the width without wrapping.
function Kpi({ label, value, sub, color = C.text, glow, compact }) {
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius: compact ? 10 : 14, padding: compact ? '8px 10px' : '14px 18px',
      borderTop:`3px solid ${color}`, boxShadow: glow ? `0 0 24px ${color}44` : 'none', minWidth:0 }}>
      <div style={{ fontSize: compact ? 9 : 11, fontWeight:700, textTransform:'uppercase', letterSpacing: compact ? .4 : .8, color:C.muted, marginBottom: compact ? 3 : 6, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{label}</div>
      <div style={{ fontSize: compact ? 26 : 40, fontWeight:800, color, letterSpacing: compact ? -1 : -1.5, lineHeight:1, fontVariantNumeric:'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: compact ? 9 : 11, color:C.muted, marginTop: compact ? 3 : 5, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{sub}</div>}
    </div>
  )
}

function Panel({ title, icon, live, children, style, compact }) {
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, overflow:'hidden', display:'flex', flexDirection:'column', ...style }}>
      <div style={{ padding: compact ? '7px 12px' : '13px 18px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
        <span style={{ fontSize: compact ? 13 : 16 }}>{icon}</span>
        <span style={{ fontSize: compact ? 11 : 13, fontWeight:700, letterSpacing:.5, color:C.text }}>{title}</span>
        {live && <div style={{ marginLeft:'auto', width:7, height:7, borderRadius:'50%', background:C.green, animation:'wr-pulse 1.5s infinite' }} />}
      </div>
      <div style={{ flex:1, overflow:'hidden', position:'relative' }}>{children}</div>
    </div>
  )
}

export default function WarRoomPage() {
  const { contacts } = useData()
  const [logs, setLogs] = useState([])
  const [tasks, setTasks] = useState([])
  const [liveCalls, setLiveCalls] = useState([])
  const [profiles, setProfiles] = useState([])
  const [time, setTime] = useState(new Date())
  const [ticker, setTicker] = useState({ enabled: false, messages: [] })
  const [board, setBoard] = useState(null)   // 3-day call board (today column shown)
  const [sales, setSales] = useState([])     // estimates SOLD today (tech wins)
  const [csrMonth, setCsrMonth] = useState(null)   // month-to-date CSR ranking (booking % · clubs · QA)
  const [wins, setWins] = useState({ reviews: [], memberships: [], bonus: null })   // 5★ / club sales / 🎯 unlock
  const [booked, setBooked] = useState([])   // today's booked calls, from ServiceTitan (same feed as the CEO board)
  const rootRef = useRef(null)
  // Live Activity shows only the rows that FIT — nobody scrolls a wall TV
  // (Brandyn, Sep 23: it was cut off mid-row with a scrollbar).
  const feedRef = useRef(null)
  const [feedH, setFeedH] = useState(0)
  useEffect(() => {
    const el = feedRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setFeedH(e.contentRect.height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Wall look survives reloads; the page updates itself when a build lands.
  const { isFull, toggleFull } = useWallboard(rootRef)
  // Fire TV Silk / Fully Kiosk report ~960 CSS px: same treatment as the
  // department boards — compact chrome, then a measured zoom-to-fit so the
  // ticker, tiles, trades AND all three panels are on screen at once.
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1150)
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 1150)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  const [fit, setFit] = useState(1)
  useEffect(() => { setFit(1) }, [narrow])
  useEffect(() => {
    if (!narrow) return
    const el = rootRef.current
    if (!el) return
    const t = setTimeout(() => {
      const need = el.scrollHeight, have = el.clientHeight
      if (need > have + 4) setFit(f => Math.max(0.6, +((f * have) / need).toFixed(3)))
    }, 250)
    return () => clearTimeout(t)
  }, [narrow, fit, board, csrMonth, sales, wins, profiles])

  // 3-Day Call Board — show today's "calls needed" per trade on the TV.
  useEffect(() => {
    const load = () => fetch('/api/board/3day').then(r => r.json()).then(setBoard).catch(() => {})
    const loadSales = () => fetch('/api/tv/sales-today').then(r => r.json()).then(d => setSales(d.sales || [])).catch(() => {})
    const loadWins = () => fetch('/api/tv/wins-today').then(r => r.json()).then(d => setWins({ reviews: d.reviews || [], memberships: d.memberships || [], bonus: d.bonus || null })).catch(() => {})
    const loadMonth = () => fetch('/api/tv/csr-month').then(r => r.json()).then(d => setCsrMonth(d)).catch(() => {})
    const loadBooked = () => fetch('/api/tv/booked-today').then(r => r.json()).then(d => setBooked(d.booked || [])).catch(() => {})
    loadSales(); loadWins(); loadMonth(); loadBooked()
    const tb = setInterval(loadBooked, 60_000)
    const tm = setInterval(loadMonth, 5 * 60_000)
    const ts = setInterval(loadSales, 2 * 60_000)
    const tw = setInterval(loadWins, 5 * 60_000)
    load()
    const t = setInterval(load, 90_000)
    return () => { clearInterval(t); clearInterval(ts); clearInterval(tw); clearInterval(tm); clearInterval(tb) }
  }, [])


  // Floor ticker — admin-editable messages from app_settings. Polled (not
  // realtime-dependent) so an alert posted from Settings shows within ~15s.
  useEffect(() => {
    const load = () => sb.from('app_settings').select('value').eq('key', 'warroom_ticker').maybeSingle()
      .then(({ data }) => {
        try {
          const v = JSON.parse(data?.value || '{}')
          setTicker({ enabled: !!v.enabled, messages: Array.isArray(v.messages) ? v.messages.filter(m => m && m.text) : [] })
        } catch { setTicker({ enabled: false, messages: [] }) }
      })
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const since = startOfToday().toISOString()
    Promise.all([
      sb.from('call_logs').select('*').gte('created_at', since).order('created_at', { ascending:false }),
      sb.from('call_tasks').select('*').gte('queued_at', since).order('queued_at', { ascending:false }),
      sb.from('active_calls').select('*').is('ended_at', null),
      // select('*') on purpose: naming columns here means any column this file
      // references before its migration lands 400s the WHOLE query and the
      // floor TV renders zero agents. A wildcard degrades to a missing chip
      // instead of an empty board.
      sb.from('profiles').select('*').eq('active', true),
    ]).then(([l, t, a, p]) => {
      setLogs(l.data || []); setTasks(t.data || []); setLiveCalls(a.data || []); setProfiles(p.data || [])
    })

    const upsert = (setter, key) => (payload) => setter(prev => {
      if (payload.eventType === 'DELETE') return prev.filter(x => x[key] !== payload.old[key])
      const i = prev.findIndex(x => x[key] === payload.new[key])
      if (i === -1) return [payload.new, ...prev]
      const next = [...prev]; next[i] = { ...next[i], ...payload.new }; return next
    })

    // Realtime is the fast path, but on a 24/7 wallboard the websocket can
    // silently die (and profiles may not be in the realtime publication at
    // all) — statuses then freeze until someone refreshes. Poll profiles
    // every 30s as the guaranteed floor.
    const pollProfiles = () => sb.from('profiles').select('*').eq('active', true)
      .then(({ data }) => { if (data) setProfiles(data) })
    const tp = setInterval(pollProfiles, 30_000)

    const ch = sb.channel('warroom')
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'call_logs' }, p => setLogs(prev => [p.new, ...prev]))
      .on('postgres_changes', { event:'*', schema:'public', table:'call_tasks' }, upsert(setTasks, 'task_sid'))
      .on('postgres_changes', { event:'*', schema:'public', table:'active_calls' }, upsert(setLiveCalls, 'call_sid'))
      .on('postgres_changes', { event:'UPDATE', schema:'public', table:'profiles' }, p =>
        setProfiles(prev => prev.map(x => x.id === p.new.id ? { ...x, ...p.new } : x)))
      .subscribe()

    const clock = setInterval(() => setTime(new Date()), 1000)
    return () => {
      clearInterval(tp); sb.removeChannel(ch); clearInterval(clock) }
  }, [])

  const inbound = useMemo(() => inboundStats(tasks), [tasks])
  const outbound = useMemo(() => outboundStats(logs), [logs])

  const queued = tasks.filter(t => t.state === 'queued' && !t.ended_at)
  const longestWait = queued.length ? Math.max(...queued.map(t => Math.round((Date.now() - new Date(t.queued_at)) / 1000))) : 0
  const liveInbound = tasks.filter(t => t.state === 'answered' && !t.ended_at).length
  const liveOutbound = liveCalls.filter(c => c.direction === 'outbound' && !c.ended_at && ['in-progress','answered','initiated','ringing'].includes(c.status)).length
  // Not staffed on the floor: the owner (watches this TV) and the field
  // managers Dean Christian and Cedric Hendricks (Brandyn, Sep 21, 2026).
  // Brittany and Deanna stay — they take calls.
  const HIDE_FROM_TV = new Set([
    '35d1b28f-e6f4-4e46-b63c-9544ae7af00b',   // Brandyn Nuffer
    'aa8b6dae-0b7a-48cd-80ca-2e365d56d86f',   // Dean Christian
    '382fe5bc-ad13-4228-b3eb-179d78ac7853',   // Cedric Hendricks
  ])
  const floor = profiles.filter(p => !HIDE_FROM_TV.has(p.id))
  const agentsAvailable = floor.filter(p => p.status === 'Available').length

  // Leaderboard — bookings drive the ranking (the live motivational number),
  // then total calls. Rows are keyed by rep and positioned by rank so they
  // slide when the order changes.
  const byName = {}
  profiles.forEach(p => { byName[p.name || p.email] = p })
  const repStats = {}
  logs.forEach(l => {
    if (!l.rep) return
    const r = repStats[l.rep] || (repStats[l.rep] = { rep:l.rep, calls:0, booked:0, lastCall:null })
    r.calls++
    if (l.outcome === 'Booked') r.booked++
    if (!r.lastCall || new Date(l.created_at) > new Date(r.lastCall)) r.lastCall = l.created_at
  })
  tasks.forEach(t => {
    if (t.state !== 'answered' || !t.agent_name) return
    const r = repStats[t.agent_name] || (repStats[t.agent_name] = { rep:t.agent_name, calls:0, booked:0, lastCall:null })
    r.inbound = (r.inbound || 0) + 1
  })
  const leaderboard = Object.values(repStats).sort((a, b) => b.booked - a.booked || b.calls - a.calls)
  const monthly = (csrMonth?.csrs || []).slice(0, 10)
  const monthName = fmtDate(new Date(), { month: 'long' })

  const agents = [...floor].sort((a, b) =>
    (STATUS_ORDER[a.status] ?? 6) - (STATUS_ORDER[b.status] ?? 6) || (a.name||'').localeCompare(b.name||''))

  // Live feed: bookings pop, everything else scrolls under.
  // One stream, two kinds of wins: CSR call outcomes and tech SALES.
  const feed = [
    ...logs.map(l => ({ kind: 'call', at: l.created_at, ...l })),
    ...booked.map(b => ({ kind: 'booked', ...b })),
    ...sales.map(x => ({ kind: 'sale', at: x.soldOn, ...x })),
    ...wins.reviews.map(x => ({ kind: 'review', ...x })),
    ...wins.memberships.map(x => ({ kind: 'membership', ...x })),
    ...(wins.bonus ? [{ kind: 'bonus', ...wins.bonus }] : []),
  ].sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0)).slice(0, 40)

  const slColor = inbound.serviceLevel == null ? C.dim : inbound.serviceLevel >= SERVICE_LEVEL_TARGET ? C.green : inbound.serviceLevel >= 60 ? C.amber : C.red
  const abColor = inbound.abandonRate == null ? C.dim : inbound.abandonRate <= 5 ? C.green : inbound.abandonRate <= 10 ? C.amber : C.red
  const queueColor = queued.length === 0 ? C.green : longestWait > 60 ? C.red : C.amber
  const zoom = narrow ? fit : 1.08
  const rowH = narrow ? 40 : ROW_H
  const floorRowH = narrow ? 30 : 60
  const feedRowH = narrow ? 38 : 56
  const feedFits = feedH ? Math.max(1, Math.floor(feedH / feedRowH)) : 10

  return (
    <div ref={rootRef} style={{ minHeight:`calc(100vh / ${zoom})`, height:`calc(100vh / ${zoom})`, background:C.bg, color:C.text,
      fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      // Readable-from-across-the-floor: everything 8% bigger on a real monitor,
      // height compensated so the board still exactly fills it. On a TV-class
      // viewport the zoom is measured instead, so nothing falls off the bottom.
      zoom,
      padding: narrow ? '10px 14px' : 20, display:'flex', flexDirection:'column', gap: narrow ? 8 : 14, overflow:'hidden', boxSizing:'border-box' }}>

      {/* Floor ticker — one strip that sweeps the admin-set messages across the
          top, enters from the right, exits left, repeats. paddingLeft:100%
          starts it off-screen right; a single copy means no phantom duplicate. */}
      {ticker.enabled && ticker.messages.length > 0 && (
        <div style={{ overflow:'hidden', whiteSpace:'nowrap', background:'#000', border:`1px solid ${C.border}`, borderRadius:10, flexShrink:0 }}>
          <div style={{ display:'inline-block', paddingLeft:'100%', animation:'wr-marquee 24s linear infinite', willChange:'transform' }}>
            {ticker.messages.map((m, i) => {
              const col = m.tone === 'alert' ? C.red : m.tone === 'success' ? C.green : C.text
              return (
                <span key={i} style={{ display:'inline-block', padding: narrow ? '4px 0' : '8px 0', margin:'0 44px', fontSize: narrow ? 14 : 18, fontWeight:700, color:col, letterSpacing:.3 }}>
                  {m.tone === 'alert' ? '⚠ ' : ''}{m.text}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0, gap: narrow ? 12 : 0, flexWrap: narrow ? 'wrap' : 'nowrap', minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap: narrow ? 8 : 12, flexShrink:0 }}>
          <span className="pulse-mark" style={{ width: narrow ? 32 : 40, height: narrow ? 32 : 40, borderRadius:11, background:'#0b0c0f', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 6px 18px rgba(255,117,31,.15)' }}>
            <svg width="26" height="26" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
              <polyline points="9,32 19,32 25,17 33,47 40,26 45,32 55,32" fill="none" stroke="#ff751f" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          <span style={{ fontSize: narrow ? 17 : 21, fontWeight:800, letterSpacing:.3, whiteSpace:'nowrap' }}>Call Center</span>
          <div style={{ width:8, height:8, borderRadius:'50%', background:C.green, animation:'wr-pulse 1.5s infinite' }} />
          {!narrow && <span style={{ fontSize:12, color:C.muted, letterSpacing:1 }}>LIVE</span>}
        </div>

        {/* Today's money — sold revenue + sales + club count, front and center */}
        {(() => {
          const soldTotal = sales.reduce((a, x) => a + (Number(x.amount) || 0), 0)
          const clubCount = wins.memberships.length
          const starCount = wins.reviews.length
          return (
            <div style={{ display:'flex', alignItems:'center', gap: narrow ? 14 : 26 }}>
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize: narrow ? 22 : 30, fontWeight:800, letterSpacing:-1, color: soldTotal >= 10000 ? '#F0B429' : C.green, fontVariantNumeric:'tabular-nums', lineHeight:1 }}>
                  ${soldTotal.toLocaleString()}
                </div>
                <div style={{ fontSize:10, fontWeight:700, letterSpacing:1.2, color:C.muted, textTransform:'uppercase', marginTop:3 }}>Sold today</div>
              </div>
              <div style={{ width:1, height: narrow ? 26 : 34, background:C.border }} />
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize: narrow ? 22 : 30, fontWeight:800, letterSpacing:-1, color:C.text, fontVariantNumeric:'tabular-nums', lineHeight:1 }}>{sales.length}</div>
                <div style={{ fontSize:10, fontWeight:700, letterSpacing:1.2, color:C.muted, textTransform:'uppercase', marginTop:3 }}>Sales</div>
              </div>
              <div style={{ width:1, height: narrow ? 26 : 34, background:C.border }} />
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize: narrow ? 22 : 30, fontWeight:800, letterSpacing:-1, color:C.purple, fontVariantNumeric:'tabular-nums', lineHeight:1 }}>{clubCount}</div>
                <div style={{ fontSize:10, fontWeight:700, letterSpacing:1.2, color:C.muted, textTransform:'uppercase', marginTop:3 }}>Clubs</div>
              </div>
              <div style={{ width:1, height: narrow ? 26 : 34, background:C.border }} />
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize: narrow ? 22 : 30, fontWeight:800, letterSpacing:-1, color:C.amber, fontVariantNumeric:'tabular-nums', lineHeight:1 }}>{starCount}</div>
                <div style={{ fontSize:10, fontWeight:700, letterSpacing:1.2, color:C.muted, textTransform:'uppercase', marginTop:3 }}>5★ Reviews</div>
              </div>
            </div>
          )
        })()}

        <div style={{ display:'flex', alignItems:'center', gap: narrow ? 12 : 16, marginLeft:'auto', justifyContent:'flex-end', flexShrink:0 }}>
          <div style={{ zoom: narrow ? .7 : 1 }}><WeatherStrip dark /></div>
          {!(narrow && isFull) && <button onClick={toggleFull} title={isFull ? 'Exit fullscreen' : 'Fullscreen'}
            style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:8, color:C.muted, cursor:'pointer', padding:'8px 10px', display:'flex', alignItems:'center' }}>
            {isFull ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 3v3a3 3 0 01-3 3H3M15 3v3a3 3 0 003 3h3M9 21v-3a3 3 0 00-3-3H3M15 21v-3a3 3 0 013-3h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 9V5a2 2 0 012-2h4M21 9V5a2 2 0 00-2-2h-4M3 15v4a2 2 0 002 2h4M21 15v4a2 2 0 01-2 2h-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            )}
          </button>}
          <div style={{ textAlign:'right' }}>
            <div style={{ fontSize: narrow ? 20 : 30, fontWeight:800, letterSpacing:-1, color:C.blue, fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>
              {fmtTime(time, { hour:'2-digit', minute:'2-digit', second:'2-digit' })}
            </div>
            <div style={{ fontSize: narrow ? 11 : 12, color:C.muted, whiteSpace:'nowrap' }}>{fmtDate(time, { weekday:'long', month:'long', day:'numeric' })}</div>
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(8, 1fr)', gap: narrow ? 8 : 12, flexShrink:0 }}>
        <Kpi compact={narrow} label="In Queue" value={queued.length} color={queueColor} glow={queued.length > 0}
          sub={queued.length ? `longest ${fmtWait(longestWait)}` : 'clear'} />
        <Kpi compact={narrow} label="Live Calls" value={liveInbound + liveOutbound} color={C.blue}
          sub={`${liveInbound} in · ${liveOutbound} out`} />
        <Kpi compact={narrow} label={`Service Lvl ${SERVICE_LEVEL_SECONDS}s`} value={inbound.serviceLevel == null ? '—' : `${Math.round(inbound.serviceLevel)}%`} color={slColor} sub={`target ${SERVICE_LEVEL_TARGET}%`} />
        <Kpi compact={narrow} label="Abandon" value={inbound.abandonRate == null ? '—' : `${Math.round(inbound.abandonRate)}%`} color={abColor} sub={`${inbound.abandoned} lost`} />
        <Kpi compact={narrow} label="Calls Offered" value={inbound.offered} color={C.text} sub={`${inbound.handled} handled`} />
        <Kpi compact={narrow} label="Avg Answer" value={fmtSecs(inbound.asa)} color={C.text} sub="speed to answer" />
        <Kpi compact={narrow} label="Booked Today" value={outbound.booked} color={C.green} glow={outbound.booked > 0} sub={`${outbound.calls} calls`} />
        <Kpi compact={narrow} label="Agents Ready" value={agentsAvailable} color={agentsAvailable ? C.green : C.red} sub={`of ${floor.length} on`} />
      </div>

      {/* 3-Day Call Board — today's calls needed per trade */}
      {board?.board && (
        <div style={{ display:'grid', gridTemplateColumns:`repeat(${board.board.length}, 1fr)`, gap: narrow ? 8 : 12, flexShrink:0 }}>
          {board.board.map(row => {
            const d = row.days[0] || {}
            const col = d.status === 'good' ? C.green : d.status === 'warn' ? C.amber : d.status === 'under' ? C.red : C.dim
            // Opportunity Watch: the board is FULL, not CLOSED. CSRs keep
            // booking high-value calls — dispatch makes room by moving
            // low-value ones. Purple + pulse so the floor can't miss it.
            const watch = Boolean(d.oppWatch)
            return (
              <div key={row.trade} style={{ background:C.panel, border:`1px solid ${watch ? '#7C3AED' : C.border}`, borderTop:`3px solid ${watch ? '#7C3AED' : col}`, borderRadius: narrow ? 10 : 14, padding: narrow ? '7px 10px' : '12px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, minWidth:0 }}>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontSize: narrow ? 10 : 11, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:C.muted, whiteSpace:'nowrap' }}>{row.trade}</div>
                  <div style={{ fontSize: narrow ? 11 : 12, color:C.muted, marginTop:3, whiteSpace:'nowrap' }}>{d.calls}/{d.capacity} booked · {d.pct}%</div>
                </div>
                {watch ? (
                  <div style={{ textAlign:'right', flexShrink:0 }}>
                    <div style={{ fontSize: narrow ? 11 : 15, fontWeight:800, lineHeight:1.15, color:'#A78BFA', letterSpacing:.4, animation:'wr-pulse 1.5s infinite', whiteSpace:'nowrap' }}>
                      {narrow ? '👀 OPP WATCH' : <>👀 OPPORTUNITY<br />WATCH</>}
                    </div>
                    <div style={{ fontSize: narrow ? 8 : 9, color:C.muted, textTransform:'uppercase', letterSpacing:.4, marginTop:2, whiteSpace:'nowrap' }}>{narrow ? 'full — keep booking' : 'full — still book strong calls'}</div>
                  </div>
                ) : (
                  <div style={{ textAlign:'right', flexShrink:0 }}>
                    <div style={{ fontSize: narrow ? 24 : 32, fontWeight:800, lineHeight:1, color: d.needed > 0 ? col : C.green, fontVariantNumeric:'tabular-nums' }}>
                      {d.needed > 0 ? d.needed : '✓'}
                    </div>
                    <div style={{ fontSize:10, color:C.muted, textTransform:'uppercase', letterSpacing:.4 }}>{d.needed > 0 ? 'calls needed' : 'at target'}</div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Main grid */}
      <div style={{ display:'grid', gridTemplateColumns:'1.2fr 0.8fr 1.3fr', gap: narrow ? 8 : 14, flex:1, minHeight: narrow ? Math.max(260, monthly.length * rowH + 48, agents.length * floorRowH + 48) : 0 }}>

        {/* Monthly leaderboard — same idea as the department TVs' tech ranking:
            booking % · clubs · call QA into one score, month to date, medals. */}
        <Panel compact={narrow} title={`${monthName.toUpperCase()} LEADERBOARD`} icon="🏆">
          <div style={{ position:'relative', height: Math.max(monthly.length * rowH, 40), padding:'6px 0' }}>
            {!csrMonth && <div style={{ padding:'30px 20px', color:C.muted, fontSize:14, textAlign:'center' }}>Loading the month…</div>}
            {csrMonth && monthly.length === 0 && (
              <div style={{ padding:'30px 20px', color:C.muted, fontSize:14, textAlign:'center' }}>No lead calls yet this month</div>
            )}
            {monthly.map((d, i) => {
              const p = byName[d.name]
              const isLeader = i === 0 && d.rankable
              const medal = d.rankable ? ['🥇','🥈','🥉'][i] : null
              const pctColor = d.bookingPct == null ? C.muted : d.bookingPct >= 80 ? C.green : d.bookingPct >= 65 ? C.amber : C.red
              return (
                <div key={d.profileId || d.name} style={{ position:'absolute', left:0, right:0, top:i * rowH + 6, height:rowH - 8,
                  transition:'top .6s cubic-bezier(.22,1,.36,1)', padding: narrow ? '0 10px' : '0 16px', display:'flex', alignItems:'center', gap: narrow ? 8 : 12, opacity: d.rankable ? 1 : .6 }}>
                  <div style={{ width: narrow ? 22 : 34, textAlign:'center', fontSize: medal ? (narrow ? 15 : 24) : (narrow ? 11 : 16), fontWeight:800, color: medal ? undefined : C.dim, flexShrink:0 }}>
                    {medal || `#${i+1}`}
                  </div>
                  <div style={{ width: narrow ? 26 : 42, height: narrow ? 26 : 42, borderRadius:'50%', flexShrink:0,
                    background: isLeader ? 'linear-gradient(135deg,#D29922,#F0883E)' : C.panel2,
                    border:`2px solid ${isLeader ? C.amber : C.border}`, color: isLeader ? '#000' : C.text,
                    display:'flex', alignItems:'center', justifyContent:'center', fontSize: p?.avatar ? (narrow ? 14 : 22) : (narrow ? 10 : 14), fontWeight:800,
                    boxShadow: isLeader ? `0 0 18px ${C.amber}66` : 'none' }}>
                    <Avatar avatar={p?.avatar} name={d.name} />
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize: narrow ? 12 : 16, fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', lineHeight:1.15 }}>{d.name}</div>
                    <div style={{ display:'flex', gap: narrow ? 7 : 12, marginTop: narrow ? 1 : 3, fontSize: narrow ? 9 : 12, color:C.muted, whiteSpace:'nowrap', overflow:'hidden' }}>
                      <span>{d.booked}/{d.leadCalls}{narrow ? '' : ' booked'}</span>
                      <span style={{ color: d.clubs ? C.purple : C.muted }}>{d.clubs} club{d.clubs === 1 ? '' : 's'}</span>
                      <span style={{ color: d.qa == null ? C.muted : d.qa >= 85 ? C.green : d.qa >= 75 ? C.amber : C.red }}>{d.qa == null ? 'QA —' : `QA ${d.qa}%`}</span>
                      {!d.rankable && <span>{10 - d.leadCalls} more lead calls to rank</span>}
                    </div>
                  </div>
                  <div style={{ textAlign:'right', flexShrink:0 }}>
                    <div style={{ fontSize: narrow ? 18 : 30, fontWeight:800, color:pctColor, lineHeight:1, fontVariantNumeric:'tabular-nums' }}>{d.bookingPct == null ? '—' : `${d.bookingPct}%`}</div>
                    <div style={{ fontSize: narrow ? 8 : 10, color:C.muted, textTransform:'uppercase', letterSpacing:.5, whiteSpace:'nowrap' }}>{narrow ? (d.score != null ? `score ${d.score}` : 'booking') : `Booking${d.score != null ? ` · score ${d.score}` : ''}`}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </Panel>

        {/* Agents + queue */}
        <Panel compact={narrow} title="THE FLOOR" icon="🎧" live>
          <div style={{ overflowY:'auto', height:'100%' }}>
            {queued.length > 0 && (
              <div style={{ padding:'10px 16px', background:`${C.red}18`, borderBottom:`1px solid ${C.border}` }}>
                <div style={{ fontSize:11, fontWeight:700, color:C.red, letterSpacing:.5, marginBottom:6 }}>WAITING IN QUEUE · {queued.length}</div>
                {[...queued].sort((a,b) => new Date(a.queued_at) - new Date(b.queued_at)).slice(0,4).map(t => {
                  const w = Math.round((Date.now() - new Date(t.queued_at)) / 1000)
                  return (
                    <div key={t.task_sid} style={{ display:'flex', justifyContent:'space-between', fontSize:13, padding:'2px 0' }}>
                      <span style={{ color:C.text }}>{t.contact_name || t.from_number || 'Caller'}</span>
                      <span style={{ fontWeight:700, color: w > 60 ? C.red : C.amber, fontVariantNumeric:'tabular-nums' }}>{fmtWait(w)}</span>
                    </div>
                  )
                })}
              </div>
            )}
            {agents.map(p => {
              const color = STATUS_COLORS[p.status] || C.dim
              const onCall = p.status === 'On Call'
              return (
                <div key={p.id} style={{ padding: narrow ? '3px 10px' : '11px 16px', minHeight: narrow ? floorRowH : undefined, boxSizing:'border-box', borderBottom:`1px solid ${C.panel2}`, display:'flex', alignItems:'center', gap: narrow ? 8 : 11,
                  opacity: p.status === 'Offline' ? 0.5 : 1 }}>
                  <div style={{ width: narrow ? 22 : 36, height: narrow ? 22 : 36, borderRadius:'50%', background:C.panel2, border:`2px solid ${color}`,
                    display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? (narrow ? 12 : 18) : (narrow ? 9 : 12), fontWeight:800, flexShrink:0,
                    boxShadow: onCall ? `0 0 12px ${color}77` : 'none' }}>
                    <Avatar avatar={p.avatar} name={p.name || p.email} />
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize: narrow ? 11 : 14, fontWeight:600, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{p.name || p.email}{narrow && p.status !== 'Offline' && <span style={{ fontWeight:400, color:C.muted, fontSize:9 }}> · {timeSince(p.status_since)}</span>}</div>
                    {!narrow && <div style={{ fontSize:11, color:C.muted, whiteSpace:'nowrap' }}>in status {timeSince(p.status_since)}</div>}
                  </div>
                  {/* What kind of interaction — sits between the name and the
                      status so the floor reads "who / on what / how long". */}
                  {p.interaction_type && ['On Call', 'Wrap Up'].includes(p.status) && (
                    <span style={{ fontSize:11, fontWeight:700, flexShrink:0, padding:'4px 10px', borderRadius:99,
                      color: INTERACTION_COLORS[p.interaction_type] || C.muted,
                      background: `${INTERACTION_COLORS[p.interaction_type] || C.muted}1f` }}>
                      {p.interaction_type}
                    </span>
                  )}
                  <span style={{ fontSize: narrow ? 8 : 11, fontWeight:700, color, background:`${color}1f`, padding: narrow ? '1px 6px' : '4px 10px', borderRadius:99, flexShrink:0,
                    display:'flex', alignItems:'center', gap:5 }}>
                    {onCall && <span style={{ width:6, height:6, borderRadius:'50%', background:color, animation:'wr-pulse 1.2s infinite' }} />}
                    {p.status || 'Offline'}
                  </span>
                </div>
              )
            })}
            {agents.length === 0 && <div style={{ padding:'30px 20px', color:C.muted, fontSize:14, textAlign:'center' }}>No agents on</div>}
          </div>
        </Panel>

        {/* Live activity */}
        <Panel compact={narrow} title="LIVE ACTIVITY" icon="⚡" live>
          <div ref={feedRef} style={{ overflow:'hidden', height:'100%' }}>
            {feed.length === 0 ? (
              <div style={{ padding:'30px 20px', color:C.muted, fontSize:14, textAlign:'center' }}>Waiting for activity…</div>
            ) : feed.slice(0, feedFits).map((l, i) => {
              const t = (v) => v ? fmtTime(v, { hour:'2-digit', minute:'2-digit' }) : ''
              if (l.kind === 'bonus') {
                const g = '#F0B429'
                return (
                  <div key={l.id} style={{ height: feedRowH, boxSizing:'border-box', padding: narrow ? '0 10px' : '0 16px', borderBottom:`1px solid ${C.panel2}`, display:'flex', alignItems:'center', gap: narrow ? 8 : 11,
                    opacity: i > 9 ? 0.45 : 1, background:`${g}1c`, boxShadow:`inset 3px 0 0 ${g}` }}>
                    <div style={{ width:9, height:9, borderRadius:'50%', background:g, flexShrink:0, boxShadow:`0 0 12px ${g}` }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize: narrow ? 12 : 14, fontWeight:800, color:g, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                        🎯 OPPORTUNITY WATCH BONUS UNLOCKED
                      </div>
                      <div style={{ fontSize: narrow ? 9 : 11, color:C.muted }}>${Number(l.pool).toFixed(0)} pool {l.n != null ? `split ${l.n} ways` : '— pays tonight to everyone working today'} · {t(l.at)}</div>
                    </div>
                    <span style={{ fontSize:12, fontWeight:800, color:g, flexShrink:0 }}>💰🎉</span>
                  </div>
                )
              }
              if (l.kind === 'review') {
                return (
                  <div key={l.id} style={{ height: feedRowH, boxSizing:'border-box', padding: narrow ? '0 10px' : '0 16px', borderBottom:`1px solid ${C.panel2}`, display:'flex', alignItems:'center', gap: narrow ? 8 : 11,
                    opacity: i > 9 ? 0.45 : 1, background:`${C.amber}10` }}>
                    <div style={{ width:9, height:9, borderRadius:'50%', background:C.amber, flexShrink:0 }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize: narrow ? 12 : 14, fontWeight:700, color:C.amber, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                        ⭐ {l.tech || 'The team'} got a 5-star review
                      </div>
                      <div style={{ fontSize: narrow ? 9 : 11, color:C.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                        {l.author} on {l.platform} · {t(l.at)}
                      </div>
                    </div>
                    <span style={{ fontSize:12, fontWeight:700, color:C.amber, flexShrink:0 }}>★★★★★</span>
                  </div>
                )
              }
              if (l.kind === 'booked') {
                const blue = C.blue || '#60A5FA'
                const sub = [l.jobType, l.job ? `#${l.job}` : null].filter(Boolean).join(' · ')
                return (
                  <div key={l.id} style={{ height: feedRowH, boxSizing:'border-box', padding: narrow ? '0 10px' : '0 16px', borderBottom:`1px solid ${C.panel2}`, display:'flex', alignItems:'center', gap: narrow ? 8 : 11,
                    opacity: i > 9 ? 0.45 : 1, background:`${blue}12` }}>
                    <div style={{ width:9, height:9, borderRadius:'50%', background:blue, flexShrink:0, boxShadow:`0 0 10px ${blue}` }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize: narrow ? 12 : 14, fontWeight:700, color:blue, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                        📞 {l.csr || 'A CSR'} booked a call {bookedForLabel(l.apptStart, l.onHold)}
                      </div>
                      <div style={{ fontSize: narrow ? 9 : 11, color:C.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                        {sub}{sub ? ' · ' : ''}{t(l.at)}
                      </div>
                    </div>
                    <span style={{ fontSize:12, fontWeight:700, color:blue, flexShrink:0 }}>BOOKED</span>
                  </div>
                )
              }
              if (l.kind === 'membership') {
                return (
                  <div key={l.id} style={{ height: feedRowH, boxSizing:'border-box', padding: narrow ? '0 10px' : '0 16px', borderBottom:`1px solid ${C.panel2}`, display:'flex', alignItems:'center', gap: narrow ? 8 : 11,
                    opacity: i > 9 ? 0.45 : 1, background:`${C.purple}12` }}>
                    <div style={{ width:9, height:9, borderRadius:'50%', background:C.purple, flexShrink:0 }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize: narrow ? 12 : 14, fontWeight:700, color:C.purple, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                        🏅 {l.seller} sold a membership
                      </div>
                      <div style={{ fontSize: narrow ? 9 : 11, color:C.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                        {l.type} · {t(l.at)}
                      </div>
                    </div>
                    <span style={{ fontSize:12, fontWeight:700, color:C.purple, flexShrink:0 }}>CLUB</span>
                  </div>
                )
              }
              if (l.kind === 'sale') {
                const big = l.amount >= 1000
                return (
                  <div key={l.id} style={{ height: feedRowH, boxSizing:'border-box', padding: narrow ? '0 10px' : '0 16px', borderBottom:`1px solid ${C.panel2}`, display:'flex', alignItems:'center', gap: narrow ? 8 : 11,
                    opacity: i > 9 ? 0.45 : 1, background: big ? '#B4530918' : `${C.green}10` }}>
                    <div style={{ width:9, height:9, borderRadius:'50%', background: big ? '#F59E0B' : C.green, flexShrink:0, boxShadow: big ? '0 0 10px #F59E0B' : 'none' }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize: narrow ? 12 : 14, fontWeight:700, color: big ? '#F59E0B' : C.green, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                        💰 {l.tech} sold ${l.amount.toLocaleString()}
                      </div>
                      <div style={{ fontSize: narrow ? 9 : 11, color:C.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                        {l.what} · {l.at ? fmtTime(l.at, { hour:'2-digit', minute:'2-digit' }) : ''}
                      </div>
                    </div>
                    <span style={{ fontSize:12, fontWeight:700, color: big ? '#F59E0B' : C.green, flexShrink:0 }}>SOLD</span>
                  </div>
                )
              }
              const color = OUTCOME_COLORS[l.outcome] || C.dim
              const c = contacts.find(x => x.id === l.contact_id)
              const booked = l.outcome === 'Booked'
              return (
                <div key={l.id} style={{ height: feedRowH, boxSizing:'border-box', padding: narrow ? '0 10px' : '0 16px', borderBottom:`1px solid ${C.panel2}`, display:'flex', alignItems:'center', gap: narrow ? 8 : 11,
                  opacity: i > 9 ? 0.45 : 1, background: booked ? `${C.green}12` : 'transparent' }}>
                  <div style={{ width:9, height:9, borderRadius:'50%', background:color, flexShrink:0, boxShadow: booked ? `0 0 10px ${color}` : 'none' }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize: narrow ? 12 : 14, fontWeight:600, color: booked ? C.green : C.text, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                      {booked ? '🎉 ' : ''}{c?.name || l.contact_name || '—'}
                    </div>
                    <div style={{ fontSize: narrow ? 9 : 11, color:C.muted }}>{l.rep} · {fmtTime(l.created_at, { hour:'2-digit', minute:'2-digit' })}</div>
                  </div>
                  <span style={{ fontSize:12, fontWeight:700, color, flexShrink:0 }}>{l.outcome}</span>
                </div>
              )
            })}
          </div>
        </Panel>
      </div>

      <style>{`
        @keyframes wr-pulse { 0%,100%{opacity:1} 50%{opacity:.25} }
        @keyframes wr-marquee { from{transform:translateX(0)} to{transform:translateX(-100%)} }
      `}</style>
    </div>
  )
}
