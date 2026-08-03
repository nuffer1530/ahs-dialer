import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { confirmDlg, toast } from '../lib/dialogs'
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

  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('tab') || 'schedule')
  // Survive hard refresh: the active tab lives in the URL (?tab=), like MyPage.
  useEffect(() => {
    const u = new URL(window.location)
    if (u.searchParams.get('tab') !== tab) { u.searchParams.set('tab', tab); window.history.replaceState({}, '', u) }
  }, [tab])
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
  const [bulkCfg, setBulkCfg] = useState({ all: false, ids: [], templateId: '', days: [0,1,2,3,4], overwrite: false })
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkResult, setBulkResult] = useState(null)
  const [templateModal, setTemplateModal] = useState(false)
  const [editTemplate, setEditTemplate] = useState(null)
  const [publishModal, setPublishModal] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState(null)
  const [pubSel, setPubSel] = useState({ all: true, ids: [] })
  const [pubEmail, setPubEmail] = useState(true)   // uncheck to publish quietly
  const [pointModal, setPointModal] = useState(null)
  const [pointData, setPointData] = useState({ reason: 'late', points: 0.5, notes: '', date: new Date().toISOString().split('T')[0] })
  const [reportRange, setReportRange] = useState({ start: '', end: '' })
  const [reportData, setReportData] = useState(null)
  const [copyModal, setCopyModal] = useState(false)
  const [copyCfg, setCopyCfg] = useState({ offset: 1, all: true, ids: [], overwrite: false })
  const [copyBusy, setCopyBusy] = useState(false)
  const [copyResult, setCopyResult] = useState(null)
  const [tplBusy, setTplBusy] = useState(false)

  const weekDates = getWeekDates(weekBase)
  const today = new Date().toISOString().split('T')[0]

  useEffect(() => {
    const load = async () => {
      const [{ data: p }, { data: s }, { data: ev }, { data: t }, { data: ap }] = await Promise.all([
        sb.from('profiles').select('id, name, email, avatar').eq('active', true).order('name'),
        // Window must COVER THE VISIBLE WEEK — the old fixed today±30 threw
        // away weeks navigated past it: shifts saved fine, then vanished from
        // the grid, and re-adds died on the invisible row's unique constraint.
        sb.from('schedules').select('*')
          .gte('date', (() => { const d = new Date(); d.setDate(d.getDate()-30); const s = d.toISOString().split('T')[0]; return s < weekDates[0] ? s : weekDates[0] })())
          .lte('date', (() => { const d = new Date(); d.setDate(d.getDate()+30); const s = d.toISOString().split('T')[0]; return s > weekDates[6] ? s : weekDates[6] })()),
        sb.from('status_events').select('*').gte('started_at', weekDates[0] + 'T00:00:00').lte('started_at', weekDates[6] + 'T23:59:59'),
        sb.from('shift_templates').select('*').order('name'),
        sb.from('attendance_points').select('*').gte('date', new Date().getFullYear() + '-01-01').order('date', { ascending: false }),
      ])
      setProfiles(p || []); setSchedules(s || []); setStatusEvents(ev || [])
      setTemplates(t || []); setAttendancePoints(ap || []); setLoading(false)
    }
    load()
  }, [weekBase])

  const reloadSchedules = async () => {
    const from = new Date(); from.setDate(from.getDate() - 30)
    const to = new Date(); to.setDate(to.getDate() + 30)
    const lo = toYMD(from) < weekDates[0] ? toYMD(from) : weekDates[0]
    const hi = toYMD(to) > weekDates[6] ? toYMD(to) : weekDates[6]
    const { data } = await sb.from('schedules').select('*').gte('date', lo).lte('date', hi)
    setSchedules(data || [])
  }

  const saveTemplate = async () => {
    const t = editTemplate
    if (!t?.name?.trim() || tplBusy) return
    setTplBusy(true)
    const payload = {
      name: t.name.trim(), shift_start: t.shift_start || '08:00', shift_end: t.shift_end || '17:00',
      break1_start: t.break1_start || null, break1_duration: t.break1_start ? (Number(t.break1_duration) || 15) : null,
      break2_start: t.break2_start || null, break2_duration: t.break2_start ? (Number(t.break2_duration) || 15) : null,
      lunch_start: t.lunch_start || null, lunch_duration: t.lunch_start ? (Number(t.lunch_duration) || 30) : null,
      color: t.color || null,
    }
    if (t.id) {
      const { data } = await sb.from('shift_templates').update(payload).eq('id', t.id).select().single()
      if (data) setTemplates(prev => prev.map(x => x.id === t.id ? data : x))
    } else {
      const { data } = await sb.from('shift_templates').insert(payload).select().single()
      if (data) setTemplates(prev => [...prev, data].sort((a, b) => (a.name || '').localeCompare(b.name || '')))
    }
    setTplBusy(false); setEditTemplate(null)
  }

  const deleteTemplate = async (id) => {
    if (!(await confirmDlg('Delete this template? Days already scheduled with it keep their times.', { title: 'Delete template', confirmLabel: 'Delete', danger: true }))) return
    await sb.from('shift_templates').delete().eq('id', id)
    setTemplates(prev => prev.filter(t => t.id !== id))
  }

  const copyWeek = async () => {
    if (copyBusy) return
    const targets = copyCfg.all ? profiles.map(p => p.id) : copyCfg.ids
    if (!targets.length) { setCopyResult({ error: 'Pick at least one person.' }); return }
    setCopyBusy(true); setCopyResult(null)
    const srcDates = weekDates.map(d => {
      const dt = new Date(d + 'T12:00:00'); dt.setDate(dt.getDate() - 7 * copyCfg.offset); return toYMD(dt)
    })
    const [{ data: srcRows }, { data: destRows }] = await Promise.all([
      sb.from('schedules').select('*').gte('date', srcDates[0]).lte('date', srcDates[6]),
      sb.from('schedules').select('*').gte('date', weekDates[0]).lte('date', weekDates[6]),
    ])
    let copied = 0, skipped = 0
    for (const pid of targets) {
      for (let i = 0; i < 7; i++) {
        const src = (srcRows || []).find(r => r.profile_id === pid && r.date === srcDates[i])
        if (!src) continue
        const dest = (destRows || []).find(r => r.profile_id === pid && r.date === weekDates[i])
        if (dest && !copyCfg.overwrite) { skipped++; continue }
        const { id, created_at, updated_at, published_at, ...fields } = src
        const payload = { ...fields, date: weekDates[i] }
        const draft = { ...payload, published_at: null }   // copies land as drafts
        if (dest) {
          const { error: e1 } = await sb.from('schedules').update(draft).eq('id', dest.id)
          if (e1) await sb.from('schedules').update(payload).eq('id', dest.id)
        } else {
          const { error: e2 } = await sb.from('schedules').insert(draft)
          if (e2) await sb.from('schedules').insert(payload)
        }
        copied++
      }
    }
    await reloadSchedules()
    setCopyBusy(false)
    setCopyResult({ ok: `Copied ${copied} day${copied === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped (already scheduled)` : ''}` })
  }

  const bulkApply = async () => {
    if (bulkBusy) return
    const t = templates.find(x => x.id === bulkCfg.templateId)
    if (!t) { setBulkResult({ error: 'Pick a template.' }); return }
    const targets = bulkCfg.all ? profiles.map(p => p.id) : bulkCfg.ids
    if (!targets.length) { setBulkResult({ error: 'Pick at least one person.' }); return }
    const dates = weekDates.filter((_, i) => bulkCfg.days.includes(i))
    if (!dates.length) { setBulkResult({ error: 'Pick at least one day.' }); return }
    setBulkBusy(true); setBulkResult(null)
    const { data: destRows } = await sb.from('schedules').select('*').gte('date', weekDates[0]).lte('date', weekDates[6])
    let applied = 0, skipped = 0
    for (const pid of targets) {
      for (const date of dates) {
        const dest = (destRows || []).find(r => r.profile_id === pid && r.date === date)
        if (dest && !bulkCfg.overwrite) { skipped++; continue }
        const payload = {
          profile_id: pid, date, day_type: 'work',
          shift_start: t.shift_start || '08:00', shift_end: t.shift_end || '17:00',
          break1_start: t.break1_start || null, break1_duration: t.break1_duration || null,
          break2_start: t.break2_start || null, break2_duration: t.break2_duration || null,
          lunch_start: t.lunch_start || null, lunch_duration: t.lunch_duration || null,
          template_color: t.color || null,
        }
        const draft = { ...payload, published_at: null }   // bulk fills land as drafts
        if (dest) {
          const { error: e1 } = await sb.from('schedules').update(draft).eq('id', dest.id)
          if (e1) await sb.from('schedules').update(payload).eq('id', dest.id)
        } else {
          const { error: e2 } = await sb.from('schedules').insert(draft)
          if (e2) await sb.from('schedules').insert(payload)
        }
        applied++
      }
    }
    await reloadSchedules()
    setBulkBusy(false)
    setBulkResult({ ok: `Scheduled ${applied} day${applied === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped (already scheduled)` : ''}` })
  }

  const publishSchedules = async () => {
    if (publishing) return
    if (!pubSel.all && !pubSel.ids.length) { setPublishResult({ error: 'Pick at least one person.' }); return }
    setPublishing(true); setPublishResult(null)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const r = await fetch('/api/schedule/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ weekStart: weekDates[0], profileIds: pubSel.all ? 'all' : pubSel.ids, sendEmails: pubEmail, from: profile?.name || profile?.email || 'your manager' }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Publish failed')
      setPublishResult(d)
      await reloadSchedules()   // drafts just went solid — repaint the grid
    } catch (e) {
      setPublishResult({ error: e.message })
    } finally { setPublishing(false) }
  }

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
    // UPSERT on (profile_id,date): the grid's state can miss rows that exist
    // (other tabs, other admins), and a blind insert dies silently on the
    // unique constraint. Errors surface as a toast instead of vanishing.
    const draft = { ...payload, published_at: null }   // any hand edit reverts to draft
    let { error } = await sb.from('schedules').upsert(draft, { onConflict: 'profile_id,date' })
    if (error) ({ error } = await sb.from('schedules').upsert(payload, { onConflict: 'profile_id,date' }))
    if (error) toast(`Could not save the shift: ${error.message}`)
    await reloadSchedules()
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
                          // Draft = saved but not published: reps can't see it
                          // yet, so it wears the When-I-Work hatching here.
                          const isDraft = sched && 'published_at' in sched && !sched.published_at
                          const hatch = isDraft ? {
                            backgroundImage: 'repeating-linear-gradient(45deg, rgba(127,127,127,.22) 0 5px, transparent 5px 11px)',
                            borderStyle: 'dashed',
                          } : {}
                          // Shift cells wear their template's color (Brittany:
                          // "colors do not populate for shifts").
                          const tc = !isOff ? sched?.template_color : null
                          return (
                            <td key={date} style={{ padding:6, borderLeft:'1px solid var(--border)', background: isToday ? 'var(--accent-bg)' : 'transparent', verticalAlign:'top' }}>
                              {sched && !isOff ? (
                                <div onClick={() => isAdmin && openEdit(p.id, date)}
                                  title={isDraft ? 'Draft — not published or emailed yet' : undefined}
                                  style={{ padding:'8px 10px', borderRadius:'var(--radius)', background: tc ? `${tc}26` : 'var(--success-bg)', border:`1px solid ${tc || 'var(--success)'}`, cursor: isAdmin ? 'pointer' : 'default', transition:'all .1s', ...hatch }}
                                  onMouseEnter={e => { if(isAdmin) e.currentTarget.style.opacity='.8' }}
                                  onMouseLeave={e => e.currentTarget.style.opacity='1'}>
                                  <div style={{ fontSize:11, fontWeight:600, color: tc || 'var(--success)' }}>{fmt(sched.shift_start)} – {fmt(sched.shift_end)}</div>
                                  {sched.lunch_start && <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:2 }}>Lunch {fmt(sched.lunch_start)}</div>}
                                  {isDraft && <div style={{ fontSize:9, fontWeight:800, letterSpacing:.5, color:'var(--text-muted)', marginTop:2 }}>DRAFT</div>}
                                </div>
                              ) : sched && isOff ? (
                                <div onClick={() => isAdmin && openEdit(p.id, date)}
                                  title={isDraft ? 'Draft — not published or emailed yet' : undefined}
                                  style={{ padding:'8px 10px', borderRadius:'var(--radius)', background: typeColor + '18', border:`1px solid ${typeColor}`, cursor: isAdmin ? 'pointer' : 'default', ...hatch }}>
                                  <div style={{ fontSize:11, fontWeight:600, color: typeColor }}>{DAY_TYPE_LABELS[sched.day_type]}</div>
                                  {isDraft && <div style={{ fontSize:9, fontWeight:800, letterSpacing:.5, color:'var(--text-muted)', marginTop:2 }}>DRAFT</div>}
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

      {/* ── TEMPLATES MODAL ── */}
      {templateModal && (
        <Modal title={editTemplate ? (editTemplate.id ? 'Edit Template' : 'New Template') : 'Shift Templates'}
          onClose={() => { setTemplateModal(false); setEditTemplate(null) }} width={520}>
          {!editTemplate ? (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {templates.length === 0 && <div style={{ fontSize:13, color:'var(--text-muted)' }}>No templates yet — create one and the Bulk Schedule and day-editor pickers will offer it.</div>}
              {templates.map(t => (
                <div key={t.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', border:'1px solid var(--border)', borderRadius:'var(--radius)' }}>
                  <span style={{ width:14, height:14, borderRadius:4, background:t.color || 'var(--surface-2)', border:'1px solid var(--border)', flexShrink:0 }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:600 }}>{t.name}</div>
                    <div style={{ fontSize:11.5, color:'var(--text-muted)' }}>
                      {fmt(t.shift_start)} – {fmt(t.shift_end)}
                      {t.lunch_start ? ` · Lunch ${fmt(t.lunch_start)}` : ''}
                    </div>
                  </div>
                  <button className="btn sm" onClick={() => setEditTemplate({ ...t })}>Edit</button>
                  <button className="btn sm" onClick={() => deleteTemplate(t.id)} style={{ color:'var(--tone-red-tx)' }}>Delete</button>
                </div>
              ))}
              <button className="btn primary" onClick={() => setEditTemplate({ shift_start:'08:00', shift_end:'17:00', break1_start:'10:00', break1_duration:15, lunch_start:'12:00', lunch_duration:30, break2_start:'14:30', break2_duration:15 })}>
                + New template
              </button>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              <div className="form-field">
                <label className="form-label">Name</label>
                <input className="form-input" autoFocus value={editTemplate.name || ''} placeholder="Early shift"
                  onChange={e => setEditTemplate(t => ({ ...t, name: e.target.value }))} />
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                <div className="form-field">
                  <label className="form-label">Shift start</label>
                  <input type="time" className="form-input" value={editTemplate.shift_start || ''} onChange={e => setEditTemplate(t => ({ ...t, shift_start: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label className="form-label">Shift end</label>
                  <input type="time" className="form-input" value={editTemplate.shift_end || ''} onChange={e => setEditTemplate(t => ({ ...t, shift_end: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label className="form-label">Break 1</label>
                  <input type="time" className="form-input" value={editTemplate.break1_start || ''} onChange={e => setEditTemplate(t => ({ ...t, break1_start: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label className="form-label">Lunch</label>
                  <input type="time" className="form-input" value={editTemplate.lunch_start || ''} onChange={e => setEditTemplate(t => ({ ...t, lunch_start: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label className="form-label">Break 2</label>
                  <input type="time" className="form-input" value={editTemplate.break2_start || ''} onChange={e => setEditTemplate(t => ({ ...t, break2_start: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label className="form-label">Color</label>
                  <div style={{ display:'flex', gap:6, alignItems:'center', paddingTop:4 }}>
                    {['#DBEAFE','var(--tone-green-bg)','#FEF3C7','#FCE7F3','#EDE9FE','#FFEDD5'].map(c => (
                      <button key={c} type="button" onClick={() => setEditTemplate(t => ({ ...t, color: c }))}
                        style={{ width:22, height:22, borderRadius:6, background:c, cursor:'pointer', border: editTemplate.color === c ? '2px solid var(--accent)' : '1px solid var(--border)' }} />
                    ))}
                  </div>
                </div>
              </div>
              <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
                <button className="btn" onClick={() => setEditTemplate(null)}>Back</button>
                <button className="btn primary" onClick={saveTemplate} disabled={tplBusy || !editTemplate.name?.trim()}>
                  {tplBusy ? 'Saving…' : 'Save template'}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* ── COPY WEEK MODAL ── */}
      {copyModal && (
        <Modal title={`Copy Week → week of ${fmtDate(weekDates[0])}`} onClose={() => { setCopyModal(false); setCopyResult(null) }} width={440}>
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div className="form-field">
              <label className="form-label">Copy from</label>
              <select className="form-input" value={copyCfg.offset} onChange={e => setCopyCfg(c => ({ ...c, offset: Number(e.target.value) }))}>
                {[1,2,3,4].map(n => <option key={n} value={n}>{n === 1 ? 'Last week' : `${n} weeks ago`} (week of {fmtDate(toYMD(new Date(new Date(weekDates[0] + 'T12:00:00').getTime() - n * 7 * 86400000)))})</option>)}
              </select>
            </div>
            <div className="form-field">
              <label className="form-label">Who</label>
              <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, fontWeight:600, cursor:'pointer', padding:'6px 2px' }}>
                <input type="checkbox" checked={copyCfg.all} onChange={e => setCopyCfg(c => ({ ...c, all: e.target.checked }))} />
                Everyone on the floor
              </label>
              {!copyCfg.all && (
                <div style={{ maxHeight:160, overflowY:'auto', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'4px 8px', display:'flex', flexDirection:'column' }}>
                  {profiles.map(p => (
                    <label key={p.id} style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer', padding:'5px 2px' }}>
                      <input type="checkbox" checked={copyCfg.ids.includes(p.id)}
                        onChange={e => setCopyCfg(prev => ({ ...prev, ids: e.target.checked ? [...prev.ids, p.id] : prev.ids.filter(x => x !== p.id) }))} />
                      {p.name || p.email}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:12.5, cursor:'pointer' }}>
              <input type="checkbox" checked={copyCfg.overwrite} onChange={e => setCopyCfg(c => ({ ...c, overwrite: e.target.checked }))} />
              Overwrite days that already have a schedule
            </label>
            {copyResult?.error && <div style={{ fontSize:12.5, fontWeight:700, color:'var(--tone-red-tx)' }}>{copyResult.error}</div>}
            {copyResult?.ok && <div style={{ fontSize:12.5, fontWeight:600, color:'var(--success)' }}>✓ {copyResult.ok}</div>}
            <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
              <button className="btn" onClick={() => { setCopyModal(false); setCopyResult(null) }}>{copyResult?.ok ? 'Done' : 'Cancel'}</button>
              <button className="btn primary" onClick={copyWeek} disabled={copyBusy || (!copyCfg.all && !copyCfg.ids.length)}>
                {copyBusy ? 'Copying…' : 'Copy week'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── BULK SCHEDULE MODAL ── */}
      {bulkModal && (
        <Modal title={`Bulk Schedule — week of ${fmtDate(weekDates[0])}`} onClose={() => { setBulkModal(false); setBulkResult(null) }} width={460}>
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div className="form-field">
              <label className="form-label">Template</label>
              <select className="form-input" value={bulkCfg.templateId} onChange={e => setBulkCfg(c => ({ ...c, templateId: e.target.value }))}>
                <option value="">Pick a template…</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name} ({fmt(t.shift_start)} – {fmt(t.shift_end)})</option>)}
              </select>
              {templates.length === 0 && <div style={{ fontSize:11.5, color:'var(--tone-amber-tx)', marginTop:4 }}>No templates yet — create one under Templates first.</div>}
            </div>
            <div className="form-field">
              <label className="form-label">Days</label>
              <div style={{ display:'flex', gap:4 }}>
                {weekDates.map((d, i) => {
                  const on = bulkCfg.days.includes(i)
                  return (
                    <button key={d} type="button"
                      onClick={() => setBulkCfg(c => ({ ...c, days: on ? c.days.filter(x => x !== i) : [...c.days, i] }))}
                      style={{ flex:1, padding:'6px 0', fontSize:11.5, fontWeight:600, borderRadius:'var(--radius)', cursor:'pointer',
                        border: on ? '1px solid var(--accent)' : '1px solid var(--border)',
                        background: on ? 'var(--accent)' : 'var(--surface-2)', color: on ? '#fff' : 'var(--text-secondary)' }}>
                      {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i]}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="form-field">
              <label className="form-label">Who</label>
              <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, fontWeight:600, cursor:'pointer', padding:'6px 2px' }}>
                <input type="checkbox" checked={bulkCfg.all} onChange={e => setBulkCfg(c => ({ ...c, all: e.target.checked }))} />
                Everyone on the floor
              </label>
              {!bulkCfg.all && (
                <div style={{ maxHeight:150, overflowY:'auto', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'4px 8px', display:'flex', flexDirection:'column' }}>
                  {profiles.map(p => (
                    <label key={p.id} style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer', padding:'5px 2px' }}>
                      <input type="checkbox" checked={bulkCfg.ids.includes(p.id)}
                        onChange={e => setBulkCfg(prev => ({ ...prev, ids: e.target.checked ? [...prev.ids, p.id] : prev.ids.filter(x => x !== p.id) }))} />
                      {p.name || p.email}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:12.5, cursor:'pointer' }}>
              <input type="checkbox" checked={bulkCfg.overwrite} onChange={e => setBulkCfg(c => ({ ...c, overwrite: e.target.checked }))} />
              Overwrite days that already have a schedule
            </label>
            {bulkResult?.error && <div style={{ fontSize:12.5, fontWeight:700, color:'var(--tone-red-tx)' }}>{bulkResult.error}</div>}
            {bulkResult?.ok && <div style={{ fontSize:12.5, fontWeight:600, color:'var(--success)' }}>✓ {bulkResult.ok}</div>}
            <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
              <button className="btn" onClick={() => { setBulkModal(false); setBulkResult(null) }}>{bulkResult?.ok ? 'Done' : 'Cancel'}</button>
              <button className="btn primary" onClick={bulkApply}
                disabled={bulkBusy || !bulkCfg.templateId || (!bulkCfg.all && !bulkCfg.ids.length) || !bulkCfg.days.length}>
                {bulkBusy ? 'Applying…' : 'Apply schedule'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── PUBLISH + EMAIL MODAL ── */}
      {publishModal && (
        <Modal title={`Publish + Email — week of ${fmtDate(weekDates[0])}`} onClose={() => { setPublishModal(false); setPublishResult(null) }} width={440}>
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div style={{ fontSize:12.5, color:'var(--text-muted)' }}>
              Publishing makes this week's <b>draft shifts visible to the team</b> (striped cells go solid) and emails each
              person their own schedule — shift, breaks, lunch, and total hours.
            </div>
            {(() => {
              const drafts = schedules.filter(s => weekDates.includes(s.date) && 'published_at' in s && !s.published_at).length
              return drafts > 0 ? (
                <div style={{ fontSize:12, fontWeight:700, color:'var(--tone-amber-tx)', padding:'7px 11px', background:'var(--tone-amber-bg)', border:'1px solid var(--tone-amber-bd)', borderRadius:8 }}>
                  {drafts} unpublished shift{drafts === 1 ? '' : 's'} in this week
                </div>
              ) : (
                <div style={{ fontSize:12, color:'var(--text-muted)' }}>No unpublished changes this week — emails will just resend the current schedule.</div>
              )
            })()}
            <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, fontWeight:600, cursor:'pointer' }}>
              <input type="checkbox" checked={pubEmail} onChange={e => setPubEmail(e.target.checked)} />
              Email everyone their schedule
            </label>
            <div className="form-field">
              <label className="form-label">Who</label>
              <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, fontWeight:600, cursor:'pointer', padding:'6px 2px' }}>
                <input type="checkbox" checked={pubSel.all}
                  onChange={e => setPubSel(p => ({ ...p, all: e.target.checked }))} />
                Everyone on the floor
              </label>
              {!pubSel.all && (
                <div style={{ maxHeight:180, overflowY:'auto', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'4px 8px', display:'flex', flexDirection:'column' }}>
                  {profiles.map(p => (
                    <label key={p.id} style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer', padding:'5px 2px' }}>
                      <input type="checkbox" checked={pubSel.ids.includes(p.id)}
                        onChange={e => setPubSel(prev => ({ ...prev, ids: e.target.checked ? [...prev.ids, p.id] : prev.ids.filter(x => x !== p.id) }))} />
                      {p.name || p.email}
                    </label>
                  ))}
                </div>
              )}
            </div>
            {publishResult?.error && <div style={{ fontSize:12.5, fontWeight:700, color:'var(--tone-red-tx)' }}>{publishResult.error}</div>}
            {publishResult && !publishResult.error && (
              <div style={{ fontSize:12.5, fontWeight:600, color:'var(--success)' }}>
                ✓ Emailed {publishResult.sent} schedule{publishResult.sent === 1 ? '' : 's'}
                {publishResult.skipped?.length > 0 && (
                  <span style={{ color:'var(--tone-amber-tx)' }}> — skipped (no email or bounce): {publishResult.skipped.join(', ')}</span>
                )}
              </div>
            )}
            <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
              <button className="btn" onClick={() => { setPublishModal(false); setPublishResult(null) }}>
                {publishResult && !publishResult.error ? 'Done' : 'Cancel'}
              </button>
              <button className="btn primary" onClick={publishSchedules}
                disabled={publishing || (!pubSel.all && !pubSel.ids.length)}>
                {publishing ? 'Sending…' : pubSel.all ? 'Email everyone' : `Email (${pubSel.ids.length})`}
              </button>
            </div>
          </div>
        </Modal>
      )}

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
