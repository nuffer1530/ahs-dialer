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

  // interactionType: omit to leave it untouched (wrap-up keeps showing what the
  // rep is wrapping), pass null to clear it, or a label to set it.
  const updateAgentStatus = useCallback(async (status, interactionType) => {
    if (!profile?.id) return
    const patch = { status, status_since: new Date().toISOString() }
    if (interactionType !== undefined) patch.interaction_type = interactionType
    await sb.from('profiles').update(patch).eq('id', profile.id)
    syncWorkerActivity(profile.id, status)
  }, [profile?.id])

  // Any engagement — a claimed lead, a text, an email — puts the rep On Call.
  // That's not just cosmetic: it also pulls them out of TaskRouter routing, so
  // an inbound call can't land on someone already working something.
  const startInteraction = useCallback((type) => {
    updateAgentStatus('On Call', type)
  }, [updateAgentStatus])

  // Auto wrap-up: after a call ends the rep gets 60s of Wrap Up, then is put
  // back to Available automatically — unless they change their status themselves
  // (e.g. re-select Wrap Up to keep wrapping), which cancels the auto-return.
  const WRAP_MS = 60_000
  const wrapTimerRef = useRef(null)
  const cancelAutoWrap = useCallback(() => {
    if (wrapTimerRef.current) { clearTimeout(wrapTimerRef.current); wrapTimerRef.current = null }
  }, [])
  const enterWrapUp = useCallback(() => {
    updateAgentStatus('Wrap Up')
    cancelAutoWrap()
    wrapTimerRef.current = setTimeout(() => { wrapTimerRef.current = null; updateAgentStatus('Available', null) }, WRAP_MS)
  }, [updateAgentStatus, cancelAutoWrap])

  const wireCallEvents = useCallback((call) => {
    call.on('ringing', () => setCallStatus('ringing'))
    call.on('accept', () => { setCallStatus('connected'); startCallTimer() })
    call.on('disconnect', () => {
      callRef.current = null; setCallStatus('ended'); stopCallTimer()
      setTimeout(() => setCallStatus(null), 3000); enterWrapUp()
    })
    call.on('error', () => {
      callRef.current = null; setCallStatus('ended'); stopCallTimer()
      setTimeout(() => setCallStatus(null), 2000)
    })
  }, [startCallTimer, stopCallTimer, enterWrapUp])

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
      cancelAutoWrap()
      setTwilioReady(false)
    }
  }, [profile?.id, currentRep, stopCallTimer])

  // Reconcile TaskRouter with reality, on a timer.
  //
  // Worker activity used to be driven only by status-change events, which is
  // one missed fetch away from broken: a rep shows Available in Andi, their
  // worker is still Offline, and TaskRouter silently never routes to them —
  // the caller just waits. Workers are also provisioned Offline, so a rep who
  // never touches the status pill would never receive a call at all.
  //
  // This reads the rep's real status and pushes it, so any drift self-heals
  // within a minute regardless of what did or didn't fire.
  useEffect(() => {
    if (!profile?.id || !twilioReady) return
    let stopped = false

    const reconcile = async () => {
      const { data } = await sb.from('profiles').select('status').eq('id', profile.id).maybeSingle()
      if (stopped || !data) return
      syncWorkerActivity(profile.id, data.status || 'Offline')
    }
    reconcile()                                   // immediately on register
    const t = setInterval(reconcile, 60_000)      // and keep it honest

    // A closed tab is an unreachable agent. Without this the worker stays
    // Available in TaskRouter and the queue keeps handing callers to a browser
    // that isn't there — they'd wait through a reservation timeout for nothing.
    // sendBeacon because a normal fetch is killed on unload.
    const goOffline = () => {
      try {
        navigator.sendBeacon?.('/api/twilio/worker-activity',
          new Blob([JSON.stringify({ profileId: profile.id, status: 'Offline' })],
            { type: 'application/json' }))
      } catch {}
    }
    window.addEventListener('pagehide', goOffline)
    return () => {
      stopped = true; clearInterval(t)
      window.removeEventListener('pagehide', goOffline)
    }
  }, [profile?.id, twilioReady])

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
      updateAgentStatus('On Call', meta.interactionType || 'Outbound')
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
    updateAgentStatus('On Call', 'Inbound')
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
    enterWrapUp()
  }, [stopCallTimer, enterWrapUp])

  return (
    <PhoneContext.Provider value={{
      twilioReady, incomingCall, callStatus, callDuration,
      makeCall, acceptIncoming, rejectIncoming, hangUp, cancelAutoWrap, startInteraction,
      pendingInbound, setPendingInbound,
      hasActiveCall: () => !!callRef.current,
    }}>
      {children}
    </PhoneContext.Provider>
  )
}

export const usePhone = () => useContext(PhoneContext)
