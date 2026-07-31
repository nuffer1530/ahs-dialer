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
    // The heartbeat IS the loader — the waveform drawing itself says "working."
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', flexDirection:'column', gap:14 }}>
      <div className="pulse-mark" style={{ width:64, height:64, borderRadius:14, background:'#111318', display:'flex', alignItems:'center', justifyContent:'center' }}>
        <svg width="40" height="40" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <polyline points="9,32 19,32 25,17 33,47 40,26 45,32 55,32" fill="none" stroke="#ff751f" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      <span style={{ fontSize:20, fontWeight:400, letterSpacing:1, color:'var(--text-primary)', fontFamily:'-apple-system, BlinkMacSystemFont, sans-serif' }}>andi</span>
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
