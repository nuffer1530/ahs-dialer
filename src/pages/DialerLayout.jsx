import { useState, useEffect, useRef } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import WeatherStrip from '../components/WeatherStrip'
import AskAndi from '../components/AskAndi'
import { DialogHost } from '../lib/dialogs'
import { useIsMobile } from '../lib/useIsMobile'
import { loadOpsConfig } from '../lib/opsConfig'
import { useData } from '../lib/DataContext'
import { sb } from '../lib/supabase'
import { syncWorkerActivity } from '../lib/utils'
import { useOpenLeads } from '../lib/useOpenLeads'
import { usePtoApprovals } from '../lib/usePtoApprovals'
import { PhoneProvider, usePhone } from '../lib/PhoneContext'
import { useWallKiosk } from '../lib/useDailyReload'
import DialerPage from './DialerPage'
import CampaignsPage from './CampaignsPage'
import DashboardPage from './DashboardPage'
import LivePage from './LivePage'
import CallBoardPage from './CallBoardPage'
import DispatchPage from './DispatchPage'
import AdminPage from './AdminPage'
import WarRoomPage from './WarRoomPage'
import DeptTVPage from './DeptTVPage'
import CEOTVPage from './CEOTVPage'
import AttendancePage from './AttendancePage'
import RecordingsPage from './RecordingsPage'
import MyPage from './MyPage'
import LeadershipPage from './LeadershipPage'
import TeamPage from './TeamPage'
import HomePage from './HomePage'
import WinCelebration from '../components/WinCelebration'
import ScheduleAlerts from '../components/ScheduleAlerts'
import Sidebar from '../components/shell/Sidebar'
import TopBar from '../components/shell/TopBar'
import PhoneDock from '../components/shell/PhoneDock'
import CommandPalette from '../components/shell/CommandPalette'
import MobileTabBar from '../components/shell/MobileTabBar'
import { visibleHubs, hubForPath, tvBoards, meLinks, roleLabel, OTHER_TITLES } from '../components/shell/nav'

const DEFAULT_STATUS_OPTIONS = [
  { value: 'Inbound',   color: '#16a34a' },
  { value: 'Available', color: '#22c55e' },
  { value: 'On Call',   color: '#3b82f6' },
  { value: 'Wrap Up',   color: '#f59e0b' },
  { value: 'Break',     color: '#a855f7' },
  { value: 'Lunch',     color: '#f97316' },
  { value: 'Offline',   color: '#6b7280' },
]

const GRACE_MINUTES = 5

// ⌘K customer search — the dialer's own ServiceTitan search endpoint. Module
// scope so its identity is stable (the layout re-renders every second for the
// status timer, which would otherwise restart the palette's debounce).
async function searchStCustomers(q) {
  const r = await fetch(`/api/st/search?q=${encodeURIComponent(q)}`)
  const d = await r.json().catch(() => ({}))
  return Array.isArray(d.data) ? d.data : []
}

// A ringing phone must interrupt you wherever you are. Previously the only
// incoming-call UI was inside DialerPage, so a rep on any other screen had no
// idea a customer was waiting.
function GlobalIncomingCall() {
  const { incomingCall, acceptIncoming, rejectIncoming } = usePhone()
  const navigate = useNavigate()
  const location = useLocation()
  // Which marketing channel is ringing? The server looked it up in ST the
  // moment the call hit — ride the same endpoint the notes poll uses.
  const [channel, setChannel] = useState(null)
  useEffect(() => {
    setChannel(null)
    const phone = incomingCall?.from
    if (!phone || incomingCall?.isTeammate) return
    const t = setTimeout(() => {   // give the ST lookup a beat to land
      fetch(`/api/call-notes/latest?phone=${encodeURIComponent(phone)}`)
        .then(r => r.json()).then(d => { if (d?.channel) setChannel(d.channel) }).catch(() => {})
    }, 2500)
    return () => clearTimeout(t)
  }, [incomingCall?.from])
  if (!incomingCall) return null

  const st = incomingCall.stLookup
  const known = incomingCall.contactName
    || (st && st !== 'loading' && st !== 'none' && st.found ? st.name : null)

  const answer = () => {
    acceptIncoming()
    // The dialer resolves the caller into a tab, so go there to take the call.
    if (location.pathname !== '/') navigate('/')
  }

  return (
    <div style={{
      position:'fixed', top:16, left:'50%', transform:'translateX(-50%)', zIndex:2000,
      background:'var(--surface)', border:'2px solid #16A34A', borderRadius:'var(--radius-lg)',
      boxShadow:'0 12px 40px rgba(0,0,0,.28)', padding:'14px 18px',
      display:'flex', alignItems:'center', gap:16, minWidth:420,
      animation:'pulse-ring 1.4s ease-in-out infinite',
    }}>
      <style>{`@keyframes pulse-ring{0%,100%{box-shadow:0 12px 40px rgba(0,0,0,.28),0 0 0 0 rgba(22,163,74,.45)}50%{box-shadow:0 12px 40px rgba(0,0,0,.28),0 0 0 10px rgba(22,163,74,0)}}`}</style>
      <div className="pulse-mark-fast" style={{ width:46, height:46, borderRadius:13, background:'#111318', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
        <svg width="28" height="28" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <polyline points="9,32 19,32 25,17 33,47 40,26 45,32 55,32" fill="none" stroke="#ff751f" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      <div style={{ minWidth:0, flex:1 }}>
        <div style={{ fontSize:10, fontWeight:700, letterSpacing:.5, textTransform:'uppercase', color:'#16A34A' }}>Incoming call</div>
        <div style={{ fontSize:15, fontWeight:700, color:'var(--text-primary)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
          {known || (st === 'loading' ? 'Looking up…' : 'Unknown caller')}
        </div>
        <div style={{ fontSize:12, color:'var(--text-muted)' }}>
          {incomingCall.from}{channel ? <span style={{ color:'var(--tone-purple-tx)', fontWeight:700 }}> · {channel}</span> : ''}
        </div>
      </div>
      <button onClick={rejectIncoming}
        style={{ padding:'8px 14px', borderRadius:'var(--radius)', border:'1px solid var(--border)', background:'var(--surface-2)', color:'var(--text-secondary)', fontSize:13, fontWeight:600, cursor:'pointer' }}>
        Decline
      </button>
      <button onClick={answer}
        style={{ padding:'8px 18px', borderRadius:'var(--radius)', border:'none', background:'#16A34A', color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer' }}>
        Answer
      </button>
    </div>
  )
}

// The phone must be registered on every route, not just the dialer, so the
// provider wraps the whole shell and the layout consumes it.
export default function DialerLayout() {
  return (
    <PhoneProvider>
      <DialerLayoutInner />
    </PhoneProvider>
  )
}

function DialerLayoutInner() {
  const { profile, isAdmin, isDispatcher, isOpsManager } = useAuth()
  useEffect(() => { loadOpsConfig() }, [])   // pull admin thresholds into the live bindings
  // Deploy watcher: open tabs run old code until reloaded, which turned every
  // fix into 'hard refresh first'. Poll the bundle name; when it changes, show
  // a reload banner (never auto-reload — reps may be mid-call).
  const [updateReady, setUpdateReady] = useState(false)
  useEffect(() => {
    let initial = null
    const check = async () => {
      try {
        const html = await fetch('/', { cache: 'no-store' }).then(r => r.text())
        const m = html.match(/assets\/index-[^"]+\.js/)
        if (!m) return
        if (initial === null) initial = m[0]
        else if (m[0] !== initial) setUpdateReady(true)
      } catch {}
    }
    check()
    const t = setInterval(check, 4 * 60_000)
    return () => clearInterval(t)
  }, [])
  const canDispatch = isAdmin || isDispatcher
  // Leadership page is owner-only by default; server enforces the real list
  // (app_settings 'leadership_viewers') — this just controls nav visibility.
  const isLeader = isAdmin && ['brandynnuffer@gmail.com', 'brandyn.nuffer@awesomeservice.com']
    .includes((profile?.email || '').toLowerCase())
  // Home (redesign stage 2) is for people who run the business; the owner
  // and operations managers land on it. Everyone else still lands on the
  // dialer, and Phones is one click away for all.
  const homeAllowed = isAdmin || isOpsManager || canDispatch
  // Brandyn (Sep 26): opening Andi should land on Home. People who take
  // inbound calls still start on the dialer — that's where their phone work is.
  const landOnHome = homeAllowed && (isLeader || isOpsManager || !profile?.inbound_skill)
  const { contacts, syncStatus, reload } = useData()
  const { cancelAutoWrap, callStatus, callDuration, incomingCall } = usePhone()
  const navigate = useNavigate()
  const location = useLocation()
  // Wall TVs: no top bar, no banners, and — once the wall look is on for the
  // device — no sidebar either, so a reload never brings the chrome back.
  const wallKiosk = useWallKiosk(location.pathname)
  const onTvRoute = location.pathname === '/warroom' || location.pathname.startsWith('/tv/')
  const isWall = onTvRoute || (location.pathname === '/callboard' && wallKiosk)
  const hideSidebar = wallKiosk && (onTvRoute || location.pathname === '/callboard')
  const [agentStatus, setAgentStatus] = useState('Offline')
  const isMobile = useIsMobile()
  // Touch device at phone width — decided once so a narrow desktop window never loses the dialer.
  const [isHandheld] = useState(() => typeof window !== 'undefined' && !!window.matchMedia
    && window.matchMedia('(max-width: 768px) and (pointer: coarse)').matches)
  const [mobileNav, setMobileNav] = useState(false)
  const [statusDuration, setStatusDuration] = useState(0)
  const statusTimerRef = useRef(null)
  const statusStartRef = useRef(null)
  const [alerts, setAlerts] = useState([])
  const currentEventRef = useRef(null)
  // The rail's collapsed state survives reloads.
  const [navCollapsed, setNavCollapsed] = useState(() => { try { return localStorage.getItem('andi-rail') === 'collapsed' } catch { return false } })
  const toggleRail = () => setNavCollapsed(v => { try { localStorage.setItem('andi-rail', v ? 'open' : 'collapsed') } catch {} return !v })
  // ⌘K / Ctrl+K opens the command palette anywhere but the wall TVs.
  const [paletteOpen, setPaletteOpen] = useState(false)

  // Open paid-lead count for the Dialer nav badge. Everyone sees it (leads are
  // claim-on-open, first rep there wins) and it clears the moment the inbox
  // empties — including when a booking is dismissed inside ServiceTitan.
  const openLeads = useOpenLeads()
  const ptoApprovals = usePtoApprovals(profile?.id, isAdmin)
  const [statusOptions, setStatusOptions] = useState(DEFAULT_STATUS_OPTIONS)

  // Load custom statuses from app_settings
  useEffect(() => {
    sb.from('app_settings').select('value').eq('key', 'custom_statuses').maybeSingle()
      .then(({ data }) => {
        if (data?.value) {
          try {
            const saved = JSON.parse(data.value)
            // Map saved statuses {id, label, color} to picker format {value, color}
            const mapped = saved.map(s => ({ value: s.label || s.value || s.id, color: s.color }))
            if (mapped.length > 0) setStatusOptions(mapped)
          } catch (e) {
            console.warn('Failed to parse custom statuses:', e)
          }
        }
      })
  }, [])
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('andi-theme')
    if (saved) { document.documentElement.setAttribute('data-theme', saved); return saved === 'dark' }
    return false
  })

  const toggleTheme = () => {
    const next = darkMode ? 'light' : 'dark'
    setDarkMode(!darkMode)
    document.documentElement.setAttribute('data-theme', next === 'dark' ? 'dark' : '')
    localStorage.setItem('andi-theme', next)
  }

  useEffect(() => {
    if (profile?.status) {
      setAgentStatus(profile.status)
      if (statusTimerRef.current) clearInterval(statusTimerRef.current)
      statusStartRef.current = profile.status_since ? new Date(profile.status_since).getTime() : Date.now()
      setStatusDuration(Math.floor((Date.now() - statusStartRef.current) / 1000))
      statusTimerRef.current = setInterval(() => {
        setStatusDuration(Math.floor((Date.now() - statusStartRef.current) / 1000))
      }, 1000)
    }
  }, [profile])

  useEffect(() => {
    if (!profile?.id) return
    const channel = sb.channel('nav-status')
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'profiles',
        filter: `id=eq.${profile.id}`
      }, payload => {
        if (payload.new?.status) {
          setAgentStatus(payload.new.status)
          if (statusTimerRef.current) clearInterval(statusTimerRef.current)
          const since = payload.new.status_since ? new Date(payload.new.status_since).getTime() : Date.now()
          statusStartRef.current = since
          setStatusDuration(Math.floor((Date.now() - since) / 1000))
          statusTimerRef.current = setInterval(() => {
            setStatusDuration(Math.floor((Date.now() - statusStartRef.current) / 1000))
          }, 1000)
        }
      })
      .subscribe()
    return () => sb.removeChannel(channel)
  }, [profile?.id])

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(v => !v) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    const checkAlerts = async () => {
      const { data: profiles } = await sb.from('profiles').select('id, name, status, status_since').eq('active', true).neq('status', 'Offline')
      if (!profiles) return
      const { data: schedulesRaw } = await sb.from('schedules').select('*').eq('date', new Date().toISOString().slice(0,10))
      const schedules = (schedulesRaw || []).filter(r => !('published_at' in r) || r.published_at)
      const now = Date.now()
      const newAlerts = []
      for (const p of profiles) {
        const elapsed = p.status_since ? Math.floor((now - new Date(p.status_since).getTime()) / 60000) : 0
        const sched = schedules?.find(s => s.profile_id === p.id)
        let limit = null
        if (p.status === 'Break') limit = (sched?.break1_duration || 15) + GRACE_MINUTES
        else if (p.status === 'Lunch') limit = (sched?.lunch_duration || 30) + GRACE_MINUTES
        if (limit && elapsed > limit) {
          newAlerts.push({ id: p.id, name: p.name, status: p.status, elapsed, limit })
        }
      }
      setAlerts(newAlerts)
    }
    checkAlerts()
    const interval = setInterval(checkAlerts, 60000)
    return () => clearInterval(interval)
  }, [isAdmin])

  const fmtDur = (secs) => {
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    const s = secs % 60
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    return `${m}:${String(s).padStart(2,'0')}`
  }

  // Auto-tardiness: the first time a rep goes Available for the day, if it's
  // more than the grace window past their scheduled shift start, log a 0.5
  // attendance point with a note of when they came on vs when they were due.
  const recordLateArrival = async (nowIso) => {
    try {
      const d = new Date()
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const { data: sched } = await sb.from('schedules').select('shift_start, day_type')
        .eq('profile_id', profile.id).eq('date', today).maybeSingle()
      if (!sched || !sched.shift_start || ['pto', 'sick', 'holiday', 'off'].includes(sched.day_type)) return

      // Only the FIRST Available of the day is their arrival — check before the
      // new status_event is inserted below.
      const { data: prior } = await sb.from('status_events').select('id')
        .eq('profile_id', profile.id).eq('status', 'Available').gte('started_at', today + 'T00:00:00').limit(1)
      if (prior && prior.length) return
      // One auto late point per day.
      const { data: existing } = await sb.from('attendance_points').select('id')
        .eq('profile_id', profile.id).eq('date', today).eq('reason', 'late').limit(1)
      if (existing && existing.length) return

      const [sh, sm] = sched.shift_start.split(':').map(Number)
      const shiftStart = new Date(today + 'T00:00:00'); shiftStart.setHours(sh, sm, 0, 0)
      const arrival = new Date(nowIso)
      if (arrival.getTime() <= shiftStart.getTime() + GRACE_MINUTES * 60_000) return   // within grace

      const fmt = t => t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      await sb.from('attendance_points').insert({
        profile_id: profile.id, date: today, points: 0.5, reason: 'late', auto_generated: true, created_by: profile.id,
        notes: `Auto: went available at ${fmt(arrival)}, scheduled ${fmt(shiftStart)} (${GRACE_MINUTES}-min grace)`,
      })
    } catch (e) { console.warn('late arrival check:', e.message) }
  }

  const updateStatus = async (newStatus) => {
    // Any manual status change cancels a pending auto-wrap-up return — including
    // re-selecting Wrap Up to keep wrapping.
    cancelAutoWrap?.()
    setAgentStatus(newStatus)
    if (statusTimerRef.current) clearInterval(statusTimerRef.current)
    const now = new Date().toISOString()
    statusStartRef.current = Date.now()
    setStatusDuration(0)
    statusTimerRef.current = setInterval(() => {
      setStatusDuration(Math.floor((Date.now() - statusStartRef.current) / 1000))
    }, 1000)
    if (currentEventRef.current) {
      await sb.from('status_events').update({ ended_at: now }).eq('id', currentEventRef.current)
      currentEventRef.current = null
    }
    // The label only exists while actually engaged — every other status,
    // Wrap Up included, clears it.
    const patch = { status: newStatus, status_since: now }
    if (newStatus !== 'On Call') patch.interaction_type = null
    await sb.from('profiles').update(patch).eq('id', profile.id)
    syncWorkerActivity(profile.id, newStatus)
    // Check tardiness before inserting the new Available event (so it's not
    // counted as a prior arrival).
    if (newStatus === 'Available') await recordLateArrival(now)
    const { data: evt } = await sb.from('status_events').insert({
      profile_id: profile.id, status: newStatus, started_at: now
    }).select().single()
    if (evt) currentEventRef.current = evt.id
  }

  const signOut = async () => {
    const now = new Date().toISOString()
    await sb.from('profiles').update({ status: 'Offline', status_since: now, interaction_type: null }).eq('id', profile.id)
    syncWorkerActivity(profile.id, 'Offline')
    if (currentEventRef.current) {
      await sb.from('status_events').update({ ended_at: now }).eq('id', currentEventRef.current)
      currentEventRef.current = null
    }
    await sb.auth.signOut()
    navigate('/login')
  }

  const currentStatusObj = statusOptions.find(s => s.value === agentStatus) || statusOptions[statusOptions.length - 1]
  // First load only: decided in the route itself (below), before the dialer
  // ever mounts — no flash of the dialer, no redirect racing the page. Later
  // clicks on Phones ('/') open the dialer as usual.
  const [landed, setLanded] = useState(false)
  useEffect(() => { setLanded(true) }, [])

  // Mobile: the sidebar becomes a slide-over drawer; navigating closes it.
  useEffect(() => { setMobileNav(false) }, [location.pathname])

  // ── Navigation model (redesign stage 1): hubs instead of 13 sidebar items.
  const navCtx = { isAdmin, isOpsManager, canDispatch, isLeader, isHandheld, leadsTeams: (profile?.leads_teams || []).length > 0 }
  const hubs = visibleHubs(navCtx)
  const hub = hubForPath(hubs, location.pathname)
  const boards = tvBoards(navCtx)
  const mine = meLinks(navCtx)
  const roleText = roleLabel(navCtx, profile)
  const pageTitle = hub?.label || OTHER_TITLES[location.pathname] || 'andi'
  const onDialer = location.pathname === '/'
  const inCall = ['calling', 'ringing', 'connected'].includes(callStatus)
  // Folded in from the old top-right nudge: Available with campaigns to work.
  const outboundWaiting = agentStatus === 'Available' && !incomingCall
    && Array.isArray(profile?.active_campaign_ids) && profile.active_campaign_ids.length > 0
  const railProps = {
    hubs, pathname: location.pathname, badges: { phones: openLeads }, profile, roleText,
    statusColor: isOpsManager ? null : currentStatusObj.color, tvBoards: boards, meLinks: mine, ptoApprovals,
    alerts: isAdmin ? alerts : [], onNavigate: (to) => navigate(to), onOpenPalette: () => setPaletteOpen(true),
    darkMode, onToggleTheme: toggleTheme, onSignOut: signOut,
  }
  const paletteItems = [
    ...hubs.flatMap(h => h.tabs.map(t => ({ id: `go:${t.to}`, label: h.tabs.length > 1 ? `${h.label} · ${t.label}` : h.label, keywords: t.label, group: 'Go to', icon: h.icon, run: () => navigate(t.to) }))),
    ...boards.map(b => ({ id: `tv:${b.to}`, label: `${b.label} TV`, group: 'TV boards', icon: 'tv', run: () => navigate(b.to) })),
    ...mine.map(l => ({ id: `me:${l.to}`, label: l.label, keywords: 'my page me', group: 'You', icon: l.to === '/settings' ? 'settings' : 'user', run: () => navigate(l.to) })),
    ...(isOpsManager ? [] : statusOptions.map(o => ({ id: `status:${o.value}`, label: `Set status: ${o.value}`, keywords: 'status', group: 'Actions', icon: 'phone', run: () => updateStatus(o.value) }))),
    { id: 'theme', label: darkMode ? 'Switch to light mode' : 'Switch to dark mode', keywords: 'theme dark light', group: 'Actions', icon: darkMode ? 'sun' : 'moon', run: toggleTheme },
    ...(updateReady ? [{ id: 'reload', label: 'Reload to get the latest Andi', group: 'Actions', icon: 'refresh', run: () => window.location.reload() }] : []),
    { id: 'signout', label: 'Sign out', group: 'Actions', icon: 'logout', run: signOut },
  ]
  // Phone tab bar: the hubs this role opens most from a phone, then More.
  const mobileItems = (() => {
    const hubItem = (id, to, label) => {
      const h = hubs.find(x => x.id === id)
      return h ? { to: to && h.tabs.some(t => t.to === to) ? to : h.tabs[0].to, label: label || h.label, icon: h.icon, match: h.tabs.map(t => t.to) } : null
    }
    const list = isOpsManager
      ? [hubItem('home'), hubItem('team'), hubItem('dispatch'), boards[0] && { to: boards.find(b => b.to !== '/warroom')?.to || boards[0].to, label: 'TV', icon: 'tv', match: ['/tv'] }]
      : [hubItem('home'), hubItem('calls', '/analytics'), hubItem('dispatch'), hubItem('team'), isLeader ? hubItem('leadership') : null,
         { to: '/mypage', label: 'Me', icon: 'user' }]
    return list.filter(Boolean).slice(0, 4)
  })()

  return (
    <div className={`app-shell${isMobile && !isWall ? ' has-tabbar' : ''}`}
      style={{ display:'flex', height:'100vh', overflow:'hidden', fontFamily: isWall ? 'var(--font-legacy)' : undefined }}>
      <WinCelebration />

      {/* ── Rail (desktop) / slide-over drawer (phone) ── */}
      {!hideSidebar && !isMobile && (
        <div style={{ flexShrink: 0, height: '100%', zIndex: 100, transition: 'width .2s' }}>
          <Sidebar {...railProps} collapsed={navCollapsed} onToggleCollapse={toggleRail} />
        </div>
      )}
      {isMobile && mobileNav && (
        <>
          <div onClick={() => setMobileNav(false)} style={{ position:'fixed', inset:0, background:'rgba(13,16,19,.5)', zIndex:1290 }} />
          <div style={{ position:'fixed', top:0, bottom:0, left:0, zIndex:1300, boxShadow:'0 0 40px rgba(0,0,0,.35)' }}>
            <Sidebar {...railProps} drawer onNavigate={(to) => { setMobileNav(false); navigate(to) }}
              onOpenPalette={() => { setMobileNav(false); setPaletteOpen(true) }}
              statusOptions={isOpsManager ? null : statusOptions} currentStatus={agentStatus} onSetStatus={updateStatus} />
          </div>
        </>
      )}

      {/* ── Main column ── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>
        {/* Wallboards update themselves in the background — never a banner on a TV. */}
        {updateReady && !isWall && (
          <div style={{ background:'var(--ink)', color:'#fff', padding:'7px 16px', display:'flex', alignItems:'center', justifyContent:'center', gap:12, fontSize:12.5, fontWeight:600, flexShrink:0, zIndex:200 }}>
            <span>Andi was updated — reload to get the latest (finish your call first).</span>
            <button onClick={() => window.location.reload()}
              style={{ background:'var(--signal)', color:'#0D1013', border:'none', borderRadius:99, padding:'4px 14px', fontSize:12, fontWeight:700, cursor:'pointer' }}>
              Reload now
            </button>
          </div>
        )}
        {!isWall && <AskAndi />}
        <DialogHost />
        {!isWall && (
          <TopBar title={pageTitle} tabs={hub?.tabs || []} pathname={location.pathname} onNavigate={(to) => navigate(to)}
            isMobile={isMobile} onOpenPalette={() => setPaletteOpen(true)} onOpenMenu={() => setMobileNav(true)}
            right={!isMobile ? <WeatherStrip /> : null} />
        )}
        <GlobalIncomingCall />
        {!isOpsManager && <ScheduleAlerts />}
        <div style={isMobile && !isWall ? { flex:1, minHeight:0, display:'flex', flexDirection:'column', overflow:'hidden' } : { display:'contents' }}>
        <Routes>
          {/* A phone is for looking, not dialing — the dialer is desktop-only. */}
          <Route path="/" element={
            !landed && landOnHome && !location.search ? <Navigate to="/home" replace />
            : isHandheld ? <Navigate to={homeAllowed ? '/home' : '/analytics'} replace />
            : <DialerPage />} />
          {homeAllowed && <Route path="/home" element={<HomePage />} />}
          {isAdmin && <Route path="/campaigns" element={<div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}><CampaignsPage /></div>} />}
          {/* Operations managers are field-side: call-center pages bounce home. */}
          <Route path="/live" element={isOpsManager ? <Navigate to="/" replace /> : <LivePage />} />
          <Route path="/callboard" element={<CallBoardPage />} />
          {canDispatch && <Route path="/dispatch" element={<DispatchPage />} />}
          <Route path="/analytics" element={isOpsManager ? <Navigate to="/" replace /> : <DashboardPage />} />
          <Route path="/recordings" element={isOpsManager ? <Navigate to="/" replace /> : <RecordingsPage />} />
          {isAdmin && <Route path="/attendance" element={<AttendancePage />} />}
          {(isAdmin || isOpsManager || (profile?.leads_teams || []).length > 0) && <Route path="/team" element={<TeamPage />} />}
          {isLeader && <Route path="/leadership/*" element={<LeadershipPage />} />}
          <Route path="/warroom" element={isOpsManager ? <Navigate to="/" replace /> : <WarRoomPage />} />
          {isLeader && <Route path="/tv/ceo" element={<CEOTVPage />} />}
          <Route path="/tv/:trade" element={<DeptTVPage />} />
          <Route path="/mypage" element={isOpsManager ? <Navigate to="/team" replace /> : <MyPage />} />
          <Route path="/settings" element={<AdminPage />} />
        </Routes>
        </div>
        {isMobile && !isWall && <MobileTabBar items={mobileItems} pathname={location.pathname} onNavigate={(to) => navigate(to)} onMore={() => setMobileNav(true)} />}
      </div>

      {/* ── Phone dock: status + the phone on every desktop page ── */}
      {!isWall && !isMobile && (
        <PhoneDock showStatus={!isOpsManager} status={currentStatusObj.value} statusColor={currentStatusObj.color}
          statusSeconds={statusDuration} statusOptions={statusOptions} onSetStatus={updateStatus}
          onDialer={onDialer} onOpenDialer={() => navigate('/')} inCall={inCall} callSeconds={callDuration || 0}
          outboundWaiting={!isOpsManager && outboundWaiting} openLeads={isOpsManager ? 0 : openLeads} isOpsManager={isOpsManager} />
      )}
      <CommandPalette open={paletteOpen && !isWall} onClose={() => setPaletteOpen(false)} items={paletteItems}
        // ServiceTitan customers, straight into the dialer (desktop only — the dialer is).
        searchCustomers={isHandheld ? null : searchStCustomers}
        onPickCustomer={(cust) => navigate('/', { state: { openStCustomer: cust } })} />
    </div>
  )
}
