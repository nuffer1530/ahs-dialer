import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useData } from '../lib/DataContext'
import Modal from '../components/Modal'
import CampaignsPage from './CampaignsPage'

const EMOJIS = {
  '🔥 Hype': ['🔥','⚡','💥','🚀','🎯','💪','👊','🏆','👑','💎','🌟','⭐','🔑','💰','🎰','🃏'],
  '😎 Personality': ['😎','🤙','😤','🥶','🤩','😏','🧠','👀','🫡','💯','🤝','🙌','🥳','😈','🤠','🫶'],
  '🦁 Animals': ['🦁','🐺','🦅','🐉','🦊','🐻','🦈','🐯','🦋','🦎','🐝','🐆','🦬','🦌','🐘','🦏'],
  '🏔️ Colorado': ['🏔️','🌊','🌵','🎿','🏕️','⛰️','🌄','🎣','🌲','❄️','🏂','🪂','🧗','🏞️','🌅','🎑'],
  '🏠 Home Services': ['🔧','🔨','⚙️','🛠️','💡','🔌','🚿','❄️','🔥','🏠','🪛','🔋','🪜','🧱','🪟','🚪'],
  '🎮 Fun': ['🎸','🎲','🎪','🎭','🎨','🎬','🎵','🍕','🌮','☕','🎉','🏋️','🎳','🎯','🏄','🤿'],
  '⚽ Sports': ['⚽','🏈','🏒','⛷️','🎽','🏊','🚴','🤸','🏋️','🥊','🎾','⛳','🏇','🛹','🤺','🥋'],
  '🌈 Vibes': ['🌈','🌙','☀️','🌊','🍀','🦄','🌸','🦋','✨','🔮','🪄','🧿','💫','🌺','🎆','🪩'],
}

export default function AdminPage() {
  const { profile, isAdmin, refreshProfile } = useAuth()
  const { campaigns } = useData()
  const [settingsTab, setSettingsTab] = useState('users')
  const [hoveredTab, setHoveredTab] = useState(null)
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [editProfile, setEditProfile] = useState(null)
  const [csrCampaigns, setCsrCampaigns] = useState([])
  const [saving, setSaving] = useState(false)
  // Password change
  const [pwModal, setPwModal] = useState(null) // { profileId, name } or 'me'
  const [newPw, setNewPw] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [savingPw, setSavingPw] = useState(false)
  // Manual commission adjustment
  const [commAdjModal, setCommAdjModal] = useState(null) // { profileId, name }
  const [commAdjAmount, setCommAdjAmount] = useState('')
  const [commAdjNote, setCommAdjNote] = useState('')
  const [savingAdj, setSavingAdj] = useState(false)
  // Status customization
  const [customStatuses, setCustomStatuses] = useState([
    { id:'Available', label:'Available', color:'#22c55e', locked:true },
    { id:'On Call', label:'On Call', color:'#3b82f6', locked:true },
    { id:'Wrap Up', label:'Wrap Up', color:'#f59e0b', locked:true },
    { id:'Break', label:'Break', color:'#a855f7', locked:false },
    { id:'Lunch', label:'Lunch', color:'#f97316', locked:false },
    { id:'Offline', label:'Offline', color:'#6b7280', locked:true },
  ])
  const [savingStatuses, setSavingStatuses] = useState(false)
  const [commissionRates, setCommissionRates] = useState({ booking: 2.00, membership: 2.00 })
  const [commissionHistory, setCommissionHistory] = useState([])

  // Scorecard state
  const _now = new Date()
  const [scSelectedProfile, setScSelectedProfile] = useState(null)
  const [scMonth, setScMonth] = useState({ year: _now.getFullYear(), month: _now.getMonth() })
  const [scActuals, setScActuals] = useState({ booking_pct: '', booked_calls: '', memberships: '' })
  const [scWeights, setScWeights] = useState({ attendance: 30, booking_pct: 25, booked_calls: 25, memberships: 20 })
  const [scAttendancePoints, setScAttendancePoints] = useState(null)
  const [scLoading, setScLoading] = useState(false)
  const [scSaving, setScSaving] = useState(false)
  const [scSaved, setScSaved] = useState(false)
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const [allRepEarnings, setAllRepEarnings] = useState([])
  const [commLoading, setCommLoading] = useState(false)
  const [savingRates, setSavingRates] = useState(false)
  const [msg, setMsg] = useState('')
  const [myName, setMyName] = useState(profile?.name || '')
  const [myAvatar, setMyAvatar] = useState(profile?.avatar || null)
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')
  const [showAvatarPicker, setShowAvatarPicker] = useState(false)
  const [pickerSelected, setPickerSelected] = useState(null)

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

  // Load saved statuses
  useEffect(() => {
    sb.from('app_settings').select('value').eq('key', 'custom_statuses').maybeSingle()
      .then(({ data }) => {
        if (data?.value) {
          try { setCustomStatuses(JSON.parse(data.value)) } catch (e) {}
        }
      })
  }, [])

  // Load commission data
  useEffect(() => {
    if (settingsTab !== 'commission') return
    setCommLoading(true)
    const today = new Date().toISOString().split('T')[0]
    const dow = new Date().getDay()
    const monday = new Date()
    monday.setDate(monday.getDate() - (dow === 0 ? 6 : dow - 1))
    monday.setHours(0,0,1,0)

    Promise.all([
      sb.from('commission_settings').select('*'),
      sb.from('commissions').select('*, profiles(name)').gte('earned_at', monday.toISOString()).order('earned_at', { ascending: false }),
    ]).then(([{ data: rates }, { data: history }]) => {
      if (rates?.length) {
        const r = {}
        rates.forEach(x => r[x.event_type] = parseFloat(x.amount))
        setCommissionRates(prev => ({ ...prev, ...r }))
      }
      setCommissionHistory(history || [])

      // Aggregate by rep for admin view
      const byRep = {}
      ;(history || []).forEach(c => {
        const name = c.profiles?.name || c.rep_name || 'Unknown'
        if (!byRep[name]) byRep[name] = { daily: 0, weekly: 0, bookings: 0, memberships: 0 }
        const earned = parseFloat(c.amount)
        byRep[name].weekly += earned
        if (new Date(c.earned_at).toISOString().split('T')[0] === today) byRep[name].daily += earned
        if (c.event_type === 'booking') byRep[name].bookings++
        if (c.event_type === 'membership') byRep[name].memberships++
      })
      setAllRepEarnings(Object.entries(byRep).sort((a,b) => b[1].weekly - a[1].weekly))
      setCommLoading(false)
    })
  }, [settingsTab])


  const changePassword = async () => {
    if (!newPw || newPw.length < 6) { setPwMsg('Password must be at least 6 characters'); return }
    setSavingPw(true); setPwMsg('')
    try {
      if (pwModal === 'me' || pwModal?.profileId === profile?.id) {
        // Change own password via Supabase auth
        const { error } = await sb.auth.updateUser({ password: newPw })
        if (error) throw error
      } else {
        // Admin changing someone else's password via admin API
        const { error } = await sb.functions.invoke('admin-change-password', {
          body: { userId: pwModal.profileId, newPassword: newPw }
        })
        if (error) throw error
      }
      setPwMsg('✓ Password changed successfully!')
      setNewPw('')
      setTimeout(() => { setPwModal(null); setPwMsg('') }, 2000)
    } catch (e) {
      setPwMsg('Error: ' + e.message)
    } finally { setSavingPw(false) }
  }

  const saveStatuses = async () => {
    setSavingStatuses(true)
    try {
      const { error } = await sb.from('app_settings').upsert(
        { key: 'custom_statuses', value: JSON.stringify(customStatuses), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      )
      if (error) throw error
      setMsg('Statuses saved')
      setTimeout(() => setMsg(''), 3000)
    } catch (e) {
      setMsg('Error saving statuses: ' + e.message)
    } finally {
      setSavingStatuses(false)
    }
  }

  const saveCommissionRates = async () => {
    setSavingRates(true)
    await Promise.all([
      sb.from('commission_settings').upsert({ event_type: 'booking', amount: commissionRates.booking, updated_at: new Date().toISOString() }, { onConflict: 'event_type' }),
      sb.from('commission_settings').upsert({ event_type: 'membership', amount: commissionRates.membership, updated_at: new Date().toISOString() }, { onConflict: 'event_type' }),
    ])
    setSavingRates(false)
    setMsg('Rates saved')
    setTimeout(() => setMsg(''), 3000)
  }

  const addCommissionAdjustment = async () => {
    if (!commAdjAmount || isNaN(parseFloat(commAdjAmount))) { return }
    setSavingAdj(true)
    try {
      await sb.from('commissions').insert({
        profile_id: commAdjModal.profileId,
        event_type: 'adjustment',
        amount: parseFloat(commAdjAmount),
        rep_name: commAdjModal.name,
        contact_name: 'Manual adjustment',
        also_membership: false,
        membership_amount: 0,
        notes: commAdjNote || 'Admin manual adjustment',
        earned_at: new Date().toISOString(),
      })
      setCommAdjModal(null); setCommAdjAmount(''); setCommAdjNote('')
      setMsg('✓ Commission adjustment added!')
      setTimeout(() => setMsg(''), 3000)
    } catch (e) {
      setMsg('Error: ' + e.message)
    } finally { setSavingAdj(false) }
  }

  const saveMyProfile = async () => {
    setSavingProfile(true)
    await sb.from('profiles').update({ name: myName, avatar: myAvatar }).eq('id', profile.id)
    await refreshProfile()
    setProfileMsg('Profile saved')
    setTimeout(() => setProfileMsg(''), 3000)
    setSavingProfile(false)
  }

  const confirmAvatar = () => {
    if (pickerSelected) setMyAvatar(pickerSelected)
    setShowAvatarPicker(false)
    setPickerSelected(null)
  }

  const saveProfile = async () => {
    if (!editProfile) return
    setSaving(true)
    try {
      const { error } = await sb.from('profiles').update({ name: editProfile.name, role: editProfile.role }).eq('id', editProfile.id)
      if (error) throw error
      const { data } = await sb.from('profiles').select('*').eq('id', editProfile.id).maybeSingle()
      if (data) setProfiles(prev => prev.map(p => p.id === data.id ? data : p))
      await sb.from('csr_campaigns').delete().eq('profile_id', editProfile.id)
      const toInsert = editProfile.campaigns.filter(c => c.active).map(c => ({ profile_id: editProfile.id, campaign_id: c.campaign_id, priority: c.priority, active: true }))
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
    setEditProfile(prev => ({ ...prev, campaigns: prev.campaigns.map(c => c.campaign_id === campaignId ? { ...c, active: !c.active } : c) }))
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
      return { ...prev, campaigns: [...newActive, ...prev.campaigns.filter(c => !c.active)] }
    })
  }

  const getProfileCampaigns = (profileId) => {
    return csrCampaigns.filter(c => c.profile_id === profileId && c.active).sort((a, b) => a.priority - b.priority).map(c => campaigns.find(camp => camp.id === c.campaign_id)?.name).filter(Boolean)
  }

  // Scorecard KPIs — single source of truth
  const SC_KPIS = [
    { id:'attendance',    label:'Attendance',          weight:30, unit:'pts', lowerIsBetter:true,  thresholds:{ exceeds:0, meets:1, improvement:2 } },
    { id:'booking_pct',   label:'Inbound Booking %',   weight:25, unit:'%',   lowerIsBetter:false, thresholds:{ exceeds:90, meets:80, improvement:75 } },
    { id:'booked_calls',  label:'Booked Calls',         weight:25, unit:'',   lowerIsBetter:false, thresholds:{ exceeds:140, meets:110, improvement:85 } },
    { id:'memberships',   label:'Memberships Sold',     weight:20, unit:'',   lowerIsBetter:false, thresholds:{ exceeds:5, meets:3, improvement:2 } },
  ]

  const scGetRating = (kpi, value) => {
    if (value === '' || value == null) return null
    const v = parseFloat(value)
    const { thresholds, lowerIsBetter } = kpi
    if (lowerIsBetter) {
      if (v <= thresholds.exceeds)    return 4
      if (v <= thresholds.meets)      return 3
      if (v <= thresholds.improvement) return 2
      return 1
    } else {
      if (v >= thresholds.exceeds)    return 4
      if (v >= thresholds.meets)      return 3
      if (v >= thresholds.improvement) return 2
      return 1
    }
  }
  const SC_RATING_LABELS = { 4:'Exceeds', 3:'Meets', 2:'Needs Improvement', 1:'Poor Performance' }
  const SC_RATING_COLORS = {
    4: { bg:'#d4edda', text:'#2E7D52' },
    3: { bg:'#d4edda', text:'#2E7D52' },
    2: { bg:'#FBF3E0', text:'#8A5A00' },
    1: { bg:'#FBEEEA', text:'#B5341A' },
  }

  // Load scorecard data when profile/month changes
  useEffect(() => {
    if (settingsTab !== 'scorecards' || !scSelectedProfile) return
    const monthStart = `${scMonth.year}-${String(scMonth.month+1).padStart(2,'0')}-01`
    const monthEnd = new Date(scMonth.year, scMonth.month+1, 0).toISOString().split('T')[0]
    setScLoading(true)
    Promise.all([
      sb.from('attendance_points').select('points').eq('profile_id', scSelectedProfile).gte('date', monthStart).lte('date', monthEnd),
      sb.from('scorecard_actuals').select('*').eq('profile_id', scSelectedProfile).eq('month', monthStart).maybeSingle(),
    ]).then(([{ data: pts }, { data: saved }]) => {
      const total = (pts || []).reduce((s, p) => s + parseFloat(p.points || 0), 0)
      setScAttendancePoints(total)
      setScActuals({
        booking_pct: saved?.booking_pct ?? '',
        booked_calls: saved?.booked_calls ?? '',
        memberships: saved?.memberships ?? '',
      })
      setScLoading(false)
    })
  }, [settingsTab, scSelectedProfile, scMonth])

  const saveScorecard = async () => {
    if (!scSelectedProfile) return
    setScSaving(true)
    const monthStart = `${scMonth.year}-${String(scMonth.month+1).padStart(2,'0')}-01`
    await sb.from('scorecard_actuals').upsert({
      profile_id: scSelectedProfile,
      month: monthStart,
      booking_pct: scActuals.booking_pct !== '' ? parseFloat(scActuals.booking_pct) : null,
      booked_calls: scActuals.booked_calls !== '' ? parseInt(scActuals.booked_calls) : null,
      memberships: scActuals.memberships !== '' ? parseInt(scActuals.memberships) : null,
      updated_by: profile.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'profile_id,month' })
    setScSaving(false)
    setScSaved(true)
    setTimeout(() => setScSaved(false), 2000)
  }

  const scNavMonth = (dir) => {
    setScMonth(prev => {
      let m = prev.month + dir, y = prev.year
      if (m > 11) { m = 0; y++ }
      if (m < 0)  { m = 11; y-- }
      return { year: y, month: m }
    })
  }

  const scWeightedScore = () => {
    const actuals = {
      attendance: scAttendancePoints,
      booking_pct: scActuals.booking_pct !== '' ? parseFloat(scActuals.booking_pct) : null,
      booked_calls: scActuals.booked_calls !== '' ? parseFloat(scActuals.booked_calls) : null,
      memberships: scActuals.memberships !== '' ? parseFloat(scActuals.memberships) : null,
    }
    let totalWeight = 0, weightedScore = 0
    SC_KPIS.forEach(kpi => {
      const w = parseFloat(scWeights[kpi.id]) || 0
      const rating = scGetRating(kpi, actuals[kpi.id])
      if (rating != null) {
        totalWeight += w
        weightedScore += rating * w
      }
    })
    if (totalWeight === 0) return null
    return (weightedScore / totalWeight).toFixed(2)
  }

  const TABS = isAdmin
    ? [{ id:'users', label:'Users' }, { id:'campaigns', label:'Campaigns' }, { id:'commission', label:'Commission' }, { id:'statuses', label:'Statuses' }, { id:'scorecards', label:'Scorecards' }]
    : [{ id:'users', label:'My Profile' }, { id:'commission', label:'My Earnings' }]

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

      {/* Tab bar header */}
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
        <div style={{ padding:'16px 24px 0' }}>
          <div style={{ fontSize:18, fontWeight:600, color:'var(--text-primary)' }}>Settings</div>
          <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2 }}>Manage users, campaigns, commission, and statuses</div>
        </div>
        <div style={{ display:'flex', padding:'0 24px', marginTop:10 }}>
          {TABS.map(t => {
            const isActive = settingsTab === t.id
            const isHov = hoveredTab === t.id && !isActive
            return (
              <button key={t.id} onClick={() => setSettingsTab(t.id)}
                onMouseEnter={() => setHoveredTab(t.id)}
                onMouseLeave={() => setHoveredTab(null)}
                style={{
                  padding:'10px 16px', fontSize:13, fontWeight: isActive ? 600 : 400,
                  border:'none', cursor:'pointer',
                  borderRadius:'var(--radius) var(--radius) 0 0',
                  background: isHov ? 'var(--surface-2)' : 'transparent',
                  color: isActive ? 'var(--accent)' : isHov ? 'var(--text-primary)' : 'var(--text-muted)',
                  borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  transition:'color .1s, background .1s',
                }}>
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Campaigns tab — full CampaignsPage */}
      {settingsTab === 'campaigns' && <CampaignsPage />}


      {/* Statuses tab — admin only */}
      {settingsTab === 'statuses' && isAdmin && (
        <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:20 }}>
          <div className="card">
            <div className="card-header">
              <div className="card-title">Status Customization</div>
              <span style={{ fontSize:11, color:'var(--text-muted)' }}>Customize the statuses reps can set. Locked statuses cannot be removed.</span>
            </div>
            <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {customStatuses.map((status, idx) => (
                <div key={status.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', background:'var(--surface-2)', borderRadius:'var(--radius)', border:'1px solid var(--border)' }}>
                  {/* Color picker */}
                  <div style={{ position:'relative', flexShrink:0 }}>
                    <input type="color" value={status.color}
                      onChange={e => setCustomStatuses(prev => prev.map((s,i) => i===idx ? {...s, color:e.target.value} : s))}
                      style={{ width:32, height:32, borderRadius:'50%', border:'2px solid var(--border)', cursor:'pointer', padding:2 }} />
                  </div>
                  {/* Color dot preview */}
                  <div style={{ width:12, height:12, borderRadius:'50%', background:status.color, flexShrink:0 }} />
                  {/* Label */}
                  <input value={status.label} disabled={status.locked}
                    onChange={e => setCustomStatuses(prev => prev.map((s,i) => i===idx ? {...s, label:e.target.value} : s))}
                    style={{ flex:1, border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'6px 10px', fontSize:13, background: status.locked ? 'var(--surface)' : 'var(--surface)', color:'var(--text-primary)', fontFamily:'inherit' }} />
                  {status.locked
                    ? <span style={{ fontSize:10, color:'var(--text-muted)', padding:'2px 8px', background:'var(--surface)', borderRadius:99, border:'1px solid var(--border)' }}>Locked</span>
                    : <button onClick={() => setCustomStatuses(prev => prev.filter((_,i) => i !== idx))}
                        style={{ padding:'4px 10px', background:'var(--danger-bg)', border:'1px solid var(--danger)', borderRadius:'var(--radius)', color:'var(--danger)', fontSize:11, cursor:'pointer', fontWeight:500 }}>Remove</button>
                  }
                </div>
              ))}

              {/* Add new status */}
              <button onClick={() => setCustomStatuses(prev => [...prev, { id:`custom_${Date.now()}`, label:'New Status', color:'#6b7280', locked:false }])}
                style={{ padding:'8px 16px', border:'1px dashed var(--border)', borderRadius:'var(--radius)', background:'transparent', color:'var(--text-muted)', fontSize:12, cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}>
                + Add status
              </button>

              <div style={{ padding:'10px 14px', background:'var(--warning-bg)', border:'1px solid #C87800', borderRadius:'var(--radius)', fontSize:12, color:'var(--warning)' }}>
                Status changes affect all reps on next page load. Removing a status doesn't affect historical adherence data.
              </div>

              <button className="btn primary" onClick={saveStatuses} disabled={savingStatuses} style={{ alignSelf:'flex-start' }}>
                {savingStatuses ? 'Saving...' : 'Save statuses'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Commission tab */}
      {settingsTab === 'commission' && (
        <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:20 }}>
          {commLoading ? <div className="spinner" style={{ margin:'40px auto' }} /> : (
            <>
              {/* Admin: Rate settings */}
              {isAdmin && (
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">Commission Rates</div>
                    {msg && <span style={{ fontSize:12, color:'var(--success)' }}>{msg}</span>}
                  </div>
                  <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:16 }}>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
                      <div className="form-field">
                        <label className="form-label">Booking Payout ($)</label>
                        <input className="form-input" type="number" step="0.50" min="0" value={commissionRates.booking}
                          onChange={e => setCommissionRates(p => ({ ...p, booking: parseFloat(e.target.value) || 0 }))} />
                        <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>Paid when a rep books a job via Andi</div>
                      </div>
                      <div className="form-field">
                        <label className="form-label">Membership Payout ($)</label>
                        <input className="form-input" type="number" step="0.50" min="0" value={commissionRates.membership}
                          onChange={e => setCommissionRates(p => ({ ...p, membership: parseFloat(e.target.value) || 0 }))} />
                        <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>Added when "Also sold a membership" is checked</div>
                      </div>
                    </div>
                    <button className="btn primary" onClick={saveCommissionRates} disabled={savingRates} style={{ alignSelf:'flex-start' }}>
                      {savingRates ? 'Saving...' : 'Save rates'}
                    </button>
                  </div>
                </div>
              )}

              {/* Admin: All rep earnings this week */}
              {isAdmin && allRepEarnings.length > 0 && (
                <div className="card">
                  <div className="card-header"><div className="card-title">Team Earnings — This Week</div></div>
                  <table className="data-table">
                    <thead><tr><th>Rep</th><th style={{textAlign:'center'}}>Today</th><th style={{textAlign:'center'}}>This Week</th><th style={{textAlign:'center'}}>Bookings</th><th style={{textAlign:'center'}}>Memberships</th></tr></thead>
                    <tbody>
                      {allRepEarnings.map(([name, d]) => (
                        <tr key={name}>
                          <td style={{padding:'10px 12px', fontWeight:600}}>{name}</td>
                          <td style={{padding:'10px 12px', textAlign:'center', fontWeight:700, color:'#16A34A'}}>{'$'}{d.daily.toFixed(2)}</td>
                          <td style={{padding:'10px 12px', textAlign:'center', fontWeight:700, color:'var(--accent)'}}>{'$'}{d.weekly.toFixed(2)}</td>
                          <td style={{padding:'10px 12px', textAlign:'center'}}>{d.bookings}</td>
                          <td style={{padding:'10px 12px', textAlign:'center'}}>{d.memberships}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Rep: Personal earnings summary */}
              {!isAdmin && (
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
                  {[
                    { label:'Today', value: commissionHistory.filter(c => new Date(c.earned_at).toISOString().split('T')[0] === new Date().toISOString().split('T')[0]).reduce((s,c) => s + parseFloat(c.amount), 0), accent:'#16A34A', note:'Resets at midnight' },
                    { label:'This Week', value: commissionHistory.reduce((s,c) => s + parseFloat(c.amount), 0), accent:'var(--accent)', note:'Resets Monday 12:01am' },
                  ].map(({ label, value, accent, note }) => (
                    <div key={label} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:16, padding:'24px', textAlign:'center' }}>
                      <div style={{ fontSize:12, fontWeight:600, textTransform:'uppercase', letterSpacing:.8, color:'var(--text-muted)', marginBottom:8 }}>{label}</div>
                      <div style={{ fontSize:42, fontWeight:900, color:accent, letterSpacing:-1 }}>{'$'}{value.toFixed(2)}</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:6 }}>{note}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Commission history */}
              <div className="card">
                <div className="card-header"><div className="card-title">Commission History — This Week</div></div>
                {commissionHistory.length === 0 ? (
                  <div className="empty-state"><div className="empty-icon">—</div><div>No commissions earned yet this week</div></div>
                ) : (
                  <table className="data-table">
                    <thead><tr>{isAdmin && <th>Rep</th>}<th>Event</th><th>Contact</th><th style={{textAlign:'right'}}>Amount</th><th>When</th></tr></thead>
                    <tbody>
                      {commissionHistory.filter(c => !isAdmin ? c.profile_id === profile?.id : true).map(c => (
                        <tr key={c.id}>
                          {isAdmin && <td style={{padding:'10px 12px', fontWeight:500}}>{c.profiles?.name || c.rep_name}</td>}
                          <td style={{padding:'10px 12px'}}>
                            <span style={{ padding:'2px 8px', borderRadius:99, fontSize:11, fontWeight:600, background: c.event_type==='booking' ? '#DCFCE7' : '#EFF6FF', color: c.event_type==='booking' ? '#16A34A' : '#3b82f6' }}>
                              {c.event_type === 'booking' ? 'Booking' : 'Membership'}
                            </span>
                          </td>
                          <td style={{padding:'10px 12px', color:'var(--text-secondary)'}}>{c.contact_name}</td>
                          <td style={{padding:'10px 12px', textAlign:'right', fontWeight:700, color:'#16A34A'}}>{'$'}{parseFloat(c.amount).toFixed(2)}</td>
                          <td style={{padding:'10px 12px', color:'var(--text-muted)', fontSize:11}}>{new Date(c.earned_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      )}


      {/* Users tab */}
      {settingsTab === 'users' && (
        <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:20 }}>

          {/* MY PROFILE */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">My Profile</div>
              {profileMsg && <span style={{ fontSize:12, color:'var(--success)' }}>{profileMsg}</span>}
            </div>
            <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:16 }}>
                <div style={{ position:'relative', flexShrink:0 }}>
                  <div style={{ width:64, height:64, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: myAvatar ? 38 : 22, fontWeight:700, border:'2px solid var(--border)' }}>
                    {myAvatar || (myName || profile?.email || '?')[0].toUpperCase()}
                  </div>
                  <button onClick={() => { setPickerSelected(myAvatar); setShowAvatarPicker(true) }}
                    style={{ position:'absolute', bottom:0, right:0, width:22, height:22, borderRadius:'50%', background:'var(--accent)', border:'2px solid var(--surface)', color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}
                    title="Change avatar">+</button>
                </div>
                <div>
                  <div style={{ fontSize:13, fontWeight:600 }}>{myName || profile?.email}</div>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>
                    {myAvatar ? `Avatar: ${myAvatar}` : 'No avatar set'} · <span style={{ color:'var(--accent)', cursor:'pointer' }} onClick={() => { setPickerSelected(myAvatar); setShowAvatarPicker(true) }}>Change</span>
                  </div>
                </div>
              </div>
              <div className="form-field">
                <label className="form-label">Display name</label>
                <input className="form-input" value={myName} onChange={e => setMyName(e.target.value)} placeholder="Your name" />
              </div>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                <button className="btn primary" onClick={saveMyProfile} disabled={savingProfile}>
                  {savingProfile ? 'Saving...' : 'Save profile'}
                </button>
                <button className="btn" onClick={() => { setPwModal('me'); setNewPw(''); setPwMsg('') }}>
                  Change my password
                </button>
              </div>
            </div>
          </div>

          {/* EMOJI PICKER MODAL */}
          {showAvatarPicker && (
            <Modal title="Choose Your Avatar" onClose={() => setShowAvatarPicker(false)} width={520}>
              <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
                <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', background:'var(--surface-2)', borderRadius:'var(--radius)' }}>
                  <div style={{ width:48, height:48, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: pickerSelected ? 28 : 18, fontWeight:700, flexShrink:0 }}>
                    {pickerSelected || myAvatar || (myName || profile?.email || '?')[0].toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontSize:13, fontWeight:600 }}>{myName || profile?.email}</div>
                    <div style={{ fontSize:11, color:'var(--text-muted)' }}>{pickerSelected ? 'Looking good! Hit save to lock it in.' : 'Pick an emoji below'}</div>
                  </div>
                </div>
                <div style={{ maxHeight:400, overflowY:'auto', display:'flex', flexDirection:'column', gap:14 }}>
                  {Object.entries(EMOJIS).map(([category, emojis]) => (
                    <div key={category}>
                      <div style={{ fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', marginBottom:6 }}>{category}</div>
                      <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                        {emojis.map(emoji => (
                          <button key={emoji} onClick={() => setPickerSelected(emoji)}
                            style={{ width:40, height:40, borderRadius:'var(--radius)', fontSize:22,
                              border: pickerSelected===emoji ? '2px solid var(--accent)' : '2px solid transparent',
                              background: pickerSelected===emoji ? 'var(--accent-bg)' : 'var(--surface-2)',
                              cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
                              transform: pickerSelected===emoji ? 'scale(1.15)' : 'scale(1)', transition:'all .1s' }}>
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setShowAvatarPicker(false)}>Cancel</button>
                <button className="btn primary" onClick={confirmAvatar} disabled={!pickerSelected}>Select avatar</button>
              </div>
            </Modal>
          )}

          {/* ADMIN ONLY — User Management */}
          {isAdmin && (
            <>
              {msg && <div style={{ background:'var(--success-bg)', color:'var(--success)', padding:'10px 14px', borderRadius:'var(--radius)', fontSize:13 }}>{msg}</div>}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">User Management</div>
                  <span style={{ fontSize:11, color:'var(--text-muted)' }}>New reps sign up at the login page — set their role and campaigns here</span>
                </div>
                {loading ? <div className="card-body"><div className="spinner"></div></div> : (
                  <table className="data-table">
                    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active Campaigns</th><th>Actions</th></tr></thead>
                    <tbody>
                      {profiles.map(p => {
                        const activeCamps = getProfileCampaigns(p.id)
                        return (
                          <tr key={p.id}>
                            <td style={{ padding:'10px 12px', fontWeight:500 }}>
                              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                                <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 18 : 11, fontWeight:600, flexShrink:0 }}>
                                  {p.avatar || (p.name || p.email || '?')[0].toUpperCase()}
                                </div>
                                {p.name || '—'}
                              </div>
                            </td>
                            <td style={{ padding:'10px 12px', color:'var(--text-secondary)', fontSize:12 }}>{p.email}</td>
                            <td style={{ padding:'10px 12px' }}>
                              <span style={{ display:'inline-block', padding:'2px 8px', borderRadius:99, fontSize:10, fontWeight:600, background: p.role==='admin' ? 'var(--accent-bg)' : 'var(--surface-2)', color: p.role==='admin' ? 'var(--accent)' : 'var(--text-secondary)' }}>
                                {p.role || 'rep'}
                              </span>
                            </td>
                            <td style={{ padding:'10px 12px' }}>
                              {activeCamps.length === 0 ? <span style={{ fontSize:11, color:'var(--text-muted)' }}>No campaigns assigned</span> : (
                                <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                                  {activeCamps.map((name, i) => (
                                    <span key={name} style={{ fontSize:10, padding:'2px 7px', borderRadius:99, background:'var(--accent-bg)', color:'var(--accent)', fontWeight:600 }}>{i+1}. {name}</span>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td style={{ padding:'10px 12px' }}>
                              <div style={{ display:'flex', gap:6 }}>
                                <button className="btn sm" onClick={() => openEdit(p)}>Edit</button>
                                <button className="btn sm" onClick={() => { setPwModal({ profileId: p.id, name: p.name || p.email }); setNewPw(''); setPwMsg('') }}>Password</button>
                                <button className="btn sm" onClick={() => { setCommAdjModal({ profileId: p.id, name: p.name || p.email }); setCommAdjAmount(''); setCommAdjNote('') }}>Adjust</button>
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

            </>
          )}

          {/* Edit user modal */}
          {editProfile && (
            <Modal title={`Edit — ${editProfile.name || editProfile.email}`} onClose={() => setEditProfile(null)} width={560}>
              <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
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
                  <label className="form-label" style={{ marginBottom:8, display:'block' }}>Campaign Access & Priority</label>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:10 }}>Toggle campaigns on/off. Use arrows to set priority — #1 loads first when CSR goes Available.</div>
                  {editProfile.campaigns.filter(c => c.active).sort((a, b) => a.priority - b.priority).length > 0 && (
                    <div style={{ marginBottom:8 }}>
                      <div style={{ fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', marginBottom:6 }}>Active (priority order)</div>
                      <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                        {editProfile.campaigns.filter(c => c.active).sort((a, b) => a.priority - b.priority).map((c, idx, arr) => (
                          <div key={c.campaign_id} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background:'var(--success-bg)', border:'1px solid var(--success)', borderRadius:'var(--radius)' }}>
                            <span style={{ fontSize:11, fontWeight:700, color:'var(--success)', minWidth:18 }}>#{idx+1}</span>
                            <span style={{ fontSize:13, fontWeight:500, flex:1 }}>{c.name}</span>
                            <div style={{ display:'flex', gap:2 }}>
                              <button onClick={() => movePriority(c.campaign_id, 'up')} disabled={idx===0} style={{ padding:'2px 6px', fontSize:11, borderRadius:4, border:'1px solid var(--border)', background:'var(--surface)', cursor: idx===0 ? 'not-allowed' : 'pointer', opacity: idx===0 ? .3 : 1 }}>▲</button>
                              <button onClick={() => movePriority(c.campaign_id, 'down')} disabled={idx===arr.length-1} style={{ padding:'2px 6px', fontSize:11, borderRadius:4, border:'1px solid var(--border)', background:'var(--surface)', cursor: idx===arr.length-1 ? 'not-allowed' : 'pointer', opacity: idx===arr.length-1 ? .3 : 1 }}>▼</button>
                            </div>
                            <button onClick={() => toggleCampaign(c.campaign_id)} style={{ padding:'2px 8px', fontSize:11, borderRadius:4, border:'1px solid var(--danger)', background:'var(--danger-bg)', color:'var(--danger)', cursor:'pointer', fontWeight:500 }}>Remove</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {editProfile.campaigns.filter(c => !c.active).length > 0 && (
                    <div>
                      <div style={{ fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', marginBottom:6 }}>Available to add</div>
                      <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                        {editProfile.campaigns.filter(c => !c.active).map(c => (
                          <div key={c.campaign_id} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:'var(--radius)' }}>
                            <span style={{ fontSize:13, flex:1, color:'var(--text-muted)' }}>{c.name}</span>
                            <button onClick={() => toggleCampaign(c.campaign_id)} style={{ padding:'2px 8px', fontSize:11, borderRadius:4, border:'1px solid var(--accent)', background:'var(--accent-bg)', color:'var(--accent)', cursor:'pointer', fontWeight:500 }}>+ Add</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div style={{ background:'var(--warning-bg)', border:'1px solid #C87800', borderRadius:'var(--radius)', padding:'10px 14px', fontSize:12, color:'var(--warning)' }}>
                  Changes take effect on next page load.
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setEditProfile(null)}>Cancel</button>
                <button className="btn primary" onClick={saveProfile} disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</button>
              </div>
            </Modal>
          )}
        </div>
      )}

      {/* ── PASSWORD CHANGE MODAL ── */}
      {pwModal && (
        <Modal title={pwModal === 'me' ? 'Change My Password' : `Change Password — ${pwModal.name}`} onClose={() => { setPwModal(null); setNewPw(''); setPwMsg('') }} width={380}>
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {!isAdmin || pwModal === 'me' ? (
              <div style={{ fontSize:13, color:'var(--text-secondary)' }}>Enter a new password for your account.</div>
            ) : (
              <div style={{ fontSize:13, color:'var(--text-secondary)' }}>Set a new password for <strong>{pwModal.name}</strong>. They will need to use this to log in next time.</div>
            )}
            <div className="form-field">
              <label className="form-label">New Password</label>
              <input className="form-input" type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
                placeholder="Min 6 characters" onKeyDown={e => e.key === 'Enter' && changePassword()} />
            </div>
            {pwMsg && <div style={{ fontSize:12, color: pwMsg.startsWith('✓') ? 'var(--success)' : 'var(--danger)', padding:'8px 12px', background: pwMsg.startsWith('✓') ? 'var(--success-bg)' : 'var(--danger-bg)', borderRadius:'var(--radius)' }}>{pwMsg}</div>}
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => { setPwModal(null); setNewPw(''); setPwMsg('') }}>Cancel</button>
            <button className="btn primary" onClick={changePassword} disabled={savingPw || newPw.length < 6}>
              {savingPw ? 'Saving...' : 'Change password'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── SCORECARDS TAB ── */}
      {settingsTab === 'scorecards' && isAdmin && (
        <div style={{ flex:1, overflowY:'auto', padding:24 }}>

          {/* Filters row */}
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:24, flexWrap:'wrap' }}>
            {/* CSR selector */}
            <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
              <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)' }}>CSR</div>
              <select value={scSelectedProfile || ''} onChange={e => setScSelectedProfile(e.target.value || null)}
                style={{ padding:'7px 12px', fontSize:13, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface)', color:'var(--text-primary)', cursor:'pointer', minWidth:180 }}>
                <option value=''>Select a rep...</option>
                {profiles.map(p => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}
              </select>
            </div>

            {/* Month nav */}
            <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
              <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)' }}>Month</div>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <button onClick={() => scNavMonth(-1)} style={{ width:32, height:32, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-secondary)', display:'flex', alignItems:'center', justifyContent:'center' }}
                  onMouseEnter={e => e.currentTarget.style.background='var(--surface)'}
                  onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>{String.fromCharCode(8249)}</button>
                <span style={{ fontSize:13, fontWeight:500, color:'var(--text-primary)', minWidth:130, textAlign:'center' }}>{MONTH_NAMES[scMonth.month]} {scMonth.year}</span>
                <button onClick={() => scNavMonth(1)} style={{ width:32, height:32, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-secondary)', display:'flex', alignItems:'center', justifyContent:'center' }}
                  onMouseEnter={e => e.currentTarget.style.background='var(--surface)'}
                  onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>{String.fromCharCode(8250)}</button>
              </div>
            </div>

            {/* Actions */}
            {scSelectedProfile && (
              <div style={{ display:'flex', alignItems:'flex-end', gap:8, paddingBottom:1 }}>
                <button onClick={saveScorecard} disabled={scSaving}
                  style={{ padding:'7px 16px', fontSize:13, fontWeight:600, background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', cursor:'pointer', opacity: scSaving ? .6 : 1 }}>
                  {scSaving ? 'Saving...' : scSaved ? 'Saved!' : 'Save'}
                </button>
                <button onClick={() => window.print()}
                  style={{ padding:'7px 14px', fontSize:13, fontWeight:500, background:'var(--surface)', color:'var(--text-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor:'pointer' }}>
                  Print
                </button>
              </div>
            )}
          </div>

          {!scSelectedProfile && (
            <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:200, color:'var(--text-muted)', fontSize:13 }}>
              Select a rep to view their scorecard
            </div>
          )}

          {scSelectedProfile && scLoading && (
            <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:200 }}>
              <div className="spinner" />
            </div>
          )}

          {scSelectedProfile && !scLoading && (() => {
            const selectedRep = profiles.find(p => p.id === scSelectedProfile)
            const overallScore = scWeightedScore()
            const actuals = {
              attendance: scAttendancePoints,
              booking_pct: scActuals.booking_pct !== '' ? parseFloat(scActuals.booking_pct) : null,
              booked_calls: scActuals.booked_calls !== '' ? parseFloat(scActuals.booked_calls) : null,
              memberships: scActuals.memberships !== '' ? parseFloat(scActuals.memberships) : null,
            }

            return (
              <div id="scorecard-print">
                {/* Print header — hidden on screen */}
                <style>{`@media print { .no-print { display:none!important; } #scorecard-print { padding:24px; } }`}</style>

                {/* Scorecard header */}
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                    <div style={{ width:40, height:40, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: selectedRep?.avatar ? 22 : 15, fontWeight:700 }}>
                      {selectedRep?.avatar || (selectedRep?.name || selectedRep?.email || '?')[0].toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontSize:16, fontWeight:700, color:'var(--text-primary)' }}>{selectedRep?.name || selectedRep?.email}</div>
                      <div style={{ fontSize:12, color:'var(--text-muted)' }}>Performance Review - {MONTH_NAMES[scMonth.month]} {scMonth.year}</div>
                    </div>
                  </div>
                  {overallScore && (
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:2 }}>Overall Score</div>
                      <div style={{ fontSize:28, fontWeight:800, color: parseFloat(overallScore) >= 3.5 ? 'var(--success)' : parseFloat(overallScore) >= 2.5 ? '#8A5A00' : 'var(--danger)', letterSpacing:'-1px' }}>{overallScore}</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)' }}>out of 4.00</div>
                    </div>
                  )}
                </div>

                {/* Scorecard table */}
                <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden', marginBottom:20 }}>
                  {/* Header */}
                  <div style={{ display:'grid', gridTemplateColumns:'1.5fr 90px 100px 1fr 1fr 1fr 1fr', background:'var(--surface-2)', borderBottom:'2px solid var(--border)' }}>
                    {['KPI','Weight','Actual','Exceeds (4)','Meets (3)','Needs Improvement (2)','Poor Performance (1)'].map((h,i) => (
                      <div key={h} style={{ padding:'10px 12px', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', textAlign: i <= 2 ? 'left' : 'center' }}>
                        {h}
                        {i === 1 && (() => {
                          const total = SC_KPIS.reduce((s, k) => s + (parseFloat(scWeights[k.id]) || 0), 0)
                          const ok = total === 100
                          return <span style={{ marginLeft:4, fontSize:9, fontWeight:700, color: ok ? 'var(--success)' : 'var(--danger)' }}>= {total}%</span>
                        })()}
                      </div>
                    ))}
                  </div>

                  {SC_KPIS.map((kpi, idx) => {
                    const actual = actuals[kpi.id]
                    const rating = scGetRating(kpi, actual)
                    const ratingStyle = rating ? SC_RATING_COLORS[rating] : null
                    const { thresholds, lowerIsBetter, unit } = kpi
                    const fmt = (n) => unit === '%' ? `${n}${unit}` : `${n}${unit}`
                    const col4 = lowerIsBetter ? fmt(thresholds.exceeds) : `${fmt(thresholds.exceeds)}+`
                    const col3 = lowerIsBetter ? `${fmt(thresholds.meets+1)}-${fmt(thresholds.exceeds+1)}` : `${fmt(thresholds.meets)}-${fmt(thresholds.exceeds-1)}`
                    const col2 = lowerIsBetter ? `${fmt(thresholds.improvement+1)}-${fmt(thresholds.meets+1)}` : `${fmt(thresholds.improvement)}-${fmt(thresholds.meets-1)}`
                    const col1 = lowerIsBetter ? `${fmt(thresholds.improvement+1)}+` : `${fmt(thresholds.improvement-1)} or less`
                    const isEditable = kpi.id !== 'attendance'

                    return (
                      <div key={kpi.id} style={{ display:'grid', gridTemplateColumns:'1.5fr 90px 100px 1fr 1fr 1fr 1fr', borderBottom: idx < SC_KPIS.length-1 ? '1px solid var(--border)' : 'none', background: idx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)' }}>
                        {/* KPI name + rating badge */}
                        <div style={{ padding:'12px', display:'flex', flexDirection:'column', gap:4, justifyContent:'center' }}>
                          <div style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)' }}>{kpi.label}</div>
                          {rating && ratingStyle && (
                            <div style={{ fontSize:10, fontWeight:700, padding:'2px 6px', borderRadius:4, background: ratingStyle.bg, color: ratingStyle.text, display:'inline-block', width:'fit-content' }}>
                              {SC_RATING_LABELS[rating]}
                            </div>
                          )}
                        </div>
                        {/* Weight — editable */}
                        <div style={{ padding:'8px', display:'flex', alignItems:'center' }}>
                          <div style={{ position:'relative', width:'100%' }}>
                            <input
                              type="number" min="0" max="100"
                              value={scWeights[kpi.id]}
                              onChange={e => setScWeights(prev => ({ ...prev, [kpi.id]: e.target.value }))}
                              style={{ width:'100%', padding:'5px 22px 5px 8px', fontSize:13, fontWeight:600, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface)', color:'var(--text-primary)', textAlign:'center' }}
                            />
                            <span style={{ position:'absolute', right:6, top:'50%', transform:'translateY(-50%)', fontSize:11, color:'var(--text-muted)', pointerEvents:'none' }}>%</span>
                          </div>
                        </div>
                        {/* Actual — editable or auto */}
                        <div style={{ padding:'8px', display:'flex', alignItems:'center' }}>
                          {isEditable ? (
                            <input
                              type="number"
                              value={scActuals[kpi.id]}
                              onChange={e => setScActuals(prev => ({ ...prev, [kpi.id]: e.target.value }))}
                              placeholder="Enter"
                              style={{ width:'100%', padding:'5px 8px', fontSize:13, fontWeight:600, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface)', color:'var(--text-primary)', textAlign:'center' }}
                            />
                          ) : (
                            <div style={{ fontSize:13, fontWeight:700, color: ratingStyle ? ratingStyle.text : 'var(--text-muted)', paddingLeft:4 }}>
                              {actual != null ? `${actual.toFixed(1)}${unit}` : '--'}
                              <div style={{ fontSize:9, color:'var(--text-muted)', fontWeight:400 }}>auto</div>
                            </div>
                          )}
                        </div>
                        {/* Threshold columns */}
                        {[{ val:col4, r:4 }, { val:col3, r:3 }, { val:col2, r:2 }, { val:col1, r:1 }].map(({ val, r }) => {
                          const cs = SC_RATING_COLORS[r]
                          const isMyRating = rating === r
                          return (
                            <div key={r} style={{ padding:'12px 8px', textAlign:'center', fontSize:12, fontWeight: isMyRating ? 700 : 400, background: isMyRating ? cs.bg : cs.bg + '33', color: cs.text, borderLeft:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center', transition:'all .15s' }}>
                              {val}
                              {isMyRating && <span style={{ marginLeft:4, fontSize:10 }}>*</span>}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>

                {/* Notes section */}
                <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:16 }}>
                  <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:8 }}>Manager Notes</div>
                  <textarea
                    placeholder="Add notes for this review period..."
                    rows={4}
                    style={{ width:'100%', padding:'10px 12px', fontSize:13, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', color:'var(--text-primary)', resize:'vertical', fontFamily:'inherit' }}
                  />
                </div>

                {/* Footer */}
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:12, fontSize:11, color:'var(--text-muted)' }}>
                  <span>Attendance auto-populated from points log. Booking %, Booked Calls, and Memberships entered manually.</span>
                  <span>Awesome Home Services - Andi</span>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* ── COMMISSION ADJUSTMENT MODAL ── */}
      {commAdjModal && (
        <Modal title={`Adjust Commission — ${commAdjModal.name}`} onClose={() => { setCommAdjModal(null); setCommAdjAmount(''); setCommAdjNote('') }} width={380}>
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            <div style={{ fontSize:13, color:'var(--text-secondary)' }}>
              Add or subtract from <strong>{commAdjModal.name}</strong>'s commission. Use negative numbers to deduct (e.g. -2.00).
            </div>
            <div className="form-field">
              <label className="form-label">Amount ($)</label>
              <input className="form-input" type="number" step="0.50" value={commAdjAmount}
                onChange={e => setCommAdjAmount(e.target.value)} placeholder="e.g. 5.00 or -2.00" />
            </div>
            <div className="form-field">
              <label className="form-label">Note (optional)</label>
              <input className="form-input" value={commAdjNote} onChange={e => setCommAdjNote(e.target.value)}
                placeholder="e.g. Bonus for membership upsell" />
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => { setCommAdjModal(null); setCommAdjAmount(''); setCommAdjNote('') }}>Cancel</button>
            <button className="btn primary" onClick={addCommissionAdjustment} disabled={savingAdj || !commAdjAmount}>
              {savingAdj ? 'Saving...' : 'Add adjustment'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
