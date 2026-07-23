// GraphicalSchedule v2 — 15min ticks + overflow scroll
import { useState, useEffect, useRef } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import Avatar from './Avatar'

const START_HOUR = 6
const END_HOUR = 21
const TOTAL_INTERVALS = (END_HOUR - START_HOUR) * 4 // 15-min slots
const LABEL_WIDTH = 200
const ROW_HEIGHT = 72
const ADHERENCE_HEIGHT = 12
const MIN_CELL_WIDTH = 12

const BLOCK_TYPES = [
  { id:'shift',    label:'On Shift',       color:'#2a78d6', bg:'#2a78d618', text:'#2a78d6' },
  { id:'break',    label:'Break',          color:'#eda100', bg:'#eda10020', text:'#854f0b' },
  { id:'lunch',    label:'Lunch',          color:'#1baf7a', bg:'#1baf7a18', text:'#0f6e56' },
  { id:'outbound', label:'Outbound',       color:'#4a3aa7', bg:'#4a3aa718', text:'#4a3aa7' },
  { id:'meeting',  label:'Meeting',        color:'#e34948', bg:'#e3494818', text:'#a32d2d' },
  { id:'pto',      label:'PTO',            color:'#3b82f6', bg:'#3b82f615', text:'#185fa5' },
  { id:'sick',     label:'Sick',           color:'#f59e0b', bg:'#f59e0b15', text:'#854f0b' },
  { id:'holiday',  label:'Holiday',        color:'#8b5cf6', bg:'#8b5cf615', text:'#4a3aa7' },
]

function timeToInterval(t) {
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  return Math.round(((h - START_HOUR) * 60 + m) / 15)
}

function intervalToTime(i) {
  const totalMins = START_HOUR * 60 + i * 15
  return `${String(Math.floor(totalMins/60)).padStart(2,'0')}:${String(totalMins%60).padStart(2,'0')}`
}

function fmtTime(t) {
  if (!t) return '--'
  const [h, m] = t.split(':')
  const hour = parseInt(h)
  return `${hour%12||12}:${m} ${hour>=12?'PM':'AM'}`
}

function fmtHour(h) {
  return h === 12 ? '12PM' : h > 12 ? `${h-12}PM` : `${h}AM`
}

function addMins(timeStr, mins) {
  const [h, m] = timeStr.split(':').map(Number)
  const t = h * 60 + m + parseInt(mins)
  return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`
}

function isoToInterval(iso) {
  if (!iso) return null
  const d = new Date(iso)
  const mins = d.getHours() * 60 + d.getMinutes()
  return (mins - START_HOUR * 60) / 15
}

export default function GraphicalSchedule({ profiles, onUpdate }) {
  const { profile, isAdmin } = useAuth()
  const containerRef = useRef(null)
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [schedules, setSchedules] = useState([])
  const [statusEvents, setStatusEvents] = useState([])
  const [blocks, setBlocks] = useState({})
  const [extraBlocks, setExtraBlocks] = useState([])
  const [dragging, setDragging] = useState(null)
  const dragStartX = useRef(0)
  const [currentInterval, setCurrentInterval] = useState(null)
  const [saving, setSaving] = useState(false)
  const [shiftModal, setShiftModal] = useState(null)
  const [shiftForm, setShiftForm] = useState({ shift_start:'08:00', shift_end:'17:00', break1_start:'10:00', break1_duration:15, lunch_start:'12:00', lunch_duration:30, break2_start:'14:30', break2_duration:15, day_type:'work' })
  const [contextMenu, setContextMenu] = useState(null)
  const [addBlockMenu, setAddBlockMenu] = useState(null)
  // Recurring weekly blocks (e.g. Team Huddle, 15 min every Wednesday) live in
  // app_settings.recurring_blocks — they materialize onto every matching
  // weekday without creating rows. Meeting blocks also carry a note.
  const [recurringDefs, setRecurringDefs] = useState([])
  const [meetingModal, setMeetingModal] = useState(null)   // { profileId, start }
  const [meetingForm, setMeetingForm] = useState({ note: '', repeat: false, durationMin: 15 })
  const [containerWidth, setContainerWidth] = useState(0)
  const [tooltip, setTooltip] = useState(null)
  const tooltipRef = useRef(null)

  // Always use a fixed cell width so timeline is consistent regardless of screen size
  // Minimum timeline = 900px wide, scrolls on smaller screens
  const MIN_TIMELINE_WIDTH = 900
  const CELL_WIDTH = containerWidth > 0
    ? Math.max(MIN_CELL_WIDTH, Math.floor(Math.max(containerWidth - LABEL_WIDTH, MIN_TIMELINE_WIDTH) / TOTAL_INTERVALS))
    : MIN_CELL_WIDTH

  const today = new Date().toISOString().split('T')[0]
  const isToday = date === today

  // Load data
  useEffect(() => {
    Promise.all([
      sb.from('schedules').select('*').eq('date', date),
      sb.from('schedule_blocks').select('*').eq('date', date),
      sb.from('status_events').select('*')
        .gte('started_at', date + 'T00:00:00')
        .lte('started_at', date + 'T23:59:59'),
    ]).then(([{ data: scheds }, { data: extras }, { data: events }]) => {
      setSchedules(scheds || [])
      setExtraBlocks(extras || [])
      setStatusEvents(events || [])
    })
  }, [date])

  useEffect(() => {
    sb.from('app_settings').select('value').eq('key', 'recurring_blocks').maybeSingle()
      .then(({ data }) => { try { setRecurringDefs(JSON.parse(data?.value || '[]')) } catch {} })
  }, [])
  const saveRecurringDefs = async (defs) => {
    setRecurringDefs(defs)
    await sb.from('app_settings').upsert({ key: 'recurring_blocks', value: JSON.stringify(defs) }, { onConflict: 'key' })
  }

  // Current time
  useEffect(() => {
    const update = () => {
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      setCurrentInterval((mins - START_HOUR * 60) / 15)
    }
    update()
    const t = setInterval(update, 30000)
    return () => clearInterval(t)
  }, [])

  // Container width
  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver(entries => {
      for (const e of entries) setContainerWidth(e.contentRect.width)
    })
    obs.observe(containerRef.current)
    setContainerWidth(containerRef.current.offsetWidth)
    return () => obs.disconnect()
  }, [])

  // Build blocks from schedules + extras
  useEffect(() => {
    const newBlocks = {}
    profiles.forEach(p => {
      const sched = schedules.find(s => s.profile_id === p.id)
      newBlocks[p.id] = []
      const weekday = new Date(date + 'T12:00:00').getDay()
      const pushRecurring = () => recurringDefs
        .filter(d => d.profile_id === p.id && Number(d.weekday) === weekday)
        .forEach(d => newBlocks[p.id].push({
          id: `rec-${d.id}`, type: d.type || 'meeting', start: d.start_interval,
          duration: d.duration_intervals, note: d.note || '', recurring: true, recId: d.id,
        }))
      if (!sched) {
        extraBlocks.filter(b => b.profile_id === p.id).forEach(b => {
          newBlocks[p.id].push({ id: b.id, type: b.type, start: b.start_interval, duration: b.duration_intervals, dbId: b.id, note: b.note || '' })
        })
        pushRecurring()
        return
      }
      if (['pto','sick','holiday','off'].includes(sched.day_type)) {
        newBlocks[p.id] = [{ id: sched.day_type+'-'+p.id, type: sched.day_type, start: 0, duration: TOTAL_INTERVALS }]
        return
      }
      if (sched.shift_start && sched.shift_end) {
        const s = timeToInterval(sched.shift_start)
        const e = timeToInterval(sched.shift_end)
        if (s !== null && e > s) newBlocks[p.id].push({ id:'shift-'+p.id, type:'shift', start:Math.max(0,s), duration:e-s })
      }
      if (sched.break1_start) {
        const s = timeToInterval(sched.break1_start)
        if (s !== null) newBlocks[p.id].push({ id:'b1-'+p.id, type:'break', start:s, duration:Math.round((sched.break1_duration||15)/15) })
      }
      if (sched.lunch_start) {
        const s = timeToInterval(sched.lunch_start)
        if (s !== null) newBlocks[p.id].push({ id:'lunch-'+p.id, type:'lunch', start:s, duration:Math.round((sched.lunch_duration||30)/15) })
      }
      if (sched.break2_start) {
        const s = timeToInterval(sched.break2_start)
        if (s !== null) newBlocks[p.id].push({ id:'b2-'+p.id, type:'break', start:s, duration:Math.round((sched.break2_duration||15)/15) })
      }
      extraBlocks.filter(b => b.profile_id === p.id).forEach(b => {
        newBlocks[p.id].push({ id: b.id, type: b.type, start: b.start_interval, duration: b.duration_intervals, dbId: b.id, note: b.note || '' })
      })
      pushRecurring()
    })
    setBlocks(newBlocks)
  }, [schedules, extraBlocks, profiles, recurringDefs, date])

  // Drag handling
  useEffect(() => {
    if (!dragging) return
    const cellW = CELL_WIDTH
    const onMove = (e) => {
      const dx = e.clientX - dragStartX.current
      const dIntervals = Math.round(dx / cellW)
      if (dIntervals === 0) return
      dragStartX.current = dragStartX.current + dIntervals * cellW
      setBlocks(prev => {
        const pBlocks = [...(prev[dragging.profileId] || [])]
        const idx = pBlocks.findIndex(b => b.id === dragging.blockId)
        if (idx === -1) return prev
        const block = { ...pBlocks[idx] }
        if (dragging.mode === 'move') {
          block.start = Math.max(0, block.start + dIntervals)
        } else {
          block.duration = Math.max(1, block.duration + dIntervals)
        }
        pBlocks[idx] = block
        return { ...prev, [dragging.profileId]: pBlocks }
      })
    }
    const onUp = () => {
      setBlocks(curr => {
        saveBlocksToDb(dragging.profileId, curr)
        return curr
      })
      setDragging(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [dragging, CELL_WIDTH])

  const saveBlocksToDb = async (profileId, currentBlocks) => {
    const pBlocks = currentBlocks[profileId] || []
    const shiftBlock = pBlocks.find(b => b.type === 'shift')
    if (!shiftBlock) return
    setSaving(true)
    const payload = {
      profile_id: profileId, date,
      day_type: 'work',
      shift_start: intervalToTime(shiftBlock.start),
      shift_end: intervalToTime(shiftBlock.start + shiftBlock.duration),
    }
    const breakBlocks = pBlocks.filter(b => b.type === 'break')
    const lunchBlock = pBlocks.find(b => b.type === 'lunch')
    if (breakBlocks[0]) { payload.break1_start = intervalToTime(breakBlocks[0].start); payload.break1_duration = breakBlocks[0].duration * 15 }
    if (lunchBlock) { payload.lunch_start = intervalToTime(lunchBlock.start); payload.lunch_duration = lunchBlock.duration * 15 }
    if (breakBlocks[1]) { payload.break2_start = intervalToTime(breakBlocks[1].start); payload.break2_duration = breakBlocks[1].duration * 15 }
    await sb.from('schedules').upsert(payload, { onConflict: 'profile_id,date' })
    for (const b of pBlocks.filter(b => ['outbound','meeting'].includes(b.type) && b.dbId)) {
      await sb.from('schedule_blocks').update({ start_interval: b.start, duration_intervals: b.duration }).eq('id', b.dbId)
    }
    if (onUpdate) onUpdate()
    setSaving(false)
  }

  const openShiftModal = (profileId) => {
    const sched = schedules.find(s => s.profile_id === profileId)
    setShiftForm(sched ? {
      shift_start: sched.shift_start || '08:00', shift_end: sched.shift_end || '17:00',
      break1_start: sched.break1_start || '10:00', break1_duration: sched.break1_duration || 15,
      lunch_start: sched.lunch_start || '12:00', lunch_duration: sched.lunch_duration || 30,
      break2_start: sched.break2_start || '14:30', break2_duration: sched.break2_duration || 15,
      day_type: sched.day_type || 'work',
    } : { shift_start:'08:00', shift_end:'17:00', break1_start:'10:00', break1_duration:15, lunch_start:'12:00', lunch_duration:30, break2_start:'14:30', break2_duration:15, day_type:'work' })
    setShiftModal(profileId)
  }

  const saveShiftModal = async () => {
    if (!shiftModal) return
    setSaving(true)
    const isOff = ['pto','sick','holiday','off'].includes(shiftForm.day_type)
    const payload = {
      profile_id: shiftModal, date, day_type: shiftForm.day_type,
      shift_start: isOff ? null : shiftForm.shift_start,
      shift_end: isOff ? null : shiftForm.shift_end,
      break1_start: isOff ? null : shiftForm.break1_start || null,
      break1_end: isOff ? null : shiftForm.break1_start ? addMins(shiftForm.break1_start, shiftForm.break1_duration) : null,
      break1_duration: shiftForm.break1_duration,
      break2_start: isOff ? null : shiftForm.break2_start || null,
      break2_end: isOff ? null : shiftForm.break2_start ? addMins(shiftForm.break2_start, shiftForm.break2_duration) : null,
      break2_duration: shiftForm.break2_duration,
      lunch_start: isOff ? null : shiftForm.lunch_start || null,
      lunch_end: isOff ? null : shiftForm.lunch_start ? addMins(shiftForm.lunch_start, shiftForm.lunch_duration) : null,
      lunch_duration: shiftForm.lunch_duration,
      created_by: profile?.id,
    }
    await sb.from('schedules').upsert(payload, { onConflict: 'profile_id,date' })
    const { data } = await sb.from('schedules').select('*').eq('date', date)
    setSchedules(data || [])
    if (onUpdate) onUpdate()
    setSaving(false)
    setShiftModal(null)
  }

  const deleteSchedule = async (profileId) => {
    await Promise.all([
      sb.from('schedules').delete().eq('profile_id', profileId).eq('date', date),
      sb.from('schedule_blocks').delete().eq('profile_id', profileId).eq('date', date),
    ])
    setSchedules(prev => prev.filter(s => s.profile_id !== profileId))
    setExtraBlocks(prev => prev.filter(b => b.profile_id !== profileId))
    setBlocks(prev => ({ ...prev, [profileId]: [] }))
    setShiftModal(null)
  }

  const removeBlock = async (profileId, blockId) => {
    const block = (blocks[profileId] || []).find(b => b.id === blockId)
    if (block?.recurring) {
      if (!confirm(`This ${block.note ? `"${block.note}"` : 'block'} repeats every week — remove it from ALL weeks?`)) return
      await saveRecurringDefs(recurringDefs.filter(d => d.id !== block.recId))
      return
    }
    if (block?.dbId) {
      await sb.from('schedule_blocks').delete().eq('id', block.dbId)
      setExtraBlocks(prev => prev.filter(b => b.id !== block.dbId))
    }
    const newBlocks = { ...blocks, [profileId]: (blocks[profileId] || []).filter(b => b.id !== blockId) }
    setBlocks(newBlocks)
    if (!block?.dbId) saveBlocksToDb(profileId, newBlocks)
  }

  const addExtraBlock = async (profileId, type, startInterval) => {
    setAddBlockMenu(null)
    if (type === 'shift') { openShiftModal(profileId); return }
    const existing = blocks[profileId] || []
    const shiftBlock = existing.find(b => b.type === 'shift')
    // Start where the manager clicked; fall back to just inside the shift.
    const start = startInterval != null ? startInterval : (shiftBlock ? shiftBlock.start + 4 : 8)
    const durations = { outbound:8, meeting:4, break:1, lunch:2, pto:TOTAL_INTERVALS, sick:TOTAL_INTERVALS, holiday:TOTAL_INTERVALS }
    const duration = durations[type] || 2
    if (type === 'meeting') {
      setMeetingForm({ note: '', repeat: false, durationMin: 15 })
      setMeetingModal({ profileId, start })
      return
    }
    if (['outbound','meeting'].includes(type)) {
      setSaving(true)
      const { data: inserted } = await sb.from('schedule_blocks').insert({
        profile_id: profileId, date, type,
        start_interval: start, duration_intervals: duration, created_by: profile?.id,
      }).select().single()
      if (inserted) {
        setExtraBlocks(prev => [...prev, inserted])
        setBlocks(prev => ({ ...prev, [profileId]: [...(prev[profileId]||[]), { id:inserted.id, type, start, duration, dbId:inserted.id }] }))
      }
      setSaving(false)
      return
    }
    const newBlock = { id: type+'-'+Date.now(), type, start, duration }
    const newBlocks = { ...blocks, [profileId]: [...existing, newBlock] }
    setBlocks(newBlocks)
    saveBlocksToDb(profileId, newBlocks)
  }

  const saveMeeting = async () => {
    if (!meetingModal) return
    const { profileId, start } = meetingModal
    const duration = Math.max(1, Math.round(meetingForm.durationMin / 15))
    const note = meetingForm.note.trim()
    setSaving(true)
    if (meetingForm.repeat) {
      const def = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        profile_id: profileId,
        weekday: new Date(date + 'T12:00:00').getDay(),
        type: 'meeting', start_interval: start, duration_intervals: duration,
        note, created_by: profile?.id || null,
      }
      await saveRecurringDefs([...recurringDefs, def])
    } else {
      let { data: inserted, error } = await sb.from('schedule_blocks').insert({
        profile_id: profileId, date, type: 'meeting',
        start_interval: start, duration_intervals: duration, created_by: profile?.id, note,
      }).select().single()
      if (error && /note/.test(error.message)) {
        // schedule_blocks.note migration not run yet — save without the note.
        alert('Meeting added, but the note could not be saved until the schedule_blocks.note migration is run.')
        ;({ data: inserted } = await sb.from('schedule_blocks').insert({
          profile_id: profileId, date, type: 'meeting',
          start_interval: start, duration_intervals: duration, created_by: profile?.id,
        }).select().single())
      }
      if (inserted) setExtraBlocks(prev => [...prev, inserted])
    }
    setSaving(false)
    setMeetingModal(null)
  }

  // Build adherence segments for a profile
  const getAdherenceSegments = (profileId) => {
    const sched = schedules.find(s => s.profile_id === profileId)
    if (!sched || !sched.shift_start || !sched.shift_end) return []
    const events = statusEvents.filter(e => e.profile_id === profileId && e.started_at)
    if (events.length === 0) return []

    const shiftStart = timeToInterval(sched.shift_start)
    const shiftEnd = timeToInterval(sched.shift_end)
    const segments = []

    events.forEach(ev => {
      if (!ev.started_at) return
      const start = isoToInterval(ev.started_at)
      const end = ev.ended_at ? isoToInterval(ev.ended_at) : (isToday ? currentInterval : shiftEnd)
      if (start === null || end === null || start >= shiftEnd || end <= shiftStart) return
      const clampedStart = Math.max(start, shiftStart)
      const clampedEnd = Math.min(end, shiftEnd)
      if (clampedEnd <= clampedStart) return
      const adherent = ['Available','On Call','Wrap Up'].includes(ev.status)
      const offSchedule = ['Break','Lunch'].includes(ev.status)
      segments.push({ start: clampedStart, end: clampedEnd, status: ev.status, adherent, offSchedule })
    })
    return segments
  }

  const formatDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
  const prevDay = () => { const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate()-1); setDate(d.toISOString().split('T')[0]) }
  const nextDay = () => { const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate()+1); setDate(d.toISOString().split('T')[0]) }

  // Coverage calculation
  const getCoverage = (interval) => profiles.filter(p => {
    const pBlocks = blocks[p.id] || []
    const shift = pBlocks.find(b => b.type === 'shift')
    if (!shift) return false
    return interval >= shift.start && interval < shift.start + shift.duration &&
      !pBlocks.some(b => ['break','lunch'].includes(b.type) && interval >= b.start && interval < b.start + b.duration)
  }).length

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

      {/* Date nav bar */}
      <div style={{ padding:'12px 24px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between', background:'var(--surface)', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <button onClick={prevDay} style={{ width:32, height:32, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-secondary)', display:'flex', alignItems:'center', justifyContent:'center' }}
            onMouseEnter={e => e.currentTarget.style.background='var(--border)'}
            onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>‹</button>
          <div style={{ fontSize:14, fontWeight:500, color:'var(--text-primary)', minWidth:260, textAlign:'center' }}>
            {formatDate(date)}
            {isToday && <span style={{ marginLeft:8, fontSize:11, fontWeight:600, color:'#2a78d6', background:'#2a78d618', padding:'2px 8px', borderRadius:99 }}>Today</span>}
          </div>
          <button onClick={nextDay} style={{ width:32, height:32, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-secondary)', display:'flex', alignItems:'center', justifyContent:'center' }}
            onMouseEnter={e => e.currentTarget.style.background='var(--border)'}
            onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>›</button>
        </div>

        {/* Legend */}
        <div style={{ display:'flex', gap:14, alignItems:'center', flexWrap:'wrap' }}>
          {BLOCK_TYPES.slice(0,5).map(bt => (
            <div key={bt.id} style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, color:'var(--text-secondary)' }}>
              <div style={{ width:10, height:10, borderRadius:2, background:bt.color, opacity:.8 }} />
              {bt.label}
            </div>
          ))}
          <div style={{ width:1, height:14, background:'var(--border)' }} />
          <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, color:'var(--text-secondary)' }}>
            <div style={{ width:10, height:4, borderRadius:2, background:'#0ca30c' }} />Adherent
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, color:'var(--text-secondary)' }}>
            <div style={{ width:10, height:4, borderRadius:2, background:'#d03b3b' }} />Deviation
          </div>
          {saving && <span style={{ fontSize:11, color:'var(--text-muted)' }}>Saving...</span>}
        </div>
      </div>

      {/* Timeline */}
      <div style={{ flex:1, overflow:'auto', WebkitOverflowScrolling:'touch' }} ref={containerRef}>
        <div style={{ minWidth: LABEL_WIDTH + TOTAL_INTERVALS * CELL_WIDTH + 120 }}>

          {/* Hour header */}
          <div style={{ display:'flex', position:'sticky', top:0, zIndex:20, background:'var(--surface)', borderBottom:'1px solid var(--border)', minHeight:48, boxShadow:'0 1px 4px rgba(0,0,0,.06)' }}>
            <div style={{ width:LABEL_WIDTH, flexShrink:0, padding:'8px 16px', borderRight:'1px solid var(--border)', fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', background:'var(--surface-2)', position:'sticky', left:0, zIndex:15 }}>Agent</div>
            <div style={{ flex:1, position:'relative', height:48 }}>
              {Array.from({ length: TOTAL_INTERVALS + 1 }, (_, i) => i).map(i => {
                const isHour = i % 4 === 0
                const isHalf = i % 4 === 2
                const isQuarter = i % 4 === 1 || i % 4 === 3
                const h = Math.floor(i / 4) + START_HOUR
                return (
                  <div key={i} style={{ position:'absolute', left:i*CELL_WIDTH, top:0, bottom:0, pointerEvents:'none', zIndex:1 }}>
                    {/* Tick mark */}
                    <div style={{
                      position:'absolute', left:0,
                      top: isHour ? 0 : isHalf ? '30%' : '55%',
                      bottom:0,
                      width: isHour ? '1.5px' : '1px',
                      background: isHour ? 'var(--border-strong)' : 'var(--border)',
                      opacity: isHour ? 1 : isHalf ? 0.7 : 0.45
                    }} />
                    {/* Hour label */}
                    {isHour && h <= END_HOUR && (
                      <span style={{ position:'absolute', top:4, left:3, fontSize:10, color:'var(--text-muted)', fontWeight:500, whiteSpace:'nowrap', userSelect:'none' }}>
                        {fmtHour(h)}
                      </span>
                    )}
                    {/* :15/:30/:45 labels — only show :30 */}
                    {isHalf && (
                      <span style={{ position:'absolute', bottom:4, left:3, fontSize:9, color:'var(--text-muted)', opacity:.5, whiteSpace:'nowrap', userSelect:'none' }}>:30</span>
                    )}
                  </div>
                )
              })}
            </div>

          </div>

          {/* Agent rows */}
          {profiles.map(p => {
            const pBlocks = blocks[p.id] || []
            const adherenceSegs = getAdherenceSegments(p.id)
            const sched = schedules.find(s => s.profile_id === p.id)
            const repLogs = statusEvents.filter(e => e.profile_id === p.id)
            const totalAdh = adherenceSegs.length > 0
              ? Math.round(adherenceSegs.filter(s => s.adherent).reduce((sum, s) => sum + (s.end - s.start), 0) / adherenceSegs.reduce((sum, s) => sum + (s.end - s.start), 0) * 100)
              : null
            const adhColor = totalAdh == null ? 'var(--text-muted)' : totalAdh >= 90 ? '#0ca30c' : totalAdh >= 75 ? '#eda100' : '#d03b3b'

            return (
              <div key={p.id} style={{ display:'flex', borderBottom:'1px solid var(--border)', minHeight:ROW_HEIGHT + ADHERENCE_HEIGHT + 8 }}
                onMouseLeave={() => setTooltip(null)}>

                {/* Agent label */}
                <div style={{ width:LABEL_WIDTH, flexShrink:0, display:'flex', flexDirection:'column', justifyContent:'center', gap:3, padding:'10px 16px', borderRight:'1px solid var(--border)', background:'var(--surface-2)', position:'sticky', left:0, zIndex:15 }}>
                  {/* Top row: avatar + name + + button */}
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ width:30, height:30, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 18 : 11, fontWeight:600, flexShrink:0 }}>
                      <Avatar avatar={p.avatar} name={p.name||p.email} />
                    </div>
                    <div style={{ fontSize:11, fontWeight:600, color:'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'normal', wordBreak:'break-word', flex:1, minWidth:0, lineHeight:1.3 }}>{p.name||p.email}</div>
                    {isAdmin && (
                      <button onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setAddBlockMenu({ profileId:p.id, x:r.left, y:r.bottom + 4 }) }}
                        style={{ width:22, height:22, borderRadius:'50%', border:'1px solid var(--border)', background:'var(--surface)', cursor:'pointer', fontSize:14, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-muted)', flexShrink:0 }}
                        onMouseEnter={e => { e.currentTarget.style.background='var(--accent-bg)'; e.currentTarget.style.color='var(--accent)' }}
                        onMouseLeave={e => { e.currentTarget.style.background='var(--surface)'; e.currentTarget.style.color='var(--text-muted)' }}
                        title="Add event">+</button>
                    )}
                  </div>
                  {/* Shift time + adherence below — read from live blocks so updates during drag */}
                  <div style={{ paddingLeft:38 }}>
                    {(() => {
                      const liveShift = pBlocks.find(b => b.type === 'shift')
                      if (liveShift) {
                        return (
                          <div style={{ fontSize:9, color:'var(--text-muted)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                            {fmtTime(intervalToTime(liveShift.start))}–{fmtTime(intervalToTime(liveShift.start + liveShift.duration))}
                          </div>
                        )
                      }
                      if (sched && ['pto','sick','holiday'].includes(sched.day_type)) {
                        return <div style={{ fontSize:9, color:'var(--text-muted)' }}>{sched.day_type.toUpperCase()}</div>
                      }
                      return <div style={{ fontSize:9, color:'var(--text-muted)' }}>No shift</div>
                    })()}
                    {totalAdh != null && (
                      <div style={{ fontSize:9, color:adhColor, fontWeight:600 }}>{totalAdh}%</div>
                    )}
                  </div>
                </div>

                {/* Track area — right-click empty space to add an event here.
                    Blocks stopPropagation their own context menu, so this only
                    fires on the gaps between them. */}
                <div style={{ flex:1, position:'relative', overflow:'visible', minWidth: TOTAL_INTERVALS * CELL_WIDTH + 120 }}
                  onContextMenu={e => {
                    if (!isAdmin) return
                    e.preventDefault()
                    const left = e.currentTarget.getBoundingClientRect().left
                    const clicked = Math.max(0, Math.round((e.clientX - left) / CELL_WIDTH))
                    setAddBlockMenu({ profileId:p.id, x:e.clientX, y:e.clientY, startInterval:clicked })
                  }}>
                  {/* Grid lines */}
                  {Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => i).map(i => (
                    <div key={i} style={{ position:'absolute', left:i*4*CELL_WIDTH, top:0, bottom:0, width:'1px', background: i%4===0 ? 'var(--border)' : 'transparent', pointerEvents:'none' }} />
                  ))}

                  {/* Now line */}
                  {isToday && currentInterval !== null && currentInterval >= 0 && currentInterval <= TOTAL_INTERVALS && (
                    <div style={{ position:'absolute', left:currentInterval*CELL_WIDTH, top:0, bottom:0, width:2, background:'#e24b4a', zIndex:10, pointerEvents:'none' }}>
                      <div style={{ position:'absolute', top:0, left:-3, width:8, height:8, borderRadius:'50%', background:'#e24b4a' }} />
                    </div>
                  )}

                  {/* Schedule blocks */}
                  {pBlocks.map(block => {
                    const bt = BLOCK_TYPES.find(t => t.id === block.type) || BLOCK_TYPES[0]
                    const w = block.duration * CELL_WIDTH - 2
                    const l = block.start * CELL_WIDTH + 1
                    const isShift = block.type === 'shift'
                    return (
                      <div key={block.id}
                        onMouseDown={e => { if (!isAdmin || block.recurring) return; e.preventDefault(); e.stopPropagation(); dragStartX.current = e.clientX; setDragging({ profileId:p.id, blockId:block.id, mode:'move' }) }}
                        onContextMenu={e => { if (!isAdmin) return; e.preventDefault(); e.stopPropagation();
                          const rowRect = e.currentTarget.parentElement.getBoundingClientRect()
                          const clicked = Math.max(0, Math.round((e.clientX - rowRect.left) / CELL_WIDTH))
                          setContextMenu({ x:e.clientX, y:e.clientY, profileId:p.id, block, startInterval: clicked }) }}
                        onMouseEnter={e => {
                          const rect = e.currentTarget.getBoundingClientRect()
                          setTooltip({
                            x: rect.left + rect.width/2, y: rect.top - 8,
                            content: `${bt.label}: ${fmtTime(intervalToTime(block.start))} – ${fmtTime(intervalToTime(block.start+block.duration))}${block.note ? ` — ${block.note}` : ''}${block.recurring ? ' · ↻ every week' : ''}`
                          })
                        }}
                        onMouseLeave={() => setTooltip(null)}
                        style={{ position:'absolute', left:Math.max(0, l), top: isShift ? 8 : 12, height: isShift ? ROW_HEIGHT - 24 : ROW_HEIGHT - 32,
                          width:Math.max(0, w), background:bt.bg, border:`1.5px solid ${bt.color}`, borderRadius:5,
                          display:'flex', alignItems:'center', overflow:'hidden',
                          cursor: isAdmin ? 'grab' : 'default', zIndex: isShift ? 2 : 4, userSelect:'none' }}>
                        <span style={{ fontSize:9, fontWeight:700, color:bt.text, paddingLeft:6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>
                          {block.recurring ? '↻ ' : ''}{block.duration * 15 >= 30 ? (block.note || bt.label) : ''}
                        </span>
                        {isAdmin && !block.recurring && (
                          <div onMouseDown={e => { e.preventDefault(); e.stopPropagation(); dragStartX.current = e.clientX; setDragging({ profileId:p.id, blockId:block.id, mode:'resize' }) }}
                            style={{ width:5, height:'100%', background:bt.color, cursor:'ew-resize', flexShrink:0, opacity:.4 }} />
                        )}
                      </div>
                    )
                  })}

                  {/* Adherence track */}
                  {adherenceSegs.length > 0 && (
                    <div style={{ position:'absolute', bottom:4, left:0, right:0, height:ADHERENCE_HEIGHT }}>
                      {adherenceSegs.map((seg, i) => {
                        const l = seg.start * CELL_WIDTH
                        const w = (seg.end - seg.start) * CELL_WIDTH
                        const color = seg.adherent ? '#0ca30c' : '#d03b3b'
                        return (
                          <div key={i}
                            onMouseEnter={e => {
                              const rect = e.currentTarget.getBoundingClientRect()
                              setTooltip({
                                x: rect.left + rect.width/2, y: rect.top - 8,
                                content: `${seg.status}: ${Math.round((seg.end - seg.start) * 15)}min — ${seg.adherent ? 'On schedule' : 'Deviation'}`
                              })
                            }}
                            onMouseLeave={() => setTooltip(null)}
                            style={{ position:'absolute', left:l, bottom:2, width:Math.max(w-1,1), height:5, borderRadius:3, background:color, opacity: seg.adherent ? .75 : 1, cursor:'default' }} />
                        )
                      })}
                    </div>
                  )}
                </div>


              </div>
            )
          })}

          {/* Coverage bar */}
          <div style={{ display:'flex', borderTop:'2px solid var(--border)', background:'var(--surface-2)' }}>
            <div style={{ width:LABEL_WIDTH, flexShrink:0, padding:'8px 16px', borderRight:'1px solid var(--border)', fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', position:'sticky', left:0, zIndex:15, background:'var(--surface-2)' }}>Coverage</div>
            <div style={{ flex:1, position:'relative', height:32 }}>
              {Array.from({ length: TOTAL_INTERVALS }, (_, i) => i).map(i => {
                const count = getCoverage(i)
                const maxCount = profiles.length || 1
                const pct = Math.min(count / maxCount, 1)
                // A gap in coverage is the thing a manager most needs to SEE, so
                // it can't render as empty space. Zero-coverage intervals get a
                // red-tinted full-height column with a solid red baseline; a
                // blank cell reads as "fine" when it's the opposite.
                const noCoverage = count === 0
                const barColor = pct >= 0.8 ? '#0ca30c' : pct >= 0.5 ? '#eda100' : '#d03b3b'
                return (
                  <div key={i}
                    onMouseEnter={e => {
                      const r = e.currentTarget.getBoundingClientRect()
                      setTooltip({ x:r.left + r.width/2, y:r.top - 8,
                        content: `${intervalToTime(i)} — ${count} agent${count === 1 ? '' : 's'} covering${noCoverage ? ' · NO COVERAGE' : ''}` })
                    }}
                    onMouseLeave={() => setTooltip(null)}
                    style={{ position:'absolute', left:i*CELL_WIDTH, top:0, bottom:0, width:Math.max(CELL_WIDTH-1,1),
                      background: noCoverage ? 'rgba(226,75,74,.16)' : 'transparent' }}>
                    {noCoverage ? (
                      <div style={{ position:'absolute', bottom:0, left:0, right:0, height:6, background:'#d03b3b' }} />
                    ) : (
                      <div style={{ position:'absolute', bottom:4, left:0, right:0, height:Math.max(pct * 20, 4),
                        background:barColor, borderRadius:2, transition:'height .1s' }} />
                    )}
                  </div>
                )
              })}
            </div>

          </div>
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div style={{ position:'fixed', left:tooltip.x, top:tooltip.y, transform:'translate(-50%,-100%)', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'6px 10px', fontSize:11, color:'var(--text-primary)', pointerEvents:'none', zIndex:999, whiteSpace:'nowrap', boxShadow:'0 4px 16px rgba(0,0,0,.12)' }}>
          {tooltip.content}
        </div>
      )}

      {/* Context menu overlay */}
      {contextMenu && <div style={{ position:'fixed', inset:0, zIndex:299 }} onMouseDown={() => setContextMenu(null)} />}

      {/* Context menu */}
      {contextMenu && (() => {
        const { x, y, profileId, block, startInterval } = contextMenu
        const bt = BLOCK_TYPES.find(t => t.id === block.type)
        const isShift = block.type === 'shift'
        const isScheduleRow = ['shift','pto','sick','holiday'].includes(block.type)
        return (
          <div style={{ position:'fixed', left:x, top:y, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 4px 20px rgba(0,0,0,.18)', zIndex:300, minWidth:180, overflow:'hidden' }}>
            <div style={{ padding:'8px 14px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ width:10, height:10, borderRadius:2, background:bt?.color }} />
              <span style={{ fontSize:11, fontWeight:600, color:'var(--text-primary)' }}>{bt?.label || block.type}</span>
            </div>
            {[
              { label: isShift ? 'Edit shift' : 'Edit block', action: () => { setContextMenu(null); openShiftModal(profileId) }, danger: false },
              { label: 'Add event…', action: () => { setAddBlockMenu({ profileId, x, y, startInterval }); setContextMenu(null) }, danger: false },
              { label: isShift ? 'Delete shift' : `Remove ${bt?.label||'block'}`, action: () => { setContextMenu(null); if (isScheduleRow) { if(confirm(`Remove ${bt?.label || block.type}?`)) deleteSchedule(profileId) } else removeBlock(profileId, block.id) }, danger: true },
            ].map(item => (
              <button key={item.label} onMouseDown={item.action}
                style={{ display:'flex', alignItems:'center', width:'100%', padding:'10px 14px', background:'transparent', border:'none', cursor:'pointer', fontSize:12, color: item.danger ? '#e24b4a' : 'var(--text-primary)', textAlign:'left' }}
                onMouseEnter={e => e.currentTarget.style.background = item.danger ? '#fee2e220' : 'var(--surface-2)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                {item.label}
              </button>
            ))}
          </div>
        )
      })()}

      {/* Add block menu */}
      {addBlockMenu && <div style={{ position:'fixed', inset:0, zIndex:199 }} onMouseDown={() => setAddBlockMenu(null)} />}
      {addBlockMenu && (
        <div style={{ position:'fixed',
          left: Math.min(addBlockMenu.x ?? LABEL_WIDTH - 16, window.innerWidth - 200),
          top: Math.min(addBlockMenu.y ?? window.innerHeight * 0.3, window.innerHeight - 340),
          background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 4px 20px rgba(0,0,0,.2)', zIndex:200, minWidth:180, overflow:'hidden' }}>
          <div style={{ padding:'6px 14px', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', borderBottom:'1px solid var(--border)' }}>Add Event</div>
          {['shift','break','lunch','outbound','meeting','pto','sick','holiday'].map(type => {
            const bt = BLOCK_TYPES.find(b => b.id === type)
            return (
              <button key={type} onMouseDown={() => addExtraBlock(addBlockMenu.profileId, type, addBlockMenu.startInterval)}
                style={{ display:'flex', alignItems:'center', gap:10, width:'100%', padding:'9px 14px', background:'transparent', border:'none', cursor:'pointer', fontSize:12, color:'var(--text-primary)', textAlign:'left' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <span style={{ width:10, height:10, borderRadius:2, background:bt?.color||'#ccc', flexShrink:0 }} />
                {bt?.label||type}
              </button>
            )
          })}
        </div>
      )}

      {/* Meeting dialog — note + optional weekly repeat */}
      {meetingModal && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.45)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center' }}
          onMouseDown={() => setMeetingModal(null)}>
          <div onMouseDown={e => e.stopPropagation()}
            style={{ background:'var(--surface)', borderRadius:12, padding:22, width:400, boxShadow:'0 8px 32px rgba(0,0,0,.25)' }}>
            <div style={{ fontSize:15, fontWeight:600, marginBottom:4 }}>Add meeting</div>
            <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:14 }}>
              {profiles.find(p => p.id === meetingModal.profileId)?.name} · starts {fmtTime(intervalToTime(meetingModal.start))}
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              <div className="form-field">
                <label className="form-label">What's the meeting? (shows on hover)</label>
                <input className="form-input" autoFocus value={meetingForm.note} placeholder="Team Huddle, 1-on-1, training…"
                  onChange={e => setMeetingForm(f => ({ ...f, note: e.target.value }))} />
              </div>
              <div className="form-field">
                <label className="form-label">Length</label>
                <div style={{ display:'flex', gap:6 }}>
                  {[15, 30, 45, 60].map(m => (
                    <button key={m} onClick={() => setMeetingForm(f => ({ ...f, durationMin: m }))}
                      style={{ flex:1, padding:'7px 0', borderRadius:8, fontSize:12, fontWeight:700, cursor:'pointer',
                        border:`2px solid ${meetingForm.durationMin === m ? 'var(--accent)' : 'var(--border)'}`,
                        background: meetingForm.durationMin === m ? 'var(--accent-bg)' : 'var(--surface-2)',
                        color: meetingForm.durationMin === m ? 'var(--accent)' : 'var(--text-secondary)' }}>
                      {m}m
                    </button>
                  ))}
                </div>
              </div>
              <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:12.5, cursor:'pointer' }}>
                <input type="checkbox" checked={meetingForm.repeat}
                  onChange={e => setMeetingForm(f => ({ ...f, repeat: e.target.checked }))} />
                <span>Repeats <b>every {new Date(date + 'T12:00:00').toLocaleDateString([], { weekday: 'long' })}</b> — shows on the schedule automatically</span>
              </label>
              <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
                <button className="btn" onClick={() => setMeetingModal(null)}>Cancel</button>
                <button className="btn primary" onClick={saveMeeting} disabled={saving}>
                  {saving ? 'Adding…' : meetingForm.repeat ? 'Add weekly meeting' : 'Add meeting'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Shift modal */}
      {shiftModal && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.45)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'var(--surface)', borderRadius:12, padding:24, width:460, boxShadow:'0 8px 32px rgba(0,0,0,.25)', maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ fontSize:15, fontWeight:600, color:'var(--text-primary)', marginBottom:18 }}>
              {profiles.find(p => p.id === shiftModal)?.name || 'Agent'} — {new Date(date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})}
            </div>

            <div style={{ display:'flex', gap:6, marginBottom:16, flexWrap:'wrap' }}>
              {['work','pto','sick','holiday','off'].map(dt => (
                <button key={dt} onClick={() => setShiftForm(p => ({ ...p, day_type: dt }))}
                  style={{ padding:'5px 12px', borderRadius:99, fontSize:11, fontWeight:500, border:'1px solid', cursor:'pointer',
                    borderColor: shiftForm.day_type === dt ? 'var(--accent)' : 'var(--border)',
                    background: shiftForm.day_type === dt ? 'var(--accent)' : 'var(--surface-2)',
                    color: shiftForm.day_type === dt ? '#fff' : 'var(--text-secondary)' }}>
                  {dt.charAt(0).toUpperCase()+dt.slice(1)}
                </button>
              ))}
            </div>

            {shiftForm.day_type === 'work' && (
              <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                  {[['Shift start','shift_start'],['Shift end','shift_end'],['Break 1','break1_start'],['Lunch','lunch_start'],['Break 2','break2_start']].map(([label, key]) => (
                    <div key={key}>
                      <label style={{ fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', display:'block', marginBottom:4 }}>{label}</label>
                      <input type="time" value={shiftForm[key]||''} onChange={e => setShiftForm(p => ({ ...p, [key]: e.target.value }))}
                        style={{ width:'100%', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'7px 10px', fontSize:13, background:'var(--surface-2)', color:'var(--text-primary)', fontFamily:'inherit' }} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display:'flex', justifyContent:'space-between', marginTop:20, gap:8 }}>
              {schedules.find(s => s.profile_id === shiftModal) && (
                <button onClick={() => { if(confirm('Delete this shift?')) deleteSchedule(shiftModal) }}
                  style={{ padding:'7px 14px', fontSize:12, fontWeight:500, border:'1px solid #e24b4a', borderRadius:'var(--radius)', background:'transparent', color:'#e24b4a', cursor:'pointer' }}>
                  Delete shift
                </button>
              )}
              <div style={{ display:'flex', gap:8, marginLeft:'auto' }}>
                <button onClick={() => setShiftModal(null)}
                  style={{ padding:'7px 14px', fontSize:12, fontWeight:500, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface)', color:'var(--text-secondary)', cursor:'pointer' }}>
                  Cancel
                </button>
                <button onClick={saveShiftModal} disabled={saving}
                  style={{ padding:'7px 20px', fontSize:12, fontWeight:600, border:'none', borderRadius:'var(--radius)', background:'var(--accent)', color:'#fff', cursor:'pointer' }}>
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
