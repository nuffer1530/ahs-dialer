import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './lib/AuthContext'
import { DataProvider } from './lib/DataContext'
import LoginPage from './pages/LoginPage'
import DialerLayout from './pages/DialerLayout'

export default function App() {
  const { user, loading } = useAuth()

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', flexDirection:'column', gap:16 }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <span style={{ background:'#1A5C8A', color:'#fff', fontWeight:700, padding:'3px 10px', borderRadius:6, fontSize:14, letterSpacing:.5 }}>AHS</span>
        <span style={{ fontSize:16, fontWeight:600 }}>Dialer</span>
      </div>
      <div className="spinner lg"></div>
    </div>
  )

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/*" element={
        user
          ? <DataProvider><DialerLayout /></DataProvider>
          : <Navigate to="/login" replace />
      } />
    </Routes>
  )
}
