import { useState, useEffect, useMemo } from 'react'
import { localYMD, shiftChanged } from '../lib/utils'
import { sb } from '../lib/supabase'
import { confirmDlg, toast } from '../lib/dialogs'
import { useAuth } from '../lib/AuthContext'
import { useIsMobile } from '../lib/useIsMobile'
import { ATTENDANCE_DEFAULTS, invalidateOpsConfig, loadOpsConfig } from '../lib/opsConfig'
import Modal from '../components/Modal'
import GraphicalSchedule from '../components/GraphicalSchedule'
import Avatar from '../components/Avatar'
import { PageTabs, PillNav, Segmented, SummaryPanel, Stat, Ring, ToneChip, Bar, Face, eyebrow, num, panel } from '../components/ui'

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
  half: '#d97706',
  pto: '#3b82f6',
  sick: '#f59e0b',
  holiday: '#8b5cf6',
  off: '#6b7280',
}

const DAY_TYPE_LABELS = {
  work: 'Work',
  half: '½ Day',
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
  // Phone layout: below 768px the tabs scroll, toolbars wrap, and wide tables
  // scroll inside their card instead of stretching the page. Desktop untouched.
  const isMobile = useIsMobile()
  const scrollX = (node) => isMobile ? <div style={{ overflowX:'auto' }}>{node}</div> : node
  const mBtn = isMobile ? { minHeight:40, flex:'1 1 auto', justifyContent:'center' } : {}
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

  // Schedule and the old Graphical tab are one Schedule tab now (redesign
  // stage 5): a week grid and a day timeline of the same shifts. Old
  // ?tab=graphical links land on the timeline.
  const [tab, setTab] = useState(() => { const t = new URLSearchParams(window.location.search).get('tab') || 'schedule'; return t === 'graphical' ? 'schedule' : t })
  const [schedView, setSchedView] = useState(() => {
    const q = new URLSearchParams(window.location.search)
    return q.get('tab') === 'graphical' || q.get('view') === 'timeline' ? 'timeline' : 'grid'
  })
  // Survive hard refresh: the active tab lives in the URL (?tab=), like MyPage.
  useEffect(() => {
    const u = new URL(window.location)
    const view = tab === 'schedule' && schedView === 'timeline' ? 'timeline' : null
    if (u.searchParams.get('tab') !== tab || u.searchParams.get('view') !== view) {
      u.searchParams.set('tab', tab)
      if (view) u.searchParams.set('view', view); else u.searchParams.delete('view')
      window.history.replaceState({}, '', u)
    }
  }, [tab, schedView])
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
  const [pointData, setPointData] = useState({ reason: 'late', points: 0.5, notes: '', date: localYMD() })
  const [reportRange, setReportRange] = useState({ start: '', end: '' })
  const [reportData, setReportData] = useState(null)
  const [copyModal, setCopyModal] = useState(false)
  const [copyCfg, setCopyCfg] = useState({ offset: 1, all: true, ids: [], overwrite: false })
  const [copyBusy, setCopyBusy] = useState(false)
  const [copyResult, setCopyResult] = useState(null)
  const [tplBusy, setTplBusy] = useState(false)

  const weekDates = getWeekDates(weekBase)
  const today = localYMD()

  useEffect(() => {
    const load = async () => {
      const [{ data: p }, { data: s }, { data: ev }, { data: t }, { data: ap }] = await Promise.all([
        sb.from('profiles').select('id, name, email, avatar, role').eq('active', true).order('name'),
        // Window must COVER THE VISIBLE WEEK — the old fixed today±30 threw
        // away weeks navigated past it: shifts saved fine, then vanished from
        // the grid, and re-adds died on the invisible row's unique constraint.
        sb.from('schedules').select('*')
          .gte('date', (() => { const d = new Date(); d.setDate(d.getDate()-30); const s = localYMD(d); return s < weekDates[0] ? s : weekDates[0] })())
          .lte('date', (() => { const d = new Date(); d.setDate(d.getDate()+30); const s = localYMD(d); return s > weekDates[6] ? s : weekDates[6] })()),
        sb.from('status_events').select('*').gte('started_at', weekDates[0] + 'T00:00:00').lte('started_at', weekDates[6] + 'T23:59:59'),
        sb.from('shift_templates').select('*').order('name'),
        sb.from('attendance_points').select('*').gte('date', new Date().getFullYear() + '-01-01').order('date', { ascending: false }),
      ])
      // Operations managers are field-side — WFM is the call center's.
      setProfiles((p || []).filter(x => x.role !== 'ops_manager')); setSchedules(s || []); setStatusEvents(ev || [])
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
    const targets = copyCfg.all ? schedProfiles.map(p => p.id) : copyCfg.ids
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
    const targets = bulkCfg.all ? schedProfiles.map(p => p.id) : bulkCfg.ids
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
    // A template gives everyone identical break times — spread them right away
    // so re-applying a template never re-collides breaks Brittany already fixed.
    if (applied) await staggerBreaks(dates)
    else await reloadSchedules()
    setBulkBusy(false)
    setBulkResult({ ok: `Scheduled ${applied} day${applied === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped (already scheduled)` : ''}${applied ? ' · breaks auto-staggered' : ''}` })
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
        body: JSON.stringify({ weekStart: pubRange.from, endDate: pubRange.to, profileIds: pubSel.all ? 'all' : pubSel.ids, sendEmails: pubEmail, from: profile?.name || profile?.email || 'your manager' }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Publish failed')
      setPublishResult(d)
      await reloadSchedules()   // drafts just went solid — repaint the grid
      refreshDraftCount()
    } catch (e) {
      setPublishResult({ error: e.message })
    } finally { setPublishing(false) }
  }

  // Bulk publish range (Brittany: "publish dates xx/xx – xx/xx so I don't have
  // to send each week at a time"). Defaults to the visible week.
  const [pubRange, setPubRange] = useState({ from: '', to: '' })
  useEffect(() => {
    if (publishModal) setPubRange({ from: weekDates[0], to: weekDates[6] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishModal])

  // Drafts-in-range counter, counted server-side — the locally loaded window
  // only spans ±30 days, so a wide range must ask the database.
  const [rangeDrafts, setRangeDrafts] = useState(null)
  useEffect(() => {
    if (!publishModal || !pubRange.from || !pubRange.to) return
    let dead = false
    sb.from('schedules').select('id', { count: 'exact', head: true })
      .is('published_at', null).gte('date', pubRange.from).lte('date', pubRange.to)
      .then(({ count, error }) => { if (!dead) setRangeDrafts(error ? null : count) })
    return () => { dead = true }
  }, [publishModal, pubRange.from, pubRange.to])

  // Toolbar chip: how many upcoming shifts are still unpublished anywhere
  // (Brittany: "an unpublished counter so I know how many are not published").
  const [draftCount, setDraftCount] = useState(0)
  const refreshDraftCount = () => {
    sb.from('schedules').select('id', { count: 'exact', head: true })
      .is('published_at', null).gte('date', today)
      .then(({ count, error }) => { if (!error) setDraftCount(count || 0) })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refreshDraftCount() }, [schedules, tab])

  // Scheduled hours for one person across the visible week — drafts included,
  // since this is the planning view. Same math the schedule emails use.
  const weekHours = (pid) => {
    let total = 0
    for (const date of weekDates) {
      const sd = schedules.find(s => s.profile_id === pid && s.date === date)
      if (!sd || ['pto','sick','holiday','off'].includes(sd.day_type) || !sd.shift_start || !sd.shift_end) continue
      const [sh, sm] = String(sd.shift_start).split(':').map(Number)
      const [eh, em] = String(sd.shift_end).split(':').map(Number)
      let h = (eh + (em || 0) / 60) - (sh + (sm || 0) / 60); if (h < 0) h += 24
      total += Math.max(0, h - (Number(sd.lunch_duration) || 0) / 60)
    }
    return total
  }
  const fmtH = (h) => (h % 1 ? h.toFixed(1) : String(h))

  // ── Break overlap detection + auto-stagger (Brittany: "3 people on the
  // same shift — don't put two people on the same break"). A break is
  // {start, end} in minutes; any two people's breaks intersecting on the
  // same day is a conflict. Flagged on the grid; "Stagger breaks" fixes it.
  const toMin = (t) => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0) }
  const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const breaksOf = (sd) => {
    if (!sd || ['pto','sick','holiday','off'].includes(sd.day_type) || !sd.shift_start) return []
    const out = []
    const add = (kind, start, dur) => { const m = toMin(start); if (m != null) out.push({ kind, start: m, end: m + (Number(dur) || (kind === 'lunch' ? 30 : 15)) }) }
    add('break1', sd.break1_start, sd.break1_duration); add('lunch', sd.lunch_start, sd.lunch_duration); add('break2', sd.break2_start, sd.break2_duration)
    return out
  }
  const overlaps = (a, b) => a.start < b.end && b.start < a.end
  const breakConflicts = useMemo(() => {
    const map = new Map()   // date -> Set(profile_id)
    for (const date of weekDates) {
      const rows = schedules.filter(x => x.date === date && breaksOf(x).length)
      for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
        const a = breaksOf(rows[i]), b = breaksOf(rows[j])
        if (a.some(x => b.some(y => overlaps(x, y)))) {
          if (!map.has(date)) map.set(date, new Set())
          map.get(date).add(rows[i].profile_id); map.get(date).add(rows[j].profile_id)
        }
      }
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedules, weekDates.join()])
  const conflictCount = [...breakConflicts.values()].reduce((a, s) => a + s.size, 0)

  const [staggering, setStaggering] = useState(false)
  const staggerBreaks = async (datesArg) => {
    if (staggering) return
    const dates = Array.isArray(datesArg) ? datesArg : weekDates
    setStaggering(true)
    let moved = 0, days = 0
    try {
      // Fresh rows from the database — after a bulk fill the component state
      // hasn't caught up yet, and stale reads would re-collide the breaks.
      const { data: freshRows } = await sb.from('schedules').select('*').in('date', dates)
      for (const date of dates) {
        const people = (freshRows || []).filter(x => x.date === date && breaksOf(x).length)
          .sort((a, b) => (toMin(a.shift_start) - toMin(b.shift_start)) || String(a.profile_id).localeCompare(String(b.profile_id)))
        const taken = []
        let dayMoved = 0
        for (const sd of people) {
          const sStart = toMin(sd.shift_start), sEnd = toMin(sd.shift_end)
          const patch = {}
          const mine = []
          for (const br of breaksOf(sd)) {
            const dur = br.end - br.start
            // Try the current slot first, then ±15-min steps outward (≤ 90 min),
            // staying inside the shift with a 30-min margin at either end.
            const offsets = [0, 15, -15, 30, -30, 45, -45, 60, -60, 75, -75, 90, -90]
            let placed = null
            for (const off of offsets) {
              const st = br.start + off, en = st + dur
              if (st < sStart + 30 || en > sEnd - 30) continue
              const slot = { start: st, end: en }
              if (taken.some(t => overlaps(t, slot)) || mine.some(t => overlaps(t, slot))) continue
              placed = slot; break
            }
            if (!placed) placed = { start: br.start, end: br.end }   // nothing free — leave it, flag stays
            mine.push(placed); taken.push(placed)
            if (placed.start !== br.start) { patch[`${br.kind}_start`] = toTime(placed.start); dayMoved++ }
          }
          if (Object.keys(patch).length) {
            const { error } = await sb.from('schedules')
              .update({ ...patch, published_at: null })   // a moved break is a real change → draft
              .eq('id', sd.id)
            if (error) toast(`Could not move a break: ${error.message}`)
          }
        }
        if (dayMoved) { moved += dayMoved; days++ }
      }
      await reloadSchedules()
      toast(moved ? `Moved ${moved} break${moved === 1 ? '' : 's'} across ${days} day${days === 1 ? '' : 's'} — now drafts, publish when ready.` : 'No overlapping breaks this week.')
    } finally { setStaggering(false) }
  }

  // Admins (Brandyn, Brittany, Deanna) run the schedule; they aren't ON it.
  // Scheduling surfaces — grid, day view, publish/copy/bulk targets — list
  // only non-admins. Points and reports keep the full roster.
  // Memoized: a fresh array identity every render made GraphicalSchedule's
  // block-rebuild effect refire after each drag-save and snap blocks back to
  // its stale local data (Deanna: breaks "bounce back").
  const schedProfiles = useMemo(() => profiles.filter(p => p.role !== 'admin'), [profiles])

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
    // A REAL change reverts to draft; re-saving an unchanged cell leaves the
    // published state alone (omitting published_at keeps the existing value).
    const draft = shiftChanged(getSchedule(profileId, date), payload) ? { ...payload, published_at: null } : payload
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
      notes: pointData.notes, auto_generated: false,
    }
    if (pointData.editId) {
      // Edit in place (Brittany: had to delete the whole entry to fix a note).
      const { data, error } = await sb.from('attendance_points').update(payload).eq('id', pointData.editId).select().single()
      if (error) toast(`Couldn't save: ${error.message}`)
      else if (data) setAttendancePoints(prev => prev.map(p => p.id === data.id ? data : p))
    } else {
      const { data, error } = await sb.from('attendance_points').insert({ ...payload, created_by: profile.id }).select().single()
      if (error) toast(`Couldn't save: ${error.message}`)
      else if (data) setAttendancePoints(prev => [data, ...prev])
    }
    setSaving(false); setPointModal(null)
    setPointData({ reason: 'late', points: 0.5, notes: '', date: today })
  }

  const editPoint = (pt) => {
    const person = profiles.find(p => p.id === pt.profile_id)
    if (!person) return
    setPointModal(person)
    setPointData({ editId: pt.id, reason: pt.reason, points: parseFloat(pt.points), notes: pt.notes || '', date: pt.date })
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

  const prevWeek = () => { const d = new Date(weekBase + 'T12:00:00'); d.setDate(d.getDate() - 7); setWeekBase(localYMD(d)) }
  const nextWeek = () => { const d = new Date(weekBase + 'T12:00:00'); d.setDate(d.getDate() + 7); setWeekBase(localYMD(d)) }
  const yearPoints = (profileId) => attendancePoints.filter(p => p.profile_id === profileId).reduce((sum, p) => sum + parseFloat(p.points), 0)

  const weekLabel = `${new Date(weekDates[0] + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' })} – ${new Date(weekDates[6] + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}`

  const TABS = [
    { id:'schedule', label:'Schedule' },
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

      {/* ── HEADER BAR ── tabs on the left, week navigation on the right. The
          schedule actions live in the Schedule tab's own toolbar. */}
      <div style={{ background:'var(--bg)', flexShrink:0, padding: isMobile ? '6px 12px 0' : '10px 24px 0',
        display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        <PageTabs value={tab} onChange={setTab}
          tabs={TABS.map(t => [t.id, t.label, t.id === 'schedule' && isAdmin && draftCount ? draftCount : null])} />
        {tab === 'schedule' && (
          <Segmented value={schedView} onChange={setSchedView} options={[['grid', 'Week grid'], ['timeline', 'Day timeline']]} />
        )}
        {((tab === 'schedule' && schedView === 'grid') || tab === 'adherence') && (
          <div style={{ marginLeft: isMobile ? 0 : 'auto', display:'flex', alignItems:'center', gap:8, paddingBottom: isMobile ? 8 : 0 }}>
            {!weekDates.includes(today) && (
              <button className="btn sm" onClick={() => setWeekBase(localYMD())} style={{ borderRadius:99 }}>This week</button>
            )}
            <PillNav label={weekLabel} onPrev={prevWeek} onNext={nextWeek} minWidth={isMobile ? 150 : 190} />
          </div>
        )}
      </div>

      {/* ── CONTENT AREA ── */}
      <div style={{ flex:1, overflowY:'auto' }}>

        {/* ── SCHEDULE TAB · week grid ── */}
        {tab === 'schedule' && schedView === 'grid' && (
          <div style={{ padding: isMobile ? 12 : 24 }}>
            {/* Week at a glance, then the actions, then the grid. */}
            {(() => {
              const totalH = schedProfiles.reduce((a, p) => a + weekHours(p.id), 0)
              const weekShifts = schedules.filter(x => weekDates.includes(x.date) && schedProfiles.some(p => p.id === x.profile_id))
              const workShifts = weekShifts.filter(x => !['pto','sick','holiday','off'].includes(x.day_type)).length
              const todayRows = schedProfiles.map(p => getSchedule(p.id, today)).filter(Boolean)
              const onToday = todayRows.filter(x => !['pto','sick','holiday','off'].includes(x.day_type)).length
              const offToday = todayRows.length - onToday
              return (
                <SummaryPanel isMobile={isMobile}>
                  <Stat label="Scheduled this week" value={`${fmtH(totalH)}h`}
                    sub={`${workShifts} shift${workShifts === 1 ? '' : 's'} · ${schedProfiles.length} people`} />
                  <Stat label={weekDates.includes(today) ? 'On today' : 'On today (this week)'} value={onToday}
                    sub={offToday ? `${offToday} off, PTO or sick` : 'Nobody out today'} />
                  <Stat label="Unpublished shifts" value={draftCount} tone={draftCount ? 'amber' : 'green'}
                    sub={draftCount ? 'Publish + Email sends them to the team' : 'Everything upcoming is published'} />
                  <Stat label="Break overlaps" value={conflictCount} tone={conflictCount ? 'amber' : 'green'}
                    sub={conflictCount ? 'Stagger breaks spreads them out' : 'No one shares a break slot'} />
                </SummaryPanel>
              )
            })()}

            {isAdmin && (
              <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', marginBottom:14 }}>
                <button className="btn" onClick={() => setBulkModal(true)} style={{ ...mBtn, borderRadius:99 }}>Bulk schedule</button>
                <button className="btn" onClick={() => setTemplateModal(true)} style={{ ...mBtn, borderRadius:99 }}>Templates</button>
                <button className="btn" onClick={() => setCopyModal(true)} style={{ ...mBtn, borderRadius:99 }}>Copy week</button>
                <button className="btn" onClick={() => staggerBreaks()} disabled={staggering}
                  title={conflictCount ? `${conflictCount} people share a break slot this week — spread them out` : 'Spread overlapping breaks so no two people are off the phones at once'}
                  style={{ ...mBtn, borderRadius:99, ...(conflictCount ? { background:'var(--tone-amber-bg)', borderColor:'var(--tone-amber-bd)', color:'var(--tone-amber-tx)' } : {}) }}>
                  {staggering ? 'Moving…' : 'Stagger breaks'}
                  {conflictCount > 0 && <span style={{ ...num, background:'var(--tone-amber-tx)', color:'var(--surface)', borderRadius:99, padding:'0 7px', fontSize:10.5, fontWeight:800 }}>{conflictCount}</span>}
                </button>
                <button className="btn primary" onClick={() => setPublishModal(true)} style={{ ...mBtn, borderRadius:99, marginLeft: isMobile ? 0 : 'auto' }}>
                  Publish + email
                  {draftCount > 0 && (
                    <span title={`${draftCount} upcoming shift${draftCount === 1 ? '' : 's'} not yet published`}
                      style={{ ...num, background:'rgba(255,255,255,.25)', borderRadius:99, padding:'0 8px', fontSize:11, fontWeight:800 }}>
                      {draftCount} draft{draftCount === 1 ? '' : 's'}
                    </span>
                  )}
                </button>
              </div>
            )}
            {/* Phone: today's shifts first, one line per person, so nobody has to
                scroll the week grid sideways just to see who's on right now. */}
            {isMobile && weekDates.includes(today) && (
              <div style={{ ...panel, padding:'12px 14px', marginBottom:12 }}>
                <div style={{ ...eyebrow, marginBottom:4 }}>Today · {fmtDate(today)}</div>
                {schedProfiles.map(p => {
                  const sched = getSchedule(p.id, today)
                  const isOff = sched && ['pto','sick','holiday','off'].includes(sched.day_type)
                  const tc = sched && !isOff ? sched.template_color : null
                  return (
                    <div key={p.id} onClick={() => isAdmin && openEdit(p.id, today)}
                      style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 0', borderTop:'1px solid var(--border)', cursor: isAdmin ? 'pointer' : 'default' }}>
                      <span style={{ flex:1, fontSize:13, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.name || p.email}</span>
                      <span style={{ fontSize:10, color:'var(--text-muted)', flexShrink:0 }}>{yearPoints(p.id).toFixed(1)} pts</span>
                      {!sched ? <span style={{ fontSize:11, color:'var(--text-muted)', flexShrink:0 }}>Not scheduled</span>
                        : isOff ? <span style={{ fontSize:11, fontWeight:600, color: DAY_TYPE_COLORS[sched.day_type], flexShrink:0 }}>{DAY_TYPE_LABELS[sched.day_type]}</span>
                        : <span style={{ fontSize:11, fontWeight:600, color: tc || 'var(--success)', flexShrink:0 }}>{fmt(sched.shift_start)} – {fmt(sched.shift_end)}</span>}
                    </div>
                  )
                })}
              </div>
            )}
            <div style={{ ...panel, overflow:'hidden' }}>
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', minWidth:900 }}>
                  <thead>
                    <tr style={{ background:'var(--surface-2)' }}>
                      <th style={{ ...eyebrow, padding:'12px 18px', textAlign:'left', width:200, borderBottom:'1px solid var(--border)' }}>
                        Agent
                        {(() => { const t = schedProfiles.reduce((a, p) => a + weekHours(p.id), 0); return t > 0 ? <span style={{ textTransform:'none', letterSpacing:0, fontWeight:700, color:'var(--text-secondary)' }}> · {fmtH(t)}h total</span> : null })()}
                      </th>
                      {weekDates.map((date, i) => {
                        const isToday = date === today
                        return (
                          <th key={date} style={{ ...eyebrow, padding:'10px 8px', textAlign:'center', color: isToday ? 'var(--accent)' : 'var(--text-muted)', borderBottom:'1px solid var(--border)', borderLeft:'1px solid var(--border)', minWidth:112 }}>
                            <div>{DAYS[i]}</div>
                            <div style={{ ...num, display:'inline-flex', alignItems:'center', justifyContent:'center', minWidth:26, height:26, borderRadius:99, marginTop:4, padding:'0 6px',
                              fontSize:13, fontWeight: isToday ? 800 : 600, letterSpacing:0,
                              background: isToday ? 'var(--accent)' : 'transparent', color: isToday ? '#fff' : 'var(--text-primary)' }}>
                              {new Date(date + 'T12:00:00').getDate()}
                            </div>
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {schedProfiles.map((p, pi) => (
                      <tr key={p.id} style={{ borderBottom:'1px solid var(--border)' }}>
                        <td style={{ padding:'12px 18px', borderRight:'1px solid var(--border)' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                            <Face avatar={p.avatar} name={p.name || p.email} size={32} />
                            <div>
                              <div style={{ fontSize:13.5, fontWeight:650, color:'var(--text-primary)' }}>{p.name || p.email}</div>
                              <div style={{ ...num, fontSize:11, color:'var(--text-muted)', marginTop:1, whiteSpace:'nowrap' }} title="Attendance points this year · hours scheduled this week">
                                {yearPoints(p.id).toFixed(1)} pts
                                {weekHours(p.id) > 0 && <span style={{ fontWeight:700, color:'var(--text-secondary)' }}> · {fmtH(weekHours(p.id))}h wk</span>}
                              </div>
                            </div>
                          </div>
                        </td>
                        {weekDates.map(date => {
                          const sched = getSchedule(p.id, date)
                          const isToday = date === today
                          const isOff = sched && ['pto','sick','holiday','off'].includes(sched.day_type)
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
                            <td key={date} style={{ padding:6, borderLeft:'1px solid var(--border)', background: isToday ? 'color-mix(in srgb, var(--accent-bg) 60%, transparent)' : 'transparent', verticalAlign:'top' }}>
                              {sched && !isOff ? (
                                <div onClick={() => isAdmin && openEdit(p.id, date)}
                                  title={isDraft ? 'Draft — not published or emailed yet' : undefined}
                                  style={{ padding:'8px 10px', borderRadius:10, background: tc ? `${tc}24` : 'var(--tone-green-bg)', border:`1px solid ${tc || 'var(--tone-green-bd)'}`, cursor: isAdmin ? 'pointer' : 'default', transition:'opacity .1s', ...hatch }}
                                  onMouseEnter={e => { if(isAdmin) e.currentTarget.style.opacity='.8' }}
                                  onMouseLeave={e => e.currentTarget.style.opacity='1'}>
                                  <div style={{ ...num, fontSize:11.5, fontWeight:700, color: tc || 'var(--tone-green-tx)' }}>{fmt(sched.shift_start)} – {fmt(sched.shift_end)}</div>
                                  {sched.lunch_start && <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:2 }}>Lunch {fmt(sched.lunch_start)}</div>}
                                  {sched.day_type === 'half' && <div style={{ fontSize:9, fontWeight:800, letterSpacing:.5, color:'var(--tone-amber-tx)', marginTop:2 }}>½ DAY — off after</div>}
                                  {breakConflicts.get(date)?.has(p.id) && (
                                    <div title="A break or lunch here overlaps someone else's on the same day — use Stagger breaks"
                                      style={{ fontSize:9.5, fontWeight:700, color:'var(--tone-amber-tx)', marginTop:2 }}>⚠ break overlap</div>
                                  )}
                                  {isDraft && <div style={{ fontSize:9, fontWeight:800, letterSpacing:.5, color:'var(--text-muted)', marginTop:2 }}>DRAFT</div>}
                                </div>
                              ) : sched && isOff ? (
                                <div onClick={() => isAdmin && openEdit(p.id, date)}
                                  title={isDraft ? 'Draft — not published or emailed yet' : undefined}
                                  style={{ padding:'8px 10px', borderRadius:10, background: typeColor + '1c', border:`1px solid ${typeColor}66`, cursor: isAdmin ? 'pointer' : 'default', ...hatch }}>
                                  <div style={{ fontSize:11, fontWeight:600, color: typeColor }}>{DAY_TYPE_LABELS[sched.day_type]}</div>
                                  {isDraft && <div style={{ fontSize:9, fontWeight:800, letterSpacing:.5, color:'var(--text-muted)', marginTop:2 }}>DRAFT</div>}
                                </div>
                              ) : isAdmin ? (
                                <button onClick={() => openEdit(p.id, date)}
                                  style={{ width:'100%', padding:'8px 4px', border:'1px dashed var(--border-strong)', borderRadius:10, background:'transparent', color:'var(--text-muted)', cursor:'pointer', fontSize:11.5, fontWeight:600, transition:'all .1s' }}
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

        {/* ── SCHEDULE TAB · day timeline (was the Graphical tab) ── */}
        {tab === 'schedule' && schedView === 'timeline' && (
          <GraphicalSchedule profiles={schedProfiles} onUpdate={async () => {
            const from = new Date(); from.setDate(from.getDate() - 30)
            const to = new Date(); to.setDate(to.getDate() + 30)
            const { data: s } = await sb.from('schedules').select('*').gte('date', from.toISOString().split('T')[0]).lte('date', to.toISOString().split('T')[0])
            setSchedules(s || [])
          }} />
        )}

        {/* ── ADHERENCE TAB ── */}
        {tab === 'adherence' && (() => {
          const adhTone = (v) => v == null ? 'gray' : v >= attCfg.adherenceGood ? 'green' : v >= attCfg.adherenceWarn ? 'amber' : 'red'
          const people = schedProfiles.map(p => {
            const pScheds = schedules.filter(s => s.profile_id === p.id && weekDates.includes(s.date))
            const pEvents = statusEvents.filter(e => e.profile_id === p.id)
            // Average only over days with a valid schedule; a null day must
            // not count as 100 (the old `|| 100` also turned a real 0 into 100).
            // Days still ahead have no events yet — they'd score 0%, so they wait.
            const dayPcts = pScheds.filter(s => s.date <= today)
              .map(s => adherencePct(s, pEvents.filter(e => e.started_at?.startsWith(s.date))))
              .filter(v => v != null)
            const avgAdh = dayPcts.length ? Math.round(dayPcts.reduce((a, b) => a + b, 0) / dayPcts.length) : null
            const noLogin = pScheds.filter(s => !['pto','sick','holiday','off'].includes(s.day_type) && s.date <= today
              && !pEvents.some(e => e.started_at?.startsWith(s.date) && (e.status === 'Available' || e.status === 'On Call'))).length
            return { p, pScheds, pEvents, dayPcts, avgAdh, noLogin }
          }).filter(x => x.pScheds.length || x.pEvents.length)
          const all = people.flatMap(x => x.dayPcts)
          const teamAvg = all.length ? Math.round(all.reduce((a, b) => a + b, 0) / all.length) : null
          const band = (t) => people.filter(x => adhTone(x.avgAdh) === t).length
          const missed = people.reduce((a, x) => a + x.noLogin, 0)
          return (
            <div style={{ padding: isMobile ? 12 : 24, display:'flex', flexDirection:'column', gap:16 }}>
              <SummaryPanel isMobile={isMobile} style={{ marginBottom:0 }} columns="minmax(250px, 290px) repeat(3, minmax(0, 1fr))">
                <div style={{ display:'flex', alignItems:'center', gap:16 }}>
                  <Ring pct={teamAvg || 0} size={76} stroke={7} tone={adhTone(teamAvg)}>
                    <div style={{ ...num, fontSize:19, fontWeight:800, color:`var(--tone-${adhTone(teamAvg)}-tx)` }}>{teamAvg == null ? '—' : teamAvg}<span style={{ fontSize:11 }}>%</span></div>
                  </Ring>
                  <div>
                    <div style={eyebrow}>Team adherence</div>
                    <div style={{ fontSize:12.5, color:'var(--text-secondary)', marginTop:4 }}>This week · target {attCfg.adherenceGood}%</div>
                  </div>
                </div>
                <Stat label="On target" value={band('green')} tone="green" sub={`At or above ${attCfg.adherenceGood}%`} />
                <Stat label="Needs attention" value={band('amber') + band('red')} tone={band('red') ? 'red' : band('amber') ? 'amber' : 'green'}
                  sub={`${band('red')} below ${attCfg.adherenceWarn}%`} />
                <Stat label="Days without a login" value={missed} tone={missed ? 'red' : 'green'} sub="Scheduled work days so far" />
              </SummaryPanel>

              {people.map(({ p, avgAdh }) => {
                const t = adhTone(avgAdh)
                return (
                  <div key={p.id} style={{ ...panel, overflow:'hidden' }}>
                    <div style={{ padding:'14px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12 }}>
                      <Face avatar={p.avatar} name={p.name || p.email} size={34} />
                      <span style={{ fontSize:14.5, fontWeight:700, flex:1, minWidth:0 }}>{p.name || p.email}</span>
                      {avgAdh != null && (
                        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                          <div style={{ width: isMobile ? 64 : 140 }}><Bar pct={avgAdh} tone={t} /></div>
                          <ToneChip tone={t}>{avgAdh}%</ToneChip>
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
                            const brk = (ev, limit) => ev
                              ? <span style={{ color: bv(ev, limit) ? 'var(--tone-red-tx)' : 'var(--text-secondary)', fontWeight: bv(ev, limit) ? 700 : 400 }}>{fmtTime(ev.started_at)} ({fmtDuration(ev.duration_seconds)}){bv(ev, limit) ? ' · over' : ''}</span>
                              : <span style={{ color:'var(--text-muted)' }}>—</span>
                            return (
                              <tr key={date}>
                                <td style={{ fontWeight:600 }}>{fmtDate(date)}</td>
                                <td>{sched ? `${fmt(sched.shift_start)} – ${fmt(sched.shift_end)}` : <span style={{ color:'var(--text-muted)' }}>—</span>}</td>
                                <td>{loginEvent ? <span style={{ color:'var(--tone-green-tx)', fontWeight:600 }}>{fmtTime(loginEvent.started_at)}</span> : <span style={{ color:'var(--tone-red-tx)', fontWeight:600 }}>No login</span>}</td>
                                <td>{brk(breakEvents[0], sched?.break1_duration || 15)}</td>
                                <td>{brk(lunchEvent, sched?.lunch_duration || 30)}</td>
                                <td>{brk(breakEvents[1], sched?.break2_duration || 15)}</td>
                                <td>{offlineEvent ? fmtTime(offlineEvent.started_at) : <span style={{ color:'var(--text-muted)' }}>—</span>}</td>
                                <td style={{ textAlign:'right' }}>{pct != null ? <ToneChip tone={adhTone(pct)} small>{pct}%</ToneChip> : <span style={{ color:'var(--text-muted)' }}>—</span>}</td>
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
          )
        })()}

        {/* ── POINTS TAB ── */}
        {tab === 'points' && (() => {
          const ptsTone = (v) => v >= attCfg.pointsCritical ? 'red' : v >= attCfg.pointsWarn ? 'amber' : 'green'
          const people = schedProfiles.map(p => {
            const pts = attendancePoints.filter(ap => ap.profile_id === p.id)
            return { p, pts, total: pts.reduce((sum, ap) => sum + parseFloat(ap.points), 0) }
          })
          const count = (t) => people.filter(x => ptsTone(x.total) === t).length
          // Phone: people and their points come first; the settings card drops to the bottom.
          const wfmCard = isAdmin && wfmCfg && (
            <div style={{ ...panel, padding:'16px 20px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
                <span className="disp" style={{ fontSize:14, fontWeight:700 }}>WFM settings</span>
                <span style={{ fontSize:12, color:'var(--text-muted)' }}>Points per incident and the color thresholds</span>
                <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:10 }}>
                  {wfmMsg && <span style={{ fontSize:12, color: wfmMsg.startsWith('Error') ? 'var(--danger)' : 'var(--tone-green-tx)' }}>{wfmMsg}</span>}
                  <button className="btn sm primary" onClick={saveWfmCfg}>Save</button>
                </div>
              </div>
              <div className={isMobile ? 'mgrid' : undefined} style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(auto-fit, minmax(150px, 1fr))', gap:12, alignItems:'end' }}>
                {[
                  ['late', 'Late arrival (pts)'],
                  ['absence', 'Unexcused absence (pts)'],
                  ['early_departure', 'Early departure (pts)'],
                  ['no_call', 'No call / no show (pts)'],
                ].map(([k, label]) => (
                  <div key={k} className="form-field" style={{ marginBottom:0 }}>
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
                  <div key={k} className="form-field" style={{ marginBottom:0 }}>
                    <label className="form-label" style={{ fontSize:11 }}>{label}</label>
                    <input className="form-input" type="number" min="0" value={wfmCfg[k]}
                      onChange={e => setWfmCfg(f => ({ ...f, [k]: Number(e.target.value) }))} />
                  </div>
                ))}
              </div>
            </div>
          )
          const cards = people.map(({ p, pts, total }) => {
            const t = ptsTone(total)
            return (
              <div key={p.id} style={{ ...panel, overflow:'hidden' }}>
                <div style={{ padding: isMobile ? '12px 14px' : '14px 20px', borderBottom: pts.length > 0 ? '1px solid var(--border)' : 'none', display:'flex', alignItems:'center', gap:12, flexWrap: isMobile ? 'wrap' : undefined }}>
                  <Face avatar={p.avatar} name={p.name || p.email} size={34} />
                  <span style={{ fontSize:14.5, fontWeight:700, flex:1, minWidth:0 }}>{p.name || p.email}</span>
                  <div style={{ display:'flex', alignItems:'center', gap:10, flex: isMobile ? '1 1 100%' : undefined }}>
                    <div style={{ width: isMobile ? undefined : 110, flex: isMobile ? 1 : undefined }}><Bar pct={Math.min((total / 8) * 100, 100)} tone={t} /></div>
                    <span style={{ ...num, fontSize:17, fontWeight:800, color:`var(--tone-${t}-tx)` }}>{total.toFixed(1)}</span>
                    <span style={{ fontSize:11.5, color:'var(--text-muted)' }}>/ 8 pts</span>
                    {isAdmin && (
                      <button className="btn sm" style={{ borderRadius:99 }} onClick={() => { setPointModal(p); setPointData({ reason:'late', points:0.5, notes:'', date:today }) }}>
                        + Add point
                      </button>
                    )}
                  </div>
                </div>
                {pts.length > 0 && scrollX(
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Reason</th><th style={{textAlign:'center'}}>Points</th><th>Notes</th>{isAdmin && <th></th>}</tr></thead>
                    <tbody>
                      {pts.map(pt => (
                        <tr key={pt.id}>
                          <td style={{ whiteSpace:'nowrap', fontWeight:600 }}>{new Date(pt.date + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}</td>
                          <td>{POINT_REASONS.find(r => r.value === pt.reason)?.label || pt.reason}</td>
                          <td style={{ textAlign:'center' }}><ToneChip tone={parseFloat(pt.points) >= 1 ? 'red' : 'amber'} small>{parseFloat(pt.points).toFixed(1)}</ToneChip></td>
                          <td style={{ color:'var(--text-muted)' }}>{pt.notes || '—'}</td>
                          {isAdmin && (
                            <td style={{ whiteSpace:'nowrap', textAlign:'right' }}>
                              <button className="btn sm" style={{ marginRight:6 }} onClick={() => editPoint(pt)}>Edit</button>
                              <button className="btn sm danger" onClick={() => deletePoint(pt.id)}>Remove</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })
          return (
            <div style={{ padding: isMobile ? 12 : 24, display:'flex', flexDirection:'column', gap:16 }}>
              <SummaryPanel isMobile={isMobile} style={{ marginBottom:0 }}>
                <Stat label="Good" value={count('green')} tone="green" sub={`Under ${attCfg.pointsWarn} points`} />
                <Stat label="Warning" value={count('amber')} tone={count('amber') ? 'amber' : 'green'} sub={`${attCfg.pointsWarn} to ${(attCfg.pointsCritical - 0.1).toFixed(1)} points`} />
                <Stat label="Critical" value={count('red')} tone={count('red') ? 'red' : 'green'} sub={`${attCfg.pointsCritical}+ points`} />
                <Stat label="Points this year" value={people.reduce((a, x) => a + x.total, 0).toFixed(1)}
                  sub={`Calendar ${new Date().getFullYear()} · resets Jan 1`} />
              </SummaryPanel>
              {isMobile ? <>{cards}{wfmCard}</> : <>{wfmCard}{cards}</>}
            </div>
          )
        })()}

        {/* ── REPORTS TAB ── */}
        {tab === 'reports' && (
          <div style={{ padding: isMobile ? 12 : 24, display:'flex', flexDirection:'column', gap:16 }}>
            <div style={{ ...panel, padding:'16px 20px' }}>
              <div style={{ ...eyebrow, marginBottom:12 }}>Attendance report</div>
              <div style={{ display:'flex', gap:12, alignItems: isMobile ? 'stretch' : 'flex-end', flexWrap:'wrap', flexDirection: isMobile ? 'column' : undefined }}>
                <div className="form-field" style={{ margin:0 }}>
                  <label className="form-label">Start date</label>
                  <input type="date" className="form-input" value={reportRange.start} onChange={e => setReportRange(p => ({ ...p, start: e.target.value }))} />
                </div>
                <div className="form-field" style={{ margin:0 }}>
                  <label className="form-label">End date</label>
                  <input type="date" className="form-input" value={reportRange.end} onChange={e => setReportRange(p => ({ ...p, end: e.target.value }))} />
                </div>
                <button className="btn primary" onClick={runReport} disabled={!reportRange.start || !reportRange.end} style={{ minHeight: isMobile ? 40 : undefined, borderRadius:99 }}>Run report</button>
                {reportData && <button className="btn" onClick={exportReport} style={{ minHeight: isMobile ? 40 : undefined, borderRadius:99 }}>Export CSV</button>}
              </div>
            </div>

            {reportData && (() => {
              const adhTone = (v) => v == null ? 'gray' : v >= attCfg.adherenceGood ? 'green' : v >= attCfg.adherenceWarn ? 'amber' : 'red'
              const ptsTone = (v) => v >= attCfg.pointsCritical ? 'red' : v >= attCfg.pointsWarn ? 'amber' : 'green'
              const withAdh = reportData.filter(r => r.avgAdherence != null)
              const teamAdh = withAdh.length ? Math.round(withAdh.reduce((a, r) => a + r.avgAdherence, 0) / withAdh.length) : null
              const pts = reportData.reduce((a, r) => a + r.totalPoints, 0)
              const brk = reportData.reduce((a, r) => a + r.breakViolations, 0)
              const lun = reportData.reduce((a, r) => a + r.lunchViolations, 0)
              const range = `${fmtDate(reportRange.start)} – ${fmtDate(reportRange.end)}`
              return (
                <>
                  <SummaryPanel isMobile={isMobile} style={{ marginBottom:0 }}>
                    <Stat label="Average adherence" value={teamAdh == null ? '—' : `${teamAdh}%`} tone={adhTone(teamAdh)} sub={range} />
                    <Stat label="Attendance points" value={pts.toFixed(1)} tone={pts ? 'amber' : 'green'} sub="Added in this range" />
                    <Stat label="Long breaks" value={brk} tone={brk ? 'red' : 'green'} sub={`Over 15 min + ${GRACE} grace`} />
                    <Stat label="Long lunches" value={lun} tone={lun ? 'red' : 'green'} sub={`Over 30 min + ${GRACE} grace`} />
                  </SummaryPanel>
                  <div style={{ ...panel, overflow:'hidden' }}>
                    {scrollX(
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Agent</th>
                          <th style={{textAlign:'center'}}>Days sched.</th>
                          <th style={{textAlign:'center'}}>Att. points</th>
                          <th style={{textAlign:'center'}}>Avg adherence</th>
                          <th style={{textAlign:'center'}}>Long breaks</th>
                          <th style={{textAlign:'center'}}>Long lunches</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportData.map(r => (
                          <tr key={r.profile.id}>
                            <td>
                              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                                <Face avatar={r.profile.avatar} name={r.profile.name || r.profile.email} size={28} />
                                <span style={{ fontWeight:650 }}>{r.profile.name || r.profile.email}</span>
                              </div>
                            </td>
                            <td style={{ textAlign:'center', fontWeight:600 }}>{r.daysScheduled}</td>
                            <td style={{ textAlign:'center' }}><ToneChip tone={ptsTone(r.totalPoints)} small>{r.totalPoints.toFixed(1)}</ToneChip></td>
                            <td style={{ textAlign:'center' }}>
                              {r.avgAdherence != null ? <ToneChip tone={adhTone(r.avgAdherence)} small>{r.avgAdherence}%</ToneChip> : <span style={{ color:'var(--text-muted)' }}>—</span>}
                            </td>
                            <td style={{ textAlign:'center', color: r.breakViolations > 0 ? 'var(--tone-red-tx)' : 'var(--text-secondary)', fontWeight: r.breakViolations > 0 ? 700 : 400 }}>{r.breakViolations}</td>
                            <td style={{ textAlign:'center', color: r.lunchViolations > 0 ? 'var(--tone-red-tx)' : 'var(--text-secondary)', fontWeight: r.lunchViolations > 0 ? 700 : 400 }}>{r.lunchViolations}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    )}
                  </div>
                </>
              )
            })()}
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
                  <div style={{ display:'flex', gap:6, alignItems:'center', paddingTop:4, flexWrap: isMobile ? 'wrap' : undefined }}>
                    {['#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6','#EC4899','#14B8A6','#F97316','#6366F1','#84CC16','#A16207','#64748B'].map(c => (
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
                  {schedProfiles.map(p => (
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
                      style={{ flex:1, minHeight: isMobile ? 40 : undefined, padding:'6px 0', fontSize:11.5, fontWeight:600, borderRadius:'var(--radius)', cursor:'pointer',
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
                  {schedProfiles.map(p => (
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
        <Modal title="Publish + Email" onClose={() => { setPublishModal(false); setPublishResult(null) }} width={440}>
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div style={{ fontSize:12.5, color:'var(--text-muted)' }}>
              Publishing makes <b>draft shifts in this date range visible to the team</b> (striped cells go solid) and emails
              each person their own schedule — shift, breaks, lunch, and total hours. Widen the range to publish several
              weeks at once.
            </div>
            <div style={{ display:'flex', gap:10, alignItems: isMobile ? 'stretch' : 'end', flexDirection: isMobile ? 'column' : undefined }}>
              <div className="form-field" style={{ flex:1, margin:0 }}>
                <label className="form-label">From</label>
                <input type="date" className="form-input" value={pubRange.from}
                  onChange={e => setPubRange(p => ({ ...p, from: e.target.value }))} />
              </div>
              <div className="form-field" style={{ flex:1, margin:0 }}>
                <label className="form-label">Through</label>
                <input type="date" className="form-input" value={pubRange.to}
                  onChange={e => setPubRange(p => ({ ...p, to: e.target.value }))} />
              </div>
            </div>
            {pubRange.to < pubRange.from ? (
              <div style={{ fontSize:12, fontWeight:700, color:'var(--tone-red-tx)' }}>End date is before start date.</div>
            ) : rangeDrafts == null ? null : rangeDrafts > 0 ? (
              <div style={{ fontSize:12, fontWeight:700, color:'var(--tone-amber-tx)', padding:'7px 11px', background:'var(--tone-amber-bg)', border:'1px solid var(--tone-amber-bd)', borderRadius:8 }}>
                {rangeDrafts} unpublished shift{rangeDrafts === 1 ? '' : 's'} in this range
              </div>
            ) : (
              <div style={{ fontSize:12, color:'var(--text-muted)' }}>No unpublished changes in this range — emails will just resend the current schedule.</div>
            )}
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
                  {schedProfiles.map(p => (
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
                disabled={publishing || (!pubSel.all && !pubSel.ids.length) || !pubRange.from || !pubRange.to || pubRange.to < pubRange.from}>
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
              <div style={{ display:'flex', gap:6, flexWrap: isMobile ? 'wrap' : undefined }}>
                {Object.entries(DAY_TYPE_LABELS).map(([val, label]) => (
                  <button key={val} onClick={() => setEditData(p => ({ ...p, day_type: val }))}
                    style={{ flex: isMobile ? '1 1 30%' : 1, minHeight: isMobile ? 40 : undefined, padding:'7px 4px', borderRadius:'var(--radius)', fontSize:11, fontWeight:500, border:'1px solid', cursor:'pointer',
                      borderColor: editData.day_type === val ? (DAY_TYPE_COLORS[val] || 'var(--accent)') : 'var(--border)',
                      background: editData.day_type === val ? (DAY_TYPE_COLORS[val] || 'var(--accent)') + '20' : 'var(--surface-2)',
                      color: editData.day_type === val ? (DAY_TYPE_COLORS[val] || 'var(--accent)') : 'var(--text-muted)' }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {(!editData.day_type || editData.day_type === 'work' || editData.day_type === 'half') && (
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
        <Modal title={`${pointData.editId ? 'Edit' : 'Add'} Attendance Point — ${pointModal.name || pointModal.email}`} onClose={() => { setPointModal(null); setPointData({ reason: 'late', points: 0.5, notes: '', date: today }) }} width={440}>
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
            <button className="btn primary" onClick={addPoint} disabled={saving}>{saving ? 'Saving...' : pointData.editId ? 'Save changes' : 'Add point'}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
