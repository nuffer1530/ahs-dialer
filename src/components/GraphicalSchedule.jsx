import { useState, useRef, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'

const BLOCK_TYPES = [
  { id: 'shift',      label: 'On Shift',        color: '#3b82f6', bg: '#dbeafe', text: '#1d4ed8' },
  { id: 'break',      label: 'Break',            color: '#f97316', bg: '#ffedd5', text: '#c2410c' },
  { id: 'lunch',      label: 'Lunch',            color: '#22c55e', bg: '#dcfce7', text: '#15803d' },
  { id: 'outbound',   label: 'Outbounding',      color: '#a855f7', bg: '#f3e8ff', text: '#7e22ce' },
  { id: 'meeting',    label: 'Meeting/Training', color: '#ef4444', bg: '#fee2e2', text: '#b91c1c' },
  { id: 'pto',        label: 'PTO',              color: '#eab308', bg: '#fef9c3', text: '#a16207' },
  { id: 'sick',       label: 'Sick',             color: '#6b7280', bg: '#f3f4f6', text: '#374151' },
]

const START_HOUR = 6   // 6am
const END_HOUR = 22    // 10pm
const TOTAL_INTERVALS = (END_HOUR - START_HOUR) * 4  // 15 min intervals = 64
const CELL_WIDTH = 32  // px per 15 min
const ROW_HEIGHT = 40
const LABEL_WIDTH = 140
const HEADER_HEIGHT = 56

function intervalToTime(interval) {
  const totalMins = START_HOUR * 60 + interval * 15
  const h = Math.floor(totalMins / 60)
  const m = totalMins % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${ampm}`
}

function timeToInterval(timeStr) {
  if (!timeStr) return null
  const [h, m] = timeStr.split(':').map(Number)
  return Math.round(((h * 60 + m) - START_HOUR * 60) / 15)
}

function durationToIntervals(minutes) {
  return Math.round(minutes / 15)
}

export default function GraphicalSchedule({ profiles, schedules, date, onUpdate }) {
  const { profile, isAdmin } = useAuth()
  const containerRef = useRef(null)
  const [blocks, setBlocks] = useState({}) // { profileId: [{ id, type, start, duration }] }
  const [dragging, setDragging] = useState(null) // { profileId, blockId, offsetX, mode: 'move'|'resize' }
  const [addMenu, setAddMenu] = useState(null) // { profileId, interval, x, y }
  const [currentInterval, setCurrentInterval] = useState(null)
  const [saving, setSaving] = useState(false)

  // Calculate current time interval
  useEffect(() => {
    const update = () => {
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const interval = (mins - START_HOUR * 60) / 15
      setCurrentInterval(interval)
    }
    update()
    const t = setInterval(update, 60000)
    return () => clearInterval(t)
  }, [])

  // Build blocks from schedules
  useEffect(() => {
    const newBlocks = {}
    profiles.forEach(p => {
      const sched = schedules.find(s => s.profile_id === p.id && s.date === date)
      newBlocks[p.id] = []
      if (sched) {
        if (sched.shift_start && sched.shift_end) {
          const start = timeToInterval(sched.shift_start)
          const end = timeToInterval(sched.shift_end)
          if (start !== null && end !== null && end > start) {
            newBlocks[p.id].push({ id: 'shift-' + p.id, type: 'shift', start, duration: end - start, fromSchedule: true })
          }
        }
        if (sched.break1_start) {
          const start = timeToInterval(sched.break1_start)
          if (start !== null) newBlocks[p.id].push({ id: 'b1-' + p.id, type: 'break', start, duration: durationToIntervals(sched.break1_duration || 15), fromSchedule: true })
        }
        if (sched.lunch_start) {
          const start = timeToInterval(sched.lunch_start)
          if (start !== null) newBlocks[p.id].push({ id: 'lunch-' + p.id, type: 'lunch', start, duration: durationToIntervals(sched.lunch_duration || 30), fromSchedule: true })
        }
        if (sched.break2_start) {
          const start = timeToInterval(sched.break2_start)
          if (start !== null) newBlocks[p.id].push({ id: 'b2-' + p.id, type: 'break', start, duration: durationToIntervals(sched.break2_duration || 15), fromSchedule: true })
        }
        // PTO/Sick full day
        if (sched.day_type === 'pto') newBlocks[p.id] = [{ id: 'pto-' + p.id, type: 'pto', start: 0, duration: TOTAL_INTERVALS, fromSchedule: true }]
        if (sched.day_type === 'sick') newBlocks[p.id] = [{ id: 'sick-' + p.id, type: 'sick', start: 0, duration: TOTAL_INTERVALS, fromSchedule: true }]
      }
    })
    setBlocks(newBlocks)
  }, [profiles, schedules, date])

  // Coverage row: count agents available per interval
  const getCoverage = (interval) => {
    return profiles.filter(p => {
      const pBlocks = blocks[p.id] || []
      const shiftBlock = pBlocks.find(b => b.type === 'shift')
      if (!shiftBlock) return false
      const inShift = interval >= shiftBlock.start && interval < shiftBlock.start + shiftBlock.duration
      const onBreak = pBlocks.some(b => (b.type === 'break' || b.type === 'lunch' || b.type === 'meeting') && interval >= b.start && interval < b.start + b.duration)
      const pto = pBlocks.some(b => (b.type === 'pto' || b.type === 'sick') && interval >= b.start && interval < b.start + b.duration)
      return inShift && !onBreak && !pto
    }).length
  }

  const handleMouseDown = (e, profileId, blockId, mode) => {
    if (!isAdmin) return
    e.preventDefault()
    e.stopPropagation()
    const containerRect = containerRef.current.getBoundingClientRect()
    setDragging({ profileId, blockId, mode, startX: e.clientX, containerLeft: containerRect.left + LABEL_WIDTH })
  }

  const saveBlocks = async (profileId, currentBlocks) => {
    setSaving(true)
    const pBlocks = currentBlocks[profileId] || []
    const shiftBlock = pBlocks.find(b => b.type === 'shift')
    const breakBlocks = pBlocks.filter(b => b.type === 'break')
    const lunchBlock = pBlocks.find(b => b.type === 'lunch')
    const ptoBlock = pBlocks.find(b => b.type === 'pto')
    const sickBlock = pBlocks.find(b => b.type === 'sick')

    function intervalToTimeStr(interval) {
      const totalMins = START_HOUR * 60 + interval * 15
      return `${String(Math.floor(totalMins/60)).padStart(2,'0')}:${String(totalMins%60).padStart(2,'0')}`
    }

    const payload = {
      profile_id: profileId,
      date,
      day_type: ptoBlock ? 'pto' : sickBlock ? 'sick' : 'work',
      shift_start: shiftBlock ? intervalToTimeStr(shiftBlock.start) : null,
      shift_end: shiftBlock ? intervalToTimeStr(shiftBlock.start + shiftBlock.duration) : null,
      break1_start: breakBlocks[0] ? intervalToTimeStr(breakBlocks[0].start) : null,
      break1_end: breakBlocks[0] ? intervalToTimeStr(breakBlocks[0].start + breakBlocks[0].duration) : null,
      break1_duration: breakBlocks[0] ? breakBlocks[0].duration * 15 : 15,
      break2_start: breakBlocks[1] ? intervalToTimeStr(breakBlocks[1].start) : null,
      break2_end: breakBlocks[1] ? intervalToTimeStr(breakBlocks[1].start + breakBlocks[1].duration) : null,
      break2_duration: breakBlocks[1] ? breakBlocks[1].duration * 15 : 15,
      lunch_start: lunchBlock ? intervalToTimeStr(lunchBlock.start) : null,
      lunch_end: lunchBlock ? intervalToTimeStr(lunchBlock.start + lunchBlock.duration) : null,
      lunch_duration: lunchBlock ? lunchBlock.duration * 15 : 30,
      created_by: profile.id,
    }
    await sb.from('schedules').upsert(payload, { onConflict: 'profile_id,date' })
    if (onUpdate) onUpdate()
    setSaving(false)
  }

  const handleMouseMove = useCallback((e) => {
    if (!dragging) return
    const { profileId, blockId, mode, startX, containerLeft } = dragging
    const deltaX = e.clientX - startX
    const deltaIntervals = Math.round(deltaX / CELL_WIDTH)
    if (deltaIntervals === 0) return

    setBlocks(prev => {
      const pBlocks = [...(prev[profileId] || [])]
      const blockIdx = pBlocks.findIndex(b => b.id === blockId)
      if (blockIdx === -1) return prev
      const block = { ...pBlocks[blockIdx] }

      if (mode === 'move') {
        block.start = Math.max(0, Math.min(TOTAL_INTERVALS - block.duration, block.start + deltaIntervals))
      } else if (mode === 'resize') {
        block.duration = Math.max(1, Math.min(TOTAL_INTERVALS - block.start, block.duration + deltaIntervals))
      }
      pBlocks[blockIdx] = block
      return { ...prev, [profileId]: pBlocks }
    })
    setDragging(prev => ({ ...prev, startX: e.clientX }))
  }, [dragging])

  const handleMouseUp = useCallback(async () => {
    if (!dragging) return
    const { profileId, blockId } = dragging
    setDragging(null)
    // Save changes back to schedule
    await saveBlocks(profileId, blocks)
  }, [dragging, blocks])

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  const addBlock = async (profileId, interval, type) => {
    setAddMenu(null)
    const blockType = BLOCK_TYPES.find(b => b.id === type)
    if (!blockType) return

    let duration = 2 // 30 min default
    if (type === 'shift') duration = 32 // 8 hours
    if (type === 'lunch') duration = 2
    if (type === 'break') duration = 1
    if (type === 'pto' || type === 'sick') duration = TOTAL_INTERVALS

    const newBlock = {
      id: type + '-' + Date.now(),
      type,
      start: type === 'pto' || type === 'sick' ? 0 : interval,
      duration,
      fromSchedule: false,
    }

    const newBlocks = {
      ...blocks,
      [profileId]: [...(blocks[profileId] || []).filter(b => {
        if ((type === 'pto' || type === 'sick')) return false
        return true
      }), newBlock]
    }
    setBlocks(newBlocks)
    await saveBlocks(profileId, newBlocks)
  }

  const removeBlock = async (profileId, blockId) => {
    const newBlocks = {
      ...blocks,
      [profileId]: (blocks[profileId] || []).filter(b => b.id !== blockId)
    }
    setBlocks(newBlocks)
    await saveBlocks(profileId, newBlocks)
  }

  const handleRowClick = (e, profileId) => {
    if (!isAdmin) return
    if (dragging) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const interval = Math.floor(x / CELL_WIDTH)
    if (interval < 0 || interval >= TOTAL_INTERVALS) return
    setAddMenu({ profileId, interval, x: e.clientX, y: e.clientY })
  }

  const totalWidth = LABEL_WIDTH + TOTAL_INTERVALS * CELL_WIDTH

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      {/* Legend */}
      <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'center' }}>
        {BLOCK_TYPES.map(bt => (
          <span key={bt.id} style={{ display:'flex', alignItems:'center', gap:4, fontSize:11 }}>
            <span style={{ width:12, height:12, borderRadius:3, background:bt.color, display:'inline-block' }}></span>
            {bt.label}
          </span>
        ))}
        {saving && <span style={{ fontSize:11, color:'var(--text-muted)', marginLeft:'auto' }}>Saving...</span>}
        {isAdmin && <span style={{ fontSize:11, color:'var(--text-muted)', marginLeft: saving ? 8 : 'auto' }}>Click row to add block | Drag to move | Drag right edge to resize</span>}
      </div>

      {/* Grid */}
      <div ref={containerRef} style={{ overflowX:'auto', border:'1px solid var(--border)', borderRadius:'var(--radius)', userSelect:'none' }}>
        <div style={{ width: totalWidth, position:'relative' }}>

          {/* Header row - time labels */}
          <div style={{ display:'flex', height:HEADER_HEIGHT, borderBottom:'1px solid var(--border)', background:'var(--surface-2)' }}>
            <div style={{ width:LABEL_WIDTH, flexShrink:0, display:'flex', alignItems:'center', paddingLeft:12, fontSize:11, fontWeight:600, color:'var(--text-muted)', borderRight:'1px solid var(--border)' }}>
              Agent
            </div>
            <div style={{ display:'flex', flex:1, position:'relative' }}>
              {Array.from({ length: TOTAL_INTERVALS }, (_, i) => {
                const showLabel = i % 4 === 0 // every hour
                const totalMins = START_HOUR * 60 + i * 15
                const h = Math.floor(totalMins / 60)
                const ampm = h >= 12 ? 'PM' : 'AM'
                const label = `${h % 12 || 12}${ampm}`
                return (
                  <div key={i} style={{ width:CELL_WIDTH, flexShrink:0, borderRight: i % 4 === 3 ? '1px solid var(--border)' : '1px solid rgba(0,0,0,.06)', display:'flex', flexDirection:'column', justifyContent:'flex-end', paddingBottom:4 }}>
                    {showLabel && <span style={{ fontSize:9, color:'var(--text-muted)', paddingLeft:2, whiteSpace:'nowrap' }}>{label}</span>}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Coverage row */}
          <div style={{ display:'flex', height:28, borderBottom:'2px solid var(--border)', background:'var(--surface)' }}>
            <div style={{ width:LABEL_WIDTH, flexShrink:0, display:'flex', alignItems:'center', paddingLeft:12, fontSize:10, fontWeight:600, color:'var(--text-muted)', borderRight:'1px solid var(--border)' }}>
              Available
            </div>
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
            const isPto = pBlocks.some(b => b.type === 'pto')
            const isSick = pBlocks.some(b => b.type === 'sick')

            return (
              <div key={p.id} style={{ display:'flex', height:ROW_HEIGHT, borderBottom:'1px solid var(--border)', background: rowIdx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)', position:'relative' }}>
                {/* Agent label */}
                <div style={{ width:LABEL_WIDTH, flexShrink:0, display:'flex', alignItems:'center', gap:6, paddingLeft:10, borderRight:'1px solid var(--border)', zIndex:2, background: rowIdx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)' }}>
                  <div style={{ width:22, height:22, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 13 : 9, fontWeight:600, flexShrink:0 }}>
                    {p.avatar || (p.name || p.email || '?')[0].toUpperCase()}
                  </div>
                  <span style={{ fontSize:11, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.name || p.email}</span>
                </div>

                {/* Timeline area */}
                <div
                  style={{ position:'relative', flex:1, cursor: isAdmin ? 'crosshair' : 'default' }}
                  onClick={(e) => handleRowClick(e, p.id)}
                >
                  {/* Hour grid lines */}
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
                    return (
                      <div
                        key={block.id}
                        onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, p.id, block.id, 'move') }}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          position:'absolute', left, top:4, height:ROW_HEIGHT - 8, width,
                          background: bt.bg, border:`1px solid ${bt.color}`,
                          borderRadius:4, display:'flex', alignItems:'center', overflow:'hidden',
                          cursor: isAdmin ? 'grab' : 'default', zIndex:5,
                        }}
                      >
                        <span style={{ fontSize:9, fontWeight:600, color: bt.text, paddingLeft:4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>
                          {bt.label}
                        </span>
                        {isAdmin && (
                          <>
                            <button
                              onMouseDown={(e) => { e.stopPropagation(); removeBlock(p.id, block.id) }}
                              style={{ fontSize:10, color: bt.text, background:'none', border:'none', cursor:'pointer', padding:'0 3px', flexShrink:0, lineHeight:1 }}
                            >x</button>
                            <div
                              onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, p.id, block.id, 'resize') }}
                              style={{ width:6, height:'100%', background: bt.color, cursor:'ew-resize', flexShrink:0, opacity:.6 }}
                            />
                          </>
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

      {/* Add block menu */}
      {addMenu && (
        <div
          style={{ position:'fixed', left: addMenu.x, top: addMenu.y, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 4px 16px rgba(0,0,0,.15)', zIndex:1000, overflow:'hidden', minWidth:160 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ padding:'8px 12px', fontSize:11, fontWeight:600, color:'var(--text-muted)', borderBottom:'1px solid var(--border)' }}>
            Add block at {intervalToTime(addMenu.interval)}
          </div>
          {BLOCK_TYPES.map(bt => (
            <button
              key={bt.id}
              onClick={() => addBlock(addMenu.profileId, addMenu.interval, bt.id)}
              style={{ display:'flex', alignItems:'center', gap:8, width:'100%', padding:'8px 12px', background:'transparent', border:'none', cursor:'pointer', fontSize:12, color:'var(--text-primary)', textAlign:'left' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ width:10, height:10, borderRadius:2, background:bt.color, flexShrink:0 }}></span>
              {bt.label}
            </button>
          ))}
          <button
            onClick={() => setAddMenu(null)}
            style={{ display:'block', width:'100%', padding:'8px 12px', background:'transparent', border:'none', borderTop:'1px solid var(--border)', cursor:'pointer', fontSize:11, color:'var(--text-muted)', textAlign:'left' }}
          >Cancel</button>
        </div>
      )}

      {/* Click outside to close menu */}
      {addMenu && <div style={{ position:'fixed', inset:0, zIndex:999 }} onClick={() => setAddMenu(null)} />}
    </div>
  )
}
