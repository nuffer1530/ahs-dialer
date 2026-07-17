// Schedule alerts — pop a banner on ANY page 15 minutes before, and again at
// the start of, a scheduled event that takes the rep off Available (break,
// lunch, meeting, outbound block, end of shift). Mounted in the app shell so
// it follows the rep across pages; it reads only their own schedule, so it's
// inherently per-person and not a broadcast.
import { useState, useEffect, useRef } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'

const START_HOUR = 6          // matches the graphical schedule's interval origin
const LEAD_MIN = 15
const AUTO_DISMISS_MS = 60_000
const FIRE_WINDOW_MS = 100_000 // catch a fire point up to ~100s late; older = missed

// Local YYYY-MM-DD. toISOString would use UTC and roll the date early evening.
function localDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function atTime(dateStr, hhmm) {
  if (!hhmm) return null
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(dateStr + 'T00:00:00')
  d.setHours(h, m, 0, 0)
  return d
}
function atInterval(dateStr, interval) {
  const mins = START_HOUR * 60 + interval * 15
  const d = new Date(dateStr + 'T00:00:00')
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0)
  return d
}

// One shared AudioContext, resumed lazily. A short two-note chime, generated so
// there's no asset to ship or fail to load.
let audioCtx = null
function playChime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const t0 = audioCtx.currentTime
    ;[880, 1175].forEach((freq, i) => {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.connect(gain); gain.connect(audioCtx.destination)
      const t = t0 + i * 0.18
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.16, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16)
      osc.start(t); osc.stop(t + 0.18)
    })
  } catch {}
}

export default function ScheduleAlerts() {
  const { profile } = useAuth()
  const [alerts, setAlerts] = useState([])
  const eventsRef = useRef([])
  const firedRef = useRef(new Set())   // `${eventId}:${phase}` we've already handled

  // Load today's schedule for this rep, and refresh every 5 min so a mid-day
  // schedule edit is picked up. firedRef is intentionally NOT reset on refresh,
  // so an already-fired alert doesn't repeat.
  useEffect(() => {
    if (!profile?.id) return
    let stopped = false

    const load = async () => {
      const dateStr = localDate()
      const [{ data: scheds }, { data: blocks }] = await Promise.all([
        sb.from('schedules').select('*').eq('profile_id', profile.id).eq('date', dateStr).maybeSingle()
          .then(r => ({ data: r.data ? [r.data] : [] })),
        sb.from('schedule_blocks').select('*').eq('profile_id', profile.id).eq('date', dateStr),
      ])
      if (stopped) return

      const sched = scheds[0]
      const evs = []
      // Off-Available shift events. Skip whole-day off types (no shift).
      if (sched && !['pto', 'sick', 'holiday', 'off'].includes(sched.day_type)) {
        if (sched.break1_start) evs.push({ id: 'break1', label: 'Break 1', at: atTime(dateStr, sched.break1_start) })
        if (sched.lunch_start)  evs.push({ id: 'lunch',  label: 'Lunch',   at: atTime(dateStr, sched.lunch_start) })
        if (sched.break2_start) evs.push({ id: 'break2', label: 'Break 2', at: atTime(dateStr, sched.break2_start) })
        if (sched.shift_end)    evs.push({ id: 'shiftend', label: 'End of shift', at: atTime(dateStr, sched.shift_end), isEnd: true })
      }
      ;(blocks || []).forEach(b => {
        if (b.type === 'meeting' || b.type === 'outbound') {
          evs.push({ id: 'blk-' + b.id, label: b.type === 'meeting' ? 'Meeting' : 'Outbound block', at: atInterval(dateStr, b.start_interval) })
        }
      })
      eventsRef.current = evs.filter(e => e.at)
    }

    load()
    const reload = setInterval(load, 5 * 60_000)
    return () => { stopped = true; clearInterval(reload) }
  }, [profile?.id])

  // Tick: fire the 15-min-ahead and at-start alerts as their moments pass.
  useEffect(() => {
    if (!profile?.id) return

    const fire = (ev, phase) => {
      const msg = phase === 'lead'
        ? (ev.isEnd ? 'Your shift ends in 15 minutes' : `${ev.label} in 15 minutes`)
        : (ev.isEnd ? 'Your shift has ended'          : `${ev.label} — starting now`)
      const id = `${ev.id}:${phase}:${Date.now()}`
      setAlerts(prev => [...prev, { id, msg, phase }])
      playChime()
      setTimeout(() => setAlerts(prev => prev.filter(a => a.id !== id)), AUTO_DISMISS_MS)
    }

    const check = () => {
      const now = Date.now()
      for (const ev of eventsRef.current) {
        const base = ev.at.getTime()
        const points = [
          { phase: 'lead', at: base - LEAD_MIN * 60_000 },
          { phase: 'now',  at: base },
        ]
        for (const p of points) {
          const key = `${ev.id}:${p.phase}`
          if (firedRef.current.has(key)) continue
          if (now >= p.at && now <= p.at + FIRE_WINDOW_MS) {
            firedRef.current.add(key)
            fire(ev, p.phase)
          } else if (now > p.at + FIRE_WINDOW_MS) {
            firedRef.current.add(key)   // window passed while app was closed — don't fire stale
          }
        }
      }
    }

    check()
    const t = setInterval(check, 20_000)
    return () => clearInterval(t)
  }, [profile?.id])

  const dismiss = (id) => setAlerts(prev => prev.filter(a => a.id !== id))
  if (alerts.length === 0) return null

  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 1900, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 340 }}>
      <style>{`@keyframes sched-in{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}`}</style>
      {alerts.map(a => {
        const accent = a.phase === 'now' ? '#2a78d6' : '#C87800'
        return (
          <div key={a.id} style={{
            background: 'var(--surface)', border: `2px solid ${accent}`, borderRadius: 'var(--radius-lg)',
            boxShadow: '0 10px 32px rgba(0,0,0,.22)', padding: '12px 14px',
            display: 'flex', alignItems: 'center', gap: 12, animation: 'sched-in .18s ease-out',
          }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: accent + '1f', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="13" r="8" stroke={accent} strokeWidth="1.8" />
                <path d="M12 9v4l2.5 2M9 2h6" stroke={accent} strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: .5, textTransform: 'uppercase', color: accent }}>
                {a.phase === 'now' ? 'Now' : 'Upcoming'}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{a.msg}</div>
            </div>
            <button onClick={() => dismiss(a.id)}
              style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, flexShrink: 0 }}
              title="Dismiss">×</button>
          </div>
        )
      })}
    </div>
  )
}
