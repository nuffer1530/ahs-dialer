import { useState, useEffect, Fragment, Children } from 'react'
import { useSearchParams } from 'react-router-dom'
import { sb } from '../lib/supabase'
import TimeOffTab from '../components/TimeOffTab'
import CallEvalsTab from '../components/CallEvalsTab'
import PtoRequestModal from '../components/PtoRequestModal'
import ShiftSwapModal from '../components/ShiftSwapModal'
import SwapRequests, { SwapIcon } from '../components/SwapRequests'
import { useAuth } from '../lib/AuthContext'
import { useIsMobile } from '../lib/useIsMobile'
import { inboundStats, outboundStats, acwStats, ahtOf, fmtSecs, fmtPct, SERVICE_LEVEL_SECONDS, SERVICE_LEVEL_TARGET } from '../lib/analytics'
import { PageTabs, PillNav, Segmented, Ring, ToneChip, SummaryPanel, Stat, EmptyState, Face, eyebrow, num, panel } from '../components/ui'
import { levelOf } from '../components/ScorecardsPanel'

const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

// LOCAL calendar date, never toISOString(): that converts to UTC, and after
// 6 PM Denver "today" is already tomorrow in UTC — the whole week grid
// shifted a day (Monday's shifts rendered under Sunday's header) every
// evening. AttendancePage does it this way already.
function toYMD(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
function getTodayMonday() {
  const d = new Date()
  const dow = d.getDay()
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return toYMD(d)
}
function getWeekDates(base) {
  const d = new Date(base + 'T12:00:00')
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(d); x.setDate(d.getDate() + i); return toYMD(x)
  })
}
function fmt12(t) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hr = h % 12 || 12
  return m === 0 ? `${hr} ${ampm}` : `${hr}:${String(m).padStart(2,'0')} ${ampm}`
}
function fmtDate(ymd) {
  const [y, mo, d] = ymd.split('-').map(Number)
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${names[mo-1]} ${d}`
}

// Tone per day type — theme tokens, so the chips read in dark mode too.
const DAY_TYPE_STYLES = {
  pto:     { label: 'PTO',     tone: 'green'  },
  sick:    { label: 'Sick',    tone: 'red'    },
  holiday: { label: 'Holiday', tone: 'purple' },
  work:    { label: null,      tone: null     },
}

// Scorecard KPIs -- Brandyn can adjust thresholds here
const SCORECARD_KPIS = [
  {
    id: 'attendance',
    label: 'Attendance',
    weight: 0.25,
    unit: 'points',
    thresholds: { exceeds: 0, meets: 1, improvement: 2 },
    lowerIsBetter: true,
  },
  {
    id: 'booking_pct',
    label: 'Inbound Booking %',
    weight: 0.20,
    unit: '%',
    thresholds: { exceeds: 90, meets: 80, improvement: 75 },
    lowerIsBetter: false,
  },
  {
    id: 'booked_calls',
    label: 'Booked Calls',
    weight: 0.20,
    unit: '',
    thresholds: { exceeds: 140, meets: 110, improvement: 85 },
    lowerIsBetter: false,
  },
  {
    id: 'call_quality',
    label: 'Call Quality Evaluation(s)',
    weight: 0.15,
    unit: '%',
    thresholds: { exceeds: 95, meets: 90, improvement: 85 },
    lowerIsBetter: false,
  },
  {
    id: 'memberships',
    label: 'Memberships Sold',
    weight: 0.20,
    unit: '',
    thresholds: { exceeds: 5, meets: 3, improvement: 2 },
    lowerIsBetter: false,
  },
]

function getRating(kpi, value, thresholds) {
  if (value == null) return null
  const thr = thresholds || kpi.thresholds
  const { lowerIsBetter } = kpi
  if (lowerIsBetter) {
    if (value <= thr.exceeds)    return 4
    if (value <= thr.meets)      return 3
    if (value <= thr.improvement) return 2
    return 1
  } else {
    if (value >= thr.exceeds)    return 4
    if (value >= thr.meets)      return 3
    if (value >= thr.improvement) return 2
    return 1
  }
}

const RATING_LABELS = { 4: 'Exceeds', 3: 'Meets', 2: 'Needs Improvement', 1: 'Poor Performance' }
// Tone per rating — the Team → Scorecards review's colors (Meets is blue).
// Theme tokens: hardcoded light-mode pastels made the dark-mode scorecard an
// unreadable gray mush.
const RATING_TONES = { 4: 'green', 3: 'blue', 2: 'amber', 1: 'red' }
// KPI track zones, worst on the left, best on the right.
const ZONES = ['Poor', 'Needs impr.', 'Meets', 'Exceeds']

// Commission rows: label + tone per type, shared by the day list and the table.
const commKind = (c, amt) => c.event_type === 'reversal' ? { key: 'reversal', label: 'Reversed', tone: 'red' }
  : c.event_type === 'adjustment' ? { key: 'adjustment', label: 'Adjustment', tone: amt < 0 ? 'red' : 'amber' }
  : c.event_type === 'membership' ? { key: 'membership', label: 'Membership', tone: 'blue' }
  : { key: 'booking', label: 'Booking', tone: 'green' }
const COMM_ICONS = {
  booking: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3.6 17.4a1.9 1.9 0 0 0 2.7 2.7l5.7-5.7a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.5-.6-.6-2.5 3-2.2z',
  membership: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  adjustment: 'M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7C10.5 4 7 4 7 6s3 1 5 1zm0 0c1.5-3 5-3 5-1s-3 1-5 1z',
  reversal: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
}
const money = (n) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`    // $12.00 / −$5.00
const signed = (n) => `${n < 0 ? '−' : '+'}$${Math.abs(n).toFixed(2)}`  // +$12.00 / −$5.00

export default function MyPage() {
  // Call-center admin tools: admins and call center managers.
  const { profile, canManageCallCenter: isAdmin } = useAuth()
  const isMobile = useIsMobile()
  const [searchParams, setSearchParams] = useSearchParams()
  const VALID_TABS = ['my-schedule', 'team-schedule', 'stats', 'commissions', 'scorecard', 'call-evals', 'time-off']
  const initialTab = VALID_TABS.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'my-schedule'
  const [tab, setTab] = useState(initialTab)
  // Click a day on My Schedule -> request time off for it.
  const [ptoDay, setPtoDay] = useState(null)
  const [swapDay, setSwapDay] = useState(null)   // opens ShiftSwapModal ('' = no prefill)
  const [ptoToast, setPtoToast] = useState('')
  // 📣 Admin floor alert — broadcast to everyone or one person; pops like a
  // schedule alert on their screen.
  const [announceOpen, setAnnounceOpen] = useState(false)
  const [announce, setAnnounce] = useState({ all: true, ids: [], message: '', sendAt: '' })
  const [annScheduled, setAnnScheduled] = useState([])
  const loadAnnScheduled = async () => {
    try {
      const { data: { session } } = await sb.auth.getSession()
      const r = await fetch('/api/admin/notify-floor/scheduled', { headers: { Authorization: `Bearer ${session?.access_token}` } })
      const d = await r.json()
      if (r.ok) setAnnScheduled(d.items || [])
    } catch {}
  }
  const unscheduleAnn = async (id) => {
    try {
      const { data: { session } } = await sb.auth.getSession()
      await fetch('/api/admin/notify-floor/unschedule', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ id }),
      })
      setAnnScheduled(prev => prev.filter(x => x.id !== id))
    } catch {}
  }
  const [announceBusy, setAnnounceBusy] = useState(false)
  const [announceMsg, setAnnounceMsg] = useState('')
  const [annProfiles, setAnnProfiles] = useState([])
  useEffect(() => {
    if (!announceOpen || annProfiles.length) return
    sb.from('profiles').select('id, name, email, role').eq('active', true).order('name')
      .then(({ data }) => setAnnProfiles((data || []).filter(p => p.role !== 'ops_manager')))   // floor announcements = call center
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announceOpen])
  // Sent through the server — this page already holds the 'floor-alerts'
  // subscription and Supabase won't join the same topic twice on one
  // connection, so a browser-side send hung forever. The server's broadcast
  // also pops on the sender's own screen, which is the delivery receipt.
  const sendAnnouncement = async () => {
    const message = announce.message.trim()
    if (!message || announceBusy) return
    if (!announce.all && !announce.ids.length) { setAnnounceMsg('Pick at least one person.'); return }
    setAnnounceBusy(true); setAnnounceMsg('')
    try {
      const { data: { session } } = await sb.auth.getSession()
      const toNames = announce.all ? '' : annProfiles.filter(p => announce.ids.includes(p.id)).map(p => p.name || p.email).join(', ')
      const r = await fetch('/api/admin/notify-floor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ to: announce.all ? 'all' : announce.ids, toNames, from: profile?.name || profile?.email || 'Admin', message, sendAt: announce.sendAt || null }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Send failed')
      if (d.scheduled) {
        setAnnounce(a => ({ ...a, message: '', sendAt: '' }))
        loadAnnScheduled()   // stays open so they see it queued
      } else {
        setAnnounce({ all: true, ids: [], message: '', sendAt: '' })
        setAnnounceOpen(false)
      }
    } catch (e) {
      setAnnounceMsg(e.message)
    } finally { setAnnounceBusy(false) }
  }
  // Shift length minus unpaid lunch; paid breaks count as worked time.
  const schedHours = (sched) => {
    if (!sched || ['pto','sick','holiday','off'].includes(sched.day_type) || !sched.shift_start || !sched.shift_end) return 0
    const [sh, sm] = sched.shift_start.split(':').map(Number)
    const [eh, em] = sched.shift_end.split(':').map(Number)
    let h = (eh + (em || 0) / 60) - (sh + (sm || 0) / 60)
    if (h < 0) h += 24
    h -= (Number(sched.lunch_duration) || 0) / 60
    return Math.max(0, h)
  }
  const fmtH = (h) => (h % 1 ? h.toFixed(1) : String(h))
  const [weekBase, setWeekBase] = useState(getTodayMonday)
  // My Schedule: week cards or a month calendar.
  const [schedView, setSchedView] = useState('week')
  const [schedMonth, setSchedMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() } })
  const [monthScheds, setMonthScheds] = useState([])
  useEffect(() => {
    if (schedView !== 'month' || !profile?.id) return
    const first = new Date(schedMonth.y, schedMonth.m, 1)
    const last = new Date(schedMonth.y, schedMonth.m + 1, 0)
    sb.from('schedules').select('*').eq('profile_id', profile.id)
      .gte('date', toYMD(first)).lte('date', toYMD(last))
      .then(({ data }) => setMonthScheds((data || []).filter(r => !('published_at' in r) || r.published_at)))
  }, [schedView, schedMonth.y, schedMonth.m, profile?.id])
  const [schedules, setSchedules] = useState([])
  const [profiles, setProfiles] = useState([])
  const [statusEvents, setStatusEvents] = useState([])
  const [attendancePoints, setAttendancePoints] = useState([])
  const [loading, setLoading] = useState(true)
  const now = new Date()
  const [scorecardMonth, setScorecardMonth] = useState({ year: now.getFullYear(), month: now.getMonth() })
  const [scWeights, setScWeights] = useState({ attendance: 25, booking_pct: 20, booked_calls: 20, call_quality: 15, memberships: 20 })
  const [scActuals, setScActuals] = useState({ booking_pct: null, booked_calls: null, call_quality: null, memberships: null })
  const [scThresholds, setScThresholds] = useState({
    attendance:   { exceeds: 0,   meets: 1,   improvement: 2  },
    booking_pct:  { exceeds: 90,  meets: 80,  improvement: 75 },
    booked_calls: { exceeds: 140, meets: 110, improvement: 85 },
    call_quality: { exceeds: 95,  meets: 90,  improvement: 85 },
    memberships:  { exceeds: 5,   meets: 3,   improvement: 2  },
  })
  const [commissions, setCommissions] = useState([])
  const [myTasks, setMyTasks] = useState([])   // this rep's inbound calls (call_tasks)
  const [myLogs, setMyLogs] = useState([])     // this rep's outbound calls (call_logs)
  const [commWeekBase, setCommWeekBase] = useState(getTodayMonday)
  const [commLoading, setCommLoading] = useState(false)

  const today = toYMD(new Date())
  const weekDates = getWeekDates(weekBase)
  const weekLabel = `${fmtDate(weekDates[0])} – ${fmtDate(weekDates[6])}`

  useEffect(() => {
    if (!profile?.id) return
    const load = async () => {
      setLoading(true)
      const from = new Date(); from.setDate(from.getDate() - 60)
      const to = new Date(); to.setDate(to.getDate() + 30)
      const fromStr = toYMD(from), toStr = toYMD(to)

      // call_logs is keyed by rep display-name string, not profile_id.
      const repName = profile.name || profile.email

      const [{ data: profs }, { data: scheds }, { data: events }, { data: pts }, { data: wts }, { data: thr }, { data: tasks }, { data: cl }] = await Promise.all([
        sb.from('profiles').select('id, name, email, avatar, role').eq('active', true).order('name'),
        sb.from('schedules').select('*').gte('date', fromStr).lte('date', toStr)
          .then(r => ({ ...r, data: (r.data || []).filter(x => !('published_at' in x) || x.published_at) })),   // drafts stay in WFM
        sb.from('status_events').select('*').eq('profile_id', profile.id).gte('started_at', fromStr + 'T00:00:00').order('started_at', { ascending: false }),
        // Whole year, not the 60-day window: the scorecard month picker goes
        // back to January and points get backfilled months later.
        sb.from('attendance_points').select('*').eq('profile_id', profile.id).gte('date', `${new Date().getFullYear()}-01-01`),
        sb.from('app_settings').select('value').eq('key', 'scorecard_weights').maybeSingle(),
        sb.from('app_settings').select('value').eq('key', 'scorecard_thresholds').maybeSingle(),
        // Real telephony, same sources the Analytics page uses.
        sb.from('call_tasks').select('*').eq('agent_profile_id', profile.id).gte('queued_at', fromStr + 'T00:00:00'),
        sb.from('call_logs').select('*').eq('rep', repName).gte('created_at', fromStr + 'T00:00:00'),
      ])
      setProfiles((profs || []).filter(p => p.role !== 'ops_manager'))   // team schedule / swaps = call center only
      setSchedules(scheds || [])
      setStatusEvents(events || [])
      setAttendancePoints(pts || [])
      setMyTasks(tasks || [])
      setMyLogs(cl || [])
      if (wts?.value) { try { setScWeights(JSON.parse(wts.value)) } catch (e) {} }
      if (thr?.value) { try { setScThresholds(JSON.parse(thr.value)) } catch (e) {} }
      setLoading(false)
    }
    load()
  }, [profile?.id])

  // Load commissions for selected week
  useEffect(() => {
    if (!profile?.id) return
    const commWeekDates = getWeekDates(commWeekBase)
    const from = commWeekDates[0] + 'T00:00:00'
    const to = commWeekDates[6] + 'T23:59:59'
    setCommLoading(true)
    sb.from('commissions').select('*')
      .eq('profile_id', profile.id)
      .gte('earned_at', from)
      .lte('earned_at', to)
      .order('earned_at', { ascending: false })
      .then(({ data }) => { setCommissions(data || []); setCommLoading(false) })
  }, [profile?.id, commWeekBase])

  // Reload scorecard actuals + thresholds when month changes or scorecard tab opens
  useEffect(() => {
    if (!profile?.id || tab !== 'scorecard') return
    // Re-fetch global thresholds so any admin changes are immediately visible
    sb.from('app_settings').select('value').eq('key', 'scorecard_thresholds').maybeSingle()
      .then(({ data }) => { if (data?.value) { try { setScThresholds(JSON.parse(data.value)) } catch (e) {} } })
    const monthStart = `${scorecardMonth.year}-${String(scorecardMonth.month+1).padStart(2,'0')}-01`
    sb.from('scorecard_actuals').select('*').eq('profile_id', profile.id).eq('month', monthStart).maybeSingle()
      .then(({ data }) => {
        setScActuals({
          booking_pct: data?.booking_pct ?? null,
          booked_calls: data?.booked_calls ?? null,
          call_quality: data?.call_quality ?? null,
          memberships: data?.memberships ?? null,
        })
        if (data?.weights) { try { setScWeights(data.weights) } catch (e) {} }
      })
  }, [profile?.id, scorecardMonth, tab])

  // Keep the active tab in sync with the ?tab= URL param, so navigating here
  // from the top-right menu (e.g. ?tab=commissions) opens the right tab even
  // when MyPage is already mounted.
  useEffect(() => {
    const t = searchParams.get('tab')
    if (t && VALID_TABS.includes(t) && t !== tab) setTab(t)
  }, [searchParams])

  const getSched = (profileId, date) => schedules.find(s => s.profile_id === profileId && s.date === date)

  // Scorecard month data -- filtered by selected scorecardMonth
  const scMonthStart = toYMD(new Date(scorecardMonth.year, scorecardMonth.month, 1))
  const scMonthEnd = toYMD(new Date(scorecardMonth.year, scorecardMonth.month + 1, 0))
  const scPoints = attendancePoints.filter(p => p.date >= scMonthStart && p.date <= scMonthEnd)
  const scTotalPoints = scPoints.reduce((s, p) => s + parseFloat(p.points || 0), 0)

  // Stats tab always uses current month
  const monthStart = toYMD(new Date(now.getFullYear(), now.getMonth(), 1))
  const myPoints = attendancePoints.filter(p => p.date >= monthStart)
  const totalPoints = myPoints.reduce((s, p) => s + parseFloat(p.points || 0), 0)

  // Real month-to-date telephony, computed the same way as the Analytics page so
  // a rep's personal numbers match what an admin sees for them. Previously
  // "Calls Handled" counted On-Call status events, which is a proxy, not calls.
  const monthTasks = myTasks.filter(t => t.queued_at?.slice(0,10) >= monthStart)
  const monthLogs = myLogs.filter(l => l.created_at?.slice(0,10) >= monthStart)
  const myInbound = inboundStats(monthTasks)
  const myOutbound = outboundStats(monthLogs)
  const myAcw = acwStats(statusEvents.filter(e => e.started_at?.slice(0,10) >= monthStart))

  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const scorecardLabel = `${MONTH_NAMES[scorecardMonth.month]} ${scorecardMonth.year}`
  const navMonth = (dir) => {
    setScorecardMonth(prev => {
      let m = prev.month + dir, y = prev.year
      if (m > 11) { m = 0; y++ }
      if (m < 0)  { m = 11; y-- }
      return { year: y, month: m }
    })
  }
  const isCurrentMonth = scorecardMonth.year === now.getFullYear() && scorecardMonth.month === now.getMonth()

  // Commission week helpers
  const commWeekDates = getWeekDates(commWeekBase)
  const commWeekLabel = `${fmtDate(commWeekDates[0])} – ${fmtDate(commWeekDates[6])}`
  const isCurrentCommWeek = commWeekBase === getTodayMonday()
  const navCommWeek = (dir) => {
    const d = new Date(commWeekBase + 'T00:00:00')
    d.setDate(d.getDate() + dir * 7)
    setCommWeekBase(toYMD(d))
  }

  // Commission totals
  const commTotal = commissions.reduce((s, c) => s + parseFloat(c.amount || 0), 0)
  const commToday = commissions.filter(c => c.earned_at?.slice(0,10) === today).reduce((s, c) => s + parseFloat(c.amount || 0), 0)
  const commByDay = commWeekDates.map(date => ({
    date,
    entries: commissions.filter(c => c.earned_at?.slice(0,10) === date),
    total: commissions.filter(c => c.earned_at?.slice(0,10) === date).reduce((s, c) => s + parseFloat(c.amount || 0), 0),
  }))

  const TABS = [
    { id: 'my-schedule',   label: 'My Schedule' },
    { id: 'team-schedule', label: 'Team Schedule' },
    { id: 'stats',         label: 'My Stats' },
    { id: 'commissions',   label: 'Commissions' },
    { id: 'scorecard',     label: 'Scorecard' },
    { id: 'call-evals',    label: 'Call Evals' },
    { id: 'time-off',      label: 'Time Off' },
  ]
  // Phone: what a rep checks on the go comes first — today's shift, then money, then the scorecard.
  const MOBILE_TAB_ORDER = ['my-schedule', 'commissions', 'scorecard', 'team-schedule', 'stats', 'call-evals', 'time-off']
  const shownTabs = isMobile ? MOBILE_TAB_ORDER.map(id => TABS.find(t => t.id === id)).filter(Boolean) : TABS

  // Header: the open tab's period navigation (the same handlers as before, as
  // pill navs) and, for admins, Notify team.
  const weekNavTab = (tab === 'my-schedule' && schedView === 'week') || tab === 'team-schedule' || tab === 'commissions'
  const monthNavTab = tab === 'my-schedule' && schedView === 'month'
  const hasHeaderActions = weekNavTab || monthNavTab || tab === 'scorecard' || isAdmin
  const navMin = isMobile ? 132 : 150
  // Stat zones: the kit's Stat, at phone size when zones sit two or three across.
  const S = isMobile ? MiniStat : Stat
  const stack = { display:'flex', flexDirection:'column', gap: isMobile ? 12 : 16 }
  const headPad = isMobile ? '12px 14px' : '14px 20px'
  const rowPad = isMobile ? '10px 12px' : '11px 18px'

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

      {/* -- HEADER BAR -- page tabs on the left; the tab's period navigation
          and Notify team on the right (their own row on a phone). */}
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0, padding: isMobile ? '0 12px' : '0 24px',
        display:'flex', alignItems:'center', gap:'0 12px', flexWrap:'wrap' }}>
        <PageTabs tabs={shownTabs.map(t => [t.id, t.label])} value={tab}
          onChange={id => { setTab(id); setSearchParams(id === 'my-schedule' ? {} : { tab: id }, { replace: true }) }} />
        {hasHeaderActions && (
          <div style={{ marginLeft: isMobile ? 0 : 'auto', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', padding: isMobile ? '0 0 10px' : '6px 0' }}>
            {weekNavTab && !(tab === 'commissions' ? isCurrentCommWeek : weekBase === getTodayMonday()) && (
              <button className="btn sm" style={{ borderRadius:99 }}
                onClick={() => tab === 'commissions' ? setCommWeekBase(getTodayMonday()) : setWeekBase(getTodayMonday())}>
                This week
              </button>
            )}
            {weekNavTab && (
              <PillNav label={tab === 'commissions' ? commWeekLabel : weekLabel} minWidth={navMin}
                onPrev={() => tab === 'commissions' ? navCommWeek(-1) : (() => { const d = new Date(weekBase + 'T00:00:00'); d.setDate(d.getDate()-7); setWeekBase(toYMD(d)) })()}
                onNext={() => tab === 'commissions' ? navCommWeek(1) : (() => { const d = new Date(weekBase + 'T00:00:00'); d.setDate(d.getDate()+7); setWeekBase(toYMD(d)) })()} />
            )}
            {monthNavTab && (
              <PillNav label={new Date(schedMonth.y, schedMonth.m, 1).toLocaleDateString([], { month:'long', year:'numeric' })} minWidth={navMin}
                onPrev={() => setSchedMonth(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))}
                onNext={() => setSchedMonth(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }))} />
            )}
            {tab === 'scorecard' && !isCurrentMonth && (
              <button className="btn sm" style={{ borderRadius:99 }} onClick={() => setScorecardMonth({ year: now.getFullYear(), month: now.getMonth() })}>
                This month
              </button>
            )}
            {tab === 'scorecard' && (
              <PillNav label={scorecardLabel} minWidth={navMin} onPrev={() => navMonth(-1)} onNext={() => navMonth(1)} />
            )}
            {isAdmin && (
              <button className="btn primary" onClick={() => { setAnnounceMsg(''); setAnnounceOpen(true); loadAnnScheduled() }}
                title="Send or schedule a pop-up alert to the floor or selected people"
                style={{ borderRadius:99 }}>
                Notify team
              </button>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ flex:1, overflow:'auto', padding: isMobile ? 12 : 24, background:'var(--bg)' }}>
        {loading ? (
          <div style={stack}>
            <div className="skel" style={{ height:38, width: isMobile ? '100%' : 340, borderRadius:99 }} />
            <div className="skel" style={{ height: isMobile ? 320 : 160, borderRadius:16 }} />
            <div className="skel" style={{ height:120, borderRadius:16 }} />
          </div>
        ) : (
          <>
            {tab === 'time-off' && <TimeOffTab profile={profile} />}
            {tab === 'call-evals' && <CallEvalsTab profile={profile} isAdmin={false} />}

            {/* MY SCHEDULE — week cards or a month calendar; click a day to request time off */}
            {tab === 'my-schedule' && (
              <div style={stack}>
                <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
                  <Segmented value={schedView} onChange={setSchedView} options={[['week','Week'],['month','Month']]} />
                  <div style={{ marginLeft: isMobile ? 0 : 'auto', display:'flex', alignItems:'baseline', gap:8, flexWrap:'wrap' }}>
                    <span style={eyebrow}>Scheduled this {schedView}</span>
                    <span style={{ ...num, fontSize:20, fontWeight:800, letterSpacing:'-.02em', color:'var(--text-primary)' }}>
                      {schedView === 'week'
                        ? fmtH(weekDates.reduce((a, dd) => a + schedHours(getSched(profile?.id, dd)), 0))
                        : fmtH(monthScheds.reduce((a, sd) => a + schedHours(sd), 0))}h
                    </span>
                    <span style={{ fontSize:11.5, color:'var(--text-muted)' }}>lunch unpaid, breaks paid</span>
                  </div>
                </div>
                {schedView === 'month' && (() => {
                  const first = new Date(schedMonth.y, schedMonth.m, 1)
                  const lead = (first.getDay() + 6) % 7   // Monday-first grid, like the week view
                  const daysIn = new Date(schedMonth.y, schedMonth.m + 1, 0).getDate()
                  const cells = [...Array(lead).fill(null), ...Array.from({ length: daysIn }, (_, i) => i + 1)]
                  while (cells.length % 7) cells.push(null)
                  const short = (t) => fmt12(t).replace(':00', '').replace(' AM', 'a').replace(' PM', 'p')
                  const schedOf = (d) => monthScheds.find(sd => sd.date === toYMD(new Date(schedMonth.y, schedMonth.m, d)))
                  return (
                    <div style={{ ...panel, padding: isMobile ? 8 : 16 }}>
                      <div className="mgrid" style={{ display:'grid', gridTemplateColumns:'repeat(7, minmax(0, 1fr))', gap: isMobile ? 4 : 6, marginBottom:8 }}>
                        {DAYS.map(d => (
                          <div key={d} style={{ ...eyebrow, textAlign:'center' }}>{d}</div>
                        ))}
                      </div>
                      <div className="mgrid" style={{ display:'grid', gridTemplateColumns:'repeat(7, minmax(0, 1fr))', gap: isMobile ? 4 : 6 }}>
                        {cells.map((d, i) => {
                          if (!d) return <div key={`e${i}`} />
                          const dateStr = toYMD(new Date(schedMonth.y, schedMonth.m, d))
                          const sched = schedOf(d)
                          const dt = sched?.day_type
                          const ds = DAY_TYPE_STYLES[dt] || DAY_TYPE_STYLES.work
                          const isToday = dateStr === today
                          const requestable = dateStr >= today
                          return (
                            <div key={dateStr}
                              onClick={() => requestable && setPtoDay(dateStr)}
                              title={requestable ? 'Click to request time off for this day' : undefined}
                              className={requestable && !isToday ? 'lift-hover' : undefined}
                              style={{ background: isToday ? 'var(--accent-bg)' : 'var(--surface)',
                                border:`1px solid ${isToday ? 'var(--accent)' : 'var(--border)'}`,
                                borderRadius:10, padding: isMobile ? '6px 4px' : '8px 10px', minHeight: isMobile ? 56 : 72, overflow:'hidden',
                                cursor: requestable ? 'pointer' : 'default', opacity: dateStr < today ? .55 : 1 }}>
                              <div style={{ ...num, fontSize:11.5, fontWeight: isToday ? 800 : 600, color: isToday ? 'var(--accent)' : 'var(--text-secondary)' }}>{d}</div>
                              {sched && dt && dt !== 'work' && ds.label && (
                                <div style={{ marginTop:4 }}><DayChip tone={ds.tone} tiny={isMobile}>{ds.label}</DayChip></div>
                              )}
                              {sched && dt === 'work' && sched.shift_start && (
                                <div style={{ marginTop:4 }}>
                                  <div style={{ ...num, fontSize:10.5, fontWeight:700, color:'var(--text-primary)' }}>{short(sched.shift_start)}–{short(sched.shift_end)}</div>
                                  <div style={{ ...num, fontSize:9.5, fontWeight:700, color:'var(--accent)' }}>{fmtH(schedHours(sched))}h</div>
                                </div>
                              )}
                              {!sched && <div style={{ marginTop:4, fontSize:10, color:'var(--text-muted)' }}>Off</div>}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
                {schedView === 'week' && (() => {
                  // Phone: today's card leads; days already gone drop below a divider.
                  const ti = isMobile ? weekDates.indexOf(today) : -1
                  const ordered = ti > 0 ? [...weekDates.slice(ti), ...weekDates.slice(0, ti)] : weekDates
                  return (
                    <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(7, minmax(0, 1fr))', gap: isMobile ? 8 : 10 }}>
                      {ordered.map(date => {
                        const sched = getSched(profile?.id, date)
                        const isToday = date === today
                        const dt = sched?.day_type
                        const ds = DAY_TYPE_STYLES[dt] || DAY_TYPE_STYLES.work
                        const requestable = date >= today
                        const breaks = sched && dt === 'work' ? [
                          sched.break1_start && { t: sched.break1_start, label: 'Break' },
                          sched.lunch_start && { t: sched.lunch_start, label: 'Lunch' },
                          sched.break2_start && { t: sched.break2_start, label: 'Break' },
                        ].filter(Boolean).sort((a, b) => String(a.t).localeCompare(String(b.t))) : []
                        return (
                          <Fragment key={date}>
                          {ti > 0 && date === weekDates[0] && (
                            <div style={{ ...eyebrow, marginTop:6 }}>Earlier this week</div>
                          )}
                          <div
                            onClick={() => requestable && setPtoDay(date)}
                            title={requestable ? 'Click to request time off for this day' : undefined}
                            style={{ ...panel, borderRadius:14, padding:'12px 14px', minHeight: isMobile ? 0 : 132, minWidth:0,
                              background: isToday ? 'var(--accent-bg)' : 'var(--surface)',
                              border:`1px solid ${isToday ? 'var(--accent)' : 'var(--border)'}`,
                              cursor: requestable ? 'pointer' : 'default', transition:'box-shadow .15s ease' }}
                            onMouseEnter={e => { if (requestable) e.currentTarget.style.boxShadow = '0 10px 24px -14px rgba(15,20,40,.28)' }}
                            onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}>
                            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                              <span style={{ ...eyebrow, color: isToday ? 'var(--accent)' : 'var(--text-muted)' }}>
                                {DAYS[weekDates.indexOf(date)]}
                              </span>
                              <span style={{ ...num, display:'inline-flex', alignItems:'center', justifyContent:'center', minWidth:26, height:26, padding:'0 6px', borderRadius:99,
                                fontSize:13, fontWeight: isToday ? 800 : 600, background: isToday ? 'var(--accent)' : 'transparent', color: isToday ? '#fff' : 'var(--text-primary)' }}>
                                {fmtDate(date).split(' ')[1]}
                              </span>
                            </div>

                            {!sched && (
                              <div style={{ fontSize:12, color:'var(--text-muted)' }}>Off</div>
                            )}

                            {sched && dt && dt !== 'work' && ds.label && (
                              <ToneChip tone={ds.tone}>{ds.label}</ToneChip>
                            )}

                            {sched && dt === 'work' && (
                              <div>
                                <div style={{ ...num, fontSize:12.5, fontWeight:700, color:'var(--text-primary)', lineHeight:1.35 }}>
                                  {fmt12(sched.shift_start)} – {fmt12(sched.shift_end)}
                                </div>
                                <div style={{ marginTop:6 }}><ToneChip tone="blue" small>{fmtH(schedHours(sched))}h</ToneChip></div>
                                {breaks.length > 0 && (
                                  <div style={{ marginTop:10, paddingTop:8, borderTop:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:3 }}>
                                    {breaks.map((b, bi) => (
                                      <div key={bi} style={{ display:'flex', gap:6, fontSize:11, color:'var(--text-muted)' }}>
                                        <span style={{ width:40, flexShrink:0 }}>{b.label}</span>
                                        <span style={{ ...num, color:'var(--text-secondary)' }}>{fmt12(b.t)}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          </Fragment>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>
            )}

            {/* TEAM SCHEDULE — When-I-Work-style shift blocks, click your own to swap */}
            {tab === 'team-schedule' && (
              <div style={stack}>
                <SwapRequests profile={profile} profiles={profiles} />
                <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                  <div style={{ fontSize:12.5, color:'var(--text-muted)', flex:'1 1 260px' }}>
                    Click one of <b style={{ color:'var(--text-secondary)' }}>your</b> shifts to request a swap — your co-worker accepts, then management signs off.
                  </div>
                  <button className="btn" style={{ borderRadius:99 }} onClick={() => setSwapDay('')}>
                    <SwapIcon /> Request a swap
                  </button>
                </div>
                <div style={{ ...panel, overflow:'hidden' }}>
                  <div style={{ overflowX:'auto' }}>
                    <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12, minWidth:860 }}>
                      <thead>
                        <tr style={{ background:'var(--surface-2)' }}>
                          <th style={{ ...eyebrow, padding:'10px 16px', textAlign:'left', borderBottom:'1px solid var(--border)', width:200 }}>Agent</th>
                          {weekDates.map((date, i) => {
                            const isToday = date === today
                            return (
                              <th key={date} style={{ ...eyebrow, padding:'8px 6px', textAlign:'center', color: isToday ? 'var(--accent)' : 'var(--text-muted)', borderBottom:'1px solid var(--border)', borderLeft:'1px solid var(--border)' }}>
                                <div>{DAYS[i]}</div>
                                <div style={{ ...num, display:'inline-flex', alignItems:'center', justifyContent:'center', minWidth:24, height:24, padding:'0 6px', borderRadius:99, marginTop:3,
                                  fontSize:12.5, fontWeight: isToday ? 800 : 600, letterSpacing:0, textTransform:'none',
                                  background: isToday ? 'var(--accent)' : 'transparent', color: isToday ? '#fff' : 'var(--text-primary)' }}>
                                  {fmtDate(date).split(' ')[1]}
                                </div>
                              </th>
                            )
                          })}
                          <th style={{ ...eyebrow, padding:'10px 16px', textAlign:'right', borderBottom:'1px solid var(--border)', borderLeft:'1px solid var(--border)', width:70 }}>Hours</th>
                        </tr>
                      </thead>
                      <tbody>
                        {profiles.map(p => {
                          const isMe = p.id === profile?.id
                          const weekTotal = weekDates.reduce((a, dd) => a + schedHours(getSched(p.id, dd)), 0)
                          return (
                          <tr key={p.id} style={{ borderTop:'1px solid var(--border)', background: isMe ? 'color-mix(in srgb, var(--accent-bg) 45%, transparent)' : undefined }}>
                            <td style={{ padding:'8px 16px', whiteSpace:'nowrap' }}>
                              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                                <Face avatar={p.avatar} name={p.name || p.email} size={28} />
                                <span style={{ fontSize:13, fontWeight: isMe ? 700 : 600, color:'var(--text-primary)' }}>{p.name || p.email}</span>
                                {isMe && <ToneChip tone="blue" small>You</ToneChip>}
                              </div>
                            </td>
                            {weekDates.map(date => {
                              const sched = getSched(p.id, date)
                              const dt = sched?.day_type
                              const ds = DAY_TYPE_STYLES[dt] || DAY_TYPE_STYLES.work
                              const isToday = date === today
                              const isWork = sched && (!dt || dt === 'work') && sched.shift_start
                              const swappable = isMe && isWork && date > today
                              // Template color as a tint, like the WFM grid (it's a category color).
                              const tc = sched?.template_color
                              return (
                                <td key={date} onClick={() => swappable && setSwapDay(date)}
                                  title={swappable ? 'Request a swap for this shift' : undefined}
                                  style={{ padding:'6px 5px', textAlign:'center', verticalAlign:'middle', borderLeft:'1px solid var(--border)', cursor: swappable ? 'pointer' : 'default',
                                    background: isToday ? 'color-mix(in srgb, var(--accent-bg) 60%, transparent)' : undefined }}>
                                  {!sched && <span style={{ fontSize:11, color:'var(--text-muted)' }}>—</span>}
                                  {sched && dt && dt !== 'work' && ds.label && (
                                    <div style={{ fontSize:10.5, fontWeight:700, padding:'8px 4px', borderRadius:10,
                                      color:`var(--tone-${ds.tone}-tx)`, background:`var(--tone-${ds.tone}-bg)`, border:`1px solid var(--tone-${ds.tone}-bd)` }}>{ds.label}</div>
                                  )}
                                  {isWork && (
                                    <div style={{ background: tc ? `${tc}24` : 'var(--tone-green-bg)',
                                      border: swappable ? '1px dashed var(--accent)' : `1px solid ${tc || 'var(--tone-green-bd)'}`,
                                      borderRadius:10, padding:'6px 4px', lineHeight:1.35 }}>
                                      <div style={{ ...num, fontSize:11, fontWeight:700, color: tc || 'var(--tone-green-tx)' }}>
                                        {fmt12(sched.shift_start).replace(':00','').replace(' ','')}–{fmt12(sched.shift_end).replace(':00','').replace(' ','')}
                                      </div>
                                      <div style={{ ...num, fontSize:9.5, fontWeight:600, color:'var(--text-muted)', display:'flex', alignItems:'center', justifyContent:'center', gap:3 }}>
                                        {fmtH(schedHours(sched))}h{swappable && <> · <SwapIcon size={10} /></>}
                                      </div>
                                    </div>
                                  )}
                                </td>
                              )
                            })}
                            <td style={{ padding:'8px 16px', textAlign:'right', fontWeight:700, borderLeft:'1px solid var(--border)', color: weekTotal > 0 ? 'var(--text-primary)' : 'var(--text-muted)', fontVariantNumeric:'tabular-nums' }}>
                              {weekTotal > 0 ? `${fmtH(weekTotal)}` : '—'}
                            </td>
                          </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* MY STATS — month to date */}
            {tab === 'stats' && (() => {
              const sl = myInbound.serviceLevel
              const slTone = sl == null ? 'gray' : sl >= SERVICE_LEVEL_TARGET ? 'green' : sl >= 60 ? 'amber' : 'red'
              return (
                <div style={stack}>
                  <div style={{ display:'flex', alignItems:'baseline', gap:8, flexWrap:'wrap' }}>
                    <span style={{ fontSize:15, fontWeight:700 }}>Month to date</span>
                    <span style={{ fontSize:12.5, color:'var(--text-muted)' }}>{new Date().toLocaleDateString('en-US', { month:'long', year:'numeric' })}</span>
                  </div>
                  <Zones isMobile={isMobile} wide={[0]} columns="minmax(240px, 280px) repeat(4, minmax(0, 1fr))">
                    <div style={{ display:'flex', alignItems:'center', gap:16 }}>
                      <Ring pct={sl || 0} size={isMobile ? 64 : 76} stroke={7} tone={slTone}>
                        <div style={{ ...num, fontSize: isMobile ? 17 : 19, fontWeight:800, color:`var(--tone-${slTone}-tx)` }}>
                          {sl == null ? '—' : <>{sl.toFixed(0)}<span style={{ fontSize:11 }}>%</span></>}
                        </div>
                      </Ring>
                      <div style={{ minWidth:0 }}>
                        <div style={eyebrow}>Service Level</div>
                        <div style={{ fontSize:12.5, color:'var(--text-secondary)', marginTop:4 }}>Answered within {SERVICE_LEVEL_SECONDS}s</div>
                        <div style={{ fontSize:11.5, color:'var(--text-muted)', marginTop:2 }}>Target {SERVICE_LEVEL_TARGET}%</div>
                      </div>
                    </div>
                    <S label="Inbound Handled" value={myInbound.handled} sub="Calls you answered" />
                    <S label="Talk Time" value={fmtSecs(myInbound.att)} sub="Avg time on the call" />
                    <S label="After-Call Work" value={fmtSecs(myAcw.avg)} sub="Avg wrap-up per call" />
                    <S label="Handle Time" value={fmtSecs(ahtOf(myInbound.att, myAcw.avg))} sub="Talk + wrap-up" />
                  </Zones>
                  <Zones isMobile={isMobile} wide={[2]}>
                    <S label="Outbound Calls" value={myOutbound.calls} sub="Dials you made" />
                    <S label="Booked" value={myOutbound.booked} sub={`${fmtPct(myOutbound.conversion)} conversion`} tone={myOutbound.booked > 0 ? 'green' : undefined} />
                    <S label="Attendance Points" value={totalPoints.toFixed(1)} sub="Lower is better" tone={totalPoints === 0 ? 'green' : totalPoints <= 1 ? 'amber' : 'red'} />
                  </Zones>

                  <div style={{ ...panel, overflow:'hidden' }}>
                    <div style={{ padding: headPad, display:'flex', alignItems:'baseline', gap:10, flexWrap:'wrap', borderBottom: myPoints.length ? '1px solid var(--border)' : 'none' }}>
                      <span style={{ fontSize:14, fontWeight:700 }}>Attendance points log</span>
                      <span style={{ fontSize:12, color:'var(--text-muted)' }}>This month</span>
                    </div>
                    {myPoints.length === 0 ? (
                      <div style={{ padding: isMobile ? '0 14px 16px' : '0 20px 18px', fontSize:13, color:'var(--text-muted)' }}>No points this month.</div>
                    ) : (
                      <div style={{ overflowX:'auto' }}>
                        <table className="data-table">
                          <thead>
                            <tr><th>Date</th><th>Reason</th><th>Points</th><th>Notes</th></tr>
                          </thead>
                          <tbody>
                            {myPoints.sort((a,b) => b.date.localeCompare(a.date)).map(pt => (
                              <tr key={pt.id}>
                                <td style={{ fontWeight:600, whiteSpace:'nowrap' }}>{fmtDate(pt.date)}</td>
                                <td style={{ textTransform:'capitalize' }}>{pt.reason?.replace(/_/g,' ')}</td>
                                <td><ToneChip tone="red" small>+{pt.points}</ToneChip></td>
                                <td style={{ color:'var(--text-muted)' }}>{pt.notes || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}

            {/* COMMISSIONS */}
            {tab === 'commissions' && (
              <div style={stack}>
                {commLoading ? (
                  <>
                    <div className="skel" style={{ height: isMobile ? 92 : 104, borderRadius:16 }} />
                    <div className="skel" style={{ height:200, borderRadius:14 }} />
                  </>
                ) : (
                  <>
                    <Zones isMobile={isMobile} cols={3}>
                      <S size={20} label="Today" value={money(commToday)} sub="Resets at midnight" tone={commToday > 0 ? 'green' : undefined} />
                      <S size={20} label="This Week" value={money(commTotal)} sub={commWeekLabel} tone={commTotal > 0 ? 'green' : undefined} />
                      <S size={20} label="Transactions" value={commissions.length} sub="This week" />
                    </Zones>

                    {/* Daily breakdown — days with earnings, and today */}
                    {commByDay.filter(d => d.entries.length > 0 || d.date === today).map(({ date, entries, total }) => {
                      const isToday = date === today
                      return (
                        <div key={date} style={{ ...panel, borderRadius:14, overflow:'hidden', border:`1px solid ${isToday ? 'var(--tone-blue-bd)' : 'var(--border)'}` }}>
                          <div style={{ display:'flex', alignItems:'center', gap:10, padding: rowPad, background: isToday ? 'var(--accent-bg)' : 'var(--surface-2)' }}>
                            <span style={{ fontSize:13, fontWeight:700, color:'var(--text-primary)' }}>
                              {DAYS[commWeekDates.indexOf(date)]}, {fmtDate(date)}
                            </span>
                            {isToday && <ToneChip tone="blue" small>Today</ToneChip>}
                            {entries.length > 0 && (
                              <span style={{ ...num, fontSize:12, color:'var(--text-muted)' }}>{entries.length} transaction{entries.length === 1 ? '' : 's'}</span>
                            )}
                            <span style={{ ...num, marginLeft:'auto', fontSize:13, fontWeight:800, color: total > 0 ? 'var(--tone-green-tx)' : total < 0 ? 'var(--tone-red-tx)' : 'var(--text-muted)' }}>
                              {entries.length > 0 ? money(total) : '—'}
                            </span>
                          </div>
                          {entries.length > 0 && entries.map(c => {
                            const amt = parseFloat(c.amount || 0)
                            const isAdj = c.event_type === 'adjustment'
                            const k = commKind(c, amt)
                            return (
                              <div key={c.id} className="eval-row" style={{ display:'flex', alignItems:'center', gap: isMobile ? 10 : 14, padding: rowPad, borderTop:'1px solid var(--border)' }}>
                                <CommTile kind={k} />
                                <div style={{ flex:1, minWidth:0 }}>
                                  <div style={{ fontSize:13.5, fontWeight:650, color:'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                                    {isAdj ? (c.notes || 'Manual adjustment') : c.contact_name}
                                  </div>
                                  <div style={{ ...num, fontSize:12, color:'var(--text-muted)', marginTop:2 }}>
                                    {k.label} · {new Date(c.earned_at).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}
                                  </div>
                                </div>
                                <span style={{ ...num, fontSize:14, fontWeight:800, flexShrink:0, color: amt < 0 ? 'var(--tone-red-tx)' : 'var(--tone-green-tx)' }}>
                                  {signed(amt)}
                                </span>
                              </div>
                            )
                          })}
                          {entries.length === 0 && (
                            <div style={{ padding: rowPad, borderTop:'1px solid var(--border)', fontSize:12.5, color:'var(--text-muted)' }}>No earnings yet</div>
                          )}
                        </div>
                      )
                    })}
                    {commByDay.every(d => d.entries.length === 0) && (
                      <EmptyState>No commissions recorded for this week.</EmptyState>
                    )}

                    {/* Full log table */}
                    {commissions.length > 0 && (
                      <div style={{ ...panel, overflow:'hidden' }}>
                        <div style={{ padding: headPad, borderBottom:'1px solid var(--border)', display:'flex', alignItems:'baseline', gap:10, flexWrap:'wrap' }}>
                          <span style={{ fontSize:14, fontWeight:700 }}>Full breakdown</span>
                          <span style={{ ...num, fontSize:12, color:'var(--text-muted)' }}>{commWeekLabel}</span>
                        </div>
                        <div style={{ overflowX:'auto' }}>
                          <table className="data-table">
                            <thead>
                              <tr><th>Type</th><th>Detail</th><th>Date / Time</th><th style={{ textAlign:'right' }}>Amount</th></tr>
                            </thead>
                            <tbody>
                              {commissions.map(c => {
                                const amt = parseFloat(c.amount || 0)
                                const isAdj = c.event_type === 'adjustment'
                                const k = commKind(c, amt)
                                return (
                                  <tr key={c.id}>
                                    <td><ToneChip tone={k.tone} small>{k.label}</ToneChip></td>
                                    <td style={{ color:'var(--text-secondary)' }}>{isAdj ? (c.notes || 'Manual adjustment') : c.contact_name}</td>
                                    <td style={{ color:'var(--text-muted)', whiteSpace:'nowrap' }}>
                                      {new Date(c.earned_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}
                                    </td>
                                    <td style={{ textAlign:'right', fontWeight:700, color: amt < 0 ? 'var(--tone-red-tx)' : 'var(--tone-green-tx)' }}>{signed(amt)}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* SCORECARD — the Team → Scorecards review look: score ring, rating
                chips, Poor → Exceeds tracks. Rating math and thresholds are this
                page's own, unchanged. */}
            {tab === 'scorecard' && (() => {
              const rows = SCORECARD_KPIS.map(kpi => {
                const w = parseFloat(scWeights[kpi.id]) || kpi.weight * 100
                const actual = kpi.id === 'attendance'
                  ? scTotalPoints
                  : (scActuals[kpi.id] != null ? parseFloat(scActuals[kpi.id]) : null)
                const rating = getRating(kpi, actual, scThresholds[kpi.id])
                const { lowerIsBetter, unit } = kpi
                const thr = scThresholds[kpi.id] || kpi.thresholds

                const fmt = (n) => unit === '%' ? `${n}%` : unit === 'points' ? `${n} pts` : `${n}${unit}`
                const range = (lo, hi) => lo === hi ? fmt(lo) : `${fmt(lo)}-${fmt(hi)}`
                let col4, col3, col2, col1
                if (kpi.id === 'attendance') {
                  // Exact values for attendance (lower is better, discrete points)
                  col4 = fmt(thr.exceeds)
                  col3 = fmt(thr.meets)
                  col2 = fmt(thr.improvement)
                  col1 = `${thr.improvement + 1}+ pts`
                } else if (lowerIsBetter) {
                  col4 = `${fmt(thr.exceeds)} or less`
                  col3 = range(thr.exceeds + 1, thr.meets)
                  col2 = range(thr.meets + 1, thr.improvement)
                  col1 = `${fmt(thr.improvement + 1)}+`
                } else {
                  col4 = `${fmt(thr.exceeds)}+`
                  col3 = range(thr.meets, thr.exceeds - 1)
                  col2 = range(thr.improvement, thr.meets - 1)
                  col1 = `Below ${fmt(thr.improvement)}`
                }
                return { kpi, w, actual, rating, thr, fmt, ranges: { 4: col4, 3: col3, 2: col2, 1: col1 } }
              })
              // Overall = the weighted average of the ratings above (the team
              // review's formula). It waits for a scored KPI — attendance alone
              // would read as "Exceeds" before the month's numbers are in.
              const rated = rows.filter(r => r.rating != null && r.w > 0)
              const wSum = rated.reduce((s, r) => s + r.w, 0)
              const score = wSum && rows.some(r => r.kpi.id !== 'attendance' && r.actual != null)
                ? rated.reduce((s, r) => s + r.rating * r.w, 0) / wSum : null
              const lv = levelOf(score)
              const lvTone = lv ? RATING_TONES[lv] : 'gray'
              return (
                <div style={stack}>
                  <div style={{ ...panel, padding: isMobile ? 16 : '20px 22px', display:'flex', alignItems:'center', gap: isMobile ? 14 : 18, flexWrap:'wrap' }}>
                    <Ring pct={score == null ? 0 : (score / 4) * 100} size={72} stroke={6} tone={lvTone}>
                      <Face avatar={profile?.avatar} name={profile?.name || profile?.email} size={54} />
                    </Ring>
                    <div style={{ flex:'1 1 200px', minWidth:0 }}>
                      <div style={{ fontSize:20, fontWeight:800, letterSpacing:'-.01em', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {profile?.name || profile?.email}
                      </div>
                      <div style={{ fontSize:13, color:'var(--text-muted)', marginTop:2 }}>Performance review · {scorecardLabel}</div>
                      <div style={{ display:'flex', gap:6, marginTop:8, flexWrap:'wrap' }}>
                        {lv ? <LevelChip level={lv} /> : <ToneChip tone="gray">Pending</ToneChip>}
                      </div>
                    </div>
                    <div style={{ textAlign: isMobile ? 'left' : 'right' }}>
                      <div style={eyebrow}>Overall score</div>
                      <div style={{ ...num, fontSize: isMobile ? 32 : 38, fontWeight:800, lineHeight:1.05, letterSpacing:'-.03em', color: lv ? `var(--tone-${lvTone}-tx)` : 'var(--text-muted)' }}>
                        {score == null ? '—' : score.toFixed(2)}
                      </div>
                      <div style={{ fontSize:11.5, color:'var(--text-muted)' }}>out of 4.00</div>
                    </div>
                  </div>

                  <div style={{ ...panel, overflow:'hidden' }}>
                    <div style={{ padding: headPad, borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                      <div style={{ fontSize:14, fontWeight:700 }}>KPIs</div>
                      <span style={{ fontSize:12, color:'var(--text-muted)' }}>Each rates 1–4; the overall score is their weighted average</span>
                      <span style={{ ...num, marginLeft:'auto', fontSize:12, color:'var(--text-muted)' }}>
                        Total weight: {SCORECARD_KPIS.reduce((s,k) => s + (parseFloat(scWeights[k.id]) || 0), 0)}%
                      </span>
                    </div>
                    {rows.map(({ kpi, w, actual, rating, thr, fmt, ranges }, idx) => (
                      <div key={kpi.id} className="mgrid" style={{ display:'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(180px, 1.1fr) minmax(150px, .8fr) minmax(260px, 2fr)',
                        gap: isMobile ? 10 : 20, alignItems:'center', padding: isMobile ? '14px 16px' : '14px 20px', borderTop: idx ? '1px solid var(--border)' : 'none' }}>
                        <div>
                          <div style={{ fontSize:14, fontWeight:700 }}>{kpi.label}</div>
                          <div style={{ ...num, fontSize:11.5, color:'var(--text-muted)', marginTop:2 }}>
                            {w}% of the score{kpi.id === 'attendance' ? ' · from your points log' : ''}
                          </div>
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                          <span style={{ ...num, fontSize:22, fontWeight:800, letterSpacing:'-.01em', color: actual != null ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                            {actual != null ? `${actual}${kpi.unit === 'points' ? ' pts' : kpi.unit}` : '—'}
                          </span>
                          {rating ? <LevelChip level={rating} small /> : <ToneChip tone="gray" small>Pending</ToneChip>}
                        </div>
                        <KpiTrack level={rating} value={actual} thr={thr} lowerIsBetter={kpi.lowerIsBetter} fmt={fmt} ranges={ranges} />
                      </div>
                    ))}
                  </div>

                  <div style={{ fontSize:11.5, color:'var(--text-muted)', display:'flex', gap:16, flexWrap:'wrap' }}>
                    <span>Attendance auto-populated from your points log</span>
                    <span>Other scores fill in automatically every hour from ServiceTitan and Andi</span>
                  </div>
                </div>
              )
            })()}
          </>
        )}
      </div>

      {/* 📣 Admin floor alert */}
      {announceOpen && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.45)', zIndex:700, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
          onMouseDown={() => setAnnounceOpen(false)}>
          <div className="modal" onMouseDown={e => e.stopPropagation()} style={{ maxWidth:420 }}>
            <div className="modal-title" style={{ marginBottom:2 }}>Notify the team</div>
            <div style={{ fontSize:12.5, color:'var(--text-muted)', marginBottom:16 }}>Pops on their screen like a schedule alert — with a chime.</div>
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              <div className="form-field">
                <label className="form-label">Who</label>
                <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, fontWeight:600, cursor:'pointer', padding:'6px 2px' }}>
                  <input type="checkbox" checked={announce.all}
                    onChange={e => setAnnounce(a => ({ ...a, all: e.target.checked }))} />
                  Everyone on the floor
                </label>
                {!announce.all && (
                  <div style={{ maxHeight:170, overflowY:'auto', border:'1px solid var(--border)', borderRadius:10, background:'var(--surface-2)', padding:'4px 10px', display:'flex', flexDirection:'column' }}>
                    {annProfiles.map(p => (
                      <label key={p.id} style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer', padding:'5px 2px' }}>
                        <input type="checkbox" checked={announce.ids.includes(p.id)}
                          onChange={e => setAnnounce(a => ({ ...a, ids: e.target.checked ? [...a.ids, p.id] : a.ids.filter(x => x !== p.id) }))} />
                        {p.name || p.email}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="form-field">
                <label className="form-label">Message</label>
                <textarea className="form-input" rows={3} autoFocus value={announce.message}
                  placeholder="Huddle in 5 · Pizza in the break room · Great job on the push this morning!"
                  onChange={e => setAnnounce(a => ({ ...a, message: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendAnnouncement() }} />
                <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginTop:6 }}>
                  {['📣','🎉','👏','🔥','💪','🍕','☕','⏰','🚨','✅','🙌','😂'].map(em => (
                    <button key={em} type="button" onClick={() => setAnnounce(a => ({ ...a, message: a.message + em }))}
                      style={{ border:'1px solid var(--border)', background:'var(--surface-2)', borderRadius:8, padding:'3px 7px', fontSize:15, cursor:'pointer', lineHeight:1 }}>
                      {em}
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-field">
                <label className="form-label">When</label>
                <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap: isMobile ? 'wrap' : undefined }}>
                  <input className="form-input" type="datetime-local" value={announce.sendAt}
                    min={new Date(Date.now() + 2 * 60_000).toISOString().slice(0, 16)}
                    onChange={e => setAnnounce(a => ({ ...a, sendAt: e.target.value }))} style={{ flex:1 }} />
                  {announce.sendAt && <button className="btn sm" onClick={() => setAnnounce(a => ({ ...a, sendAt: '' }))}>Send now instead</button>}
                </div>
                <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>Leave empty to send immediately.</div>
              </div>
              {annScheduled.length > 0 && (
                <div style={{ border:'1px solid var(--border)', borderRadius:10, padding:'8px 12px', display:'flex', flexDirection:'column', gap:5 }}>
                  <div style={eyebrow}>Scheduled</div>
                  {annScheduled.map(m => (
                    <div key={m.id} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12 }}>
                      <span style={{ ...num, fontWeight:700, flexShrink:0 }}>
                        {new Date(m.sendAt).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}
                      </span>
                      <span style={{ color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>
                        {m.to === 'all' ? 'Everyone' : m.toNames || 'Selected'} — {m.message}
                      </span>
                      <button onClick={() => unscheduleAnn(m.id)} title="Cancel this scheduled message" aria-label="Cancel this scheduled message"
                        style={{ border:'none', background:'none', color:'var(--tone-red-tx)', cursor:'pointer', fontSize:15, lineHeight:1, flexShrink:0 }}>×</button>
                    </div>
                  ))}
                </div>
              )}
              {announceMsg && <div style={{ fontSize:12.5, fontWeight:700, color:'var(--tone-red-tx)' }}>{announceMsg}</div>}
              <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
                <button className="btn" onClick={() => setAnnounceOpen(false)}>Cancel</button>
                <button className="btn primary" onClick={sendAnnouncement}
                  disabled={announceBusy || !announce.message.trim() || (!announce.all && !announce.ids.length)}>
                  {announceBusy ? 'Sending…' : announce.sendAt ? '📅 Schedule it' : announce.all ? 'Send to everyone' : `Send (${announce.ids.length})`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {swapDay !== null && (
        <ShiftSwapModal profile={profile} profiles={profiles} schedules={schedules}
          initialDate={swapDay || undefined} onClose={() => setSwapDay(null)}
          onSubmitted={() => { setPtoToast('Swap request sent — your co-worker has been emailed.'); setTimeout(() => setPtoToast(''), 6000) }} />
      )}
      {ptoDay && (
        <PtoRequestModal initialDate={ptoDay} onClose={() => setPtoDay(null)}
          onSubmitted={() => { setPtoToast('Request sent — your manager has been notified. Track it in the Time Off tab.'); setTimeout(() => setPtoToast(''), 6000) }} />
      )}
      {ptoToast && (
        <div role="status" style={{ position:'fixed', bottom:20, right:20, left: isMobile ? 20 : undefined, zIndex:900, background:'var(--tone-green-bg)', border:'1px solid var(--tone-green-bd)', color:'var(--tone-green-tx)', borderRadius:12, padding:'11px 16px', fontSize:12.5, fontWeight:600, boxShadow:'0 12px 28px -14px rgba(15,20,40,.35)' }}>
          ✓ {ptoToast}
        </div>
      )}
    </div>
  )
}

// A day-type chip small enough for a month-calendar cell.
function DayChip({ tone, tiny, children }) {
  return (
    <span style={{ display:'inline-block', maxWidth:'100%', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', verticalAlign:'top',
      fontSize: tiny ? 9 : 10, fontWeight:700, borderRadius:99, padding: tiny ? '1px 5px' : '1px 7px',
      color:`var(--tone-${tone}-tx)`, background:`var(--tone-${tone}-bg)`, border:`1px solid var(--tone-${tone}-bd)` }}>
      {children}
    </span>
  )
}

// The kit's SummaryPanel on desktop. On a phone the kit stacks one zone per
// row (My Stats ran three screens tall), so here zones sit `cols` across,
// with hairlines between, and any index in `wide` takes a whole row.
function Zones({ isMobile, columns, cols = 2, wide = [], children }) {
  const zones = Children.toArray(children).filter(Boolean)
  if (!isMobile) return <SummaryPanel columns={columns} style={{ marginBottom:0 }}>{zones}</SummaryPanel>
  let row = 0, col = 0
  const cells = zones.map((z, i) => {
    const span = wide.includes(i) ? cols : 1
    if (col + span > cols) { row++; col = 0 }
    const cell = { z, span, top: row > 0, left: col > 0 }
    col += span
    if (col >= cols) { row++; col = 0 }
    return cell
  })
  return (
    <div className="mgrid" style={{ ...panel, display:'grid', gridTemplateColumns:`repeat(${cols}, minmax(0, 1fr))` }}>
      {cells.map((c, i) => (
        <div key={i} style={{ gridColumn: c.span > 1 ? '1 / -1' : undefined, padding: cols > 2 ? '12px 12px' : '14px 16px', minWidth:0,
          borderTop: c.top ? '1px solid var(--border)' : 'none', borderLeft: c.left ? '1px solid var(--border)' : 'none' }}>
          {c.z}
        </div>
      ))}
    </div>
  )
}

// The kit's Stat at phone size, for zones two or three across.
function MiniStat({ label, value, sub, tone, size = 22 }) {
  return (
    <div>
      <div style={eyebrow}>{label}</div>
      <div style={{ ...num, fontSize:size, fontWeight:800, letterSpacing:'-.03em', lineHeight:1.1, marginTop:4,
        color: tone ? `var(--tone-${tone}-tx)` : 'var(--text-primary)' }}>{value}</div>
      {sub && <div style={{ fontSize:11.5, color:'var(--text-secondary)', marginTop:3 }}>{sub}</div>}
    </div>
  )
}

// Rating chip — the team review's LevelChip look with this page's labels.
function LevelChip({ level, small }) {
  return <ToneChip tone={RATING_TONES[level]} small={small}>{RATING_LABELS[level]}</ToneChip>
}

// Poor → Exceeds, worst-left / best-right (attendance included), after the
// team review's KpiTrack. The zone comes from this page's own rating; the
// marker interpolates inside the two middle zones and centers in the
// open-ended outer ones. Each zone's exact range is its tooltip.
function KpiTrack({ level, value, thr, lowerIsBetter, fmt, ranges }) {
  let pos = null
  if (level) {
    const z = level - 1
    let frac = 0.5
    if (z === 1 || z === 2) {
      const [lo, hi] = z === 1 ? [thr.improvement, thr.meets] : [thr.meets, thr.exceeds]
      frac = hi === lo ? 0.5 : Math.min(0.92, Math.max(0.08, lowerIsBetter ? (lo - value) / (lo - hi) : (value - lo) / (hi - lo)))
    }
    pos = ((z + frac) / 4) * 100
  }
  const tone = level ? RATING_TONES[level] : null
  const tip = (lv) => `${RATING_LABELS[lv]} (${lv}): ${ranges[lv]}`
  return (
    <div style={{ minWidth:0 }}>
      <div className="mgrid" style={{ display:'grid', gridTemplateColumns:'repeat(4, minmax(0, 1fr))', gap:3, marginBottom:4 }}>
        {ZONES.map((z, i) => {
          const on = level === i + 1
          return (
            <span key={z} title={tip(i + 1)} style={{ fontSize:10.5, fontWeight: on ? 800 : 600, textAlign:'center', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
              color: on ? `var(--tone-${RATING_TONES[i + 1]}-tx)` : 'var(--text-muted)' }}>{z}</span>
          )
        })}
      </div>
      <div style={{ position:'relative' }}>
        <div className="mgrid" style={{ display:'grid', gridTemplateColumns:'repeat(4, minmax(0, 1fr))', gap:3 }}>
          {ZONES.map((z, i) => {
            const lv = i + 1
            const t = RATING_TONES[lv]
            return <div key={z} title={tip(lv)} style={{ height:9, borderRadius:99, background: level === lv ? `var(--tone-${t}-tx)` : `var(--tone-${t}-bg)`,
              border:`1px solid var(--tone-${t}-bd)`, opacity: level && level !== lv ? 0.7 : 1 }} />
          })}
        </div>
        {pos != null && (
          <div style={{ position:'absolute', top:'50%', left:`${pos}%`, width:15, height:15, transform:'translate(-50%, -50%)', borderRadius:99,
            background:'var(--surface)', border:`3px solid var(--tone-${tone}-tx)`, boxShadow:'0 1px 4px rgba(15,20,40,.25)' }} />
        )}
      </div>
      <div style={{ position:'relative', height:14, marginTop:5 }}>
        {[thr.improvement, thr.meets, thr.exceeds].map((b, i) => (
          <span key={i} style={{ ...num, position:'absolute', left:`${(i + 1) * 25}%`, transform:'translateX(-50%)', fontSize:10, color:'var(--text-muted)', whiteSpace:'nowrap' }}>
            {fmt(b)}
          </span>
        ))}
      </div>
    </div>
  )
}

// Commission type tile — the type's icon in its tone, as on Team → Commissions.
function CommTile({ kind }) {
  return (
    <div title={kind.label} style={{ width:34, height:34, borderRadius:10, flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center',
      color:`var(--tone-${kind.tone}-tx)`, background:`var(--tone-${kind.tone}-bg)`, border:`1px solid var(--tone-${kind.tone}-bd)` }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={COMM_ICONS[kind.key]} />
      </svg>
    </div>
  )
}
