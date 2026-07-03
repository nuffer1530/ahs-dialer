import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import Modal from '../components/Modal'

export default function AdminPage() {
  const { isAdmin } = useAuth()
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [editProfile, setEditProfile] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    sb.from('profiles').select('*').order('name')
      .then(({ data }) => { setProfiles(data || []); setLoading(false) })
  }, [])

  if (!isAdmin) return <div className="empty-state"><div>Admin access required.</div></div>

  const saveProfile = async () => {
    if (!editProfile) return
    setSaving(true)
    const { data } = await sb.from('profiles').update({ name: editProfile.name, role: editProfile.role }).eq('id', editProfile.id).select().single()
    if (data) setProfiles(prev => prev.map(p => p.id === data.id ? data : p))
    setSaving(false); setEditProfile(null)
  }

  const deleteUser = async (id) => {
    if (!confirm('Remove this user? They will no longer be able to log in.')) return
    await sb.from('profiles').delete().eq('id', id)
    setProfiles(prev => prev.filter(p => p.id !== id))
  }

  return (
    <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:20 }}>
      <h1 style={{ fontSize:20, fontWeight:600 }}>Admin Panel</h1>

      {/* Rep management */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">User management</div>
          <span style={{ fontSize:11, color:'var(--text-muted)' }}>New reps sign up at the login page — admins set their role here</span>
        </div>
        {loading ? <div className="card-body"><div className="spinner"></div></div> : (
          <table className="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Actions</th></tr></thead>
            <tbody>
              {profiles.map(p => (
                <tr key={p.id}>
                  <td style={{padding:'10px 12px',fontWeight:500}}>{p.name || '—'}</td>
                  <td style={{padding:'10px 12px',color:'var(--text-secondary)'}}>{p.email}</td>
                  <td style={{padding:'10px 12px'}}>
                    <span style={{
                      display:'inline-block', padding:'2px 8px', borderRadius:99, fontSize:10, fontWeight:600,
                      background: p.role==='admin' ? 'var(--accent-bg)' : 'var(--surface-2)',
                      color: p.role==='admin' ? 'var(--accent)' : 'var(--text-secondary)',
                    }}>{p.role || 'rep'}</span>
                  </td>
                  <td style={{padding:'10px 12px'}}>
                    <div style={{display:'flex',gap:6}}>
                      <button className="btn sm" onClick={() => setEditProfile({...p})}>Edit</button>
                      <button className="btn sm danger" onClick={() => deleteUser(p.id)}>Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* SQL Tools for admins */}
      <div className="card">
        <div className="card-header"><div className="card-title">Quick actions</div></div>
        <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ fontSize:13, color:'var(--text-secondary)' }}>
            For bulk data operations (deleting contacts, fixing data), use the <a href="https://supabase.com" target="_blank" rel="noopener noreferrer" style={{color:'var(--accent)'}}>Supabase SQL editor</a> directly.
          </div>
          <div style={{ background:'var(--surface-2)', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:12, color:'var(--text-secondary)', fontFamily:'monospace' }}>
            <div style={{marginBottom:4, fontWeight:600, fontFamily:'inherit', color:'var(--text-primary)'}}>Useful SQL commands:</div>
            <div>DELETE FROM contacts WHERE campaign_id = 'your-campaign-id';</div>
            <div>DELETE FROM call_logs; DELETE FROM contacts;</div>
            <div>UPDATE contacts SET phone = TRIM(SPLIT_PART(phone, ',', 1)) WHERE phone LIKE '%,%';</div>
          </div>
        </div>
      </div>

      {editProfile && (
        <Modal title="Edit user" onClose={() => setEditProfile(null)}>
          <div className="form-field"><label className="form-label">Display name</label><input className="form-input" value={editProfile.name||''} onChange={e=>setEditProfile(p=>({...p,name:e.target.value}))} /></div>
          <div className="form-field"><label className="form-label">Role</label>
            <select className="form-input" value={editProfile.role||'rep'} onChange={e=>setEditProfile(p=>({...p,role:e.target.value}))}>
              <option value="rep">Rep</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setEditProfile(null)}>Cancel</button>
            <button className="btn primary" onClick={saveProfile} disabled={saving}>{saving?'…':'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
