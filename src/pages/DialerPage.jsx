import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useData } from '../lib/DataContext'
import { useAuth } from '../lib/AuthContext'
import { sb } from '../lib/supabase'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import { isDone, isCallbackDueToday, getDupSet, normPhone, getInitials, fmtDate, fmtShort } from '../lib/utils'
import { OUTCOMES, MAX_ATTEMPTS, DONE_OUTCOMES } from '../lib/constants'

const PAGE_SIZE = 50

const OUTCOME_ICONS = {
  'No Answer': (color) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z" fill={color}/>
      <line x1="18" y1="6" x2="6" y2="18" stroke={color} strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
  'Voicemail': (color) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="7" cy="13" r="3" stroke={color} strokeWidth="1.8" fill="none"/>
      <circle cx="17" cy="13" r="3" stroke={color} strokeWidth="1.8" fill="none"/>
      <path d="M7 16h10M4 16h2M18 16h2" stroke={color} strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M12 7v4" stroke={color} strokeWidth="1.8" strokeLinecap="round"/>
      <circle cx="12" cy="5" r="1.5" fill={color}/>
    </svg>
  ),
  'Booked': (color) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4" width="18" height="17" rx="2" stroke={color} strokeWidth="1.8" fill="none"/>
      <path d="M16 2v4M8 2v4M3 10h18" stroke={color} strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M8 15l3 3 5-5" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  'Not Interested': (color) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.8" fill="none"/>
      <path d="M6 18L18 6" stroke={color} strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
  'DNC': (color) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.8" fill="none"/>
      <path d="M12 7v6M12 16v1" stroke={color} strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
  'Bad Data': (color) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      <path d="M10 11v6M14 11v6" stroke={color} strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  ),
}

const OUTCOME_CONFIG = {
  'No Answer':      { border:'#C87800', bg:'#FFF8E6', color:'#C87800' },
  'Voicemail':      { border:'#7C3AED', bg:'#F3E8FF', color:'#7C3AED' },
  'Booked':         { border:'#16A34A', bg:'#DCFCE7', color:'#16A34A' },
  'Not Interested': { border:'#DC2626', bg:'#FEE2E2', color:'#DC2626' },
  'DNC':            { border:'#7F1D1D', bg:'#FEF2F2', color:'#7F1D1D' },
  'Bad Data':       { border:'#6B7280', bg:'#F3F4F6', color:'#6B7280' },
}

export default function DialerPage() {
  const { contacts, setContacts, campaigns, dncSet } = useData()
  const { profile } = useAuth()
  const currentRep = profile?.name || profile?.email || 'Unknown'

  // Queue & contact state
  const [selectedId, setSelectedId] = useState(null)
  const [selectedOutcome, setSelectedOutcome] = useState(null)
  const [filter, setFilter] = useState('active')
  const [campFilter, setCampFilter] = useState('')
  const [search, setSearch] = useState('')
  const [contactLogs, setContactLogs] = useState([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState('script')
  const [notesVal, setNotesVal] = useState('')
  const [queueCollapsed, setQueueCollapsed] = useState(true)
  const [todayLogs, setTodayLogs] = useState([])
  const [powerDialActive, setPowerDialActive] = useState(false)
  const [alsoMembership, setAlsoMembership] = useState(false)
  const [commissionRates, setCommissionRates] = useState({ booking: 2.00, membership: 2.00 })
  const [dailyEarnings, setDailyEarnings] = useState(0)
  const [weeklyEarnings, setWeeklyEarnings] = useState(0)
  const [showEarningsDetail, setShowEarningsDetail] = useState(false)

  // Modals
  const [showCallbackModal, setShowCallbackModal] = useState(false)
  const [showCorrectModal, setShowCorrectModal] = useState(false)
  const [showDialpad, setShowDialpad] = useState(false)
  const [cbDate, setCbDate] = useState('')
  const [cbTime, setCbTime] = useState('09:00')
  const [cbNote, setCbNote] = useState('')
  const [correctOutcome, setCorrectOutcome] = useState('')
  const [correctNote, setCorrectNote] = useState('')
  const [dialpadNumber, setDialpadNumber] = useState('')

  // ST Booking panel
  const [stJobTypes, setStJobTypes] = useState([])
  const [stBusinessUnits, setStBusinessUnits] = useState([])
  const [stCampaigns, setStCampaigns] = useState([])
  const [stCampaignId, setStCampaignId] = useState(null)
  const [selectedJobType, setSelectedJobType] = useState('')
  const [selectedBU, setSelectedBU] = useState('')
  const [buSearch, setBuSearch] = useState('')
  const [buOpen, setBuOpen] = useState(false)
  const [jtSearch, setJtSearch] = useState('')
  const [jtOpen, setJtOpen] = useState(false)
  const [campSearch, setCampSearch] = useState('')
  const [campOpen, setCampOpen] = useState(false)
  const [availability, setAvailability] = useState([])
  const [availLoading, setAvailLoading] = useState(false)
  const [availError, setAvailError] = useState(null)
  const [booking, setBooking] = useState(false)
  const [bookingResult, setBookingResult] = useState(null)
  const [selectedSlot, setSelectedSlot] = useState(null)
  const [showAvailModal, setShowAvailModal] = useState(false)
  const [availWeekOffset, setAvailWeekOffset] = useState(0)
  const [stLoading, setStLoading] = useState(false)

  const [incomingCall, setIncomingCall] = useState(null) // { call, from, contactName }
  const callRef = useRef(null)
  const [twilioReady, setTwilioReady] = useState(false)
  const [callStatus, setCallStatus] = useState(null)
  const [callDuration, setCallDuration] = useState(0)
  const callTimerRef = useRef(null)

  // Load ST job types + business units + campaigns on mount
  useEffect(() => {
    const loadST = async () => {
      setStLoading(true)

      // Fetch each independently so one failure doesn't kill the others
      const safeFetch = async (url) => {
        try {
          const res = await fetch(url)
          if (!res.ok) { console.error(`ST fetch failed ${url}:`, res.status); return null }
          const data = await res.json()
          if (data?.error) { console.error(`ST error ${url}:`, data.error); return null }
          return data
        } catch (e) {
          console.error(`ST fetch error ${url}:`, e.message)
          return null
        }
      }

      const [jtData, buData, campData] = await Promise.all([
        safeFetch('/api/st/jobtypes'),
        safeFetch('/api/st/businessunits'),
        safeFetch('/api/st/campaigns'),
      ])

      console.log('ST jobtypes:', jtData?.data?.length ?? 'failed')
      console.log('ST businessunits:', buData?.data?.length ?? 'failed')
      console.log('ST campaigns:', campData?.data?.length ?? 'failed')

      setStJobTypes(jtData?.data || [])
      setStBusinessUnits(buData?.data || [])
      const camps = campData?.data || []
      setStCampaigns(camps)
      if (camps[0]?.id) setStCampaignId(camps[0].id)

      setStLoading(false)
    }
    loadST()
  }, [])

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
  const campName = useCallback((c) => campaigns.find(x => x.id === c.campaign_id)?.name || '', [campaigns])

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

  useEffect(() => { setNotesVal(''); setBookingResult(null); setAlsoMembership(false) }, [selectedId])

  useEffect(() => {
    if (!currentRep) return
    const today = new Date().toISOString().split('T')[0]
    sb.from('call_logs').select('*').eq('rep', currentRep)
      .gte('created_at', today + 'T00:00:00').lte('created_at', today + 'T23:59:59')
      .then(({ data }) => setTodayLogs(data || []))
  }, [currentRep])

  // Load commission rates
  useEffect(() => {
    sb.from('commission_settings').select('*').then(({ data }) => {
      if (data?.length) {
        const rates = {}
        data.forEach(r => rates[r.event_type] = parseFloat(r.amount))
        setCommissionRates(prev => ({ ...prev, ...rates }))
      }
    })
  }, [])

  // Load daily + weekly earnings
  useEffect(() => {
    if (!profile?.id) return
    const today = new Date()
    const todayStr = today.toISOString().split('T')[0]
    // Week starts Monday
    const dow = today.getDay()
    const monday = new Date(today)
    monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1))
    monday.setHours(0,0,1,0)
    const mondayStr = monday.toISOString()

    sb.from('commissions').select('amount, earned_at')
      .eq('profile_id', profile.id)
      .gte('earned_at', todayStr + 'T00:00:00')
      .then(({ data }) => {
        const daily = (data || []).reduce((sum, c) => sum + parseFloat(c.amount), 0)
        setDailyEarnings(daily)
      })

    sb.from('commissions').select('amount, earned_at')
      .eq('profile_id', profile.id)
      .gte('earned_at', mondayStr)
      .then(({ data }) => {
        const weekly = (data || []).reduce((sum, c) => sum + parseFloat(c.amount), 0)
        setWeeklyEarnings(weekly)
      })
  }, [profile?.id])

  // Init Twilio
  useEffect(() => {
    if (!currentRep || currentRep === 'Unknown') return
    let device = null
    const init = async () => {
      try {
        const { Device } = await import('@twilio/voice-sdk')
        const res = await fetch('/api/twilio/token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity: currentRep.replace(/[^a-zA-Z0-9_]/g, '_') })
        })
        const { token } = await res.json()
        if (!token) return
        device = new Device(token, { logLevel: 1, codecPreferences: ['opus', 'pcmu'] })
        device.on('registered', () => { setTwilioReady(true) })
        device.on('error', (err) => console.error('Twilio error:', err))
        device.on('incoming', (call) => {
          const from = call.parameters?.From || call.parameters?.from || 'Unknown'
          const normalizedPhone = from.replace(/\D/g, '').slice(-10)
          // Try to find matching contact
          const matchedContact = contacts.find(c => c.phone && c.phone.replace(/\D/g,'').slice(-10) === normalizedPhone)
          setIncomingCall({ call, from, contactName: matchedContact?.name || null, contactId: matchedContact?.id || null })
          // Play browser notification sound if possible
          try { new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAA==').play().catch(()=>{}) } catch(e){}
        })
        await device.register()
        deviceRef.current = device
      } catch (err) { console.error('Twilio init error:', err) }
    }
    init()
    return () => { if (deviceRef.current) { deviceRef.current.destroy(); deviceRef.current = null }; stopCallTimer() }
  }, [currentRep])

  const startCallTimer = () => { setCallDuration(0); callTimerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000) }
  const stopCallTimer = () => { if (callTimerRef.current) { clearInterval(callTimerRef.current); callTimerRef.current = null } }
  const fmtDuration = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`

  const updateAgentStatus = async (status) => {
    if (!profile?.id) return
    await sb.from('profiles').update({ status, status_since: new Date().toISOString() }).eq('id', profile.id)
  }

  const acceptIncomingCall = () => {
    if (!incomingCall?.call) return
    const call = incomingCall.call
    callRef.current = call
    setCallStatus('connected')
    startCallTimer()
    updateAgentStatus('On Call')
    call.on('disconnect', () => { setCallStatus('ended'); stopCallTimer(); setTimeout(() => setCallStatus(null), 3000); updateAgentStatus('Wrap Up') })
    call.on('error', () => { setCallStatus('ended'); stopCallTimer(); setTimeout(() => setCallStatus(null), 2000) })
    call.accept()
    // Auto-select the contact if we found one
    if (incomingCall.contactId) selectContact(incomingCall.contactId)
    setIncomingCall(null)
  }

  const rejectIncomingCall = () => {
    if (!incomingCall?.call) return
    incomingCall.call.reject()
    setIncomingCall(null)
  }
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
      call.on('error', () => { setCallStatus('ended'); stopCallTimer(); setTimeout(() => setCallStatus(null), 2000) })
    } catch (err) { console.error('makeCall error:', err); setCallStatus(null) }
  }

  const hangUp = () => {
    if (callRef.current) { callRef.current.disconnect(); callRef.current = null }
    setCallStatus('ended'); stopCallTimer()
    setTimeout(() => setCallStatus(null), 2000)
    updateAgentStatus('Wrap Up')
  }

  const selectContact = (id) => { setSelectedId(id); setSelectedOutcome(null) }
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

      // Sync notes to ST customer record
      if (notes && c.external_id) {
        fetch('/api/st/note', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: c.external_id, note: `${selectedOutcome}: ${notes}`, repName: currentRep })
        }).catch(err => console.warn('ST note sync failed:', err))
      }

      // Commission tracking for Booked outcome
      if (selectedOutcome === 'Booked' && profile?.id) {
        const bookingAmt = commissionRates.booking || 2
        const membershipAmt = alsoMembership ? (commissionRates.membership || 2) : 0
        const totalAmt = bookingAmt + membershipAmt
        await sb.from('commissions').insert({
          profile_id: profile.id, contact_id: c.id, event_type: 'booking',
          amount: bookingAmt, rep_name: currentRep, contact_name: c.name || 'Unknown',
          also_membership: alsoMembership, membership_amount: membershipAmt,
          earned_at: new Date().toISOString(),
        })
        setDailyEarnings(prev => prev + totalAmt)
        setWeeklyEarnings(prev => prev + totalAmt)
        setAlsoMembership(false)
      }

      setSelectedOutcome(null); setNotesVal(''); updateAgentStatus('Available')
      const { data: logs } = await sb.from('call_logs').select('*').eq('contact_id', c.id).order('created_at', { ascending: false })
      setContactLogs(logs || [])

      if (!stay) {
        const nextContact = filtered.slice(selectedIdx + 1).find(x => !isDone(x) && x.status !== 'Max Attempts')
        if (nextContact) selectContact(nextContact.id)
        else { setSelectedId(null) }
      }
    } finally { setSaving(false) }
  }

  // ST Availability check
  const checkAvailability = async () => {
    if (!selectedJobType || !selectedBU) { setAvailError('Please select a job type and business unit first.'); return }
    setAvailLoading(true); setAvailError(null); setAvailability([])
    try {
      const from = new Date().toISOString()
      const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      const c = selectedContact
      const params = new URLSearchParams({ jobTypeId: selectedJobType, businessUnitId: selectedBU, from, to })
      if (c?.zip) params.set('zip', c.zip)
      const res = await fetch(`/api/st/availability?${params}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load availability')
      const slots = data?.availabilities || data?.data || []
      setAvailability(slots)
      setSelectedSlot(null)
      if (slots.length > 0) { setShowAvailModal(true); setAvailWeekOffset(0) }
      else setAvailError('No availability found for the selected criteria.')
    } catch (e) {
      setAvailError(e.message)
    } finally { setAvailLoading(false) }
  }

  const WEEK_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

  const getWeekDates = (offset) => {
    const start = new Date()
    start.setHours(0,0,0,0)
    start.setDate(start.getDate() - start.getDay() + offset * 7)
    return Array.from({length:7}, (_,i) => { const d = new Date(start); d.setDate(d.getDate()+i); return d })
  }

  const getSlotsByDay = (weekDates) => {
    const byDay = {}
    weekDates.forEach((date, i) => {
      // Compare date portion only (YYYY-MM-DD) since slot.start is now a local ISO string
      const dayStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
      byDay[i] = availability.filter(s => s.start && s.start.slice(0,10) === dayStr)
    })
    return byDay
  }

  // ST Direct Booking
  const bookInST = async () => {
    const c = selectedContact
    if (!c?.external_id) { alert('No ST Customer ID on this contact. Please link to ST first.'); return }
    if (!selectedJobType || !selectedBU) { alert('Please select a job type and business unit.'); return }
    const notes = notesVal.trim()
    setBooking(true); setBookingResult(null)
    try {
      const res = await fetch('/api/st/book', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: c.external_id, jobTypeId: selectedJobType, businessUnitId: selectedBU,
          campaignId: stCampaignId,
          notes: notes || `Outbound call booked by ${currentRep} via Andi`,
          repName: currentRep, contactName: c.name, phone: c.phone, zip: c.zip,
          start: selectedSlot?.start || null,
          end: selectedSlot?.end || null,
        })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Booking failed')
      setBookingResult({ ok: true, jobId: data.jobId, jobNumber: data.jobNumber })
    } catch (e) {
      setBookingResult({ ok: false, error: e.message })
    } finally { setBooking(false) }
  }

  const openCallbackModal = () => {
    const c = selectedContact
    setCbDate(c?.callback_at ? c.callback_at.split('T')[0] : new Date().toISOString().split('T')[0])
    setCbTime(c?.callback_at ? new Date(c.callback_at).toTimeString().slice(0,5) : '09:00')
    setCbNote(c?.callback_note || ''); setShowCallbackModal(true)
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
    const last = contactLogs[0]; if (!last) return
    setCorrectOutcome(last.outcome); setCorrectNote(''); setShowCorrectModal(true)
  }

  const applyCorrection = async () => {
    const last = contactLogs[0]; if (!last) return
    await sb.from('call_logs').update({ outcome: correctOutcome, correction: last.outcome, notes: correctNote || `Corrected from ${last.outcome}` }).eq('id', last.id)
    const c = selectedContact
    const isFinal = DONE_OUTCOMES.includes(correctOutcome) || (c?.attempts || 1) >= MAX_ATTEMPTS
    const newStatus = isFinal ? (DONE_OUTCOMES.includes(correctOutcome) ? correctOutcome : 'Max Attempts') : correctOutcome
    const { data } = await sb.from('contacts').update({ status: newStatus }).eq('id', selectedId).select().single()
    if (data) setContacts(prev => prev.map(x => x.id === selectedId ? data : x))
    const { data: logs } = await sb.from('call_logs').select('*').eq('contact_id', selectedId).order('created_at', { ascending: false })
    setContactLogs(logs || []); setShowCorrectModal(false)
  }

  const openInST = (contact) => {
    if (contact.external_id) window.open(`https://go.servicetitan.com/#/customer/${contact.external_id}`, '_blank')
    else window.open(`https://go.servicetitan.com/#/Customer/Index?name=${encodeURIComponent(contact.name || '')}&phone=${encodeURIComponent(contact.phone || '')}`, '_blank')
  }

  const c = selectedContact
  const isMe = c?.claimed_by === currentRep
  const isOther = c?.claimed_by && !isMe
  const done = c ? (isDone(c) || c.status === 'Max Attempts') : false
  const isDNC = c ? dncSet.has(normPhone(c.phone || '')) : false
  const isDup = c ? dupSet.has(c.id) : false
  const cbDue = contacts.filter(x => isCallbackDueToday(x) && !isDone(x))
  const camp = c ? campaigns.find(x => x.id === c.campaign_id) : null
  const myStats = { calls: todayLogs.length, booked: todayLogs.filter(x => x.outcome === 'Booked').length }


  // ST job history for the customer info panel
  const [stJobHistory, setStJobHistory] = useState([])
  const [stJobHistoryLoading, setStJobHistoryLoading] = useState(false)
  const [stCustomerInfo, setStCustomerInfo] = useState(null)

  // Fetch ST customer info + job history when contact changes
  useEffect(() => {
    if (!c?.external_id) { setStJobHistory([]); setStCustomerInfo(null); return }
    setStJobHistoryLoading(true)
    fetch(`/api/st/customer/${c.external_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setStCustomerInfo(data) })
      .catch(() => {})
    fetch(`/api/st/jobs?customerId=${c.external_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { setStJobHistory(data?.data?.slice(0,3) || []); setStJobHistoryLoading(false) })
      .catch(() => setStJobHistoryLoading(false))
  }, [c?.external_id])

  // SearchSelect component
  const SearchSelect = ({ label, value, onChange, options, placeholder, disabled }) => {
    const [open, setOpen] = useState(false)
    const [q, setQ] = useState('')
    const ref = useRef(null)
    useEffect(() => {
      const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
      document.addEventListener('mousedown', handler)
      return () => document.removeEventListener('mousedown', handler)
    }, [])
    const hits = options.filter(o => o.label.toLowerCase().includes(q.toLowerCase()))
    const sel = options.find(o => String(o.value) === String(value))
    return (
      <div ref={ref} style={{ position:'relative' }}>
        {label && <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:4 }}>{label}</div>}
        <div onClick={() => !disabled && setOpen(v => !v)}
          style={{ border:`1px solid ${open ? 'var(--accent)' : 'var(--border)'}`, borderRadius:'var(--radius)', padding:'7px 10px', fontSize:12, background:'var(--surface)', color: sel ? 'var(--text-primary)' : 'var(--text-muted)', cursor: disabled ? 'default' : 'pointer', display:'flex', justifyContent:'space-between', alignItems:'center', userSelect:'none', opacity: disabled ? .5 : 1 }}>
          <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{sel?.label || placeholder}</span>
          <span style={{ fontSize:10, marginLeft:4, color:'var(--text-muted)', flexShrink:0 }}>v</span>
        </div>
        {open && (
          <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:400, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 4px 20px rgba(0,0,0,.15)', marginTop:2 }}>
            <div style={{ padding:'5px 8px', borderBottom:'1px solid var(--border)' }}>
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} onClick={e => e.stopPropagation()}
                placeholder="Search..." style={{ width:'100%', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'4px 8px', fontSize:11, background:'var(--surface-2)', color:'var(--text-primary)' }} />
            </div>
            <div style={{ maxHeight:200, overflowY:'auto' }}>
              {hits.length === 0
                ? <div style={{ padding:'9px 12px', fontSize:12, color:'var(--text-muted)', fontStyle:'italic' }}>No results</div>
                : hits.map(o => (
                    <div key={o.value} onClick={() => { onChange(o.value); setOpen(false); setQ('') }}
                      style={{ padding:'9px 12px', fontSize:12, cursor:'pointer', background: String(value)===String(o.value) ? 'var(--accent-bg)' : 'transparent', color: String(value)===String(o.value) ? 'var(--accent)' : 'var(--text-primary)', fontWeight: String(value)===String(o.value) ? 600 : 400 }}
                      onMouseEnter={e => { if (String(value)!==String(o.value)) e.currentTarget.style.background='var(--surface-2)' }}
                      onMouseLeave={e => { if (String(value)!==String(o.value)) e.currentTarget.style.background='transparent' }}>
                      {o.label}
                    </div>
                  ))
              }
            </div>
          </div>
        )}
      </div>
    )
  }

  const buOptions = [...stBusinessUnits].sort((a,b) => a.name.localeCompare(b.name)).map(b => ({ value:String(b.id), label:b.name }))
  const jtOptions = [...stJobTypes].filter(jt => !selectedBU || jt.businessUnitIds?.includes(parseInt(selectedBU)) || jt.businessUnitId===parseInt(selectedBU)).sort((a,b) => a.name.localeCompare(b.name)).map(j => ({ value:String(j.id), label:j.name }))
  const campOptions = [...stCampaigns].sort((a,b) => a.name.localeCompare(b.name)).map(c => ({ value:String(c.id), label:c.name }))

  // Label helper
  const L = ({ text }) => <div style={{ fontSize:9, fontWeight:700, textTransform:'uppercase', letterSpacing:.7, color:'var(--text-muted)', marginBottom:3 }}>{text}</div>

  const sectionCard = { background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, overflow:'hidden', marginBottom:0 }
  const sectionHeader = { padding:'8px 14px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between', background:'var(--surface-2)' }
  const sectionTitle = { fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.7, color:'var(--text-muted)' }

  return (
    <div style={{ display:'flex', flex:1, overflow:'hidden', height:'100%', flexDirection:'column' }}>

      {/* INCOMING CALL BANNER */}
      {incomingCall && (
        <div style={{ position:'fixed', top:16, right:16, zIndex:9999, background:'var(--surface)', border:'2px solid #16A34A', borderRadius:12, boxShadow:'0 8px 32px rgba(0,0,0,.25)', padding:'16px 20px', minWidth:320, display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            {/* Pulsing ring indicator */}
            <div style={{ position:'relative', width:44, height:44, flexShrink:0 }}>
              <div style={{ position:'absolute', inset:0, borderRadius:'50%', background:'#DCFCE7', animation:'ping 1s cubic-bezier(0,0,.2,1) infinite' }} />
              <div style={{ position:'relative', width:44, height:44, borderRadius:'50%', background:'#16A34A', display:'flex', alignItems:'center', justifyContent:'center' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>
              </div>
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:700, color:'var(--text-primary)' }}>Incoming call</div>
              {incomingCall.contactName ? (
                <>
                  <div style={{ fontSize:14, fontWeight:700, color:'#16A34A', marginTop:1 }}>{incomingCall.contactName}</div>
                  <div style={{ fontSize:11, color:'var(--text-muted)' }}>{incomingCall.from}</div>
                </>
              ) : (
                <div style={{ fontSize:13, color:'var(--text-secondary)', marginTop:1 }}>{incomingCall.from}</div>
              )}
            </div>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={rejectIncomingCall}
              style={{ flex:1, padding:'10px 0', border:'none', borderRadius:'var(--radius)', background:'#DC2626', color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/><line x1="1" y1="1" x2="23" y2="23" stroke="white" strokeWidth="2.5"/></svg>
              Decline
            </button>
            <button onClick={acceptIncomingCall}
              style={{ flex:1, padding:'10px 0', border:'none', borderRadius:'var(--radius)', background:'#16A34A', color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>
              Answer
            </button>
          </div>
        </div>
      )}
      <style>{`@keyframes ping { 75%,100% { transform:scale(2); opacity:0 } }`}</style>

      {/* == TOP BAR == */}
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 12px', background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
        <button onClick={() => setQueueCollapsed(p => !p)}
          style={{ width:28, height:28, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, color:'var(--text-muted)', flexShrink:0 }}>
          {queueCollapsed ? '>' : '<'}
        </button>
        <button className="btn" disabled={selectedIdx <= 0} onClick={() => { const p = filtered[selectedIdx-1]; if(p) selectContact(p.id) }} style={{fontSize:11,padding:'4px 9px'}}>Prev</button>
        <button className="btn" disabled={selectedIdx >= filtered.length-1} onClick={() => { const n = filtered[selectedIdx+1]; if(n) selectContact(n.id) }} style={{fontSize:11,padding:'4px 9px'}}>Next</button>
        <button className="btn primary" onClick={navNextPending} style={{fontSize:11,padding:'4px 11px',fontWeight:600}}>Next pending</button>
        <button onClick={() => setShowDialpad(true)}
          style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 12px', background: twilioReady ? '#16A34A' : 'var(--border)', border:'none', borderRadius:'var(--radius)', cursor: twilioReady ? 'pointer' : 'not-allowed', fontSize:11, fontWeight:600, color:'#fff' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>
          Manual Dial
        </button>
        {powerDialActive && (
          <div style={{ display:'flex', alignItems:'center', gap:5, padding:'3px 9px', background:'var(--accent)', borderRadius:'var(--radius)', color:'#fff', fontSize:11 }}>
            Power Dial <button onClick={() => setPowerDialActive(false)} style={{ background:'rgba(255,255,255,.2)', border:'none', color:'#fff', padding:'1px 5px', borderRadius:3, cursor:'pointer', fontSize:10 }}>Stop</button>
          </div>
        )}
        {callStatus && (
          <div style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 10px', borderRadius:'var(--radius)', fontSize:11, fontWeight:600,
            background: callStatus==='connected' ? '#DCFCE7' : callStatus==='ended' ? 'var(--surface-2)' : '#FFF8E6',
            border:`1px solid ${callStatus==='connected' ? '#16A34A' : callStatus==='ended' ? 'var(--border)' : '#C87800'}`,
            color: callStatus==='connected' ? '#16A34A' : callStatus==='ended' ? 'var(--text-muted)' : '#C87800' }}>
            <span style={{ width:6, height:6, borderRadius:'50%', background:'currentColor', display:'inline-block' }}></span>
            {callStatus==='calling' ? 'Dialing...' : callStatus==='ringing' ? 'Ringing...' : callStatus==='connected' ? fmtDuration(callDuration) : 'Ended'}
            {['calling','ringing','connected'].includes(callStatus) && (
              <button onClick={hangUp} style={{ background:'#DC2626', border:'none', color:'#fff', padding:'2px 7px', borderRadius:3, cursor:'pointer', fontSize:10, marginLeft:2 }}>Hang up</button>
            )}
          </div>
        )}
        <div style={{ flex:1 }} />
        {/* Stats pills */}
        {[
          { l:'Calls', v:myStats.calls, c:'var(--text-primary)' },
          { l:'Booked', v:myStats.booked, c:'#16A34A' },
          { l:'Rate', v:todayLogs.length ? Math.round((myStats.booked/todayLogs.length)*100)+'%' : '--', c:'#7C3AED' },
        ].map(({ l, v, c:col }) => (
          <div key={l} style={{ display:'flex', flexDirection:'column', alignItems:'center', minWidth:44 }}>
            <div style={{ fontSize:9, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)' }}>{l}</div>
            <div style={{ fontSize:13, fontWeight:700, color:col }}>{v}</div>
          </div>
        ))}
        <div style={{ position:'relative' }}>
          <button onClick={() => setShowEarningsDetail(p => !p)}
            style={{ display:'flex', alignItems:'center', gap:4, padding:'4px 10px', background: dailyEarnings > 0 ? '#16A34A' : 'var(--surface-2)', border:`1px solid ${dailyEarnings > 0 ? '#16A34A' : 'var(--border)'}`, borderRadius:99, cursor:'pointer', color: dailyEarnings > 0 ? '#fff' : 'var(--text-muted)', fontSize:12, fontWeight:700 }}>
            ${dailyEarnings.toFixed(2)}
          </button>
          {showEarningsDetail && (
            <div style={{ position:'fixed', right:16, top:46, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 4px 20px rgba(0,0,0,.15)', zIndex:500, minWidth:190 }} onMouseLeave={() => setShowEarningsDetail(false)}>
              <div style={{ padding:'9px 14px', borderBottom:'1px solid var(--border)', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)' }}>Earnings</div>
              <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:8 }}>
                <div style={{ display:'flex', justifyContent:'space-between' }}><span style={{ fontSize:12, color:'var(--text-secondary)' }}>Today</span><span style={{ fontSize:16, fontWeight:800, color:'#16A34A' }}>${dailyEarnings.toFixed(2)}</span></div>
                <div style={{ height:1, background:'var(--border)' }} />
                <div style={{ display:'flex', justifyContent:'space-between' }}><span style={{ fontSize:12, color:'var(--text-secondary)' }}>This week</span><span style={{ fontSize:16, fontWeight:800, color:'var(--accent)' }}>${weeklyEarnings.toFixed(2)}</span></div>
              </div>
            </div>
          )}
        </div>
        {cbDue.length > 0 && <div style={{ fontSize:11, fontWeight:600, color:'#C87800', padding:'3px 8px', background:'#FFFBEB', border:'1px solid #FCD34D', borderRadius:99 }}>CB: {cbDue.length}</div>}
      </div>

      {/* == BODY == */}
      <div style={{ flex:1, display:'flex', overflow:'hidden', minHeight:0 }}>

        {/* Queue sidebar */}
        <aside style={{ width: queueCollapsed ? 0 : 220, minWidth: queueCollapsed ? 0 : 220, flexShrink:0, background:'var(--surface)', borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', overflow:'hidden', transition:'width .2s, min-width .2s' }}>
          <div style={{ padding:'9px 10px 7px', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:5 }}>
              <span style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.8, color:'var(--text-muted)' }}>Queue</span>
              <span style={{ fontSize:10, color:'var(--text-muted)' }}>{filtered.length}/{contacts.length}</span>
            </div>
            <input style={{ width:'100%', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'4px 8px', fontSize:11, background:'var(--surface-2)', color:'var(--text-primary)' }}
              placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} />
            <div style={{ display:'flex', gap:3, marginTop:5, flexWrap:'wrap' }}>
              {[{id:'active',label:'Active'},{id:'callback',label:'CB'},{id:'no-answer',label:'N/A'},{id:'voicemail',label:'VM'},{id:'done',label:'Done'},{id:'all',label:'All'}].map(f => (
                <button key={f.id} onClick={() => setFilter(f.id)}
                  style={{ padding:'2px 6px', borderRadius:99, fontSize:10, border:'1px solid', cursor:'pointer', borderColor: filter===f.id ? 'var(--accent)' : 'var(--border)', background: filter===f.id ? 'var(--accent)' : 'transparent', color: filter===f.id ? '#fff' : 'var(--text-muted)' }}>
                  {f.label}
                </button>
              ))}
            </div>
            <select value={campFilter} onChange={e => setCampFilter(e.target.value)}
              style={{ width:'100%', marginTop:5, border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'3px 6px', fontSize:11, background:'var(--surface-2)', color:'var(--text-primary)' }}>
              <option value="">All campaigns</option>
              {campaigns.map(camp => <option key={camp.id} value={camp.id}>{camp.name}</option>)}
            </select>
          </div>
          <div style={{ flex:1, overflowY:'auto' }}>
            {filtered.slice(0, PAGE_SIZE).map((contact, idx) => {
              const active = contact.id === selectedId
              const hasCb = isCallbackDueToday(contact) && !isDone(contact)
              return (
                <div key={contact.id} onClick={() => selectContact(contact.id)}
                  style={{ padding:'7px 10px', cursor:'pointer', borderBottom:'1px solid var(--border)', background: active ? 'var(--accent-bg)' : 'transparent', borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                    <span style={{ fontSize:10, color:'var(--text-muted)', width:14, flexShrink:0 }}>{idx+1}</span>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontWeight:600, fontSize:11, color: active ? 'var(--accent)' : 'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {hasCb && '* '}{contact.name || '--'}
                        {contact.claimed_by === currentRep && <span style={{ marginLeft:3, fontSize:9, background:'var(--accent)', color:'#fff', borderRadius:3, padding:'1px 3px' }}>You</span>}
                      </div>
                      <div style={{ fontSize:10, color:'var(--text-muted)' }}>{contact.phone || 'No phone'}</div>
                    </div>
                    <div style={{ display:'flex', gap:2 }}>
                      {Array.from({length:MAX_ATTEMPTS},(_,i) => <div key={i} style={{width:4,height:4,borderRadius:'50%',background:i<(contact.attempts||0)?'var(--accent)':'var(--border)'}}></div>)}
                    </div>
                  </div>
                </div>
              )
            })}
            {filtered.length > PAGE_SIZE && <div style={{ padding:'6px', fontSize:10, color:'var(--text-muted)', textAlign:'center' }}>+{filtered.length-PAGE_SIZE} more</div>}
          </div>
        </aside>

        {/* == MAIN WORKSPACE == */}
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>

          {/* EMPTY STATE */}
          {!c && (
            <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:20, padding:32 }}>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, width:'100%', maxWidth:560 }}>
                {[
                  { label:'Calls today', value:myStats.calls, color:'var(--accent)' },
                  { label:'Booked today', value:myStats.booked, color:'#16A34A' },
                  { label:'Booking rate', value:todayLogs.length ? Math.round((myStats.booked/todayLogs.length)*100)+'%' : '--', color:'#7C3AED' },
                  { label:'Callbacks due', value:cbDue.length, color:'#C87800', click:()=>setFilter('callback') },
                ].map(({ label, value, color, click }) => (
                  <div key={label} onClick={click} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderTop:`3px solid ${color}`, borderRadius:'var(--radius)', padding:'12px 14px', cursor: click ? 'pointer' : 'default' }}>
                    <div style={{ fontSize:9, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:4 }}>{label}</div>
                    <div style={{ fontSize:22, fontWeight:700, color }}>{value}</div>
                  </div>
                ))}
              </div>
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize:15, fontWeight:600, color:'var(--text-primary)', marginBottom:4 }}>Ready to dial</div>
                <div style={{ fontSize:13, color:'var(--text-muted)', marginBottom:16 }}>Select a contact or hit Next pending</div>
                <button className="btn primary" style={{ padding:'9px 28px', fontSize:14, fontWeight:600 }} onClick={navNextPending}>Next pending</button>
              </div>
            </div>
          )}

          {/* == CONTACT WORKSPACE == */}
          {c && (
            <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

              {/* -- CONTACT HEADER -- */}
              <div style={{ padding:'10px 16px', background:'var(--surface)', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
                <div style={{ width:40, height:40, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:700, flexShrink:0 }}>
                  {getInitials(c.name)}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                    <span style={{ fontSize:15, fontWeight:700, color:'var(--text-primary)' }}>{c.name || '--'}</span>
                    <Badge status={c.status || 'Pending'} />
                    {isDNC && <span style={{ fontSize:10, fontWeight:700, background:'#FEE2E2', color:'#7F1D1D', border:'1px solid #FECACA', borderRadius:99, padding:'1px 6px' }}>DNC</span>}
                    {isDup && <span style={{ fontSize:10, fontWeight:700, background:'#F3E8FF', color:'#5B21B6', border:'1px solid #DDD6FE', borderRadius:99, padding:'1px 6px' }}>Duplicate</span>}
                    {campName(c) && <span style={{ fontSize:10, background:'var(--surface-2)', color:'var(--text-muted)', border:'1px solid var(--border)', borderRadius:99, padding:'1px 7px' }}>{campName(c)}</span>}
                  </div>
                  <div style={{ display:'flex', gap:16, marginTop:3 }}>
                    {[c.phone, c.email, [c.address,c.city,c.state].filter(Boolean).join(', ')].filter(Boolean).map((v,i) => (
                      <span key={i} style={{ fontSize:11, color:'var(--text-secondary)' }}>{v}</span>
                    ))}
                    <span style={{ fontSize:11, color:'var(--text-secondary)' }}>ST: {c.external_id || '--'}</span>
                    <span style={{ fontSize:11, color:'var(--text-secondary)' }}>Attempts: {c.attempts||0}/{MAX_ATTEMPTS}</span>
                  </div>
                </div>
                {/* Action buttons */}
                <div style={{ display:'flex', gap:6, flexShrink:0, alignItems:'center' }}>
                  {c.callback_at && <span style={{ fontSize:10, padding:'4px 8px', background:'#FFF8E6', border:'1px solid #FCD34D', borderRadius:'var(--radius)', color:'#92400E' }}>CB: {fmtDate(c.callback_at)}</span>}
                  {c.phone && (
                    <button onClick={() => makeCall(c.phone)} disabled={!twilioReady || !!callStatus}
                      style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 18px', border:'none', borderRadius:'var(--radius)', background: twilioReady && !callStatus ? '#16A34A' : 'var(--border)', cursor: twilioReady && !callStatus ? 'pointer' : 'not-allowed', fontSize:13, fontWeight:700, color:'#fff' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>
                      Call
                    </button>
                  )}
                  <button onClick={() => openInST(c)} style={{ padding:'7px 12px', border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:12, color:'var(--text-primary)' }}>Open in ST</button>
                  {!c.claimed_by && !done && <button className="btn sm primary" onClick={claimContact}>Claim</button>}
                  {isMe && !done && <button className="btn sm" onClick={() => releaseContact(c.id)}>Release</button>}
                  {isOther && <span style={{ fontSize:11, color:'var(--text-muted)' }}>Claimed by {c.claimed_by}</span>}
                </div>
              </div>

              {/* -- 3-COLUMN BODY -- */}
              <div style={{ flex:1, display:'grid', gridTemplateColumns:'300px 1fr 300px', overflow:'hidden', minHeight:0 }}>

                {/* -- LEFT: Customer info + Job history -- */}
                <div style={{ borderRight:'1px solid var(--border)', overflowY:'auto', background:'var(--surface-2)', display:'flex', flexDirection:'column', gap:1 }}>

                  {/* Customer info card */}
                  <div style={sectionCard}>
                    <div style={sectionHeader}>
                      <span style={sectionTitle}>Customer info</span>
                      {stCustomerInfo?.membershipStatus && (
                        <span style={{ fontSize:10, background:'#DCFCE7', color:'#15803D', border:'1px solid #86EFAC', borderRadius:99, padding:'1px 7px', fontWeight:600 }}>Member</span>
                      )}
                    </div>
                    <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:10 }}>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                        <div><L text="Email" /><div style={{ fontSize:12, color:'var(--text-primary)', wordBreak:'break-all' }}>{c.email || '--'}</div></div>
                        <div><L text="Source" /><div style={{ fontSize:12, color:'var(--text-primary)' }}>{c.source || '--'}</div></div>
                        <div><L text="Membership" /><div style={{ fontSize:12, color: stCustomerInfo ? '#16A34A' : 'var(--text-muted)', fontWeight: stCustomerInfo ? 600 : 400 }}>
                          {stCustomerInfo ? (stCustomerInfo.membershipStatus || 'Checking...') : c.external_id ? 'Loading...' : '--'}
                        </div></div>
                        <div><L text="Last service" /><div style={{ fontSize:12, color:'var(--text-primary)' }}>
                          {stJobHistory[0] ? fmtDate(stJobHistory[0].completedOn || stJobHistory[0].scheduledDate) : c.external_id ? (stJobHistoryLoading ? 'Loading...' : 'None found') : '--'}
                        </div></div>
                      </div>
                      <div>
                        <L text="Address" />
                        <div style={{ fontSize:12, color:'var(--text-primary)' }}>{[c.address,c.city,c.state,c.zip].filter(Boolean).join(', ') || '--'}</div>
                      </div>
                    </div>
                  </div>

                  {/* Job history */}
                  <div style={{ ...sectionCard, marginTop:1 }}>
                    <div style={sectionHeader}>
                      <span style={sectionTitle}>Recent jobs</span>
                      {c.external_id && <span onClick={() => openInST(c)} style={{ fontSize:10, color:'var(--accent)', cursor:'pointer' }}>View all in ST</span>}
                    </div>
                    <div style={{ padding:0 }}>
                      {!c.external_id ? (
                        <div style={{ padding:'14px', fontSize:12, color:'var(--text-muted)', textAlign:'center' }}>No ST ID -- can't load history</div>
                      ) : stJobHistoryLoading ? (
                        <div style={{ padding:'14px', display:'flex', justifyContent:'center' }}><div className="spinner" /></div>
                      ) : stJobHistory.length === 0 ? (
                        <div style={{ padding:'14px', fontSize:12, color:'var(--text-muted)', textAlign:'center' }}>No jobs found</div>
                      ) : stJobHistory.map((job, i) => (
                        <div key={job.id || i} style={{ padding:'10px 14px', borderBottom: i < stJobHistory.length-1 ? '1px solid var(--border)' : 'none', display:'flex', alignItems:'flex-start', gap:10 }}>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:12, fontWeight:600, color:'var(--text-primary)', marginBottom:2 }}>{job.type?.name || job.jobTypeName || 'Job'}</div>
                            <div style={{ fontSize:10, color:'var(--text-muted)' }}>{job.businessUnit?.name || ''}</div>
                          </div>
                          <div style={{ textAlign:'right', flexShrink:0 }}>
                            <div style={{ fontSize:10, padding:'2px 7px', borderRadius:99, fontWeight:600,
                              background: job.jobStatus === 'Completed' ? '#DCFCE7' : '#F3F4F6',
                              color: job.jobStatus === 'Completed' ? '#15803D' : '#6B7280' }}>
                              {job.jobStatus || 'Unknown'}
                            </div>
                            <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:3 }}>{job.completedOn ? fmtDate(job.completedOn) : fmtDate(job.scheduledDate)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Call log history */}
                  <div style={{ ...sectionCard, marginTop:1, flex:1 }}>
                    <div style={sectionHeader}>
                      <span style={sectionTitle}>Call history</span>
                      {contactLogs.length > 0 && <button className="btn sm" style={{ fontSize:10, padding:'2px 7px' }} onClick={openCorrectModal}>Correct last</button>}
                    </div>
                    <div style={{ overflowY:'auto' }}>
                      {logsLoading ? <div style={{ padding:14, display:'flex', justifyContent:'center' }}><div className="spinner" /></div> :
                        contactLogs.length === 0 ? <div style={{ padding:'14px', fontSize:12, color:'var(--text-muted)', textAlign:'center' }}>No attempts yet</div> :
                        contactLogs.map(l => (
                          <div key={l.id} style={{ padding:'9px 14px', borderBottom:'1px solid var(--border)', borderLeft:`3px solid ${OUTCOME_CONFIG[l.outcome]?.border || 'var(--border)'}` }}>
                            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:2 }}>
                              <span style={{ fontSize:11, fontWeight:600, color: OUTCOME_CONFIG[l.outcome]?.color || 'var(--text-primary)' }}>{l.outcome}</span>
                              <span style={{ fontSize:10, color:'var(--text-muted)' }}>{fmtShort(l.created_at)}</span>
                            </div>
                            {l.notes && <div style={{ fontSize:11, color:'var(--text-secondary)', lineHeight:1.5 }}>{l.notes}</div>}
                            <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:2 }}>by {l.rep}</div>
                          </div>
                        ))
                      }
                    </div>
                  </div>
                </div>

                {/* -- CENTER: Outcome + Booking -- */}
                <div style={{ overflowY:'auto', padding:14, display:'flex', flexDirection:'column', gap:10 }}>

                  {/* Banners */}
                  {isDNC && <div style={{ background:'#FEF2F2', border:'1px solid #FECACA', borderRadius:'var(--radius)', padding:'8px 12px', fontSize:12, color:'#7F1D1D', fontWeight:600 }}>DNC -- Do not dial this number</div>}
                  {c.callback_at && (
                    <div style={{ background:'#FFFBEB', border:'1px solid #FCD34D', borderRadius:'var(--radius)', padding:'8px 12px', fontSize:12, color:'#92400E', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                      <span><strong>Callback:</strong> {fmtDate(c.callback_at)}{c.callback_note ? ` -- ${c.callback_note}` : ''}</span>
                      <button className="btn sm" onClick={() => clearCallback(c.id)}>Clear</button>
                    </div>
                  )}

                  {!done ? (
                    <>
                      {/* Outcome grid */}
                      <div style={sectionCard}>
                        <div style={sectionHeader}>
                          <span style={sectionTitle}>Log outcome</span>
                          {isOther && <span style={{ fontSize:11, color:'var(--text-muted)' }}>Claimed by {c.claimed_by}</span>}
                        </div>
                        <div style={{ padding:12, display:'flex', flexDirection:'column', gap:10 }}>
                          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
                            {OUTCOMES.map(o => {
                              const sel = selectedOutcome === o.id
                              const cm = OUTCOME_CONFIG[o.id] || {}
                              return (
                                <button key={o.id} disabled={!isMe} onClick={() => setSelectedOutcome(sel ? null : o.id)}
                                  style={{ padding:'12px 8px', borderRadius:'var(--radius)', fontSize:12, fontWeight: sel ? 700 : 500, border: sel ? `2px solid ${cm.border}` : '1px solid var(--border)', background: sel ? cm.bg : 'var(--surface-2)', color: sel ? cm.color : 'var(--text-secondary)', cursor: isMe ? 'pointer' : 'not-allowed', opacity: isMe ? 1 : .4, textAlign:'center', transition:'all .1s' }}>
                                  <div style={{ display:'flex', alignItems:'center', justifyContent:'center', marginBottom:5 }}>{OUTCOME_ICONS[o.id]?.(sel ? cm.color : 'var(--text-muted)')}</div>
                                  {o.id}
                                </button>
                              )
                            })}
                          </div>

                          {/* Notes */}
                          <textarea value={notesVal} onChange={e => setNotesVal(e.target.value)} disabled={!isMe}
                            placeholder={selectedOutcome === 'Booked' ? 'Notes required before booking...' : 'Add call notes...'}
                            style={{ width:'100%', border:`1px solid ${selectedOutcome==='Booked' ? 'var(--accent)' : 'var(--border)'}`, borderRadius:'var(--radius)', padding:'9px 10px', fontSize:12, fontFamily:'inherit', resize:'vertical', minHeight:80, background:'var(--surface)', color:'var(--text-primary)', opacity: isMe ? 1 : .4 }} />

                          {/* ST Booking panel */}
                          {selectedOutcome === 'Booked' && (
                            <div style={{ background:'var(--success-bg)', border:'1px solid var(--success)', borderRadius:'var(--radius)', padding:12, display:'flex', flexDirection:'column', gap:10 }}>
                              <div style={{ fontSize:11, fontWeight:700, color:'var(--success)' }}>ServiceTitan booking details</div>
                              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                                <SearchSelect label="Business unit" value={selectedBU} onChange={v => { setSelectedBU(v); setSelectedJobType(''); setAvailability([]); setBookingResult(null) }} options={buOptions} placeholder="Select..." />
                                <SearchSelect label="Job type" value={selectedJobType} onChange={v => { setSelectedJobType(v); setAvailability([]); setBookingResult(null) }} options={jtOptions} placeholder="Select..." disabled={!selectedBU} />
                              </div>
                              <SearchSelect label="Marketing campaign" value={String(stCampaignId||'')} onChange={v => setStCampaignId(v)} options={campOptions} placeholder="Select campaign..." />

                              <label style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background: alsoMembership ? '#EFF6FF' : 'var(--surface)', border:`1px solid ${alsoMembership ? '#3b82f6' : 'var(--border)'}`, borderRadius:'var(--radius)', cursor:'pointer' }}>
                                <div onClick={() => setAlsoMembership(p => !p)}
                                  style={{ width:18, height:18, borderRadius:4, border:`2px solid ${alsoMembership ? '#3b82f6' : 'var(--border)'}`, background: alsoMembership ? '#3b82f6' : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, cursor:'pointer' }}>
                                  {alsoMembership && <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                                </div>
                                <div onClick={() => setAlsoMembership(p => !p)}>
                                  <span style={{ fontSize:12, fontWeight:600, color: alsoMembership ? '#1d4ed8' : 'var(--text-primary)' }}>Also sold a membership</span>
                                  <span style={{ fontSize:11, color:'var(--text-muted)', marginLeft:6 }}>+${(commissionRates.membership||2).toFixed(2)}</span>
                                </div>
                              </label>

                              <button onClick={checkAvailability} disabled={!selectedJobType || !selectedBU || availLoading}
                                style={{ width:'100%', padding:'8px 0', border:'1px solid #16A34A', borderRadius:'var(--radius)', background:'var(--surface)', color:'#16A34A', fontSize:12, fontWeight:600, cursor: selectedJobType && selectedBU ? 'pointer' : 'not-allowed', opacity: selectedJobType && selectedBU ? 1 : .5, display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
                                {availLoading ? <><div className="spinner" style={{width:12,height:12,borderWidth:2}}></div> Loading...</> : 'Check availability'}
                              </button>
                              {availError && <div style={{ fontSize:11, color:'var(--danger)', padding:'5px 8px', background:'var(--danger-bg)', borderRadius:'var(--radius)' }}>{availError}</div>}

                              {selectedSlot && (
                                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'7px 10px', background:'#DCFCE7', border:'1px solid #16A34A', borderRadius:'var(--radius)' }}>
                                  <span style={{ fontSize:12, fontWeight:600, color:'#15803D' }}>
                                    {new Date(selectedSlot.start).toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })} . {new Date(selectedSlot.start).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })} - {new Date(selectedSlot.end).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}
                                  </span>
                                  <button onClick={() => { setSelectedSlot(null); setShowAvailModal(true) }} style={{ fontSize:10, padding:'2px 8px', background:'#16A34A', color:'#fff', border:'none', borderRadius:4, cursor:'pointer' }}>Change</button>
                                </div>
                              )}

                              <button onClick={bookInST} disabled={!c.external_id || !selectedJobType || !selectedBU || booking}
                                style={{ width:'100%', padding:'10px 0', border:'none', borderRadius:'var(--radius)', background: c.external_id && selectedJobType && selectedBU ? '#16A34A' : 'var(--border)', color:'#fff', fontSize:13, fontWeight:700, cursor: c.external_id && selectedJobType && selectedBU ? 'pointer' : 'not-allowed', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
                                {booking ? <><div className="spinner" style={{width:13,height:13,borderWidth:2,borderTopColor:'#fff'}}></div> Booking...</> :
                                  selectedSlot ? `Book ${new Date(selectedSlot.start).toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })} ${new Date(selectedSlot.start).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}` :
                                  'Book in ServiceTitan (Unscheduled)'}
                              </button>
                              {!c.external_id && <div style={{ fontSize:10, color:'var(--warning)', textAlign:'center' }}>No ST Customer ID on this contact</div>}
                              {bookingResult && (
                                <div style={{ padding:'7px 10px', borderRadius:'var(--radius)', fontSize:11, fontWeight:500, background: bookingResult.ok ? '#DCFCE7' : '#FEE2E2', border:`1px solid ${bookingResult.ok ? '#16A34A' : '#DC2626'}`, color: bookingResult.ok ? '#15803D' : '#DC2626' }}>
                                  {bookingResult.ok ? `Job #${bookingResult.jobNumber||bookingResult.jobId} created!` : bookingResult.error}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Log actions */}
                          <div style={{ display:'flex', gap:6, justifyContent:'space-between', paddingTop:2 }}>
                            <button className="btn" disabled={!isMe} onClick={openCallbackModal} style={{fontSize:12}}>Callback</button>
                            <div style={{ display:'flex', gap:6 }}>
                              <button className="btn" disabled={!isMe || !selectedOutcome || saving} onClick={() => logOutcome(true)} style={{fontSize:12}}>{saving ? 'Saving...' : 'Log & stay'}</button>
                              <button className="btn" disabled={!isMe || !selectedOutcome || saving} onClick={() => logOutcome(false)}
                                style={{ background:'#16A34A', borderColor:'#16A34A', color:'#fff', fontWeight:600, fontSize:12 }}>
                                {saving ? 'Saving...' : 'Log & next'}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div style={{ background:'#DCFCE7', border:'1px solid #BBF7D0', borderRadius:'var(--radius)', padding:'12px 16px', fontSize:13, color:'#15803D', fontWeight:500 }}>
                      Contact complete -- {c.status}
                    </div>
                  )}
                </div>

                {/* -- RIGHT: Stats + Script + Tips -- */}
                <div style={{ borderLeft:'1px solid var(--border)', display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--surface-2)' }}>

                  {/* Stats -- always visible */}
                  <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--border)', background:'var(--surface)', flexShrink:0 }}>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8, marginBottom:8 }}>
                      {[
                        { l:'Calls today', v:myStats.calls, col:'var(--text-primary)' },
                        { l:'Booked', v:myStats.booked, col:'#16A34A' },
                        { l:'Booking rate', v:todayLogs.length ? Math.round((myStats.booked/todayLogs.length)*100)+'%' : '--', col:'#7C3AED' },
                        { l:'Commission', v:'$'+dailyEarnings.toFixed(2), col:'#2563eb' },
                      ].map(({ l, v, col }) => (
                        <div key={l} style={{ background:'var(--surface-2)', borderRadius:'var(--radius)', padding:'8px 10px' }}>
                          <div style={{ fontSize:9, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', marginBottom:2 }}>{l}</div>
                          <div style={{ fontSize:16, fontWeight:700, color:col }}>{v}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Script / Tips tabs */}
                  <div style={{ display:'flex', borderBottom:'1px solid var(--border)', flexShrink:0, background:'var(--surface)' }}>
                    {['script','tips','history'].map(t => (
                      <button key={t} onClick={() => setActiveTab(t)}
                        style={{ flex:1, padding:'8px 0', fontSize:11, fontWeight: activeTab===t ? 600 : 400, border:'none', cursor:'pointer', background: activeTab===t ? 'var(--surface-2)' : 'var(--surface)', color: activeTab===t ? 'var(--accent)' : 'var(--text-muted)', borderBottom: activeTab===t ? '2px solid var(--accent)' : '2px solid transparent', textTransform:'capitalize' }}>
                        {t === 'history' ? `Log (${contactLogs.length})` : t.charAt(0).toUpperCase()+t.slice(1)}
                      </button>
                    ))}
                  </div>

                  <div style={{ flex:1, overflowY:'auto', padding:12 }}>
                    {activeTab === 'script' && (
                      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                        {camp?.script ? (
                          <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderLeft:'3px solid var(--accent)', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:12, lineHeight:1.9, whiteSpace:'pre-wrap', color:'var(--text-primary)' }}>
                            {camp.script}
                          </div>
                        ) : (
                          <div style={{ fontSize:12, color:'var(--text-muted)', fontStyle:'italic', textAlign:'center', paddingTop:16 }}>No script set for this campaign.</div>
                        )}
                      </div>
                    )}
                    {activeTab === 'tips' && (
                      <div>
                        {camp?.tips ? (
                          <div style={{ background:'#FFFBEB', border:'1px solid #FCD34D', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:12, lineHeight:1.9, whiteSpace:'pre-wrap', color:'#78350F' }}>
                            {camp.tips}
                          </div>
                        ) : (
                          <div style={{ fontSize:12, color:'var(--text-muted)', fontStyle:'italic', textAlign:'center', paddingTop:16 }}>No tips set for this campaign.</div>
                        )}
                      </div>
                    )}
                    {activeTab === 'history' && (
                      <div>
                        {logsLoading ? <div style={{ display:'flex', justifyContent:'center', paddingTop:20 }}><div className="spinner" /></div> :
                          contactLogs.length === 0 ? <div style={{ fontSize:12, color:'var(--text-muted)', fontStyle:'italic', textAlign:'center', paddingTop:20 }}>No attempts yet</div> :
                          contactLogs.map(l => (
                            <div key={l.id} style={{ padding:'9px 11px', marginBottom:8, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', borderLeft:`3px solid ${OUTCOME_CONFIG[l.outcome]?.border||'var(--border)'}` }}>
                              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:3 }}>
                                <span style={{ fontSize:12, fontWeight:600, color:OUTCOME_CONFIG[l.outcome]?.color||'var(--text-primary)' }}>{l.outcome}</span>
                                <span style={{ fontSize:10, color:'var(--text-muted)' }}>{fmtShort(l.created_at)}</span>
                              </div>
                              {l.notes && <div style={{ fontSize:11, color:'var(--text-secondary)', lineHeight:1.5 }}>{l.notes}</div>}
                              <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:2 }}>by {l.rep}</div>
                            </div>
                          ))
                        }
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* AVAILABILITY MODAL */}
      {showAvailModal && (() => {
        const weekDates = getWeekDates(availWeekOffset)
        const byDay = getSlotsByDay(weekDates)
        const weekStart = weekDates[0], weekEnd = weekDates[6]
        const hasNext = availability.some(s => new Date(s.start) > weekEnd)
        const hasPrev = availWeekOffset > 0
        return (
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:600, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
            <div style={{ background:'var(--surface)', borderRadius:12, width:'100%', maxWidth:780, boxShadow:'0 8px 32px rgba(0,0,0,.2)', overflow:'hidden', display:'flex', flexDirection:'column', maxHeight:'90vh' }}>
              <div style={{ padding:'14px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
                <div>
                  <div style={{ fontSize:15, fontWeight:600, color:'var(--text-primary)' }}>Check availability</div>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:1 }}>{stBusinessUnits.find(b=>b.id===parseInt(selectedBU))?.name} . {stJobTypes.find(j=>j.id===parseInt(selectedJobType))?.name}</div>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <button onClick={() => setAvailWeekOffset(p=>p-1)} disabled={!hasPrev} style={{ width:30,height:30,borderRadius:'var(--radius)',border:'1px solid var(--border)',background:'var(--surface-2)',cursor:hasPrev?'pointer':'not-allowed',opacity:hasPrev?1:.3,fontSize:16,color:'var(--text-secondary)',display:'flex',alignItems:'center',justifyContent:'center' }}>{'<'}</button>
                  <span style={{ fontSize:12, fontWeight:500, color:'var(--text-primary)', minWidth:150, textAlign:'center' }}>{MONTHS_SHORT[weekStart.getMonth()]} {weekStart.getDate()} - {MONTHS_SHORT[weekEnd.getMonth()]} {weekEnd.getDate()}, {weekEnd.getFullYear()}</span>
                  <button onClick={() => setAvailWeekOffset(p=>p+1)} disabled={!hasNext} style={{ width:30,height:30,borderRadius:'var(--radius)',border:'1px solid var(--border)',background:'var(--surface-2)',cursor:hasNext?'pointer':'not-allowed',opacity:hasNext?1:.3,fontSize:16,color:'var(--text-secondary)',display:'flex',alignItems:'center',justifyContent:'center' }}>{'>'}</button>
                  <button onClick={() => setShowAvailModal(false)} style={{ width:30,height:30,borderRadius:'var(--radius)',border:'1px solid var(--border)',background:'var(--surface-2)',cursor:'pointer',fontSize:16,color:'var(--text-muted)',display:'flex',alignItems:'center',justifyContent:'center',marginLeft:4 }}>x</button>
                </div>
              </div>
              <div style={{ padding:'14px 18px', overflowY:'auto', flex:1 }}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:8 }}>
                  {weekDates.map((date, i) => {
                    const isToday = date.toDateString() === new Date().toDateString()
                    const daySlots = byDay[i] || []
                    return (
                      <div key={i} style={{ display:'flex', flexDirection:'column', gap:5 }}>
                        <div style={{ textAlign:'center', marginBottom:3 }}>
                          <div style={{ fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:.8, color:'var(--text-muted)' }}>{WEEK_DAYS[i]}</div>
                          <div style={{ width:26,height:26,borderRadius:'50%',background:isToday?'#3b82f6':'transparent',color:isToday?'#fff':'var(--text-primary)',fontSize:13,fontWeight:isToday?600:400,display:'inline-flex',alignItems:'center',justifyContent:'center',marginTop:2 }}>{date.getDate()}</div>
                        </div>
                        {daySlots.length === 0
                          ? <div style={{ height:52, borderRadius:'var(--radius)', border:'1px dashed var(--border)' }} />
                          : daySlots.map((slot,si) => {
                              const open = slot.openAvailability||0, total = slot.totalAvailability||open
                              const pctOpen = total ? Math.round((open/total)*100) : 0
                              const isSel = selectedSlot?.start === slot.start, hasOpen = open > 0
                              let bg, border, tc, bc
                              if (isSel) { bg='#16A34A'; border='2px solid #16A34A'; tc='#fff'; bc='rgba(255,255,255,.4)' }
                              else if (!hasOpen) { bg='var(--surface-2)'; border='1px solid var(--border)'; tc='var(--text-muted)'; bc='var(--border)' }
                              else if (pctOpen < 50) { bg='#FEF3C7'; border='1px solid #F59E0B'; tc='#92400E'; bc='#F59E0B' }
                              else { bg='#DCFCE7'; border='1px solid #16A34A'; tc='#15803D'; bc='#16A34A' }
                              return (
                                <div key={si} onClick={() => { if(!hasOpen) return; setSelectedSlot(isSel?null:slot); if(!isSel) setShowAvailModal(false) }}
                                  style={{ padding:'7px 8px', borderRadius:'var(--radius)', background:bg, border, cursor:hasOpen?'pointer':'default', transition:'all .12s' }}
                                  onMouseEnter={e => { if(hasOpen&&!isSel) e.currentTarget.style.opacity='.85' }}
                                  onMouseLeave={e => e.currentTarget.style.opacity='1'}>
                                  <div style={{ fontSize:10, fontWeight:600, color:tc, lineHeight:1.3 }}>{new Date(slot.start).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}</div>
                                  <div style={{ fontSize:10, color:tc, opacity:.8 }}>- {new Date(slot.end).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}</div>
                                  <div style={{ marginTop:4, height:3, background:'rgba(0,0,0,.1)', borderRadius:99, overflow:'hidden' }}>
                                    <div style={{ height:'100%', width:`${pctOpen}%`, background:bc, borderRadius:99 }} />
                                  </div>
                                  <div style={{ fontSize:9, color:tc, marginTop:2, opacity:.9 }}>{isSel?'Selected':hasOpen?`${open} open`:'Full'}</div>
                                </div>
                              )
                            })
                        }
                      </div>
                    )
                  })}
                </div>
                <div style={{ display:'flex', gap:14, marginTop:14, paddingTop:10, borderTop:'1px solid var(--border)' }}>
                  {[['#DCFCE7','#16A34A','Available'],['#FEF3C7','#F59E0B','Filling up'],['var(--surface-2)','var(--border)','Full']].map(([bg,bdr,lbl]) => (
                    <div key={lbl} style={{ display:'flex', alignItems:'center', gap:5 }}>
                      <div style={{ width:10,height:10,borderRadius:3,background:bg,border:`1px solid ${bdr}` }} />
                      <span style={{ fontSize:11, color:'var(--text-muted)' }}>{lbl}</span>
                    </div>
                  ))}
                </div>
              </div>
              {selectedSlot ? (
                <div style={{ padding:'10px 18px', borderTop:'1px solid var(--border)', background:'#DCFCE7', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
                  <span style={{ fontSize:12, fontWeight:600, color:'#15803D' }}>
                    {new Date(selectedSlot.start).toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' })} . {new Date(selectedSlot.start).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })} - {new Date(selectedSlot.end).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}
                  </span>
                  <button onClick={() => setShowAvailModal(false)} style={{ padding:'6px 16px', background:'#16A34A', color:'#fff', border:'none', borderRadius:'var(--radius)', fontSize:12, fontWeight:600, cursor:'pointer' }}>Confirm slot</button>
                </div>
              ) : (
                <div style={{ padding:'10px 18px', borderTop:'1px solid var(--border)', flexShrink:0 }}>
                  <div style={{ fontSize:12, color:'var(--text-muted)', textAlign:'center' }}>Click an available slot to select it</div>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* CALLBACK MODAL */}
      {showCallbackModal && (
        <Modal title="Schedule Callback" onClose={() => setShowCallbackModal(false)} width={360}>
          <div className="form-field"><label className="form-label">Date</label><input className="form-input" type="date" value={cbDate} onChange={e => setCbDate(e.target.value)} /></div>
          <div className="form-field"><label className="form-label">Time</label><input className="form-input" type="time" value={cbTime} onChange={e => setCbTime(e.target.value)} /></div>
          <div className="form-field"><label className="form-label">Note</label><input className="form-input" value={cbNote} onChange={e => setCbNote(e.target.value)} placeholder="Optional note..." /></div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setShowCallbackModal(false)}>Cancel</button>
            <button className="btn primary" onClick={saveCallback}>Save callback</button>
          </div>
        </Modal>
      )}

      {/* CORRECT MODAL */}
      {showCorrectModal && (
        <Modal title="Correct Last Outcome" onClose={() => setShowCorrectModal(false)} width={360}>
          <div className="form-field"><label className="form-label">New outcome</label>
            <select className="form-input" value={correctOutcome} onChange={e => setCorrectOutcome(e.target.value)}>
              {OUTCOMES.map(o => <option key={o.id} value={o.id}>{o.id}</option>)}
            </select>
          </div>
          <div className="form-field"><label className="form-label">Correction note</label><input className="form-input" value={correctNote} onChange={e => setCorrectNote(e.target.value)} placeholder="Why the correction?" /></div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setShowCorrectModal(false)}>Cancel</button>
            <button className="btn primary" onClick={applyCorrection}>Apply correction</button>
          </div>
        </Modal>
      )}

      {/* DIALPAD MODAL */}
      {showDialpad && (
        <Modal title="Manual Dial" onClose={() => { setShowDialpad(false); setDialpadNumber('') }} width={280}>
          <div style={{ textAlign:'center', marginBottom:12 }}>
            <input autoFocus type="tel" value={dialpadNumber}
              onChange={e => setDialpadNumber(e.target.value.replace(/[^0-9*#]/g,'').slice(0,15))}
              onKeyDown={e => { if(e.key==='Enter'&&dialpadNumber.length>=10){makeCall(dialpadNumber);setShowDialpad(false)} }}
              placeholder="Enter number"
              style={{ width:'100%', background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'10px 14px', fontSize:20, fontWeight:600, letterSpacing:2, textAlign:'center', color:'var(--text-primary)', outline:'none' }} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:12 }}>
            {['1','2','3','4','5','6','7','8','9','*','0','#'].map(k => (
              <button key={k} onClick={() => setDialpadNumber(p => p.length<15?p+k:p)}
                style={{ padding:'13px 0', fontSize:18, fontWeight:600, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', color:'var(--text-primary)' }}
                onMouseEnter={e => e.currentTarget.style.background='var(--accent-bg)'}
                onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>
                {k}
              </button>
            ))}
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={() => setDialpadNumber(p => p.slice(0,-1))}
              style={{ flex:1, padding:'10px 0', border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:15, color:'var(--text-muted)' }}>Del</button>
            <button onClick={() => { if(dialpadNumber.length>=10){makeCall(dialpadNumber);setShowDialpad(false)} }}
              disabled={dialpadNumber.length<10}
              style={{ flex:2, padding:'10px 0', border:'none', borderRadius:'var(--radius)', background:dialpadNumber.length>=10?'#16A34A':'var(--border)', cursor:dialpadNumber.length>=10?'pointer':'not-allowed', fontSize:14, fontWeight:700, color:'#fff' }}>
              Call
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
