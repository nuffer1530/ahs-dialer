import { useState } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'

// First-run setup for invited users. They arrive here already signed in (the
// invite link verifies them), but with no password of their own and a name
// defaulted from their email. App.jsx routes them here whenever the auth
// metadata says invited && !setup_done — so the flow works no matter which
// URL Supabase actually redirected them to.
export default function WelcomePage() {
  const { user, refreshProfile } = useAuth()
  const [name, setName] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setErr('')
    if (name.trim().length < 2) return setErr('Enter your full name')
    if (pw.length < 6) return setErr('Password must be at least 6 characters')
    if (pw !== pw2) return setErr("Passwords don't match")
    setBusy(true)
    try {
      // setup_done flips the flag App.jsx routes on — set it with the
      // password in one call so a half-finished setup can't strand them.
      const { error } = await sb.auth.updateUser({ password: pw, data: { setup_done: true } })
      if (error) throw error
      await sb.from('profiles').update({ name: name.trim() }).eq('id', user.id)
      refreshProfile()
      window.location.replace('/')
    } catch (e2) {
      setErr(e2.message || 'Something went wrong — try again')
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <form onSubmit={submit} style={{ width:'100%', maxWidth:400, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:16, padding:'28px 26px', display:'flex', flexDirection:'column', gap:16 }}>
        <div>
          <div style={{ fontSize:22, fontWeight:800, color:'#ff751f' }}>andi</div>
          <div style={{ fontSize:16, fontWeight:700, marginTop:8 }}>Welcome to the team 🎉</div>
          <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:4 }}>
            You're joining as <b>{user?.email}</b>. Set your name and a password and you're in.
          </div>
        </div>
        <div className="form-field">
          <label className="form-label">Full name</label>
          <input className="form-input" value={name} onChange={e => setName(e.target.value)}
            placeholder="First Last" autoFocus autoComplete="name" />
        </div>
        <div className="form-field">
          <label className="form-label">Password</label>
          <input className="form-input" type="password" value={pw} onChange={e => setPw(e.target.value)}
            placeholder="At least 6 characters" autoComplete="new-password" />
        </div>
        <div className="form-field">
          <label className="form-label">Confirm password</label>
          <input className="form-input" type="password" value={pw2} onChange={e => setPw2(e.target.value)}
            placeholder="Same again" autoComplete="new-password" />
        </div>
        {err && <div style={{ fontSize:12, color:'var(--danger)', background:'var(--danger-bg)', padding:'8px 12px', borderRadius:8 }}>{err}</div>}
        <button className="btn primary" type="submit" disabled={busy} style={{ padding:'10px 0', fontSize:14 }}>
          {busy ? 'Setting up…' : 'Create my account'}
        </button>
      </form>
    </div>
  )
}
