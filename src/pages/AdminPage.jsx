import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useData } from '../lib/DataContext'
import Modal from '../components/Modal'

const EMOJIS = {
  '🔥 Hype': ['🔥','⚡','💥','🚀','🎯','💪','👊','🏆','👑','💎','🌟','⭐'],
  '😎 Personality': ['😎','🤙','😤','🥶','🤩','😏','🧠','👀','🫡','💯','🤝','🙌'],
  '🦁 Animals': ['🦁','🐺','🦅','🐉','🦊','🐻','🦈','🐯','🦋','🦎','🐝','🦁'],
  '🏔️ Colorado': ['🏔️','🌊','🌵','🎿','🏕️','⛰️','🌄','🎣','🌲','❄️'],
  '🏠 Home Services': ['🔧','🔨','⚙️','🛠️','💡','🔌','🚿','❄️','🔥','🏠','🪛','🔋'],
  '🎮 Fun': ['🎸','🎲','🎪','🎭','🎨','🎬','🎵','🍕','🌮','☕','🎉','🏋️'],
}

export default function AdminPage() {
  const { profile, isAdmin, refreshProfile } = useAuth()
  const { campaigns } = useData()
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [editProfile, setEditProfile] = useState(null)
  const [csrCampaigns, setCsrCampaigns] = useState([])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  // My profile state
  const [myName, setMyName] = useState(profile?.name || '')
  const [myAvatar, setMyAvatar] = useState(profile?.avatar || null)
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')

  useEffect(() => {
    setMyName(profile?.name || '')
    setMyAvatar(profile?.avatar || null)
  }, [profile])

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return }
    Promise.all([
      sb.from('profiles').select('*').order('name'),
      sb.from('csr_campaigns').select('*'),
    ]).then(([{ data: profilesData }, { data: csrCampData }]) => {
      setProfiles(profilesData || [])
      setCsrCampaigns(csrCampData || [])
      setLoading(false)
    })
  }, [isAdmin])

  const saveMyProfile = async () => {
    setSavingProfile(true)
    await sb.from('profiles').update({ name: myName, avatar: myAvatar }).eq('id', profile.id)
    await refreshProfile()
    setProfileMsg('✓ Profile saved!')
    setTimeout(() => setProfileMsg(''), 3000)
    setSavingProfile(false)
  }

  const saveProfile = async () => {
    if (!editProfile) return
    setSaving(true)
    try {
      const { error } = await sb.from('profiles')
        .update({ name: editProfile.name, role: editProfile.role })
        .eq('id', editProfile.id)
      if (error) throw error
      const { data } = await sb.from('profiles').select('*').eq('id', editProfile.id).maybeSingle()
      if (data) setProfiles(prev => prev.map(p => p.id === data.id ? data : p))

      await sb.from('csr_campaigns').delete().eq('profile_id', editProfile.id)
      const toInsert = editProfile.campaigns
        .filter(c => c.active)
        .map(c => ({ profile_id: editProfile.id, campaign_id: c.campaign_id, priority: c.priority, active: true }))
      if (toInsert.length > 0) await sb.from('csr_campaigns').insert(toInsert)

      const { data: csrCampData } = await sb.from('csr_campaigns').select('*')
      setCsrCampaigns(csrCampData || [])

      setMsg(`✓ ${editProfile.name || editProfile.email} updated successfully`)
      setTimeout(() => setMsg(''), 3000)
      await refreshProfile()
    } catch (e) {
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

  const openEdit = (p) => {
    const existing = csrCampaigns.filter(c => c.profile_id === p.id)
    const campaignList = campaigns.map(camp => {
      const assignment = existing.find(e => e.campaign_id === camp.id)
      return { campaign_id: camp.id, name: camp.name, active: !!assignment, priority: assignment?.priority || 99 }
    }).sort((a, b) => a.priority - b.priority)
    setEditProfile({ ...p, campaigns: campaignList })
  }

  const toggleCampaign = (campaignId) => {
    setEditProfile(prev => ({
      ...prev,
      campaigns: prev.campaigns.map(c => c.campaign_id === campaignId ? { ...c, active: !c.active } : c)
    }))
  }

  const movePriority = (campaignId, direction) => {
    setEditProfile(prev => {
      const active = prev.campaigns.filter(c => c.active).sort((a, b) => a.priority - b.priority)
      const idx = active.findIndex(c => c.campaign_id === campaignId)
      if (direction === 'up' && idx === 0) return prev
      if (direction === 'down' && idx === active.length - 1) return prev
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1
      const newActive = [...active]
      ;[newActive[idx], newActive[swapIdx]] = [newActive[swapIdx], newActive[idx]]
      newActive.forEach((c, i) => c.priority = i + 1)
      const inactive = prev.campaigns.filter(c => !c.active)
      return { ...prev, campaigns: [...newActive, ...inactive] }
    })
  }

  const getProfileCampaigns = (profileId) => {
    return csrCampaigns
      .filter(c => c.profile_id === profileId && c.active)
      .sort((a, b) => a.priority - b.priority)
      .map(c => campaigns.find(camp => camp.id === c.campaign_id)?.name)
      .filter(Boolean)
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600 }}>⚙️ {isAdmin ? 'Admin Panel' : 'My Profile'}</h1>

      {/* MY PROFILE — visible to everyone */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">My Profile</div>
          {profileMsg && <span style={{ fontSize: 12, color: 'var(--success)' }}>{profileMsg}</span>}
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Avatar preview + name */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--accent-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: myAvatar ? 38 : 22, fontWeight: 700, flexShrink: 0, border: '2px solid var(--border)' }}>
              {myAvatar || (myName || profile?.email || '?')[0].toUpperCase()}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{profile?.email}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Click an emoji below to set your avatar</div>
            </div>
          </div>

          {/* Name field */}
          <div className="form-field">
            <label className="form-label">Display name</label>
            <input className="form-input" value={myName} onChange={e => setMyName(e.target.value)} placeholder="Your name" />
          </div>

          {/* Emoji picker inline */}
          <div>
            <label className="form-label" style={{ marginBottom: 8, display: 'block' }}>Avatar</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 320, overflowY: 'auto', padding: '4px 2px' }}>
              {Object.entries(EMOJIS).map(([category, emojis]) => (
                <div key={category}>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, color: 'var(--text-muted)', marginBottom: 6 }}>{category}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {emojis.map(emoji => (
                      <button
                        key={emoji}
                        onClick={() => setMyAvatar(emoji)}
                        style={{
                          width: 38, height: 38, borderRadius: 'var(--radius)', fontSize: 20,
                          border: myAvatar === emoji ? '2px solid var(--accent)' : '2px solid transparent',
                          background: myAvatar === emoji ? 'var(--accent-bg)' : 'var(--surface-2)',
                          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          transform: myAvatar === emoji ? 'scale(1.15)' : 'scale(1)', transition: 'all .1s'
                        }}
                      >{emoji}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <button className="btn primary" onClick={saveMyProfile} disabled={savingProfile} style={{ alignSelf: 'flex-start' }}>
            {savingProfile ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </div>

      {/* ADMIN ONLY sections */}
      {isAdmin && (
        <>
          {msg && <div style={{ background: 'var(--success-bg)', color: 'var(--success)', padding: '10px 14px', borderRadius: 'var(--radius)', fontSize: 13 }}>{msg}</div>}

          <div className="card">
            <div className="card-header">
              <div className="card-title">User Management</div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>New reps sign up at the login page — set their role and campaigns here</span>
            </div>
            {loading ? <div className="card-body"><div className="spinner"></div></div> : (
              <table className="data-table">
                <thead>
                  <tr><th>Name</th><th>Email</th><th>Role</th><th>Active Campaigns</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {profiles.map(p => {
                    const activeCamps = getProfileCampaigns(p.id)
                    return (
                      <tr key={p.id}>
                        <td style={{ padding: '10px 12px', fontWeight: 500 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accent-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: p.avatar ? 18 : 11, fontWeight: 600, flexShrink: 0 }}>
                              {p.avatar || (p.name || p.email || '?')[0].toUpperCase()}
                            </div>
                            {p.name || '—'}
                          </div>
                        </td>
                        <td style={{ padding: '10px 12px', color: 'var(--text-secondary)', fontSize: 12 }}>{p.email}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 99, fontSize: 10, fontWeight: 600, background: p.role === 'admin' ? 'var(--accent-bg)' : 'var(--surface-2)', color: p.role === 'admin' ? 'var(--accent)' : 'var(--text-secondary)' }}>
                            {p.role || 'rep'}
                          </span>
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          {activeCamps.length === 0 ? (
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>No campaigns assigned</span>
                          ) : (
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {activeCamps.map((name, i) => (
                                <span key={name} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 99, background: 'var(--accent-bg)', color: 'var(--accent)', fontWeight: 600 }}>
                                  {i + 1}. {name}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn sm" onClick={() => openEdit(p)}>Edit</button>
                            <button className="btn sm danger" onClick={() => deleteUser(p.id)}>Remove</button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <div className="card-header"><div className="card-title">Quick SQL Reference</div></div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                For bulk operations, use the <a href="https://supabase.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Supabase SQL editor</a>.
              </div>
              <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius)', padding: '12px 14px', fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace', lineHeight: 1.8 }}>
                <div>-- Clean duplicate phone numbers:</div>
                <div>UPDATE contacts SET phone = TRIM(SPLIT_PART(phone, ',', 1)) WHERE phone LIKE '%,%';</div>
                <div style={{ marginTop: 6 }}>-- Clear all contacts (careful!):</div>
                <div>DELETE FROM call_logs; DELETE FROM contacts;</div>
              </div>
            </div>
          </div>
        </>
      )}

      {editProfile && (
        <Modal title={`Edit — ${editProfile.name || editProfile.email}`} onClose={() => setEditProfile(null)} width={560}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="form-field">
              <label className="form-label">Display name</label>
              <input className="form-input" value={editProfile.name || ''} onChange={e => setEditProfile(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="form-field">
              <label className="form-label">Role</label>
              <select className="form-input" value={editProfile.role || 'rep'} onChange={e => setEditProfile(p => ({ ...p, role: e.target.value }))}>
                <option value="rep">Rep — can dial, view dashboard, see all stats</option>
                <option value="admin">Admin — full access including uploads and user management</option>
              </select>
            </div>

            <div>
              <label className="form-label" style={{ marginBottom: 8, display: 'block' }}>Campaign Access & Priority</label>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
                Toggle campaigns on/off. Use arrows to set priority order — #1 loads first when CSR goes Available.
              </div>
              {editProfile.campaigns.filter(c => c.active).sort((a, b) => a.priority - b.priority).length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, color: 'var(--text-muted)', marginBottom: 6 }}>Active (priority order)</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {editProfile.campaigns.filter(c => c.active).sort((a, b) => a.priority - b.priority).map((c, idx, arr) => (
                      <div key={c.campaign_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--success-bg)', border: '1px solid var(--success)', borderRadius: 'var(--radius)' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--success)', minWidth: 18 }}>#{idx + 1}</span>
                        <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{c.name}</span>
                        <div style={{ display: 'flex', gap: 2 }}>
                          <button onClick={() => movePriority(c.campaign_id, 'up')} disabled={idx === 0} style={{ padding: '2px 6px', fontSize: 11, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', cursor: idx === 0 ? 'not-allowed' : 'pointer', opacity: idx === 0 ? .3 : 1 }}>▲</button>
                          <button onClick={() => movePriority(c.campaign_id, 'down')} disabled={idx === arr.length - 1} style={{ padding: '2px 6px', fontSize: 11, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', cursor: idx === arr.length - 1 ? 'not-allowed' : 'pointer', opacity: idx === arr.length - 1 ? .3 : 1 }}>▼</button>
                        </div>
                        <button onClick={() => toggleCampaign(c.campaign_id)} style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, border: '1px solid var(--danger)', background: 'var(--danger-bg)', color: 'var(--danger)', cursor: 'pointer', fontWeight: 500 }}>Remove</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {editProfile.campaigns.filter(c => !c.active).length > 0 && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, color: 'var(--text-muted)', marginBottom: 6 }}>Available to add</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {editProfile.campaigns.filter(c => !c.active).map(c => (
                      <div key={c.campaign_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                        <span style={{ fontSize: 13, flex: 1, color: 'var(--text-muted)' }}>{c.name}</span>
                        <button onClick={() => toggleCampaign(c.campaign_id)} style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, border: '1px solid var(--accent)', background: 'var(--accent-bg)', color: 'var(--accent)', cursor: 'pointer', fontWeight: 500 }}>+ Add</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div style={{ background: 'var(--warning-bg)', border: '1px solid #C87800', borderRadius: 'var(--radius)', padding: '10px 14px', fontSize: 12, color: 'var(--warning)' }}>
              ⚠ Changes take effect immediately on next page load.
            </div>
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
