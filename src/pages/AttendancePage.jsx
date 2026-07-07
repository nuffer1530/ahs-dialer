import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import Modal from '../components/Modal'
import GraphicalSchedule from '../components/GraphicalSchedule'

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const GRACE = 5

function fmt(time) {
  if (!time) return '--'
  const [h, m] = time.split(':')
  const hour = parseInt(h)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  return `${hour % 12 || 12}:${m} ${ampm}`
}

function fmtDuration(seconds) {
  if (!seconds && seconds !== 0) return '--'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return `${m}m ${s}s`
  return `${Math.floor(m/60)}h ${m%60}m`
}

function fmtTime(iso) {
  if (!iso) return '--'
  return new Date(iso).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true })
}

function fmtDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })
}

function adherencePct(sched, nonAdherentSeconds) {
  if (!sched) return null
  const [sh, sm] = sched.shift_start.split(':').map(Number)
  const [eh, em] = sched.shift_end.split(':').map(Number)
  const totalMins = (eh * 60 + em) - (sh * 60 + sm)
  if (totalMins <= 0) return null
  const nonAdherentMins = (nonAdherentSeconds || 0) / 60
  return Math.max(0, Math.round(((totalMins - nonAdherentMins) / totalMins) * 100))
}

function getWeekDates(baseDate) {
  const d = new Date(baseDate)
  const day = d.getDay()
  const monday = new Date(d)
  monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(monday)
    date.setDate(monday.getDate() + i)
    return date.toISOString().split('T')[0]
  })
}

function addMinutes(timeStr, mins) {
  if (!timeStr || !mins) return ''
  const [h, m] = timeStr.split(':').map(Number)
  const total = h * 60 + m + parseInt(mins)
  return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`
}

const POINT_REASONS = [
  { value: 'late', label: 'Late arrival (0.5 pts)', points: 0.5 },
  { value: 'absence', label: 'Unexcused absence (1.0 pts)', points: 1.0 },
  { value: 'early_departure', label: 'Early departure (0.5 pts)', points: 0.5 },
  { value: 'no_call', label: 'No call/no show (1.0 pts)', points: 1.0 },
  { value: 'manual', label: 'Manual entry', points: 0 },
]

export default function AttendancePage() {
  const { profile, isAdmin } = useAuth()
  const getTodayMonday = () => {
    const d = new Date()
    const day = d.getDay()
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
    return d.toISOString().split('T')[0]
  }
  const [tab, setTab] = useState('schedule')
  const [profiles, setProfiles] = useState([])
  const [schedules, setSchedules] = useState([])
  const [statusEvents, setStatusEvents] = useState([])
  const [templates, setTemplates] = useState([])
  const [attendancePoints, setAttendancePoints] = useState([])
  const [loading, setLoading] = useState(true)
  const [weekBase, setWeekBase] = useState(() => getTodayMonday())
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
        sb.from('profiles').select('id, name, email, avatar').order('name'),
        sb.from('schedules').select('*').gte('date', weekDates[0]).lte('date', weekDates[6]),
        sb.from('status_events').select('*').gte('started_at', weekDates[0] + 'T00:00:00').lte('started_at', weekDates[6] + 'T23:59:59'),
        sb.from('shift_templates').select('*').order('name'),
        sb.from('attendance_points').select('*').gte('date', new Date().getFullYear() + '-01-01').order('date', { ascending: false }),
      ])
      setProfiles(p || [])
      setSchedules(s || [])
      setStatusEvents(ev || [])
      setTemplates(t || [])
      setAttendancePoints(ap || [])
      setLoading(false)
    }
    load()
  }, [weekBase])

  const getSchedule = (profileId, date) => schedules.find(s => s.profile_id === profileId && s.date === date)
  const getEvents = (profileId, date) => statusEvents.filter(e => e.profile_id === profileId && e.started_at.startsWith(date)).sort((a, b) => new Date(a.started_at) - new Date(b.started_at))

  const openEdit = (profileId, date) => {
    const existing = getSchedule(profileId, date)
    setEditData(existing ? {
      shift_start: existing.shift_start || '08:00',
      shift_end: existing.shift_end || '17:00',
      break1_start: existing.break1_start || '',
      break1_duration: existing.break1_duration || 15,
      break2_start: existing.break2_start || '',
      break2_duration: existing.break2_duration || 15,
      lunch_start: existing.lunch_start || '',
      lunch_duration: existing.lunch_duration || 30,
    } : {
      shift_start: '08:00', shift_end: '17:00',
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
      shift_start: t.shift_start || '08:00',
      shift_end: t.shift_end || '17:00',
      break1_start: t.break1_start || '',
      break1_duration: t.break1_duration || 15,
      break2_start: t.break2_start || '',
      break2_duration: t.break2_duration || 15,
      lunch_start: t.lunch_start || '',
      lunch_duration: t.lunch_duration || 30,
    })
  }

  const saveSchedule = async () => {
    if (!editCell) return
    setSaving(true)
    const { profileId, date } = editCell
    const isPtoOrSick = editData.day_type === 'pto' || editData.day_type === 'sick' || editData.day_type === 'off'
    const payload = {
      profile_id: profileId, date,
      day_type: editData.day_type || 'work',
      shift_start: isPtoOrSick ? null : editData.shift_start,
      shift_end: isPtoOrSick ? null : editData.shift_end,
      break1_start: isPtoOrSick ? null : (editData.break1_start || null),
      break1_end: isPtoOrSick ? null : (editData.break1_start ? addMinutes(editData.break1_start, editData.break1_duration) : null),
      break1_duration: editData.break1_duration,
      break2_start: isPtoOrSick ? null : (editData.break2_start || null),
      break2_end: isPtoOrSick ? null : (editData.break2_start ? addMinutes(editData.break2_start, editData.break2_duration) : null),
      break2_duration: editData.break2_duration,
      lunch_start: isPtoOrSick ? null : (editData.lunch_start || null),
      lunch_end: isPtoOrSick ? null : (editData.lunch_start ? addMinutes(editData.lunch_start, editData.lunch_duration) : null),
      lunch_duration: editData.lunch_duration,
      created_by: profile.id,
    }
    await sb.from('schedules').upsert(payload, { onConflict: 'profile_id,date' })
    const { data: s } = await sb.from('schedules').select('*').gte('date', weekDates[0]).lte('date', weekDates[6])
    setSchedules(s || [])
    setSaving(false)
    setEditCell(null)
  }

  const deleteSchedule = async (profileId, date) => {
    await sb.from('schedules').delete().eq('profile_id', profileId).eq('date', date)
    setSchedules(prev => prev.filter(s => !(s.profile_id === profileId && s.date === date)))
    setEditCell(null)
  }

  const applyBulkSchedule = async () => {
    if (!bulkData.templateId || bulkData.profileIds.length === 0 || bulkData.dates.length === 0) return
    setSaving(true)
    const t = templates.find(t => t.id === bulkData.templateId)
    if (!t) { setSaving(false); return }
    const rows = []
    bulkData.profileIds.forEach(pid => {
      bulkData.dates.forEach(date => {
        rows.push({
          profile_id: pid, date,
          shift_start: t.shift_start, shift_end: t.shift_end,
          break1_start: t.break1_start, break1_end: t.break1_start ? addMinutes(t.break1_start, t.break1_duration) : null, break1_duration: t.break1_duration,
          break2_start: t.break2_start, break2_end: t.break2_start ? addMinutes(t.break2_start, t.break2_duration) : null, break2_duration: t.break2_duration,
          lunch_start: t.lunch_start, lunch_end: t.lunch_start ? addMinutes(t.lunch_start, t.lunch_duration) : null, lunch_duration: t.lunch_duration,
          created_by: profile.id,
        })
      })
    })
    await sb.from('schedules').upsert(rows, { onConflict: 'profile_id,date' })
    const { data: s } = await sb.from('schedules').select('*').gte('date', weekDates[0]).lte('date', weekDates[6])
    setSchedules(s || [])
    setSaving(false)
    setBulkModal(false)
    setBulkData({ profileIds: [], templateId: '', dates: [] })
  }

  const saveTemplate = async () => {
    if (!editTemplate) return
    setSaving(true)
    if (editTemplate.id) {
      await sb.from('shift_templates').update(editTemplate).eq('id', editTemplate.id)
      setTemplates(prev => prev.map(t => t.id === editTemplate.id ? editTemplate : t))
    } else {
      const { data } = await sb.from('shift_templates').insert({ ...editTemplate, created_by: profile.id }).select().single()
      if (data) setTemplates(prev => [...prev, data])
    }
    setSaving(false)
    setEditTemplate(null)
  }

  const deleteTemplate = async (id) => {
    if (!confirm('Delete this template?')) return
    await sb.from('shift_templates').delete().eq('id', id)
    setTemplates(prev => prev.filter(t => t.id !== id))
  }

  const copyWeek = async () => {
    const d = new Date(weekBase)
    d.setDate(d.getDate() + 7)
    const targetDates = getWeekDates(d.toISOString().split('T')[0])
    const rows = []
    weekDates.forEach((date, i) => {
      profiles.forEach(p => {
        const s = getSchedule(p.id, date)
        if (s) rows.push({ ...s, id: undefined, date: targetDates[i], created_by: profile.id })
      })
    })
    if (rows.length > 0) await sb.from('schedules').upsert(rows, { onConflict: 'profile_id,date' })
    setCopyModal(false)
    const nd = new Date(weekBase)
    nd.setDate(nd.getDate() + 7)
    setWeekBase(nd.toISOString().split('T')[0])
  }

  const publishSchedule = async () => {
    setPublishing(true)
    const results = []
    const profilesWithSchedules = profiles.filter(p => weekDates.some(d => getSchedule(p.id, d)))
    for (const p of profilesWithSchedules) {
      const shifts = weekDates.map(date => {
        const s = getSchedule(p.id, date)
        const d = new Date(date + 'T12:00:00')
        const dayName = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
        if (!s) return `<tr><td style="padding:8px 12px;color:#6b7280;">${dayName}</td><td style="padding:8px 12px;color:#6b7280;">Off</td></tr>`
        const breaks = [
          s.break1_start ? `Break 1: ${fmt(s.break1_start)} (${s.break1_duration || 15} min)` : null,
          s.lunch_start ? `Lunch: ${fmt(s.lunch_start)} (${s.lunch_duration || 30} min)` : null,
          s.break2_start ? `Break 2: ${fmt(s.break2_start)} (${s.break2_duration || 15} min)` : null,
        ].filter(Boolean).join(' &nbsp;|&nbsp; ')
        return `<tr><td style="padding:8px 12px;font-weight:600;">${dayName}</td><td style="padding:8px 12px;">${fmt(s.shift_start)} - ${fmt(s.shift_end)}<br><span style="font-size:12px;color:#6b7280;">${breaks}</span></td></tr>`
      }).join('')

      const weekLabel = `${new Date(weekDates[0] + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${new Date(weekDates[6] + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

      const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <div style="background:#1e3a5f;padding:20px 24px;border-radius:8px 8px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:20px;">Your Schedule</h1>
            <p style="color:#93c5fd;margin:4px 0 0;font-size:14px;">Week of ${weekLabel}</p>
          </div>
          <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;overflow:hidden;">
            <table style="width:100%;border-collapse:collapse;">
              <thead><tr style="background:#f9fafb;"><th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;">Day</th><th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;">Shift</th></tr></thead>
              <tbody>${shifts}</tbody>
            </table>
          </div>
          <p style="color:#6b7280;font-size:12px;margin-top:16px;">Questions? Contact your manager. This schedule was sent from Altitude by Awesome Home Services.</p>
        </div>`

      try {
        const { error } = await sb.functions.invoke('send-schedule-email', {
          body: { to: p.email, subject: `Your Schedule: Week of ${weekLabel}`, html }
        })
        results.push({ name: p.name || p.email, success: !error, error: error?.message })
      } catch (e) {
        results.push({ name: p.name || p.email, success: false, error: e.message })
      }
    }
    await sb.from('schedule_publishes').insert({
      published_by: profile.id,
      week_start: weekDates[0],
      week_end: weekDates[6],
      profile_ids: profilesWithSchedules.map(p => p.id),
      email_sent: results.some(r => r.success),
      sent_at: new Date().toISOString(),
    })
    setPublishResult(results)
    setPublishing(false)
  }

  const addPoint = async () => {
    if (!pointModal) return
    setSaving(true)
    const payload = {
      profile_id: pointModal.id,
      date: pointData.date,
      points: parseFloat(pointData.points),
      reason: pointData.reason,
      notes: pointData.notes,
      auto_generated: false,
      created_by: profile.id,
    }
    const { data } = await sb.from('attendance_points').insert(payload).select().single()
    if (data) setAttendancePoints(prev => [data, ...prev])
    setSaving(false)
    setPointModal(null)
    setPointData({ reason: 'late', points: 0.5, notes: '', date: new Date().toISOString().split('T')[0] })
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
      const avgAdherence = pScheds.length > 0
        ? Math.round(pScheds.reduce((sum, s) => {
            const dayEvents = pEvents.filter(e => e.started_at.startsWith(s.date))
            const late = dayEvents.filter(e => !e.adherent).reduce((a, b) => a + (b.duration_seconds || 0), 0)
            return sum + (adherencePct(s, late) || 100)
          }, 0) / pScheds.length)
        : null
      return { profile: p, daysScheduled: pScheds.length, totalPoints, breakViolations, lunchViolations, avgAdherence, pointEntries: pPoints }
    })
    setReportData(results)
  }

  const exportReport = () => {
    if (!reportData) return
    const rows = reportData.map(r => [r.profile.name || r.profile.email, r.daysScheduled, r.totalPoints.toFixed(1), r.avgAdherence != null ? r.avgAdherence + '%' : '--', r.breakViolations, r.lunchViolations])
    const csv = [['Agent','Days Scheduled','Attendance Points','Avg Adherence','Break Violations','Lunch Violations'], ...rows].map(r => r.join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `AHS_Attendance_${reportRange.start}_${reportRange.end}.csv`
    a.click()
  }

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', flex:1 }}>
      <div className="spinner lg"></div>
    </div>
  )

  const prevWeek = () => { const d = new Date(weekBase); d.setDate(d.getDate() - 7); setWeekBase(d.toISOString().split('T')[0]) }
  const nextWeek = () => { const d = new Date(weekBase); d.setDate(d.getDate() + 7); setWeekBase(d.toISOString().split('T')[0]) }

  const yearPoints = (profileId) => attendancePoints.filter(p => p.profile_id === profileId).reduce((sum, p) => sum + parseFloat(p.points), 0)

  return (
    <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:20 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10 }}>
        <h1 style={{ fontSize:20, fontWeight:600 }}>Attendance and Schedule</h1>
        <div style={{ display:'flex', gap:6 }}>
          {['schedule','graphical','adherence','points','reports'].map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{ padding:'5px 14px', borderRadius:99, fontSize:12, fontWeight:500, border:'1px solid', cursor:'pointer',
                borderColor: tab === t ? 'var(--accent)' : 'var(--border)',
                background: tab === t ? 'var(--accent)' : 'var(--surface)',
                color: tab === t ? '#fff' : 'var(--text-secondary)' }}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* SCHEDULE TAB */}
      {tab === 'schedule' && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
            <button className="btn sm" onClick={prevWeek}>Prev</button>
            <span style={{ fontSize:13, fontWeight:600 }}>
              Week of {new Date(weekDates[0] + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' })} - {new Date(weekDates[6] + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}
            </span>
            <button className="btn sm" onClick={nextWeek}>Next</button>
            {isAdmin && (
              <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
                <button className="btn sm" onClick={() => setBulkModal(true)}>Bulk Schedule</button>
                <button className="btn sm" onClick={() => setTemplateModal(true)}>Templates</button>
                <button className="btn sm" onClick={() => setCopyModal(true)}>Copy Week</button>
                <button className="btn primary sm" onClick={() => setPublishModal(true)}>Publish + Email</button>
              </div>
            )}
          </div>

          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <thead>
                <tr style={{ background:'var(--surface-2)' }}>
                  <th style={{ padding:'10px 12px', textAlign:'left', fontWeight:600, width:140, borderBottom:'1px solid var(--border)' }}>Agent</th>
                  {weekDates.map(date => {
                    const d = new Date(date + 'T12:00:00')
                    const isToday = date === today
                    return (
                      <th key={date} style={{ padding:'10px 8px', textAlign:'center', fontWeight:600, borderBottom:'1px solid var(--border)', minWidth:120, background: isToday ? 'var(--accent-bg)' : undefined, color: isToday ? 'var(--accent)' : undefined }}>
                        <div>{DAYS[d.getDay()]}</div>
                        <div style={{ fontSize:10, fontWeight:400, color:'var(--text-muted)' }}>{d.toLocaleDateString('en-US', { month:'short', day:'numeric' })}</div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {profiles.map(p => {
                  // Calculate weekly hours
                  const weeklyMins = weekDates.reduce((sum, date) => {
                    const s = getSchedule(p.id, date)
                    if (!s || !s.shift_start || !s.shift_end || s.day_type === 'pto' || s.day_type === 'sick') return sum
                    const [sh, sm] = s.shift_start.split(':').map(Number)
                    const [eh, em] = s.shift_end.split(':').map(Number)
                    return sum + ((eh * 60 + em) - (sh * 60 + sm))
                  }, 0)
                  const weeklyHrs = (weeklyMins / 60).toFixed(1)

                  return (
                  <tr key={p.id} style={{ borderBottom:'1px solid var(--border)' }}>
                    <td style={{ padding:'8px 12px', fontWeight:500 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <div style={{ width:24, height:24, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 14 : 10, fontWeight:600, flexShrink:0 }}>
                          {p.avatar || (p.name || p.email || '?')[0].toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontSize:11 }}>{p.name || p.email}</div>
                          {weeklyMins > 0 && <div style={{ fontSize:9, color:'var(--text-muted)' }}>{weeklyHrs} hrs/wk</div>}
                        </div>
                      </div>
                    </td>
                    {weekDates.map(date => {
                      const sched = getSchedule(p.id, date)
                      const isToday = date === today
                      return (
                        <td key={date} style={{ padding:'4px 6px', verticalAlign:'top', background: isToday ? 'rgba(59,130,246,.04)' : undefined }}>
                          {sched ? (
                            <div onClick={() => isAdmin && openEdit(p.id, date)}
                              style={{ background: sched.day_type === 'pto' ? '#fef9c3' : sched.day_type === 'sick' ? '#f3f4f6' : (sched.template_color ? sched.template_color + '20' : 'var(--accent-bg)'), border:`1px solid ${sched.day_type === 'pto' ? '#eab308' : sched.day_type === 'sick' ? '#6b7280' : (sched.template_color || 'var(--accent)')}`, borderRadius:'var(--radius)', padding:'5px 7px', cursor: isAdmin ? 'pointer' : 'default', fontSize:10 }}>
                              {sched.day_type === 'pto' ? (
                                <div style={{ fontWeight:600, color:'#a16207' }}>PTO - Full Day</div>
                              ) : sched.day_type === 'sick' ? (
                                <div style={{ fontWeight:600, color:'#374151' }}>Sick - Full Day</div>
                              ) : (
                                <>
                                  <div style={{ fontWeight:600, color:'var(--accent)' }}>{fmt(sched.shift_start)} - {fmt(sched.shift_end)}</div>
                                  {sched.break1_start && <div style={{ color:'var(--text-muted)', marginTop:2 }}>B1: {fmt(sched.break1_start)} ({sched.break1_duration || 15}m)</div>}
                                  {sched.lunch_start && <div style={{ color:'var(--text-muted)' }}>L: {fmt(sched.lunch_start)} ({sched.lunch_duration || 30}m)</div>}
                                  {sched.break2_start && <div style={{ color:'var(--text-muted)' }}>B2: {fmt(sched.break2_start)} ({sched.break2_duration || 15}m)</div>}
                                </>
                              )}
                            </div>
                          ) : (
                            isAdmin ? (
                              <button onClick={() => openEdit(p.id, date)}
                                style={{ width:'100%', padding:'6px', border:'1px dashed var(--border)', borderRadius:'var(--radius)', background:'transparent', color:'var(--text-muted)', cursor:'pointer', fontSize:11 }}>
                                + Add
                              </button>
                            ) : <span style={{ fontSize:10, color:'var(--text-muted)', padding:'4px 6px', display:'block' }}>Off</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* GRAPHICAL TAB */}
      {tab === 'graphical' && (
        <GraphicalSchedule
          profiles={profiles}
          onUpdate={async () => {
            const { data: s } = await sb.from('schedules').select('*').gte('date', weekDates[0]).lte('date', weekDates[6])
            setSchedules(s || [])
          }}
        />
      )}

      {/* ADHERENCE TAB */}
      {tab === 'adherence' && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <button className="btn sm" onClick={prevWeek}>Prev</button>
            <span style={{ fontSize:13, fontWeight:600 }}>
              Week of {new Date(weekDates[0] + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' })} - {new Date(weekDates[6] + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}
            </span>
            <button className="btn sm" onClick={nextWeek}>Next</button>
          </div>
          {profiles.map(p => {
            const pScheds = schedules.filter(s => s.profile_id === p.id)
            const pEvents = statusEvents.filter(e => e.profile_id === p.id)
            if (pScheds.length === 0 && pEvents.length === 0) return null
            const avgAdh = pScheds.length > 0 ? Math.round(pScheds.reduce((sum, s) => {
              const dayEvents = pEvents.filter(e => e.started_at.startsWith(s.date))
              const late = dayEvents.filter(e => !e.adherent).reduce((a, b) => a + (b.duration_seconds || 0), 0)
              return sum + (adherencePct(s, late) || 100)
            }, 0) / pScheds.length) : null
            return (
              <div key={p.id} className="card">
                <div className="card-header">
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 18 : 11, fontWeight:600 }}>
                      {p.avatar || (p.name || p.email || '?')[0].toUpperCase()}
                    </div>
                    <div className="card-title">{p.name || p.email}</div>
                  </div>
                  {avgAdh != null && <span style={{ fontSize:13, fontWeight:700, color: avgAdh >= 90 ? 'var(--success)' : avgAdh >= 75 ? 'var(--warning)' : 'var(--danger)' }}>{avgAdh}% adherence</span>}
                </div>
                <div style={{ overflowX:'auto' }}>
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Scheduled</th><th>Login</th><th>Break 1</th><th>Lunch</th><th>Break 2</th><th>Logout</th><th>Adherence</th></tr></thead>
                    <tbody>
                      {weekDates.map(date => {
                        const sched = getSchedule(p.id, date)
                        const dayEvents = getEvents(p.id, date)
                        const loginEvent = dayEvents.find(e => e.status === 'Available' || e.status === 'On Call')
                        const breakEvents = dayEvents.filter(e => e.status === 'Break')
                        const lunchEvent = dayEvents.find(e => e.status === 'Lunch')
                        const offlineEvent = [...dayEvents].reverse().find(e => e.status === 'Offline')
                        if (!sched && dayEvents.length === 0) return null
                        const lateSeconds = dayEvents.filter(e => !e.adherent).reduce((a, b) => a + (b.duration_seconds || 0), 0)
                        const pct = adherencePct(sched, lateSeconds)
                        const bv = (ev, limit) => ev && ev.duration_seconds > (limit + GRACE) * 60
                        return (
                          <tr key={date}>
                            <td style={{ padding:'8px 12px', fontSize:11 }}>{fmtDate(date)}</td>
                            <td style={{ padding:'8px 12px', fontSize:11 }}>{sched ? `${fmt(sched.shift_start)} - ${fmt(sched.shift_end)}` : <span style={{ color:'var(--text-muted)' }}>--</span>}</td>
                            <td style={{ padding:'8px 12px' }}>{loginEvent ? <span style={{ fontSize:11, color:'var(--success)' }}>{fmtTime(loginEvent.started_at)}</span> : <span style={{ fontSize:11, color:'var(--danger)' }}>No login</span>}</td>
                            <td style={{ padding:'8px 12px' }}>
                              {breakEvents[0] ? <span style={{ fontSize:11, color: bv(breakEvents[0], sched?.break1_duration || 15) ? 'var(--danger)' : 'var(--text-secondary)' }}>{fmtTime(breakEvents[0].started_at)} ({fmtDuration(breakEvents[0].duration_seconds)}){bv(breakEvents[0], sched?.break1_duration || 15) ? ' (!)' : ''}</span> : <span style={{ fontSize:11, color:'var(--text-muted)' }}>--</span>}
                            </td>
                            <td style={{ padding:'8px 12px' }}>
                              {lunchEvent ? <span style={{ fontSize:11, color: bv(lunchEvent, sched?.lunch_duration || 30) ? 'var(--danger)' : 'var(--text-secondary)' }}>{fmtTime(lunchEvent.started_at)} ({fmtDuration(lunchEvent.duration_seconds)}){bv(lunchEvent, sched?.lunch_duration || 30) ? ' (!)' : ''}</span> : <span style={{ fontSize:11, color:'var(--text-muted)' }}>--</span>}
                            </td>
                            <td style={{ padding:'8px 12px' }}>
                              {breakEvents[1] ? <span style={{ fontSize:11, color: bv(breakEvents[1], sched?.break2_duration || 15) ? 'var(--danger)' : 'var(--text-secondary)' }}>{fmtTime(breakEvents[1].started_at)} ({fmtDuration(breakEvents[1].duration_seconds)}){bv(breakEvents[1], sched?.break2_duration || 15) ? ' (!)' : ''}</span> : <span style={{ fontSize:11, color:'var(--text-muted)' }}>--</span>}
                            </td>
                            <td style={{ padding:'8px 12px' }}>{offlineEvent ? <span style={{ fontSize:11 }}>{fmtTime(offlineEvent.started_at)}</span> : <span style={{ fontSize:11, color:'var(--text-muted)' }}>--</span>}</td>
                            <td style={{ padding:'8px 12px' }}>{pct != null ? <span style={{ fontSize:12, fontWeight:700, color: pct >= 90 ? 'var(--success)' : pct >= 75 ? 'var(--warning)' : 'var(--danger)' }}>{pct}%</span> : <span style={{ fontSize:11, color:'var(--text-muted)' }}>--</span>}</td>
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

      {/* POINTS TAB */}
      {tab === 'points' && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <span style={{ fontSize:12, color:'var(--text-muted)' }}>Calendar year {new Date().getFullYear()} - Points reset Jan 1</span>
          </div>
          {profiles.map(p => {
            const pts = attendancePoints.filter(ap => ap.profile_id === p.id)
            const total = pts.reduce((sum, ap) => sum + parseFloat(ap.points), 0)
            return (
              <div key={p.id} className="card">
                <div className="card-header">
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 18 : 11, fontWeight:600 }}>
                      {p.avatar || (p.name || p.email || '?')[0].toUpperCase()}
                    </div>
                    <div className="card-title">{p.name || p.email}</div>
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <span style={{ fontSize:15, fontWeight:700, color: total >= 6 ? 'var(--danger)' : total >= 3 ? 'var(--warning)' : 'var(--success)' }}>
                      {total.toFixed(1)} pts
                    </span>
                    {isAdmin && (
                      <button className="btn sm primary" onClick={() => { setPointModal(p); setPointData({ reason: 'late', points: 0.5, notes: '', date: today }) }}>
                        + Add Point
                      </button>
                    )}
                  </div>
                </div>
                {pts.length > 0 ? (
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Reason</th><th>Points</th><th>Notes</th>{isAdmin && <th>Actions</th>}</tr></thead>
                    <tbody>
                      {pts.map(pt => (
                        <tr key={pt.id}>
                          <td style={{ padding:'8px 12px', fontSize:11 }}>{fmtDate(pt.date)}</td>
                          <td style={{ padding:'8px 12px', fontSize:12 }}>{pt.reason}{pt.auto_generated && <span style={{ fontSize:10, color:'var(--text-muted)', marginLeft:6 }}>(auto)</span>}</td>
                          <td style={{ padding:'8px 12px', fontWeight:700, color: parseFloat(pt.points) >= 1 ? 'var(--danger)' : 'var(--warning)' }}>{parseFloat(pt.points).toFixed(1)}</td>
                          <td style={{ padding:'8px 12px', fontSize:11, color:'var(--text-muted)' }}>{pt.notes || '--'}</td>
                          {isAdmin && <td style={{ padding:'8px 12px' }}><button className="btn sm danger" onClick={() => deletePoint(pt.id)}>Remove</button></td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="card-body" style={{ fontSize:12, color:'var(--text-muted)' }}>No attendance points this year.</div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* REPORTS TAB */}
      {tab === 'reports' && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div className="card">
            <div className="card-header"><div className="card-title">Generate Report</div></div>
            <div className="card-body" style={{ display:'flex', gap:12, alignItems:'flex-end', flexWrap:'wrap' }}>
              <div className="form-field" style={{ margin:0 }}>
                <label className="form-label">Start date</label>
                <input type="date" className="form-input" value={reportRange.start} onChange={e => setReportRange(p => ({ ...p, start: e.target.value }))} />
              </div>
              <div className="form-field" style={{ margin:0 }}>
                <label className="form-label">End date</label>
                <input type="date" className="form-input" value={reportRange.end} onChange={e => setReportRange(p => ({ ...p, end: e.target.value }))} />
              </div>
              <button className="btn primary" onClick={runReport} disabled={!reportRange.start || !reportRange.end}>Run report</button>
              {reportData && <button className="btn success" onClick={exportReport}>Export CSV</button>}
            </div>
          </div>
          {reportData && (
            <div className="card">
              <div className="card-header"><div className="card-title">Summary - {reportRange.start} to {reportRange.end}</div></div>
              <table className="data-table">
                <thead><tr><th>Agent</th><th style={{ textAlign:'center' }}>Days Sched.</th><th style={{ textAlign:'center' }}>Att. Points</th><th style={{ textAlign:'center' }}>Avg Adherence</th><th style={{ textAlign:'center' }}>Break Viol.</th><th style={{ textAlign:'center' }}>Lunch Viol.</th></tr></thead>
                <tbody>
                  {reportData.map(r => (
                    <tr key={r.profile.id}>
                      <td style={{ padding:'10px 12px', fontWeight:500 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <div style={{ width:24, height:24, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: r.profile.avatar ? 14 : 10, fontWeight:600 }}>
                            {r.profile.avatar || (r.profile.name || r.profile.email || '?')[0].toUpperCase()}
                          </div>
                          {r.profile.name || r.profile.email}
                        </div>
                      </td>
                      <td style={{ padding:'10px 12px', textAlign:'center' }}>{r.daysScheduled}</td>
                      <td style={{ padding:'10px 12px', textAlign:'center', fontWeight:700, color: r.totalPoints >= 6 ? 'var(--danger)' : r.totalPoints >= 3 ? 'var(--warning)' : 'var(--success)' }}>{r.totalPoints.toFixed(1)}</td>
                      <td style={{ padding:'10px 12px', textAlign:'center', fontWeight:700, color: r.avgAdherence == null ? 'var(--text-muted)' : r.avgAdherence >= 90 ? 'var(--success)' : r.avgAdherence >= 75 ? 'var(--warning)' : 'var(--danger)' }}>{r.avgAdherence != null ? r.avgAdherence + '%' : '--'}</td>
                      <td style={{ padding:'10px 12px', textAlign:'center', color: r.breakViolations > 0 ? 'var(--danger)' : 'var(--text-secondary)', fontWeight: r.breakViolations > 0 ? 600 : 400 }}>{r.breakViolations}</td>
                      <td style={{ padding:'10px 12px', textAlign:'center', color: r.lunchViolations > 0 ? 'var(--danger)' : 'var(--text-secondary)', fontWeight: r.lunchViolations > 0 ? 600 : 400 }}>{r.lunchViolations}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* SCHEDULE EDIT MODAL */}
      {editCell && (
        <Modal title={`Schedule - ${profiles.find(p => p.id === editCell.profileId)?.name || 'Agent'} - ${fmtDate(editCell.date)}`} onClose={() => setEditCell(null)} width={500}>
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            {templates.length > 0 && (
              <div className="form-field">
                <label className="form-label">Apply template</label>
                <select className="form-input" onChange={e => e.target.value && applyTemplate(e.target.value)} defaultValue="">
                  <option value="">Select a template...</option>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            )}
            <div className="form-field">
              <label className="form-label">Day type</label>
              <select className="form-input" value={editData.day_type || 'work'} onChange={e => setEditData(p => ({ ...p, day_type: e.target.value }))}>
                <option value="work">Working</option>
                <option value="pto">PTO - Full Day</option>
                <option value="sick">Sick - Full Day</option>
                <option value="off">Off</option>
              </select>
            </div>
            {(!editData.day_type || editData.day_type === 'work') && (
              <div className="form-field"><label className="form-label">Shift start</label><input type="time" className="form-input" value={editData.shift_start || ''} onChange={e => setEditData(p => ({ ...p, shift_start: e.target.value }))} /></div>
              <div className="form-field"><label className="form-label">Shift end</label><input type="time" className="form-input" value={editData.shift_end || ''} onChange={e => setEditData(p => ({ ...p, shift_end: e.target.value }))} /></div>
            </div>
            <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)' }}>Break 1</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <div className="form-field"><label className="form-label">Start time</label><input type="time" className="form-input" value={editData.break1_start || ''} onChange={e => setEditData(p => ({ ...p, break1_start: e.target.value }))} /></div>
              <div className="form-field"><label className="form-label">Duration (min)</label><input type="number" className="form-input" value={editData.break1_duration || 15} min={5} max={30} onChange={e => setEditData(p => ({ ...p, break1_duration: parseInt(e.target.value) }))} /></div>
            </div>
            <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)' }}>Lunch</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <div className="form-field"><label className="form-label">Start time</label><input type="time" className="form-input" value={editData.lunch_start || ''} onChange={e => setEditData(p => ({ ...p, lunch_start: e.target.value }))} /></div>
              <div className="form-field"><label className="form-label">Duration (min)</label><select className="form-input" value={editData.lunch_duration || 30} onChange={e => setEditData(p => ({ ...p, lunch_duration: parseInt(e.target.value) }))}><option value={30}>30 min</option><option value={60}>60 min</option></select></div>
            </div>
            <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)' }}>Break 2</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <div className="form-field"><label className="form-label">Start time</label><input type="time" className="form-input" value={editData.break2_start || ''} onChange={e => setEditData(p => ({ ...p, break2_start: e.target.value }))} /></div>
              <div className="form-field"><label className="form-label">Duration (min)</label><input type="number" className="form-input" value={editData.break2_duration || 15} min={5} max={30} onChange={e => setEditData(p => ({ ...p, break2_duration: parseInt(e.target.value) }))} /></div>
            </div>
            )}
          </div>
          <div className="modal-actions">
            {getSchedule(editCell.profileId, editCell.date) && <button className="btn danger" onClick={() => deleteSchedule(editCell.profileId, editCell.date)}>Delete</button>}
            <button className="btn" onClick={() => setEditCell(null)}>Cancel</button>
            <button className="btn primary" onClick={saveSchedule} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        </Modal>
      )}

      {/* BULK SCHEDULE MODAL */}
      {bulkModal && (
        <Modal title="Bulk Schedule" onClose={() => setBulkModal(false)} width={520}>
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div className="form-field">
              <label className="form-label">Select template</label>
              <select className="form-input" value={bulkData.templateId} onChange={e => setBulkData(p => ({ ...p, templateId: e.target.value }))}>
                <option value="">Choose template...</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label" style={{ marginBottom:8, display:'block' }}>Select agents</label>
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {profiles.map(p => (
                  <label key={p.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', background:'var(--surface-2)', borderRadius:'var(--radius)', cursor:'pointer' }}>
                    <input type="checkbox" checked={bulkData.profileIds.includes(p.id)} onChange={e => setBulkData(prev => ({ ...prev, profileIds: e.target.checked ? [...prev.profileIds, p.id] : prev.profileIds.filter(id => id !== p.id) }))} />
                    <div style={{ width:20, height:20, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 12 : 9, fontWeight:600 }}>{p.avatar || (p.name || p.email || '?')[0].toUpperCase()}</div>
                    <span style={{ fontSize:13 }}>{p.name || p.email}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="form-label" style={{ marginBottom:8, display:'block' }}>Select days</label>
              <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                {weekDates.map(date => {
                  const d = new Date(date + 'T12:00:00')
                  return (
                    <label key={date} style={{ display:'flex', alignItems:'center', gap:4, padding:'5px 10px', background: bulkData.dates.includes(date) ? 'var(--accent-bg)' : 'var(--surface-2)', border: `1px solid ${bulkData.dates.includes(date) ? 'var(--accent)' : 'var(--border)'}`, borderRadius:99, cursor:'pointer', fontSize:12 }}>
                      <input type="checkbox" style={{ display:'none' }} checked={bulkData.dates.includes(date)} onChange={e => setBulkData(prev => ({ ...prev, dates: e.target.checked ? [...prev.dates, date] : prev.dates.filter(d => d !== date) }))} />
                      {DAYS[d.getDay()]} {d.getDate()}
                    </label>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setBulkModal(false)}>Cancel</button>
            <button className="btn primary" onClick={applyBulkSchedule} disabled={saving || !bulkData.templateId || bulkData.profileIds.length === 0 || bulkData.dates.length === 0}>
              {saving ? 'Applying...' : `Apply to ${bulkData.profileIds.length} agents, ${bulkData.dates.length} days`}
            </button>
          </div>
        </Modal>
      )}

      {/* TEMPLATES MODAL */}
      {templateModal && (
        <Modal title="Shift Templates" onClose={() => setTemplateModal(false)} width={560}>
          <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:16 }}>
            {templates.map(t => (
              <div key={t.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px', background:'var(--surface-2)', borderRadius:'var(--radius)', border:'1px solid var(--border)' }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ width:12, height:12, borderRadius:'50%', background: t.color || '#3b82f6', flexShrink:0 }}></div>
                    <div style={{ fontSize:13, fontWeight:600 }}>{t.name}</div>
                  </div>
                  <div style={{ fontSize:11, color:'var(--text-muted)' }}>{fmt(t.shift_start)} - {fmt(t.shift_end)} | B1: {fmt(t.break1_start)} ({t.break1_duration || 15}m) | L: {fmt(t.lunch_start)} ({t.lunch_duration || 30}m) | B2: {fmt(t.break2_start)} ({t.break2_duration || 15}m)</div>
                </div>
                <button className="btn sm" onClick={() => setEditTemplate({ ...t })}>Edit</button>
                <button className="btn sm danger" onClick={() => deleteTemplate(t.id)}>Del</button>
              </div>
            ))}
            {templates.length < 5 && (
              <button className="btn sm primary" onClick={() => setEditTemplate({ name:'', shift_start:'08:00', shift_end:'17:00', break1_start:'10:00', break1_duration:15, lunch_start:'12:00', lunch_duration:30, break2_start:'14:30', break2_duration:15 })}>
                + New Template
              </button>
            )}
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setTemplateModal(false)}>Close</button>
          </div>
        </Modal>
      )}

      {/* EDIT TEMPLATE MODAL */}
      {editTemplate && (
        <Modal title={editTemplate.id ? 'Edit Template' : 'New Template'} onClose={() => setEditTemplate(null)} width={480}>
          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
            <div style={{ display:'grid', gridTemplateColumns:'1fr auto', gap:10, alignItems:'end' }}>
              <div className="form-field"><label className="form-label">Template name</label><input className="form-input" value={editTemplate.name || ''} onChange={e => setEditTemplate(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Standard 8-5" /></div>
              <div className="form-field">
                <label className="form-label">Color</label>
                <input type="color" value={editTemplate.color || '#3b82f6'} onChange={e => setEditTemplate(p => ({ ...p, color: e.target.value }))} style={{ width:44, height:36, padding:2, borderRadius:'var(--radius)', border:'1px solid var(--border)', cursor:'pointer' }} />
              </div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <div className="form-field"><label className="form-label">Shift start</label><input type="time" className="form-input" value={editTemplate.shift_start || ''} onChange={e => setEditTemplate(p => ({ ...p, shift_start: e.target.value }))} /></div>
              <div className="form-field"><label className="form-label">Shift end</label><input type="time" className="form-input" value={editTemplate.shift_end || ''} onChange={e => setEditTemplate(p => ({ ...p, shift_end: e.target.value }))} /></div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <div className="form-field"><label className="form-label">Break 1 start</label><input type="time" className="form-input" value={editTemplate.break1_start || ''} onChange={e => setEditTemplate(p => ({ ...p, break1_start: e.target.value }))} /></div>
              <div className="form-field"><label className="form-label">Break 1 duration</label><input type="number" className="form-input" value={editTemplate.break1_duration || 15} onChange={e => setEditTemplate(p => ({ ...p, break1_duration: parseInt(e.target.value) }))} /></div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <div className="form-field"><label className="form-label">Lunch start</label><input type="time" className="form-input" value={editTemplate.lunch_start || ''} onChange={e => setEditTemplate(p => ({ ...p, lunch_start: e.target.value }))} /></div>
              <div className="form-field"><label className="form-label">Lunch duration</label><select className="form-input" value={editTemplate.lunch_duration || 30} onChange={e => setEditTemplate(p => ({ ...p, lunch_duration: parseInt(e.target.value) }))}><option value={30}>30 min</option><option value={60}>60 min</option></select></div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <div className="form-field"><label className="form-label">Break 2 start</label><input type="time" className="form-input" value={editTemplate.break2_start || ''} onChange={e => setEditTemplate(p => ({ ...p, break2_start: e.target.value }))} /></div>
              <div className="form-field"><label className="form-label">Break 2 duration</label><input type="number" className="form-input" value={editTemplate.break2_duration || 15} onChange={e => setEditTemplate(p => ({ ...p, break2_duration: parseInt(e.target.value) }))} /></div>
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setEditTemplate(null)}>Cancel</button>
            <button className="btn primary" onClick={saveTemplate} disabled={saving || !editTemplate.name}>{saving ? 'Saving...' : 'Save template'}</button>
          </div>
        </Modal>
      )}

      {/* ADD POINT MODAL */}
      {pointModal && (
        <Modal title={`Add Attendance Point - ${pointModal.name || pointModal.email}`} onClose={() => setPointModal(null)} width={440}>
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div className="form-field">
              <label className="form-label">Date</label>
              <input type="date" className="form-input" value={pointData.date} onChange={e => setPointData(p => ({ ...p, date: e.target.value }))} />
            </div>
            <div className="form-field">
              <label className="form-label">Reason</label>
              <select className="form-input" value={pointData.reason} onChange={e => {
                const r = POINT_REASONS.find(r => r.value === e.target.value)
                setPointData(p => ({ ...p, reason: e.target.value, points: r?.points || p.points }))
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

      {/* PUBLISH MODAL */}
      {publishModal && !publishResult && (
        <Modal title="Publish Schedule + Send Emails" onClose={() => setPublishModal(false)} width={480}>
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div style={{ background:'var(--accent-bg)', border:'1px solid var(--accent)', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:13 }}>
              <strong>Week of {new Date(weekDates[0] + 'T12:00:00').toLocaleDateString('en-US', { month:'long', day:'numeric' })} - {new Date(weekDates[6] + 'T12:00:00').toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })}</strong>
            </div>
            <div style={{ fontSize:13, color:'var(--text-secondary)' }}>
              This will send schedule emails to the following agents:
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
              {profiles.filter(p => weekDates.some(d => getSchedule(p.id, d))).map(p => (
                <div key={p.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', background:'var(--surface-2)', borderRadius:'var(--radius)', fontSize:12 }}>
                  <div style={{ width:20, height:20, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 12 : 9, fontWeight:600 }}>{p.avatar || (p.name || p.email || '?')[0].toUpperCase()}</div>
                  <span style={{ flex:1 }}>{p.name || p.email}</span>
                  <span style={{ color:'var(--text-muted)', fontSize:11 }}>{p.email}</span>
                </div>
              ))}
            </div>
            {profiles.filter(p => weekDates.some(d => getSchedule(p.id, d))).length === 0 && (
              <div style={{ color:'var(--danger)', fontSize:13 }}>No schedules set for this week. Add schedules first.</div>
            )}
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setPublishModal(false)}>Cancel</button>
            <button className="btn primary" onClick={publishSchedule} disabled={publishing || profiles.filter(p => weekDates.some(d => getSchedule(p.id, d))).length === 0}>
              {publishing ? 'Sending...' : 'Publish and Send Emails'}
            </button>
          </div>
        </Modal>
      )}

      {/* PUBLISH RESULT MODAL */}
      {publishResult && (
        <Modal title="Schedule Published!" onClose={() => { setPublishModal(false); setPublishResult(null) }} width={440}>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {publishResult.map((r, i) => (
              <div key={i} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background: r.success ? 'var(--success-bg)' : 'var(--danger-bg)', borderRadius:'var(--radius)', fontSize:13 }}>
                <span>{r.success ? 'v' : 'x'}</span>
                <span style={{ flex:1 }}>{r.name}</span>
                <span style={{ fontSize:11, color:'var(--text-muted)' }}>{r.success ? 'Email sent' : r.error}</span>
              </div>
            ))}
          </div>
          <div className="modal-actions">
            <button className="btn primary" onClick={() => { setPublishModal(false); setPublishResult(null) }}>Done</button>
          </div>
        </Modal>
      )}

      {/* COPY WEEK MODAL */}
      {copyModal && (
        <Modal title="Copy Week to Next Week" onClose={() => setCopyModal(false)} width={400}>
          <div style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:16 }}>
            This will copy all schedules from the current week to next week. Existing schedules for next week will be overwritten.
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setCopyModal(false)}>Cancel</button>
            <button className="btn primary" onClick={copyWeek}>Copy to next week</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
