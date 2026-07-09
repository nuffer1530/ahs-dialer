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
    // Write Offline to profile first — direct write, no shortcuts
    await sb.from('profiles').update({ status: 'Offline', status_since: now }).eq('id', profile.id)
    // Close any open status event
    if (currentEventRef.current) {
      await sb.from('status_events').update({ ended_at: now }).eq('id', currentEventRef.current)
      currentEventRef.current = null
    }
    await sb.auth.signOut()
    navigate('/login')
  }

  const currentStatusObj = STATUS_OPTIONS.find(s => s.value === agentStatus) || STATUS_OPTIONS[STATUS_OPTIONS.length - 1]

  const navItems = [
    { to:'/', label:'📞 Dialer', end:true },
    { to:'/live', label:'🟢 Live Dashboard' },
    { to:'/leaderboard', label:'🏆 Leaderboard' },
    { to:'/analytics', label:'📊 Analytics' },
    { to:'/attendance', label:'📋 Attendance' },
    { to:'/notes', label:'📝 Notes' },
    { to:'/warroom', label:'📺 War Room' },
    { to:'/campaigns', label:'📣 Campaigns' },
    ...(isAdmin ? [{ to:'/admin', label:'⚙️ Admin' }] : []),
  ]

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden' }}>
      <WinCelebration />
      <header style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', padding:'0 20px', display:'flex', alignItems:'center', justifyContent:'space-between', height:52, flexShrink:0, zIndex:100 }}>

        {/* Logo */}
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {/* Icon: dot + 3 arcs */}
          <svg width="28" height="28" viewBox="-2 0 112 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="18" cy="50" r="10" fill="#ff751f"/>
            <path d="M36 28 Q62 50 36 72" stroke="#ff751f" strokeWidth="8" fill="none" strokeLinecap="round"/>
            <path d="M54 14 Q94 50 54 86" stroke="#ff751f" strokeWidth="8" fill="none" strokeLinecap="round"/>
            <path d="M72 2 Q126 50 72 98" stroke="#ff751f" strokeWidth="8" fill="none" strokeLinecap="round"/>
          </svg>
          {/* Wordmark */}
          <span style={{ fontSize:20, fontWeight:400, letterSpacing:1, color:'var(--text-primary)', fontFamily:'-apple-system, BlinkMacSystemFont, sans-serif' }}>andi</span>
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:12 }}>

          {/* Alert badge for admins */}
          {isAdmin && alerts.length > 0 && (
            <div style={{ position:'relative', cursor:'pointer' }} title={alerts.map(a => `${a.name}: ${a.elapsed}m on ${a.status} (limit ${a.limit}m)`).join('\n')}>
              <span style={{ background:'var(--danger)', color:'#fff', fontSize:11, fontWeight:700, padding:'3px 8px', borderRadius:99, display:'flex', alignItems:'center', gap:4 }}>
                (!) {alerts.length} overrun{alerts.length > 1 ? 's' : ''}
              </span>
            </div>
          )}

          {/* Status picker */}
          <div ref={menuRef} style={{ position:'relative' }}>
            <button
              onClick={() => setShowStatusMenu(v => !v)}
              style={{ display:'flex', alignItems:'center', gap:8, background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:99, padding:'5px 14px 5px 10px', cursor:'pointer', fontSize:13, fontWeight:600, color:'var(--text-primary)' }}
            >
              <div style={{ width:10, height:10, borderRadius:'50%', background:currentStatusObj.color, flexShrink:0 }}></div>
              {currentStatusObj.value}
              <span style={{ fontSize:11, color:'var(--text-muted)', fontWeight:400, fontVariantNumeric:'tabular-nums' }}>{fmtDur(statusDuration)}</span>
            </button>
            {showStatusMenu && (
              <div style={{ position:'absolute', right:0, top:'calc(100% + 6px)', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 4px 16px rgba(0,0,0,.15)', zIndex:200, minWidth:145, overflow:'hidden' }}>
                {STATUS_OPTIONS.map(s => (
                  <button
                    key={s.value}
                    onClick={() => updateStatus(s.value)}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                    onMouseLeave={e => e.currentTarget.style.background = agentStatus === s.value ? 'var(--accent-bg)' : 'transparent'}
                    style={{ display:'flex', alignItems:'center', gap:8, width:'100%', padding:'9px 14px', background: agentStatus === s.value ? 'var(--accent-bg)' : 'transparent', border:'none', cursor:'pointer', fontSize:12, fontWeight: agentStatus === s.value ? 600 : 400, color: agentStatus === s.value ? 'var(--accent)' : 'var(--text-primary)', textAlign:'left' }}
                  >
                    <div style={{ width:8, height:8, borderRadius:'50%', background:s.color, flexShrink:0 }}></div>
                    {s.value}
                    {agentStatus === s.value && <span style={{ marginLeft:'auto', fontSize:11 }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Agent name + avatar */}
          <div style={{ fontSize:12, color:'var(--text-secondary)', display:'flex', alignItems:'center', gap:6 }}>
            <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent-text)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: profile?.avatar ? 18 : 11, fontWeight:600, flexShrink:0 }}>
              {profile?.avatar || (profile?.name || profile?.email || '?')[0].toUpperCase()}
            </div>
            <span style={{ maxWidth:120, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{profile?.name || profile?.email}</span>
            {isAdmin && <span style={{ background:'var(--accent-bg)', color:'var(--accent)', fontSize:9, fontWeight:700, padding:'1px 5px', borderRadius:3, textTransform:'uppercase' }}>Admin</span>}
          </div>
          <button className="btn sm danger" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <nav style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', padding:'0 20px', display:'flex', gap:2, flexShrink:0, overflowX:'auto' }}>
        {navItems.map(({ to, label, end }) => (
          <NavLink key={to} to={to} end={end} style={({ isActive }) => ({
            padding:'10px 14px', fontSize:12, fontWeight:500,
            color: isActive ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
            textDecoration:'none', whiteSpace:'nowrap', transition:'all .1s',
          })}>
            {label}
          </NavLink>
        ))}
      </nav>

      <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
        <Routes>
          <Route path="/" element={<DialerPage />} />
          <Route path="/campaigns" element={<CampaignsPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/attendance" element={<AttendancePage />} />
          <Route path="/warroom" element={<WarRoomPage />} />
          <Route path="/notes" element={<NotesPage />} />
          {isAdmin && <Route path="/admin" element={<AdminPage />} />}
        </Routes>
      </div>
    </div>
  )
}
