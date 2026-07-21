import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { ATTENDANCE_DEFAULTS, invalidateOpsConfig, loadOpsConfig } from '../lib/opsConfig'
import Modal from '../components/Modal'
import GraphicalSchedule from '../components/GraphicalSchedule'
import Avatar from '../components/Avatar'

const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
const GRACE = 5

function fmt(time) {
  if (!time) return '--'
  const [h, m] = time.split(':')
  const hour = parseInt(h)
  return `${hour % 12 || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`
}

function fmtDuration(seconds) {
  if (!seconds && seconds !== 0) return '--'
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m/60)}h ${m%60}m`
}

function fmtTime(iso) {
  if (!iso) return '--'
  return new Date(iso).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true })
}

function fmtDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })
}

// A rep is "adherent" while actually working the phones. Matches the graphical
// schedule's definition so the two views agree.
const ADHERENT_STATUSES = ['Available', 'On Call', 'Wrap Up']

const minsOfDay = (iso) => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes() }

// Adherence = the share of the scheduled shift the rep actually spent in a
// working state, within the scheduled window.
//
// The old version did (scheduled − flagged-bad time) / scheduled, so an absence
// — with no bad time to subtract — scored 100%, exactly backwards. It also
// relied on a stored `adherent` flag that isn't reliably populated. This counts
// worked time from the status itself, so a no-show is 0% and a late login only
// earns credit from the moment they actually came on.
function adherencePct(sched, dayEvents) {
  if (!sched || !sched.shift_start || !sched.shift_end) return null
  const [sh, sm] = sched.shift_start.split(':').map(Number)
  const [eh, em] = sched.shift_end.split(':').map(Number)
  const winStart = sh * 60 + sm
  const winEnd = eh * 60 + em
  if (winEnd <= winStart) return null

  let adherentMins = 0
  for (const ev of dayEvents || []) {
    if (!ev.started_at || !ADHERENT_STATUSES.includes(ev.status)) continue
    const start = minsOfDay(ev.started_at)
    // Still open (no ended_at) → assume it ran to shift end, not forever.
    let end = ev.ended_at ? minsOfDay(ev.ended_at) : winEnd
    if (end < start) end = winEnd   // crossed midnight; clamp to the shift
    const s = Math.max(start, winStart)
    const e = Math.min(end, winEnd)
    if (e > s) adherentMins += e - s
  }
  return Math.max(0, Math.min(100, Math.round((adherentMins / (winEnd - winStart)) * 100)))
}

function toYMD(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
}

function getWeekDates(baseDate) {
  const d = new Date(baseDate + 'T12:00:00')
  const dow = d.getDay()
  const monday = new Date(d)
  monday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday)
    day.setDate(monday.getDate() + i)
    return toYMD(day)
  })
}

const DAY_TYPE_COLORS = {
  work: null,
  pto: '#3b82f6',
  sick: '#f59e0b',
  holiday: '#8b5cf6',
  off: '#6b7280',
}

const DAY_TYPE_LABELS = {
  work: 'Work',
  pto: 'PTO',
  sick: 'Sick',
  holiday: 'Holiday',
  off: 'Off',
}

const POINT_REASONS = [
  { value: 'late', label: 'Late arrival', points: 0.5 },
  { value: 'absence', label: 'Unexcused absence', points: 1.0 },
  { value: 'early_departure', label: 'Early departure', points: 0.5 },
  { value: 'no_call', label: 'No call / no show', points: 1.0 },
  { value: 'manual', label: 'Manual entry', points: 0 },
]

export default function AttendancePage() {
  const { profile, isAdmin } = useAuth()
  // Admin-tunable WFM numbers (Settings live in app_settings.attendance_config)
  const [attCfg, setAttCfg] = useState(ATTENDANCE_DEFAULTS)
  const [wfmCfg, setWfmCfg] = useState(null)     // edit buffer for the admin card
  const [wfmMsg, setWfmMsg] = useState('')
  useEffect(() => {
    loadOpsConfig().then(c => {
      setAttCfg(c.attendance)
      setWfmCfg({ ...c.attendance, points: { ...c.attendance.points } })
    })
  }, [])
  const saveWfmCfg = async () => {
    try {
      await sb.from('app_settings').upsert({ key: 'attendance_config', value: JSON.stringify(wfmCfg) }, { onConflict: 'key' })
      invalidateOpsConfig(); await loadOpsConfig(true)
      setAttCfg(wfmCfg)
      setWfmMsg('Saved'); setTimeout(() => setWfmMsg(''), 3000)
    } catch (e) { setWfmMsg('Error: ' + e.message) }
  }

  const getTodayMonday = () => {
    const now = new Date()
    const dow = now.getDay()
    const monday = new Date(now)
    monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1))
    return toYMD(monday)
  }

  const [tab, setTab] = useState('schedule')
  const [hoveredTab, setHoveredTab] = useState(null)
  const [profiles, setProfiles] = useState([])
  const [schedules, setSchedules] = useState([])
  const [statusEvents, setStatusEvents] = useState([])
  const [templates, setTemplates] = useState([])
  const [attendancePoints, setAttendancePoints] = useState([])
  const [loading, setLoading] = useState(true)
  const [weekBase, setWeekBase] = useState(() => getTodayMonday())

  useEffect(() => {
    if (tab !== 'schedule') return
    // Jump the week grid to today's week whenever returning to schedule tab
    setWeekBase(getTodayMonday())
    const from = new Date(); from.setDate(from.getDate() - 30)
    const to = new Date(); to.setDate(to.getDate() + 30)
    sb.from('schedules').select('*')
      .gte('date', from.toISOString().split('T')[0])
      .lte('date', to.toISOString().split('T')[0])
      .then(({ data }) => setSchedules(data || []))
  }, [tab])

  const [editCell, setEditCell] = useState(null)
  const [editData, setEditData] = useState({})
  const [saving, setSaving] = useState(false)
  const [bulkModal, setBulkModal] = useState(false)
  const [bulkData, setBulkData] = useState({ profileIds: [], templateId: '', dates: [] })
  const [templateModal, setTemplateModal] = useState(false)
  const [editTemplate, setEditTemplate] = useState(null)
  const [publishModal, setPublishModal] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState(null)
  const [pointModal, setPointModal] = useState(null)
  const [pointData, setPointData] = useState({ reason: 'late', points: 0.5, notes: '', date: new Date().toISOString().split('T')[0] })
  const [reportRange, setReportRange] = useState({ start: '', end: '' })
  const [reportData, setReportData] = useState(null)
  const [copyModal, setCopyModal] = useState(false)

  const weekDates = getWeekDates(weekBase)
  const today = new Date().toISOString().split('T')[0]

  useEffect(() => {
    const load = async () => {
      const [{ data: p }, { data: s }, { data: ev }, { data: t }, { data: ap }] = await Promise.all([
        sb.from('profiles').select('id, name, email, avatar').eq('active', true).order('name'),
        sb.from('schedules').select('*').gte('date', (() => { const d = new Date(); d.setDate(d.getDate()-30); return d.toISOString().split('T')[0] })()).lte('date', (() => { const d = new Date(); d.setDate(d.getDate()+30); return d.toISOString().split('T')[0] })()),
        sb.from('status_events').select('*').gte('started_at', weekDates[0] + 'T00:00:00').lte('started_at', weekDates[6] + 'T23:59:59'),
        sb.from('shift_templates').select('*').order('name'),
        sb.from('attendance_points').select('*').gte('date', new Date().getFullYear() + '-01-01').order('date', { ascending: false }),
      ])
      setProfiles(p || []); setSchedules(s || []); setStatusEvents(ev || [])
      setTemplates(t || []); setAttendancePoints(ap || []); setLoading(false)
    }
    load()
  }, [weekBase])

  const getSchedule = (profileId, date) => schedules.find(s => s.profile_id === profileId && s.date === date)
  const getEvents = (profileId, date) => statusEvents.filter(e => e.profile_id === profileId && e.started_at.startsWith(date)).sort((a, b) => new Date(a.started_at) - new Date(b.started_at))

  const openEdit = (profileId, date) => {
    const existing = getSchedule(profileId, date)
    setEditData(existing ? {
      day_type: existing.day_type || 'work',
      shift_start: existing.shift_start || '08:00', shift_end: existing.shift_end || '17:00',
      break1_start: existing.break1_start || '', break1_duration: existing.break1_duration || 15,
      break2_start: existing.break2_start || '', break2_duration: existing.break2_duration || 15,
      lunch_start: existing.lunch_start || '', lunch_duration: existing.lunch_duration || 30,
      template_color: existing.template_color || null,
    } : {
      day_type: 'work', shift_start: '08:00', shift_end: '17:00',
      break1_start: '10:00', break1_duration: 15,
      break2_start: '14:30', break2_duration: 15,
      lunch_start: '12:00', lunch_duration: 30,
    })
    setEditCell({ profileId, date })
  }

  const applyTemplate = (templateId) => {
    const t = templates.find(t => t.id === templateId)
    if (!t) return
    setEditData({
      shift_start: t.shift_start || '08:00', shift_end: t.shift_end || '17:00',
      break1_start: t.break1_start || '', break1_duration: t.break1_duration || 15,
      break2_start: t.break2_start || '', break2_duration: t.break2_duration || 15,
      lunch_start: t.lunch_start || '', lunch_duration: t.lunch_duration || 30,
      template_color: t.color || null,
    })
  }

  const saveSchedule = async () => {
    if (!editCell) return
    setSaving(true)
    const { profileId, date } = editCell
    const isOff = ['pto','sick','holiday','off'].includes(editData.day_type)
    const payload = {
      profile_id: profileId, date, day_type: editData.day_type || 'work',
      shift_start: isOff ? null : editData.shift_start,
      shift_end: isOff ? null : editData.shift_end,
      break1_start: isOff ? null : editData.break1_start || null,
      break1_duration: isOff ? null : editData.break1_duration || null,
      break2_start: isOff ? null : editData.break2_start || null,
      break2_duration: isOff ? null : editData.break2_duration || null,
      lunch_start: isOff ? null : editData.lunch_start || null,
      lunch_duration: isOff ? null : editData.lunch_duration || null,
      template_color: editData.template_color || null,
    }
    const existing = getSchedule(profileId, date)
    let result
    if (existing) {
      const { data } = await sb.from('schedules').update(payload).eq('id', existing.id).select().single()
      result = data
    } else {
      const { data } = await sb.from('schedules').insert(payload).select().single()
      result = data
    }
    if (result) setSchedules(prev => existing ? prev.map(s => s.id === existing.id ? result : s) : [...prev, result])
    // Also refresh wide window so Graphical tab stays in sync
    const from = new Date(); from.setDate(from.getDate() - 30)
    const to = new Date(); to.setDate(to.getDate() + 30)
    sb.from('schedules').select('*').gte('date', from.toISOString().split('T')[0]).lte('date', to.toISOString().split('T')[0]).then(({ data }) => setSchedules(data || []))
    setSaving(false); setEditCell(null)
  }

  const deleteSchedule = async (profileId, date) => {
    const existing = getSchedule(profileId, date)
    if (!existing) return
    await sb.from('schedules').delete().eq('id', existing.id)
    setSchedules(prev => prev.filter(s => s.id !== existing.id))
    setEditCell(null)
  }

  const addPoint = async () => {
    if (!pointModal) return
    setSaving(true)
    const payload = {
      profile_id: pointModal.id, date: pointData.date,
      points: parseFloat(pointData.points), reason: pointData.reason,
      notes: pointData.notes, auto_generated: false, created_by: profile.id,
    }
    const { data } = await sb.from('attendance_points').insert(payload).select().single()
    if (data) setAttendancePoints(prev => [data, ...prev])
    setSaving(false); setPointModal(null)
    setPointData({ reason: 'late', points: 0.5, notes: '', date: today })
  }

  const deletePoint = async (id) => {
    if (!confirm('Delete this point entry?')) return
    await sb.from('attendance_points').delete().eq('id', id)
    setAttendancePoints(prev => prev.filter(p => p.id !== id))
  }

  const runReport = async () => {
    if (!reportRange.start || !reportRange.end) return
    const [{ data: scheds }, { data: events }, { data: points }] = await Promise.all([
      sb.from('schedules').select('*').gte('date', reportRange.start).lte('date', reportRange.end),
      sb.from('status_events').select('*').gte('started_at', reportRange.start + 'T00:00:00').lte('started_at', reportRange.end + 'T23:59:59'),
      sb.from('attendance_points').select('*').gte('date', reportRange.start).lte('date', reportRange.end),
    ])
    const results = profiles.map(p => {
      const pScheds = scheds?.filter(s => s.profile_id === p.id) || []
      const pEvents = events?.filter(e => e.profile_id === p.id) || []
      const pPoints = points?.filter(pt => pt.profile_id === p.id) || []
      const totalPoints = pPoints.reduce((sum, pt) => sum + parseFloat(pt.points), 0)
      const breakViolations = pEvents.filter(e => e.status === 'Break' && e.duration_seconds > (15 + GRACE) * 60).length
      const lunchViolations = pEvents.filter(e => e.status === 'Lunch' && e.duration_seconds > (30 + GRACE) * 60).length
      const adhPcts = pScheds
        .map(s => adherencePct(s, pEvents.filter(e => e.started_at?.startsWith(s.date))))
        .filter(v => v != null)
      const avgAdherence = adhPcts.length ? Math.round(adhPcts.reduce((a, b) => a + b, 0) / adhPcts.length) : null
      return { profile: p, daysScheduled: pScheds.length, totalPoints, breakViolations, lunchViolations, avgAdherence, pointEntries: pPoints }
    })
    setReportData(results)
  }

  const exportReport = () => {
    if (!reportData) return
    const rows = reportData.map(r => [r.profile.name || r.profile.email, r.daysScheduled, r.totalPoints.toFixed(1), r.avgAdherence != null ? r.avgAdherence + '%' : '--', r.breakViolations, r.lunchViolations])
    const csv = [['Agent','Days Scheduled','Attendance Points','Avg Adherence','Break Violations','Lunch Violations'], ...rows].map(r => r.join(',')).join('\n')
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' })); a.download = `WFM_Report_${reportRange.start}_${reportRange.end}.csv`; a.click()
  }

  const prevWeek = () => { const d = new Date(weekBase); d.setDate(d.getDate() - 7); setWeekBase(d.toISOString().split('T')[0]) }
  const nextWeek = () => { const d = new Date(weekBase); d.setDate(d.getDate() + 7); setWeekBase(d.toISOString().split('T')[0]) }
  const yearPoints = (profileId) => attendancePoints.filter(p => p.profile_id === profileId).reduce((sum, p) => sum + parseFloat(p.points), 0)

  const weekLabel = `${new Date(weekDates[0] + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' })} – ${new Date(weekDates[6] + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}`

  const TABS = [
    { id:'schedule', label:'Schedule' },
    { id:'graphical', label:'Graphical' },
    { id:'adherence', label:'Adherence' },
    { id:'points', label:'Points' },
    { id:'reports', label:'Reports' },
  ]

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', flex:1 }}>
      <div className="spinner lg"></div>
    </div>
  )

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

      {/* ── HEADER BAR ── */}
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
        {/* Title + week nav row */}
        <div style={{ padding:'16px 24px 0', display:'flex', alignItems:'flex-start', justifyContent:'flex-end', gap:16 }}>
          {(tab === 'schedule' || tab === 'adherence') && (
            <div style={{ display:'flex', alignItems:'center', gap:10, marginTop:2 }}>
              <button onClick={prevWeek}
                style={{ width:32, height:32, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-secondary)', display:'flex', alignItems:'center', justifyContent:'center' }}
                onMouseEnter={e => e.currentTarget.style.background='var(--surface)'}
                onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>‹</button>
              <span style={{ fontSize:13, fontWeight:500, color:'var(--text-primary)', minWidth:200, textAlign:'center' }}>{weekLabel}</span>
              <button onClick={nextWeek}
                style={{ width:32, height:32, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-secondary)', display:'flex', alignItems:'center', justifyContent:'center' }}
                onMouseEnter={e => e.currentTarget.style.background='var(--surface)'}
                onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>›</button>
            </div>
          )}
        </div>

        {/* Tab bar + schedule actions */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 24px', marginTop:10 }}>
          <div style={{ display:'flex', gap:0 }}>
            {TABS.map(t => {
              const isActive = tab === t.id
              const isHovered = hoveredTab === t.id && !isActive
              return (
                <button key={t.id}
                  onClick={() => setTab(t.id)}
                  onMouseEnter={() => setHoveredTab(t.id)}
                  onMouseLeave={() => setHoveredTab(null)}
                  style={{ padding:'10px 16px', fontSize:13, fontWeight: isActive ? 600 : 400, border:'none', cursor:'pointer',
                    borderRadius:'var(--radius) var(--radius) 0 0',
                    background: isHovered ? 'var(--surface-2)' : 'transparent',
                    color: isActive ? 'var(--accent)' : isHovered ? 'var(--text-primary)' : 'var(--text-muted)',
                    borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                    transition:'color .1s, background .1s' }}>
                  {t.label}
                </button>
              )
            })}
          </div>

          {/* Action buttons — only on schedule tab */}
          {tab === 'schedule' && isAdmin && (
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <button onClick={() => setBulkModal(true)}
                style={{ padding:'6px 14px', fontSize:12, fontWeight:500, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface)', color:'var(--text-secondary)', cursor:'pointer', transition:'all .1s' }}
                onMouseEnter={e => { e.currentTarget.style.background='var(--surface-2)'; e.currentTarget.style.color='var(--text-primary)' }}
                onMouseLeave={e => { e.currentTarget.style.background='var(--surface)'; e.currentTarget.style.color='var(--text-secondary)' }}>
                Bulk Schedule
              </button>
              <button onClick={() => setTemplateModal(true)}
                style={{ padding:'6px 14px', fontSize:12, fontWeight:500, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface)', color:'var(--text-secondary)', cursor:'pointer', transition:'all .1s' }}
                onMouseEnter={e => { e.currentTarget.style.background='var(--surface-2)'; e.currentTarget.style.color='var(--text-primary)' }}
                onMouseLeave={e => { e.currentTarget.style.background='var(--surface)'; e.currentTarget.style.color='var(--text-secondary)' }}>
                Templates
              </button>
              <button onClick={() => setCopyModal(true)}
                style={{ padding:'6px 14px', fontSize:12, fontWeight:500, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface)', color:'var(--text-secondary)', cursor:'pointer', transition:'all .1s' }}
                onMouseEnter={e => { e.currentTarget.style.background='var(--surface-2)'; e.currentTarget.style.color='var(--text-primary)' }}
                onMouseLeave={e => { e.currentTarget.style.background='var(--surface)'; e.currentTarget.style.color='var(--text-secondary)' }}>
                Copy Week
              </button>
              <button onClick={() => setPublishModal(true)}
                style={{ padding:'6px 16px', fontSize:12, fontWeight:600, border:'none', borderRadius:'var(--radius)', background:'var(--accent)', color:'#fff', cursor:'pointer', transition:'opacity .1s' }}
                onMouseEnter={e => e.currentTarget.style.opacity='.9'}
                onMouseLeave={e => e.currentTarget.style.opacity='1'}>
                Publish + Email
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── CONTENT AREA ── */}
      <div style={{ flex:1, overflowY:'auto' }}>

        {/* ── SCHEDULE TAB ── */}
        {tab === 'schedule' && (
          <div style={{ padding:24 }}>
            <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden' }}>
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', minWidth:900 }}>
                  <thead>
                    <tr style={{ background:'var(--surface-2)' }}>
                      <th style={{ padding:'12px 16px', textAlign:'left', fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', width:180, borderBottom:'1px solid var(--border)' }}>Agent</th>
                      {weekDates.map((date, i) => {
                        const isToday = date === today
                        return (
                          <th key={date} style={{ padding:'10px 8px', textAlign:'center', fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color: isToday ? 'var(--accent)' : 'var(--text-muted)', borderBottom:'1px solid var(--border)', borderLeft:'1px solid var(--border)', minWidth:110 }}>
                            <div>{DAYS[i]}</div>
                            <div style={{ fontSize:13, fontWeight: isToday ? 700 : 500, color: isToday ? 'var(--accent)' : 'var(--text-primary)', marginTop:2 }}>{new Date(date + 'T12:00:00').getDate()}</div>
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {profiles.map((p, pi) => (
                      <tr key={p.id} style={{ borderBottom:'1px solid var(--border)' }}>
                        <td style={{ padding:'12px 16px', borderRight:'1px solid var(--border)' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <div style={{ width:30, height:30, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 18 : 11, fontWeight:600, flexShrink:0 }}>
                              <Avatar avatar={p.avatar} name={p.name || p.email} />
                            </div>
                            <div>
                              <div style={{ fontSize:13, fontWeight:500, color:'var(--text-primary)' }}>{p.name || p.email}</div>
                              <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:1 }}>
                                {yearPoints(p.id).toFixed(1)} pts YTD
                              </div>
                            </div>
                          </div>
                        </td>
                        {weekDates.map(date => {
                          const sched = getSchedule(p.id, date)
                          const isToday = date === today
                          const isOff = sched && sched.day_type !== 'work'
                          const typeColor = sched ? DAY_TYPE_COLORS[sched.day_type] : null
                          return (
                            <td key={date} style={{ padding:6, borderLeft:'1px solid var(--border)', background: isToday ? 'var(--accent-bg)' : 'transparent', verticalAlign:'top' }}>
                              {sched && !isOff ? (
                                <div onClick={() => isAdmin && openEdit(p.id, date)}
                                  style={{ padding:'8px 10px', borderRadius:'var(--radius)', background:'var(--success-bg)', border:'1px solid var(--success)', cursor: isAdmin ? 'pointer' : 'default', transition:'all .1s' }}
                                  onMouseEnter={e => { if(isAdmin) e.currentTarget.style.opacity='.8' }}
                                  onMouseLeave={e => e.currentTarget.style.opacity='1'}>
                                  <div style={{ fontSize:11, fontWeight:600, color:'var(--success)' }}>{fmt(sched.shift_start)} – {fmt(sched.shift_end)}</div>
                                  {sched.lunch_start && <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:2 }}>Lunch {fmt(sched.lunch_start)}</div>}
                                </div>
                              ) : sched && isOff ? (
                                <div onClick={() => isAdmin && openEdit(p.id, date)}
                                  style={{ padding:'8px 10px', borderRadius:'var(--radius)', background: typeColor + '18', border:`1px solid ${typeColor}`, cursor: isAdmin ? 'pointer' : 'default' }}>
                                  <div style={{ fontSize:11, fontWeight:600, color: typeColor }}>{DAY_TYPE_LABELS[sched.day_type]}</div>
                                </div>
                              ) : isAdmin ? (
                                <button onClick={() => openEdit(p.id, date)}
                                  style={{ width:'100%', padding:'8px 4px', border:'1px dashed var(--border)', borderRadius:'var(--radius)', background:'transparent', color:'var(--text-muted)', cursor:'pointer', fontSize:11, transition:'all .1s' }}
                                  onMouseEnter={e => { e.currentTarget.style.borderColor='var(--accent)'; e.currentTarget.style.color='var(--accent)' }}
                                  onMouseLeave={e => { e.currentTarget.style.borderColor='var(--border)'; e.currentTarget.style.color='var(--text-muted)' }}>
                                  + Add
                                </button>
                              ) : (
                                <div style={{ fontSize:10, color:'var(--text-muted)', textAlign:'center', padding:6 }}>—</div>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ── GRAPHICAL TAB ── */}
        {tab === 'graphical' && (
          <GraphicalSchedule profiles={profiles} onUpdate={async () => {
            const from = new Date(); from.setDate(from.getDate() - 30)
            const to = new Date(); to.setDate(to.getDate() + 30)
            const { data: s } = await sb.from('schedules').select('*').gte('date', from.toISOString().split('T')[0]).lte('date', to.toISOString().split('T')[0])
            setSchedules(s || [])
          }} />
        )}

        {/* ── ADHERENCE TAB ── */}
        {tab === 'adherence' && (
          <div style={{ padding:24, display:'flex', flexDirection:'column', gap:16 }}>
            {profiles.map(p => {
              const pScheds = schedules.filter(s => s.profile_id === p.id)
              const pEvents = statusEvents.filter(e => e.profile_id === p.id)
              if (pScheds.length === 0 && pEvents.length === 0) return null
              // Average only over days with a valid schedule; a null day must
              // not count as 100 (the old `|| 100` also turned a real 0 into 100).
              const dayPcts = pScheds
                .map(s => adherencePct(s, pEvents.filter(e => e.started_at?.startsWith(s.date))))
                .filter(v => v != null)
              const avgAdh = dayPcts.length ? Math.round(dayPcts.reduce((a, b) => a + b, 0) / dayPcts.length) : null

              return (
                <div key={p.id} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden' }}>
                  <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between', background:'var(--surface-2)' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <div style={{ width:32, height:32, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 20 : 12, fontWeight:600 }}>
                        <Avatar avatar={p.avatar} name={p.name || p.email} />
                      </div>
                      <span style={{ fontSize:14, fontWeight:600 }}>{p.name || p.email}</span>
                    </div>
                    {avgAdh != null && (
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <div style={{ width:120, height:6, background:'var(--border)', borderRadius:99, overflow:'hidden' }}>
                          <div style={{ height:'100%', width:`${avgAdh}%`, background: avgAdh >= attCfg.adherenceGood ? 'var(--success)' : avgAdh >= attCfg.adherenceWarn ? '#f59e0b' : 'var(--danger)', borderRadius:99 }} />
                        </div>
                        <span style={{ fontSize:14, fontWeight:700, color: avgAdh >= attCfg.adherenceGood ? 'var(--success)' : avgAdh >= attCfg.adherenceWarn ? '#f59e0b' : 'var(--danger)' }}>{avgAdh}%</span>
                      </div>
                    )}
                  </div>
                  <div style={{ overflowX:'auto' }}>
                    <table className="data-table">
                      <thead><tr><th>Date</th><th>Scheduled</th><th>Login</th><th>Break 1</th><th>Lunch</th><th>Break 2</th><th>Logout</th><th style={{textAlign:'right'}}>Adherence</th></tr></thead>
                      <tbody>
                        {weekDates.map(date => {
                          const sched = getSchedule(p.id, date)
                          const dayEvents = getEvents(p.id, date)
                          const loginEvent = dayEvents.find(e => e.status === 'Available' || e.status === 'On Call')
                          const breakEvents = dayEvents.filter(e => e.status === 'Break')
                          const lunchEvent = dayEvents.find(e => e.status === 'Lunch')
                          const offlineEvent = [...dayEvents].reverse().find(e => e.status === 'Offline')
                          if (!sched && dayEvents.length === 0) return null
                          const pct = adherencePct(sched, dayEvents)
                          const bv = (ev, limit) => ev && ev.duration_seconds > (limit + GRACE) * 60
                          return (
                            <tr key={date}>
                              <td style={{ padding:'10px 12px', fontSize:12, fontWeight:500 }}>{fmtDate(date)}</td>
                              <td style={{ padding:'10px 12px', fontSize:12 }}>{sched ? `${fmt(sched.shift_start)} – ${fmt(sched.shift_end)}` : <span style={{ color:'var(--text-muted)' }}>—</span>}</td>
                              <td style={{ padding:'10px 12px', fontSize:12 }}>{loginEvent ? <span style={{ color:'var(--success)', fontWeight:500 }}>{fmtTime(loginEvent.started_at)}</span> : <span style={{ color:'var(--danger)' }}>No login</span>}</td>
                              <td style={{ padding:'10px 12px', fontSize:12 }}>{breakEvents[0] ? <span style={{ color: bv(breakEvents[0], sched?.break1_duration || 15) ? 'var(--danger)' : 'var(--text-secondary)' }}>{fmtTime(breakEvents[0].started_at)} ({fmtDuration(breakEvents[0].duration_seconds)}){bv(breakEvents[0], sched?.break1_duration || 15) ? ' !' : ''}</span> : <span style={{ color:'var(--text-muted)' }}>—</span>}</td>
                              <td style={{ padding:'10px 12px', fontSize:12 }}>{lunchEvent ? <span style={{ color: bv(lunchEvent, sched?.lunch_duration || 30) ? 'var(--danger)' : 'var(--text-secondary)' }}>{fmtTime(lunchEvent.started_at)} ({fmtDuration(lunchEvent.duration_seconds)}){bv(lunchEvent, sched?.lunch_duration || 30) ? ' !' : ''}</span> : <span style={{ color:'var(--text-muted)' }}>—</span>}</td>
                              <td style={{ padding:'10px 12px', fontSize:12 }}>{breakEvents[1] ? <span style={{ color: bv(breakEvents[1], sched?.break2_duration || 15) ? 'var(--danger)' : 'var(--text-secondary)' }}>{fmtTime(breakEvents[1].started_at)} ({fmtDuration(breakEvents[1].duration_seconds)}){bv(breakEvents[1], sched?.break2_duration || 15) ? ' !' : ''}</span> : <span style={{ color:'var(--text-muted)' }}>—</span>}</td>
                              <td style={{ padding:'10px 12px', fontSize:12 }}>{offlineEvent ? <span>{fmtTime(offlineEvent.started_at)}</span> : <span style={{ color:'var(--text-muted)' }}>—</span>}</td>
                              <td style={{ padding:'10px 12px', textAlign:'right' }}>{pct != null ? <span style={{ fontSize:13, fontWeight:700, color: pct >= attCfg.adherenceGood ? 'var(--success)' : pct >= attCfg.adherenceWarn ? '#f59e0b' : 'var(--danger)' }}>{pct}%</span> : <span style={{ color:'var(--text-muted)' }}>—</span>}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* ── POINTS TAB ── */}
        {tab === 'points' && (
          <div style={{ padding:24, display:'flex', flexDirection:'column', gap:16 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <span style={{ fontSize:12, color:'var(--text-muted)' }}>Calendar year {new Date().getFullYear()} · Points reset Jan 1</span>
              <div style={{ display:'flex', gap:10, fontSize:11, color:'var(--text-muted)' }}>
                <span style={{ display:'flex', alignItems:'center', gap:4 }}><span style={{ width:10, height:10, borderRadius:'50%', background:'var(--success)', display:'inline-block' }}></span> {`0–${(attCfg.pointsWarn - 0.1).toFixed(1)} Good`}</span>
                <span style={{ display:'flex', alignItems:'center', gap:4 }}><span style={{ width:10, height:10, borderRadius:'50%', background:'#f59e0b', display:'inline-block' }}></span> {`${attCfg.pointsWarn}–${(attCfg.pointsCritical - 0.1).toFixed(1)} Warning`}</span>
                <span style={{ display:'flex', alignItems:'center', gap:4 }}><span style={{ width:10, height:10, borderRadius:'50%', background:'var(--danger)', display:'inline-block' }}></span> {`${attCfg.pointsCritical}+ Critical`}</span>
              </div>
            </div>
            {isAdmin && wfmCfg && (
              <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:16 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                  <span style={{ fontSize:13, fontWeight:700 }}>WFM settings</span>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    {wfmMsg && <span style={{ fontSize:12, color: wfmMsg.startsWith('Error') ? 'var(--danger)' : 'var(--success)' }}>{wfmMsg}</span>}
                    <button className="btn sm primary" onClick={saveWfmCfg}>Save</button>
                  </div>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:12 }}>
                  {[
                    ['late', 'Late arrival (pts)'],
                    ['absence', 'Unexcused absence (pts)'],
                    ['early_departure', 'Early departure (pts)'],
                    ['no_call', 'No call / no show (pts)'],
                  ].map(([k, label]) => (
                    <div key={k} className="form-field">
                      <label className="form-label" style={{ fontSize:11 }}>{label}</label>
                      <input className="form-input" type="number" step="0.5" min="0" value={wfmCfg.points[k]}
                        onChange={e => setWfmCfg(f => ({ ...f, points: { ...f.points, [k]: Number(e.target.value) } }))} />
                    </div>
                  ))}
                  {[
                    ['pointsWarn', 'Points → Warning at'],
                    ['pointsCritical', 'Points → Critical at'],
                    ['adherenceGood', 'Adherence green ≥ (%)'],
                    ['adherenceWarn', 'Adherence amber ≥ (%)'],
                  ].map(([k, label]) => (
                    <div key={k} className="form-field">
                      <label className="form-label" style={{ fontSize:11 }}>{label}</label>
                      <input className="form-input" type="number" min="0" value={wfmCfg[k]}
                        onChange={e => setWfmCfg(f => ({ ...f, [k]: Number(e.target.value) }))} />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {profiles.map(p => {
              const pts = attendancePoints.filter(ap => ap.profile_id === p.id)
              const total = pts.reduce((sum, ap) => sum + parseFloat(ap.points), 0)
              const statusColor = total >= attCfg.pointsCritical ? 'var(--danger)' : total >= attCfg.pointsWarn ? '#f59e0b' : 'var(--success)'
              return (
                <div key={p.id} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden' }}>
                  <div style={{ padding:'14px 18px', borderBottom: pts.length > 0 ? '1px solid var(--border)' : 'none', display:'flex', alignItems:'center', justifyContent:'space-between', background:'var(--surface-2)' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <div style={{ width:32, height:32, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 20 : 12, fontWeight:600 }}>
                        <Avatar avatar={p.avatar} name={p.name || p.email} />
                      </div>
                      <span style={{ fontSize:14, fontWeight:600 }}>{p.name || p.email}</span>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <div style={{ width:80, height:6, background:'var(--border)', borderRadius:99, overflow:'hidden' }}>
                          <div style={{ height:'100%', width:`${Math.min((total/8)*100, 100)}%`, background:statusColor, borderRadius:99 }} />
                        </div>
                        <span style={{ fontSize:16, fontWeight:800, color:statusColor }}>{total.toFixed(1)}</span>
                        <span style={{ fontSize:11, color:'var(--text-muted)' }}>/ 8 pts</span>
                      </div>
                      {isAdmin && (
                        <button className="btn sm primary" onClick={() => { setPointModal(p); setPointData({ reason:'late', points:0.5, notes:'', date:today }) }}>
                          + Add Point
                        </button>
                      )}
                    </div>
                  </div>
                  {pts.length > 0 && (
                    <table className="data-table">
                      <thead><tr><th>Date</th><th>Reason</th><th style={{textAlign:'center'}}>Points</th><th>Notes</th>{isAdmin && <th></th>}</tr></thead>
                      <tbody>
                        {pts.map(pt => (
                          <tr key={pt.id}>
                            <td style={{ padding:'8px 12px', fontSize:12 }}>{pt.date}</td>
                            <td style={{ padding:'8px 12px', fontSize:12 }}>{POINT_REASONS.find(r => r.value === pt.reason)?.label || pt.reason}</td>
                            <td style={{ padding:'8px 12px', fontSize:13, fontWeight:700, textAlign:'center', color: parseFloat(pt.points) >= 1 ? 'var(--danger)' : '#f59e0b' }}>{parseFloat(pt.points).toFixed(1)}</td>
                            <td style={{ padding:'8px 12px', fontSize:11, color:'var(--text-muted)' }}>{pt.notes || '—'}</td>
                            {isAdmin && <td style={{ padding:'8px 12px' }}><button className="btn sm danger" onClick={() => deletePoint(pt.id)}>Remove</button></td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* ── REPORTS TAB ── */}
        {tab === 'reports' && (
          <div style={{ padding:24, display:'flex', flexDirection:'column', gap:16 }}>
            <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:20 }}>
              <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', marginBottom:14 }}>Generate Report</div>
              <div style={{ display:'flex', gap:12, alignItems:'flex-end', flexWrap:'wrap' }}>
                <div className="form-field" style={{ margin:0 }}>
                  <label className="form-label">Start date</label>
                  <input type="date" className="form-input" value={reportRange.start} onChange={e => setReportRange(p => ({ ...p, start: e.target.value }))} />
                </div>
                <div className="form-field" style={{ margin:0 }}>
                  <label className="form-label">End date</label>
                  <input type="date" className="form-input" value={reportRange.end} onChange={e => setReportRange(p => ({ ...p, end: e.target.value }))} />
                </div>
                <button className="btn primary" onClick={runReport} disabled={!reportRange.start || !reportRange.end}>Run report</button>
                {reportData && <button className="btn" onClick={exportReport}>Export CSV</button>}
              </div>
            </div>

            {reportData && (
              <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden' }}>
                <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--border)', background:'var(--surface-2)' }}>
                  <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)' }}>
                    Summary — {reportRange.start} to {reportRange.end}
                  </div>
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th style={{textAlign:'center'}}>Days Sched.</th>
                      <th style={{textAlign:'center'}}>Att. Points</th>
                      <th style={{textAlign:'center'}}>Avg Adherence</th>
                      <th style={{textAlign:'center'}}>Break Viol.</th>
                      <th style={{textAlign:'center'}}>Lunch Viol.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportData.map(r => (
                      <tr key={r.profile.id}>
                        <td style={{ padding:'12px 14px', fontWeight:500 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <div style={{ width:26, height:26, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: r.profile.avatar ? 16 : 10, fontWeight:600 }}>
                              <Avatar avatar={r.profile.avatar} name={r.profile.name || r.profile.email} />
                            </div>
                            {r.profile.name || r.profile.email}
                          </div>
                        </td>
                        <td style={{ padding:'12px 14px', textAlign:'center', fontWeight:500 }}>{r.daysScheduled}</td>
                        <td style={{ padding:'12px 14px', textAlign:'center', fontWeight:700, color: r.totalPoints >= 6 ? 'var(--danger)' : r.totalPoints >= 3 ? '#f59e0b' : 'var(--success)' }}>{r.totalPoints.toFixed(1)}</td>
                        <td style={{ padding:'12px 14px', textAlign:'center' }}>
                          {r.avgAdherence != null ? (
                            <span style={{ fontWeight:700, color: r.avgAdherence >= attCfg.adherenceGood ? 'var(--success)' : r.avgAdherence >= attCfg.adherenceWarn ? '#f59e0b' : 'var(--danger)' }}>{r.avgAdherence}%</span>
                          ) : <span style={{ color:'var(--text-muted)' }}>—</span>}
                        </td>
                        <td style={{ padding:'12px 14px', textAlign:'center', color: r.breakViolations > 0 ? 'var(--danger)' : 'var(--text-secondary)', fontWeight: r.breakViolations > 0 ? 700 : 400 }}>{r.breakViolations}</td>
                        <td style={{ padding:'12px 14px', textAlign:'center', color: r.lunchViolations > 0 ? 'var(--danger)' : 'var(--text-secondary)', fontWeight: r.lunchViolations > 0 ? 700 : 400 }}>{r.lunchViolations}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── EDIT SCHEDULE MODAL ── */}
      {editCell && (
        <Modal title={`Schedule — ${profiles.find(p => p.id === editCell.profileId)?.name || ''} · ${fmtDate(editCell.date)}`} onClose={() => setEditCell(null)} width={480}>
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div className="form-field">
              <label className="form-label">Day Type</label>
              <div style={{ display:'flex', gap:6 }}>
                {Object.entries(DAY_TYPE_LABELS).map(([val, label]) => (
                  <button key={val} onClick={() => setEditData(p => ({ ...p, day_type: val }))}
                    style={{ flex:1, padding:'7px 4px', borderRadius:'var(--radius)', fontSize:11, fontWeight:500, border:'1px solid', cursor:'pointer',
                      borderColor: editData.day_type === val ? (DAY_TYPE_COLORS[val] || 'var(--accent)') : 'var(--border)',
                      background: editData.day_type === val ? (DAY_TYPE_COLORS[val] || 'var(--accent)') + '20' : 'var(--surface-2)',
                      color: editData.day_type === val ? (DAY_TYPE_COLORS[val] || 'var(--accent)') : 'var(--text-muted)' }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {(!editData.day_type || editData.day_type === 'work') && (
              <>
                {templates.length > 0 && (
                  <div className="form-field">
                    <label className="form-label">Apply Template</label>
                    <select className="form-input" onChange={e => e.target.value && applyTemplate(e.target.value)} defaultValue="">
                      <option value="">Select template...</option>
                      {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                )}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                  <div className="form-field">
                    <label className="form-label">Shift Start</label>
                    <input type="time" className="form-input" value={editData.shift_start || ''} onChange={e => setEditData(p => ({ ...p, shift_start: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label className="form-label">Shift End</label>
                    <input type="time" className="form-input" value={editData.shift_end || ''} onChange={e => setEditData(p => ({ ...p, shift_end: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label className="form-label">Break 1</label>
                    <input type="time" className="form-input" value={editData.break1_start || ''} onChange={e => setEditData(p => ({ ...p, break1_start: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label className="form-label">Lunch</label>
                    <input type="time" className="form-input" value={editData.lunch_start || ''} onChange={e => setEditData(p => ({ ...p, lunch_start: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label className="form-label">Break 2</label>
                    <input type="time" className="form-input" value={editData.break2_start || ''} onChange={e => setEditData(p => ({ ...p, break2_start: e.target.value }))} />
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="modal-actions">
            {getSchedule(editCell.profileId, editCell.date) && (
              <button className="btn danger" onClick={() => deleteSchedule(editCell.profileId, editCell.date)}>Remove</button>
            )}
            <div style={{ flex:1 }} />
            <button className="btn" onClick={() => setEditCell(null)}>Cancel</button>
            <button className="btn primary" onClick={saveSchedule} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        </Modal>
      )}

      {/* ── ADD POINT MODAL ── */}
      {pointModal && (
        <Modal title={`Add Attendance Point — ${pointModal.name || pointModal.email}`} onClose={() => setPointModal(null)} width={440}>
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div className="form-field">
              <label className="form-label">Date</label>
              <input type="date" className="form-input" value={pointData.date} onChange={e => setPointData(p => ({ ...p, date: e.target.value }))} />
            </div>
            <div className="form-field">
              <label className="form-label">Reason</label>
              <select className="form-input" value={pointData.reason} onChange={e => {
                const r = POINT_REASONS.find(r => r.value === e.target.value)
                setPointData(p => ({ ...p, reason: e.target.value, points: (attCfg.points || {})[e.target.value] ?? r?.points ?? p.points }))
              }}>
                {POINT_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label className="form-label">Points</label>
              <input type="number" className="form-input" value={pointData.points} min={0.5} max={2} step={0.5} onChange={e => setPointData(p => ({ ...p, points: parseFloat(e.target.value) }))} />
            </div>
            <div className="form-field">
              <label className="form-label">Notes (optional)</label>
              <input className="form-input" value={pointData.notes} onChange={e => setPointData(p => ({ ...p, notes: e.target.value }))} placeholder="Add context..." />
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setPointModal(null)}>Cancel</button>
            <button className="btn primary" onClick={addPoint} disabled={saving}>{saving ? 'Saving...' : 'Add point'}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
