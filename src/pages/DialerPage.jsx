import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useData } from '../lib/DataContext'
import { useAuth } from '../lib/AuthContext'
import { sb } from '../lib/supabase'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import { isDone, isCallbackDueToday, getDupSet, normPhone, getInitials, fmtDate, fmtShort } from '../lib/utils'
import { OUTCOMES, MAX_ATTEMPTS, DONE_OUTCOMES } from '../lib/constants'

const PAGE_SIZE = 50

const OUTCOME_CONFIG = {
  'No Answer':     { border:'#C87800', bg:'#FFF8E6', color:'#C87800', emoji:'📵' },
  'Voicemail':     { border:'#7C3AED', bg:'#F3E8FF', color:'#7C3AED', emoji:'📬' },
  'Booked':        { border:'#16A34A', bg:'#DCFCE7', color:'#16A34A', emoji:'✅' },
  'Not Interested':{ border:'#DC2626', bg:'#FEE2E2', color:'#DC2626', emoji:'🚫' },
  'DNC':           { border:'#7F1D1D', bg:'#FEF2F2', color:'#7F1D1D', emoji:'⛔' },
  'Bad Data':      { border:'#6B7280', bg:'#F3F4F6', color:'#6B7280', emoji:'🗑️' },
}

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
  const [mobileView, setMobileView] = useState('queue')
  const [powerDialActive, setPowerDialActive] = useState(false)
  const [celebration, setCelebration] = useState(null)
  const [queueCollapsed, setQueueCollapsed] = useState(true) // collapsed by default
  const [todayLogs, setTodayLogs] = useState([])
  const [activeTab, setActiveTab] = useState('script') // 'script' | 'history'
  const [notesVal, setNotesVal] = useState('')

  // Manual dialpad
  const [showDialpad, setShowDialpad] = useState(false)
  const [dialpadNumber, setDialpadNumber] = useState('')

  // Twilio Device
  const deviceRef = useRef(null)
  const callRef = useRef(null)
  const [twilioReady, setTwilioReady] = useState(false)
  const [callStatus, setCallStatus] = useState(null) // null | 'calling' | 'ringing' | 'connected' | 'ended'
  const [callDuration, setCallDuration] = useState(0)
  const callTimerRef = useRef(null)

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
      const aCb = isCallbackDueToday(a) && !isDone(a)
      const bCb = isCallbackDueToday(b) && !isDone(b)
      if (aCb && !bCb) return -1
      if (!aCb && bCb) return 1
      return 0
    })
  }, [contacts, search, campFilter, filter])

  const selectedContact = contacts.find(c => c.id === selectedId)
  const selectedIdx = filtered.findIndex(c => c.id === selectedId)

  useEffect(() => {
    if (!selectedId) return
    setLogsLoading(true)
    sb.from('call_logs').select('*').eq('contact_id', selectedId).order('created_at', { ascending: false })
      .then(({ data }) => { setContactLogs(data || []); setLogsLoading(false) })
  }, [selectedId])

  // Reset notes when contact changes
  useEffect(() => { setNotesVal('') }, [selectedId])

  // Load today's call logs for this rep
  useEffect(() => {
    if (!currentRep) return
    const today = new Date().toISOString().split('T')[0]
    sb.from('call_logs').select('*')
      .eq('rep', currentRep)
      .gte('created_at', today + 'T00:00:00')
      .lte('created_at', today + 'T23:59:59')
      .then(({ data }) => setTodayLogs(data || []))
  }, [currentRep])

  // Init Twilio Device using npm package
  useEffect(() => {
    if (!currentRep || currentRep === 'Unknown') return
    let device = null
    const init = async () => {
      try {
        const { Device } = await import('@twilio/voice-sdk')
        const res = await fetch('/api/twilio/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity: currentRep.replace(/[^a-zA-Z0-9_]/g, '_') })
        })
        const { token } = await res.json()
        if (!token) { console.error('No token returned'); return }
        device = new Device(token, { logLevel: 1, codecPreferences: ['opus', 'pcmu'] })
        device.on('registered', () => { console.log('Twilio ready'); setTwilioReady(true) })
        device.on('error', (err) => console.error('Twilio Device error:', err))
        device.on('incoming', (call) => {
          callRef.current = call
          setCallStatus('ringing')
          call.accept()
          setCallStatus('connected')
          startCallTimer()
          call.on('disconnect', () => { setCallStatus('ended'); stopCallTimer(); setTimeout(() => setCallStatus(null), 3000) })
        })
        await device.register()
        deviceRef.current = device
      } catch (err) {
        console.error('Twilio init error:', err)
      }
    }
    init()
    return () => {
      if (deviceRef.current) { deviceRef.current.destroy(); deviceRef.current = null }
      stopCallTimer()
    }
  }, [currentRep])

  const startCallTimer = () => {
    setCallDuration(0)
    callTimerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000)
  }
  const stopCallTimer = () => {
    if (callTimerRef.current) { clearInterval(callTimerRef.current); callTimerRef.current = null }
  }
  const fmtDuration = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`

  const makeCall = async (phoneNumber) => {
    if (!deviceRef.current || !twilioReady) {
      // Fallback to tel: link if Twilio not ready
      window.location.href = `tel:${phoneNumber}`
      return
    }
    try {
      const call = await deviceRef.current.connect({
        params: { To: phoneNumber, contactId: selectedId || '', contactName: c?.name || '' }
      })
      callRef.current = call
      setCallStatus('calling')
      call.on('ringing', () => setCallStatus('ringing'))
      call.on('accept', () => { setCallStatus('connected'); startCallTimer() })
      call.on('disconnect', () => { setCallStatus('ended'); stopCallTimer(); setTimeout(() => setCallStatus(null), 3000) })
      call.on('cancel', () => { setCallStatus(null); stopCallTimer() })
      call.on('error', (err) => { console.error('Call error:', err); setCallStatus(null); stopCallTimer() })
    } catch (err) {
      console.error('makeCall error:', err)
    }
  }

  const hangUp = () => {
    if (callRef.current) { callRef.current.disconnect(); callRef.current = null }
    setCallStatus(null)
    stopCallTimer()
  }

  const selectContact = (id) => {
    setSelectedId(id)
    setSelectedOutcome(null)
    setMobileView('contact')
    setActiveTab('script')
  }

  const navNextPending = () => {
    const cb = contacts.find(c => isCallbackDueToday(c) && !isDone(c) && !c.claimed_by)
    if (cb) { selectContact(cb.id); return }
    const next = contacts.find(c => (c.status || 'Pending') === 'Pending' && !c.claimed_by)
    if (next) selectContact(next.id)
    else alert('No unclaimed pending contacts!')
  }

  const claimContact = async (id) => {
    const alreadyClaimed = contacts.find(c => c.claimed_by === currentRep && c.id !== id)
    if (alreadyClaimed) {
      alert(`You already have ${alreadyClaimed.name} claimed. Log an outcome first.`); return
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

  const logOutcome = async (stay) => {
    if (!selectedOutcome || !selectedContact) return
    const c = selectedContact
    const notes = notesVal.trim()
    if (selectedOutcome === 'Booked' && !notes) { alert('Please add notes before booking.'); return }
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

      if (selectedOutcome === 'DNC' && c.phone) {
        const phone = normPhone(c.phone)
        const dupes = contacts.filter(x => x.id !== c.id && normPhone(x.phone || '') === phone)
        if (dupes.length) {
          await sb.from('contacts').update({ status: 'DNC' }).in('id', dupes.map(d => d.id))
          setContacts(prev => prev.map(x => dupes.some(d => d.id === x.id) ? { ...x, status: 'DNC', claimed_by: null } : x))
        }
      }

      if (selectedOutcome === 'Booked') {
        setCelebration({ rep: currentRep, contactName: c.name || 'a contact' })
        setTimeout(() => setCelebration(null), 5000)
        fetch('https://hooks.zapier.com/hooks/catch/25348607/4u2k7s2/', {
          method: 'POST',
          body: JSON.stringify({
            name: c.name || '', phone: c.phone || '', email: c.email || 'noemail@ahsdialer.com',
            address: c.address || '', city: c.city || '', state: c.state || '', zip: c.zip || '',
            campaign: campName(c) || '', rep: currentRep, booked_at: new Date().toISOString(),
            source: c.source || 'AHS Dialer', notes,
          })
        }).catch(err => console.warn('Zapier webhook failed:', err))
      }

      setSelectedOutcome(null)
      setNotesVal('')
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
  const camp = c ? campaigns.find(x => x.id === c.campaign_id) : null
  const myStats = {
    calls: todayLogs.length,
    booked: todayLogs.filter(x => x.outcome === 'Booked').length,
    callbacks: cbDue.length,
  }

  return (
    <div style={{ display:'flex', flex:1, overflow:'hidden', height:'100%', background:'var(--bg)' }}>

      {/* ── QUEUE SIDEBAR ── */}
      <aside style={{
        width: queueCollapsed ? 0 : 260, minWidth: queueCollapsed ? 0 : 260,
        flexShrink: 0, background:'var(--surface)', borderRight:'1px solid var(--border)',
        display:'flex', flexDirection:'column', overflow:'hidden',
        transition:'width .2s, min-width .2s',
      }}>
        {/* Sidebar header */}
        <div style={{ padding:'10px 12px 8px', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
            <span style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.8, color:'var(--text-muted)' }}>Queue</span>
            <span style={{ fontSize:11, color:'var(--text-muted)' }}>{filtered.length.toLocaleString()} / {contacts.length.toLocaleString()}</span>
          </div>
          <input
            style={{ width:'100%', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'5px 8px', fontSize:12, background:'var(--surface-2)', color:'var(--text-primary)' }}
            placeholder="Search..." value={search} onChange={e => { setSearch(e.target.value); setQueuePage(1) }}
          />
          {/* Filter pills */}
          <div style={{ display:'flex', gap:3, marginTop:6, flexWrap:'wrap' }}>
            {[
              { id:'active', label:'Active' },
              { id:'callback', label:'📅 CB' },
              { id:'no-answer', label:'No Ans' },
              { id:'voicemail', label:'VM' },
              { id:'done', label:'Done' },
              { id:'all', label:'All' },
            ].map(f => (
              <button key={f.id} onClick={() => { setFilter(f.id); setQueuePage(1) }}
                style={{ padding:'2px 7px', borderRadius:99, fontSize:10, fontWeight:500, border:'1px solid', cursor:'pointer',
                  borderColor: filter===f.id ? 'var(--accent)' : 'var(--border)',
                  background: filter===f.id ? 'var(--accent)' : 'transparent',
                  color: filter===f.id ? '#fff' : 'var(--text-muted)' }}>
                {f.label}
              </button>
            ))}
          </div>
          <select value={campFilter} onChange={e => setCampFilter(e.target.value)}
            style={{ width:'100%', marginTop:6, border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'4px 8px', fontSize:11, background:'var(--surface-2)', color:'var(--text-primary)' }}>
            <option value="">All campaigns</option>
            {campaigns.map(camp => <option key={camp.id} value={camp.id}>{camp.name}</option>)}
          </select>
        </div>

        {/* Callbacks due */}
        {cbDue.length > 0 && (
          <div style={{ background:'#FFFBEB', borderBottom:'2px solid #FCD34D', maxHeight:140, overflowY:'auto', flexShrink:0 }}>
            <div style={{ padding:'5px 12px', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.5, color:'#92400E' }}>
              Callbacks due ({cbDue.length})
            </div>
            {cbDue.map(cb => {
              const d = new Date(cb.callback_at); const overdue = d < new Date()
              return (
                <div key={cb.id} onClick={() => selectContact(cb.id)}
                  style={{ padding:'6px 12px', borderBottom:'1px solid #FDE68A', cursor:'pointer', background: overdue ? '#FEF2F2' : 'transparent' }}>
                  <div style={{ fontSize:10, fontWeight:600, color: overdue ? '#DC2626' : '#92400E' }}>
                    {overdue ? 'OVERDUE' : d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}
                  </div>
                  <div style={{ fontSize:12, fontWeight:500, color:'var(--text-primary)' }}>{cb.name}</div>
                </div>
              )
            })}
          </div>
        )}

        {/* Up Next — slim list, just next 8 */}
        <div style={{ flex:1, overflowY:'auto' }}>
          <div style={{ padding:'6px 12px 4px', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)' }}>
            Up next
          </div>
          {filtered.slice(0, 8).map((contact, idx) => {
            const attempts = contact.attempts || 0
            const isMyContact = contact.claimed_by === currentRep
            const active = contact.id === selectedId
            const hasCb = isCallbackDueToday(contact)
            return (
              <div key={contact.id} onClick={() => selectContact(contact.id)}
                style={{
                  padding:'8px 12px', borderBottom:'1px solid var(--border)', cursor:'pointer',
                  background: active ? 'var(--accent-bg)' : 'transparent',
                  borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent',
                }}>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <span style={{ fontSize:10, color:'var(--text-muted)', width:14, flexShrink:0 }}>{idx+1}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontWeight:600, fontSize:12, color: active ? 'var(--accent)' : 'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {hasCb && '📅 '}{contact.name || '—'}
                      {isMyContact && <span style={{ marginLeft:4, fontSize:9, background:'var(--accent)', color:'#fff', borderRadius:3, padding:'1px 4px' }}>You</span>}
                    </div>
                    <div style={{ fontSize:10, color:'var(--text-muted)' }}>{contact.phone || 'No phone'}</div>
                  </div>
                  <div style={{ display:'flex', gap:2, flexShrink:0 }}>
                    {Array.from({length:MAX_ATTEMPTS},(_,i)=>(
                      <div key={i} style={{width:4,height:4,borderRadius:'50%',background:i<attempts?'var(--accent)':'var(--border)'}}></div>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
          {filtered.length > 8 && (
            <div style={{ padding:'8px 12px', fontSize:11, color:'var(--text-muted)', textAlign:'center', borderTop:'1px solid var(--border)' }}>
              +{(filtered.length - 8).toLocaleString()} more in queue
            </div>
          )}
        </div>
      </aside>

      {/* ── MAIN WORKSPACE ── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>

        {/* Top bar */}
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 16px', background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
          {/* Toggle sidebar */}
          <button onClick={() => setQueueCollapsed(p => !p)}
            style={{ width:28, height:28, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, color:'var(--text-muted)', flexShrink:0 }}
            title={queueCollapsed ? 'Show queue' : 'Hide queue'}>
            {queueCollapsed ? '›' : '‹'}
          </button>

          {/* Nav */}
          <div style={{ display:'flex', gap:4 }}>
            <button className="btn sm" disabled={selectedIdx <= 0} onClick={() => { const prev = filtered[selectedIdx-1]; if(prev) selectContact(prev.id) }}>‹ Prev</button>
            <button className="btn sm" disabled={selectedIdx >= filtered.length-1} onClick={() => { const next = filtered[selectedIdx+1]; if(next) selectContact(next.id) }}>Next ›</button>
          </div>

          <button className="btn sm primary" onClick={navNextPending} style={{ fontWeight:600 }}>
            Next pending →
          </button>
          <button className="btn sm" onClick={() => setShowDialpad(true)} title="Manual dial any number"
            style={{ fontSize:16, padding:'4px 10px' }}>
            ⌨️
          </button>

          {/* Power dial */}
          {powerDialActive && (
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'4px 12px', background:'var(--accent)', borderRadius:'var(--radius)', color:'#fff', fontSize:12 }}>
              <span>⚡</span> <strong>Power Dial</strong>
              <button onClick={() => setPowerDialActive(false)} style={{ background:'rgba(255,255,255,.2)', border:'none', color:'#fff', padding:'2px 8px', borderRadius:4, cursor:'pointer', fontSize:11 }}>Stop</button>
            </div>
          )}

          {/* Spacer */}
          <div style={{ flex:1 }} />

          {/* My stats */}
          <div style={{ display:'flex', gap:12, fontSize:11, color:'var(--text-muted)' }}>
            <span>Calls: <strong style={{ color:'var(--text-primary)' }}>{myStats.calls}</strong></span>
            <span>Booked: <strong style={{ color:'#16A34A' }}>{myStats.booked}</strong></span>
            {myStats.callbacks > 0 && <span style={{ color:'#C87800' }}>Callbacks: <strong>{myStats.callbacks}</strong></span>}
          </div>

          {/* Live call status bar */}
          {callStatus && (
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'4px 12px', borderRadius:'var(--radius)', fontWeight:600, fontSize:12,
              background: callStatus === 'connected' ? '#DCFCE7' : callStatus === 'ended' ? '#F3F4F6' : '#FFF8E6',
              border: `1px solid ${callStatus === 'connected' ? '#16A34A' : callStatus === 'ended' ? '#D1D5DB' : '#C87800'}`,
              color: callStatus === 'connected' ? '#16A34A' : callStatus === 'ended' ? '#6B7280' : '#C87800' }}>
              <span style={{ width:8, height:8, borderRadius:'50%', background:'currentColor', display:'inline-block',
                animation: callStatus === 'connected' ? 'pulse 1.5s infinite' : 'none' }} />
              {callStatus === 'calling' && 'Calling...'}
              {callStatus === 'ringing' && 'Ringing...'}
              {callStatus === 'connected' && `Connected ${fmtDuration(callDuration)}`}
              {callStatus === 'ended' && 'Call ended'}
            </div>
          )}
          <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>

          {/* Attempt dots */}
          {c && (
            <div style={{ display:'flex', alignItems:'center', gap:4, padding:'4px 10px', background:'var(--surface-2)', borderRadius:'var(--radius)', border:'1px solid var(--border)' }}>
              <span style={{ fontSize:10, color:'var(--text-muted)' }}>Attempts</span>
              <div style={{ display:'flex', gap:3 }}>
                {Array.from({length:MAX_ATTEMPTS},(_,i)=>(
                  <div key={i} style={{width:7,height:7,borderRadius:'50%',background:i<(c.attempts||0)?'var(--accent)':'var(--border)'}}></div>
                ))}
              </div>
              <span style={{ fontSize:10, color:'var(--text-muted)' }}>{c.attempts||0}/{MAX_ATTEMPTS}</span>
            </div>
          )}
        </div>

        {/* ── IDLE STATE ── */}
        {!c && (
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:24, padding:40 }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, width:'100%', maxWidth:640 }}>
              {[
                { label:'My Calls Today', value: todayLogs.length, accent:'var(--accent)' },
                { label:'My Bookings Today', value: todayLogs.filter(x=>x.outcome==='Booked').length, accent:'#16A34A' },
                { label:'Booking Rate', value: todayLogs.length > 0 ? Math.round((todayLogs.filter(x=>x.outcome==='Booked').length / todayLogs.length) * 100) + '%' : '—', accent:'#7C3AED' },
                { label:'Callbacks Due', value: cbDue.length, accent:'#C87800', click:()=>setFilter('callback') },
              ].map(({ label, value, accent, click }) => (
                <div key={label} onClick={click}
                  style={{ background:'var(--surface)', border:'1px solid var(--border)', borderTop:`3px solid ${accent}`, borderRadius:'var(--radius)', padding:'14px 16px', cursor: click ? 'pointer' : 'default' }}>
                  <div style={{ fontSize:10, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:6 }}>{label}</div>
                  <div style={{ fontSize:26, fontWeight:700, color: accent }}>{value}</div>
                </div>
              ))}
            </div>
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:42, marginBottom:8 }}>📞</div>
              <div style={{ fontSize:16, fontWeight:600, color:'var(--text-primary)', marginBottom:4 }}>Ready to dial</div>
              <div style={{ fontSize:13, color:'var(--text-muted)', marginBottom:20 }}>Click a contact in the queue or hit Next pending to start</div>
              <button className="btn primary" style={{ padding:'10px 32px', fontSize:14, fontWeight:600 }} onClick={navNextPending}>
                Next pending →
              </button>
            </div>
          </div>
        )}

        {/* ── CONTACT WORKSPACE ── */}
        {c && (
          <div style={{ flex:1, overflowY:'auto', display:'grid', gridTemplateColumns:'1fr 320px', gridTemplateRows:'auto 1fr', gap:0 }}>

            {/* ── LEFT: Contact + Outcome ── */}
            <div style={{ padding:'16px 16px 16px 16px', display:'flex', flexDirection:'column', gap:12, overflowY:'auto', borderRight:'1px solid var(--border)' }}>

              {/* Warnings */}
              {isDNC && (
                <div style={{ background:'#FEF2F2', border:'1px solid #FECACA', borderRadius:'var(--radius)', padding:'8px 12px', fontSize:12, color:'#7F1D1D', display:'flex', alignItems:'center', gap:8, fontWeight:600 }}>
                  ⛔ DNC — Do not dial this number
                </div>
              )}
              {isDup && (
                <div style={{ background:'#F3E8FF', border:'1px solid #DDD6FE', borderRadius:'var(--radius)', padding:'8px 12px', fontSize:12, color:'#5B21B6', display:'flex', alignItems:'center', gap:8 }}>
                  ⚠ Duplicate number on multiple contacts
                </div>
              )}
              {c.callback_at && (
                <div style={{ background:'#FFFBEB', border:'1px solid #FCD34D', borderRadius:'var(--radius)', padding:'8px 12px', fontSize:12, color:'#92400E', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <span>📅 <strong>Callback:</strong> {fmtDate(c.callback_at)}{c.callback_note ? ' — ' + c.callback_note : ''}</span>
                  <button className="btn sm" onClick={() => clearCallback(c.id)}>Clear</button>
                </div>
              )}

              {/* ── CONTACT CARD ── */}
              <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                {/* Header */}
                <div style={{ padding:'16px 18px', display:'flex', alignItems:'flex-start', gap:14, borderBottom:'1px solid var(--border)' }}>
                  {/* Avatar */}
                  <div style={{ width:48, height:48, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent)', fontWeight:700, fontSize:16, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, border:'2px solid var(--accent)' }}>
                    {getInitials(c.name)}
                  </div>
                  {/* Name + address */}
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:18, fontWeight:700, color:'var(--text-primary)', lineHeight:1.2 }}>{c.name || '—'}</div>
                    <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:3 }}>
                      {[c.address, c.city, c.state, c.zip].filter(Boolean).join(', ') || 'No address'}
                    </div>
                    {camp && (
                      <span style={{ display:'inline-block', marginTop:6, padding:'2px 8px', borderRadius:4, fontSize:10, fontWeight:600, background:'var(--accent-bg)', color:'var(--accent)' }}>
                        {camp.name}
                      </span>
                    )}
                  </div>
                  {/* Phone + actions */}
                  <div style={{ textAlign:'right', flexShrink:0 }}>
                    <a href={`tel:${c.phone}`}
                      style={{ display:'block', fontSize:20, fontWeight:700, color:'var(--accent)', textDecoration:'none', letterSpacing:-.3, lineHeight:1.2 }}>
                      {c.phone || 'No phone'}
                    </a>
                    <div style={{ display:'flex', gap:6, marginTop:6, justifyContent:'flex-end' }}>
                      {c.phone && (
                        <button className="btn sm" onClick={() => navigator.clipboard.writeText(c.phone)}>Copy</button>
                      )}
                      {callStatus && callRef.current ? (
                        <button className="btn sm" style={{ background:'#DC2626', borderColor:'#DC2626', color:'#fff', fontWeight:600 }}
                          onClick={hangUp}>
                          ⏹ Hang up
                        </button>
                      ) : (
                        <button className="btn sm primary" style={{ fontWeight:600 }}
                          onClick={() => makeCall(c.phone)}
                          disabled={!c.phone}>
                          📞 {twilioReady ? 'Call' : 'Call (loading...)'}
                        </button>
                      )}
                    </div>
                    {c.email && <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:4 }}>{c.email}</div>}
                  </div>
                </div>

                {/* Claim bar */}
                {done ? (
                  <div style={{ padding:'8px 18px', background:'#DCFCE7', fontSize:12, color:'#16A34A', fontWeight:600 }}>
                    ✓ Complete — {c.status}
                  </div>
                ) : !c.claimed_by ? (
                  <div style={{ padding:'8px 18px', display:'flex', alignItems:'center', justifyContent:'space-between', background:'var(--surface-2)' }}>
                    <span style={{ fontSize:12, color:'var(--text-muted)' }}>Unclaimed</span>
                    <button className="btn sm primary" onClick={() => claimContact(c.id)}>Claim & call</button>
                  </div>
                ) : isMe ? (
                  <div style={{ padding:'8px 18px', display:'flex', alignItems:'center', justifyContent:'space-between', background:'var(--accent-bg)' }}>
                    <span style={{ fontSize:12, color:'var(--accent)', fontWeight:600 }}>✓ Claimed by you</span>
                    <button className="btn sm" onClick={() => releaseContact(c.id)}>Release</button>
                  </div>
                ) : (
                  <div style={{ padding:'8px 18px', background:'#FFFBEB', fontSize:12, color:'#92400E', fontWeight:500 }}>
                    ⚠ Claimed by <strong>{c.claimed_by}</strong>
                  </div>
                )}

                {/* Meta row */}
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', borderTop:'1px solid var(--border)' }}>
                  {[
                    { label:'Status', value: <Badge status={c.status || 'Pending'} /> },
                    { label:'Source', value: c.source || '—' },
                    { label:'Ext. ID', value: c.external_id || '—' },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ padding:'8px 14px', borderRight:'1px solid var(--border)' }}>
                      <div style={{ fontSize:9, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:2 }}>{label}</div>
                      <div style={{ fontSize:12, color:'var(--text-primary)' }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── OUTCOME LOGGER ── */}
              {!done && (
                <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                  <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                    <span style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)' }}>Log outcome</span>
                    {!isMe && c.claimed_by && (
                      <span style={{ fontSize:11, color:'var(--text-muted)' }}>Claimed by {c.claimed_by}</span>
                    )}
                  </div>
                  <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:10 }}>
                    {/* Outcome buttons */}
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
                      {OUTCOMES.map(o => {
                        const sel = selectedOutcome === o.id
                        const cm = OUTCOME_CONFIG[o.id] || {}
                        return (
                          <button key={o.id} disabled={!isMe} onClick={() => setSelectedOutcome(sel ? null : o.id)}
                            style={{
                              padding:'10px 6px', borderRadius:'var(--radius)', fontSize:12, fontWeight: sel ? 700 : 500,
                              border: sel ? `2px solid ${cm.border}` : '1.5px solid var(--border)',
                              background: sel ? cm.bg : 'var(--surface-2)', color: sel ? cm.color : 'var(--text-secondary)',
                              cursor: isMe ? 'pointer' : 'not-allowed', opacity: isMe ? 1 : .4,
                              textAlign:'center', transition:'all .1s', lineHeight:1.4,
                              transform: sel ? 'scale(1.02)' : 'scale(1)',
                            }}>
                            <div style={{ fontSize:16 }}>{cm.emoji}</div>
                            <div style={{ fontSize:11 }}>{o.id}</div>
                          </button>
                        )
                      })}
                    </div>

                    {/* Notes */}
                    <textarea
                      value={notesVal} onChange={e => setNotesVal(e.target.value)}
                      disabled={!isMe} placeholder={selectedOutcome === 'Booked' ? 'Notes required before booking...' : 'Add notes...'}
                      style={{ width:'100%', border:`1px solid ${selectedOutcome === 'Booked' ? 'var(--accent)' : 'var(--border)'}`, borderRadius:'var(--radius)', padding:'8px 10px', fontSize:12, fontFamily:'inherit', resize:'vertical', minHeight:60, background:'var(--surface-2)', color:'var(--text-primary)', opacity: isMe ? 1 : .4 }}
                    />

                    {/* Actions */}
                    <div style={{ display:'flex', gap:6, justifyContent:'space-between', flexWrap:'wrap' }}>
                      <button className="btn sm warning" disabled={!isMe} onClick={openCallbackModal}>
                        📅 Schedule callback
                      </button>
                      <div style={{ display:'flex', gap:6 }}>
                        <button className="btn sm" disabled={!isMe || !selectedOutcome || saving} onClick={() => logOutcome(true)}>
                          {saving ? 'Saving...' : 'Log & stay'}
                        </button>
                        <button className="btn sm success" disabled={!isMe || !selectedOutcome || saving} onClick={() => logOutcome(false)}
                          style={{ background:'#16A34A', borderColor:'#16A34A', color:'#fff', fontWeight:600 }}>
                          {saving ? 'Saving...' : 'Log & next →'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {done && (
                <div style={{ background:'#DCFCE7', border:'1px solid #BBF7D0', borderRadius:'var(--radius)', padding:'12px 16px', fontSize:13, color:'#15803D', fontWeight:500 }}>
                  ✓ Contact complete — {c.status}
                </div>
              )}
            </div>

            {/* ── RIGHT PANEL: Script / History ── */}
            <div style={{ display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--surface-2)' }}>
              {/* Tabs */}
              <div style={{ display:'flex', borderBottom:'1px solid var(--border)', flexShrink:0, background:'var(--surface)' }}>
                {['script', 'history'].map(t => (
                  <button key={t} onClick={() => setActiveTab(t)}
                    style={{ flex:1, padding:'10px 0', fontSize:12, fontWeight: activeTab===t ? 600 : 400, border:'none', cursor:'pointer',
                      background: activeTab===t ? 'var(--surface-2)' : 'var(--surface)',
                      color: activeTab===t ? 'var(--accent)' : 'var(--text-muted)',
                      borderBottom: activeTab===t ? '2px solid var(--accent)' : '2px solid transparent' }}>
                    {t === 'script' ? '📜 Script' : `📋 History (${contactLogs.length})`}
                  </button>
                ))}
              </div>

              <div style={{ flex:1, overflowY:'auto', padding:14 }}>
                {/* Script tab */}
                {activeTab === 'script' && (
                  <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                    {camp?.script ? (
                      <div>
                        <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:6 }}>Call Script</div>
                        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderLeft:'3px solid var(--accent)', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:13, lineHeight:1.8, whiteSpace:'pre-wrap', color:'var(--text-primary)' }}>
                          {camp.script}
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize:12, color:'var(--text-muted)', fontStyle:'italic' }}>No script set for this campaign.</div>
                    )}
                    {camp?.tips && (
                      <div>
                        <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:6 }}>Tips & Talking Points</div>
                        <div style={{ background:'#FFFBEB', border:'1px solid #FCD34D', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:13, lineHeight:1.8, whiteSpace:'pre-wrap', color:'#78350F' }}>
                          {camp.tips}
                        </div>
                      </div>
                    )}
                    {/* Open in ST button */}
                    <div style={{ marginTop:8, paddingTop:12, borderTop:'1px solid var(--border)' }}>
                      <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:8 }}>ServiceTitan</div>
                      <button
                        onClick={() => {
                          const name = encodeURIComponent(c.name || '')
                          const phone = encodeURIComponent(c.phone || '')
                          window.open(`https://go.servicetitan.com/#/Dispatch/Booking?customerName=${name}&phone=${phone}`, '_blank')
                        }}
                        style={{ width:'100%', padding:'9px 0', border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface)', cursor:'pointer', fontSize:12, fontWeight:600, color:'var(--text-primary)', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}
                        onMouseEnter={e => e.currentTarget.style.background='var(--accent-bg)'}
                        onMouseLeave={e => e.currentTarget.style.background='var(--surface)'}>
                        Open in ServiceTitan →
                      </button>
                    </div>
                  </div>
                )}

                {/* History tab */}
                {activeTab === 'history' && (
                  <div>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                      <span style={{ fontSize:11, color:'var(--text-muted)' }}>{contactLogs.length} attempt{contactLogs.length !== 1 ? 's' : ''}</span>
                      {contactLogs.length > 0 && (
                        <button className="btn sm" onClick={openCorrectModal}>✏️ Correct last</button>
                      )}
                    </div>
                    {logsLoading ? (
                      <div className="spinner" style={{ margin:'20px auto' }} />
                    ) : contactLogs.length === 0 ? (
                      <div style={{ fontSize:12, color:'var(--text-muted)', fontStyle:'italic', textAlign:'center', marginTop:20 }}>No attempts yet</div>
                    ) : (
                      contactLogs.map(l => (
                        <div key={l.id} style={{ padding:'10px 12px', marginBottom:8, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', borderLeft:`3px solid ${OUTCOME_CONFIG[l.outcome]?.border || 'var(--border)'}` }}>
                          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
                            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                              <span style={{ fontSize:14 }}>{OUTCOME_CONFIG[l.outcome]?.emoji || '•'}</span>
                              <span style={{ fontSize:12, fontWeight:600, color: OUTCOME_CONFIG[l.outcome]?.color || 'var(--text-primary)' }}>{l.outcome}</span>
                            </div>
                            <span style={{ fontSize:10, color:'var(--text-muted)' }}>{fmtShort(l.created_at)}</span>
                          </div>
                          <div style={{ fontSize:10, color:'var(--text-muted)', marginBottom: l.notes ? 4 : 0 }}>{l.rep}</div>
                          {l.notes && <div style={{ fontSize:11, color:'var(--text-secondary)', lineHeight:1.5 }}>{l.notes}</div>}
                          {l.correction && <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:3 }}>✏️ Corrected from {l.correction}</div>}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>

          </div>
        )}
      </div>

      {/* ── DIALPAD MODAL ── */}
      {showDialpad && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowDialpad(false) }}>
          <div style={{ background:'var(--surface)', borderRadius:16, padding:28, width:280, boxShadow:'0 8px 40px rgba(0,0,0,.3)' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
              <span style={{ fontSize:14, fontWeight:700, color:'var(--text-primary)' }}>Manual Dial</span>
              <button onClick={() => setShowDialpad(false)} style={{ background:'none', border:'none', fontSize:18, cursor:'pointer', color:'var(--text-muted)' }}>×</button>
            </div>
            {/* Number display */}
            <div style={{ background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'10px 14px', fontSize:20, fontWeight:600, letterSpacing:2, textAlign:'center', marginBottom:16, minHeight:48, color:'var(--text-primary)' }}>
              {dialpadNumber || <span style={{ color:'var(--text-muted)', fontSize:14, fontWeight:400 }}>Enter number</span>}
            </div>
            {/* Keypad */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:16 }}>
              {['1','2','3','4','5','6','7','8','9','*','0','#'].map(k => (
                <button key={k} onClick={() => setDialpadNumber(p => p.length < 15 ? p + k : p)}
                  style={{ padding:'14px 0', fontSize:18, fontWeight:600, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', color:'var(--text-primary)' }}
                  onMouseEnter={e => e.currentTarget.style.background='var(--accent-bg)'}
                  onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>
                  {k}
                </button>
              ))}
            </div>
            {/* Actions */}
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={() => setDialpadNumber(p => p.slice(0,-1))}
                style={{ flex:1, padding:'10px 0', border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-muted)' }}>
                ⌫
              </button>
              {callStatus && callRef.current ? (
                <button onClick={() => { hangUp(); }}
                  style={{ flex:2, padding:'10px 0', border:'none', borderRadius:'var(--radius)', background:'#DC2626', cursor:'pointer', fontSize:14, fontWeight:700, color:'#fff' }}>
                  ⏹ Hang up
                </button>
              ) : (
                <button onClick={() => { if (dialpadNumber.length >= 10) { makeCall(dialpadNumber); } }}
                  disabled={dialpadNumber.length < 10}
                  style={{ flex:2, padding:'10px 0', border:'none', borderRadius:'var(--radius)', background: dialpadNumber.length >= 10 ? '#16A34A' : 'var(--border)', cursor: dialpadNumber.length >= 10 ? 'pointer' : 'not-allowed', fontSize:16, fontWeight:700, color:'#fff' }}>
                  📞 Call
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── WIN CELEBRATION ── */}
      {celebration && (
        <>
          <style>{`@keyframes fall{0%{transform:translateY(0) rotate(0deg);opacity:1}100%{transform:translateY(100vh) rotate(720deg);opacity:0}} @keyframes popIn{0%{transform:translate(-50%,-50%) scale(0.5);opacity:0}70%{transform:translate(-50%,-50%) scale(1.05);opacity:1}100%{transform:translate(-50%,-50%) scale(1);opacity:1}}`}</style>
          {Array.from({length:60},(_,i)=>(
            <div key={i} style={{position:'fixed',borderRadius:3,left:`${Math.random()*100}%`,top:`-${Math.random()*20+10}px`,width:`${Math.random()*10+6}px`,height:`${Math.random()*10+6}px`,background:['#1A5C8A','#2E7D52','#FFC107','#E91E63','#9C27B0','#FF5722','#00BCD4'][Math.floor(Math.random()*7)],animation:`fall ${Math.random()*1.5+2}s ease-in ${Math.random()*1.5}s forwards`,pointerEvents:'none',zIndex:9999}}/>
          ))}
          <div style={{position:'fixed',top:'50%',left:'50%',zIndex:10000,animation:'popIn 0.5s cubic-bezier(0.175,0.885,0.32,1.275) forwards',background:'white',borderRadius:20,padding:'40px 48px',boxShadow:'0 20px 60px rgba(0,0,0,.3)',textAlign:'center',border:'3px solid #16A34A',minWidth:340}}>
            <div style={{fontSize:64,marginBottom:8}}>🎉</div>
            <div style={{fontSize:28,fontWeight:800,color:'#16A34A',marginBottom:6}}>BOOKED!</div>
            <div style={{fontSize:18,fontWeight:600,color:'#1C1B19',marginBottom:4}}>{celebration.contactName}</div>
            <div style={{fontSize:14,color:'#6B6760'}}>{celebration.rep} just closed one! 🔥</div>
            <button onClick={()=>setCelebration(null)} style={{marginTop:20,padding:'8px 24px',background:'#16A34A',color:'white',border:'none',borderRadius:8,cursor:'pointer',fontSize:13,fontWeight:600}}>Let's go! 💪</button>
          </div>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.4)',zIndex:9998}} onClick={()=>setCelebration(null)}/>
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
            <input className="form-input" placeholder="e.g. Mis-clicked, meant Booked" value={correctNote} onChange={e=>setCorrectNote(e.target.value)} />
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
