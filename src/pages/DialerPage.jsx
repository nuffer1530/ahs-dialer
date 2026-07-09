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
  'No Answer':      { border:'#C87800', bg:'#FFF8E6', color:'#C87800', emoji:'📵' },
  'Voicemail':      { border:'#7C3AED', bg:'#F3E8FF', color:'#7C3AED', emoji:'📬' },
  'Booked':         { border:'#16A34A', bg:'#DCFCE7', color:'#16A34A', emoji:'✅' },
  'Not Interested': { border:'#DC2626', bg:'#FEE2E2', color:'#DC2626', emoji:'🚫' },
  'DNC':            { border:'#7F1D1D', bg:'#FEF2F2', color:'#7F1D1D', emoji:'⛔' },
  'Bad Data':       { border:'#6B7280', bg:'#F3F4F6', color:'#6B7280', emoji:'🗑️' },
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
  const [queueCollapsed, setQueueCollapsed] = useState(true)
  const [todayLogs, setTodayLogs] = useState([])
  const [activeTab, setActiveTab] = useState('script')
  const [notesVal, setNotesVal] = useState('')

  // Manual dialpad
  const [showDialpad, setShowDialpad] = useState(false)
  const [dialpadNumber, setDialpadNumber] = useState('')

  // Twilio Device
  const deviceRef = useRef(null)
  const callRef = useRef(null)
  const [twilioReady, setTwilioReady] = useState(false)
  const [callStatus, setCallStatus] = useState(null)
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

  useEffect(() => { setNotesVal('') }, [selectedId])

  useEffect(() => {
    if (!currentRep) return
    const today = new Date().toISOString().split('T')[0]
    sb.from('call_logs').select('*')
      .eq('rep', currentRep)
      .gte('created_at', today + 'T00:00:00')
      .lte('created_at', today + 'T23:59:59')
      .then(({ data }) => setTodayLogs(data || []))
  }, [currentRep])

  // Init Twilio Device
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
          updateAgentStatus('On Call')
          call.on('disconnect', () => { setCallStatus('ended'); stopCallTimer(); setTimeout(() => setCallStatus(null), 3000); updateAgentStatus('Wrap Up') })
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

  const updateAgentStatus = async (status) => {
    if (!profile?.id) return
    await sb.from('profiles').update({ status, status_since: new Date().toISOString() }).eq('id', profile.id)
  }

  const makeCall = async (number) => {
    if (!deviceRef.current) { alert('Twilio not ready yet'); return }
    try {
      const params = { To: number, identity: currentRep.replace(/[^a-zA-Z0-9_]/g, '_'), contactId: selectedId || '', contactName: selectedContact?.name || '' }
      const call = await deviceRef.current.connect({ params })
      callRef.current = call
      setCallStatus('calling')
      updateAgentStatus('On Call')
      call.on('ringing', () => setCallStatus('ringing'))
      call.on('accept', () => { setCallStatus('connected'); startCallTimer() })
      call.on('disconnect', () => { setCallStatus('ended'); stopCallTimer(); setTimeout(() => setCallStatus(null), 3000); updateAgentStatus('Wrap Up') })
      call.on('error', (err) => { console.error('Call error:', err); setCallStatus('ended'); stopCallTimer(); setTimeout(() => setCallStatus(null), 2000) })
    } catch (err) {
      console.error('makeCall error:', err)
      setCallStatus(null)
    }
  }

  const hangUp = () => {
    if (callRef.current) { callRef.current.disconnect(); callRef.current = null }
    setCallStatus('ended')
    stopCallTimer()
    setTimeout(() => setCallStatus(null), 2000)
    updateAgentStatus('Wrap Up')
  }

  const selectContact = (id) => {
    setSelectedId(id)
    setSelectedOutcome(null)
    setMobileView('detail')
  }

  const navNextPending = () => {
    const next = filtered.find(x => !isDone(x) && x.status !== 'Max Attempts' && !x.claimed_by)
    if (next) selectContact(next.id)
  }

  const claimContact = async () => {
    if (!selectedContact || selectedContact.claimed_by) return
    const { data } = await sb.from('contacts').update({ claimed_by: currentRep, claimed_at: new Date().toISOString() }).eq('id', selectedId).select().single()
    if (data) setContacts(prev => prev.map(c => c.id === selectedId ? data : c))
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
      updateAgentStatus('Available')
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

  const openInServiceTitan = (contact) => {
    if (contact.external_id) {
      window.open(`https://go.servicetitan.com/#/Customer/Index/${contact.external_id}`, '_blank')
    } else {
      const name = encodeURIComponent(contact.name || '')
      const phone = encodeURIComponent(contact.phone || '')
      window.open(`https://go.servicetitan.com/#/Customer/Index?name=${name}&phone=${phone}`, '_blank')
    }
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
        <div style={{ padding:'10px 12px 8px', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
            <span style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.8, color:'var(--text-muted)' }}>Queue</span>
            <span style={{ fontSize:11, color:'var(--text-muted)' }}>{filtered.length.toLocaleString()} / {contacts.length.toLocaleString()}</span>
          </div>
          <input
            style={{ width:'100%', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'5px 8px', fontSize:12, background:'var(--surface-2)', color:'var(--text-primary)' }}
            placeholder="Search..." value={search} onChange={e => { setSearch(e.target.value); setQueuePage(1) }}
          />
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
            style={{ width:'100%', marginTop:6, border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'4px 6px', fontSize:11, background:'var(--surface-2)', color:'var(--text-primary)' }}>
            <option value="">All campaigns</option>
            {campaigns.map(camp => <option key={camp.id} value={camp.id}>{camp.name}</option>)}
          </select>
        </div>

        <div style={{ flex:1, overflowY:'auto' }}>
          {filtered.slice(0, PAGE_SIZE).map((contact, idx) => {
            const active = contact.id === selectedId
            const hasCb = isCallbackDueToday(contact) && !isDone(contact)
            const attempts = contact.attempts || 0
            const isMyContact = contact.claimed_by === currentRep
            return (
              <div key={contact.id} onClick={() => selectContact(contact.id)}
                style={{ padding:'8px 12px', cursor:'pointer', borderBottom:'1px solid var(--border)',
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
          {filtered.length > PAGE_SIZE && (
            <div style={{ padding:'8px 12px', fontSize:11, color:'var(--text-muted)', textAlign:'center', borderTop:'1px solid var(--border)' }}>
              +{(filtered.length - PAGE_SIZE).toLocaleString()} more in queue
            </div>
          )}
        </div>
      </aside>

      {/* ── MAIN WORKSPACE ── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>

        {/* Top bar */}
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 16px', background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
          <button onClick={() => setQueueCollapsed(p => !p)}
            style={{ width:28, height:28, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, color:'var(--text-muted)', flexShrink:0 }}
            title={queueCollapsed ? 'Show queue' : 'Hide queue'}>
            {queueCollapsed ? '›' : '‹'}
          </button>

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

          {powerDialActive && (
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'4px 12px', background:'var(--accent)', borderRadius:'var(--radius)', color:'#fff', fontSize:12 }}>
              <span>⚡</span> <strong>Power Dial</strong>
              <button onClick={() => setPowerDialActive(false)} style={{ background:'rgba(255,255,255,.2)', border:'none', color:'#fff', padding:'2px 8px', borderRadius:4, cursor:'pointer', fontSize:11 }}>Stop</button>
            </div>
          )}

          <div style={{ flex:1 }} />

          <div style={{ display:'flex', gap:12, fontSize:11, color:'var(--text-muted)' }}>
            <span>Calls: <strong style={{ color:'var(--text-primary)' }}>{myStats.calls}</strong></span>
            <span>Booked: <strong style={{ color:'#16A34A' }}>{myStats.booked}</strong></span>
            {myStats.callbacks > 0 && <span style={{ color:'#C87800' }}>Callbacks: <strong>{myStats.callbacks}</strong></span>}
          </div>

          {callStatus && (
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'4px 12px', borderRadius:'var(--radius)', fontWeight:600, fontSize:12,
              background: callStatus === 'connected' ? '#DCFCE7' : callStatus === 'ended' ? '#F3F4F6' : '#FFF8E6',
              border: `1px solid ${callStatus === 'connected' ? '#16A34A' : callStatus === 'ended' ? '#D1D5DB' : '#C87800'}`,
              color: callStatus === 'connected' ? '#16A34A' : callStatus === 'ended' ? '#6B7280' : '#C87800' }}>
              <span style={{ width:8, height:8, borderRadius:'50%', background:'currentColor', display:'inline-block',
                animation: callStatus === 'connected' ? 'pulse 1.5s infinite' : 'none' }}></span>
              {callStatus === 'calling' ? 'Dialing...' : callStatus === 'ringing' ? 'Ringing...' : callStatus === 'connected' ? `Connected ${fmtDuration(callDuration)}` : 'Call ended'}
              {(callStatus === 'calling' || callStatus === 'ringing' || callStatus === 'connected') && (
                <button onClick={hangUp} style={{ background:'#DC2626', border:'none', color:'#fff', padding:'2px 8px', borderRadius:4, cursor:'pointer', fontSize:11, marginLeft:4 }}>Hang up</button>
              )}
            </div>
          )}
        </div>

        {/* ── EMPTY STATE ── */}
        {!c && (
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:24, padding:32 }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:12, width:'100%', maxWidth:480 }}>
              {[
                { label:'Calls Today', value: myStats.calls, accent:'var(--accent)' },
                { label:'Booked Today', value: myStats.booked, accent:'#16A34A' },
                { label:'Booking Rate', value: todayLogs.length ? Math.round((todayLogs.filter(x=>x.outcome==='Booked').length / todayLogs.length) * 100) + '%' : '—', accent:'#7C3AED' },
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
            <div style={{ padding:'16px', display:'flex', flexDirection:'column', gap:12, overflowY:'auto', borderRight:'1px solid var(--border)' }}>

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
                  <span>📅 <strong>Callback:</strong> {fmtDate(c.callback_at)}{c.callback_note ? ` — ${c.callback_note}` : ''}</span>
                  <button className="btn sm" onClick={() => clearCallback(c.id)} style={{ fontSize:10 }}>Clear</button>
                </div>
              )}

              {/* Contact card */}
              <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <div style={{ width:36, height:36, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:700, flexShrink:0 }}>
                      {getInitials(c.name)}
                    </div>
                    <div>
                      <div style={{ fontSize:15, fontWeight:700, color:'var(--text-primary)' }}>{c.name || '—'}</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)' }}>{campName(c) || 'No campaign'}</div>
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                    <Badge status={c.status || 'Pending'} />
                    {!c.claimed_by && !done && (
                      <button className="btn sm primary" onClick={claimContact}>Claim</button>
                    )}
                    {isMe && !done && (
                      <button className="btn sm" onClick={() => releaseContact(c.id)}>Release</button>
                    )}
                    {isOther && (
                      <span style={{ fontSize:11, color:'var(--text-muted)' }}>Claimed by {c.claimed_by}</span>
                    )}
                  </div>
                </div>

                {/* Contact details grid */}
                <div style={{ display:'flex', flexWrap:'wrap', borderBottom:'1px solid var(--border)' }}>
                  {[
                    { label:'Phone', value: c.phone || '—' },
                    { label:'Email', value: c.email || '—' },
                    { label:'Address', value: [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ') || '—' },
                    { label:'Source', value: c.source || '—' },
                    { label:'Attempts', value: `${c.attempts || 0} / ${MAX_ATTEMPTS}` },
                    { label:'ST Customer ID', value: c.external_id || '—' },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ padding:'8px 14px', borderRight:'1px solid var(--border)', minWidth:'33%' }}>
                      <div style={{ fontSize:9, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:2 }}>{label}</div>
                      <div style={{ fontSize:12, color:'var(--text-primary)' }}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Action buttons */}
                <div style={{ padding:'10px 14px', display:'flex', gap:8 }}>
                  {c.phone && (
                    <button
                      onClick={() => makeCall(c.phone)}
                      disabled={!twilioReady || !!callStatus}
                      style={{ flex:1, padding:'8px 0', border:'none', borderRadius:'var(--radius)', background: twilioReady && !callStatus ? '#16A34A' : 'var(--border)', cursor: twilioReady && !callStatus ? 'pointer' : 'not-allowed', fontSize:13, fontWeight:700, color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
                      📞 {callStatus ? 'On call...' : 'Call'}
                    </button>
                  )}
                  {/* ── OPEN IN SERVICETITAN BUTTON ── */}
                  <button
                    onClick={() => openInServiceTitan(c)}
                    style={{ flex:1, padding:'8px 0', border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface)', cursor:'pointer', fontSize:12, fontWeight:600, color:'var(--text-primary)', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}
                    onMouseEnter={e => e.currentTarget.style.background='var(--accent-bg)'}
                    onMouseLeave={e => e.currentTarget.style.background='var(--surface)'}>
                    {c.external_id ? '🔗 Open in ST' : '🔍 Search in ST'}
                  </button>
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

                    <textarea
                      value={notesVal} onChange={e => setNotesVal(e.target.value)}
                      disabled={!isMe} placeholder={selectedOutcome === 'Booked' ? 'Notes required before booking...' : 'Add notes...'}
                      style={{ width:'100%', border:`1px solid ${selectedOutcome === 'Booked' ? 'var(--accent)' : 'var(--border)'}`, borderRadius:'var(--radius)', padding:'8px 10px', fontSize:12, fontFamily:'inherit', resize:'vertical', minHeight:60, background:'var(--surface-2)', color:'var(--text-primary)', opacity: isMe ? 1 : .4 }}
                    />

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
              <div style={{ display:'flex', borderBottom:'1px solid var(--border)', flexShrink:0, background:'var(--surface)' }}>
                {['script', 'history'].map(t => (
                  <button key={t} onClick={() => setActiveTab(t)}
                    style={{ flex:1, padding:'10px 0', fontSize:12, fontWeight: activeTab===t ? 600 : 400, border:'none',
                      cursor:'pointer',
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
                          {l.notes && <div style={{ fontSize:11, color:'var(--text-secondary)', marginTop:2, lineHeight:1.5 }}>{l.notes}</div>}
                          <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:4 }}>by {l.rep}</div>
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

      {/* ── CALLBACK MODAL ── */}
      {showCallbackModal && (
        <Modal title="Schedule Callback" onClose={() => setShowCallbackModal(false)} width={360}>
          <div className="form-field">
            <label className="form-label">Date</label>
            <input className="form-input" type="date" value={cbDate} onChange={e => setCbDate(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-label">Time</label>
            <input className="form-input" type="time" value={cbTime} onChange={e => setCbTime(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-label">Note</label>
            <input className="form-input" value={cbNote} onChange={e => setCbNote(e.target.value)} placeholder="Optional note..." />
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setShowCallbackModal(false)}>Cancel</button>
            <button className="btn primary" onClick={saveCallback}>Save callback</button>
          </div>
        </Modal>
      )}

      {/* ── CORRECT MODAL ── */}
      {showCorrectModal && (
        <Modal title="Correct Last Outcome" onClose={() => setShowCorrectModal(false)} width={360}>
          <div className="form-field">
            <label className="form-label">New outcome</label>
            <select className="form-input" value={correctOutcome} onChange={e => setCorrectOutcome(e.target.value)}>
              {OUTCOMES.map(o => <option key={o.id} value={o.id}>{o.id}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label className="form-label">Correction note</label>
            <input className="form-input" value={correctNote} onChange={e => setCorrectNote(e.target.value)} placeholder="Why the correction?" />
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setShowCorrectModal(false)}>Cancel</button>
            <button className="btn primary" onClick={applyCorrection}>Apply correction</button>
          </div>
        </Modal>
      )}

      {/* ── DIALPAD MODAL ── */}
      {showDialpad && (
        <Modal title="Manual Dial" onClose={() => { setShowDialpad(false); setDialpadNumber('') }} width={280}>
          <div style={{ textAlign:'center', marginBottom:12 }}>
            <div style={{ fontSize:22, fontWeight:600, letterSpacing:3, color:'var(--text-primary)', minHeight:34, padding:'4px 0', borderBottom:'2px solid var(--accent)' }}>
              {dialpadNumber || ' '}
            </div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:12 }}>
            {['1','2','3','4','5','6','7','8','9','*','0','#'].map(k => (
              <button key={k} onClick={() => setDialpadNumber(p => p + k)}
                style={{ padding:'14px 0', fontSize:18, fontWeight:600, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', color:'var(--text-primary)' }}
                onMouseEnter={e => e.currentTarget.style.background='var(--accent-bg)'}
                onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>
                {k}
              </button>
            ))}
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={() => setDialpadNumber(p => p.slice(0,-1))}
              style={{ flex:1, padding:'10px 0', border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-muted)' }}>
              ⌫
            </button>
            {callStatus && callRef.current ? (
              <button onClick={hangUp}
                style={{ flex:2, padding:'10px 0', border:'none', borderRadius:'var(--radius)', background:'#DC2626', cursor:'pointer', fontSize:14, fontWeight:700, color:'#fff' }}>
                ⏹ Hang up
              </button>
            ) : (
              <button onClick={() => { if (dialpadNumber.length >= 10) { makeCall(dialpadNumber); setShowDialpad(false) } }}
                disabled={dialpadNumber.length < 10}
                style={{ flex:2, padding:'10px 0', border:'none', borderRadius:'var(--radius)', background: dialpadNumber.length >= 10 ? '#16A34A' : 'var(--border)', cursor: dialpadNumber.length >= 10 ? 'pointer' : 'not-allowed', fontSize:14, fontWeight:700, color:'#fff' }}>
                📞 Call
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
