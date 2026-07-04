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
        // Create profile
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
            <span style={{ background:'var(--accent)', color:'#fff', fontWeight:700, padding:'4px 12px', borderRadius:6, fontSize:16, letterSpacing:.5 }}>AHS</span>
            <span style={{ fontSize:20, fontWeight:600 }}>Dialer</span>
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
            {mode !== 'login' && <button className="btn ghost sm" onClick={()=>setMode('login')}>← Back to sign in</button>}
          </div>
        </div>
      </div>
    </div>
  )
}
