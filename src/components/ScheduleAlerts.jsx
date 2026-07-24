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
  const firedRef = useRef(new Set())   // `${eventId}:${phase}:${time}` we've already handled
  const checkRef = useRef(null)        // lets a realtime reload re-evaluate at once

  // Load today's schedule for this rep. A realtime subscription reloads the
  // instant an admin edits this rep's schedule or blocks; a slow interval is
  // only a backstop if the socket drops. firedRef is intentionally NOT reset on
  // reload, so an already-fired alert doesn't repeat.
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
      // Evaluate straight away so a just-changed break (possibly already inside
      // the 15-min window) alerts now, not on the next 20s tick.
      checkRef.current?.()
    }

    load()

    // Instant updates: reload on any change to this rep's rows. The filter keeps
    // it to their own schedule so one rep's edit doesn't wake every browser.
    const channel = sb.channel(`sched-alerts-${profile.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedules', filter: `profile_id=eq.${profile.id}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_blocks', filter: `profile_id=eq.${profile.id}` }, load)
      .subscribe()

    // Backstop only — if realtime drops, still catch an edit within 5 min.
    const reload = setInterval(load, 5 * 60_000)
    return () => { stopped = true; clearInterval(reload); sb.removeChannel(channel) }
  }, [profile?.id])

  // Tick: fire the 15-min-ahead and at-start alerts as their moments pass.
  useEffect(() => {
    if (!profile?.id) return

    const fire = (ev, phase, minsLeft) => {
      const msg = phase === 'lead'
        ? (ev.isEnd ? `Your shift ends in ${minsLeft} minute${minsLeft === 1 ? '' : 's'}`
                    : `${ev.label} in ${minsLeft} minute${minsLeft === 1 ? '' : 's'}`)
        : (ev.isEnd ? 'Your shift has ended' : `${ev.label} — starting now`)
      const id = `${ev.id}:${phase}:${Date.now()}`
      setAlerts(prev => [...prev, { id, msg, phase }])
      playChime()
      setTimeout(() => setAlerts(prev => prev.filter(a => a.id !== id)), AUTO_DISMISS_MS)
    }

    const check = () => {
      const now = Date.now()
      for (const ev of eventsRef.current) {
        const base = ev.at.getTime()
        // Keys carry the event TIME, so moving a break to a new time re-arms both
        // alerts for the new time rather than staying suppressed from the old one.
        const leadKey = `${ev.id}:lead:${base}`
        const nowKey = `${ev.id}:now:${base}`

        // Lead (heads-up): fire ONCE any time we're inside the 15-min window and
        // the event hasn't started — including when a break is set/moved to a
        // time that's already within 15 minutes. The minute count is the real
        // time remaining, so a break set 8 min out reads "in 8 minutes".
        if (!firedRef.current.has(leadKey)) {
          if (now >= base) {
            firedRef.current.add(leadKey)                 // already started; heads-up is moot
          } else if (now >= base - LEAD_MIN * 60_000) {
            firedRef.current.add(leadKey)
            fire(ev, 'lead', Math.max(1, Math.round((base - now) / 60_000)))
          }
        }

        // At start: fire when the event begins; skip if the app only opened well
        // after it started (stale).
        if (!firedRef.current.has(nowKey)) {
          if (now >= base && now <= base + FIRE_WINDOW_MS) {
            firedRef.current.add(nowKey)
            fire(ev, 'now')
          } else if (now > base + FIRE_WINDOW_MS) {
            firedRef.current.add(nowKey)
          }
        }
      }
    }

    // Expose check so a realtime reload can fire it immediately, not on the next tick.
    checkRef.current = check
    check()
    const t = setInterval(check, 20_000)
    return () => clearInterval(t)
  }, [profile?.id])

  // 📣 Floor announcements — an admin sends from My Page; pops for everyone
  // (or just the person it targets). Realtime broadcast, no table behind it.
  useEffect(() => {
    if (!profile?.id) return
    const ch = sb.channel('floor-alerts')
      .on('broadcast', { event: 'announce' }, ({ payload }) => {
        if (!payload?.message) return
        const to = payload.to
        const forMe = to === 'all' || (Array.isArray(to) ? to.includes(profile.id) : to === profile.id)
        const isSender = payload.fromId === profile.id
        if (!forMe && !isSender) return
        const id = `ann:${Date.now()}`
        // The sender gets the same popup as a delivery receipt.
        const from = isSender && !forMe
          ? `Sent \u2713${payload.toNames ? ' \u2192 ' + payload.toNames : ''}`
          : (payload.from || 'Admin')
        setAlerts(prev => [...prev, { id, kind: 'announce', from, message: String(payload.message).slice(0, 300) }])
        playChime()
        setTimeout(() => setAlerts(prev => prev.filter(a => a.id !== id)), 25000)
      })
      .subscribe()
    return () => sb.removeChannel(ch)
  }, [profile?.id])

  // "You Got Paid!" — pops when the commission sync records a new payout for
  // this rep (a booked job ServiceTitan just marked completed). Realtime INSERT
  // only, so old commissions don't replay on load.
  useEffect(() => {
    if (!profile?.id) return
    const ch = sb.channel(`pay-${profile.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'commissions', filter: `profile_id=eq.${profile.id}` },
        ({ new: c }) => {
          const id = `pay:${c.id || Date.now()}`
          setAlerts(prev => [...prev, {
            id, kind: 'pay',
            jobNumber: c.job_number || (c.st_job_id ? String(c.st_job_id) : null),
            amount: Number(c.amount || 0),
          }])
          playChime()
          setTimeout(() => setAlerts(prev => prev.filter(a => a.id !== id)), 15000)
        })
      .subscribe()
    return () => sb.removeChannel(ch)
  }, [profile?.id])

  const dismiss = (id) => setAlerts(prev => prev.filter(a => a.id !== id))
  if (alerts.length === 0) return null

  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 1900, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 340 }}>
      <style>{`@keyframes sched-in{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}`}</style>
      {alerts.map(a => {
        if (a.kind === 'pay') {
          const g = '#16A34A'
          return (
            <div key={a.id} style={{
              background: 'var(--surface)', border: `2px solid ${g}`, borderRadius: 'var(--radius-lg)',
              boxShadow: '0 10px 32px rgba(0,0,0,.22)', padding: '12px 14px',
              display: 'flex', alignItems: 'center', gap: 12, animation: 'sched-in .18s ease-out',
            }}>
              <div style={{ width: 34, height: 34, borderRadius: '50%', background: g + '1f', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 18 }}>💰</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: .5, textTransform: 'uppercase', color: g }}>You got paid!</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>
                  ${a.amount.toFixed(2)}{a.jobNumber ? <span style={{ fontWeight: 500, color: 'var(--text-muted)', fontSize: 13 }}> · Job #{a.jobNumber}</span> : null}
                </div>
              </div>
              <button onClick={() => dismiss(a.id)}
                style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, flexShrink: 0 }}
                title="Dismiss">×</button>
            </div>
          )
        }
        if (a.kind === 'announce') {
          const c = '#7C3AED'
          return (
            <div key={a.id} style={{
              background: 'var(--surface)', border: `2px solid ${c}`, borderRadius: 'var(--radius-lg)',
              boxShadow: '0 10px 32px rgba(0,0,0,.22)', padding: '12px 14px',
              display: 'flex', alignItems: 'center', gap: 12, animation: 'sched-in .18s ease-out',
            }}>
              <div style={{ width: 34, height: 34, borderRadius: '50%', background: c + '1f', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 17 }}>📣</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: .5, textTransform: 'uppercase', color: c }}>{a.from}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{a.message}</div>
              </div>
              <button onClick={() => dismiss(a.id)}
                style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, flexShrink: 0 }}
                title="Dismiss">×</button>
            </div>
          )
        }
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
