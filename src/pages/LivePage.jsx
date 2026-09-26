import { useState, useEffect, useRef } from 'react'
import { useData } from '../lib/DataContext'
import { useAuth } from '../lib/AuthContext'
import { usePhone } from '../lib/PhoneContext'
import { sb } from '../lib/supabase'
import Badge from '../components/Badge'
import { isDone, fmtShort, syncWorkerActivity } from '../lib/utils'
import { INTERACTION_COLORS } from '../lib/constants'
import { Stat, ToneChip, Face, eyebrow, num, panel } from '../components/ui'
import { useIsMobile } from '../lib/useIsMobile'

const DEFAULT_STATUS_OPTIONS = [
  { value: 'Available', color: '#22c55e' },
  { value: 'On Call',   color: '#3b82f6' },
  { value: 'Wrap Up',   color: '#f59e0b' },
  { value: 'Break',     color: '#a855f7' },
  { value: 'Lunch',     color: '#f97316' },
  { value: 'Offline',   color: '#6b7280' },
]

// Status and interaction colors are hexes an admin can change in Settings.
// The chips here draw from the theme's tone tokens instead (so they read in
// light and dark), taking the tone nearest each hex by hue: the defaults land
// where you'd expect — Available green, On Call blue, Wrap Up and Lunch amber,
// Break purple, Offline gray — and a custom status follows the color it got.
function toneOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim())
  if (!m) return 'gray'
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const sat = d === 0 ? 0 : d / (1 - Math.abs(max + min - 1))
  if (sat < 0.2 || d < 0.1) return 'gray'
  const h = ((max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360
  return h < 15 || h >= 335 ? 'red' : h < 65 ? 'amber' : h < 180 ? 'green' : h < 250 ? 'blue' : 'purple'
}

function timeSince(isoString) {
  if (!isoString) return '—'
  // Clamp: server timestamps can sit a second ahead of the browser clock,
  // which rendered as '-1s' right after a status change.
  const secs = Math.max(0, Math.floor((Date.now() - new Date(isoString)) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs/60)}m ${Math.floor(secs%60/60)}s`
  return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`
}

// Service level: answered within this many seconds of entering the queue.
const SERVICE_LEVEL_SECONDS = 30

function fmtWait(secs) {
  if (secs == null) return '—'
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

// One KPI — a zone of the summary panel. `tone` drives the color so a queue
// building up reads red at a glance from across the room. Each zone draws its
// hairline on its left and top edges and the panel clips the ones on its outer
// edge, so the dividers land right however many zones fit on a row.
const KPI_TONE = { good:'green', warn:'amber', bad:'red', accent:'blue' }
function Kpi({ label, value, sub, tone = 'default', big = false }) {
  return (
    <div style={{ padding:'16px 20px', minWidth:0, boxShadow:'-1px 0 0 var(--border), 0 -1px 0 var(--border)' }}>
      <Stat label={label} value={value} sub={sub} tone={KPI_TONE[tone]} big={big} />
    </div>
  )
}

// A section panel. flexShrink: the page is a height-bound flex column, and a
// panel with overflow hidden would otherwise compress instead of scrolling.
const sec = { ...panel, overflow:'hidden', flexShrink:0 }

// Section header row — title, a muted one-liner, anything else on the right.
function SectionHead({ title, desc, isMobile, children }) {
  return (
    <div style={{ padding: isMobile ? '12px 14px' : '14px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:'6px 10px', flexWrap:'wrap' }}>
      <span style={{ fontSize:14.5, fontWeight:700 }}>{title}</span>
      {desc && <span style={{ fontSize:12, color:'var(--text-muted)' }}>{desc}</span>}
      {children && <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>{children}</div>}
    </div>
  )
}

export default function LivePage() {
  const { contacts } = useData()
  const { isAdmin, profile: myProfile } = useAuth()
  const { callTeammate, twilioReady, callStatus } = usePhone()
  const isMobile = useIsMobile()

  // 👁 Live Call X-Ray (admins): read any in-progress call's transcript live.
  const [xrayCalls, setXrayCalls] = useState([])
  const [watchSid, setWatchSid] = useState(null)
  // Transcript auto-scroll: follow the live tail ONLY while the reader is at
  // the bottom — scrolling up to reread must not get yanked back down by the
  // 2.5s poll (Brittany's report).
  const txBodyRef = useRef(null)
  const txStickRef = useRef(true)
  useEffect(() => { txStickRef.current = true }, [watchSid])
  const [watchTx, setWatchTx] = useState(null)
  const authedGet = async (path) => {
    const { data: { session } } = await sb.auth.getSession()
    const r = await fetch(path, { headers: { Authorization: `Bearer ${session?.access_token}` } })
    if (!r.ok) throw new Error('request failed')
    return r.json()
  }
  useEffect(() => {
    if (!isAdmin) return
    let dead = false
    const load = () => authedGet('/api/live-calls').then(d => { if (!dead) setXrayCalls(d.calls || []) }).catch(() => {})
    load()
    const t = setInterval(load, 5000)
    return () => { dead = true; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])
  useEffect(() => {
    if (!watchSid) { setWatchTx(null); return }
    let dead = false
    const load = () => authedGet(`/api/live-calls/${watchSid}/transcript`).then(d => { if (!dead) setWatchTx(d) }).catch(() => {})
    load()
    const t = setInterval(load, 2500)
    return () => { dead = true; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchSid])
  const xrayName = (c) => c.contactName
    || contacts.find(x => x.id === c.contactId)?.name
    || (c.phone ? `(${c.phone.slice(0, 3)}) ${c.phone.slice(3, 6)}-${c.phone.slice(6)}` : 'Unknown caller')
  const xrayDur = (t) => {
    if (!t) return ''
    const m = Math.floor((Date.now() - t) / 60000), s2 = Math.floor(((Date.now() - t) % 60000) / 1000)
    return `${m}:${String(s2).padStart(2, '0')}`
  }
  const [logs, setLogs] = useState([])
  const [profiles, setProfiles] = useState([])
  const [tasks, setTasks] = useState([])        // today's inbound queue tasks
  const [liveCalls, setLiveCalls] = useState([]) // calls in progress right now
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const [overrideTarget, setOverrideTarget] = useState(null)
  const [statusOptions, setStatusOptions] = useState(DEFAULT_STATUS_OPTIONS)

  // Load custom statuses from app_settings
  useEffect(() => {
    sb.from('app_settings').select('value').eq('key', 'custom_statuses').maybeSingle()
      .then(({ data }) => {
        if (data?.value) {
          try {
            const saved = JSON.parse(data.value)
            const mapped = saved.map(s => ({ value: s.label || s.value || s.id, color: s.color }))
            if (mapped.length > 0) setStatusOptions(mapped)
          } catch (e) {}
        }
      })
  }, [])

  const adminSetStatus = async (profileId, val) => {
    setOverrideTarget(null)
    await sb.from('profiles').update({ status: val, status_since: new Date().toISOString() }).eq('id', profileId)
    syncWorkerActivity(profileId, val)
    setProfiles(prev => prev.map(p => p.id === profileId ? { ...p, status: val, status_since: new Date().toISOString() } : p))
  }

  // 1s tick: the queue timers ("longest wait") are the whole point of a
  // wallboard and must actually count. Cheap — it only re-renders this page.
  useEffect(() => {
    const t = setInterval(() => setTick(v => v + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const midnight = () => { const d = new Date(); d.setHours(0,0,0,0); return d.toISOString() }

  useEffect(() => {
    const since = new Date(Date.now() - 24*60*60*1000).toISOString()
    Promise.all([
      sb.from('call_logs').select('*').gte('created_at', since).order('created_at', { ascending: false }),
      sb.from('profiles').select('*').eq('active', true).order('name'),
      // Today's queue activity drives every KPI.
      sb.from('call_tasks').select('*').gte('queued_at', midnight()).order('queued_at', { ascending: false }),
      sb.from('active_calls').select('*').is('ended_at', null).order('started_at', { ascending: false }),
    ]).then(([{ data: logsData }, { data: profilesData }, { data: taskData }, { data: callData }]) => {
      setLogs(logsData || [])
      setProfiles(profilesData || [])
      setTasks(taskData || [])
      setLiveCalls(callData || [])
      setLoading(false)
    })

    const upsert = (setter, key) => (payload) => setter(prev => {
      if (payload.eventType === 'DELETE') return prev.filter(x => x[key] !== payload.old[key])
      const i = prev.findIndex(x => x[key] === payload.new[key])
      if (i === -1) return [payload.new, ...prev]
      const next = [...prev]; next[i] = { ...next[i], ...payload.new }; return next
    })

    const logChannel = sb.channel('live-logs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_logs' }, payload => {
        setLogs(prev => [payload.new, ...prev])
      }).subscribe()

    const profileChannel = sb.channel('live-profiles')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, payload => {
        setProfiles(prev => prev.map(p => p.id === payload.new.id ? { ...p, ...payload.new } : p))
      }).subscribe()

    // The wallboard's live pulse: every queue state change lands here.
    const taskChannel = sb.channel('live-tasks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_tasks' },
        upsert(setTasks, 'task_sid')).subscribe()

    const callChannel = sb.channel('live-calls')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'active_calls' },
        upsert(setLiveCalls, 'call_sid')).subscribe()

    return () => {
      sb.removeChannel(logChannel); sb.removeChannel(profileChannel)
      sb.removeChannel(taskChannel); sb.removeChannel(callChannel)
    }
  }, [])

  const now = new Date()
  const todayStr = now.toDateString()

  if (loading) return (
    <div style={{ flex:1, overflowY:'auto', padding: isMobile ? 12 : 24, display:'flex', flexDirection:'column', gap:16, background:'var(--bg)' }}>
      <div className="skel" style={{ height:108, borderRadius:16, flexShrink:0 }} />
      <div className="skel" style={{ height:340, borderRadius:16, flexShrink:0 }} />
      <div className="skel" style={{ height:220, borderRadius:16, flexShrink:0 }} />
    </div>
  )

  // Sort: active statuses first, then by name
  const statusPriority = (status) => {
    const idx = statusOptions.findIndex(s => s.value === status)
    return idx === -1 ? statusOptions.length : idx
  }
  const sortedProfiles = [...profiles].sort((a, b) => {
    const ai = statusPriority(a.status || 'Offline')
    const bi = statusPriority(b.status || 'Offline')
    if (ai !== bi) return ai - bi
    return (a.name || '').localeCompare(b.name || '')
  })

  // Get color for any status, including custom ones
  const getStatusColor = (status) => {
    const found = statusOptions.find(s => s.value === status)
    return found ? found.color : '#6b7280'
  }

  // ── Telephony KPIs. All of today, from call_tasks; `tick` keeps the live
  // timers honest without re-querying.
  const queued = tasks.filter(t => t.state === 'queued' && !t.ended_at)
  const waitOf = (t) => Math.max(0, Math.round((Date.now() - new Date(t.queued_at).getTime()) / 1000))
  const longestWait = queued.length ? Math.max(...queued.map(waitOf)) : 0

  // Live calls come from two places and neither alone is the truth: inbound
  // lives in call_tasks (TaskRouter dequeues the caller, so no active_calls row
  // is written), outbound lives in active_calls via the TwiML app.
  const liveInbound = tasks.filter(t => t.state === 'answered' && !t.ended_at)
  const liveOutbound = liveCalls.filter(c =>
    c.direction === 'outbound' && !c.ended_at && ['in-progress', 'answered', 'initiated', 'ringing'].includes(c.status))
  const onCall = [...liveInbound, ...liveOutbound]
  const agentsAvailable = profiles.filter(p => p.status === 'Available').length

  // Denominator excludes calls still waiting and sub-grace misdials ('missed'),
  // so a caller who hung up in 2 seconds neither counts as handled nor against you.
  const settled = tasks.filter(t => t.state === 'answered' || t.state === 'abandoned')
  const answered = settled.filter(t => t.state === 'answered')
  const abandoned = settled.filter(t => t.state === 'abandoned')
  const abandonRate = settled.length ? (abandoned.length / settled.length) * 100 : 0

  // Service level: of everything that reached a conclusion, what share was
  // answered inside the target. Abandons count against it — that's the point.
  const withinSL = answered.filter(t => (t.wait_seconds ?? 9999) <= SERVICE_LEVEL_SECONDS)
  const serviceLevel = settled.length ? (withinSL.length / settled.length) * 100 : null

  const avgWait = answered.length
    ? Math.round(answered.reduce((s, t) => s + (t.wait_seconds || 0), 0) / answered.length)
    : null

  const queueTone = queued.length === 0 ? 'good' : longestWait > 60 ? 'bad' : 'warn'
  const slTone = serviceLevel == null ? 'default' : serviceLevel >= 80 ? 'good' : serviceLevel >= 60 ? 'warn' : 'bad'
  const abTone = !settled.length ? 'default' : abandonRate <= 5 ? 'good' : abandonRate <= 10 ? 'warn' : 'bad'

  return (
    <div style={{ flex:1, overflowY:'auto', padding: isMobile ? 12 : 24, display:'flex', flexDirection:'column', gap:16, background:'var(--bg)' }}>

      {/* Admin status override modal */}
      {isAdmin && overrideTarget && (
        <div onClick={() => setOverrideTarget(null)}
          style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.45)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div onClick={e => e.stopPropagation()} className="mkeep"
            style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:18, padding:22, minWidth:260, boxShadow:'0 24px 60px -20px rgba(15,20,40,.35)' }}>
            <div style={eyebrow}>Change status</div>
            <div style={{ fontSize:16, fontWeight:700, margin:'3px 0 14px' }}>{overrideTarget.name}</div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {statusOptions.map(s => {
                const on = overrideTarget.status === s.value
                const t = toneOf(s.color)
                return (
                  <button key={s.value} onClick={() => adminSetStatus(overrideTarget.id, s.value)} className={on ? undefined : 'eval-row'}
                    style={{ display:'flex', alignItems:'center', gap:10, padding: isMobile ? '12px 14px' : '10px 14px', borderRadius:12,
                      border: `1px solid ${on ? `var(--tone-${t}-bd)` : 'var(--border)'}`,
                      background: on ? `var(--tone-${t}-bg)` : 'var(--surface)',
                      cursor:'pointer', fontSize:13, fontWeight: on ? 700 : 500,
                      color:'var(--text-primary)', textAlign:'left' }}>
                    <span style={{ width:9, height:9, borderRadius:'50%', background:`var(--tone-${t}-tx)`, flexShrink:0 }} />
                    {s.value}
                    {on && <span style={{ marginLeft:'auto', fontSize:11.5, fontWeight:700, color:`var(--tone-${t}-tx)` }}>✓ Current</span>}
                  </button>
                )
              })}
            </div>
            <button onClick={() => setOverrideTarget(null)} className="btn" style={{ marginTop:14, width:'100%', justifyContent:'center', borderRadius:99, minHeight: isMobile ? 40 : undefined }}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── Telephony KPIs — always first, this is what a floor lead scans.
          One summary panel, zones split by hairlines. mgrid: auto-fit already
          gives two zones a row on a phone; without it the phone layer stacks
          all six. ── */}
      <div className="mgrid" style={{ ...sec, display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Kpi label="In queue" value={queued.length} tone={queueTone} big
          sub={queued.length ? `longest ${fmtWait(longestWait)}` : 'nobody waiting'} />
        <Kpi label="Live calls" value={onCall.length} tone={onCall.length ? 'accent' : 'default'} big
          sub={`${liveInbound.length} in · ${liveOutbound.length} out`} />
        <Kpi label="Agents available" value={agentsAvailable} big
          tone={agentsAvailable === 0 ? 'bad' : 'good'}
          sub={`of ${profiles.length} on the floor`} />
        <Kpi label={`Service level (${SERVICE_LEVEL_SECONDS}s)`}
          value={serviceLevel == null ? '—' : `${serviceLevel.toFixed(0)}%`} tone={slTone}
          sub={settled.length ? `${withinSL.length}/${settled.length} today` : 'no calls yet'} />
        <Kpi label="Abandon rate" value={settled.length ? `${abandonRate.toFixed(0)}%` : '—'} tone={abTone}
          sub={settled.length ? `${abandoned.length} of ${settled.length} today` : 'no calls yet'} />
        <Kpi label="Avg wait" value={avgWait == null ? '—' : fmtWait(avgWait)}
          sub={answered.length ? `${answered.length} answered today` : 'no calls yet'} />
      </div>

      {/* Who's actually waiting, oldest first — the queue itself */}
      {queued.length > 0 && (
        <div style={sec}>
          <SectionHead isMobile={isMobile} title="Waiting now" desc="Oldest first">
            <ToneChip tone={KPI_TONE[queueTone]}>{queued.length} caller{queued.length === 1 ? '' : 's'}</ToneChip>
          </SectionHead>
          {/* Three columns fit a phone, so skip the forced 640px sideways scroll. */}
          <div style={{ overflowX:'auto' }}>
            <table className="data-table" style={isMobile ? { minWidth:0 } : undefined}>
              <thead><tr><th>Caller</th><th>Number</th><th style={{ textAlign:'right' }}>Waiting</th></tr></thead>
              <tbody>
                {[...queued].sort((a, b) => new Date(a.queued_at) - new Date(b.queued_at)).map(t => {
                  const w = waitOf(t)
                  return (
                    <tr key={t.task_sid}>
                      <td style={{ fontWeight:650 }}>{t.contact_name || 'Unknown caller'}</td>
                      <td style={{ color:'var(--text-secondary)' }}>{t.from_number || '—'}</td>
                      <td style={{ textAlign:'right' }}>
                        <ToneChip tone={w > 60 ? 'red' : w > 30 ? 'amber' : 'gray'}>{fmtWait(w)}</ToneChip>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 👁 Live Call X-Ray — admin-only list of in-progress transcriptions */}
      {isAdmin && xrayCalls.length > 0 && (
        <div style={sec}>
          <SectionHead isMobile={isMobile} title="Live calls" desc="Click a call to read along · transcript only, nothing extra is recorded">
            <ToneChip tone="blue">{xrayCalls.length} in progress</ToneChip>
          </SectionHead>
          <div>
            {xrayCalls.map((c, i) => (
              <button key={c.id} onClick={() => setWatchSid(c.id)} className="eval-row"
                style={{ width:'100%', textAlign:'left', display:'flex', alignItems:'center', gap:10, padding: isMobile ? '12px 12px' : '11px 20px',
                  border:'none', borderTop: i ? '1px solid var(--border)' : 'none', background:'transparent', cursor:'pointer', color:'inherit', font:'inherit',
                  flexWrap: isMobile ? 'wrap' : undefined }}>
                <span style={{ width:8, height:8, borderRadius:'50%', background:'var(--tone-red-tx)', animation:'pulse 1.2s infinite', flexShrink:0 }} />
                <span style={{ fontSize:13.5, fontWeight:700 }}>{xrayName(c)}</span>
                <ToneChip tone={c.direction === 'inbound' ? 'blue' : 'purple'} small>{c.direction === 'inbound' ? 'Inbound' : 'Outbound'}</ToneChip>
                <span style={{ ...num, fontSize:12, color:'var(--text-muted)' }}>
                  {c.rep ? `${c.rep} · ` : ''}{xrayDur(c.startedAt)} · {c.lines} lines
                </span>
                <span style={{ marginLeft:'auto', fontSize:12, fontWeight:700, color:'var(--accent)' }}>View transcript</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {watchSid && (
        <div onClick={() => setWatchSid(null)}
          style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:800, display:'flex', alignItems:'center', justifyContent:'center', padding: isMobile ? 10 : 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:18, width:'100%', maxWidth:640, height:'78vh', boxShadow:'0 24px 60px -20px rgba(15,20,40,.35)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
            <div style={{ padding: isMobile ? '12px 14px' : '14px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
              {watchTx?.active !== false
                ? <span style={{ width:9, height:9, borderRadius:'50%', background:'var(--tone-red-tx)', animation:'pulse 1.2s infinite', flexShrink:0 }} />
                : <span style={{ width:9, height:9, borderRadius:'50%', background:'var(--text-muted)', flexShrink:0 }} />}
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:15, fontWeight:700, display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                  {watchTx ? (watchTx.contactName || contacts.find(x => x.id === watchTx.contactId)?.name || 'Live call') : 'Live call'}
                  {watchTx?.active === false && <ToneChip tone="gray" small>Call ended</ToneChip>}
                </div>
                <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:1 }}>
                  {watchTx?.rep ? `with ${watchTx.rep} · ` : ''}updates every few seconds · the rep can't see that you're reading
                </div>
              </div>
              <button className="btn sm" onClick={() => setWatchSid(null)} style={{ borderRadius:99, ...(isMobile ? { minHeight:40 } : {}) }}>Close</button>
            </div>
            <div style={{ flex:1, overflowY:'auto', padding:16, display:'flex', flexDirection:'column', gap:8 }}
              ref={el => {
                txBodyRef.current = el
                if (el && txStickRef.current) el.scrollTop = el.scrollHeight
              }}
              onScroll={e => {
                const el = e.currentTarget
                txStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
              }}>
              {(!watchTx || watchTx.lines.length === 0) && (
                <div style={{ color:'var(--text-muted)', fontSize:13, textAlign:'center', padding:'40px 0' }}>
                  {watchTx?.active === false ? 'This call has ended.' : 'Waiting for the first words…'}
                </div>
              )}
              {(watchTx?.lines || []).map((l, i) => (
                <div key={i} style={{ alignSelf: l.who === 'Rep' ? 'flex-end' : 'flex-start', maxWidth:'85%' }}>
                  <div style={{ ...eyebrow, ...num, fontSize:10, marginBottom:3,
                    color: l.who === 'Rep' ? 'var(--accent)' : 'var(--tone-amber-tx)', textAlign: l.who === 'Rep' ? 'right' : 'left' }}>
                    {l.who}{l.at ? ` · ${new Date(l.at).toLocaleTimeString([], { hour:'numeric', minute:'2-digit', second:'2-digit' })}` : ''}
                  </div>
                  <div style={{ padding:'9px 13px', borderRadius:14, fontSize:13, lineHeight:1.5,
                    background: l.who === 'Rep' ? 'var(--accent-bg)' : 'var(--surface-2)',
                    border: `1px solid ${l.who === 'Rep' ? 'var(--tone-blue-bd)' : 'var(--border)'}` }}>
                    {l.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Agent Status Board */}
      <div style={sec}>
        <SectionHead isMobile={isMobile} title="Agent status board"
          desc={`${profiles.length} on the floor${isAdmin ? ' · click a status to change it' : ''}`}>
          {statusOptions.map(s => {
            const count = profiles.filter(p => (p.status || 'Offline') === s.value).length
            if (count === 0) return null
            return <ToneChip key={s.value} tone={toneOf(s.color)} small>{count} {s.value}</ToneChip>
          })}
          {/* Also show any statuses not in statusOptions (edge case) */}
          {profiles.filter(p => p.status && !statusOptions.find(s => s.value === p.status)).map(p => p.status)
            .filter((v, i, arr) => arr.indexOf(v) === i)
            .map(status => (
              <ToneChip key={status} tone="gray" small>{profiles.filter(p => p.status === status).length} {status}</ToneChip>
            ))
          }
        </SectionHead>
        <div style={{ overflowX:'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Time in Status</th>
                <th>Interaction</th>
                <th style={{ textAlign:'center' }}>Today Calls</th>
                <th style={{ textAlign:'center' }}>Today Booked</th>
                <th>Last Call</th>
              </tr>
            </thead>
            <tbody>
              {sortedProfiles.map(p => {
                const status = p.status || 'Offline'
                const statusColor = getStatusColor(status)
                const repLogs = logs.filter(l => l.rep === (p.name || p.email))
                const todayLogs = repLogs.filter(l => new Date(l.created_at).toDateString() === todayStr)
                const lastLog = repLogs[0]
                const lastContact = lastLog ? contacts.find(c => c.id === lastLog.contact_id) : null
                const bookedToday = todayLogs.filter(l => l.outcome === 'Booked').length

                return (
                  <tr key={p.id}>
                    <td>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <Face avatar={p.avatar} name={p.name || p.email} size={30} />
                        <span style={{ fontSize:13, fontWeight:650, whiteSpace:'nowrap' }}>{p.name || p.email}</span>
                        {p.id !== myProfile?.id && (
                          <button onClick={() => callTeammate(p)} className="btn sm"
                            disabled={!twilioReady || !!callStatus || status === 'Offline'}
                            title={status === 'Offline' ? `${p.name || 'They'} aren't logged in` : `Call ${p.name || p.email} — rings their browser wherever they're logged in`}
                            style={{ marginLeft:2, padding: isMobile ? '6px 14px' : '2px 10px', fontSize: isMobile ? 12 : 11, fontWeight:700, borderRadius:99,
                              minHeight: isMobile ? 40 : undefined, color:'var(--accent)' }}>
                            Call
                          </button>
                        )}
                      </div>
                    </td>
                    <td>
                      <span
                        onClick={() => isAdmin && setOverrideTarget({ id:p.id, name:p.name || p.email, status })}
                        style={{ display:'inline-flex', alignItems:'center', cursor: isAdmin ? 'pointer' : 'default',
                          minHeight: isMobile && isAdmin ? 40 : undefined }}
                        title={isAdmin ? 'Click to change status' : ''}>
                        <ToneChip tone={toneOf(statusColor)}>
                          <span style={{ display:'inline-block', width:6, height:6, borderRadius:99, background:'currentColor', marginRight:6, verticalAlign:1 }} />
                          {status}
                          {isAdmin && <span style={{ fontSize:9, opacity:.6, marginLeft:5 }}>▾</span>}
                        </ToneChip>
                      </span>
                    </td>
                    <td style={{ color:'var(--text-secondary)', whiteSpace:'nowrap' }}>
                      {p.status_since ? timeSince(p.status_since) : '—'}
                    </td>
                    {/* What they're engaged on — inbound, outbound, a paid lead,
                        a text, an email. Campaign rides underneath when set, so
                        this column didn't lose information when it was renamed. */}
                    <td>
                      {p.interaction_type && ['On Call', 'Wrap Up'].includes(p.status) ? (
                        <div>
                          <ToneChip tone={toneOf(INTERACTION_COLORS[p.interaction_type])} small>{p.interaction_type}</ToneChip>
                          {p.current_campaign && <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:3 }}>{p.current_campaign}</div>}
                        </div>
                      ) : (
                        p.current_campaign
                          ? <span style={{ color:'var(--text-secondary)' }}>{p.current_campaign}</span>
                          : <span style={{ color:'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td style={{ fontWeight:700, textAlign:'center' }}>
                      {todayLogs.length}
                    </td>
                    <td style={{ fontWeight:700, textAlign:'center', color: bookedToday ? 'var(--tone-green-tx)' : 'var(--text-muted)' }}>
                      {bookedToday}
                    </td>
                    <td style={{ fontSize:11.5, color:'var(--text-muted)' }}>
                      {lastLog ? (
                        <div>
                          <div style={{ fontWeight:600, color:'var(--text-secondary)' }}>{lastContact?.name || '—'}</div>
                          <div style={{ whiteSpace:'nowrap' }}>{fmtShort(lastLog.created_at)} · {lastLog.outcome}</div>
                        </div>
                      ) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Calls Live Feed */}
      <div style={sec}>
        <SectionHead isMobile={isMobile} title="Recent calls" desc={`Live feed · ${logs.length} calls in last 24h`} />
        {logs.length === 0 ? (
          <div style={{ padding:'40px 20px', textAlign:'center', color:'var(--text-muted)', fontSize:13 }}>No calls in the last 24 hours.</div>
        ) : (
          <div style={{ overflowX:'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Rep</th>
                  <th>Contact</th>
                  <th>Outcome</th>
                  <th>Notes</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {logs.slice(0, 5).map(l => {
                  const contact = contacts.find(c => c.id === l.contact_id)
                  const color = getStatusColor(l.outcome) || '#6b7280'
                  return (
                    <tr key={l.id}>
                      <td>
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <Face avatar={profiles.find(p => (p.name || p.email) === l.rep)?.avatar} name={l.rep} size={22} />
                          <span style={{ fontWeight:600, whiteSpace:'nowrap' }}>{l.rep}</span>
                        </div>
                      </td>
                      <td>{contact?.name || '—'}</td>
                      <td>
                        <ToneChip tone={l.outcome === 'Booked' ? 'green' : l.outcome === 'DNC' ? 'red' : 'gray'} small>{l.outcome}</ToneChip>
                      </td>
                      <td style={{ color:'var(--text-muted)', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {l.notes || '—'}
                      </td>
                      <td style={{ color:'var(--text-muted)', whiteSpace:'nowrap' }}>
                        {fmtShort(l.created_at)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
