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

export default function DialerLayout() {
  const { profile, isAdmin } = useAuth()
  const { contacts, syncStatus, reload } = useData()
  const navigate = useNavigate()

  const signOut = async () => {
    await sb.auth.signOut()
    navigate('/login')
  }

  const syncColors = {
    ok: { bg:'var(--success-bg)', color:'var(--success)' },
    loading: { bg:'var(--warning-bg)', color:'var(--warning)' },
    error: { bg:'var(--danger-bg)', color:'var(--danger)' },
  }
  const sc = syncColors[syncStatus] || syncColors.loading
  const syncLabel = syncStatus === 'ok' ? `✓ ${contacts.length.toLocaleString()} contacts` : syncStatus === 'loading' ? 'Loading…' : '✗ Error'

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden' }}>
      {/* HEADER */}
      <header style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', padding:'0 20px', display:'flex', alignItems:'center', justifyContent:'space-between', height:52, flexShrink:0, zIndex:100 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ background:'var(--accent)', color:'#fff', fontSize:11, fontWeight:700, padding:'2px 8px', borderRadius:4, letterSpacing:.5 }}>AHS</span>
          <span style={{ fontSize:15, fontWeight:600 }}>Dialer</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <span style={{ fontSize:11, padding:'3px 8px', borderRadius:99, fontWeight:500, background:sc.bg, color:sc.color }}>{syncLabel}</span>
          <button className="btn sm" onClick={reload}>↻</button>
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

      {/* NAV TABS */}
      <nav style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', padding:'0 20px', display:'flex', gap:2, flexShrink:0, overflowX:'auto' }}>
        {[
          { to:'/', label:'📞 Dialer', end:true },
          { to:'/campaigns', label:'📋 Campaigns' },
          { to:'/dashboard', label:'📊 Dashboard' },
          { to:'/live', label:'🟢 Live' },
          { to:'/notes', label:'🔍 Notes' },
          ...(isAdmin ? [{ to:'/admin', label:'⚙️ Admin' }] : []),
        ].map(({ to, label, end }) => (
          <NavLink key={to} to={to} end={end} style={({ isActive }) => ({
            padding:'10px 16px', fontSize:13, fontWeight:500, color: isActive ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
            textDecoration:'none', whiteSpace:'nowrap', transition:'all .1s',
          })}>
            {label}
          </NavLink>
        ))}
      </nav>

      {/* PAGE CONTENT */}
      <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
        <Routes>
          <Route path="/" element={<DialerPage />} />
          <Route path="/campaigns" element={<CampaignsPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/notes" element={<NotesPage />} />
          {isAdmin && <Route path="/admin" element={<AdminPage />} />}
        </Routes>
      </div>
    </div>
  )
}
