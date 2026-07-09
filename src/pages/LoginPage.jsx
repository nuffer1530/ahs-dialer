import { useState } from 'react'
import { sb } from '../lib/supabase'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState('login') // 'login' | 'signup' | 'reset'
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState(null)
  const [err, setErr] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true); setErr(null); setMsg(null)
    try {
      if (mode === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email, password })
        if (error) throw error
      } else if (mode === 'signup') {
        if (!email.toLowerCase().endsWith('@awesomeservice.com')) {
          throw new Error('You must use an @awesomeservice.com email to sign up.')
        }
        const { data, error } = await sb.auth.signUp({ email, password })
        if (error) throw error
        if (data.user) {
          await sb.from('profiles').insert({ id: data.user.id, email, name: email.split('@')[0], role: 'rep' })
        }
        setMsg('Account created! Check your email to confirm, then log in.')
        setMode('login')
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
        if (error) throw error
        setMsg('Password reset email sent!')
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight:'100vh', background:'var(--bg)', display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ width:'100%', maxWidth:400 }}>

        {/* Logo */}
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <div style={{ display:'inline-flex', alignItems:'center', gap:10, marginBottom:8 }}>
            <svg width="36" height="36" viewBox="-2 0 112 100" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="18" cy="50" r="10" fill="#ff751f"/>
              <path d="M36 28 Q62 50 36 72" stroke="#ff751f" strokeWidth="8" fill="none" strokeLinecap="round"/>
              <path d="M54 14 Q94 50 54 86" stroke="#ff751f" strokeWidth="8" fill="none" strokeLinecap="round"/>
              <path d="M72 2 Q126 50 72 98" stroke="#ff751f" strokeWidth="8" fill="none" strokeLinecap="round"/>
            </svg>
            <span style={{ fontSize:28, fontWeight:400, letterSpacing:1, color:'var(--text-primary)', fontFamily:'-apple-system, BlinkMacSystemFont, sans-serif' }}>andi</span>
          </div>
          <div style={{ fontSize:13, color:'var(--text-muted)' }}>Awesome Home Services</div>
        </div>

        <div className="card" style={{ padding:28 }}>
          <h2 style={{ fontSize:18, fontWeight:600, marginBottom:20, textAlign:'center' }}>
            {mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Reset password'}
          </h2>

          {err && <div style={{ background:'var(--danger-bg)', color:'var(--danger)', padding:'10px 14px', borderRadius:'var(--radius)', marginBottom:14, fontSize:13 }}>{err}</div>}
          {msg && <div style={{ background:'var(--success-bg)', color:'var(--success)', padding:'10px 14px', borderRadius:'var(--radius)', marginBottom:14, fontSize:13 }}>{msg}</div>}

          <form onSubmit={handleSubmit}>
            <div className="form-field">
              <label className="form-label">Email</label>
              <input className="form-input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@awesomeservice.com" required />
            </div>
            {mode !== 'reset' && (
              <div className="form-field">
                <label className="form-label">Password</label>
                <input className="form-input" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" required minLength={6} />
              </div>
            )}
            <button className="btn primary lg" type="submit" disabled={loading} style={{ width:'100%', justifyContent:'center', marginTop:4 }}>
              {loading ? <div className="spinner" style={{width:16,height:16,borderWidth:2}}></div> :
                mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset email'}
            </button>
          </form>

          <div style={{ marginTop:18, display:'flex', flexDirection:'column', gap:8, alignItems:'center' }}>
            {mode === 'login' && <>
              <button className="btn ghost sm" onClick={()=>setMode('reset')}>Forgot password?</button>
              <button className="btn ghost sm" onClick={()=>setMode('signup')}>New rep? Create account</button>
            </>}
            {mode !== 'login' && <button className="btn ghost sm" onClick={()=>setMode('login')}>Back to sign in</button>}
          </div>
        </div>
      </div>
    </div>
  )
}
