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
  const [alerts, setAlerts] = useState([])
  const menuRef = useRef(null)
  const currentEventRef = useRef(null) // tracks the open status_event id

  // Load status from profile on mount
  useEffect(() => {
    if (profile?.status) setAgentStatus(profile.status)
  }, [profile])

  // Real-time listener for admin status overrides
  useEffect(() => {
    if (!profile?.id) return
    const channel = sb.channel('nav-status')
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'profiles',
        filter: `id=eq.${profile.id}`
      }, payload => {
        if (payload.new?.status) setAgentStatus(payload.new.status)
      })
      .subscribe()
    return () => sb.removeChannel(channel)
  }, [profile?.id])

  // Admin: watch for break/lunch overruns
  useEffect(() => {
    if (!isAdmin) return
    const interval = setInterval(async () => {
      const now = new Date()
      const { data: openEvents } = await sb
        .from('status_events')
        .select('*, profiles(name, avatar)')
        .is('ended_at', null)
        .in('status', ['Break', 'Lunch'])

      if (!openEvents) return
      const newAlerts = []
      openEvents.forEach(ev => {
        const started = new Date(ev.started_at)
        const elapsed = Math.floor((now - started) / 60000) // minutes
        const limit = ev.status === 'Break' ? 15 : 30
        const threshold = limit + GRACE_MINUTES
        if (elapsed >= threshold) {
          newAlerts.push({
            id: ev.id,
            name: ev.profiles?.name || 'Unknown',
            avatar: ev.profiles?.avatar,
            status: ev.status,
            elapsed,
            limit,
          })
        }
      })
      setAlerts(newAlerts)
    }, 30000) // check every 30s
    return () => clearInterval(interval)
  }, [isAdmin])

  // Close menu on outside click
  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowStatusMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const logStatusEvent = async (newStatus) => {
    if (!profile?.id) return
    const now = new Date().toISOString()

    // Close previous open event
    const { data: openEvents } = await sb
      .from('status_events')
      .select('id, started_at')
      .eq('profile_id', profile.id)
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)

    if (openEvents?.length > 0) {
      const prev = openEvents[0]
      const duration = Math.floor((new Date() - new Date(prev.started_at)) / 1000)
      await sb.from('status_events').update({
        ended_at: now,
        duration_seconds: duration,
      }).eq('id', prev.id)
    }

    // Open new event
    const { data: newEvent } = await sb.from('status_events').insert({
      profile_id: profile.id,
      status: newStatus,
      started_at: now,
    }).select().single()

    if (newEvent) currentEventRef.current = newEvent.id
  }

  const updateStatus = async (val) => {
    setAgentStatus(val)
    setShowStatusMenu(false)
    await Promise.all([
      sb.from('profiles').update({ status: val, status_since: new Date().toISOString() }).eq('id', profile.id),
      logStatusEvent(val),
    ])
  }

  const signOut = async () => {
    await updateStatus('Offline')
    await sb.auth.signOut()
    navigate('/login')
  }

  const currentStatusObj = STATUS_OPTIONS.find(s => s.value === agentStatus) || STATUS_OPTIONS[5]

  const navItems = [
    { to:'/', label:'📞 Dialer', end:true },
    { to:'/live', label:'🟢 Live Dashboard' },
    { to:'/leaderboard', label:'🏆 Leaderboard' },
    { to:'/dashboard', label:'📊 Analytics' },
    { to:'/attendance', label:'📅 Attendance' },
    { to:'/notes', label:'🔍 Notes' },
    { to:'/warroom', label:'📺 War Room' },
    { to:'/campaigns', label:'📋 Campaigns' },
    ...(isAdmin ? [{ to:'/admin', label:' Admin' }] : []),
  ]

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden' }}>
      <WinCelebration />
      <header style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', padding:'0 20px', display:'flex', alignItems:'center', justifyContent:'space-between', height:52, flexShrink:0, zIndex:100 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ background:'var(--accent)', color:'#fff', fontSize:11, fontWeight:700, padding:'2px 8px', borderRadius:4, letterSpacing:.5 }}>AHS</span>
          <span style={{ fontSize:15, fontWeight:600 }}>Dialer</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <button className="btn sm" onClick={reload}>R</button>

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
              style={{ display:'flex', alignItems:'center', gap:7, background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:99, padding:'4px 10px 4px 8px', cursor:'pointer', fontSize:12, fontWeight:500, color:'var(--text-primary)' }}
            >
              <div style={{ width:8, height:8, borderRadius:'50%', background:currentStatusObj.color, flexShrink:0 }}></div>
              {currentStatusObj.value}
              <span style={{ fontSize:10, color:'var(--text-muted)' }}>v</span>
            </button>
            {showStatusMenu && (
              <div style={{ position:'absolute', right:0, top:'calc(100% + 6px)', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 4px 16px rgba(0,0,0,.15)', zIndex:200, minWidth:145, overflow:'hidden' }}>
                {STATUS_OPTIONS.map(s => (
                  <button
                    key={s.value}
                    onClick={() => updateStatus(s.value)}
                    style={{ display:'flex', alignItems:'center', gap:8, width:'100%', padding:'9px 14px', background: agentStatus === s.value ? 'var(--surface-2)' : 'transparent', border:'none', cursor:'pointer', fontSize:12, fontWeight: agentStatus === s.value ? 600 : 400, color:'var(--text-primary)', textAlign:'left' }}
                  >
                    <div style={{ width:8, height:8, borderRadius:'50%', background:s.color, flexShrink:0 }}></div>
                    {s.value}
                    {agentStatus === s.value && <span style={{ marginLeft:'auto', fontSize:10 }}>v</span>}
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
