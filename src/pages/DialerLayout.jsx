import { useState, useEffect, useRef } from 'react'
import { Routes, Route, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { useData } from '../lib/DataContext'
import { sb } from '../lib/supabase'
import DialerPage from './DialerPage'
import CampaignsPage from './CampaignsPage'
import DashboardPage from './DashboardPage'
import LivePage from './LivePage'
import NotesPage from './NotesPage'
import AdminPage from './AdminPage'
import WarRoomPage from './WarRoomPage'
import LeaderboardPage from './LeaderboardPage'
import AttendancePage from './AttendancePage'
import RecordingsPage from './RecordingsPage'
import MyPage from './MyPage'
import WinCelebration from '../components/WinCelebration'

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

const ICON_COLOR = '#ff751f'
const ICON_MUTED = '#9E9B96'

const NAV_ICONS = {
  dialer: (active) => {
    const c = active ? ICON_COLOR : ICON_MUTED
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5.4 11.1C6.8 13.9 9.1 16.1 12 17.5l2.3-2.3c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.7.6.6 0 1 .4 1 1v3.6c0 .6-.4 1-1 1C9.6 21.2 2.8 14.4 2.8 6c0-.6.4-1 1-1H7.4c.6 0 1 .4 1 1 0 1.4.2 2.6.6 3.7.1.4 0 .7-.3 1L5.4 11.1z" fill={c}/>
      </svg>
    )
  },
  live: (active) => {
    const c = active ? ICON_COLOR : ICON_MUTED
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="3" fill={c}/>
        <path d="M8.5 8.5a5 5 0 000 7M15.5 8.5a5 5 0 010 7" stroke={c} strokeWidth="1.8" strokeLinecap="round" fill="none"/>
        <path d="M5.6 5.6a9 9 0 000 12.8M18.4 5.6a9 9 0 010 12.8" stroke={c} strokeWidth="1.8" strokeLinecap="round" fill="none" opacity=".5"/>
      </svg>
    )
  },
  analytics: (active) => {
    const c = active ? ICON_COLOR : ICON_MUTED
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="3" y="13" width="4" height="8" rx="1" fill={c} opacity=".5"/>
        <rect x="10" y="8" width="4" height="13" rx="1" fill={c} opacity=".75"/>
        <rect x="17" y="3" width="4" height="18" rx="1" fill={c}/>
        <path d="M3 21h18" stroke={c} strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    )
  },
  leaderboard: (active) => {
    const c = active ? ICON_COLOR : ICON_MUTED
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 6H5a1 1 0 00-1 1v3a4 4 0 004 4h.5M16 6h3a1 1 0 011 1v3a4 4 0 01-4 4h-.5" stroke={c} strokeWidth="1.8" strokeLinecap="round" fill="none"/>
        <path d="M12 2l1.5 4.5h4L14 9l1.5 4.5L12 11l-3.5 2.5L10 9 6.5 6.5h4L12 2z" fill={c}/>
        <path d="M9 17h6M12 14v7" stroke={c} strokeWidth="1.8" strokeLinecap="round"/>
      </svg>
    )
  },
  wfm: (active) => {
    const c = active ? ICON_COLOR : ICON_MUTED
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="3" y="4" width="18" height="17" rx="2" stroke={c} strokeWidth="1.8" fill="none"/>
        <path d="M16 2v4M8 2v4M3 10h18" stroke={c} strokeWidth="1.8" strokeLinecap="round"/>
        <circle cx="8" cy="15" r="1.2" fill={c}/>
        <circle cx="12" cy="15" r="1.2" fill={c}/>
        <circle cx="16" cy="15" r="1.2" fill={c}/>
      </svg>
    )
  },
  notes: (active) => {
    const c = active ? ICON_COLOR : ICON_MUTED
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke={c} strokeWidth="1.8" fill="none" strokeLinejoin="round"/>
        <path d="M14 2v6h6" stroke={c} strokeWidth="1.8" strokeLinejoin="round"/>
        <path d="M8 13h8M8 17h6" stroke={c} strokeWidth="1.8" strokeLinecap="round"/>
      </svg>
    )
  },
  tv: (active) => {
    const c = active ? ICON_COLOR : ICON_MUTED
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="4" width="20" height="13" rx="2" stroke={c} strokeWidth="1.8" fill="none"/>
        <path d="M8 21h8M12 17v4" stroke={c} strokeWidth="1.8" strokeLinecap="round"/>
        <circle cx="8.5" cy="10.5" r="2.5" fill={c} opacity=".3"/>
        <path d="M13 8.5h4M13 11.5h3M13 14h2" stroke={c} strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    )
  },
  recordings: (active) => {
    const c = active ? ICON_COLOR : ICON_MUTED
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="9" stroke={c} strokeWidth="1.8" fill="none"/>
        <path d="M10 8.5v7l6-3.5-6-3.5z" fill={c}/>
      </svg>
    )
  },
  mypage: (active) => {
    const c = active ? ICON_COLOR : ICON_MUTED
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="8" r="3.5" stroke={c} strokeWidth="1.8" fill="none"/>
        <path d="M5 20c0-3.314 3.134-6 7-6s7 2.686 7 6" stroke={c} strokeWidth="1.8" strokeLinecap="round" fill="none"/>
      </svg>
    )
  },
  settings: (active) => {
    const c = active ? ICON_COLOR : ICON_MUTED
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="3" stroke={c} strokeWidth="1.8" fill="none"/>
        <path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke={c} strokeWidth="1.8" strokeLinecap="round"/>
      </svg>
    )
  },
}

const NAV_ITEMS = [
  { to:'/', label:'Dialer', iconKey:'dialer', end:true },
  { to:'/live', label:'Live Dashboard', iconKey:'live' },
  { to:'/analytics', label:'Analytics', iconKey:'analytics' },
  { to:'/recordings', label:'Recordings', iconKey:'recordings' },
  { to:'/leaderboard', label:'Leaderboard', iconKey:'leaderboard' },
  { to:'/attendance', label:'WFM', iconKey:'wfm' },
  { to:'/notes', label:'Notes', iconKey:'notes' },
  { to:'/warroom', label:'Call Center TV', iconKey:'tv' },
]

const MY_PAGE_ITEM = { to:'/mypage', label:'My Page', iconKey:'mypage' }

const SETTINGS_ITEMS = [
  { to:'/settings', label:'Settings', icon:'⚙️' },
]

export default function DialerLayout() {
  const { profile, isAdmin } = useAuth()
  const { contacts, syncStatus, reload } = useData()
  const navigate = useNavigate()
  const location = useLocation()
  const [agentStatus, setAgentStatus] = useState('Offline')
  const [showStatusMenu, setShowStatusMenu] = useState(false)
  const [showSidebarStatus, setShowSidebarStatus] = useState(false)
  const [statusDuration, setStatusDuration] = useState(0)
  const statusTimerRef = useRef(null)
  const statusStartRef = useRef(null)
  const [alerts, setAlerts] = useState([])
  const menuRef = useRef(null)
  const sidebarStatusRef = useRef(null)
  const sidebarBtnRef = useRef(null)
  const [sbPopupStyle, setSbPopupStyle] = useState({})

  // Open the sidebar status popup as a fixed-position element anchored to the
  // button, so it escapes the sidebar's overflow:hidden (which was clipping it
  // when collapsed).
  const toggleSidebarStatus = () => {
    setShowSidebarStatus(v => {
      const next = !v
      if (next && sidebarBtnRef.current) {
        const r = sidebarBtnRef.current.getBoundingClientRect()
        setSbPopupStyle({ position:'fixed', left: Math.round(r.left), bottom: Math.round(window.innerHeight - r.top + 6), width: 200 })
      }
      return next
    })
  }
  const currentEventRef = useRef(null)
  const [navCollapsed, setNavCollapsed] = useState(false)
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
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowStatusMenu(false)
      if (sidebarStatusRef.current && !sidebarStatusRef.current.contains(e.target)) setShowSidebarStatus(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Close both status/profile menus whenever the route changes so nothing
  // stays open and overlays the next page.
  useEffect(() => {
    setShowStatusMenu(false)
    setShowSidebarStatus(false)
  }, [location.pathname, location.search])

  useEffect(() => {
    if (!isAdmin) return
    const checkAlerts = async () => {
      const { data: profiles } = await sb.from('profiles').select('id, name, status, status_since').neq('status', 'Offline')
      if (!profiles) return
      const { data: schedules } = await sb.from('schedules').select('*').eq('date', new Date().toISOString().slice(0,10))
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

  const updateStatus = async (newStatus) => {
    setShowStatusMenu(false)
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
    await sb.from('profiles').update({ status: newStatus, status_since: now }).eq('id', profile.id)
    const { data: evt } = await sb.from('status_events').insert({
      profile_id: profile.id, status: newStatus, started_at: now
    }).select().single()
    if (evt) currentEventRef.current = evt.id
  }

  const signOut = async () => {
    const now = new Date().toISOString()
    await sb.from('profiles').update({ status: 'Offline', status_since: now }).eq('id', profile.id)
    if (currentEventRef.current) {
      await sb.from('status_events').update({ ended_at: now }).eq('id', currentEventRef.current)
      currentEventRef.current = null
    }
    await sb.auth.signOut()
    navigate('/login')
  }

  const currentStatusObj = statusOptions.find(s => s.value === agentStatus) || statusOptions[statusOptions.length - 1]
  const NAV_WIDTH = navCollapsed ? 56 : 200

  const navLinkStyle = ({ isActive }) => ({
    display: 'flex',
    alignItems: 'center',
    gap: navCollapsed ? 0 : 10,
    padding: navCollapsed ? '10px 0' : '9px 14px',
    justifyContent: navCollapsed ? 'center' : 'flex-start',
    borderRadius: 'var(--radius)',
    fontSize: 13,
    fontWeight: isActive ? 600 : 400,
    color: isActive ? 'var(--accent)' : 'var(--text-muted)',
    background: isActive ? 'var(--accent-bg)' : 'transparent',
    textDecoration: 'none',
    transition: 'background .1s, color .1s',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    marginBottom: 2,
  })

  const handleNavHover = (e, isActive) => {
    if (!isActive) {
      e.currentTarget.style.background = 'var(--surface-2)'
      e.currentTarget.style.color = 'var(--text-primary)'
    }
  }
  const handleNavLeave = (e, isActive) => {
    if (!isActive) {
      e.currentTarget.style.background = 'transparent'
      e.currentTarget.style.color = 'var(--text-muted)'
    }
  }

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden' }}>
      <WinCelebration />

      {/* ── LEFT SIDEBAR ── */}
      <aside style={{
        width: NAV_WIDTH,
        minWidth: NAV_WIDTH,
        flexShrink: 0,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width .2s, min-width .2s',
        overflow: 'hidden',
        zIndex: 100,
      }}>

        {/* Logo + collapse toggle */}
        <div style={{ display:'flex', alignItems:'center', justifyContent: navCollapsed ? 'center' : 'space-between', padding: navCollapsed ? '0' : '0 14px 0 16px', borderBottom:'1px solid var(--border)', flexShrink:0, height:53, minHeight:53, boxSizing:'border-box' }}>
          {!navCollapsed && (
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <svg width="24" height="24" viewBox="-2 0 112 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="18" cy="50" r="10" fill="#ff751f"/>
                <path d="M36 28 Q62 50 36 72" stroke="#ff751f" strokeWidth="8" fill="none" strokeLinecap="round"/>
                <path d="M54 14 Q94 50 54 86" stroke="#ff751f" strokeWidth="8" fill="none" strokeLinecap="round"/>
                <path d="M72 2 Q126 50 72 98" stroke="#ff751f" strokeWidth="8" fill="none" strokeLinecap="round"/>
              </svg>
              <span style={{ fontSize:17, fontWeight:400, letterSpacing:1, color:'var(--text-primary)', fontFamily:'-apple-system, BlinkMacSystemFont, sans-serif' }}>andi</span>
            </div>
          )}
          <button onClick={() => setNavCollapsed(p => !p)}
            style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', fontSize:16, padding:4, display:'flex', alignItems:'center', justifyContent:'center', borderRadius:'var(--radius)', flexShrink:0 }}
            title={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {navCollapsed ? '→' : '←'}
          </button>
        </div>

        {/* Nav links */}
        <div style={{ flex:1, overflowY:'auto', padding:'10px 8px', display:'flex', flexDirection:'column' }}>
          {NAV_ITEMS.map(({ to, label, iconKey, end }) => (
            <NavLink key={to} to={to} end={end} style={navLinkStyle} title={navCollapsed ? label : undefined}
              onMouseEnter={e => { const isActive = e.currentTarget.style.fontWeight === '600'; handleNavHover(e, isActive) }}
              onMouseLeave={e => { const isActive = e.currentTarget.style.fontWeight === '600'; handleNavLeave(e, isActive) }}>
              {({ isActive }) => (
                <>
                  <span style={{ flexShrink:0, display:'flex', alignItems:'center' }}>{NAV_ICONS[iconKey]?.(isActive)}</span>
                  {!navCollapsed && <span>{label}</span>}
                </>
              )}
            </NavLink>
          ))}

          {/* My Page — above settings */}
          <div style={{ height:1, background:'var(--border)', margin:'8px 0' }} />
          <NavLink to={MY_PAGE_ITEM.to} style={navLinkStyle} title={navCollapsed ? MY_PAGE_ITEM.label : undefined}
            onMouseEnter={e => { const isActive = e.currentTarget.style.fontWeight === '600'; handleNavHover(e, isActive) }}
            onMouseLeave={e => { const isActive = e.currentTarget.style.fontWeight === '600'; handleNavLeave(e, isActive) }}>
            {({ isActive }) => (
              <>
                <span style={{ flexShrink:0, display:'flex', alignItems:'center' }}>{NAV_ICONS[MY_PAGE_ITEM.iconKey]?.(isActive)}</span>
                {!navCollapsed && <span>{MY_PAGE_ITEM.label}</span>}
              </>
            )}
          </NavLink>

          {/* Settings — admin only */}
          {isAdmin && (
            <>
              <div style={{ height:1, background:'var(--border)', margin:'8px 0' }} />
              <NavLink to="/settings" style={navLinkStyle} title={navCollapsed ? 'Settings' : undefined}
                onMouseEnter={e => { const isActive = e.currentTarget.style.fontWeight === '600'; handleNavHover(e, isActive) }}
                onMouseLeave={e => { const isActive = e.currentTarget.style.fontWeight === '600'; handleNavLeave(e, isActive) }}>
                {({ isActive }) => (
                  <>
                    <span style={{ flexShrink:0, display:'flex', alignItems:'center' }}>{NAV_ICONS.settings(isActive)}</span>
                    {!navCollapsed && <span>Settings</span>}
                  </>
                )}
              </NavLink>
            </>
          )}

          {/* Alert badge */}
          {isAdmin && alerts.length > 0 && !navCollapsed && (
            <div style={{ margin:'6px 0', padding:'6px 10px', background:'var(--danger-bg)', border:'1px solid var(--danger)', borderRadius:'var(--radius)', fontSize:11, color:'var(--danger)', fontWeight:600 }}
              title={alerts.map(a => `${a.name}: ${a.elapsed}m on ${a.status}`).join('\n')}>
              ⚠ {alerts.length} overrun{alerts.length > 1 ? 's' : ''}
            </div>
          )}
          {isAdmin && alerts.length > 0 && navCollapsed && (
            <div style={{ display:'flex', justifyContent:'center', padding:'4px 0' }}
              title={alerts.map(a => `${a.name}: ${a.elapsed}m on ${a.status}`).join('\n')}>
              <span style={{ background:'var(--danger)', color:'#fff', borderRadius:'50%', width:18, height:18, fontSize:10, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center' }}>{alerts.length}</span>
            </div>
          )}
        </div>

        {/* Bottom: status changer (primary) + theme toggle */}
        <div style={{ borderTop:'1px solid var(--border)', padding:'10px 8px', flexShrink:0, display:'flex', flexDirection:'column', gap:8 }}>
          {/* Status changer — primary place to set status */}
          <div ref={sidebarStatusRef} style={{ position:'relative' }}>
            <button ref={sidebarBtnRef} onClick={toggleSidebarStatus}
              title={navCollapsed ? `${currentStatusObj.value} · ${fmtDur(statusDuration)}` : undefined}
              style={{ width:'100%', padding: navCollapsed ? '8px 0' : '7px 10px', background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent: navCollapsed ? 'center' : 'space-between', gap:8 }}>
              <span style={{ display:'flex', alignItems:'center', gap:8, minWidth:0 }}>
                <span style={{ width:10, height:10, borderRadius:'50%', background:currentStatusObj.color, flexShrink:0, border:'1px solid rgba(0,0,0,.1)' }} />
                {!navCollapsed && (
                  <span style={{ display:'flex', flexDirection:'column', lineHeight:1.25, minWidth:0, textAlign:'left' }}>
                    <span style={{ fontSize:12, fontWeight:700, color:'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{currentStatusObj.value}</span>
                    <span style={{ fontSize:10, color:'var(--text-muted)', fontVariantNumeric:'tabular-nums' }}>{fmtDur(statusDuration)}</span>
                  </span>
                )}
              </span>
              {!navCollapsed && <span style={{ fontSize:9, color:'var(--text-muted)' }}>{'\u25B2'}</span>}
            </button>

            {showSidebarStatus && (
              <div style={{ ...sbPopupStyle, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, boxShadow:'0 8px 32px rgba(0,0,0,.18)', overflow:'hidden', zIndex:9999 }}>
                <div style={{ fontSize:9, fontWeight:700, textTransform:'uppercase', letterSpacing:.7, color:'var(--text-muted)', padding:'10px 14px 6px' }}>Set status</div>
                {statusOptions.map(s => (
                  <button key={s.value} onClick={() => { updateStatus(s.value); setShowSidebarStatus(false) }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                    onMouseLeave={e => e.currentTarget.style.background = agentStatus === s.value ? 'var(--accent-bg)' : 'transparent'}
                    style={{ display:'flex', alignItems:'center', gap:9, width:'100%', padding:'8px 14px', background: agentStatus === s.value ? 'var(--accent-bg)' : 'transparent', border:'none', cursor:'pointer', fontSize:12, fontWeight: agentStatus === s.value ? 600 : 400, color: agentStatus === s.value ? 'var(--accent)' : 'var(--text-primary)', textAlign:'left' }}>
                    <div style={{ width:9, height:9, borderRadius:'50%', background:s.color, flexShrink:0 }}></div>
                    {s.value}
                    {agentStatus === s.value && <span style={{ marginLeft:'auto', fontSize:11 }}>{'\u2713'}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Theme toggle */}
          <button onClick={toggleTheme}
            style={{ width:'100%', padding: navCollapsed ? '8px 0' : '7px 10px', background:'transparent', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor:'pointer', fontSize:12, color:'var(--text-muted)', display:'flex', alignItems:'center', justifyContent: navCollapsed ? 'center' : 'flex-start', gap:8 }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.color = 'var(--text-primary)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
            <span style={{ fontSize:14 }}>{darkMode ? '\u2600\uFE0F' : '\uD83C\uDF19'}</span>
            {!navCollapsed && <span>{darkMode ? 'Light mode' : 'Dark mode'}</span>}
          </button>
        </div>
      </aside>

      {/* ── MAIN CONTENT (with a real top bar so the profile menu never overlaps pages) ── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>
        {/* Top bar — reserves its own height; every page renders below it */}
        <div style={{ height:53, minHeight:53, boxSizing:'border-box', flexShrink:0, borderBottom:'1px solid var(--border)', background:'var(--surface)', display:'flex', alignItems:'center', justifyContent:'flex-end', padding:'0 16px', position:'relative', zIndex:100 }}>
          <div ref={menuRef} style={{ position:'relative' }}>
        <button onClick={() => setShowStatusMenu(v => !v)}
          title={`${currentStatusObj.value} · ${fmtDur(statusDuration)}`}
          style={{ display:'flex', alignItems:'center', gap:8, padding:'4px 10px 4px 5px', background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:99, cursor:'pointer' }}>
          {/* Avatar with status ring */}
          <div style={{ position:'relative', flexShrink:0 }}>
            <div style={{ width:30, height:30, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: profile?.avatar ? 16 : 12, fontWeight:700, border:`2px solid ${currentStatusObj.color}` }}>
              {profile?.avatar || (profile?.name || profile?.email || '?')[0].toUpperCase()}
            </div>
            <div style={{ position:'absolute', bottom:-1, right:-1, width:9, height:9, borderRadius:'50%', background:currentStatusObj.color, border:'2px solid var(--surface)' }} />
          </div>
          <div style={{ textAlign:'left', lineHeight:1.2 }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--text-primary)', whiteSpace:'nowrap' }}>{currentStatusObj.value}</div>
            <div style={{ fontSize:10, color:'var(--text-muted)', fontVariantNumeric:'tabular-nums' }}>{fmtDur(statusDuration)}</div>
          </div>
        </button>

        {showStatusMenu && (
          <div style={{ position:'absolute', top:'calc(100% + 6px)', right:0, width:240, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, boxShadow:'0 8px 32px rgba(0,0,0,.18)', overflow:'hidden' }}>

            {/* Who you are */}
            <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--border)', background:'var(--surface-2)', display:'flex', alignItems:'center', gap:10 }}>
              <div style={{ width:34, height:34, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: profile?.avatar ? 18 : 13, fontWeight:700, flexShrink:0 }}>
                {profile?.avatar || (profile?.name || profile?.email || '?')[0].toUpperCase()}
              </div>
              <div style={{ minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:700, color:'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{profile?.name || profile?.email}</div>
                {isAdmin && <div style={{ fontSize:9, color:'var(--accent)', fontWeight:700, textTransform:'uppercase', letterSpacing:.5 }}>Admin</div>}
              </div>
            </div>

            {/* Status list */}
            <div style={{ padding:'6px 0', borderBottom:'1px solid var(--border)' }}>
              <div style={{ fontSize:9, fontWeight:700, textTransform:'uppercase', letterSpacing:.7, color:'var(--text-muted)', padding:'4px 14px 6px' }}>Set status</div>
              {statusOptions.map(s => (
                <button key={s.value} onClick={() => { updateStatus(s.value); setShowStatusMenu(false) }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                  onMouseLeave={e => e.currentTarget.style.background = agentStatus === s.value ? 'var(--accent-bg)' : 'transparent'}
                  style={{ display:'flex', alignItems:'center', gap:9, width:'100%', padding:'8px 14px', background: agentStatus === s.value ? 'var(--accent-bg)' : 'transparent', border:'none', cursor:'pointer', fontSize:12, fontWeight: agentStatus === s.value ? 600 : 400, color: agentStatus === s.value ? 'var(--accent)' : 'var(--text-primary)', textAlign:'left' }}>
                  <div style={{ width:9, height:9, borderRadius:'50%', background:s.color, flexShrink:0 }}></div>
                  {s.value}
                  {agentStatus === s.value && <span style={{ marginLeft:'auto', fontSize:11 }}>{'\u2713'}</span>}
                </button>
              ))}
            </div>

            {/* Links */}
            <div style={{ padding:'6px 0', borderBottom:'1px solid var(--border)' }}>
              {[
                { to:'/mypage', label:'My Page' },
                { to:'/mypage?tab=commissions', label:'Commissions' },
                { to:'/mypage?tab=scorecard', label:'Scorecard' },
                ...(isAdmin ? [{ to:'/settings', label:'Settings' }] : []),
              ].map(({ to, label }) => (
                <button key={label} onClick={() => { navigate(to); setShowStatusMenu(false) }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  style={{ display:'flex', alignItems:'center', width:'100%', padding:'8px 14px', background:'transparent', border:'none', cursor:'pointer', fontSize:12, color:'var(--text-primary)', textAlign:'left' }}>
                  {label}
                </button>
              ))}
            </div>

            {/* Sign out */}
            <button onClick={signOut}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger-bg)'; e.currentTarget.style.color = 'var(--danger)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
              style={{ display:'flex', alignItems:'center', width:'100%', padding:'9px 14px', background:'transparent', border:'none', cursor:'pointer', fontSize:12, color:'var(--text-muted)', textAlign:'left' }}>
              Sign out
            </button>
          </div>
        )}
      </div>

        </div>
        <Routes>
          <Route path="/" element={<DialerPage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/analytics" element={<DashboardPage />} />
          <Route path="/recordings" element={<RecordingsPage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="/attendance" element={<AttendancePage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/warroom" element={<WarRoomPage />} />
          <Route path="/mypage" element={<MyPage />} />
          {isAdmin && <Route path="/settings" element={<AdminPage />} />}
        </Routes>
      </div>
    </div>
  )
}
