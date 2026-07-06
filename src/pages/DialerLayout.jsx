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
import WinCelebration from '../components/WinCelebration'

const STATUS_OPTIONS = [
  { value: 'Available', color: '#22c55e' },
  { value: 'On Call',   color: '#3b82f6' },
  { value: 'Wrap Up',   color: '#f59e0b' },
  { value: 'Break',     color: '#a855f7' },
  { value: 'Lunch',     color: '#f97316' },
  { value: 'Offline',   color: '#6b7280' },
]

export default function DialerLayout() {
  const { profile, isAdmin } = useAuth()
  const { contacts, syncStatus, reload } = useData()
  const navigate = useNavigate()
  const [agentStatus, setAgentStatus] = useState('Offline')
  const [showStatusMenu, setShowStatusMenu] = useState(false)
  const menuRef = useRef(null)

  // Load status from profile on mount
  useEffect(() => {
    if (profile?.status) setAgentStatus(profile.status)
  }, [profile])

  // Real-time listener for admin status overrides
  useEffect(() => {
    if (!profile?.id) return
    const channel = sb.channel('nav-status')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'profiles',
        filter: `id=eq.${profile.id}`
      }, payload => {
        if (payload.new?.status) setAgentStatus(payload.new.status)
      })
      .subscribe()
    return () => sb.removeChannel(channel)
  }, [profile?.id])

  // Close menu on outside click
  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowStatusMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const updateStatus = async (val) => {
    setAgentStatus(val)
    setShowStatusMenu(false)
    await sb.from('profiles').update({ status: val, status_since: new Date().toISOString() }).eq('id', profile.id)
  }

  const signOut = async () => {
    await updateStatus('Offline')
    await sb.auth.signOut()
    navigate('/login')
  }

  const currentStatusObj = STATUS_OPTIONS.find(s => s.value === agentStatus) || STATUS_OPTIONS[5]

  const sc = {
    ok:      { bg:'var(--success-bg)', color:'var(--success)' },
    loading: { bg:'var(--warning-bg)', color:'var(--warning)' },
    error:   { bg:'var(--danger-bg)',  color:'var(--danger)'  },
  }[syncStatus] || { bg:'var(--warning-bg)', color:'var(--warning)' }

  const syncLabel = syncStatus === 'ok'
    ? `✓ ${contacts.length.toLocaleString()} contacts`
    : syncStatus === 'loading' ? 'Loading…' : '✗ Error'

  const navItems = [
    { to:'/', label:'📞 Dialer', end:true },
    { to:'/live', label:'🟢 Live Dashboard' },
    { to:'/leaderboard', label:'🏆 Leaderboard' },
    { to:'/dashboard', label:'📊 Analytics' },
    { to:'/notes', label:'🔍 Notes' },
    { to:'/warroom', label:'📺 War Room' },
    { to:'/campaigns', label:'📋 Campaigns' },
    ...(isAdmin ? [{ to:'/admin', label:'⚙️ Admin' }] : []),
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
          <button className="btn sm" onClick={reload}>↻</button>

          {/* Status picker */}
          <div ref={menuRef} style={{ position:'relative' }}>
            <button
              onClick={() => setShowStatusMenu(v => !v)}
              style={{ display:'flex', alignItems:'center', gap:7, background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:99, padding:'4px 10px 4px 8px', cursor:'pointer', fontSize:12, fontWeight:500, color:'var(--text-primary)' }}
            >
              <div style={{ width:8, height:8, borderRadius:'50%', background:currentStatusObj.color, flexShrink:0 }}></div>
              {currentStatusObj.value}
              <span style={{ fontSize:10, color:'var(--text-muted)' }}>▾</span>
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
                    {agentStatus === s.value && <span style={{ marginLeft:'auto', fontSize:10 }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Agent name */}
          <div style={{ fontSize:12, color:'var(--text-secondary)', display:'flex', alignItems:'center', gap:6 }}>
            <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent-text)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:600 }}>
              {(profile?.name || profile?.email || '?')[0].toUpperCase()}
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
          <Route path="/warroom" element={<WarRoomPage />} />
          <Route path="/notes" element={<NotesPage />} />
          {isAdmin && <Route path="/admin" element={<AdminPage />} />}
        </Routes>
      </div>
    </div>
  )
}
