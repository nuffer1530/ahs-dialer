import { useState, useEffect, useMemo, useRef } from 'react'
import { sb } from '../lib/supabase'
import { useData } from '../lib/DataContext'
import { inboundStats, outboundStats, fmtSecs, SERVICE_LEVEL_SECONDS, SERVICE_LEVEL_TARGET } from '../lib/analytics'
import { INTERACTION_COLORS } from '../lib/constants'
import Avatar from '../components/Avatar'

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

const startOfToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d }
const fmtWait = (s) => s == null ? '—' : s < 60 ? `${s}s` : `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`
const timeSince = (iso) => {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s/60)}m`
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`
}

function Kpi({ label, value, sub, color = C.text, glow }) {
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, padding:'14px 18px',
      borderTop:`3px solid ${color}`, boxShadow: glow ? `0 0 24px ${color}44` : 'none', minWidth:0 }}>
      <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:.8, color:C.muted, marginBottom:6 }}>{label}</div>
      <div style={{ fontSize:40, fontWeight:800, color, letterSpacing:-1.5, lineHeight:1, fontVariantNumeric:'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:C.muted, marginTop:5 }}>{sub}</div>}
    </div>
  )
}

function Panel({ title, icon, live, children, style }) {
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:14, overflow:'hidden', display:'flex', flexDirection:'column', ...style }}>
      <div style={{ padding:'13px 18px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
        <span style={{ fontSize:16 }}>{icon}</span>
        <span style={{ fontSize:13, fontWeight:700, letterSpacing:.5, color:C.text }}>{title}</span>
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
  const [isFull, setIsFull] = useState(false)
  const rootRef = useRef(null)

  // 3-Day Call Board — show today's "calls needed" per trade on the TV.
  useEffect(() => {
    const load = () => fetch('/api/board/3day').then(r => r.json()).then(setBoard).catch(() => {})
    load()
    const t = setInterval(load, 90_000)
    return () => clearInterval(t)
  }, [])

  // Fullscreen the wallboard itself (not the whole app) so the nav drops away.
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen?.()
    else rootRef.current?.requestFullscreen?.()
  }
  useEffect(() => {
    const onFs = () => setIsFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
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
      sb.from('profiles').select('id, name, email, avatar, status, status_since, interaction_type').eq('active', true),
    ]).then(([l, t, a, p]) => {
      setLogs(l.data || []); setTasks(t.data || []); setLiveCalls(a.data || []); setProfiles(p.data || [])
    })

    const upsert = (setter, key) => (payload) => setter(prev => {
      if (payload.eventType === 'DELETE') return prev.filter(x => x[key] !== payload.old[key])
      const i = prev.findIndex(x => x[key] === payload.new[key])
      if (i === -1) return [payload.new, ...prev]
      const next = [...prev]; next[i] = { ...next[i], ...payload.new }; return next
    })

    const ch = sb.channel('warroom')
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'call_logs' }, p => setLogs(prev => [p.new, ...prev]))
      .on('postgres_changes', { event:'*', schema:'public', table:'call_tasks' }, upsert(setTasks, 'task_sid'))
      .on('postgres_changes', { event:'*', schema:'public', table:'active_calls' }, upsert(setLiveCalls, 'call_sid'))
      .on('postgres_changes', { event:'UPDATE', schema:'public', table:'profiles' }, p =>
        setProfiles(prev => prev.map(x => x.id === p.new.id ? { ...x, ...p.new } : x)))
      .subscribe()

    const clock = setInterval(() => setTime(new Date()), 1000)
    return () => { sb.removeChannel(ch); clearInterval(clock) }
  }, [])

  const inbound = useMemo(() => inboundStats(tasks), [tasks])
  const outbound = useMemo(() => outboundStats(logs), [logs])

  const queued = tasks.filter(t => t.state === 'queued' && !t.ended_at)
  const longestWait = queued.length ? Math.max(...queued.map(t => Math.round((Date.now() - new Date(t.queued_at)) / 1000))) : 0
  const liveInbound = tasks.filter(t => t.state === 'answered' && !t.ended_at).length
  const liveOutbound = liveCalls.filter(c => c.direction === 'outbound' && !c.ended_at && ['in-progress','answered','initiated','ringing'].includes(c.status)).length
  const agentsAvailable = profiles.filter(p => p.status === 'Available').length

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

  const agents = [...profiles].sort((a, b) =>
    (STATUS_ORDER[a.status] ?? 6) - (STATUS_ORDER[b.status] ?? 6) || (a.name||'').localeCompare(b.name||''))

  // Live feed: bookings pop, everything else scrolls under.
  const feed = logs.slice(0, 14)

  const slColor = inbound.serviceLevel == null ? C.dim : inbound.serviceLevel >= SERVICE_LEVEL_TARGET ? C.green : inbound.serviceLevel >= 60 ? C.amber : C.red
  const abColor = inbound.abandonRate == null ? C.dim : inbound.abandonRate <= 5 ? C.green : inbound.abandonRate <= 10 ? C.amber : C.red
  const queueColor = queued.length === 0 ? C.green : longestWait > 60 ? C.red : C.amber

  return (
    <div ref={rootRef} style={{ minHeight:'100vh', height:'100vh', background:C.bg, color:C.text,
      fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      padding:20, display:'flex', flexDirection:'column', gap:14, overflow:'hidden', boxSizing:'border-box' }}>

      {/* Floor ticker — one strip that sweeps the admin-set messages across the
          top, enters from the right, exits left, repeats. paddingLeft:100%
          starts it off-screen right; a single copy means no phantom duplicate. */}
      {ticker.enabled && ticker.messages.length > 0 && (
        <div style={{ overflow:'hidden', whiteSpace:'nowrap', background:'#000', border:`1px solid ${C.border}`, borderRadius:10, flexShrink:0 }}>
          <div style={{ display:'inline-block', paddingLeft:'100%', animation:'wr-marquee 24s linear infinite', willChange:'transform' }}>
            {ticker.messages.map((m, i) => {
              const col = m.tone === 'alert' ? C.red : m.tone === 'success' ? C.green : C.text
              return (
                <span key={i} style={{ display:'inline-block', padding:'8px 0', margin:'0 44px', fontSize:18, fontWeight:700, color:col, letterSpacing:.3 }}>
                  {m.tone === 'alert' ? '⚠ ' : ''}{m.text}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <span style={{ background:'#1A5C8A', color:'#fff', fontSize:15, fontWeight:800, padding:'4px 11px', borderRadius:6, letterSpacing:.5 }}>AHS</span>
          <span style={{ fontSize:21, fontWeight:800, letterSpacing:.3 }}>Call Center</span>
          <div style={{ width:8, height:8, borderRadius:'50%', background:C.green, animation:'wr-pulse 1.5s infinite' }} />
          <span style={{ fontSize:12, color:C.muted, letterSpacing:1 }}>LIVE</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
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

      {/* KPI strip */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(8, 1fr)', gap:12, flexShrink:0 }}>
        <Kpi label="In Queue" value={queued.length} color={queueColor} glow={queued.length > 0}
          sub={queued.length ? `longest ${fmtWait(longestWait)}` : 'clear'} />
        <Kpi label="Live Calls" value={liveInbound + liveOutbound} color={C.blue}
          sub={`${liveInbound} in · ${liveOutbound} out`} />
        <Kpi label={`Service Lvl ${SERVICE_LEVEL_SECONDS}s`} value={inbound.serviceLevel == null ? '—' : `${Math.round(inbound.serviceLevel)}%`} color={slColor} sub={`target ${SERVICE_LEVEL_TARGET}%`} />
        <Kpi label="Abandon" value={inbound.abandonRate == null ? '—' : `${Math.round(inbound.abandonRate)}%`} color={abColor} sub={`${inbound.abandoned} lost`} />
        <Kpi label="Calls Offered" value={inbound.offered} color={C.text} sub={`${inbound.handled} handled`} />
        <Kpi label="Avg Answer" value={fmtSecs(inbound.asa)} color={C.text} sub="speed to answer" />
        <Kpi label="Booked Today" value={outbound.booked} color={C.green} glow={outbound.booked > 0} sub={`${outbound.calls} calls`} />
        <Kpi label="Agents Ready" value={agentsAvailable} color={agentsAvailable ? C.green : C.red} sub={`of ${profiles.length} on`} />
      </div>

      {/* 3-Day Call Board — today's calls needed per trade */}
      {board?.board && (
        <div style={{ display:'grid', gridTemplateColumns:`repeat(${board.board.length}, 1fr)`, gap:12, flexShrink:0 }}>
          {board.board.map(row => {
            const d = row.days[0] || {}
            const col = d.status === 'good' ? C.green : d.status === 'warn' ? C.amber : d.status === 'under' ? C.red : C.dim
            return (
              <div key={row.trade} style={{ background:C.panel, border:`1px solid ${C.border}`, borderTop:`3px solid ${col}`, borderRadius:14, padding:'12px 16px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <div>
                  <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:C.muted }}>{row.trade}</div>
                  <div style={{ fontSize:12, color:C.muted, marginTop:3 }}>{d.calls}/{d.capacity} booked · {d.pct}%</div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ fontSize:32, fontWeight:800, lineHeight:1, color: d.needed > 0 ? col : C.green, fontVariantNumeric:'tabular-nums' }}>
                    {d.needed > 0 ? d.needed : '✓'}
                  </div>
                  <div style={{ fontSize:10, color:C.muted, textTransform:'uppercase', letterSpacing:.4 }}>{d.needed > 0 ? 'calls needed' : 'at target'}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Main grid */}
      <div style={{ display:'grid', gridTemplateColumns:'1.25fr 1fr 1fr', gap:14, flex:1, minHeight:0 }}>

        {/* Leaderboard — animated */}
        <Panel title="TODAY'S LEADERBOARD" icon="🏆">
          <div style={{ position:'relative', height: Math.max(leaderboard.length * ROW_H, 40), padding:'6px 0' }}>
            {leaderboard.length === 0 && (
              <div style={{ padding:'30px 20px', color:C.muted, fontSize:14, textAlign:'center' }}>No calls logged yet today</div>
            )}
            {leaderboard.map((d, i) => {
              const conv = d.calls ? Math.round((d.booked / d.calls) * 100) : 0
              const active = d.lastCall && (Date.now() - new Date(d.lastCall)) < 15 * 60 * 1000
              const p = byName[d.rep]
              const isLeader = i === 0 && d.booked > 0
              const medal = ['🥇','🥈','🥉'][i]
              return (
                <div key={d.rep} style={{ position:'absolute', left:0, right:0, top:i * ROW_H + 6, height:ROW_H - 8,
                  transition:'top .6s cubic-bezier(.22,1,.36,1)', padding:'0 16px', display:'flex', alignItems:'center', gap:12 }}>
                  <div style={{ width:34, textAlign:'center', fontSize:medal ? 24 : 16, fontWeight:800, color: medal ? undefined : C.dim, flexShrink:0 }}>
                    {medal || `#${i+1}`}
                  </div>
                  <div style={{ width:42, height:42, borderRadius:'50%', flexShrink:0,
                    background: isLeader ? 'linear-gradient(135deg,#D29922,#F0883E)' : C.panel2,
                    border:`2px solid ${isLeader ? C.amber : C.border}`, color: isLeader ? '#000' : C.text,
                    display:'flex', alignItems:'center', justifyContent:'center', fontSize: p?.avatar ? 22 : 14, fontWeight:800,
                    boxShadow: isLeader ? `0 0 18px ${C.amber}66` : 'none' }}>
                    <Avatar avatar={p?.avatar} name={d.rep} />
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ fontSize:16, fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{d.rep}</span>
                      {active && <div style={{ width:7, height:7, borderRadius:'50%', background:C.green, animation:'wr-pulse 1.5s infinite', flexShrink:0 }} />}
                    </div>
                    <div style={{ display:'flex', gap:12, marginTop:3, fontSize:12, color:C.muted }}>
                      <span>{d.calls} calls</span>
                      {d.inbound ? <span>{d.inbound} inbound</span> : null}
                      <span style={{ color: conv >= 15 ? C.green : C.muted }}>{conv}% conv</span>
                    </div>
                  </div>
                  <div style={{ textAlign:'right', flexShrink:0 }}>
                    <div style={{ fontSize:30, fontWeight:800, color:C.green, lineHeight:1, fontVariantNumeric:'tabular-nums' }}>{d.booked}</div>
                    <div style={{ fontSize:10, color:C.muted, textTransform:'uppercase', letterSpacing:.5 }}>Booked</div>
                  </div>
                </div>
              )
            })}
          </div>
        </Panel>

        {/* Agents + queue */}
        <Panel title="THE FLOOR" icon="🎧" live>
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
                <div key={p.id} style={{ padding:'11px 16px', borderBottom:`1px solid ${C.panel2}`, display:'flex', alignItems:'center', gap:11,
                  opacity: p.status === 'Offline' ? 0.5 : 1 }}>
                  <div style={{ width:36, height:36, borderRadius:'50%', background:C.panel2, border:`2px solid ${color}`,
                    display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 18 : 12, fontWeight:800, flexShrink:0,
                    boxShadow: onCall ? `0 0 12px ${color}77` : 'none' }}>
                    <Avatar avatar={p.avatar} name={p.name || p.email} />
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:600, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{p.name || p.email}</div>
                    <div style={{ fontSize:11, color:C.muted }}>in status {timeSince(p.status_since)}</div>
                  </div>
                  {/* What kind of interaction — sits between the name and the
                      status so the floor reads "who / on what / how long". */}
                  {p.interaction_type && (
                    <span style={{ fontSize:11, fontWeight:700, flexShrink:0, padding:'4px 10px', borderRadius:99,
                      color: INTERACTION_COLORS[p.interaction_type] || C.muted,
                      background: `${INTERACTION_COLORS[p.interaction_type] || C.muted}1f` }}>
                      {p.interaction_type}
                    </span>
                  )}
                  <span style={{ fontSize:11, fontWeight:700, color, background:`${color}1f`, padding:'4px 10px', borderRadius:99, flexShrink:0,
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
        <Panel title="LIVE ACTIVITY" icon="⚡" live>
          <div style={{ overflowY:'auto', height:'100%' }}>
            {feed.length === 0 ? (
              <div style={{ padding:'30px 20px', color:C.muted, fontSize:14, textAlign:'center' }}>Waiting for activity…</div>
            ) : feed.map((l, i) => {
              const color = OUTCOME_COLORS[l.outcome] || C.dim
              const c = contacts.find(x => x.id === l.contact_id)
              const booked = l.outcome === 'Booked'
              return (
                <div key={l.id} style={{ padding:'11px 16px', borderBottom:`1px solid ${C.panel2}`, display:'flex', alignItems:'center', gap:11,
                  opacity: i > 9 ? 0.45 : 1, background: booked ? `${C.green}12` : 'transparent' }}>
                  <div style={{ width:9, height:9, borderRadius:'50%', background:color, flexShrink:0, boxShadow: booked ? `0 0 10px ${color}` : 'none' }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:600, color: booked ? C.green : C.text, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                      {booked ? '🎉 ' : ''}{c?.name || l.contact_name || '—'}
                    </div>
                    <div style={{ fontSize:11, color:C.muted }}>{l.rep} · {new Date(l.created_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</div>
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
