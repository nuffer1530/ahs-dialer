// Per-queue availability for a CSR. Shows only the queues an admin has granted
// this rep (inbound skill + active csr_campaigns); the rep toggles which they're
// taking right now. Inbound availability drives their TaskRouter worker so they
// only receive inbound calls when opted in. Renders nothing for reps with no
// skills granted, so they keep the pre-skills behavior.
import { useState, useEffect, useRef } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useData } from '../lib/DataContext'
import { syncWorkerActivity } from '../lib/utils'

function Toggle({ label, sub, on, onClick, accent = 'var(--accent)' }) {
  return (
    <button onClick={onClick}
      style={{ display:'flex', alignItems:'center', gap:10, width:'100%', padding:'8px', background:'transparent', border:'none', cursor:'pointer', textAlign:'left', borderRadius:6 }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
      <div style={{ width:34, height:20, borderRadius:99, background: on ? accent : 'var(--border)', position:'relative', flexShrink:0, transition:'background .15s' }}>
        <div style={{ position:'absolute', top:2, left: on ? 16 : 2, width:16, height:16, borderRadius:'50%', background:'#fff', transition:'left .15s', boxShadow:'0 1px 2px rgba(0,0,0,.2)' }} />
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)' }}>{label}</div>
        <div style={{ fontSize:10, color:'var(--text-muted)' }}>{sub}</div>
      </div>
    </button>
  )
}

export default function QueueSelector() {
  const { profile, refreshProfile } = useAuth()
  const { campaigns } = useData()
  const [open, setOpen] = useState(false)
  const [granted, setGranted] = useState([])            // granted outbound campaigns, priority order
  const [inboundAvail, setInboundAvail] = useState(false)
  const [activeCamps, setActiveCamps] = useState([])
  const ref = useRef(null)

  useEffect(() => {
    if (!profile?.id) return
    setInboundAvail(!!profile.inbound_available)
    setActiveCamps(Array.isArray(profile.active_campaign_ids) ? profile.active_campaign_ids : [])
    sb.from('csr_campaigns').select('campaign_id, priority').eq('profile_id', profile.id).eq('active', true)
      .then(({ data }) => setGranted((data || []).sort((a, b) => a.priority - b.priority)))
  }, [profile?.id])

  useEffect(() => {
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const hasInbound = !!profile?.inbound_skill
  const campName = id => campaigns.find(c => c.id === id)?.name || 'Campaign'
  const grantedCampaigns = granted.map(g => ({ ...g, name: campName(g.campaign_id) }))

  // No skills granted → no control; the rep keeps the pre-skills lead pool.
  if (!hasInbound && grantedCampaigns.length === 0) return null

  const toggleInbound = async () => {
    const next = !inboundAvail
    setInboundAvail(next)
    await sb.from('profiles').update({ inbound_available: next }).eq('id', profile.id)
    syncWorkerActivity(profile.id, profile.status)   // reflect into TaskRouter now
    refreshProfile?.()
  }
  const toggleCamp = async (id) => {
    const next = activeCamps.includes(id) ? activeCamps.filter(x => x !== id) : [...activeCamps, id]
    setActiveCamps(next)
    await sb.from('profiles').update({ active_campaign_ids: next }).eq('id', profile.id)
    refreshProfile?.()
  }

  const activeCount = (hasInbound && inboundAvail ? 1 : 0)
    + activeCamps.filter(id => grantedCampaigns.some(g => g.campaign_id === id)).length

  return (
    <div ref={ref} style={{ position:'relative', flexShrink:0 }}>
      <button onClick={() => setOpen(o => !o)} className="btn"
        style={{ fontSize:11, padding:'4px 10px', display:'flex', gap:6, alignItems:'center' }}>
        Queues
        {activeCount > 0 && <span style={{ background:'var(--accent)', color:'#fff', borderRadius:99, padding:'0 6px', fontSize:10, fontWeight:700 }}>{activeCount}</span>}
        <span style={{ fontSize:9, color:'var(--text-muted)' }}>▾</span>
      </button>
      {open && (
        <div style={{ position:'absolute', top:'115%', left:0, zIndex:300, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 8px 28px rgba(0,0,0,.18)', minWidth:250, padding:8 }}>
          <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', padding:'4px 8px 6px' }}>Go available for</div>
          {hasInbound && (
            <Toggle label="Inbound queue" sub="Live calls · always served first" on={inboundAvail} onClick={toggleInbound} accent="#16A34A" />
          )}
          {grantedCampaigns.map((g, i) => (
            <Toggle key={g.campaign_id} label={g.name} sub={`Outbound · priority #${i + 1}`}
              on={activeCamps.includes(g.campaign_id)} onClick={() => toggleCamp(g.campaign_id)} />
          ))}
        </div>
      )}
    </div>
  )
}
