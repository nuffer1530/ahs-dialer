import { useState, useEffect, useRef } from 'react'
import { Routes, Route, NavLink, useNavigate } from 'react-router-dom'
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
import WinCelebration from '../components/WinCelebration'

const STATUS_OPTIONS = [
  { value: 'Available', color: '#22c55e' },
  { value: 'On Call',   color: '#3b82f6' },
  { value: 'Wrap Up',   color: '#f59e0b' },
  { value: 'Break',     color: '#a855f7' },
  { value: 'Lunch',     color: '#f97316' },
  { value: 'Offline',   color: '#6b7280' },
]

const GRACE_MINUTES = 5

const NAV_ITEMS = [
  { to:'/', label:'Dialer', icon:'📞', end:true },
  { to:'/live', label:'Live Dashboard', icon:'🟢' },
  { to:'/analytics', label:'Analytics', icon:'📊' },
  { to:'/leaderboard', label:'Leaderboard', icon:'🏆' },
  { to:'/attendance', label:'WFM', icon:'📋' },
  { to:'/notes', label:'Notes', icon:'📝' },
  { to:'/warroom', label:'Call Center TV', icon:'📺' },
]

const SETTINGS_ITEMS = [
  { to:'/settings', label:'Settings', icon:'⚙️' },
]

export default function DialerLayout() {
  const { profile, isAdmin } = useAuth()
  const { contacts, syncStatus, reload } = useData()
  const navigate = useNavigate()
  const [agentStatus, setAgentStatus] = useState('Offline')
  const [showStatusMenu, setShowStatusMenu] = useState(false)
  const [statusDuration, setStatusDuration] = useState(0)
  const statusTimerRef = useRef(null)
  const statusStartRef = useRef(null)
  const [alerts, setAlerts] = useState([])
  const menuRef = useRef(null)
  const currentEventRef = useRef(null)
  const [navCollapsed, setNavCollapsed] = useState(false)
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
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

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

  const currentStatusObj = STATUS_OPTIONS.find(s => s.value === agentStatus) || STATUS_OPTIONS[STATUS_OPTIONS.length - 1]
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
        <div style={{ display:'flex', alignItems:'center', justifyContent: navCollapsed ? 'center' : 'space-between', padding: navCollapsed ? '14px 0' : '14px 14px 14px 16px', borderBottom:'1px solid var(--border)', flexShrink:0, minHeight:52 }}>
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
          {NAV_ITEMS.map(({ to, label, icon, end }) => (
            <NavLink key={to} to={to} end={end} style={navLinkStyle} title={navCollapsed ? label : undefined}
              onMouseEnter={e => { const isActive = e.currentTarget.style.fontWeight === '600'; handleNavHover(e, isActive) }}
              onMouseLeave={e => { const isActive = e.currentTarget.style.fontWeight === '600'; handleNavLeave(e, isActive) }}>
              <span style={{ fontSize:16, flexShrink:0 }}>{icon}</span>
              {!navCollapsed && <span>{label}</span>}
            </NavLink>
          ))}

          {/* Settings — admin only */}
          {isAdmin && (
            <>
              <div style={{ height:1, background:'var(--border)', margin:'8px 0' }} />
              <NavLink to="/settings" style={navLinkStyle} title={navCollapsed ? 'Settings' : undefined}
                onMouseEnter={e => { const isActive = e.currentTarget.style.fontWeight === '600'; handleNavHover(e, isActive) }}
                onMouseLeave={e => { const isActive = e.currentTarget.style.fontWeight === '600'; handleNavLeave(e, isActive) }}>
                <span style={{ fontSize:16, flexShrink:0 }}>⚙️</span>
                {!navCollapsed && <span>Settings</span>}
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

        {/* Bottom: status picker + user + sign out */}
        <div style={{ borderTop:'1px solid var(--border)', padding:'10px 8px', flexShrink:0 }}>

          {/* Status picker */}
          <div ref={menuRef} style={{ position:'relative', marginBottom:8 }}>
            <button onClick={() => setShowStatusMenu(v => !v)}
              style={{ display:'flex', alignItems:'center', gap: navCollapsed ? 0 : 8, width:'100%', padding: navCollapsed ? '8px 0' : '7px 10px', justifyContent: navCollapsed ? 'center' : 'flex-start', background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor:'pointer', fontSize:12, fontWeight:600, color:'var(--text-primary)' }}>
              <div style={{ width:10, height:10, borderRadius:'50%', background:currentStatusObj.color, flexShrink:0 }}></div>
              {!navCollapsed && (
                <>
                  <span>{currentStatusObj.value}</span>
                  <span style={{ marginLeft:'auto', fontSize:10, color:'var(--text-muted)', fontWeight:400, fontVariantNumeric:'tabular-nums' }}>{fmtDur(statusDuration)}</span>
                </>
              )}
            </button>
            {showStatusMenu && (
              <div style={{ position:'absolute', bottom:'calc(100% + 6px)', left:0, right:0, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 4px 16px rgba(0,0,0,.15)', zIndex:200, overflow:'hidden' }}>
                {STATUS_OPTIONS.map(s => (
                  <button key={s.value} onClick={() => updateStatus(s.value)}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                    onMouseLeave={e => e.currentTarget.style.background = agentStatus === s.value ? 'var(--accent-bg)' : 'transparent'}
                    style={{ display:'flex', alignItems:'center', gap:8, width:'100%', padding:'9px 12px', background: agentStatus === s.value ? 'var(--accent-bg)' : 'transparent', border:'none', cursor:'pointer', fontSize:12, fontWeight: agentStatus === s.value ? 600 : 400, color: agentStatus === s.value ? 'var(--accent)' : 'var(--text-primary)', textAlign:'left' }}>
                    <div style={{ width:8, height:8, borderRadius:'50%', background:s.color, flexShrink:0 }}></div>
                    {s.value}
                    {agentStatus === s.value && <span style={{ marginLeft:'auto', fontSize:11 }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* User info */}
          {!navCollapsed && (
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 4px', marginBottom:6 }}>
              <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: profile?.avatar ? 16 : 11, fontWeight:600, flexShrink:0 }}>
                {profile?.avatar || (profile?.name || profile?.email || '?')[0].toUpperCase()}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:600, color:'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{profile?.name || profile?.email}</div>
                {isAdmin && <div style={{ fontSize:9, color:'var(--accent)', fontWeight:700, textTransform:'uppercase', letterSpacing:.5 }}>Admin</div>}
              </div>
            </div>
          )}

          {/* Theme toggle */}
          <button onClick={toggleTheme}
            style={{ width:'100%', padding: navCollapsed ? '8px 0' : '7px 10px', background:'transparent', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor:'pointer', fontSize:12, color:'var(--text-muted)', display:'flex', alignItems:'center', justifyContent: navCollapsed ? 'center' : 'flex-start', gap:8, marginBottom:6 }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.color = 'var(--text-primary)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
            <span style={{ fontSize:14 }}>{darkMode ? '☀️' : '🌙'}</span>
            {!navCollapsed && <span>{darkMode ? 'Light mode' : 'Dark mode'}</span>}
          </button>

          {/* Sign out */}
          <button onClick={signOut}
            style={{ width:'100%', padding: navCollapsed ? '8px 0' : '7px 0', background:'transparent', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor:'pointer', fontSize:12, color:'var(--text-muted)', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger-bg)'; e.currentTarget.style.color = 'var(--danger)'; e.currentTarget.style.borderColor = 'var(--danger)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border)' }}>
            {navCollapsed ? '↩' : '↩ Sign out'}
          </button>
        </div>
      </aside>

      {/* ── MAIN CONTENT ── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>
        <Routes>
          <Route path="/" element={<DialerPage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/analytics" element={<DashboardPage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="/attendance" element={<AttendancePage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/warroom" element={<WarRoomPage />} />
          {isAdmin && <Route path="/settings" element={<AdminPage />} />}
        </Routes>
      </div>
    </div>
  )
}
