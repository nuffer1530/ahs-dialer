import { useState, useRef, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import Modal from './Modal'

const BLOCK_TYPES = [
  { id: 'shift',     label: 'On Shift',        color: '#3b82f6', bg: '#dbeafe', text: '#1d4ed8' },
  { id: 'break',     label: 'Break',            color: '#f97316', bg: '#ffedd5', text: '#c2410c' },
  { id: 'lunch',     label: 'Lunch',            color: '#22c55e', bg: '#dcfce7', text: '#15803d' },
  { id: 'outbound',  label: 'Outbounding',      color: '#a855f7', bg: '#f3e8ff', text: '#7e22ce' },
  { id: 'meeting',   label: 'Meeting/Training', color: '#ef4444', bg: '#fee2e2', text: '#b91c1c' },
  { id: 'pto',       label: 'PTO',              color: '#eab308', bg: '#fef9c3', text: '#a16207' },
  { id: 'sick',      label: 'Sick',             color: '#6b7280', bg: '#f3f4f6', text: '#374151' },
  { id: 'holiday',   label: 'Holiday',          color: '#7c3aed', bg: '#ede9fe', text: '#5b21b6' },
]

const START_HOUR = 6
const END_HOUR = 22
const TOTAL_INTERVALS = (END_HOUR - START_HOUR) * 4
const MIN_CELL_WIDTH = 14  // minimum so labels still readable
const ROW_HEIGHT = 44
const LABEL_WIDTH = 150

function intervalToTimeStr(interval) {
  const totalMins = START_HOUR * 60 + interval * 15
  return `${String(Math.floor(totalMins/60)).padStart(2,'0')}:${String(totalMins%60).padStart(2,'0')}`
}

function timeToInterval(timeStr) {
  if (!timeStr) return null
  const [h, m] = timeStr.split(':').map(Number)
  return Math.round(((h * 60 + m) - START_HOUR * 60) / 15)
}

function fmt12(timeStr) {
  if (!timeStr) return '--'
  const [h, m] = timeStr.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${m.toString().padStart(2,'0')} ${ampm}`
}

function addMins(timeStr, mins) {
  const [h, m] = timeStr.split(':').map(Number)
  const t = h * 60 + m + parseInt(mins)
  return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
}

function prevDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() - 1)
  return d.toISOString().split('T')[0]
}

function nextDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() + 1)
  return d.toISOString().split('T')[0]
}

export default function GraphicalSchedule({ profiles, onUpdate }) {
  const { profile, isAdmin } = useAuth()
  const containerRef = useRef(null)
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [schedules, setSchedules] = useState([])
  const [blocks, setBlocks] = useState({})
  const [dragging, setDragging] = useState(null)
  const [currentInterval, setCurrentInterval] = useState(null)
  const [saving, setSaving] = useState(false)
  const [shiftModal, setShiftModal] = useState(null)
  const [shiftForm, setShiftForm] = useState({ shift_start:'08:00', shift_end:'17:00', break1_start:'10:00', break1_duration:15, lunch_start:'12:00', lunch_duration:30, break2_start:'14:30', break2_duration:15, day_type:'work' })
  const [addBlockMenu, setAddBlockMenu] = useState(null)
  const [contextMenu, setContextMenu] = useState(null) // { x, y, profileId, block }
  const [containerWidth, setContainerWidth] = useState(0)
  const [extraBlocks, setExtraBlocks] = useState([]) // outbound/meeting from schedule_blocks table
  const today = new Date().toISOString().split('T')[0]

  // Dynamic cell width — fills available space, minimum 14px
  const CELL_WIDTH = containerWidth > 0
    ? Math.max(MIN_CELL_WIDTH, Math.floor((containerWidth - LABEL_WIDTH) / TOTAL_INTERVALS))
    : MIN_CELL_WIDTH

  // Load schedules + extra blocks for this date
  useEffect(() => {
    Promise.all([
      sb.from('schedules').select('*').eq('date', date),
      sb.from('schedule_blocks').select('*').eq('date', date),
    ]).then(([{ data: scheds }, { data: extras }]) => {
      setSchedules(scheds || [])
      setExtraBlocks(extras || [])
    })
  }, [date])

  // Current time indicator
  useEffect(() => {
    const update = () => {
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      setCurrentInterval((mins - START_HOUR * 60) / 15)
    }
    update()
    const t = setInterval(update, 60000)
    return () => clearInterval(t)
  }, [])

  // Track container width for dynamic cell sizing
  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    obs.observe(containerRef.current)
    setContainerWidth(containerRef.current.offsetWidth)
    return () => obs.disconnect()
  }, [])

  // Build blocks from schedules + extraBlocks
  useEffect(() => {
    const newBlocks = {}
    profiles.forEach(p => {
      const sched = schedules.find(s => s.profile_id === p.id)
      newBlocks[p.id] = []
      if (!sched) {
        // Still load any extra blocks even if no shift set
        const pExtras = extraBlocks.filter(b => b.profile_id === p.id)
        pExtras.forEach(b => newBlocks[p.id].push({ id: b.id, type: b.type, start: b.start_interval, duration: b.duration_intervals, dbId: b.id }))
        return
      }
      if (sched.day_type === 'pto') { newBlocks[p.id] = [{ id:'pto-'+p.id, type:'pto', start:0, duration:TOTAL_INTERVALS }]; return }
      if (sched.day_type === 'sick') { newBlocks[p.id] = [{ id:'sick-'+p.id, type:'sick', start:0, duration:TOTAL_INTERVALS }]; return }
      if (sched.day_type === 'holiday') { newBlocks[p.id] = [{ id:'holiday-'+p.id, type:'holiday', start:0, duration:TOTAL_INTERVALS }]; return }
      if (sched.shift_start && sched.shift_end) {
        const s = timeToInterval(sched.shift_start), e = timeToInterval(sched.shift_end)
        if (s !== null && e > s) newBlocks[p.id].push({ id:'shift-'+p.id, type:'shift', start:s, duration:e-s })
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
      // Extra blocks (outbound, meeting) from schedule_blocks table
      const pExtras = extraBlocks.filter(b => b.profile_id === p.id)
      pExtras.forEach(b => newBlocks[p.id].push({ id: b.id, type: b.type, start: b.start_interval, duration: b.duration_intervals, dbId: b.id }))
    })
    setBlocks(newBlocks)
  }, [schedules, extraBlocks, profiles])

  // FIX: saveBlocksToDb takes profileId + blocksSnapshot — no stale closure issues
  const saveBlocksToDb = useCallback(async (profileId, blocksSnapshot) => {
    setSaving(true)
    const pBlocks = blocksSnapshot[profileId] || []
    const shiftBlock = pBlocks.find(b => b.type === 'shift')
    const breakBlocks = pBlocks.filter(b => b.type === 'break')
    const lunchBlock = pBlocks.find(b => b.type === 'lunch')
    const ptoBlock = pBlocks.find(b => b.type === 'pto')
    const sickBlock = pBlocks.find(b => b.type === 'sick')

    const holidayBlock = pBlocks.find(b => b.type === 'holiday')
    const dayType = ptoBlock ? 'pto' : sickBlock ? 'sick' : holidayBlock ? 'holiday' : 'work'
    const isOff = ptoBlock || sickBlock || holidayBlock

    const payload = {
      profile_id: profileId,
      date,
      day_type: dayType,
      shift_start: (!isOff && shiftBlock) ? intervalToTimeStr(shiftBlock.start) : null,
      shift_end: (!isOff && shiftBlock) ? intervalToTimeStr(shiftBlock.start + shiftBlock.duration) : null,
      break1_start: (!isOff && breakBlocks[0]) ? intervalToTimeStr(breakBlocks[0].start) : null,
      break1_end: (!isOff && breakBlocks[0]) ? intervalToTimeStr(breakBlocks[0].start + breakBlocks[0].duration) : null,
      break1_duration: breakBlocks[0] ? breakBlocks[0].duration * 15 : 15,
      break2_start: (!isOff && breakBlocks[1]) ? intervalToTimeStr(breakBlocks[1].start) : null,
      break2_end: (!isOff && breakBlocks[1]) ? intervalToTimeStr(breakBlocks[1].start + breakBlocks[1].duration) : null,
      break2_duration: breakBlocks[1] ? breakBlocks[1].duration * 15 : 15,
      lunch_start: (!isOff && lunchBlock) ? intervalToTimeStr(lunchBlock.start) : null,
      lunch_end: (!isOff && lunchBlock) ? intervalToTimeStr(lunchBlock.start + lunchBlock.duration) : null,
      lunch_duration: lunchBlock ? lunchBlock.duration * 15 : 30,
      created_by: profile?.id,
    }

    const { error } = await sb.from('schedules').upsert(payload, { onConflict: 'profile_id,date' })
    if (error) {
      console.error('Schedule save error:', error.message, JSON.stringify(payload))
      setSaving(false)
      return
    }
    const { data } = await sb.from('schedules').select('*').eq('date', date)
    setSchedules(data || [])
    if (onUpdate) onUpdate()
    setSaving(false)
  }, [date, profile?.id, onUpdate])

  const handleMouseMove = useCallback((e) => {
    if (!dragging) return
    const deltaX = e.clientX - dragging.startX
    const deltaIntervals = Math.round(deltaX / CELL_WIDTH)
    if (deltaIntervals === 0) return
    setBlocks(prev => {
      const pBlocks = [...(prev[dragging.profileId] || [])]
      const idx = pBlocks.findIndex(b => b.id === dragging.blockId)
      if (idx === -1) return prev
      const block = { ...pBlocks[idx] }
      if (dragging.mode === 'move') block.start = Math.max(0, Math.min(TOTAL_INTERVALS - block.duration, block.start + deltaIntervals))
      if (dragging.mode === 'resize') block.duration = Math.max(1, Math.min(TOTAL_INTERVALS - block.start, block.duration + deltaIntervals))
      pBlocks[idx] = block
      return { ...prev, [dragging.profileId]: pBlocks }
    })
    setDragging(prev => ({ ...prev, startX: prev.startX + deltaIntervals * CELL_WIDTH }))
  }, [dragging])

  const handleMouseUp = useCallback(() => {
    if (!dragging) return
    const { profileId, blockId } = dragging
    setDragging(null)
    setBlocks(prev => {
      const movedBlock = (prev[profileId] || []).find(b => b.id === blockId)
      if (movedBlock?.dbId) {
        // Extra block — update schedule_blocks table
        sb.from('schedule_blocks').update({
          start_interval: movedBlock.start,
          duration_intervals: movedBlock.duration,
        }).eq('id', movedBlock.dbId).then(({ error }) => {
          if (error) console.error('Extra block drag save error:', error.message)
        })
      } else {
        saveBlocksToDb(profileId, prev)
      }
      return prev
    })
  }, [dragging, saveBlocksToDb])

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp) }
  }, [handleMouseMove, handleMouseUp])

  const openShiftModal = (profileId) => {
    const sched = schedules.find(s => s.profile_id === profileId)
    if (sched) {
      setShiftForm({
        shift_start: sched.shift_start || '08:00',
        shift_end: sched.shift_end || '17:00',
        break1_start: sched.break1_start || '10:00',
        break1_duration: sched.break1_duration || 15,
        lunch_start: sched.lunch_start || '12:00',
        lunch_duration: sched.lunch_duration || 30,
        break2_start: sched.break2_start || '14:30',
        break2_duration: sched.break2_duration || 15,
        day_type: sched.day_type || 'work',
      })
    } else {
      setShiftForm({ shift_start:'08:00', shift_end:'17:00', break1_start:'10:00', break1_duration:15, lunch_start:'12:00', lunch_duration:30, break2_start:'14:30', break2_duration:15, day_type:'work' })
    }
    setShiftModal(profileId)
  }

  const saveShiftModal = async () => {
    if (!shiftModal) return
    setSaving(true)
    const isOff = shiftForm.day_type !== 'work'  // covers pto, sick, holiday, off
    const payload = {
      profile_id: shiftModal, date,
      day_type: shiftForm.day_type,
      shift_start: isOff ? null : shiftForm.shift_start,
      shift_end: isOff ? null : shiftForm.shift_end,
      break1_start: isOff ? null : shiftForm.break1_start,
      break1_end: isOff ? null : shiftForm.break1_start ? addMins(shiftForm.break1_start, shiftForm.break1_duration) : null,
      break1_duration: shiftForm.break1_duration,
      break2_start: isOff ? null : shiftForm.break2_start,
      break2_end: isOff ? null : shiftForm.break2_start ? addMins(shiftForm.break2_start, shiftForm.break2_duration) : null,
      break2_duration: shiftForm.break2_duration,
      lunch_start: isOff ? null : shiftForm.lunch_start,
      lunch_end: isOff ? null : shiftForm.lunch_start ? addMins(shiftForm.lunch_start, shiftForm.lunch_duration) : null,
      lunch_duration: shiftForm.lunch_duration,
      created_by: profile?.id,
    }
    const { error } = await sb.from('schedules').upsert(payload, { onConflict: 'profile_id,date' })
    if (error) console.error('Shift modal save error:', error.message)
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

  const addExtraBlock = async (profileId, type) => {
    setAddBlockMenu(null)

    // Shift: open the shift modal
    if (type === 'shift') { openShiftModal(profileId); return }

    const existing = blocks[profileId] || []
    const shiftBlock = existing.find(b => b.type === 'shift')
    const start = shiftBlock ? shiftBlock.start + 4 : 8
    let duration = 2
    if (type === 'outbound') duration = 8
    if (type === 'meeting') duration = 4
    if (type === 'break') duration = 1
    if (type === 'lunch') duration = 2
    if (type === 'pto' || type === 'sick' || type === 'holiday') duration = TOTAL_INTERVALS

    // Outbound and meeting go to schedule_blocks table (not schedules)
    if (type === 'outbound' || type === 'meeting') {
      setSaving(true)
      const { data: inserted, error } = await sb.from('schedule_blocks').insert({
        profile_id: profileId, date, type,
        start_interval: start, duration_intervals: duration,
        created_by: profile?.id,
      }).select().single()
      if (error) { console.error('Extra block save error:', error.message); setSaving(false); return }
      const newBlock = { id: inserted.id, type, start, duration, dbId: inserted.id }
      setBlocks(prev => ({ ...prev, [profileId]: [...(prev[profileId] || []), newBlock] }))
      setExtraBlocks(prev => [...prev, inserted])
      setSaving(false)
      return
    }

    // PTO/Sick/Holiday/Break/Lunch go through schedules table as before
    const newBlock = { id: type + '-' + Date.now(), type, start: (type === 'pto' || type === 'sick' || type === 'holiday') ? 0 : start, duration }
    const base = (type === 'pto' || type === 'sick' || type === 'holiday') ? [] : existing
    const newBlocks = { ...blocks, [profileId]: [...base, newBlock] }
    setBlocks(newBlocks)
    saveBlocksToDb(profileId, newBlocks)
  }

  const removeBlock = async (profileId, blockId) => {
    const block = (blocks[profileId] || []).find(b => b.id === blockId)
    if (block?.dbId) {
      // Extra block from schedule_blocks table — delete by DB id
      await sb.from('schedule_blocks').delete().eq('id', block.dbId)
      setExtraBlocks(prev => prev.filter(b => b.id !== block.dbId))
    }
    const newBlocks = { ...blocks, [profileId]: (blocks[profileId] || []).filter(b => b.id !== blockId) }
    setBlocks(newBlocks)
    if (!block?.dbId) saveBlocksToDb(profileId, newBlocks)
  }

  const getCoverage = (interval) => profiles.filter(p => {
    const pBlocks = blocks[p.id] || []
    const shift = pBlocks.find(b => b.type === 'shift')
    if (!shift) return false
    const inShift = interval >= shift.start && interval < shift.start + shift.duration
    const busy = pBlocks.some(b => ['break','lunch','meeting'].includes(b.type) && interval >= b.start && interval < b.start + b.duration)
    const away = pBlocks.some(b => ['pto','sick'].includes(b.type))
    return inShift && !busy && !away
  }).length


  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

      {/* Date nav */}
      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <button className="btn sm" onClick={() => setDate(prevDate(date))}>Prev</button>
        <span style={{ fontSize:14, fontWeight:600 }}>{formatDate(date)}</span>
        <button className="btn sm" onClick={() => setDate(nextDate(date))}>Next</button>
        {date !== today && <button className="btn sm" onClick={() => setDate(today)}>Today</button>}
        {saving && <span style={{ fontSize:11, color:'var(--text-muted)', marginLeft:8 }}>Saving...</span>}
      </div>

      {/* Legend */}
      <div style={{ display:'flex', gap:12, flexWrap:'wrap', alignItems:'center' }}>
        {BLOCK_TYPES.map(bt => (
          <span key={bt.id} style={{ display:'flex', alignItems:'center', gap:4, fontSize:11 }}>
            <span style={{ width:10, height:10, borderRadius:2, background:bt.color, display:'inline-block' }}></span>
            {bt.label}
          </span>
        ))}
        {isAdmin && <span style={{ fontSize:11, color:'var(--text-muted)', marginLeft:'auto' }}>Click name to set shift | Drag to move | Drag right edge to resize | Right-click to delete</span>}
      </div>

      {/* Grid */}
      <div ref={containerRef} style={{ border:'1px solid var(--border)', borderRadius:'var(--radius)', userSelect:'none', position:'relative', width:'100%' }}>
        <div style={{ width:'100%' }}>

          {/* Time header */}
          <div style={{ display:'flex', height:48, borderBottom:'2px solid var(--border)', background:'var(--surface-2)' }}>
            <div style={{ width:LABEL_WIDTH, flexShrink:0, borderRight:'1px solid var(--border)', display:'flex', alignItems:'center', paddingLeft:12, fontSize:11, fontWeight:600, color:'var(--text-muted)', position:'sticky', left:0, zIndex:10, background:'var(--surface-2)' }}>Agent</div>
            <div style={{ display:'flex', flex:1 }}>
              {Array.from({ length: TOTAL_INTERVALS }, (_, i) => {
                const totalMins = START_HOUR * 60 + i * 15
                const h = Math.floor(totalMins / 60)
                const m = totalMins % 60
                const isHour = m === 0
                const label = isHour ? `${h % 12 || 12}${h >= 12 ? 'PM' : 'AM'}` : `:${m.toString().padStart(2,'0')}`
                return (
                  <div key={i} style={{ width:CELL_WIDTH, flexShrink:0, borderRight: isHour && i > 0 ? '1px solid var(--border)' : '1px solid rgba(0,0,0,.05)', display:'flex', flexDirection:'column', alignItems:'flex-start', justifyContent:'flex-end', paddingBottom:3, paddingLeft:2 }}>
                    <span style={{ fontSize: isHour ? 9 : 8, color: isHour ? 'var(--text-secondary)' : 'var(--text-muted)', whiteSpace:'nowrap', fontWeight: isHour ? 600 : 400 }}>{label}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Coverage row */}
          <div style={{ display:'flex', height:26, borderBottom:'2px solid var(--border)', background:'var(--surface)' }}>
            <div style={{ width:LABEL_WIDTH, flexShrink:0, borderRight:'1px solid var(--border)', display:'flex', alignItems:'center', paddingLeft:12, fontSize:10, fontWeight:600, color:'var(--text-muted)', position:'sticky', left:0, zIndex:10, background:'var(--surface)' }}>Available</div>
            <div style={{ display:'flex', flex:1 }}>
              {Array.from({ length: TOTAL_INTERVALS }, (_, i) => {
                const count = getCoverage(i)
                const color = count >= 3 ? '#22c55e' : count === 2 ? '#f59e0b' : count === 1 ? '#ef4444' : 'transparent'
                return (
                  <div key={i} style={{ width:CELL_WIDTH, flexShrink:0, borderRight: i % 4 === 3 ? '1px solid var(--border)' : '1px solid rgba(0,0,0,.04)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                    {count > 0 && <span style={{ fontSize:9, fontWeight:700, color }}>{count}</span>}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Agent rows */}
          {profiles.map((p, rowIdx) => {
            const pBlocks = blocks[p.id] || []
            const sched = schedules.find(s => s.profile_id === p.id)
            const isPto = pBlocks.some(b => b.type === 'pto')
            const isSick = pBlocks.some(b => b.type === 'sick')

            return (
              <div key={p.id} style={{ display:'flex', height:ROW_HEIGHT, borderBottom:'1px solid var(--border)', background: rowIdx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)' }}>
                {/* Agent label - sticky */}
                <div style={{ width:LABEL_WIDTH, flexShrink:0, borderRight:'1px solid var(--border)', display:'flex', alignItems:'center', gap:6, paddingLeft:8, background: rowIdx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)', position:'sticky', left:0, zIndex:5 }}>
                  <div style={{ width:22, height:22, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 13 : 9, fontWeight:600, flexShrink:0 }}>
                    {p.avatar || (p.name || p.email || '?')[0].toUpperCase()}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div
                      onClick={() => isAdmin && openShiftModal(p.id)}
                      style={{ fontSize:11, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', cursor: isAdmin ? 'pointer' : 'default', color: isAdmin ? 'var(--accent)' : 'var(--text-primary)' }}
                      title={isAdmin ? 'Click to set shift' : ''}
                    >
                      {p.name || p.email}
                    </div>
                    {sched && (
                      <div style={{ fontSize:9, color:'var(--text-muted)' }}>
                        {isPto ? 'PTO' : isSick ? 'Sick' : pBlocks.some(b=>b.type==='holiday') ? 'Holiday' : sched.shift_start ? `${fmt12(sched.shift_start)}-${fmt12(sched.shift_end)}` : 'No shift'}
                      </div>
                    )}
                  </div>
                  {isAdmin && !isPto && !isSick && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        const rect = e.currentTarget.getBoundingClientRect()
                        setAddBlockMenu(addBlockMenu?.profileId === p.id ? null : { profileId: p.id, x: rect.left, y: rect.bottom + 4 })
                      }}
                      style={{ fontSize:16, background:'none', border:'none', cursor:'pointer', color:'var(--accent)', padding:'2px 4px', flexShrink:0, lineHeight:1 }}
                      title="Add block"
                    >+</button>
                  )}
                </div>

                {/* Timeline */}
                <div style={{ position:'relative', flex:1 }}>
                  {/* Grid lines */}
                  {Array.from({ length: TOTAL_INTERVALS }, (_, i) => (
                    <div key={i} style={{ position:'absolute', left: i * CELL_WIDTH, top:0, bottom:0, borderRight: i % 4 === 3 ? '1px solid var(--border)' : '1px solid rgba(0,0,0,.04)', pointerEvents:'none' }} />
                  ))}

                  {/* Current time line */}
                  {currentInterval !== null && currentInterval >= 0 && currentInterval <= TOTAL_INTERVALS && (
                    <div style={{ position:'absolute', left: currentInterval * CELL_WIDTH, top:0, bottom:0, width:2, background:'#ef4444', zIndex:10, pointerEvents:'none' }}>
                      <div style={{ position:'absolute', top:0, left:-3, width:8, height:8, borderRadius:'50%', background:'#ef4444' }} />
                    </div>
                  )}

                  {/* Blocks */}
                  {pBlocks.map(block => {
                    const bt = BLOCK_TYPES.find(t => t.id === block.type) || BLOCK_TYPES[0]
                    const width = block.duration * CELL_WIDTH - 2
                    const left = block.start * CELL_WIDTH + 1
                    const isShift = block.type === 'shift'
                    return (
                      <div
                        key={block.id}
                        onMouseDown={(e) => { if (!isAdmin) return; e.preventDefault(); e.stopPropagation(); setDragging({ profileId: p.id, blockId: block.id, mode:'move', startX: e.clientX }) }}
                        onContextMenu={(e) => {
                          if (!isAdmin) return
                          e.preventDefault()
                          e.stopPropagation()
                          setContextMenu({ x: e.clientX, y: e.clientY, profileId: p.id, block })
                        }}
                        title={isAdmin ? 'Right-click for options' : ''}
                        style={{
                          position:'absolute', left, top: isShift ? 6 : 10, height: isShift ? ROW_HEIGHT - 12 : ROW_HEIGHT - 20, width,
                          background: bt.bg, border:`1.5px solid ${bt.color}`, borderRadius:4,
                          display:'flex', alignItems:'center', overflow:'hidden',
                          cursor: isAdmin ? 'grab' : 'default', zIndex: isShift ? 2 : 4,
                          opacity: isShift ? 0.85 : 1,
                        }}
                      >
                        <span style={{ fontSize:9, fontWeight:700, color: bt.text, paddingLeft:4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>
                          {bt.label}
                        </span>
                        {isAdmin && (
                          <div
                            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setDragging({ profileId: p.id, blockId: block.id, mode:'resize', startX: e.clientX }) }}
                            style={{ width:5, height:'100%', background: bt.color, cursor:'ew-resize', flexShrink:0, opacity:.5 }}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Context menu overlay */}
      {contextMenu && <div style={{ position:'fixed', inset:0, zIndex:299 }} onMouseDown={() => setContextMenu(null)} />}

      {/* Context menu */}
      {contextMenu && (() => {
        const { x, y, profileId, block } = contextMenu
        const isShift = block.type === 'shift'
        const bt = BLOCK_TYPES.find(t => t.id === block.type)
        return (
          <div style={{ position:'fixed', left: x, top: y, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 4px 20px rgba(0,0,0,.18)', zIndex:300, minWidth:200, overflow:'hidden' }}>
            {/* Header */}
            <div style={{ padding:'8px 14px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ width:10, height:10, borderRadius:2, background: bt?.color, flexShrink:0 }}></span>
              <span style={{ fontSize:11, fontWeight:700, color:'var(--text-primary)' }}>{bt?.label || block.type}</span>
            </div>

            {/* Adjust shift / Edit block */}
            <button
              onMouseDown={() => { setContextMenu(null); openShiftModal(profileId) }}
              style={{ display:'flex', alignItems:'center', gap:10, width:'100%', padding:'10px 14px', background:'transparent', border:'none', cursor:'pointer', fontSize:12, color:'var(--text-primary)', textAlign:'left' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ fontSize:14 }}>✏️</span>
              {isShift ? 'Adjust shift times' : 'Edit block'}
            </button>

            {/* Add event (only shown on shift right-click) */}
            {isShift && (
              <button
                onMouseDown={() => {
                  setContextMenu(null)
                  const rect = document.getElementById('add-btn-' + profileId)?.getBoundingClientRect()
                  setAddBlockMenu({ profileId, x: x, y: y + 10 })
                }}
                style={{ display:'flex', alignItems:'center', gap:10, width:'100%', padding:'10px 14px', background:'transparent', border:'none', cursor:'pointer', fontSize:12, color:'var(--text-primary)', textAlign:'left' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <span style={{ fontSize:14 }}>➕</span>
                Add event
              </button>
            )}

            {/* Divider */}
            <div style={{ borderTop:'1px solid var(--border)', margin:'2px 0' }} />

            {/* Delete */}
            <button
              onMouseDown={() => {
                setContextMenu(null)
                if (isShift) {
                  if (confirm('Delete shift for this day?')) deleteSchedule(profileId)
                } else {
                  removeBlock(profileId, block.id)
                }
              }}
              style={{ display:'flex', alignItems:'center', gap:10, width:'100%', padding:'10px 14px', background:'transparent', border:'none', cursor:'pointer', fontSize:12, color:'#ef4444', textAlign:'left' }}
              onMouseEnter={e => e.currentTarget.style.background = '#fee2e2'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ fontSize:14 }}>🗑️</span>
              {isShift ? 'Delete shift' : `Remove ${bt?.label || 'block'}`}
            </button>
          </div>
        )
      })()}

      {/* Click outside add block menu */}
      {addBlockMenu && <div style={{ position:'fixed', inset:0, zIndex:199 }} onMouseDown={() => setAddBlockMenu(null)} />}

      {/* Add block dropdown */}
      {addBlockMenu && (
        <div style={{ position:'fixed', left: addBlockMenu.x, top: addBlockMenu.y, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 4px 16px rgba(0,0,0,.2)', zIndex:300, minWidth:180, overflow:'hidden' }}>
          <div style={{ padding:'6px 14px', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', borderBottom:'1px solid var(--border)' }}>Add Block</div>
          {['shift','break','lunch','outbound','meeting','pto','sick','holiday'].map(type => {
            const bt = BLOCK_TYPES.find(b => b.id === type)
            const label = type === 'shift' ? 'Set Shift...' : bt.label
            return (
              <button key={type}
                onMouseDown={(e) => { e.stopPropagation(); addExtraBlock(addBlockMenu.profileId, type) }}
                style={{ display:'flex', alignItems:'center', gap:8, width:'100%', padding:'9px 14px', background:'transparent', border:'none', cursor:'pointer', fontSize:12, color:'var(--text-primary)', textAlign:'left' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <span style={{ width:10, height:10, borderRadius:2, background:bt.color, flexShrink:0 }}></span>
                {label}
              </button>
            )
          })}
          <button onMouseDown={() => setAddBlockMenu(null)}
            style={{ display:'block', width:'100%', padding:'7px 14px', background:'transparent', border:'none', borderTop:'1px solid var(--border)', cursor:'pointer', fontSize:11, color:'var(--text-muted)', textAlign:'left' }}>
            Cancel
          </button>
        </div>
      )}

      {/* Shift modal */}
      {shiftModal && (
        <Modal
          title={`Set Schedule - ${profiles.find(p => p.id === shiftModal)?.name || 'Agent'} - ${formatDate(date)}`}
          onClose={() => setShiftModal(null)}
          width={460}
        >
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div className="form-field">
              <label className="form-label">Day type</label>
              <select className="form-input" value={shiftForm.day_type} onChange={e => setShiftForm(p => ({ ...p, day_type: e.target.value }))}>
                <option value="work">Working</option>
                <option value="pto">PTO - Full Day</option>
                <option value="sick">Sick - Full Day</option>
                <option value="holiday">Holiday</option>
                <option value="off">Off</option>
              </select>
            </div>

            {shiftForm.day_type === 'work' && (
              <>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div className="form-field"><label className="form-label">Shift start</label><input type="time" className="form-input" value={shiftForm.shift_start} onChange={e => setShiftForm(p => ({ ...p, shift_start: e.target.value }))} /></div>
                  <div className="form-field"><label className="form-label">Shift end</label><input type="time" className="form-input" value={shiftForm.shift_end} onChange={e => setShiftForm(p => ({ ...p, shift_end: e.target.value }))} /></div>
                </div>
                <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)' }}>Break 1</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div className="form-field"><label className="form-label">Start time</label><input type="time" className="form-input" value={shiftForm.break1_start} onChange={e => setShiftForm(p => ({ ...p, break1_start: e.target.value }))} /></div>
                  <div className="form-field"><label className="form-label">Duration (min)</label><input type="number" className="form-input" value={shiftForm.break1_duration} min={5} max={30} onChange={e => setShiftForm(p => ({ ...p, break1_duration: parseInt(e.target.value) }))} /></div>
                </div>
                <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)' }}>Lunch</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div className="form-field"><label className="form-label">Start time</label><input type="time" className="form-input" value={shiftForm.lunch_start} onChange={e => setShiftForm(p => ({ ...p, lunch_start: e.target.value }))} /></div>
                  <div className="form-field"><label className="form-label">Duration</label><select className="form-input" value={shiftForm.lunch_duration} onChange={e => setShiftForm(p => ({ ...p, lunch_duration: parseInt(e.target.value) }))}><option value={30}>30 min</option><option value={60}>60 min</option></select></div>
                </div>
                <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)' }}>Break 2</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div className="form-field"><label className="form-label">Start time</label><input type="time" className="form-input" value={shiftForm.break2_start} onChange={e => setShiftForm(p => ({ ...p, break2_start: e.target.value }))} /></div>
                  <div className="form-field"><label className="form-label">Duration (min)</label><input type="number" className="form-input" value={shiftForm.break2_duration} min={5} max={30} onChange={e => setShiftForm(p => ({ ...p, break2_duration: parseInt(e.target.value) }))} /></div>
                </div>
              </>
            )}
          </div>
          <div className="modal-actions">
            {schedules.find(s => s.profile_id === shiftModal) && (
              <button className="btn danger" onClick={() => deleteSchedule(shiftModal)}>Clear day</button>
            )}
            <button className="btn" onClick={() => setShiftModal(null)}>Cancel</button>
            <button className="btn primary" onClick={saveShiftModal} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
