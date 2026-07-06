import { useState, useEffect, useCallback, useMemo } from 'react'
import { useData } from '../lib/DataContext'
import { useAuth } from '../lib/AuthContext'
import { sb } from '../lib/supabase'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import { isDone, isCallbackDueToday, getDupSet, normPhone, getInitials, fmtDate, fmtShort } from '../lib/utils'
import { OUTCOMES, MAX_ATTEMPTS, DONE_OUTCOMES } from '../lib/constants'

const PAGE_SIZE = 50

export default function DialerPage() {
  const { contacts, setContacts, campaigns, dncSet } = useData()
  const { profile } = useAuth()
  const currentRep = profile?.name || profile?.email || 'Unknown'

  const [selectedId, setSelectedId] = useState(null)
  const [selectedOutcome, setSelectedOutcome] = useState(null)
  const [filter, setFilter] = useState('active')
  const [campFilter, setCampFilter] = useState('')
  const [search, setSearch] = useState('')
  const [queuePage, setQueuePage] = useState(1)
  const [contactLogs, setContactLogs] = useState([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showCallbackModal, setShowCallbackModal] = useState(false)
  const [showCorrectModal, setShowCorrectModal] = useState(false)
  const [cbDate, setCbDate] = useState('')
  const [cbTime, setCbTime] = useState('09:00')
  const [cbNote, setCbNote] = useState('')
  const [correctOutcome, setCorrectOutcome] = useState('')
  const [correctNote, setCorrectNote] = useState('')
  const [mobileView, setMobileView] = useState('queue') // 'queue' | 'contact'
  const [powerDialActive, setPowerDialActive] = useState(false)
  const [showScript, setShowScript] = useState(false)
  const [celebration, setCelebration] = useState(null)

  // Check for power dial campaign from sessionStorage
  useEffect(() => {
    const campId = sessionStorage.getItem('powerDialCampaign')
    if (campId) {
      sessionStorage.removeItem('powerDialCampaign')
      setCampFilter(campId)
      setPowerDialActive(true)
      setTimeout(() => navNextPending(), 300)
    }
  }, [])

  const dupSet = useMemo(() => getDupSet(contacts), [contacts])

  const campName = useCallback((c) => {
    return campaigns.find(x => x.id === c.campaign_id)?.name || ''
  }, [campaigns])

  // FILTERED LIST
  const filtered = useMemo(() => {
    return contacts.filter(c => {
      if (search && !(c.name || '').toLowerCase().includes(search.toLowerCase()) && !(c.phone || '').includes(search)) return false
      if (campFilter && c.campaign_id !== campFilter) return false
      const s = c.status || 'Pending'
      if (filter === 'active') return !isDone(c) && s !== 'Max Attempts'
      if (filter === 'pending') return s === 'Pending'
      if (filter === 'callback') return isCallbackDueToday(c) && !isDone(c)
      if (filter === 'no-answer') return s === 'No Answer'
      if (filter === 'voicemail') return s === 'Voicemail'
      if (filter === 'done') return isDone(c) || s === 'Max Attempts'
      return true
    }).sort((a, b) => {
      // Callbacks first
      const aCb = isCallbackDueToday(a) && !isDone(a)
      const bCb = isCallbackDueToday(b) && !isDone(b)
      if (aCb && !bCb) return -1
      if (!aCb && bCb) return 1
      return 0
    })
  }, [contacts, search, campFilter, filter])

  const selectedContact = contacts.find(c => c.id === selectedId)
  const selectedIdx = filtered.findIndex(c => c.id === selectedId)

  // Load contact history
  useEffect(() => {
    if (!selectedId) return
    setLogsLoading(true)
    sb.from('call_logs').select('*').eq('contact_id', selectedId).order('created_at', { ascending: false })
      .then(({ data }) => { setContactLogs(data || []); setLogsLoading(false) })
  }, [selectedId])

  const selectContact = (id) => {
    setSelectedId(id)
    setSelectedOutcome(null)
    setMobileView('contact')
  }

  const navNextPending = () => {
    const cb = contacts.find(c => isCallbackDueToday(c) && !isDone(c) && !c.claimed_by)
    if (cb) { selectContact(cb.id); return }
    const next = contacts.find(c => (c.status || 'Pending') === 'Pending' && !c.claimed_by)
    if (next) selectContact(next.id)
    else alert('No unclaimed pending contacts!')
  }

  // CLAIM
  const claimContact = async (id) => {
  const alreadyClaimed = contacts.find(c => c.claimed_by === currentRep && c.id !== id)
  if (alreadyClaimed) {
    alert(`You already have ${alreadyClaimed.name} claimed. Log an outcome before claiming another contact.`); return
  }
  const { data: fresh } = await sb.from('contacts').select('claimed_by').eq('id', id).single()
  if (fresh?.claimed_by && fresh.claimed_by !== currentRep) {
    alert(`${fresh.claimed_by} just claimed this.`); return
    }
    const { data } = await sb.from('contacts').update({ claimed_by: currentRep, claimed_at: new Date().toISOString() }).eq('id', id).select().single()
    if (data) setContacts(prev => prev.map(c => c.id === id ? data : c))
  }

  const releaseContact = async (id) => {
    const { data } = await sb.from('contacts').update({ claimed_by: null, claimed_at: null }).eq('id', id).select().single()
    if (data) setContacts(prev => prev.map(c => c.id === id ? data : c))
  }

  // LOG OUTCOME
  const logOutcome = async (stay) => {
    if (!selectedOutcome || !selectedContact) return
    const c = selectedContact
    const notes = document.getElementById('call-notes')?.value?.trim() || ''
    const newAttempts = (c.attempts || 0) + 1
    const isFinal = DONE_OUTCOMES.includes(selectedOutcome) || newAttempts >= MAX_ATTEMPTS
    const newStatus = isFinal ? (DONE_OUTCOMES.includes(selectedOutcome) ? selectedOutcome : 'Max Attempts') : selectedOutcome

    setSaving(true)
    try {
      await sb.from('call_logs').insert({ contact_id: c.id, campaign_id: c.campaign_id, rep: currentRep, outcome: selectedOutcome, notes })
      const upd = { status: newStatus, attempts: newAttempts }
      if (isFinal) { upd.claimed_by = null; if (c.callback_at) { upd.callback_at = null; upd.callback_note = null } }
      const { data: updated } = await sb.from('contacts').update(upd).eq('id', c.id).select().single()
      if (updated) setContacts(prev => prev.map(x => x.id === c.id ? updated : x))

      // DNC cascade
      if (selectedOutcome === 'DNC' && c.phone) {
        const phone = normPhone(c.phone)
        const dupes = contacts.filter(x => x.id !== c.id && normPhone(x.phone || '') === phone)
        if (dupes.length) {
          await sb.from('contacts').update({ status: 'DNC' }).in('id', dupes.map(d => d.id))
          setContacts(prev => prev.map(x => dupes.some(d => d.id === x.id) ? { ...x, status: 'DNC', claimed_by: null } : x))
        }
      }

      // Trigger win celebration for Booked
    if (selectedOutcome === 'Booked') {
        setCelebration({ rep: currentRep, contactName: c.name || 'a contact' })
        setTimeout(() => setCelebration(null), 5000)
        // Fire Zapier webhook
        fetch('https://hooks.zapier.com/hooks/catch/25348607/4u2k7s2/', {
          method: 'POST',
         body: JSON.stringify({
  name: c.name || '',
  phone: c.phone || '',
  email: c.email || 'noemail@ahsdialer.com',
  address: c.address || '',
  city: c.city || '',
  state: c.state || '',
  zip: c.zip || '80901',
  campaign: campName(c) || '',
  rep: currentRep,
  booked_at: new Date().toISOString(),
  source: c.source || 'AHS Dialer',
  notes: notes || '',  // 👈 add this line
})
        }).catch(err => console.warn('Zapier webhook failed:', err))
      }

      setSelectedOutcome(null)
      // Reload logs
      const { data: logs } = await sb.from('call_logs').select('*').eq('contact_id', c.id).order('created_at', { ascending: false })
      setContactLogs(logs || [])

      if (!stay) {
        const nextContact = filtered.slice(selectedIdx + 1).find(x => !isDone(x) && x.status !== 'Max Attempts')
        if (nextContact) selectContact(nextContact.id)
        else { setSelectedId(null); setMobileView('queue') }
      }
    } finally {
      setSaving(false)
    }
  }

  // CALLBACK
  const openCallbackModal = () => {
    const c = selectedContact
    setCbDate(c?.callback_at ? c.callback_at.split('T')[0] : new Date().toISOString().split('T')[0])
    setCbTime(c?.callback_at ? new Date(c.callback_at).toTimeString().slice(0, 5) : '09:00')
    setCbNote(c?.callback_note || '')
    setShowCallbackModal(true)
  }

  const saveCallback = async () => {
    if (!cbDate || !cbTime) return
    const dt = new Date(`${cbDate}T${cbTime}`).toISOString()
    const { data } = await sb.from('contacts').update({ callback_at: dt, callback_note: cbNote }).eq('id', selectedId).select().single()
    if (data) setContacts(prev => prev.map(c => c.id === selectedId ? data : c))
    setShowCallbackModal(false)
  }

  const clearCallback = async (id) => {
    const { data } = await sb.from('contacts').update({ callback_at: null, callback_note: null }).eq('id', id).select().single()
    if (data) setContacts(prev => prev.map(c => c.id === id ? data : c))
  }

  // CORRECT OUTCOME
  const openCorrectModal = () => {
    const last = contactLogs[0]
    if (!last) return
    setCorrectOutcome(last.outcome)
    setCorrectNote('')
    setShowCorrectModal(true)
  }

  const applyCorrection = async () => {
    const last = contactLogs[0]
    if (!last) return
    const oldOutcome = last.outcome
    await sb.from('call_logs').update({ outcome: correctOutcome, correction: oldOutcome, notes: correctNote || `Corrected from ${oldOutcome}` }).eq('id', last.id)
    const c = selectedContact
    const attempts = c?.attempts || 1
    const isFinal = DONE_OUTCOMES.includes(correctOutcome) || attempts >= MAX_ATTEMPTS
    const newStatus = isFinal ? (DONE_OUTCOMES.includes(correctOutcome) ? correctOutcome : 'Max Attempts') : correctOutcome
    const { data } = await sb.from('contacts').update({ status: newStatus }).eq('id', selectedId).select().single()
    if (data) setContacts(prev => prev.map(x => x.id === selectedId ? data : x))
    const { data: logs } = await sb.from('call_logs').select('*').eq('contact_id', selectedId).order('created_at', { ascending: false })
    setContactLogs(logs || [])
    setShowCorrectModal(false)
  }

  const c = selectedContact
  const isMe = c?.claimed_by === currentRep
  const isOther = c?.claimed_by && !isMe
  const done = c ? (isDone(c) || c.status === 'Max Attempts') : false
  const isDNC = c ? (dncSet.has(normPhone(c.phone || ''))) : false
  const isDup = c ? dupSet.has(c.id) : false
  const cbDue = contacts.filter(x => isCallbackDueToday(x) && !isDone(x))

  // Responsive: on mobile show either queue or contact
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

  return (
    <div style={{ display:'flex', flex:1, overflow:'hidden', flexDirection: isMobile ? 'column' : 'row' }}>

      {/* SIDEBAR */}
      <aside style={{
        width: isMobile ? '100%' : 290, minWidth: isMobile ? 'auto' : 290, flexShrink:0,
        background:'var(--surface)', borderRight:'1px solid var(--border)',
        display: isMobile ? (mobileView === 'queue' ? 'flex' : 'none') : 'flex',
        flexDirection:'column', overflow:'hidden',
        height: isMobile ? 'calc(100vh - 90px)' : 'auto',
      }}>
        {/* Sidebar header */}
        <div style={{ padding:'12px 14px 10px', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
          <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:8 }}>Contact queue</div>
          <input
            style={{ width:'100%', border:'1px solid var(--border-strong)', borderRadius:'var(--radius)', padding:'6px 10px', fontSize:12, background:'var(--surface)', color:'var(--text-primary)' }}
            placeholder="Search name or phone…" value={search} onChange={e => { setSearch(e.target.value); setQueuePage(1) }}
          />
          <div style={{ display:'flex', gap:4, marginTop:8, flexWrap:'wrap' }}>
            {['active','pending','callback','no-answer','voicemail','done','all'].map(f => (
              <button key={f} onClick={() => { setFilter(f); setQueuePage(1) }}
                style={{ padding:'3px 8px', borderRadius:99, fontSize:11, fontWeight:500, border:'1px solid', cursor:'pointer', whiteSpace:'nowrap',
                  borderColor: filter===f ? 'var(--accent)' : 'var(--border-strong)',
                  background: filter===f ? 'var(--accent)' : 'var(--surface)',
                  color: filter===f ? '#fff' : 'var(--text-secondary)' }}>
                {f === 'no-answer' ? 'No ans' : f === 'callback' ? '📅 CB' : f.charAt(0).toUpperCase()+f.slice(1)}
              </button>
            ))}
          </div>
          <select value={campFilter} onChange={e => setCampFilter(e.target.value)}
            style={{ width:'100%', marginTop:6, border:'1px solid var(--border-strong)', borderRadius:'var(--radius)', padding:'5px 8px', fontSize:11, background:'var(--surface)', color:'var(--text-primary)' }}>
            <option value="">All campaigns</option>
            {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        {/* Queue count */}
        <div style={{ padding:'6px 14px', fontSize:11, color:'var(--text-muted)', background:'var(--surface-2)', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between' }}>
          <span>{filtered.length.toLocaleString()} shown</span>
          <span>{contacts.length.toLocaleString()} total</span>
        </div>

        {/* Callbacks due */}
        {cbDue.length > 0 && (
          <div style={{ background:'#FFF8E6', borderBottom:'2px solid #E8C84A', maxHeight:160, overflowY:'auto', flexShrink:0 }}>
            <div style={{ padding:'6px 14px', fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--warning)', position:'sticky', top:0, background:'#FFF8E6' }}>
              📅 Callbacks due ({cbDue.length})
            </div>
            {cbDue.map(cb => {
              const d = new Date(cb.callback_at); const overdue = d < new Date()
              return (
                <div key={cb.id} onClick={() => selectContact(cb.id)}
                  style={{ padding:'7px 14px', borderBottom:'1px solid #F0E090', cursor:'pointer', background: overdue ? '#FFF0EE' : 'transparent' }}>
                  <div style={{ fontSize:10, fontWeight:600, color: overdue ? 'var(--danger)' : 'var(--warning)' }}>
                    {overdue ? '⚠ OVERDUE — ' : ''}{d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}
                  </div>
                  <div style={{ fontSize:12, fontWeight:500 }}>{cb.name} · {cb.phone}</div>
                  {cb.callback_note && <div style={{ fontSize:11, color:'var(--text-muted)' }}>{cb.callback_note}</div>}
                </div>
              )
            })}
          </div>
        )}

        {/* Queue list */}
        <div style={{ flex:1, overflowY:'auto' }}>
          {filtered.slice(0, queuePage * PAGE_SIZE).map(contact => {
            const s = contact.status || 'Pending', attempts = contact.attempts || 0
            const isMyContact = contact.claimed_by === currentRep
            const isOtherContact = contact.claimed_by && !isMyContact
            const active = contact.id === selectedId
            const isDNCContact = dncSet.has(normPhone(contact.phone || ''))
            const isDupContact = dupSet.has(contact.id)
            const hasCb = isCallbackDueToday(contact)
            return (
              <div key={contact.id} onClick={() => selectContact(contact.id)}
                style={{
                  padding:'10px 14px', borderBottom:'1px solid var(--border)', cursor:'pointer',
                  background: active ? 'var(--accent-bg)' : 'transparent',
                  borderLeft: active ? '3px solid var(--accent)' : isDNCContact ? '3px solid var(--danger)' : isDupContact ? '3px solid var(--purple)' : '3px solid transparent',
                  opacity: isOtherContact ? .6 : 1,
                }}>
                <div style={{ fontWeight:500, fontSize:12, marginBottom:2, display:'flex', alignItems:'center', gap:4, flexWrap:'wrap' }}>
                  {contact.name || '—'}
                  {isMyContact && <span className="badge" style={{background:'var(--warning-bg)',color:'var(--warning)',fontSize:9}}>You</span>}
                  {isOtherContact && <span className="badge" style={{background:'var(--warning-bg)',color:'var(--warning)',fontSize:9}}>{contact.claimed_by.split(' ')[0]}</span>}
                  {isDNCContact && <span className="badge" style={{background:'#FBE8E4',color:'#5F1C0A',fontSize:9}}>⛔DNC</span>}
                  {isDupContact && <span className="badge" style={{background:'var(--purple-bg)',color:'var(--purple)',fontSize:9}}>⚠Dup</span>}
                  {hasCb && <span className="badge" style={{background:'#FFF8E6',color:'var(--warning)',fontSize:9}}>📅</span>}
                </div>
                <div style={{ fontSize:11, color:'var(--text-muted)' }}>{contact.phone || 'No phone'} · {campName(contact) || 'No campaign'}</div>
                <div style={{ display:'flex', gap:3, marginTop:3 }}>
                  {Array.from({length:MAX_ATTEMPTS},(_,i)=>(
                    <div key={i} style={{width:5,height:5,borderRadius:'50%',background:i<attempts?'var(--accent)':'var(--border-strong)'}}></div>
                  ))}
                </div>
                <div style={{ marginTop:3 }}><Badge status={s} /></div>
              </div>
            )
          })}
          {filtered.length > queuePage * PAGE_SIZE && (
            <button onClick={() => setQueuePage(p => p+1)}
              style={{ width:'100%', padding:10, fontSize:12, color:'var(--accent)', background:'var(--surface-2)', border:'none', borderTop:'1px solid var(--border)', cursor:'pointer', fontWeight:500 }}>
              Load more ({filtered.length - queuePage * PAGE_SIZE} more)
            </button>
          )}
        </div>

        {/* Mobile: next pending button */}
        {isMobile && (
          <div style={{ padding:12, borderTop:'1px solid var(--border)', flexShrink:0 }}>
            <button className="btn primary" style={{ width:'100%', justifyContent:'center' }} onClick={navNextPending}>Next pending →</button>
          </div>
        )}
      </aside>

      {/* MAIN PANEL */}
      <div style={{
        flex:1, display: isMobile ? (mobileView === 'contact' ? 'flex' : 'none') : 'flex',
        flexDirection:'column', overflow:'hidden'
      }}>
        {/* Toolbar */}
        <div style={{ padding:'8px 20px', background:'var(--surface)', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, flexShrink:0, flexWrap:'wrap' }}>
          <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
            {isMobile && <button className="btn sm" onClick={() => { setSelectedId(null); setMobileView('queue') }}>← Queue</button>}
            {!isMobile && <button className="btn sm" onClick={() => setSelectedId(null)}>← Queue</button>}
            <button className="btn sm" disabled={selectedIdx <= 0} onClick={() => { const prev = filtered[selectedIdx-1]; if(prev) selectContact(prev.id) }}>‹ Prev</button>
            <button className="btn sm" disabled={selectedIdx >= filtered.length-1} onClick={() => { const next = filtered[selectedIdx+1]; if(next) selectContact(next.id) }}>Next ›</button>
            <button className="btn sm primary" onClick={navNextPending}>Next pending →</button>
          </div>
          {c && (
            <div style={{ fontSize:11, color:'var(--text-muted)', display:'flex', alignItems:'center', gap:6 }}>
              Attempts:
              <div style={{ display:'flex', gap:3 }}>
                {Array.from({length:MAX_ATTEMPTS},(_,i)=>(
                  <div key={i} style={{width:8,height:8,borderRadius:'50%',background:i<(c.attempts||0)?'var(--accent)':'var(--border-strong)'}}></div>
                ))}
              </div>
              {c.attempts||0}/{MAX_ATTEMPTS}
            </div>
          )}
        </div>

        {/* Contact area */}
        <div style={{ flex:1, overflowY:'auto', padding:'20px 20px 40px' }}>
          {/* Power dial banner */}
        {powerDialActive && (
          <div style={{ background:'var(--accent)', color:'#fff', padding:'8px 20px', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, fontWeight:500 }}>
              <span>⚡</span> <strong>Power Dial Mode Active</strong> — auto-advancing through contacts
            </div>
            <button onClick={() => setPowerDialActive(false)} style={{ background:'rgba(255,255,255,0.2)', border:'none', color:'#fff', padding:'4px 12px', borderRadius:'var(--radius)', cursor:'pointer', fontSize:12 }}>Stop</button>
          </div>
        )}

        {!c ? (
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {/* Home stats */}
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))', gap:12 }}>
                {[
                  { label:'Total contacts', value:contacts.length.toLocaleString(), color:'accent' },
                  { label:'Active (to call)', value:contacts.filter(x=>!isDone(x)&&x.status!=='Max Attempts').length.toLocaleString(), color:'warning' },
                  { label:'Completed', value:contacts.filter(isDone).length.toLocaleString(), color:'success' },
                  { label:'Callbacks today', value:cbDue.length, color:'warning', onClick:()=>setFilter('callback') },
                ].map(({ label, value, color, onClick }) => (
                  <div key={label} className={`stat-card ${color}${onClick?' clickable':''}`} style={{ borderLeft:`3px solid var(--${color})` }} onClick={onClick}>
                    <div className="stat-label">{label}</div>
                    <div className="stat-value">{value}</div>
                  </div>
                ))}
              </div>
              <div className="empty-state">
                <div className="empty-icon">📞</div>
                <div style={{ fontWeight:500 }}>Ready to dial</div>
                <button className="btn primary" style={{ marginTop:8 }} onClick={navNextPending}>Next pending →</button>
              </div>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:14, maxWidth:900, margin:'0 auto' }}>
              {/* Warnings */}
              {isDNC && <div style={{ background:'#FBE8E4', border:'1px solid #E8C0B8', borderRadius:'var(--radius)', padding:'10px 14px', fontSize:12, color:'#5F1C0A', display:'flex', alignItems:'center', gap:8 }}>⛔ <strong>DNC WARNING</strong> — Do not dial this number.</div>}
              {isDup && <div style={{ background:'var(--purple-bg)', border:'1px solid #C8B8E8', borderRadius:'var(--radius)', padding:'10px 14px', fontSize:12, color:'var(--purple)', display:'flex', alignItems:'center', gap:8 }}>⚠ <strong>Duplicate phone</strong> — This number appears on multiple contacts.</div>}
              {c.callback_at && (
                <div style={{ background:'#FFF8E6', border:'1px solid #E8C84A', borderRadius:'var(--radius)', padding:'10px 14px', fontSize:12, color:'var(--warning)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <span>📅 <strong>Callback:</strong> {fmtDate(c.callback_at)}{c.callback_note ? ' — ' + c.callback_note : ''}</span>
                  <button className="btn sm" onClick={() => clearCallback(c.id)}>Clear</button>
                </div>
              )}

              {/* Contact card */}
              <div className="card">
                <div className="contact-header" style={{ padding:'16px 18px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12 }}>
                  <div style={{ display:'flex', alignItems:'flex-start', gap:12, flex:1 }}>
                    <div style={{ width:42, height:42, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent-text)', fontWeight:600, fontSize:14, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      {getInitials(c.name)}
                    </div>
                    <div>
                      <div style={{ fontSize:16, fontWeight:600 }}>{c.name || '—'}</div>
                      <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:2 }}>{[c.address,c.city,c.state,c.zip].filter(Boolean).join(', ') || 'No address'}</div>
                      {campName(c) && <span className="badge" style={{ background:'var(--accent-bg)', color:'var(--accent-text)', marginTop:4, display:'inline-block' }}>{campName(c)}</span>}
                    </div>
                  </div>
                  <div style={{ textAlign:'right', flexShrink:0 }}>
                  <a href={`tel:${c.phone}`} style={{ fontSize:22, fontWeight:500, color:'var(--accent)', letterSpacing:-.3, textDecoration:'none' }}>{c.phone || 'No phone'}</a>
                    {c.phone && (
                      <button className="btn sm" style={{ marginTop:4 }} onClick={() => navigator.clipboard.writeText(c.phone)}>📋 Copy</button>
                    )}
                    {c.email && <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>{c.email}</div>}
                  </div>
                </div>

                {/* Claim bar */}
                {done ? (
                  <div style={{ padding:'10px 18px', background:'var(--surface-2)', borderBottom:'1px solid var(--border)', fontSize:12, color:'var(--success)', fontWeight:500 }}>✓ Complete — {c.status}</div>
                ) : !c.claimed_by ? (
                  <div style={{ padding:'10px 18px', background:'var(--surface-2)', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between', fontSize:12 }}>
                    <span style={{ color:'var(--text-secondary)' }}>Unclaimed</span>
                    <button className="btn sm primary" onClick={() => claimContact(c.id)}>Claim &amp; call</button>
                  </div>
                ) : isMe ? (
                  <div style={{ padding:'10px 18px', background:'var(--surface-2)', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between', fontSize:12 }}>
                    <span style={{ color:'var(--accent)', fontWeight:500 }}>✓ Claimed by you</span>
                    <button className="btn sm" onClick={() => releaseContact(c.id)}>Release</button>
                  </div>
                ) : (
                  <div style={{ padding:'10px 18px', background:'var(--warning-bg)', borderBottom:'1px solid var(--border)', fontSize:12, color:'var(--warning)' }}>
                    ⚠ Claimed by <strong>{c.claimed_by}</strong>
                  </div>
                )}

                {/* Details */}
                <div style={{ display:'flex', flexWrap:'wrap', borderTop:'1px solid var(--border)' }}>
                  {[
                    { label:'Status', value:<Badge status={c.status || 'Pending'} /> },
                    { label:'Source', value:c.source || '—', empty:!c.source },
                    { label:'Email', value:c.email || '—', empty:!c.email },
                    { label:'External ID', value:c.external_id || '—', empty:!c.external_id },
                  ].map(({ label, value, empty }) => (
                    <div key={label} style={{ flex:'1 1 140px', padding:'8px 18px', borderBottom:'1px solid var(--border)', borderRight:'1px solid var(--border)' }}>
                      <div style={{ fontSize:10, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', marginBottom:2 }}>{label}</div>
                      <div style={{ fontSize:13, color: empty ? 'var(--text-muted)' : 'var(--text-primary)', fontStyle: empty ? 'italic' : 'normal' }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Campaign script — auto-shows when campaign has script/tips */}
              {(() => {
                const camp = campaigns.find(x => x.id === c.campaign_id)
                if (!camp?.script && !camp?.tips) return null
                return (
                  <div className="card" style={{ border:'2px solid var(--accent)' }}>
                    <div className="card-header" style={{ background:'var(--accent-bg)' }}>
                      <div className="card-title" style={{ color:'var(--accent)' }}>📜 {camp.name} — Call Guide</div>
                    </div>
                    <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:14 }}>
                      {camp.script && (
                        <div>
                          <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-secondary)', marginBottom:6 }}>Script</div>
                          <div style={{ background:'var(--surface-2)', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:13, lineHeight:1.8, whiteSpace:'pre-wrap', color:'var(--text-primary)', borderLeft:'3px solid var(--accent)' }}>
                            {camp.script}
                          </div>
                        </div>
                      )}
                      {camp.tips && (
                        <div>
                          <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-secondary)', marginBottom:6 }}>💡 Tips & Talking Points</div>
                          <div style={{ background:'var(--warning-bg)', border:'1px solid #E8C84A', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:13, lineHeight:1.8, whiteSpace:'pre-wrap', color:'var(--text-primary)' }}>
                            {camp.tips}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}

              {/* Log outcome */}
              {!done && (
                <div className="card">
                  <div className="card-header"><div className="card-title">Log call outcome</div></div>
                  <div className="card-body">
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6, marginBottom:10 }}>
                      {OUTCOMES.map(o => {
                        const sel = selectedOutcome === o.id
                        const colorMap = {
                          'No Answer': { border:'#C87800', bg:'var(--warning-bg)', color:'var(--warning)' },
                          'Voicemail': { border:'var(--purple)', bg:'var(--purple-bg)', color:'var(--purple)' },
                          'Booked': { border:'var(--success)', bg:'var(--success-bg)', color:'var(--success)' },
                          'Not Interested': { border:'var(--danger)', bg:'var(--danger-bg)', color:'var(--danger)' },
                          'DNC': { border:'#5F1C0A', bg:'#FBE8E4', color:'#5F1C0A' },
                          'Bad Data': { border:'var(--border-strong)', bg:'var(--surface-2)', color:'var(--text-secondary)' },
                        }
                        const cm = colorMap[o.id]
                        return (
                          <button key={o.id} disabled={!isMe} onClick={() => setSelectedOutcome(o.id)}
                            style={{
                              padding:'8px 6px', borderRadius:'var(--radius)', fontSize:11, fontWeight:sel?600:500,
                              border: sel ? `2px solid ${cm.border}` : '1.5px solid var(--border)',
                              background: sel ? cm.bg : 'var(--surface)', color: sel ? cm.color : 'var(--text-primary)',
                              cursor: isMe ? 'pointer' : 'not-allowed', opacity: isMe ? 1 : .45,
                              textAlign:'center', lineHeight:1.3, transition:'all .1s',
                            }}>
                            {o.emoji}<br/>{o.id}
                          </button>
                        )
                      })}
                    </div>
                    <textarea id="call-notes" disabled={!isMe} placeholder="Notes (optional)…"
                      style={{ width:'100%', border:'1px solid var(--border-strong)', borderRadius:'var(--radius)', padding:'8px 10px', fontSize:12, fontFamily:'inherit', resize:'vertical', minHeight:44, background:'var(--surface)', color:'var(--text-primary)', marginBottom:10, opacity:isMe?1:.45 }} />
                    <div style={{ display:'flex', gap:6, justifyContent:'flex-end', flexWrap:'wrap' }}>
                      <button className="btn warning" disabled={!isMe} onClick={openCallbackModal}>📅 Schedule callback</button>
                      <button className="btn" disabled={!isMe || !selectedOutcome || saving} onClick={() => logOutcome(true)}>
                        {saving ? <div className="spinner" style={{width:14,height:14,borderWidth:2}}></div> : 'Log & stay'}
                      </button>
                      <button className="btn success" disabled={!isMe || !selectedOutcome || saving} onClick={() => logOutcome(false)}>
                        {saving ? <div className="spinner" style={{width:14,height:14,borderWidth:2}}></div> : 'Log & next →'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {done && (
                <div className="card" style={{ borderLeft:'3px solid var(--success)' }}>
                  <div className="card-body" style={{ fontSize:13, color:'var(--text-secondary)' }}>
                    Contact is <strong>complete</strong> ({c.status}). Removed from active queue.
                  </div>
                </div>
              )}

              {/* Script panel */}
              {showScript && c?.campaign_id && (() => {
                const camp = campaigns.find(x=>x.id===c.campaign_id)
                if (!camp?.script && !camp?.tips) return null
                return (
                  <div className="card" style={{ border:'2px solid var(--accent)' }}>
                    <div className="card-header">
                      <div className="card-title">📜 {camp.name} — Script</div>
                      <button className="btn sm ghost" onClick={()=>setShowScript(false)}>✕</button>
                    </div>
                    <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:14 }}>
                      {camp.script && (
                        <div>
                          <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-secondary)', marginBottom:6 }}>Call Script</div>
                          <div style={{ background:'var(--surface-2)', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:13, lineHeight:1.7, whiteSpace:'pre-wrap' }}>{camp.script}</div>
                        </div>
                      )}
                      {camp.tips && (
                        <div>
                          <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-secondary)', marginBottom:6 }}>💡 Tips</div>
                          <div style={{ background:'var(--warning-bg)', border:'1px solid #E8C84A', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:13, lineHeight:1.7, whiteSpace:'pre-wrap' }}>{camp.tips}</div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}

              {/* Call history */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Call history ({contactLogs.length})</div>
                  {contactLogs.length > 0 && (
                    <button className="btn sm warning" onClick={openCorrectModal}>✏️ Correct last outcome</button>
                  )}
                </div>
                <div className="card-body">
                  {logsLoading ? <div className="spinner" style={{margin:'8px auto'}}></div> :
                    contactLogs.length === 0 ? <div style={{ color:'var(--text-muted)', fontSize:12 }}>No attempts yet.</div> :
                    contactLogs.map(l => (
                      <div key={l.id} style={{ padding:'8px 0', borderBottom:'1px solid var(--border)', fontSize:12 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:2, flexWrap:'wrap' }}>
                          <Badge status={l.outcome} />
                          <span style={{ color:'var(--text-muted)', fontSize:11, marginLeft:'auto' }}>{l.rep} · {fmtDate(l.created_at)}</span>
                        </div>
                        {l.notes && <div style={{ color:'var(--text-secondary)', fontSize:11 }}>{l.notes}</div>}
                        {l.correction && <div style={{ color:'var(--text-muted)', fontSize:10, marginTop:2 }}>✏️ Corrected from {l.correction}</div>}
                      </div>
                    ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* WIN CELEBRATION */}
      {celebration && (
        <>
          <style>{`
            @keyframes fall { 0%{transform:translateY(0) rotate(0deg);opacity:1;} 100%{transform:translateY(100vh) rotate(720deg);opacity:0;} }
            @keyframes popIn { 0%{transform:translate(-50%,-50%) scale(0.5);opacity:0;} 70%{transform:translate(-50%,-50%) scale(1.05);opacity:1;} 100%{transform:translate(-50%,-50%) scale(1);opacity:1;} }
          `}</style>
          {Array.from({length:60},(_,i)=>(
            <div key={i} style={{position:'fixed',borderRadius:3,left:`${Math.random()*100}%`,top:`-${Math.random()*20+10}px`,width:`${Math.random()*10+6}px`,height:`${Math.random()*10+6}px`,background:['#1A5C8A','#2E7D52','#FFC107','#E91E63','#9C27B0','#FF5722','#00BCD4'][Math.floor(Math.random()*7)],animation:`fall ${Math.random()*1.5+2}s ease-in ${Math.random()*1.5}s forwards`,pointerEvents:'none',zIndex:9999}}/>
          ))}
          <div style={{position:'fixed',top:'50%',left:'50%',zIndex:10000,animation:'popIn 0.5s cubic-bezier(0.175,0.885,0.32,1.275) forwards',background:'white',borderRadius:20,padding:'40px 48px',boxShadow:'0 20px 60px rgba(0,0,0,0.3)',textAlign:'center',border:'3px solid #2E7D52',minWidth:340}}>
            <div style={{fontSize:64,marginBottom:8,lineHeight:1}}>🎉</div>
            <div style={{fontSize:28,fontWeight:800,color:'#2E7D52',marginBottom:6}}>BOOKED!</div>
            <div style={{fontSize:18,fontWeight:600,color:'#1C1B19',marginBottom:4}}>{celebration.contactName}</div>
            <div style={{fontSize:14,color:'#6B6760'}}>{celebration.rep} just closed one! 🔥</div>
            <button onClick={()=>setCelebration(null)} style={{marginTop:20,padding:'8px 24px',background:'#2E7D52',color:'white',border:'none',borderRadius:8,cursor:'pointer',fontSize:13,fontWeight:600}}>Let's go! 💪</button>
          </div>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',zIndex:9998}} onClick={()=>setCelebration(null)}/>
        </>
      )}

      {/* CALLBACK MODAL */}
      {showCallbackModal && (
        <Modal title="📅 Schedule callback" onClose={() => setShowCallbackModal(false)}>
          <div className="form-field"><label className="form-label">Date</label><input className="form-input" type="date" value={cbDate} onChange={e=>setCbDate(e.target.value)} /></div>
          <div className="form-field"><label className="form-label">Time</label><input className="form-input" type="time" value={cbTime} onChange={e=>setCbTime(e.target.value)} /></div>
          <div className="form-field"><label className="form-label">Note (optional)</label><input className="form-input" placeholder="e.g. Husband home after 5pm" value={cbNote} onChange={e=>setCbNote(e.target.value)} /></div>
          <div className="modal-actions">
            {c?.callback_at && <button className="btn danger" onClick={() => { clearCallback(c.id); setShowCallbackModal(false) }}>Clear</button>}
            <button className="btn" onClick={() => setShowCallbackModal(false)}>Cancel</button>
            <button className="btn primary" onClick={saveCallback}>Schedule</button>
          </div>
        </Modal>
      )}

      {/* CORRECT MODAL */}
      {showCorrectModal && contactLogs[0] && (
        <Modal title="✏️ Correct last outcome" onClose={() => setShowCorrectModal(false)}>
          <div style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:14 }}>
            Last logged: <Badge status={contactLogs[0].outcome} /> by {contactLogs[0].rep} at {fmtDate(contactLogs[0].created_at)}
          </div>
          <div className="form-field">
            <label className="form-label">Change outcome to</label>
            <select className="form-input" value={correctOutcome} onChange={e=>setCorrectOutcome(e.target.value)}>
              {OUTCOMES.map(o => <option key={o.id} value={o.id}>{o.emoji} {o.id}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label className="form-label">Correction note</label>
            <input className="form-input" placeholder="e.g. Mis-clicked, meant to select Booked" value={correctNote} onChange={e=>setCorrectNote(e.target.value)} />
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setShowCorrectModal(false)}>Cancel</button>
            <button className="btn primary" onClick={applyCorrection}>Apply correction</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
