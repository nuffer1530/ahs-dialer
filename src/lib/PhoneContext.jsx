import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import { sb } from './supabase'
import { useAuth } from './AuthContext'
import { useData } from './DataContext'
import { syncWorkerActivity } from './utils'

// The softphone. This MUST live above the router: it used to be created inside
// DialerPage, so navigating to any other page unmounted it and destroyed the
// Twilio Device — the browser stopped being registered as client:<identity>,
// TaskRouter had nowhere to send the call, and it sat in the queue while the
// rep watched it on the dashboard unable to answer.
//
// Everything that must outlive a route change lives here: the Device, the
// active call, the ringing call, and the call timer.
const PhoneContext = createContext(null)

export function PhoneProvider({ children }) {
  const { profile } = useAuth()
  const { contacts, setContacts } = useData()

  const deviceRef = useRef(null)
  const callRef = useRef(null)
  const connectingRef = useRef(false)
  const callTimerRef = useRef(null)

  const [twilioReady, setTwilioReady] = useState(false)
  const [incomingCall, setIncomingCall] = useState(null) // { call, from, contactName, contactId, stLookup }
  const [callStatus, setCallStatus] = useState(null)
  const [callDuration, setCallDuration] = useState(0)

  // Set when a call is accepted. DialerPage watches this and resolves it into a
  // contact tab — that work needs the dialer's own state, so it can't live here,
  // but the answering itself must work from any page.
  const [pendingInbound, setPendingInbound] = useState(null)

  const currentRep = profile?.name || profile?.email || 'Unknown'

  // contacts changes constantly; a ref keeps the 'incoming' handler from being
  // rebuilt (and the Device re-registered) on every keystroke elsewhere.
  const contactsRef = useRef(contacts)
  useEffect(() => { contactsRef.current = contacts }, [contacts])

  const startCallTimer = useCallback(() => {
    setCallDuration(0)
    if (callTimerRef.current) clearInterval(callTimerRef.current)
    callTimerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000)
  }, [])
  const stopCallTimer = useCallback(() => {
    if (callTimerRef.current) { clearInterval(callTimerRef.current); callTimerRef.current = null }
  }, [])

  const updateAgentStatus = useCallback(async (status) => {
    if (!profile?.id) return
    await sb.from('profiles').update({ status, status_since: new Date().toISOString() }).eq('id', profile.id)
    syncWorkerActivity(profile.id, status)
  }, [profile?.id])

  const wireCallEvents = useCallback((call) => {
    call.on('ringing', () => setCallStatus('ringing'))
    call.on('accept', () => { setCallStatus('connected'); startCallTimer() })
    call.on('disconnect', () => {
      callRef.current = null; setCallStatus('ended'); stopCallTimer()
      setTimeout(() => setCallStatus(null), 3000); updateAgentStatus('Wrap Up')
    })
    call.on('error', () => {
      callRef.current = null; setCallStatus('ended'); stopCallTimer()
      setTimeout(() => setCallStatus(null), 2000)
    })
  }, [startCallTimer, stopCallTimer, updateAgentStatus])

  // Register the Device once per rep, for the whole session.
  useEffect(() => {
    if (!profile?.id || currentRep === 'Unknown') return
    let device = null
    let cancelled = false

    const init = async () => {
      try {
        const { Device } = await import('@twilio/voice-sdk')
        const identity = currentRep.replace(/[^a-zA-Z0-9_]/g, '_')
        const res = await fetch('/api/twilio/token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity }),
        })
        const { token } = await res.json()
        if (!token || cancelled) return

        device = new Device(token, { logLevel: 1, codecPreferences: ['opus', 'pcmu'] })
        device.on('registered', () => setTwilioReady(true))
        device.on('unregistered', () => setTwilioReady(false))
        device.on('error', (err) => console.error('Twilio error:', err))

        device.on('incoming', async (call) => {
          const from = call.parameters?.From || call.parameters?.from || 'Unknown'
          const normalizedPhone = from.replace(/\D/g, '').slice(-10)
          const matched = contactsRef.current.find(
            c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === normalizedPhone)

          setIncomingCall({
            call, from,
            contactName: matched?.name || null,
            contactId: matched?.id || null,
            stLookup: matched ? null : 'loading',
          })
          // The caller hung up while we were still ringing — clear the banner.
          call.on('cancel', () => setIncomingCall(prev => (prev?.call === call ? null : prev)))
          call.on('disconnect', () => setIncomingCall(prev => (prev?.call === call ? null : prev)))

          if (!matched && normalizedPhone.length === 10) {
            try {
              const r = await fetch(`/api/st/lookup?phone=${normalizedPhone}`)
              const data = await r.json()
              setIncomingCall(prev => prev && prev.call === call
                ? { ...prev, stLookup: data.found ? data : 'none', contactName: data.found ? data.name : null }
                : prev)
            } catch {
              setIncomingCall(prev => prev && prev.call === call ? { ...prev, stLookup: 'none' } : prev)
            }
          }
        })

        await device.register()
        if (cancelled) { device.destroy(); return }
        deviceRef.current = device
      } catch (err) {
        console.error('Twilio init error:', err)
      }
    }
    init()

    // Only tears down on sign-out / rep change — NOT on navigation, which is
    // the entire point of hoisting this out of the page.
    return () => {
      cancelled = true
      if (deviceRef.current) { deviceRef.current.destroy(); deviceRef.current = null }
      stopCallTimer()
      setTwilioReady(false)
    }
  }, [profile?.id, currentRep, stopCallTimer])

  const makeCall = useCallback(async (number, meta = {}) => {
    if (!deviceRef.current) { alert('Phone not ready yet'); return }
    if (callRef.current || connectingRef.current) {
      console.warn('Call already in progress — ignoring new dial')
      return
    }
    connectingRef.current = true
    try {
      try { deviceRef.current.disconnectAll?.() } catch {}
      const params = {
        To: number,
        identity: currentRep.replace(/[^a-zA-Z0-9_]/g, '_'),
        contactId: meta.contactId || '',
        contactName: meta.contactName || '',
      }
      const call = await deviceRef.current.connect({ params })
      callRef.current = call
      setCallStatus('calling')
      updateAgentStatus('On Call')
      wireCallEvents(call)
    } catch (err) {
      console.error('makeCall error:', err)
      setCallStatus(null)
    } finally {
      connectingRef.current = false
    }
  }, [currentRep, updateAgentStatus, wireCallEvents])

  // Answer. Callable from any page — the banner in the shell uses this.
  const acceptIncoming = useCallback(() => {
    if (!incomingCall?.call) return null
    const inc = incomingCall
    callRef.current = inc.call
    setCallStatus('connected')
    startCallTimer()
    updateAgentStatus('On Call')
    wireCallEvents(inc.call)
    inc.call.accept()
    setIncomingCall(null)
    setPendingInbound(inc)   // DialerPage turns this into a contact tab
    return inc
  }, [incomingCall, startCallTimer, updateAgentStatus, wireCallEvents])

  const rejectIncoming = useCallback(() => {
    if (!incomingCall?.call) return
    incomingCall.call.reject()
    setIncomingCall(null)
  }, [incomingCall])

  const hangUp = useCallback(() => {
    if (callRef.current) { callRef.current.disconnect(); callRef.current = null }
    setCallStatus('ended'); stopCallTimer()
    setTimeout(() => setCallStatus(null), 2000)
    updateAgentStatus('Wrap Up')
  }, [stopCallTimer, updateAgentStatus])

  return (
    <PhoneContext.Provider value={{
      twilioReady, incomingCall, callStatus, callDuration,
      makeCall, acceptIncoming, rejectIncoming, hangUp,
      pendingInbound, setPendingInbound,
      hasActiveCall: () => !!callRef.current,
    }}>
      {children}
    </PhoneContext.Provider>
  )
}

export const usePhone = () => useContext(PhoneContext)
