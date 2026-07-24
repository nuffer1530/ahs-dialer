import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useData } from '../lib/DataContext'
import { useAuth } from '../lib/AuthContext'
import { sb } from '../lib/supabase'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import { isDone, isCallbackDueToday, getDupSet, normPhone, getInitials, fmtDate, fmtShort, syncWorkerActivity } from '../lib/utils'
import { usePhone } from '../lib/PhoneContext'
import QueueSelector from '../components/QueueSelector'
import LeadsRail from '../components/LeadsRail'
import { useOpenLeads } from '../lib/useOpenLeads'
import { OUTCOMES, INBOUND_OUTCOMES, MAX_ATTEMPTS, DONE_OUTCOMES } from '../lib/constants'
import { RichText } from '../components/RichTextEditor'

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

OUTCOME_ICONS['Rescheduled'] = (color) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <rect x="3" y="4" width="18" height="17" rx="2" stroke={color} strokeWidth="1.8" fill="none"/>
    <path d="M16 2v4M8 2v4M3 10h18" stroke={color} strokeWidth="1.8" strokeLinecap="round"/>
    <path d="M9 15.5a3 3 0 105.6-1.5" stroke={color} strokeWidth="1.6" strokeLinecap="round" fill="none"/>
    <path d="M15 12v2.2h-2.2" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
OUTCOME_ICONS['Canceled Appt'] = (color) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <rect x="3" y="4" width="18" height="17" rx="2" stroke={color} strokeWidth="1.8" fill="none"/>
    <path d="M16 2v4M8 2v4M3 10h18" stroke={color} strokeWidth="1.8" strokeLinecap="round"/>
    <path d="M9.5 13.5l5 5M14.5 13.5l-5 5" stroke={color} strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
)
OUTCOME_ICONS['Question / Info'] = (color) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <path d="M21 12a8 8 0 01-8 8H8l-5 2 1.5-4.5A8 8 0 1121 12z" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    <path d="M10.5 10a1.8 1.8 0 113 1.2c-.7.6-1.3 1-1.3 1.8" stroke={color} strokeWidth="1.6" strokeLinecap="round" fill="none"/>
    <circle cx="12.2" cy="15.6" r="0.9" fill={color}/>
  </svg>
)
OUTCOME_ICONS['Not Booked - Price'] = (color) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.8" fill="none"/>
    <path d="M12 6.5v11M14.6 8.8c-.5-.9-1.5-1.3-2.6-1.3-1.5 0-2.6.8-2.6 2s1 1.8 2.6 2.1c1.7.3 2.8 1 2.8 2.3s-1.2 2.1-2.8 2.1c-1.2 0-2.3-.5-2.8-1.4" stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none"/>
  </svg>
)
OUTCOME_ICONS['Wrong Number'] = (color) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    <path d="M16 5l4 4M20 5l-4 4" stroke={color} strokeWidth="1.7" strokeLinecap="round"/>
  </svg>
)

const OUTCOME_CONFIG = {
  'No Answer':      { border:'#C87800', bg:'#FFF8E6', color:'#C87800' },
  'Voicemail':      { border:'#7C3AED', bg:'#F3E8FF', color:'#7C3AED' },
  'Booked':         { border:'#16A34A', bg:'#DCFCE7', color:'#16A34A' },
  'Not Interested': { border:'#DC2626', bg:'#FEE2E2', color:'#DC2626' },
  'DNC':            { border:'#7F1D1D', bg:'#FEF2F2', color:'#7F1D1D' },
  'Bad Data':       { border:'#6B7280', bg:'#F3F4F6', color:'#6B7280' },
  'Rescheduled':    { border:'#2563EB', bg:'#EFF6FF', color:'#2563EB' },
  'Canceled Appt':  { border:'#C87800', bg:'#FFF8E6', color:'#C87800' },
  'Question / Info':{ border:'#0891B2', bg:'#ECFEFF', color:'#0891B2' },
  'Not Booked - Price': { border:'#DC2626', bg:'#FEE2E2', color:'#DC2626' },
  'Wrong Number':   { border:'#6B7280', bg:'#F3F4F6', color:'#6B7280' },
}

function SearchSelect({ label, value, onChange, options, placeholder, disabled }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [menuStyle, setMenuStyle] = useState({})
  const ref = useRef(null)
  const triggerRef = useRef(null)
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    // Close on outside scroll/resize so the fixed menu never detaches from its field.
    const onScrollOrResize = (e) => { if (ref.current && e && e.target && ref.current.contains(e.target)) return; setOpen(false) }
    document.addEventListener('mousedown', handler)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      document.removeEventListener('mousedown', handler)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [])
  const positionMenu = () => {
    if (!triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    const openUp = spaceBelow < 260 && spaceAbove > spaceBelow
    const maxHeight = Math.max(140, Math.min(260, (openUp ? spaceAbove : spaceBelow) - 12))
    setMenuStyle({
      position: 'fixed',
      left: Math.round(r.left),
      width: Math.round(r.width),
      maxHeight,
      ...(openUp ? { bottom: Math.round(window.innerHeight - r.top + 4) } : { top: Math.round(r.bottom + 4) }),
    })
  }
  const toggle = () => {
    if (disabled) return
    setOpen(v => {
      const next = !v
      if (next) positionMenu()
      return next
    })
  }
  const hits = options.filter(o => o.label.toLowerCase().includes(q.toLowerCase()))
  const sel = options.find(o => String(o.value) === String(value))
  return (
    <div ref={ref} style={{ position:'relative' }}>
      {label && <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:4 }}>{label}</div>}
      <div ref={triggerRef} onClick={toggle}
        style={{ border:`1px solid ${open ? 'var(--accent)' : 'var(--border)'}`, borderRadius:'var(--radius)', padding:'7px 10px', fontSize:12, background:'var(--surface)', color: sel ? 'var(--text-primary)' : 'var(--text-muted)', cursor: disabled ? 'default' : 'pointer', display:'flex', justifyContent:'space-between', alignItems:'center', userSelect:'none', opacity: disabled ? .5 : 1 }}>
        <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{sel?.label || placeholder}</span>
        <span style={{ fontSize:10, marginLeft:4, color:'var(--text-muted)', flexShrink:0 }}>v</span>
      </div>
      {open && (
        <div style={{ ...menuStyle, zIndex:4000, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 4px 20px rgba(0,0,0,.15)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
          <div style={{ padding:'5px 8px', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} onClick={e => e.stopPropagation()}
              placeholder="Search..." style={{ width:'100%', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'4px 8px', fontSize:11, background:'var(--surface-2)', color:'var(--text-primary)' }} />
          </div>
          <div style={{ overflowY:'auto', flex:1 }}>
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

export default function DialerPage() {
  const { contacts, setContacts, campaigns, dncSet } = useData()
  const { profile } = useAuth()
  const currentRep = profile?.name || profile?.email || 'Unknown'

  // Queue & contact state
  const [selectedId, setSelectedId] = useState(null)
  const [openTabIds, setOpenTabIds] = useState([])
  const MAX_TABS = 3
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
  const openLeadCount = useOpenLeads()
  const [todayLogs, setTodayLogs] = useState([])
  const [powerDialActive, setPowerDialActive] = useState(false)
  const [alsoMembership, setAlsoMembership] = useState(false)
  const [membershipTypeId, setMembershipTypeId] = useState('')
  const [sellableMemberships, setSellableMemberships] = useState([])
  const [membershipMsg, setMembershipMsg] = useState('')
  const [dailyEarnings, setDailyEarnings] = useState(0)
  const [weeklyEarnings, setWeeklyEarnings] = useState(0)
  const [showCommPop, setShowCommPop] = useState(false)
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
  const [guidance, setGuidance] = useState(null)   // dispatch-brain read of THIS call
  const [availWeekOffset, setAvailWeekOffset] = useState(0)
  const [stLoading, setStLoading] = useState(false)

  // ST global search
  const [stSearch, setStSearch] = useState('')
  const [stSearchResults, setStSearchResults] = useState([])
  const [stSearchLoading, setStSearchLoading] = useState(false)
  const [stSearchOpen, setStSearchOpen] = useState(false)
  const stSearchRef = useRef(null)

  // Text / Email
  const [showTextModal, setShowTextModal] = useState(false)
  const [textBody, setTextBody] = useState('')
  const [textSending, setTextSending] = useState(false)
  const [textResult, setTextResult] = useState(null)

  // Send note to ST
  const [stNoteSending, setStNoteSending] = useState(false)
  const [stNoteResult, setStNoteResult] = useState(null)
  // Wrap-up autopilot: the server drafts notes from the call recording; we
  // poll briefly after hangup and pre-fill the notes box (never overwriting
  // anything the rep already typed — a button offers the draft instead).
  const [autoNote, setAutoNote] = useState(null)   // { contactId, text }
  const prevCallStatus = useRef(null)

  // Twilio — the phone lives in PhoneContext (mounted in DialerLayout) so it
  // survives navigation. It used to be created here, which meant leaving the
  // dialer destroyed the Device and inbound calls could not be answered.
  const {
    twilioReady, callStatus, callDuration, incomingCall,
    makeCall: phoneMakeCall, hangUp, startInteraction, endInteraction,
    pendingInbound, setPendingInbound, callDirection,
  } = usePhone()

  // Skills-based outbound routing. When the rep has selected active campaigns
  // (via the Queues selector), Next / auto-advance serve leads from those
  // campaigns in the admin-set priority order, instead of the blended pool.
  const [repCampPriority, setRepCampPriority] = useState([]) // [{campaign_id, priority}] granted, ordered
  useEffect(() => {
    if (!profile?.id) { setRepCampPriority([]); return }
    sb.from('csr_campaigns').select('campaign_id, priority').eq('profile_id', profile.id).eq('active', true)
      .then(({ data }) => setRepCampPriority((data || []).sort((a, b) => a.priority - b.priority)))
  }, [profile?.id])

  const activeCampOrder = useMemo(() => {
    const ids = Array.isArray(profile?.active_campaign_ids) ? profile.active_campaign_ids : []
    return repCampPriority.filter(p => ids.includes(p.campaign_id)).map(p => p.campaign_id)
  }, [profile?.active_campaign_ids, repCampPriority])
  const skillsMode = activeCampOrder.length > 0

  // Next lead under skills routing: today's callbacks first, then the oldest
  // unclaimed lead from the highest-priority active campaign.
  const nextSkillLead = useCallback(() => {
    const workable = c => !isDone(c) && c.status !== 'Max Attempts' && !c.claimed_by
    const byOldest = (a, b) => new Date(a.created_at) - new Date(b.created_at)
    const inActive = contacts.filter(c => activeCampOrder.includes(c.campaign_id) && workable(c))
    const cb = inActive.filter(c => isCallbackDueToday(c)).sort(byOldest)
    if (cb.length) return cb[0]
    for (const campId of activeCampOrder) {
      const lead = inActive.filter(c => c.campaign_id === campId).sort(byOldest)[0]
      if (lead) return lead
    }
    return null
  }, [contacts, activeCampOrder])

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
      // No auto-default: campaign stays blank until the CSR selects one (required to book)

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

  // Reset per-contact: a membership selection left over from the previous
  // customer must never carry into the next one — and neither can the booking
  // panel. Rebooking a customer used to reopen with the LAST booking's BU,
  // job type and time window still selected, one click from a wrong booking.
  const resetBookingPanel = () => {
    setSelectedBU(''); setSelectedJobType(''); setStCampaignId(null)
    setAvailability([]); setSelectedSlot(null); setAvailError(null)
    setShowAvailModal(false); setAvailWeekOffset(0); setGuidance(null)
  }
  useEffect(() => {
    setNotesVal(''); setBookingResult(null); setSelectedOutcome(null)
    setAlsoMembership(false); setMembershipTypeId(''); setMembershipMsg('')
    resetBookingPanel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  // Restore open tabs + active tab on mount (survives refresh)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('andi_open_tabs')
      const active = sessionStorage.getItem('andi_active_tab')
      if (raw) {
        const ids = JSON.parse(raw)
        if (Array.isArray(ids) && ids.length) {
          const trimmed = ids.slice(0, MAX_TABS)
          setOpenTabIds(trimmed)
          const act = trimmed.find(x => String(x) === String(active))
          setSelectedId(act ?? trimmed[0])
        }
      }
    } catch {}
  }, [])

  // Persist tabs whenever they change
  useEffect(() => {
    try {
      sessionStorage.setItem('andi_open_tabs', JSON.stringify(openTabIds))
      if (selectedId != null) sessionStorage.setItem('andi_active_tab', String(selectedId))
      else sessionStorage.removeItem('andi_active_tab')
    } catch {}
  }, [openTabIds, selectedId])

  useEffect(() => {
    if (!currentRep) return
    const today = new Date().toISOString().split('T')[0]
    sb.from('call_logs').select('*').eq('rep', currentRep)
      .gte('created_at', today + 'T00:00:00').lte('created_at', today + 'T23:59:59')
      .then(({ data }) => setTodayLogs(data || []))
  }, [currentRep])

  // Membership types a rep can actually sell — an admin has mapped each of
  // these to a ServiceTitan sale task and term. Unmapped types can't be sold.
  useEffect(() => {
    sb.from('membership_type_spiffs')
      .select('st_membership_type_id, name, sale_task_id, duration_billing_id')
      .not('sale_task_id', 'is', null)
      .not('duration_billing_id', 'is', null)
      .then(({ data }) => setSellableMemberships(data || []))
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


  const fmtDuration = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`

  // Status changes all route through PhoneContext (startInteraction /
  // endInteraction / the call paths) — no local status writer, so there is
  // exactly one place that owns the status + interaction_type contract.

  // Answering happens in the shell's incoming-call banner (PhoneContext), so it
  // works on every page. What stays here is turning the answered caller into an
  // open tab — that needs the dialer's own state, so the provider hands it over
  // via pendingInbound.
  useEffect(() => {
    if (!pendingInbound) return
    const inc = pendingInbound
    setPendingInbound(null)
    resolveInboundContact(inc)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInbound])

  const resolveInboundContact = async (inc) => {
    // Case 1: already a local contact — just select it
    if (inc.contactId) { selectContact(inc.contactId); claimContactById(inc.contactId); return }

    // Case 2: found in ST but not local — create the contact so booking/history work
    const st = inc.stLookup
    if (st && st !== 'loading' && st !== 'none' && st.found) {
      const { data: created } = await sb.from('contacts').insert({
        name: st.name || 'Unknown caller',
        phone: inc.from,
        email: st.email || null,
        address: st.address || null,
        city: st.city || null,
        state: st.state || null,
        zip: st.zip || null,
        external_id: String(st.customerId),
        status: 'Pending',
        attempts: 0,
        source: 'Inbound call',
        claimed_by: currentRep,
        claimed_at: new Date().toISOString(),
      }).select().single()
      if (created) {
        setContacts(prev => [created, ...prev])
        selectContact(created.id)
      }
      return
    }

    // Case 3: unknown caller — create a bare contact so the CSR can still log the call
    const { data: created } = await sb.from('contacts').insert({
      name: 'Unknown caller',
      phone: inc.from,
      status: 'Pending',
      attempts: 0,
      source: 'Inbound call',
      claimed_by: currentRep,
      claimed_at: new Date().toISOString(),
    }).select().single()
    if (created) {
      setContacts(prev => [created, ...prev])
      selectContact(created.id)
    }
  }

  const claimContactById = async (id) => {
    const { data } = await sb.from('contacts').update({ claimed_by: currentRep, claimed_at: new Date().toISOString() }).eq('id', id).select().single()
    if (data) setContacts(prev => prev.map(c => c.id === id ? data : c))
  }

  // Claim a lead AND release any others this rep still holds — a CSR works one
  // outbound lead at a time, so being auto-served the next one drops the last.
  // Without this, auto-claim accumulates locked leads the rep isn't working.
  const claimExclusive = async (id) => {
    const now = new Date().toISOString()
    setContacts(prev => prev.map(c =>
      c.id === id ? { ...c, claimed_by: currentRep, claimed_at: now }
      : (c.claimed_by === currentRep ? { ...c, claimed_by: null, claimed_at: null } : c)))
    await sb.from('contacts').update({ claimed_by: currentRep, claimed_at: now }).eq('id', id)
    await sb.from('contacts').update({ claimed_by: null, claimed_at: null }).eq('claimed_by', currentRep).neq('id', id)
  }


  // ── ST global search (debounced)
  useEffect(() => {
    if (!stSearch || stSearch.trim().length < 3) { setStSearchResults([]); return }
    const t = setTimeout(async () => {
      setStSearchLoading(true)
      try {
        const res = await fetch(`/api/st/search?q=${encodeURIComponent(stSearch.trim())}`)
        const data = await res.json()
        setStSearchResults(data?.data || [])
      } catch (e) { setStSearchResults([]) }
      finally { setStSearchLoading(false) }
    }, 400)
    return () => clearTimeout(t)
  }, [stSearch])

  // Close search dropdown on outside click
  useEffect(() => {
    const handler = (e) => { if (stSearchRef.current && !stSearchRef.current.contains(e.target)) setStSearchOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Open a ST customer from search — reuse existing contact or create one
  const openStCustomer = async (cust) => {
    setStSearch(''); setStSearchResults([]); setStSearchOpen(false)
    const existing = contacts.find(x => String(x.external_id) === String(cust.id))
    if (existing) { selectContact(existing.id); return }
    const { data: created } = await sb.from('contacts').insert({
      name: cust.name || 'Unknown',
      phone: cust.phone || null,
      email: cust.email || null,
      address: cust.address || null,
      city: cust.city || null,
      state: cust.state || null,
      zip: cust.zip || null,
      external_id: String(cust.id),
      status: 'Pending',
      attempts: 0,
      source: 'ST search',
    }).select().single()
    if (created) { setContacts(prev => [created, ...prev]); selectContact(created.id) }
  }

  // Customer tags: add/remove straight on the ST account. Heavy tags (DNC,
  // Do Not Service) get a confirm click before they fly.
  const [tagPicker, setTagPicker] = useState(false)
  const [tagCatalog, setTagCatalog] = useState(null)
  const [tagSearch, setTagSearch] = useState('')
  const [tagBusy, setTagBusy] = useState(false)
  const [tagErr, setTagErr] = useState('')
  const DANGER_TAG = /do not service|dnc|do not call/i
  const openTagPicker = async () => {
    setTagPicker(true); setTagSearch(''); setTagErr('')
    if (!tagCatalog) {
      try {
        const r = await fetch('/api/st/tag-types')
        const d = await r.json()
        setTagCatalog(d.tags || [])
      } catch { setTagCatalog([]) }
    }
  }
  const mutateTags = async (patch) => {
    if (!c?.external_id) return
    setTagBusy(true); setTagErr('')
    try {
      const r = await fetch(`/api/st/customer/${c.external_id}/tags`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Tag update failed')
      setStCustomerInfo(prev => (prev ? { ...prev, tags: d.tags } : prev))
    } catch (e) { setTagErr(e.message) }
    setTagBusy(false)
  }
  const addTag = async (t) => {
    if (DANGER_TAG.test(t.name) && !confirm(`"${t.name}" is a heavy tag — add it to this ServiceTitan account?`)) return
    await mutateTags({ add: [t.id] })
    setTagPicker(false)
  }
  const removeTag = async (t) => {
    if (DANGER_TAG.test(t.name) && !confirm(`Remove "${t.name}" from this ServiceTitan account?`)) return
    await mutateTags({ remove: [t.id] })
  }

  // Brand-new customer: create them in ServiceTitan without leaving Andi,
  // link (or create) the local contact, and the normal booking flow takes
  // over. forContactId links an existing unlinked contact instead.
  const [newCust, setNewCust] = useState(null)   // { name, phone, email, street, city, state, zip, forContactId }
  const [newCustBusy, setNewCustBusy] = useState(false)
  const [newCustErr, setNewCustErr] = useState('')
  const createStCustomer = async () => {
    if (!newCust) return
    setNewCustBusy(true); setNewCustErr('')
    try {
      const res = await fetch('/api/st/customer/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCust),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'ServiceTitan rejected the customer')
      if (newCust.forContactId) {
        const { data: upd } = await sb.from('contacts').update({ external_id: String(d.id) }).eq('id', newCust.forContactId).select().single()
        if (upd) setContacts(prev => prev.map(x => x.id === upd.id ? upd : x))
      } else {
        const { data: created } = await sb.from('contacts').insert({
          name: newCust.name, phone: newCust.phone || null, email: newCust.email || null,
          address: newCust.street || null, city: newCust.city || null, state: newCust.state || 'CO', zip: newCust.zip || null,
          external_id: String(d.id), status: 'Pending', attempts: 0, source: 'New customer (Andi)',
        }).select().single()
        if (created) { setContacts(prev => [created, ...prev]); selectContact(created.id) }
      }
      setNewCust(null)
    } catch (e) { setNewCustErr(e.message) }
    setNewCustBusy(false)
  }

  // Send SMS
  const sendText = async () => {
    const contact = selectedContact
    if (!contact?.phone || !textBody.trim()) return
    setTextSending(true); setTextResult(null)
    try {
      const res = await fetch('/api/twilio/sms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: contact.phone, body: textBody.trim(), repName: currentRep, contactId: contact.id })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to send')
      setTextResult({ ok: true })
      setTextBody('')
      startInteraction?.('Text')
      setTimeout(() => { setShowTextModal(false); setTextResult(null) }, 1200)
    } catch (e) {
      setTextResult({ ok: false, error: e.message })
    } finally { setTextSending(false) }
  }

  // Email via mailto
  const sendEmail = () => {
    const contact = selectedContact
    const email = stCustomerInfo?.email || contact?.email
    if (!email) { alert('No email on file for this customer.'); return }
    const subject = encodeURIComponent('Awesome Home Services')
    const body = encodeURIComponent(`Hi ${contact?.name || ''},\n\n`)
    window.open(`mailto:${email}?subject=${subject}&body=${body}`, '_blank')
    startInteraction?.('Email')
  }

  // Send the current notes to the ST location record
  const sendNoteToST = async () => {
    const contact = selectedContact
    if (!contact?.external_id || !notesVal.trim()) return
    setStNoteSending(true); setStNoteResult(null)
    try {
      const res = await fetch('/api/st/note', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: contact.external_id, note: notesVal.trim(), repName: currentRep })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to send note')
      setStNoteResult({ ok: true })
      setTimeout(() => setStNoteResult(null), 2500)
    } catch (e) {
      setStNoteResult({ ok: false, error: e.message })
    } finally { setStNoteSending(false) }
  }

  const makeCall = async (number) => {
    phoneMakeCall(number, { contactId: selectedId || '', contactName: selectedContact?.name || '' })
  }


  // Tabs: open/focus a customer in a tab (max 3). At max, replace the active tab.
  const openTab = (id) => {
    if (!id) return
    setOpenTabIds(prev => {
      if (prev.includes(id)) return prev
      if (prev.length < MAX_TABS) return [...prev, id]
      return prev.map(x => x === selectedId ? id : x)
    })
    setSelectedId(id); setSelectedOutcome(null)
  }
  // Queue navigation: replace the ACTIVE tab's customer in place (no new tab).
  const navigateActiveTo = (id) => {
    if (!id) return
    setOpenTabIds(prev => {
      if (!prev.length) return [id]
      if (prev.includes(id)) return prev
      return prev.map(x => x === selectedId ? id : x)
    })
    setSelectedId(id); setSelectedOutcome(null)
  }
  const closeTab = (id, e) => {
    if (e) e.stopPropagation()
    const idx = openTabIds.indexOf(id)
    const next = openTabIds.filter(x => x !== id)
    setOpenTabIds(next)
    if (id === selectedId) {
      const neighbor = next[idx] ?? next[idx - 1] ?? next[0] ?? null
      setSelectedId(neighbor); setSelectedOutcome(null)
    }
    // Closed the last tab with no live call: not working anything anymore.
    // Without this, pulling work (On Call) then closing it without dialing or
    // dispositioning leaves the rep stuck On Call. endInteraction defers to
    // the call path when a call is actually up.
    if (next.length === 0) endInteraction?.()
  }
  // Explicit selection (queue click, search, inbound pop) opens/focuses a tab.
  const selectContact = (id) => openTab(id)
  // Serve a lead and, when it was routed to the rep by skills, claim it to them
  // automatically — an auto-served outbound lead is theirs, no Claim click.
  const serveLead = (contact, claim) => {
    if (!contact) return false
    navigateActiveTo(contact.id)
    // Exclusive: claiming the served lead releases any the rep was still holding.
    if (claim && contact.claimed_by !== currentRep) claimExclusive(contact.id)
    return true
  }

  // Open a contact that was just created server-side (promoted from a lead).
  // It must be seeded into DataContext first: the realtime INSERT that normally
  // delivers new contacts hasn't arrived yet, and selecting an id that isn't in
  // `contacts` renders an empty customer tab.
  const openPromotedContact = (contact) => {
    if (!contact?.id) return
    setContacts(prev => prev.some(c => c.id === contact.id) ? prev : [...prev, contact])
    navigateActiveTo(contact.id)
    // Claiming a paid lead is real work — go On Call so the floor sees it and
    // TaskRouter stops routing inbound here while it's being worked.
    startInteraction?.('Lead')
  }

  // Paid leads jump the queue. A $52 Angi lead is being called by competitors
  // right now; an outbound contact has been waiting a week and can wait five
  // more minutes. Putting this here (rather than only in the rail) means it
  // works even for a rep who never looks at the sidebar — "Next pending" is
  // what actually drives their day.
  const navNextPending = async () => {
    try {
      const { data: lead } = await sb.from('st_leads').select('id')
        .is('resolved_at', null).is('claimed_by', null)
        .order('submitted_at', { ascending: true }).limit(1).maybeSingle()
      if (lead) {
        const c = await fetch(`/api/leads/${lead.id}/claim`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rep: currentRep }),
        })
        if (c.ok) {
          const p = await fetch(`/api/leads/${lead.id}/promote`, { method: 'POST' })
          const pd = await p.json().catch(() => ({}))
          if (p.ok && pd.contactId) {
            openPromotedContact(pd.contact || { id: pd.contactId })
            return
          }
        }
        // Lost the race or ST closed it — fall through to normal queue.
      }
    } catch (e) { console.warn('lead-first next pending failed:', e.message) }

    // Rep deliberately pulled outbound work — that's an interaction starting.
    // (The idle auto-advance effect below stays silent on purpose: it pre-loads
    // work while the rep waits, and flipping them On Call there would make
    // every idle rep permanently invisible to inbound routing.)
    if (skillsMode) {
      if (serveLead(nextSkillLead(), true)) startInteraction?.('Outbound')
      return
    }
    const next = filtered.find(x => !isDone(x) && x.status !== 'Max Attempts' && !x.claimed_by)
    if (next) { navigateActiveTo(next.id); startInteraction?.('Outbound') }
  }

  // Auto-progressive: when a skills-routed rep is free and nothing's loaded,
  // pull their next lead automatically and claim it. Inbound wins — never
  // advance while an inbound call is ringing or in progress.
  useEffect(() => {
    if (!skillsMode) return
    if (incomingCall || callStatus) return
    if (profile?.status !== 'Available') return
    if (selectedContact && !isDone(selectedContact)) return
    serveLead(nextSkillLead(), true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillsMode, incomingCall, callStatus, profile?.status, selectedContact, nextSkillLead])

  const claimContact = async () => {
    if (!selectedContact || selectedContact.claimed_by) return
    const { data } = await sb.from('contacts').update({ claimed_by: currentRep, claimed_at: new Date().toISOString() }).eq('id', selectedId).select().single()
    if (data) {
      setContacts(prev => prev.map(c => c.id === selectedId ? data : c))
      // A manual claim means "I'm working this now" — flip status, typed by
      // what was claimed. Only the MANUAL button does this; the auto-claim
      // paths (claimContactById / claimExclusive from auto-advance) stay
      // silent so idle reps remain visible to inbound routing.
      const campName = campaigns.find(x => x.id === data.campaign_id)?.name
      startInteraction?.(campName === 'Leads' ? 'Lead' : 'Outbound')
    }
  }

  const releaseContact = async (id) => {
    const { data } = await sb.from('contacts').update({ claimed_by: null, claimed_at: null }).eq('id', id).select().single()
    if (data) setContacts(prev => prev.map(c => c.id === id ? data : c))
    endInteraction?.()   // letting it go means you're no longer working it
  }

  // Poll for drafted notes DURING the call (live transcription updates every
  // ~20s) and for a minute after hangup (the Whisper final pass).
  useEffect(() => {
    const was = prevCallStatus.current
    prevCallStatus.current = callStatus
    const live = callStatus === 'connected' || callStatus === 'calling'
    const justEnded = (was === 'connected' || was === 'calling') && (callStatus === 'ended' || callStatus === null)
    if ((!live && !justEnded) || !selectedId) return
    const cid = selectedId
    const cphone = (contacts.find(x => x.id === cid)?.phone) || ''
    let tries = 0
    const t = setInterval(async () => {
      if (justEnded && ++tries > 15) { clearInterval(t); return }   // post-call: give up after ~60s
      try {
        const r = await fetch(`/api/call-notes/latest?contactId=${cid}&phone=${encodeURIComponent(cphone)}`)
        const d = await r.json()
        if (d?.text) setAutoNote(prev => (prev?.text === d.text ? prev : { contactId: cid, text: d.text, at: d.at }))
      } catch {}
    }, live ? 6000 : 4000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callStatus])

  // Fill when the box is empty OR still holds the previous auto-draft — the
  // moment the rep types their own words, we stop touching the box and the
  // banner offers the newest draft instead.
  const lastAutoRef = useRef('')
  useEffect(() => {
    if (!autoNote || autoNote.contactId !== selectedId) return
    if (!notesVal.trim() || notesVal === lastAutoRef.current) {
      setNotesVal(autoNote.text)
      lastAutoRef.current = autoNote.text
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoNote])

  const logOutcome = async (stay) => {
    if (!selectedOutcome || !selectedContact) return
    const c = selectedContact
    const notes = notesVal.trim()
    if (selectedOutcome === 'Booked' && !notes) { alert('Please add notes before booking.'); return }
    const isCampaignContact = !!c.campaign_id
    const newAttempts = isCampaignContact ? (c.attempts || 0) + 1 : (c.attempts || 0)
    const isFinal = DONE_OUTCOMES.includes(selectedOutcome) || (isCampaignContact && newAttempts >= MAX_ATTEMPTS)
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

      // Sync notes to ST customer record. NOT on a booking: /api/st/book
      // already posts the same notes as its own location note, so this
      // second write duplicated every booking note in ST.
      if (notes && c.external_id && selectedOutcome !== 'Booked') {
        fetch('/api/st/note', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: c.external_id, note: `${selectedOutcome}: ${notes}`, repName: currentRep })
        }).catch(err => console.warn('ST note sync failed:', err))
      }

      // Commissions are no longer written here. A rep is paid when ServiceTitan
      // reports the job Completed, at the amount tagged against the job type —
      // syncCommissions() in server.js owns the commissions table and keys off
      // the andi_bookings row written by /api/st/book. Writing a flat rate here
      // too would double-pay every booking.
      if (selectedOutcome === 'Booked') { setAlsoMembership(false); setMembershipTypeId('') }

      // Disposition ends the interaction → wrap-up (60s, then auto-Available).
      // If the call's own hangup already put us in Wrap Up, endInteraction
      // leaves that wrap (and its timer) untouched.
      setSelectedOutcome(null); setNotesVal(''); resetBookingPanel(); endInteraction?.()
      const { data: logs } = await sb.from('call_logs').select('*').eq('contact_id', c.id).order('created_at', { ascending: false })
      setContactLogs(logs || [])

      if (!stay) {
        const nextContact = skillsMode
          ? nextSkillLead()
          : filtered.slice(selectedIdx + 1).find(x => !isDone(x) && x.status !== 'Max Attempts')
        if (nextContact) serveLead(nextContact, skillsMode)   // claim only under skills routing
        else { closeTab(selectedId) }
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
      // Same moment, two brains: the window grid AND the dispatch read of
      // this exact call (notes -> opportunity, best tech, urgency).
      const jtName = (jtOptions.find(o => String(o.value) === String(selectedJobType)) || {}).label || ''
      const addr = [c?.address, c?.city, c?.state, c?.zip].filter(Boolean).join(', ')
      const [res, g] = await Promise.all([
        fetch(`/api/st/availability?${params}`),
        fetch('/api/booking/guidance', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobType: jtName, address: addr, notes: notesVal }),
        }).then(r => (r.ok ? r.json() : null)).catch(() => null),
      ])
      setGuidance(g && g.urgency ? g : null)
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


  const GuidanceBanner = ({ compact }) => {
    if (!guidance) return null
    const isToday = guidance.urgency === 'today'
    const isSoon = guidance.urgency === 'soon'
    const bg = isToday ? '#FEF2F2' : isSoon ? '#FFFBEB' : 'var(--surface-2)'
    const border = isToday ? '#FCA5A5' : isSoon ? '#FCD34D' : 'var(--border)'
    const color = isToday ? '#991B1B' : isSoon ? '#92400E' : 'var(--text-secondary)'
    return (
      <div style={{ background:bg, border:`1px solid ${border}`, borderRadius:'var(--radius)', padding: compact ? '8px 12px' : '10px 14px', fontSize:12, color, lineHeight:1.5 }}>
        <span style={{ fontWeight:700 }}>
          {isToday ? '\ud83d\udd25 High opportunity \u2014 worth getting on the board TODAY.'
            : isSoon ? 'Solid opportunity \u2014 book the earliest window that works.'
            : 'Routine call \u2014 use the next best available window.'}
        </span>
        {guidance.reasons?.length > 0 && <span> {guidance.reasons.join(' \u00b7 ')}.</span>}
        {isToday && <span> If you don't see availability today, <b>reach out to dispatch</b> — they'll move things around.</span>}
      </div>
    )
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

  // ST Direct Booking — returns true on success, false otherwise
  const bookInST = async () => {
    const c = selectedContact
    if (!c?.external_id) { alert('No ST Customer ID on this contact. Please link to ST first.'); return false }
    if (!selectedJobType || !selectedBU) { alert('Please select a job type and business unit.'); return false }
    if (!stCampaignId) { alert('Please select a marketing campaign — it is required to book.'); return false }
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
          andiRec: guidance?.urgency === 'today'
            ? `Andi: HIGH OPPORTUNITY \u2014 keep this on the board today${guidance.reasons?.length ? ` (${guidance.reasons.join(' \u00b7 ')})` : ''}`
            : null,
        })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Booking failed')
      setBookingResult({ ok: true, jobId: data.jobId, jobNumber: data.jobNumber })
      return true
    } catch (e) {
      setBookingResult({ ok: false, error: e.message })
      return false
    } finally { setBooking(false) }
  }

  // Sell the membership into ServiceTitan. Separate from booking on purpose: it
  // creates an invoice for the customer, so a failure here must not silently
  // roll into the booking, and a booking failure must not sell a membership.
  const sellMembership = async () => {
    const c = selectedContact
    if (!c?.external_id) { setMembershipMsg('Error: no ServiceTitan customer linked to this contact.'); return false }
    const type = sellableMemberships.find(m => String(m.st_membership_type_id) === String(membershipTypeId))
    if (!type) { setMembershipMsg('Error: pick a membership.'); return false }

    if (!confirm(`Sell "${type.name}" to ${c.name || 'this customer'}?\n\nThis creates a real membership and a real invoice in ServiceTitan. It cannot be undone from Andi.`)) return false

    setMembershipMsg('Selling…')
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch('/api/st/membership/sell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ customerId: c.external_id, membershipTypeId: type.st_membership_type_id, contactId: c.id }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || `Sale failed (${res.status})`)
      setMembershipMsg(out.warning ? `✓ Sold — ${out.warning}` : `✓ ${type.name} sold (invoice ${out.invoiceId})`)
      return true
    } catch (e) {
      setMembershipMsg(`Error: ${e.message}`)
      return false
    }
  }

  // Booked flow: create the ST job, sell the membership if asked, then log.
  const bookAndLog = async () => {
    if (!notesVal.trim()) { alert('Please add call notes before booking.'); return }
    if (alsoMembership && !membershipTypeId) { alert('Pick which membership, or untick "Sell Membership?".'); return }
    const ok = await bookInST()
    if (!ok) return
    // Job booked. A membership failure from here shouldn't lose the booking —
    // the message stays on screen and the call still logs.
    if (alsoMembership && membershipTypeId) await sellMembership()
    await logOutcome(true)
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
  const isOutbound = !!c?.campaign_id
  const isMe = isOutbound ? (c?.claimed_by === currentRep) : true
  const isOther = isOutbound && c?.claimed_by && c.claimed_by !== currentRep
  // "Done" is a CAMPAIGN lifecycle concept — a lead worked to a final outcome.
  // A customer opened from ST search has no campaign: they can call back and
  // book another job next week, so their tab never locks. (Booking used to
  // mark them done forever, which blocked every rebook for that customer.)
  const done = c ? ((isDone(c) || c.status === 'Max Attempts') && !!c.campaign_id) : false
  const isDNC = c ? dncSet.has(normPhone(c.phone || '')) : false
  const isDup = c ? dupSet.has(c.id) : false
  const cbDue = contacts.filter(x => isCallbackDueToday(x) && !isDone(x))
  const camp = c ? campaigns.find(x => x.id === c.campaign_id) : null
  const myStats = { calls: todayLogs.length, booked: todayLogs.filter(x => x.outcome === 'Booked').length }


  // ST job history for the customer info panel
  const [stJobHistory, setStJobHistory] = useState([])
  const [stJobHistoryLoading, setStJobHistoryLoading] = useState(false)
  const [stCustomerInfo, setStCustomerInfo] = useState(null)
  // Inbound script/tips — the fallback whenever the customer isn't on a
  // campaign (inbound calls, ST-searched customers, paid leads with no
  // script of their own). Editable in Settings → Campaigns.
  const [inboundScript, setInboundScript] = useState(null)
  useEffect(() => {
    sb.from('app_settings').select('value').eq('key', 'inbound_script').maybeSingle()
      .then(({ data }) => { try { setInboundScript(JSON.parse(data?.value || 'null')) } catch {} })
  }, [])

  // Customer intelligence brief (AI synthesis of ST history)
  const [brief, setBrief] = useState(null)
  const [briefData, setBriefData] = useState(null)
  const [briefFacts, setBriefFacts] = useState(null)
  const [briefLoading, setBriefLoading] = useState(false)

  // Fetch ST customer info + job history + intelligence brief when contact changes
  useEffect(() => {
    if (!c?.external_id) {
      setStJobHistory([]); setStCustomerInfo(null)
      setBrief(null); setBriefData(null); setBriefFacts(null); setBriefLoading(false)
      return
    }
    setStJobHistoryLoading(true)
    // Always resolve the state, even on failure. A brand-new lead has no
    // ServiceTitan customer yet, so this 404s — and leaving the state null made
    // Email and Membership sit on "Loading..." forever.
    fetch(`/api/st/customer/${c.external_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => setStCustomerInfo(data || { notInSt: true }))
      .catch(() => setStCustomerInfo({ notInSt: true }))
    fetch(`/api/st/jobs?customerId=${c.external_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { setStJobHistory(data?.data?.slice(0,5) || []); setStJobHistoryLoading(false) })
      .catch(() => setStJobHistoryLoading(false))

    setBrief(null); setBriefData(null); setBriefFacts(null); setBriefLoading(true)
    fetch(`/api/st/intelligence/${c.external_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { setBrief(data?.brief || null); setBriefData(data?.brief_data || null); setBriefFacts(data?.facts || null); setBriefLoading(false) })
      .catch(() => setBriefLoading(false))
  }, [c?.external_id])

  const refreshBrief = () => {
    if (!c?.external_id || briefLoading) return
    setBriefLoading(true); setBrief(null); setBriefData(null)
    fetch(`/api/st/intelligence/${c.external_id}?refresh=1`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { setBrief(data?.brief || null); setBriefFacts(data?.facts || null); setBriefLoading(false) })
      .catch(() => setBriefLoading(false))
  }


  // SearchSelect component

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
      {/* The incoming-call UI lives in DialerLayout so it appears on every
          page, not just here. Rendering a second one locally showed the rep
          two Answer/Decline prompts at once. */}

      {/* == TOP BAR == */}
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 12px', background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
        {/* Collapse toggle. Carries a dot when leads are waiting — with the rail
            collapsed this button is the only thing on screen that could tell a
            rep a paid lead is sitting there. */}
        <button onClick={() => setQueueCollapsed(p => !p)}
          title={openLeadCount > 0 ? `${openLeadCount} paid lead${openLeadCount === 1 ? '' : 's'} waiting` : 'Show leads'}
          style={{ position:'relative', width:28, height:28, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, color:'var(--text-muted)', flexShrink:0 }}>
          {queueCollapsed ? '>' : '<'}
          {openLeadCount > 0 && (
            <span style={{ position:'absolute', top:-3, right:-3, minWidth:8, height:8, borderRadius:99, background:'var(--danger)', border:'1.5px solid var(--surface)' }} />
          )}
        </button>
        <button className="btn" disabled={selectedIdx <= 0} onClick={() => { const p = filtered[selectedIdx-1]; if(p) navigateActiveTo(p.id) }} style={{fontSize:11,padding:'4px 9px'}}>Prev</button>
        <button className="btn" disabled={selectedIdx >= filtered.length-1} onClick={() => { const n = filtered[selectedIdx+1]; if(n) navigateActiveTo(n.id) }} style={{fontSize:11,padding:'4px 9px'}}>Next</button>
        <button className="btn primary" onClick={navNextPending} style={{fontSize:11,padding:'4px 11px',fontWeight:600}}>Next pending</button>
        <QueueSelector />
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
        {/* ST GLOBAL SEARCH */}
        <div ref={stSearchRef} style={{ position:'relative', flex:1, maxWidth:380, marginLeft:8 }}>
          <div style={{ position:'relative' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', pointerEvents:'none' }}>
              <circle cx="11" cy="11" r="7" stroke="var(--text-muted)" strokeWidth="2"/>
              <path d="M20 20l-4-4" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <input value={stSearch}
              onChange={e => { setStSearch(e.target.value); setStSearchOpen(true) }}
              onFocus={() => setStSearchOpen(true)}
              placeholder="Search ServiceTitan by name, phone, or address..."
              style={{ width:'100%', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'6px 10px 6px 28px', fontSize:12, background:'var(--surface-2)', color:'var(--text-primary)' }} />
            {stSearchLoading && <div className="spinner" style={{ position:'absolute', right:9, top:'50%', transform:'translateY(-50%)', width:12, height:12, borderWidth:2 }} />}
          </div>
          {stSearchOpen && stSearch.trim().length >= 3 && (
            <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:500, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 4px 20px rgba(0,0,0,.15)', marginTop:3, maxHeight:340, overflowY:'auto' }}>
              {stSearchLoading ? (
                <div style={{ padding:'14px', textAlign:'center', fontSize:12, color:'var(--text-muted)' }}>Searching...</div>
              ) : stSearchResults.length === 0 ? (
                <div style={{ padding:'14px', textAlign:'center', fontSize:12, color:'var(--text-muted)' }}>No customers found</div>
              ) : stSearchResults.map(cust => (
                <div key={cust.id} onClick={() => openStCustomer(cust)}
                  style={{ padding:'9px 12px', borderBottom:'1px solid var(--border)', cursor:'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background='var(--accent-bg)'}
                  onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                  <div style={{ fontSize:12, fontWeight:600, color:'var(--text-primary)' }}>{cust.name}</div>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:1 }}>
                    {[cust.phone, [cust.address, cust.city].filter(Boolean).join(', ')].filter(Boolean).join(' . ')}
                  </div>
                </div>
              ))}
              {/* Always available — right person not in the list means new customer */}
              {!stSearchLoading && (
                <div onClick={() => {
                    const q = stSearch.trim()
                    const digits = q.replace(/\D/g, '')
                    setNewCustErr('')
                    setNewCust({ name: digits.length >= 7 ? '' : q, phone: digits.length >= 7 ? q : '', email: '', street: '', city: 'Colorado Springs', state: 'CO', zip: '' })
                    setStSearchOpen(false)
                  }}
                  style={{ padding:'9px 12px', cursor:'pointer', fontSize:12, fontWeight:600, color:'var(--accent)', display:'flex', alignItems:'center', gap:6, borderTop:'1px solid var(--border)', background:'var(--surface-2)', position:'sticky', bottom:0 }}
                  onMouseEnter={e => e.currentTarget.style.background='var(--accent-bg)'}
                  onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>
                  <span style={{ fontSize:14, lineHeight:1 }}>＋</span> Create new ServiceTitan customer
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ flex:1 }} />
        {cbDue.length > 0 && <div style={{ fontSize:11, fontWeight:600, color:'#C87800', padding:'3px 8px', background:'#FFFBEB', border:'1px solid #FCD34D', borderRadius:99 }}>CB: {cbDue.length}</div>}
      </div>

      {/* == BODY == */}
      <div style={{ flex:1, display:'flex', overflow:'hidden', minHeight:0 }}>

        {/* Lead inbox rail. The outbound contact list used to live here, but
            nobody scrolls 4,000 rows — reps work off "Next pending". This space
            is worth far more showing the handful of paid leads that are on a
            clock. Outbound contacts are still reachable via Next pending and
            the ServiceTitan search in the header. */}
        <aside style={{ width: queueCollapsed ? 0 : 232, minWidth: queueCollapsed ? 0 : 232, flexShrink:0, background:'var(--surface)', borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', overflow:'hidden', transition:'width .2s, min-width .2s' }}>
          <LeadsRail currentRep={currentRep} onOpenContact={openPromotedContact} />
        </aside>

        {/* == MAIN WORKSPACE == */}
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>

          {/* Customer tabs (up to 3 open at once) */}
          {openTabIds.length > 0 && (
            <div style={{ display:'flex', alignItems:'stretch', background:'var(--surface-2)', borderBottom:'1px solid var(--border)', flexShrink:0, overflowX:'auto' }}>
              {openTabIds.map(tid => {
                const tc = contacts.find(x => x.id === tid)
                const isActive = tid === selectedId
                return (
                  <div key={tid} onClick={() => { setSelectedId(tid); setSelectedOutcome(null) }}
                    style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px 7px 13px', cursor:'pointer', minWidth:120, maxWidth:200, flexShrink:0,
                      background: isActive ? 'var(--surface)' : 'transparent',
                      borderRight:'1px solid var(--border)',
                      borderTop: isActive ? '2px solid var(--accent)' : '2px solid transparent' }}>
                    <span style={{ fontSize:12, fontWeight: isActive ? 600 : 500, color: isActive ? 'var(--text-primary)' : 'var(--text-muted)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                      {tc?.name || 'Customer'}
                    </span>
                    <button onClick={(e) => closeTab(tid, e)} title="Close tab"
                      style={{ display:'flex', alignItems:'center', justifyContent:'center', width:16, height:16, borderRadius:4, border:'none', background:'transparent', cursor:'pointer', color:'var(--text-muted)', flexShrink:0, padding:0 }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                    </button>
                  </div>
                )
              })}
            </div>
          )}

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
            // minHeight:0 is load-bearing: without it this flex child grows to
            // content height and the grid below inherits a giant canvas — the
            // columns then never scroll, they just get clipped (Brittany's
            // tab-to-reach-booking bug).
            <div style={{ flex:1, minHeight:0, display:'flex', flexDirection:'column', overflow:'hidden' }}>

              {/* -- CONTACT HEADER -- */}
              <div style={{ padding:'10px 16px', background:'var(--surface)', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
                <div style={{ width:40, height:40, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:700, flexShrink:0 }}>
                  {getInitials(c.name)}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                    <span style={{ fontSize:15, fontWeight:700, color:'var(--text-primary)' }}>{c.name || '--'}</span>
                    {/* 'Pending' and 'Booked' are outbound-campaign lifecycle labels —
                        meaningless on a customer account now that Andi handles every
                        interaction type. Other statuses (callbacks, Max Attempts…)
                        still tell the rep something and stay. */}
                    {c.status && !['Pending', 'Booked'].includes(c.status) && <Badge status={c.status} />}
                    {isDNC && <span style={{ fontSize:10, fontWeight:700, background:'#FEE2E2', color:'#7F1D1D', border:'1px solid #FECACA', borderRadius:99, padding:'1px 6px' }}>DNC</span>}
                    {isDup && <span style={{ fontSize:10, fontWeight:700, background:'#F3E8FF', color:'#5B21B6', border:'1px solid #DDD6FE', borderRadius:99, padding:'1px 6px' }}>Duplicate</span>}
                    {campName(c) && <span style={{ fontSize:10, background:'var(--surface-2)', color:'var(--text-muted)', border:'1px solid var(--border)', borderRadius:99, padding:'1px 7px' }}>{campName(c)}</span>}
                    {/* ServiceTitan customer tags, in ST's own colors */}
                    {(stCustomerInfo?.tags || []).map((t, i) => (
                      <span key={`sttag-${i}`} title="ServiceTitan tag" style={{ fontSize:10, fontWeight:700, borderRadius:99, padding:'1px 4px 1px 7px',
                        background: `${t.color || '#888780'}1F`, color: t.color || 'var(--text-secondary)', border: `1px solid ${t.color || 'var(--border)'}`,
                        display:'inline-flex', alignItems:'center', gap:3 }}>
                        {t.name}
                        <span onClick={() => !tagBusy && removeTag(t)} title="Remove tag from the ST account"
                          style={{ cursor:'pointer', opacity:.55, fontSize:11, lineHeight:1, padding:'0 2px' }}
                          onMouseEnter={e => e.currentTarget.style.opacity = 1}
                          onMouseLeave={e => e.currentTarget.style.opacity = .55}>×</span>
                      </span>
                    ))}
                    {c.external_id && (
                      <span onClick={openTagPicker} title="Add a ServiceTitan tag"
                        style={{ fontSize:10, fontWeight:700, borderRadius:99, padding:'1px 8px', cursor:'pointer',
                          background:'var(--surface-2)', color:'var(--accent)', border:'1px dashed var(--accent)' }}>
                        + Tag
                      </span>
                    )}
                    {tagErr && <span style={{ fontSize:10, color:'var(--danger)' }}>{tagErr}</span>}
                  </div>
                  <div style={{ display:'flex', gap:16, marginTop:3 }}>
                    {[c.phone, c.email, [c.address,c.city,c.state].filter(Boolean).join(', ')].filter(Boolean).map((v,i) => (
                      <span key={i} style={{ fontSize:11, color:'var(--text-secondary)' }}>{v}</span>
                    ))}
                    <span style={{ fontSize:11, color:'var(--text-secondary)' }}>ST: {c.external_id || '--'}</span>
                    {/* Attempts is outbound-campaign lifecycle — hidden for paid
                        leads (the 'Leads' campaign) and ST-searched customers. */}
                    {isOutbound && campName(c) !== 'Leads' && <span style={{ fontSize:11, color:'var(--text-secondary)' }}>Attempts: {c.attempts||0}/{MAX_ATTEMPTS}</span>}
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
                  {c.phone && (
                    <button onClick={() => { setShowTextModal(true); setTextResult(null) }}
                      style={{ display:'flex', alignItems:'center', gap:5, padding:'7px 12px', border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:12, color:'var(--text-primary)' }}
                      title="Send text message">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M21 12a8 8 0 01-8 8H8l-5 2 1.5-4.5A8 8 0 1121 12z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      Text
                    </button>
                  )}
                  <button onClick={sendEmail} disabled={!stCustomerInfo?.email && !c.email}
                    style={{ display:'flex', alignItems:'center', gap:5, padding:'7px 12px', border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor: (stCustomerInfo?.email || c.email) ? 'pointer' : 'not-allowed', opacity: (stCustomerInfo?.email || c.email) ? 1 : .4, fontSize:12, color:'var(--text-primary)' }}
                    title="Send email">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" strokeWidth="1.8"/><path d="M2 7l10 6 10-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
                    Email
                  </button>
                  <button onClick={() => openInST(c)} style={{ padding:'7px 12px', border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:12, color:'var(--text-primary)' }}>Open in ST</button>
                  {isOutbound && !c.claimed_by && !done && <button className="btn sm primary" onClick={claimContact}>Claim</button>}
                  {isOutbound && isMe && c.claimed_by && !done && <button className="btn sm" onClick={() => releaseContact(c.id)}>Release</button>}
                  {isOther && <span style={{ fontSize:11, color:'var(--text-muted)' }}>Claimed by {c.claimed_by}</span>}
                </div>
              </div>

              {/* -- 3-COLUMN BODY -- */}
              <div style={{ flex:1, display:'grid', gridTemplateColumns:'300px 1fr 300px',
                // gridTemplateRows is the load-bearing part: without it the single
                // implicit row sizes to the TALLEST column's content and overflows
                // the container (which clips it) — so the columns never scroll, no
                // matter how their own overflow is set. minmax(0,1fr) pins the row
                // to the container's height and lets each column scroll itself.
                gridTemplateRows:'minmax(0, 1fr)', overflow:'hidden', minHeight:0 }}>

                {/* -- LEFT: Customer info + Job history -- */}
                <div style={{ borderRight:'1px solid var(--border)', overflowY:'auto', minHeight:0, background:'var(--surface-2)' }}>
                <div style={{ display:'flex', flexDirection:'column', gap:1 }}>

                  {/* Customer info card */}
                  <div style={sectionCard}>
                    <div style={sectionHeader}>
                      <span style={sectionTitle}>Customer info</span>
                      {stCustomerInfo?.membership && (
                        <span style={{ fontSize:10, fontWeight:700, borderRadius:99, padding:'2px 8px',
                          background: stCustomerInfo.membership.active ? '#DCFCE7' : '#F3F4F6',
                          color: stCustomerInfo.membership.active ? '#15803D' : '#6B7280',
                          border: `1px solid ${stCustomerInfo.membership.active ? '#86EFAC' : 'var(--border)'}` }}>
                          {stCustomerInfo.membership.active ? (stCustomerInfo.membership.name || 'Member') : 'Non-Member'}
                        </span>
                      )}
                    </div>
                    <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:10 }}>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                        <div><L text="Email" /><div style={{ fontSize:12, color:'var(--text-primary)', wordBreak:'break-all' }}>
                          {stCustomerInfo?.email || c.email || (c.external_id && !stCustomerInfo ? 'Loading...' : '--')}
                        </div></div>
                        <div><L text="Source" /><div style={{ fontSize:12, color:'var(--text-primary)' }}>{c.source || '--'}</div></div>
                        <div><L text="Membership" /><div style={{ fontSize:12, fontWeight:600,
                          color: stCustomerInfo?.membership?.active ? '#16A34A' : stCustomerInfo ? 'var(--text-muted)' : 'var(--text-muted)' }}>
                          {stCustomerInfo?.membership
                            ? (stCustomerInfo.membership.active ? (stCustomerInfo.membership.name || 'Active') : 'Non-Member')
                            : stCustomerInfo?.notInSt ? 'New — not in ST'
                            : c.external_id && !stCustomerInfo ? 'Loading...' : '--'}
                        </div></div>
                        <div><L text="Last service" /><div style={{ fontSize:12, color:'var(--text-primary)' }}>
                          {stJobHistory[0] ? fmtDate(stJobHistory[0].completedOn || stJobHistory[0].scheduledDate || stJobHistory[0].createdOn) : c.external_id ? (stJobHistoryLoading ? 'Loading...' : 'None found') : '--'}
                        </div></div>
                      </div>
                      <div>
                        <L text="Address" />
                        <div style={{ fontSize:12, color:'var(--text-primary)' }}>{[c.address,c.city,c.state,c.zip].filter(Boolean).join(', ') || '--'}</div>
                      </div>
                    </div>
                  </div>

                  {/* Intelligence brief — AI synthesis of ST customer history */}
                  <div style={{ ...sectionCard, marginTop:1, borderLeft:'3px solid var(--accent)' }}>
                    <div style={sectionHeader}>
                      <span style={sectionTitle}>Intelligence brief</span>
                      {c.external_id && (
                        <span onClick={refreshBrief}
                          title="Regenerate"
                          style={{ fontSize:10, color: briefLoading ? 'var(--text-muted)' : 'var(--accent)', cursor: briefLoading ? 'default' : 'pointer', display:'flex', alignItems:'center', gap:3 }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
                          Refresh
                        </span>
                      )}
                    </div>
                    <div style={{ padding:'12px 14px' }}>
                      {!c.external_id ? (
                        <div style={{ fontSize:12, color:'var(--text-muted)' }}>No ST ID -- no history to analyze.</div>
                      ) : briefLoading ? (
                        <div style={{ display:'flex', alignItems:'center', gap:10, color:'var(--text-muted)', fontSize:12 }}>
                          <div className="spinner" style={{ width:16, height:16 }} />
                          Analyzing customer history...
                        </div>
                      ) : (briefData || brief) ? (
                        <>
                          {/* Pinned staff notes verbatim (highest priority); else the model's flag */}
                          {Array.isArray(briefFacts?.pinnedNotes) && briefFacts.pinnedNotes.length > 0 ? (
                            <div style={{ marginBottom:10, display:'flex', flexDirection:'column', gap:6 }}>
                              {briefFacts.pinnedNotes.map((note, i) => (
                                <div key={i} style={{ background:'#FFFBEB', border:'1px solid #FCD34D', borderRadius:'var(--radius)', padding:'8px 10px', display:'flex', gap:7, alignItems:'flex-start' }}>
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#B45309" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0, marginTop:1 }}><path d="m12 2 1.5 6.5L20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5z"/></svg>
                                  <div style={{ fontSize:12, lineHeight:1.5, color:'#78350F', fontWeight:500 }}>{note}</div>
                                </div>
                              ))}
                            </div>
                          ) : briefData?.flag ? (
                            <div style={{ marginBottom:10, background:'#FFFBEB', border:'1px solid #FCD34D', borderRadius:'var(--radius)', padding:'8px 10px', display:'flex', gap:7, alignItems:'flex-start' }}>
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#B45309" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0, marginTop:1 }}><path d="m12 2 1.5 6.5L20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5z"/></svg>
                              <div style={{ fontSize:12, lineHeight:1.5, color:'#78350F', fontWeight:500 }}>{briefData.flag}</div>
                            </div>
                          ) : null}

                          {/* Structured brief: glanceable headline + prioritized actions */}
                          {briefData ? (
                            <>
                              {briefData.headline && (
                                <div style={{ fontSize:14, fontWeight:700, lineHeight:1.4, color:'var(--text-primary)' }}>{briefData.headline}</div>
                              )}
                              {Array.isArray(briefData.actions) && briefData.actions.length > 0 && (
                                <div style={{ display:'flex', flexDirection:'column', gap:8, marginTop: briefData.headline ? 11 : 0 }}>
                                  {briefData.actions.map((a, i) => (
                                    <div key={i} style={{ display:'flex', gap:9, alignItems:'flex-start' }}>
                                      <div style={{ width:17, height:17, borderRadius:5, background: i === 0 ? 'var(--accent)' : 'var(--accent-bg)', color: i === 0 ? '#fff' : 'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:1, fontSize:10, fontWeight:700 }}>{i + 1}</div>
                                      <div style={{ fontSize:13, lineHeight:1.45, color:'var(--text-primary)', fontWeight: i === 0 ? 600 : 500 }}>{a}</div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </>
                          ) : (
                            <div style={{ fontSize:13, lineHeight:1.65, color:'var(--text-primary)', whiteSpace:'pre-line' }}>{brief}</div>
                          )}

                          {briefFacts && (() => {
                            const chips = []
                            if (typeof briefFacts.lifetimeValue === 'number' && briefFacts.lifetimeValue > 0)
                              chips.push({ label:'LTV', value:`$${Math.round(briefFacts.lifetimeValue).toLocaleString()}` })
                            if (Array.isArray(briefFacts.equipment) && briefFacts.equipment.length) {
                              const oldest = briefFacts.equipment.filter(e => e.ageYears != null).sort((a,b) => b.ageYears - a.ageYears)[0]
                              if (oldest) chips.push({ label:oldest.name, value:`${oldest.ageYears}yr` })
                            }
                            if (briefFacts.openEstimates?.count)
                              chips.push({ label:'Open est.', value: briefFacts.openEstimates.total ? `${briefFacts.openEstimates.count} ($${Math.round(briefFacts.openEstimates.total).toLocaleString()})` : String(briefFacts.openEstimates.count) })
                            if (briefFacts.membership && briefFacts.membership !== 'Non-member')
                              chips.push({ label:'Member', value: briefFacts.membership })
                            if (briefFacts.maintenanceVisits?.dueCount > 0)
                              chips.push({ label:'Visits due', value: String(briefFacts.maintenanceVisits.dueCount), accent:true })
                            if (!briefFacts.isMember && briefFacts.memberSavings?.upTo > 0)
                              chips.push({ label:'Save up to', value:`$${Math.round(briefFacts.memberSavings.upTo).toLocaleString()}`, accent:true })
                            if (!chips.length) return null
                            return (
                              <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:12 }}>
                                {chips.map((ch, i) => (
                                  <span key={i} style={{ fontSize:10, fontWeight:600, background: ch.accent ? 'var(--accent-bg)' : 'var(--surface-2)', border:`1px solid ${ch.accent ? 'var(--accent)' : 'var(--border)'}`, borderRadius:99, padding:'3px 9px', color: ch.accent ? 'var(--accent)' : 'var(--text-secondary)' }}>
                                    <span style={{ color: ch.accent ? 'var(--accent)' : 'var(--text-muted)', fontWeight:500, opacity: ch.accent ? .85 : 1 }}>{ch.label}: </span>{ch.value}
                                  </span>
                                ))}
                              </div>
                            )
                          })()}
                        </>
                      ) : (
                        <div style={{ fontSize:12, color:'var(--text-muted)' }}>No brief available. Tap Refresh to generate one.</div>
                      )}
                    </div>
                  </div>

                  {/* Recent jobs — last 5 */}
                  <div style={{ ...sectionCard, marginTop:1, flex:1, display:'flex', flexDirection:'column', minHeight:0 }}>
                    <div style={sectionHeader}>
                      <span style={sectionTitle}>Recent jobs</span>
                      {c.external_id && <span onClick={() => openInST(c)} style={{ fontSize:10, color:'var(--accent)', cursor:'pointer' }}>View all in ST</span>}
                    </div>
                    <div style={{ padding:0, overflowY:'auto', flex:1 }}>
                      {!c.external_id ? (
                        <div style={{ padding:'14px', fontSize:12, color:'var(--text-muted)', textAlign:'center' }}>No ST ID -- can't load history</div>
                      ) : stJobHistoryLoading ? (
                        <div style={{ padding:'14px', display:'flex', justifyContent:'center' }}><div className="spinner" /></div>
                      ) : stJobHistory.length === 0 ? (
                        <div style={{ padding:'14px', fontSize:12, color:'var(--text-muted)', textAlign:'center' }}>No jobs found</div>
                      ) : stJobHistory.map((job, i) => {
                        const jobTypeName = job.jobType?.name || job.type?.name || job.jobTypeName || job.summary || 'Job'
                        const buName = job.businessUnit?.name || job.businessUnitName || ''
                        const jobDate = job.completedOn || job.scheduledDate || job.createdOn
                        const isComplete = (job.jobStatus || '').toLowerCase() === 'completed'
                        return (
                          <div key={job.id || i}
                            onClick={() => job.id && window.open(`https://go.servicetitan.com/#/Job/Index/${job.id}`, '_blank')}
                            style={{ padding:'10px 14px', borderBottom: i < stJobHistory.length-1 ? '1px solid var(--border)' : 'none', display:'flex', alignItems:'flex-start', gap:10, cursor: job.id ? 'pointer' : 'default', transition:'background .1s' }}
                            onMouseEnter={e => { if (job.id) e.currentTarget.style.background='var(--accent-bg)' }}
                            onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                            <div style={{ flex:1, minWidth:0 }}>
                              <div style={{ fontSize:12, fontWeight:600, color:'var(--text-primary)', marginBottom:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                                {jobTypeName}
                              </div>
                              <div style={{ fontSize:10, color:'var(--text-muted)' }}>
                                {buName}{job.jobNumber ? `${buName ? ' - ' : ''}#${job.jobNumber}` : ''}
                              </div>
                            </div>
                            <div style={{ textAlign:'right', flexShrink:0 }}>
                              <div style={{ fontSize:10, padding:'2px 7px', borderRadius:99, fontWeight:600, display:'inline-block',
                                background: isComplete ? '#DCFCE7' : '#F3F4F6',
                                color: isComplete ? '#15803D' : '#6B7280' }}>
                                {job.jobStatus || 'Unknown'}
                              </div>
                              <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:3 }}>{jobDate ? fmtDate(jobDate) : ''}</div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
                </div>

                {/* -- CENTER: Outcome + Booking -- */}
                {/* Two layers on purpose: the outer div ONLY scrolls; the inner
                    div does the flex stacking. When one div did both, a short
                    viewport made the flex children SHRINK (cards are
                    overflow:hidden, so they may compress to nothing) instead of
                    overflowing into the scrollbar — Brittany's scrunched panel. */}
                <div style={{ overflowY:'auto', minHeight:0 }}>
                <div style={{ padding:14, display:'flex', flexDirection:'column', gap:10 }}>

                  {/* Recent ST notes — what the last few touches on this account said,
                      right above where the rep decides what to do next. */}
                  {(stCustomerInfo?.notes || []).length > 0 && (
                    <div style={sectionCard}>
                      <div style={sectionHeader}>
                        <span style={sectionTitle}>Recent ServiceTitan notes</span>
                        <span style={{ fontSize:10, color:'var(--text-muted)' }}>latest {stCustomerInfo.notes.length}</span>
                      </div>
                      <div style={{ padding:'2px 12px 8px' }}>
                        {stCustomerInfo.notes.map((n, i) => (
                          <div key={i} style={{ padding:'7px 0', borderBottom: i < stCustomerInfo.notes.length - 1 ? '1px solid var(--border)' : 'none' }}>
                            <div style={{ fontSize:11.5, color:'var(--text-primary)', lineHeight:1.45, wordBreak:'break-word',
                              display:'-webkit-box', WebkitLineClamp:3, WebkitBoxOrient:'vertical', overflow:'hidden' }}>
                              {n.text}
                            </div>
                            {n.createdOn && <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:2 }}>{fmtDate(n.createdOn)}</div>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

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
                          <span style={sectionTitle}>{callDirection === 'inbound' ? 'Inbound call — book or classify' : 'Log outcome'}</span>
                          {isOther && <span style={{ fontSize:11, color:'var(--text-muted)' }}>Claimed by {c.claimed_by}</span>}
                        </div>
                        <div style={{ padding:12, display:'flex', flexDirection:'column', gap:10 }}>
                          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
                            {(callDirection === 'inbound' ? INBOUND_OUTCOMES : OUTCOMES).map(o => {
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
                          <div>
                            {autoNote && autoNote.contactId === selectedId && (
                              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, background:'#F3E8FF', border:'1px solid #DDD6FE', borderRadius:'var(--radius)', padding:'6px 10px', marginBottom:6, fontSize:11.5, color:'#5B21B6' }}>
                                <span>✨ {callStatus === 'connected' || callStatus === 'calling' ? 'Live notes — updating as the call goes' : 'Notes drafted from the call — review before saving.'}</span>
                                {notesVal.trim() !== autoNote.text && (
                                  <button className="btn sm" onClick={() => setNotesVal(autoNote.text)} style={{ flexShrink:0 }}>Use draft</button>
                                )}
                              </div>
                            )}
                            <textarea value={notesVal} onChange={e => setNotesVal(e.target.value)} disabled={!isMe}
                              placeholder={selectedOutcome === 'Booked' ? 'Notes required before booking...' : 'Add call notes...'}
                              style={{ width:'100%', border:`1px solid ${selectedOutcome==='Booked' ? 'var(--accent)' : 'var(--border)'}`, borderRadius:'var(--radius)', padding:'9px 10px', fontSize:12, fontFamily:'inherit', resize:'vertical', minHeight:80, background:'var(--surface)', color:'var(--text-primary)', opacity: isMe ? 1 : .4 }} />
                            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:6 }}>
                              <div style={{ fontSize:10, color:'var(--text-muted)' }}>
                                Notes save with the outcome and sync to ServiceTitan.
                              </div>
                              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                                {stNoteResult && (
                                  <span style={{ fontSize:11, fontWeight:600, color: stNoteResult.ok ? '#16A34A' : '#DC2626' }}>
                                    {stNoteResult.ok ? 'Sent to ST' : stNoteResult.error}
                                  </span>
                                )}
                                <button onClick={sendNoteToST} disabled={!c.external_id || !notesVal.trim() || stNoteSending}
                                  style={{ padding:'5px 12px', border:'1px solid var(--accent)', borderRadius:'var(--radius)', background:'var(--surface)', color:'var(--accent)', fontSize:11, fontWeight:600, cursor: (c.external_id && notesVal.trim() && !stNoteSending) ? 'pointer' : 'not-allowed', opacity: (c.external_id && notesVal.trim()) ? 1 : .4 }}>
                                  {stNoteSending ? 'Sending...' : 'Send note to ST'}
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* ST Booking panel — only when "Booked" is the outcome */}
                          {selectedOutcome === 'Booked' && (
                            <div style={{ background:'var(--success-bg)', border:'1px solid var(--success)', borderRadius:'var(--radius)', padding:12, display:'flex', flexDirection:'column', gap:10 }}>
                              <div style={{ fontSize:11, fontWeight:700, color:'var(--success)' }}>ServiceTitan booking details</div>
                              <GuidanceBanner compact />
                              {!c.external_id && (
                                <div style={{ background:'#FFFBEB', border:'1px solid #FCD34D', borderRadius:'var(--radius)', padding:'8px 12px', fontSize:12, color:'#92400E', display:'flex', alignItems:'center', justifyContent:'space-between', gap:10 }}>
                                  <span>Not in ServiceTitan yet — create them to book.</span>
                                  <button className="btn sm primary" onClick={() => {
                                    setNewCustErr('')
                                    setNewCust({ name: c.name || '', phone: c.phone || '', email: c.email || '', street: c.address || '', city: c.city || 'Colorado Springs', state: c.state || 'CO', zip: c.zip || '', forContactId: c.id })
                                  }}>Create in ST</button>
                                </div>
                              )}
                              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                                <SearchSelect label="Business unit" value={selectedBU} onChange={v => { setSelectedBU(v); setSelectedJobType(''); setAvailability([]); setBookingResult(null) }} options={buOptions} placeholder="Select..." />
                                <SearchSelect label="Job type" value={selectedJobType} onChange={v => { setSelectedJobType(v); setAvailability([]); setBookingResult(null) }} options={jtOptions} placeholder="Select..." disabled={!selectedBU} />
                              </div>
                              <SearchSelect label="Marketing campaign" value={String(stCampaignId||'')} onChange={v => setStCampaignId(v)} options={campOptions} placeholder="Select campaign..." />

                              {/* Sell a membership into ServiceTitan. Only types an admin has
                                  mapped to a sale task are offered — the rest can't be sold. */}
                              {sellableMemberships.length > 0 && (
                                <div style={{ padding:'8px 10px', background: alsoMembership ? '#EFF6FF' : 'var(--surface)', border:`1px solid ${alsoMembership ? '#3b82f6' : 'var(--border)'}`, borderRadius:'var(--radius)', display:'flex', flexDirection:'column', gap:8 }}>
                                  <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
                                    <div onClick={() => { setAlsoMembership(p => !p); setMembershipTypeId('') }}
                                      style={{ width:18, height:18, borderRadius:4, border:`2px solid ${alsoMembership ? '#3b82f6' : 'var(--border)'}`, background: alsoMembership ? '#3b82f6' : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, cursor:'pointer' }}>
                                      {alsoMembership && <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                                    </div>
                                    <div onClick={() => { setAlsoMembership(p => !p); setMembershipTypeId('') }}>
                                      <span style={{ fontSize:12, fontWeight:600, color: alsoMembership ? '#1d4ed8' : 'var(--text-primary)' }}>Sell Membership?</span>
                                    </div>
                                  </label>

                                  {alsoMembership && (
                                    <>
                                      <select value={membershipTypeId} onChange={e => setMembershipTypeId(e.target.value)}
                                        style={{ width:'100%', padding:'6px 8px', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, background:'var(--surface)', color:'var(--text-primary)' }}>
                                        <option value="">Which membership?</option>
                                        {sellableMemberships.map(m => <option key={m.st_membership_type_id} value={m.st_membership_type_id}>{m.name}</option>)}
                                      </select>
                                      <div style={{ fontSize:10, color:'#B5341A', fontWeight:600 }}>
                                        Creates a real membership and invoice in ServiceTitan for this customer.
                                      </div>
                                      {membershipMsg && (
                                        <div style={{ fontSize:11, padding:'5px 8px', borderRadius:'var(--radius)',
                                          background: membershipMsg.startsWith('Error') ? 'var(--danger-bg)' : 'var(--success-bg)',
                                          color: membershipMsg.startsWith('Error') ? 'var(--danger)' : 'var(--success)' }}>{membershipMsg}</div>
                                      )}
                                    </>
                                  )}
                                </div>
                              )}

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

                              {!c.external_id && <div style={{ fontSize:10, color:'var(--warning)', textAlign:'center' }}>No ST Customer ID on this contact</div>}
                            </div>
                          )}

                          {/* Booking confirmation (persists after the panel closes on log) */}
                          {bookingResult && (
                            <div style={{ padding:'7px 10px', borderRadius:'var(--radius)', fontSize:11, fontWeight:500, background: bookingResult.ok ? '#DCFCE7' : '#FEE2E2', border:`1px solid ${bookingResult.ok ? '#16A34A' : '#DC2626'}`, color: bookingResult.ok ? '#15803D' : '#DC2626' }}>
                              {bookingResult.ok ? `Job #${bookingResult.jobNumber||bookingResult.jobId} created in ServiceTitan` : bookingResult.error}
                            </div>
                          )}

                          {/* One contextual action: Booked → book & log; otherwise → log. Stays on customer. */}
                          <div style={{ display:'flex', gap:8, justifyContent:'space-between', alignItems:'center', paddingTop:2 }}>
                            <button className="btn" disabled={!isMe} onClick={openCallbackModal} style={{fontSize:12}}>Callback</button>
                            {selectedOutcome === 'Booked' ? (
                              <button onClick={bookAndLog} disabled={!isMe || !c.external_id || !selectedJobType || !selectedBU || !stCampaignId || booking || saving}
                                style={{ padding:'10px 22px', border:'none', borderRadius:'var(--radius)', background: (c.external_id && selectedJobType && selectedBU && stCampaignId) ? '#16A34A' : 'var(--border)', color:'#fff', fontSize:13, fontWeight:700, cursor: (c.external_id && selectedJobType && selectedBU && stCampaignId && !booking && !saving) ? 'pointer' : 'not-allowed', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
                                {(booking || saving) ? <><div className="spinner" style={{width:13,height:13,borderWidth:2,borderTopColor:'#fff'}}></div> Booking...</> :
                                  selectedSlot ? `Book ${new Date(selectedSlot.start).toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })} ${new Date(selectedSlot.start).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })} & log` :
                                  'Book in ServiceTitan & log'}
                              </button>
                            ) : (
                              <button onClick={() => logOutcome(true)} disabled={!isMe || !selectedOutcome || saving}
                                style={{ padding:'10px 22px', border:'none', borderRadius:'var(--radius)', background: selectedOutcome ? '#16A34A' : 'var(--border)', color:'#fff', fontSize:13, fontWeight:600, cursor: (selectedOutcome && !saving) ? 'pointer' : 'not-allowed' }}>
                                {saving ? 'Saving...' : selectedOutcome ? 'Log outcome' : 'Pick an outcome'}
                              </button>
                            )}
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
                </div>

                {/* -- RIGHT: Stats + Script + Tips -- */}
                <div style={{ borderLeft:'1px solid var(--border)', display:'flex', flexDirection:'column', overflow:'hidden', minHeight:0, background:'var(--surface-2)' }}>

                  {/* Stats -- always visible */}
                  <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--border)', background:'var(--surface)', flexShrink:0 }}>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8, marginBottom:8 }}>
                      {[
                        { l:'Calls today', v:myStats.calls, col:'var(--text-primary)' },
                        { l:'Booked', v:myStats.booked, col:'#16A34A' },
                        { l:'Booking rate', v:todayLogs.length ? Math.round((myStats.booked/todayLogs.length)*100)+'%' : '--', col:'#7C3AED' },
                        { l:'Commission', v:'$'+dailyEarnings.toFixed(2), col:'#2563eb' },
                      ].map(({ l, v, col }) => {
                        const isComm = l === 'Commission'
                        return (
                          <div key={l}
                            onClick={isComm ? () => setShowCommPop(s => !s) : undefined}
                            style={{ background:'var(--surface-2)', borderRadius:'var(--radius)', padding:'8px 10px', position:'relative', cursor: isComm ? 'pointer' : 'default' }}>
                            <div style={{ fontSize:9, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', marginBottom:2, display:'flex', alignItems:'center', gap:3 }}>
                              {l}
                              {isComm && (
                                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ opacity:.5, transform: showCommPop ? 'rotate(180deg)' : 'none' }}><path d="m6 9 6 6 6-6"/></svg>
                              )}
                            </div>
                            <div style={{ fontSize:16, fontWeight:700, color:col }}>{v}</div>
                            {isComm && showCommPop && (
                              <div style={{ position:'absolute', top:'calc(100% + 4px)', left:0, right:0, zIndex:60, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', boxShadow:'0 8px 24px rgba(0,0,0,.15)', padding:'6px 10px' }}>
                                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:11, padding:'3px 0' }}>
                                  <span style={{ color:'var(--text-muted)' }}>Today</span>
                                  <span style={{ fontWeight:700, color:'#2563eb' }}>${dailyEarnings.toFixed(2)}</span>
                                </div>
                                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:11, padding:'3px 0', borderTop:'1px solid var(--border)' }}>
                                  <span style={{ color:'var(--text-muted)' }}>This week</span>
                                  <span style={{ fontWeight:700, color:'var(--text-primary)' }}>${weeklyEarnings.toFixed(2)}</span>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
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

                  <div style={{ flex:1, minHeight:0, overflowY:'auto', padding:12 }}>
                    {activeTab === 'script' && (
                      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                        {(camp?.script || inboundScript?.script) ? (
                          <>
                            {!camp?.script && (
                              <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)' }}>Inbound script</div>
                            )}
                            <RichText html={camp?.script || inboundScript.script}
                              style={{ background:'var(--surface)', border:'1px solid var(--border)', borderLeft:'3px solid var(--accent)', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:12, lineHeight:1.9, color:'var(--text-primary)' }} />
                          </>
                        ) : (
                          <div style={{ fontSize:12, color:'var(--text-muted)', fontStyle:'italic', textAlign:'center', paddingTop:16 }}>{camp ? 'No script set for this campaign.' : 'No inbound script set — add one in Settings → Campaigns.'}</div>
                        )}
                      </div>
                    )}
                    {activeTab === 'tips' && (
                      <div>
                        {(camp?.tips || inboundScript?.tips) ? (
                          <RichText html={camp?.tips || inboundScript.tips}
                            style={{ background:'#FFFBEB', border:'1px solid #FCD34D', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:12, lineHeight:1.9, color:'#78350F' }} />
                        ) : (
                          <div style={{ fontSize:12, color:'var(--text-muted)', fontStyle:'italic', textAlign:'center', paddingTop:16 }}>{camp ? 'No tips set for this campaign.' : 'No inbound tips set — add them in Settings → Campaigns.'}</div>
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
                {guidance && <div style={{ marginBottom:12 }}><GuidanceBanner /></div>}
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

      {/* TEXT MODAL */}
      {tagPicker && (
        <Modal title="Add a ServiceTitan tag" onClose={() => setTagPicker(false)} width={420}>
          <input className="form-input" placeholder="Search tags..." value={tagSearch} autoFocus
            onChange={e => setTagSearch(e.target.value)} style={{ marginBottom:10 }} />
          <div style={{ maxHeight:320, overflowY:'auto', display:'flex', flexDirection:'column' }}>
            {tagCatalog === null ? (
              <div style={{ padding:16, textAlign:'center' }}><div className="spinner" /></div>
            ) : (tagCatalog
              .filter(t => !(stCustomerInfo?.tags || []).some(x => x.id === t.id))
              .filter(t => !tagSearch.trim() || t.name.toLowerCase().includes(tagSearch.trim().toLowerCase()))
              .slice(0, 60)
              .map(t => (
                <button key={t.id} onClick={() => addTag(t)} disabled={tagBusy}
                  style={{ display:'flex', alignItems:'center', gap:8, width:'100%', textAlign:'left', padding:'8px 10px',
                    background:'transparent', border:'none', borderBottom:'1px solid var(--border)', cursor:'pointer', fontSize:12, color:'var(--text-primary)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <span style={{ width:10, height:10, borderRadius:'50%', background: t.color || 'var(--border)', flexShrink:0 }} />
                  {t.name}
                </button>
              )))}
          </div>
          <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:8 }}>Tags write straight to the ServiceTitan account.</div>
        </Modal>
      )}

      {newCust && (
        <Modal title={newCust.forContactId ? 'Create this customer in ServiceTitan' : 'New ServiceTitan customer'} onClose={() => setNewCust(null)} width={480}>
          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
            <div className="form-field"><label className="form-label">Full name *</label>
              <input className="form-input" value={newCust.name} onChange={e => setNewCust(f => ({ ...f, name: e.target.value }))} placeholder="First Last" autoFocus /></div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <div className="form-field"><label className="form-label">Phone</label>
                <input className="form-input" value={newCust.phone} onChange={e => setNewCust(f => ({ ...f, phone: e.target.value }))} placeholder="(719) 555-0123" /></div>
              <div className="form-field"><label className="form-label">Email</label>
                <input className="form-input" value={newCust.email} onChange={e => setNewCust(f => ({ ...f, email: e.target.value }))} placeholder="name@email.com" /></div>
            </div>
            <div className="form-field"><label className="form-label">Street address *</label>
              <input className="form-input" value={newCust.street} onChange={e => setNewCust(f => ({ ...f, street: e.target.value }))} placeholder="123 Main St" /></div>
            <div style={{ display:'grid', gridTemplateColumns:'2fr 70px 1fr', gap:10 }}>
              <div className="form-field"><label className="form-label">City *</label>
                <input className="form-input" value={newCust.city} onChange={e => setNewCust(f => ({ ...f, city: e.target.value }))} /></div>
              <div className="form-field"><label className="form-label">State</label>
                <input className="form-input" value={newCust.state} onChange={e => setNewCust(f => ({ ...f, state: e.target.value }))} /></div>
              <div className="form-field"><label className="form-label">Zip *</label>
                <input className="form-input" value={newCust.zip} onChange={e => setNewCust(f => ({ ...f, zip: e.target.value }))} placeholder="80831" /></div>
            </div>
            <div style={{ fontSize:11, color:'var(--text-muted)' }}>
              Creates the customer and their service location in ServiceTitan, links them here, and the normal booking flow takes over.
            </div>
            {newCustErr && <div style={{ fontSize:12, color:'var(--danger)', background:'var(--danger-bg)', padding:'8px 12px', borderRadius:8 }}>{newCustErr}</div>}
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setNewCust(null)}>Cancel</button>
            <button className="btn primary" onClick={createStCustomer}
              disabled={newCustBusy || !newCust.name.trim() || !newCust.street.trim() || !newCust.city.trim() || !newCust.zip.trim()}>
              {newCustBusy ? 'Creating…' : 'Create customer'}
            </button>
          </div>
        </Modal>
      )}

      {showTextModal && c && (
        <Modal title={`Text ${c.name || c.phone}`} onClose={() => { setShowTextModal(false); setTextBody(''); setTextResult(null) }} width={420}>
          <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:10 }}>To: {c.phone}</div>
          <textarea autoFocus value={textBody} onChange={e => setTextBody(e.target.value.slice(0, 320))}
            placeholder="Type your message..."
            style={{ width:'100%', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'10px 12px', fontSize:13, fontFamily:'inherit', resize:'vertical', minHeight:110, background:'var(--surface-2)', color:'var(--text-primary)' }} />
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:6 }}>
            <span style={{ fontSize:11, color:'var(--text-muted)' }}>{textBody.length} / 320</span>
            {textResult && (
              <span style={{ fontSize:12, fontWeight:600, color: textResult.ok ? '#16A34A' : '#DC2626' }}>
                {textResult.ok ? 'Message sent' : textResult.error}
              </span>
            )}
          </div>
          {/* Quick templates */}
          <div style={{ display:'flex', gap:6, marginTop:10, flexWrap:'wrap' }}>
            {[
              "Hi, this is Awesome Home Services following up on your service. Is now a good time to talk?",
              "Your appointment is confirmed. We'll see you soon!",
              "We tried reaching you about your HVAC maintenance. Please call us back at your convenience.",
            ].map((t, i) => (
              <button key={i} onClick={() => setTextBody(t)}
                style={{ padding:'4px 9px', fontSize:10, border:'1px solid var(--border)', borderRadius:99, background:'var(--surface-2)', color:'var(--text-secondary)', cursor:'pointer' }}>
                Template {i+1}
              </button>
            ))}
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => { setShowTextModal(false); setTextBody(''); setTextResult(null) }}>Cancel</button>
            <button className="btn primary" onClick={sendText} disabled={!textBody.trim() || textSending}>
              {textSending ? 'Sending...' : 'Send text'}
            </button>
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
