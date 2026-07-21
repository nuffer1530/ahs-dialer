import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './lib/AuthContext'
import { DataProvider } from './lib/DataContext'
import LoginPage from './pages/LoginPage'
import WelcomePage from './pages/WelcomePage'
import DialerLayout from './pages/DialerLayout'

export default function App() {
  const { user, loading } = useAuth()
  // Invited users land signed-in but with no password of their own yet —
  // hold them on the setup screen (whatever URL they arrived at) until done.
  const needsSetup = Boolean(user?.user_metadata?.invited && !user?.user_metadata?.setup_done)

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', flexDirection:'column', gap:16 }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <svg width="36" height="36" viewBox="-2 0 112 100" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="18" cy="50" r="10" fill="#ff751f"/>
          <path d="M36 28 Q62 50 36 72" stroke="#ff751f" strokeWidth="8" fill="none" strokeLinecap="round"/>
          <path d="M54 14 Q94 50 54 86" stroke="#ff751f" strokeWidth="8" fill="none" strokeLinecap="round"/>
          <path d="M72 2 Q126 50 72 98" stroke="#ff751f" strokeWidth="8" fill="none" strokeLinecap="round"/>
        </svg>
        <span style={{ fontSize:24, fontWeight:400, letterSpacing:1, color:'var(--text-primary)', fontFamily:'-apple-system, BlinkMacSystemFont, sans-serif' }}>andi</span>
      </div>
      <div className="spinner lg"></div>
    </div>
  )

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/*" element={
        user
          ? (needsSetup ? <WelcomePage /> : <DataProvider><DialerLayout /></DataProvider>)
          : <Navigate to="/login" replace />
      } />
    </Routes>
  )
}
