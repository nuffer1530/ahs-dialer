import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import Modal from '../components/Modal'

export default function AdminPage() {
  const { isAdmin, refreshProfile } = useAuth()
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [editProfile, setEditProfile] = useState(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    sb.from('profiles').select('*').order('name')
      .then(({ data }) => { setProfiles(data || []); setLoading(false) })
  }, [])

  if (!isAdmin) return <div className="empty-state"><div>Admin access required.</div></div>

  const saveProfile = async () => {
    if (!editProfile) return
    setSaving(true)
   try {
      const { error } = await sb.from('profiles')
        .update({ name: editProfile.name, role: editProfile.role })
        .eq('id', editProfile.id)
      if (error) throw error
      const { data } = await sb.from('profiles').select('*').eq('id', editProfile.id).maybeSingle()
      if (data) {
        setProfiles(prev => prev.map(p => p.id === data.id ? data : p))
        setMsg(`✓ ${data.name}'s role updated to ${data.role}`)
      } else {
        const { data: all } = await sb.from('profiles').select('*').order('name')
        if (all) setProfiles(all)
        setMsg('✓ Role updated successfully')
      }
      setTimeout(() => setMsg(''), 3000)
      await refreshProfile()
      await refreshProfile()
    } catch(e) {
      setMsg('Error: ' + e.message)
    } finally {
      setSaving(false)
      setEditProfile(null)
    }
  }

  const deleteUser = async (id) => {
    if (!confirm('Remove this user? They will no longer be able to log in.')) return
    await sb.from('profiles').delete().eq('id', id)
    setProfiles(prev => prev.filter(p => p.id !== id))
  }

  return (
    <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:20 }}>
      <h1 style={{ fontSize:20, fontWeight:600 }}>⚙️ Admin Panel</h1>

      {msg && <div style={{ background:'var(--success-bg)', color:'var(--success)', padding:'10px 14px', borderRadius:'var(--radius)', fontSize:13 }}>{msg}</div>}

      <div className="card">
        <div className="card-header">
          <div className="card-title">User management</div>
          <span style={{ fontSize:11, color:'var(--text-muted)' }}>New reps sign up at the login page — set their role here</span>
        </div>
        {loading ? <div className="card-body"><div className="spinner"></div></div> : (
          <table className="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Actions</th></tr></thead>
            <tbody>
              {profiles.map(p => (
                <tr key={p.id}>
                  <td style={{padding:'10px 12px',fontWeight:500}}>{p.name || '—'}</td>
                  <td style={{padding:'10px 12px',color:'var(--text-secondary)',fontSize:12}}>{p.email}</td>
                  <td style={{padding:'10px 12px'}}>
                    <span style={{ display:'inline-block', padding:'2px 8px', borderRadius:99, fontSize:10, fontWeight:600,
                      background: p.role==='admin' ? 'var(--accent-bg)' : 'var(--surface-2)',
                      color: p.role==='admin' ? 'var(--accent)' : 'var(--text-secondary)' }}>
                      {p.role || 'rep'}
                    </span>
                  </td>
                  <td style={{padding:'10px 12px'}}>
                    <div style={{display:'flex',gap:6}}>
                      <button className="btn sm" onClick={() => setEditProfile({...p})}>Edit role</button>
                      <button className="btn sm danger" onClick={() => deleteUser(p.id)}>Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-header"><div className="card-title">Quick SQL reference</div></div>
        <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:10 }}>
          <div style={{ fontSize:13, color:'var(--text-secondary)' }}>
            For bulk operations, use the <a href="https://supabase.com" target="_blank" rel="noopener noreferrer" style={{color:'var(--accent)'}}>Supabase SQL editor</a>.
          </div>
          <div style={{ background:'var(--surface-2)', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:11, color:'var(--text-secondary)', fontFamily:'monospace', lineHeight:1.8 }}>
            <div>-- Clean duplicate phone numbers:</div>
            <div>UPDATE contacts SET phone = TRIM(SPLIT_PART(phone, ',', 1)) WHERE phone LIKE '%,%';</div>
            <div style={{marginTop:6}}>-- Clear all contacts (careful!):</div>
            <div>DELETE FROM call_logs; DELETE FROM contacts;</div>
          </div>
        </div>
      </div>

      {editProfile && (
        <Modal title="Edit user role" onClose={() => setEditProfile(null)}>
          <div style={{ marginBottom:16, fontSize:13, color:'var(--text-secondary)' }}>
            Editing: <strong>{editProfile.email}</strong>
          </div>
          <div className="form-field">
            <label className="form-label">Display name</label>
            <input className="form-input" value={editProfile.name||''} onChange={e=>setEditProfile(p=>({...p,name:e.target.value}))} />
          </div>
          <div className="form-field">
            <label className="form-label">Role</label>
            <select className="form-input" value={editProfile.role||'rep'} onChange={e=>setEditProfile(p=>({...p,role:e.target.value}))}>
              <option value="rep">Rep — can dial, view dashboard, see all stats</option>
              <option value="admin">Admin — full access including uploads and user management</option>
            </select>
          </div>
          <div style={{ background:'var(--warning-bg)', border:'1px solid #C87800', borderRadius:'var(--radius)', padding:'10px 14px', fontSize:12, color:'var(--warning)', marginTop:4 }}>
            ⚠ Role changes take effect immediately. The user will see updated permissions on their next page load.
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setEditProfile(null)}>Cancel</button>
            <button className="btn primary" onClick={saveProfile} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
