import express from 'express'
import twilio from 'twilio'
import { createClient } from '@supabase/supabase-js'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

const accountSid = process.env.TWILIO_ACCOUNT_SID
const authToken = process.env.TWILIO_AUTH_TOKEN
const twilioPhone = process.env.TWILIO_PHONE_NUMBER
const appUrl = process.env.APP_URL || 'https://andi.awesomeservice.com'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const twilioClient = twilio(accountSid, authToken)
const VoiceResponse = twilio.twiml.VoiceResponse

// ─────────────────────────────────────────────
// ── SERVICETITAN API LAYER
// ─────────────────────────────────────────────

const ST_CLIENT_ID     = process.env.ST_CLIENT_ID
const ST_CLIENT_SECRET = process.env.ST_CLIENT_SECRET
const ST_TENANT_ID     = process.env.ST_TENANT_ID || '3101065365'
const ST_AUTH_URL      = 'https://auth.servicetitan.io/connect/token'
const ST_API_BASE      = `https://api.servicetitan.io`

let stTokenCache = null

async function getSTToken() {
  // Return cached token if still valid (with 60s buffer)
  if (stTokenCache && stTokenCache.expiresAt > Date.now() + 60000) {
    return stTokenCache.token
  }
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: ST_CLIENT_ID,
    client_secret: ST_CLIENT_SECRET,
  })
  const res = await fetch(ST_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ST auth failed: ${err}`)
  }
  const data = await res.json()
  stTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  }
  return stTokenCache.token
}

async function stGet(path) {
  const token = await getSTToken()
  const res = await fetch(`${ST_API_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'ST-App-Key': process.env.ST_APP_KEY,
    },
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ST GET ${path} failed: ${err}`)
  }
  return res.json()
}

async function stPost(path, body) {
  const token = await getSTToken()
  const res = await fetch(`${ST_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'ST-App-Key': process.env.ST_APP_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ST POST ${path} failed: ${err}`)
  }
  return res.json()
}

// ── ST: Add note to customer record (via primary location)
app.post('/api/st/note', async (req, res) => {
  try {
    const { customerId, note, repName } = req.body
    if (!customerId || !note) return res.status(400).json({ error: 'customerId and note required' })
    const noteText = `[Andi - ${repName || 'CSR'}] ${note}`

    // Step 1: Get customer's primary location ID
    const locData = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/locations?customerId=${customerId}&pageSize=1`)
    const locationId = locData?.data?.[0]?.id
    if (!locationId) throw new Error(`No location found for customer ${customerId}`)

    // Step 2: Post note to the location
    const data = await stPost(`/crm/v2/tenant/${ST_TENANT_ID}/locations/${locationId}/notes`, {
      text: noteText,
      pinToTop: false,
    })

    res.json({ ok: true, locationId, data })
  } catch (err) {
    console.error('ST note error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── ST: Get customer by ID (with email + membership status)
app.get('/api/st/customer/:id', async (req, res) => {
  try {
    const id = req.params.id
    const customer = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers/${id}`)

    // Email lives on the customer's contact records, not the customer itself
    let email = customer?.email || null
    if (!email) {
      try {
        const contacts = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers/${id}/contacts`)
        const emailContact = (contacts?.data || []).find(ct => ct.type === 'Email' || ct.type === 'MobileEmail')
        email = emailContact?.value || null
      } catch (e) { console.warn('ST customer contacts failed:', e.message) }
    }

    // Membership status
    let membership = { active: false, name: null }
    try {
      const memb = await stGet(`/memberships/v2/tenant/${ST_TENANT_ID}/memberships?customerIds=${id}&pageSize=10`)
      const active = (memb?.data || []).find(m => m.status === 'Active')
      if (active) {
        membership = { active: true, name: active.membershipTypeName || active.type?.name || 'Member', expiresOn: active.to || null }
      }
    } catch (e) { console.warn('ST memberships failed:', e.message) }

    res.json({ ...customer, email, membership })
  } catch (err) {
    console.error('ST customer error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── ST: Get availability (capacity slots) — POST dispatch/v2/capacity
app.get('/api/st/availability', async (req, res) => {
  try {
    const { jobTypeId, businessUnitId, from, to } = req.query
    if (!jobTypeId || !businessUnitId) {
      return res.status(400).json({ error: 'jobTypeId and businessUnitId required' })
    }

    const body = {
      startsOnOrAfter: from || new Date().toISOString(),
      endsOnOrBefore: to || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      businessUnitIds: [parseInt(businessUnitId)],
      jobTypeId: parseInt(jobTypeId),
      skillBasedAvailability: true,
    }

    const data = await stPost(`/dispatch/v2/tenant/${ST_TENANT_ID}/capacity`, body)
    console.log('ST capacity response:', JSON.stringify(data).slice(0, 500))

    // AHS arrival windows mapped to their UTC equivalents (MDT = UTC-6)
    // Source: actual ST API response logs
    // ST stores local MT times with Z suffix (confirmed from raw response logs)
    // e.g. "2026-07-14T07:59:00Z" = 7:59 AM MT in ST UI
    // Filter to AHS valid windows by matching HH:MM directly
    const VALID_WINDOWS_UTC = [
      { start: '08:00', end: '12:00' },
      { start: '10:00', end: '14:00' },
      { start: '12:00', end: '16:00' },
      { start: '14:00', end: '18:00' },
      { start: '16:00', end: '20:00' },
      { start: '18:00', end: '22:00' },
    ]

    const toHHMM = (isoString) => {
      if (!isoString) return ''
      return isoString.slice(11, 16)
    }

    const toLocal = (isoString) => {
      if (!isoString) return isoString
      return isoString.replace('Z', '').slice(0, 19)
    }

    const rawSlots = data?.availabilities || data?.data || []
    console.log('ST raw windows:', [...new Set(rawSlots.map(s => `${toHHMM(s.start)}-${toHHMM(s.end)}`))].sort())

    const availabilities = rawSlots
      .filter(slot => {
        const startHH = toHHMM(slot.start)
        const endHH = toHHMM(slot.end)
        return VALID_WINDOWS_UTC.some(w => w.start === startHH && w.end === endHH)
      })
      .map(slot => ({
        ...slot,
        start: toLocal(slot.start),
        end: toLocal(slot.end),
      }))
      .sort((a, b) => a.start.localeCompare(b.start))

    res.json({ availabilities })
  } catch (err) {
    console.error('ST availability error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── ST: Get job types (for availability dropdown)
app.get('/api/st/jobtypes', async (req, res) => {
  try {
    const data = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/job-types?active=true&pageSize=500`)
    res.json(data)
  } catch (err) {
    console.error('ST job types error:', err.message)
    res.status(500).json({ error: err.message })
  }
})


// ── ST: Get business units (for booking dropdown)
app.get('/api/st/businessunits', async (req, res) => {
  try {
    // Try settings/v2 first, fall back to other known paths
    let data
    const paths = [
      `/settings/v2/tenant/${ST_TENANT_ID}/business-units?active=true&pageSize=200`,
      `/settings/v2/tenant/${ST_TENANT_ID}/business-units?pageSize=200`,
      `/jpm/v2/tenant/${ST_TENANT_ID}/business-units?active=true&pageSize=200`,
      `/dispatch/v2/tenant/${ST_TENANT_ID}/business-units?active=true&pageSize=200`,
      `/accounting/v2/tenant/${ST_TENANT_ID}/business-units?active=true&pageSize=200`,
      `/memberships/v2/tenant/${ST_TENANT_ID}/business-units?pageSize=200`,
      `/payroll/v2/tenant/${ST_TENANT_ID}/business-units?pageSize=200`,
    ]
    let lastErr
    for (const path of paths) {
      try {
        data = await stGet(path)
        if (data?.data?.length > 0) {
          console.log('Business units found at:', path)
          break
        }
      } catch (e) {
        lastErr = e
        console.log('BU path failed:', path, e.message)
      }
    }
    if (!data) throw lastErr || new Error('No business units found')
    res.json(data)
  } catch (err) {
    console.error('ST business units error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── ST: Probe which API endpoints this tenant/app can reach
app.get('/api/st/probe', async (req, res) => {
  const paths = {
    bookings:            `/crm/v2/tenant/${ST_TENANT_ID}/bookings?pageSize=3`,
    bookingProviderTags: `/crm/v2/tenant/${ST_TENANT_ID}/booking-provider-tags?pageSize=3`,
    leads:               `/crm/v2/tenant/${ST_TENANT_ID}/leads?pageSize=3`,
    calls:               `/telecom/v2/tenant/${ST_TENANT_ID}/calls?pageSize=3`,
    callsV3:             `/telecom/v3/tenant/${ST_TENANT_ID}/calls?pageSize=3`,
    chats:               `/chat/v2/tenant/${ST_TENANT_ID}/chats?pageSize=3`,
    customerInteractions:`/customer-interactions/v2/tenant/${ST_TENANT_ID}/interactions?pageSize=3`,
    schedulingProBookings:`/scheduling-pro/v2/tenant/${ST_TENANT_ID}/bookings?pageSize=3`,
    tasks:               `/taskmanagement/v2/tenant/${ST_TENANT_ID}/tasks?pageSize=3`,
    memberships:         `/memberships/v2/tenant/${ST_TENANT_ID}/memberships?pageSize=3`,
    equipment:           `/equipmentsystems/v2/tenant/${ST_TENANT_ID}/installed-equipment?pageSize=3`,
  }

  const results = {}
  for (const [name, path] of Object.entries(paths)) {
    try {
      const data = await stGet(path)
      const count = Array.isArray(data?.data) ? data.data.length : (data ? 1 : 0)
      results[name] = {
        ok: true,
        count,
        totalCount: data?.totalCount ?? null,
        sampleKeys: data?.data?.[0] ? Object.keys(data.data[0]).slice(0, 15) : null,
        sample: data?.data?.[0] || null,
      }
    } catch (err) {
      const msg = err.message || ''
      results[name] = {
        ok: false,
        error: msg.includes('403') ? 'FORBIDDEN - scope not enabled'
             : msg.includes('404') ? 'NOT FOUND - endpoint does not exist'
             : msg.includes('401') ? 'UNAUTHORIZED'
             : msg.slice(0, 160),
      }
    }
  }

  res.json({ tenant: ST_TENANT_ID, results })
})

// ── ST: Search customers by name, phone, or address
app.get('/api/st/search', async (req, res) => {
  try {
    const { q } = req.query
    if (!q || q.trim().length < 3) return res.json({ data: [] })
    const query = q.trim()
    const digits = query.replace(/\D/g, '')
    const results = new Map()

    const addResults = (arr) => {
      (arr || []).forEach(cust => { if (cust?.id && !results.has(cust.id)) results.set(cust.id, cust) })
    }

    // Phone search (if it looks like a phone number)
    if (digits.length >= 7) {
      try {
        const byPhone = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers?phone=${digits.slice(-10)}&pageSize=10`)
        addResults(byPhone?.data)
      } catch (e) {}
      // Also check contacts index
      try {
        const contactHits = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/contacts?phone=${digits.slice(-10)}&pageSize=10`)
        const ids = [...new Set((contactHits?.data || []).map(ct => ct.customerId).filter(Boolean))]
        for (const cid of ids.slice(0, 5)) {
          if (results.has(cid)) continue
          try { const cust = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers/${cid}`); addResults([cust]) } catch (e) {}
        }
      } catch (e) {}
    }

    // Name search
    if (digits.length < 7 || results.size === 0) {
      try {
        const byName = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers?name=${encodeURIComponent(query)}&pageSize=10`)
        addResults(byName?.data)
      } catch (e) {}
    }

    // Address / street search
    if (results.size === 0) {
      try {
        const byStreet = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers?street=${encodeURIComponent(query)}&pageSize=10`)
        addResults(byStreet?.data)
      } catch (e) {}
      try {
        const locHits = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/locations?street=${encodeURIComponent(query)}&pageSize=10`)
        const ids = [...new Set((locHits?.data || []).map(l => l.customerId).filter(Boolean))]
        for (const cid of ids.slice(0, 5)) {
          if (results.has(cid)) continue
          try { const cust = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers/${cid}`); addResults([cust]) } catch (e) {}
        }
      } catch (e) {}
    }

    const data = [...results.values()].slice(0, 10).map(cust => ({
      id: cust.id,
      name: cust.name,
      phone: cust.phoneSettings?.phoneNumber || cust.phoneNumber || null,
      email: cust.email || null,
      address: cust.address?.street || null,
      city: cust.address?.city || null,
      state: cust.address?.state || null,
      zip: cust.address?.zip || null,
    }))
    res.json({ data })
  } catch (err) {
    console.error('ST search error:', err.message)
    res.status(500).json({ error: err.message, data: [] })
  }
})

// ── ST: Look up a customer by phone number (for inbound call pop)
app.get('/api/st/lookup', async (req, res) => {
  try {
    const { phone } = req.query
    if (!phone) return res.status(400).json({ error: 'phone required' })
    const digits = phone.replace(/\D/g, '').slice(-10)
    if (digits.length < 10) return res.json({ found: false })

    // ST stores phones in various formats — try the contacts endpoint which indexes them
    let customerId = null
    try {
      const contactData = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/contacts?phone=${digits}&pageSize=5`)
      customerId = contactData?.data?.[0]?.customerId || null
    } catch (e) {
      console.warn('ST contacts lookup failed:', e.message)
    }

    // Fallback: search customers directly
    if (!customerId) {
      try {
        const custData = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers?phone=${digits}&pageSize=5`)
        customerId = custData?.data?.[0]?.id || null
      } catch (e) {
        console.warn('ST customers lookup failed:', e.message)
      }
    }

    if (!customerId) return res.json({ found: false })

    // Pull the full customer record + primary location
    const customer = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers/${customerId}`)
    let location = null
    try {
      const locData = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/locations?customerId=${customerId}&pageSize=1`)
      location = locData?.data?.[0] || null
    } catch (e) {}

    res.json({
      found: true,
      customerId,
      name: customer?.name || null,
      email: customer?.email || null,
      address: location?.address?.street || customer?.address?.street || null,
      city: location?.address?.city || customer?.address?.city || null,
      state: location?.address?.state || customer?.address?.state || null,
      zip: location?.address?.zip || customer?.address?.zip || null,
      customer,
    })
  } catch (err) {
    console.error('ST lookup error:', err.message)
    res.status(500).json({ error: err.message, found: false })
  }
})

// ── ST: Get jobs for a customer (job history)
app.get('/api/st/jobs', async (req, res) => {
  try {
    const { customerId } = req.query
    if (!customerId) return res.status(400).json({ error: 'customerId required' })
    const data = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs?customerId=${customerId}&pageSize=5&sort=-modifiedOn`)
    const jobs = data?.data || []

    // ST returns jobTypeId / businessUnitId — resolve them to names
    const [jtRes, buRes] = await Promise.all([
      stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/job-types?pageSize=500`).catch(() => null),
      stGet(`/settings/v2/tenant/${ST_TENANT_ID}/business-units?pageSize=200`).catch(() => null),
    ])
    const jtMap = {}, buMap = {}
    ;(jtRes?.data || []).forEach(jt => { jtMap[jt.id] = jt.name })
    ;(buRes?.data || []).forEach(bu => { buMap[bu.id] = bu.name })

    const enriched = jobs.map(j => ({
      ...j,
      jobType: { id: j.jobTypeId, name: jtMap[j.jobTypeId] || j.summary || 'Job' },
      businessUnit: { id: j.businessUnitId, name: buMap[j.businessUnitId] || '' },
    }))

    res.json({ data: enriched })
  } catch (err) {
    console.error('ST jobs error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── ST: Get campaigns (for booking)
app.get('/api/st/campaigns', async (req, res) => {
  try {
    const data = await stGet(`/marketing/v2/tenant/${ST_TENANT_ID}/campaigns?active=true&pageSize=200`)
    res.json(data)
  } catch (err) {
    console.error('ST campaigns error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── ST: Create booking (direct to dispatch board, unscheduled)
app.post('/api/st/book', async (req, res) => {
  try {
    const { customerId, jobTypeId, businessUnitId, notes, repName, contactName, phone, zip, start, end, campaignId } = req.body
    if (!customerId || !jobTypeId || !businessUnitId) {
      return res.status(400).json({ error: 'customerId, jobTypeId, and businessUnitId required' })
    }

    // Step 1: Get customer's primary location
    const locData = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/locations?customerId=${customerId}&pageSize=1`)
    const location = locData?.data?.[0]
    if (!location) throw new Error(`No location found for customer ${customerId}`)

    // Step 2: Create the job — scheduled if slot selected, unscheduled falls to bottom of dispatch board
    // Get a valid ST campaign ID — required by ST API
    let stCampaignId = campaignId ? parseInt(campaignId) : null
    if (!stCampaignId) {
      try {
        const campData = await stGet(`/marketing/v2/tenant/${ST_TENANT_ID}/campaigns?active=true&pageSize=1`)
        stCampaignId = campData?.data?.[0]?.id || null
      } catch (e) {
        console.warn('Could not fetch ST campaigns:', e.message)
      }
    }

    const jobBody = {
      customerId: parseInt(customerId),
      locationId: location.id,
      jobTypeId: parseInt(jobTypeId),
      businessUnitId: parseInt(businessUnitId),
      campaignId: stCampaignId,
      priority: 'Normal',
      summary: notes || `Outbound booking via Andi — ${repName || 'CSR'}`,
      body: notes || `Outbound booking via Andi — ${repName || 'CSR'}`,
      tagTypeIds: [],
    }

    // If a specific slot was selected, schedule it with an appointment
    // The slot times from our availability endpoint are in MT local ISO format
    // Convert back to UTC for ST API
    if (start && end) {
      // Parse the local ISO string and convert to UTC
      const toUTC = (localISO) => {
        // localISO looks like "2026-07-17T08:00:00-06:00"
        return new Date(localISO).toISOString()
      }
      jobBody.appointments = [{
        start: toUTC(start),
        end: toUTC(end),
        arrivalWindowStart: toUTC(start),
        arrivalWindowEnd: toUTC(end),
      }]
    }
    // No slot selected = unscheduled, drops to bottom of dispatch board automatically

    const jobData = await stPost(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs`, jobBody)
    const jobId = jobData?.id
    const jobNumber = jobData?.jobNumber

    // Step 3: Also post a note to the location
    await stPost(`/crm/v2/tenant/${ST_TENANT_ID}/locations/${location.id}/notes`, {
      text: `[Andi - ${repName || 'CSR'}] Booked: ${notes || 'Outbound call booking'}`,
      pinToTop: false,
    }).catch(e => console.warn('Note post failed:', e.message))

    res.json({ ok: true, jobId, jobNumber, locationId: location.id })
  } catch (err) {
    console.error('ST booking error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── ST: Health check (verify credentials work)
app.get('/api/st/health', async (req, res) => {
  try {
    await getSTToken()
    res.json({ ok: true, tenant: ST_TENANT_ID })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ─────────────────────────────────────────────
// ── TWILIO
// ─────────────────────────────────────────────

// ── Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', phone: twilioPhone })
})

// ── Generate Twilio Access Token for browser SDK
app.post('/api/twilio/token', async (req, res) => {
  try {
    const { identity } = req.body
    if (!identity) return res.status(400).json({ error: 'identity required' })
    const AccessToken = twilio.jwt.AccessToken
    const VoiceGrant = AccessToken.VoiceGrant
    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      incomingAllow: true,
    })
    const token = new AccessToken(accountSid, process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, {
      identity,
      ttl: 3600,
    })
    token.addGrant(voiceGrant)
    res.json({ token: token.toJwt(), identity })
  } catch (err) {
    console.error('Token error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Send SMS
app.post('/api/twilio/sms', async (req, res) => {
  try {
    const { to, body, repName, contactId } = req.body
    if (!to || !body) return res.status(400).json({ error: 'to and body required' })
    const msg = await twilioClient.messages.create({ to, from: twilioPhone, body })
    // Log it
    await supabase.from('call_logs').insert({
      contact_id: contactId || null,
      rep: repName || 'CSR',
      outcome: 'Text Sent',
      notes: body,
    }).catch(() => {})
    res.json({ ok: true, sid: msg.sid })
  } catch (err) {
    console.error('SMS error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Outbound call
app.post('/api/twilio/call', async (req, res) => {
  try {
    const { to, identity, contactId, contactName } = req.body
    if (!to) return res.status(400).json({ error: 'to number required' })
    const call = await twilioClient.calls.create({
      to,
      from: twilioPhone,
      url: `${appUrl}/api/twilio/twiml/outbound`,
      statusCallback: `${appUrl}/api/twilio/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    })
    await supabase.from('active_calls').upsert({
      call_sid: call.sid,
      direction: 'outbound',
      rep_identity: identity,
      contact_id: contactId || null,
      contact_name: contactName || null,
      to_number: to,
      from_number: twilioPhone,
      status: 'initiated',
      started_at: new Date().toISOString(),
    }, { onConflict: 'call_sid' })
    res.json({ callSid: call.sid, status: call.status })
  } catch (err) {
    console.error('Call error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── TwiML for outbound (recorded)
app.post('/api/twilio/twiml/outbound', (req, res) => {
  const twiml = new VoiceResponse()
  const dial = twiml.dial({
    callerId: twilioPhone,
    timeout: 30,
    record: 'record-from-answer-dual',
    recordingStatusCallback: `${appUrl}/api/twilio/recording`,
    recordingStatusCallbackEvent: 'completed',
  })
  dial.number(req.query.to || req.body.To)
  res.type('text/xml')
  res.send(twiml.toString())
})

// ── Twilio recording webhook — save the recording URL onto the call log
app.post('/api/twilio/recording', async (req, res) => {
  try {
    const { CallSid, RecordingSid, RecordingUrl, RecordingDuration } = req.body
    if (!CallSid || !RecordingUrl) return res.sendStatus(200)
    const mp3 = `${RecordingUrl}.mp3`

    await supabase.from('active_calls').update({
      recording_url: mp3,
      recording_sid: RecordingSid,
      recording_duration: RecordingDuration ? parseInt(RecordingDuration) : null,
    }).eq('call_sid', CallSid)

    // Attach to the matching call log if one exists
    const { data: ac } = await supabase.from('active_calls').select('*').eq('call_sid', CallSid).maybeSingle()
    if (ac?.contact_id) {
      const { data: recentLog } = await supabase
        .from('call_logs')
        .select('id')
        .eq('contact_id', ac.contact_id)
        .is('recording_url', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (recentLog) {
        await supabase.from('call_logs').update({
          recording_url: mp3,
          recording_duration: RecordingDuration ? parseInt(RecordingDuration) : null,
          call_sid: CallSid,
        }).eq('id', recentLog.id)
      }
    }
    res.sendStatus(200)
  } catch (err) {
    console.error('Recording webhook error:', err.message)
    res.sendStatus(200)
  }
})

// ── Proxy a Twilio recording (authenticated) so the browser can play/download it
app.get('/api/twilio/recording/:sid', async (req, res) => {
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${req.params.sid}.mp3`
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
    const twRes = await fetch(url, { headers: { Authorization: `Basic ${auth}` } })
    if (!twRes.ok) return res.status(404).json({ error: 'Recording not found' })
    res.setHeader('Content-Type', 'audio/mpeg')
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="call-${req.params.sid}.mp3"`)
    const buf = Buffer.from(await twRes.arrayBuffer())
    res.send(buf)
  } catch (err) {
    console.error('Recording proxy error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── List call recordings (for the Recordings page)
app.get('/api/recordings', async (req, res) => {
  try {
    const { rep, from, to, limit = 100 } = req.query
    let q = supabase
      .from('call_logs')
      .select('*, contacts(name, phone, external_id)')
      .not('recording_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit))
    if (rep) q = q.eq('rep', rep)
    if (from) q = q.gte('created_at', from)
    if (to) q = q.lte('created_at', to)
    const { data, error } = await q
    if (error) throw error
    res.json({ data: data || [] })
  } catch (err) {
    console.error('Recordings list error:', err.message)
    res.status(500).json({ error: err.message, data: [] })
  }
})

// ── ST: Recent calls for a customer
app.get('/api/st/calls', async (req, res) => {
  try {
    const { customerId, limit = 5 } = req.query
    if (!customerId) return res.status(400).json({ error: 'customerId required' })
    const data = await stGet(`/telecom/v2/tenant/${ST_TENANT_ID}/calls?customerId=${customerId}&pageSize=${limit}&sort=-createdOn`)
    const calls = (data?.data || []).map(c => {
      const lc = c.leadCall || c
      return {
        id: lc.id || c.id,
        createdOn: lc.createdOn || c.createdOn,
        receivedOn: lc.receivedOn || c.receivedOn,
        duration: lc.duration || null,
        from: lc.from || null,
        to: lc.to || null,
        direction: lc.direction || null,
        reason: lc.reason?.name || lc.reason || null,
        agent: lc.agent?.name || null,
        campaign: lc.campaign?.name || null,
        recordingUrl: lc.recordingUrl || null,
        voiceMailUrl: lc.voiceMailUrl || null,
      }
    })
    res.json({ data: calls })
  } catch (err) {
    console.error('ST calls error:', err.message)
    res.status(500).json({ error: err.message, data: [] })
  }
})

// ── Proxy a ServiceTitan (or other CDN) recording so the browser can play it.
// ST recording URLs need the same Bearer token + ST-App-Key that stGet uses,
// which the browser can't send, so we stream the audio through the backend.
app.get('/api/st/recording', async (req, res) => {
  try {
    const { url } = req.query
    if (!url) return res.status(400).json({ error: 'url required' })

    // Only proxy known/trusted domains.
    const allowed = ['servicetitan.com', 'servicetitan.io', 'amazonaws.com', 'twilio.com']
    let host
    try { host = new URL(url).hostname } catch { return res.status(400).json({ error: 'bad url' }) }
    if (!allowed.some(d => host.endsWith(d))) {
      return res.status(403).json({ error: `Disallowed domain: ${host}` })
    }

    // Twilio recordings use Basic auth; everything else uses ST auth.
    let headers = {}
    if (host.endsWith('twilio.com')) {
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
      headers = { Authorization: `Basic ${auth}` }
    } else {
      const token = await getSTToken()
      headers = { Authorization: `Bearer ${token}`, 'ST-App-Key': process.env.ST_APP_KEY }
    }

    const upstream = await fetch(url, { headers })
    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '')
      console.error(`ST recording fetch ${upstream.status} for ${host}:`, body.slice(0, 200))
      return res.status(upstream.status).json({ error: 'Recording fetch failed' })
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg')
    if (req.query.download) res.setHeader('Content-Disposition', 'attachment; filename="recording.mp3"')
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.send(buf)
  } catch (err) {
    console.error('ST recording proxy error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────
// ── CUSTOMER INTELLIGENCE BRIEF
// ─────────────────────────────────────────────
// Gathers everything ST knows about a customer, then has Claude synthesize a
// short pre-call brief for the rep. Cached in Supabase so repeat opens are
// instant and we don't re-hit ST / Claude on every contact selection.

const BRIEF_TTL_HOURS = 6
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const MEMBERSHIP_INFO = 'Awesome Club Membership: $29.95/mo or $399/yr. Includes 2 annual HVAC inspections, 1 plumbing inspection, 1 electrical inspection on request, and 2 garage door inspections; a discounted $49 service fee; 15% off all repairs; 10% off indoor-air-quality products, replacements, and garage door replacements; transferable if they move.'

// Gather structured facts from ST. Every sub-fetch is best-effort: if a scope
// or endpoint fails, that fact is simply omitted and the brief adapts.
async function gatherCustomerFacts(id) {
  const facts = {}
  let jobIds = []
  let locIds = []

  // Customer + membership (reuse the same shape as /api/st/customer)
  try {
    const cust = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers/${id}`)
    facts.name = cust?.name || null
    facts.customerType = cust?.type || null
    try {
      const memb = await stGet(`/memberships/v2/tenant/${ST_TENANT_ID}/memberships?customerIds=${id}&pageSize=10`)
      const active = (memb?.data || []).find(m => m.status === 'Active')
      facts.membership = active ? (active.membershipTypeName || active.type?.name || 'Member') : 'Non-member'
      facts.isMember = !!active
      if (active) facts._membership = { id: active.id, from: active.from, to: active.to }
    } catch {}
  } catch (e) { console.warn('facts customer:', e.message) }

  // Jobs — most recent first (last service, last outcome, cadence)
  try {
    const jobsRes = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs?customerId=${id}&pageSize=10&sort=-modifiedOn`)
    const jobs = jobsRes?.data || []
    jobIds = jobs.map(j => j.id).filter(Boolean)
    facts.totalJobs = jobs.length
    if (jobs[0]) {
      const j = jobs[0]
      facts.lastJob = {
        date: j.completedOn || j.scheduledDate || j.createdOn || null,
        status: j.jobStatus || null,
        summary: j.summary || null,
      }
    }
    // Business units touched (which trades they've used)
    facts.jobStatuses = jobs.slice(0, 5).map(j => j.jobStatus).filter(Boolean)
  } catch (e) { console.warn('facts jobs:', e.message) }

  // Installed equipment — age is the install date
  try {
    const locRes = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/locations?customerId=${id}&pageSize=5`)
    locIds = (locRes?.data || []).map(l => l.id).filter(Boolean)
    if (locIds.length) {
      const eqRes = await stGet(`/equipmentsystems/v2/tenant/${ST_TENANT_ID}/installed-equipment?locationIds=${locIds.join(',')}&pageSize=50`)
      const eq = (eqRes?.data || []).map(e => ({
        name: e.name || e.type || 'Equipment',
        installedOn: e.installedOn || e.createdOn || null,
      })).filter(e => e.installedOn)
      if (eq.length) {
        facts.equipment = eq.slice(0, 6).map(e => {
          const yrs = e.installedOn ? Math.floor((Date.now() - new Date(e.installedOn)) / (365.25 * 864e5)) : null
          return { name: e.name, ageYears: yrs }
        })
      }
    }
  } catch (e) { console.warn('facts equipment:', e.message) }

  // Membership maintenance visits — which inspections are booked vs still owed.
  // recurring-service-events has no customerId filter; scope by the customer's
  // location(s), then (when known) to their active membership.
  try {
    if (facts.isMember && locIds.length) {
      const evRes = await Promise.all(locIds.slice(0, 5).map(lid =>
        stGet(`/memberships/v2/tenant/${ST_TENANT_ID}/recurring-service-events?locationId=${lid}&pageSize=100`)
          .then(r => r?.data || []).catch(() => [])
      ))
      const mId = facts._membership?.id
      const events = evRes.flat().filter(e => !mId || String(e.membershipId) === String(mId))
      const isBooked = e => !!e.jobId || e.status === 'Won'
      const horizon = Date.now() + 90 * 864e5
      const due = events.filter(e => !isBooked(e) && e.status !== 'Dismissed' && e.date && new Date(e.date).getTime() <= horizon)
      const booked = events.filter(isBooked)
      if (events.length) {
        facts.maintenanceVisits = {
          booked: booked.length,
          dueCount: due.length,
          due: due
            .sort((a, b) => new Date(a.date) - new Date(b.date))
            .slice(0, 6)
            .map(e => ({ name: e.locationRecurringServiceName || 'Inspection', date: e.date })),
        }
      }
    }
  } catch (e) { console.warn('facts recurring events:', e.message) }

  // Open estimates — ST's estimates endpoint filters by jobId (NOT customerId),
  // so we look up estimates across this customer's jobs. No jobs = no estimates.
  // Per the salestech spec: amount = subtotal + tax; status is {value,name};
  // the response also carries customerId, which we use as a safety filter.
  facts._debug = { jobIds, rawEstimates: 0, afterCustomerFilter: 0, openCount: 0 }
  try {
    if (jobIds.length) {
      const perJob = await Promise.all(jobIds.slice(0, 10).map(jid =>
        stGet(`/sales/v2/tenant/${ST_TENANT_ID}/estimates?jobId=${jid}&pageSize=50`)
          .then(r => r?.data || [])
          .catch(() => [])
      ))
      const raw = perJob.flat()
      const all = raw.filter(e => String(e.customerId) === String(id))
      const open = all.filter(e => {
        const s = (e.status?.name || '').toLowerCase()
        return s === 'open' || (s === '' && e.active !== false && !e.soldOn)
      })
      facts._debug.rawEstimates = raw.length
      facts._debug.afterCustomerFilter = all.length
      facts._debug.openCount = open.length
      if (open.length) {
        facts.openEstimates = {
          count: open.length,
          total: open.reduce((sum, e) => sum + (Number(e.subtotal) || 0) + (Number(e.tax) || 0), 0),
        }
      }
    }
  } catch (e) { console.warn('facts estimates:', e.message); facts._debug.error = e.message }

  // Lifetime value — sum of invoice totals
  try {
    const invRes = await stGet(`/accounting/v2/tenant/${ST_TENANT_ID}/invoices?customerId=${id}&pageSize=200`)
    const invoices = invRes?.data || []
    if (invoices.length) {
      facts.lifetimeValue = invoices.reduce((sum, i) => sum + (Number(i.total) || 0), 0)
      facts.invoiceCount = invoices.length
    }
  } catch (e) { console.warn('facts invoices:', e.message) }

  // Membership savings estimate — conservative 10% blended "up to" figure on
  // open estimates + lifetime spend. Only surfaced for non-members.
  try {
    const estTotal = facts.openEstimates?.total || 0
    const ltv = facts.lifetimeValue || 0
    if (!facts.isMember && (estTotal + ltv) > 0) {
      facts.memberSavings = {
        onOpenEstimates: Math.round(estTotal * 0.10),
        onHistory: Math.round(ltv * 0.10),
        upTo: Math.round((estTotal + ltv) * 0.10),
        basis: 'Conservative 10% blended (repairs 15% / replacements & IAQ 10%); actual varies by job type.',
      }
    }
  } catch {}

  // Customer notes — pinned notes are high-signal operational flags the rep
  // must see. Surface pinned verbatim; include a couple recent ones as context.
  try {
    const notesRes = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers/${id}/notes?pageSize=50`)
    const notes = Array.isArray(notesRes) ? notesRes : (notesRes?.data || [])
    const textOf = n => (n.text || n.note || '').trim()
    const isPinned = n => n.isPinned === true || !!n.pinnedOn
    const pinned = notes.filter(isPinned).map(textOf).filter(Boolean)
    const recent = notes.filter(n => !isPinned(n)).map(textOf).filter(Boolean).slice(0, 3)
    if (pinned.length) facts.pinnedNotes = pinned.slice(0, 5)
    if (recent.length) facts.recentNotes = recent
  } catch (e) { console.warn('facts notes:', e.message) }

  delete facts._membership
  return facts
}

async function generateBrief(facts) {
  if (!ANTHROPIC_KEY) return null
  const sys = `You write a punchy pre-call intelligence brief for a home-services call-center rep at Awesome Home Services (HVAC, plumbing, electrical, garage doors). You are given structured ServiceTitan data about a customer. Write 2-4 short sentences of plain prose: first what stands out about their history (age of equipment, time since last service, membership, open estimates, lifetime value), then a tactical line on how to approach the call. If the data includes pinnedNotes, treat them as high-priority operational flags from staff and account for them (do not contradict or soften them).

MEMBERSHIP PLAYS — ${MEMBERSHIP_INFO}
- If the customer IS a member (isMember true): briefly thank them for being an Awesome Club member. If maintenanceVisits.due lists inspections, tell the rep to book those specific visit(s) on THIS call, naming them, since they are included in the membership; if maintenanceVisits.dueCount is 0, note their inspections are on track. If they have openEstimates, remind the rep those qualify for the 15% member repair discount.
- If the customer is NOT a member: work membership in as an opportunity in the tactical line. If memberSavings is present, cite it with "up to" language (e.g., "up to ~$X across their open estimates and past work") and mention the $49 service fee and included inspections as the hook. Keep it natural and genuinely helpful, not pushy — one line the rep can actually say.
- Only use a play when the relevant data is present. Never invent visit names, dates, or savings figures not in the data.

CRITICAL: only state what the data explicitly supports. If a field is absent or zero, the data is simply not present in ServiceTitan — it does NOT imply non-payment, debt, collections risk, or anything negative. Never infer unpaid work or financial trouble from a missing or zero lifetimeValue; if there is no lifetime value, omit it. No greeting, no bullet points, no markdown, no preamble. Reference concrete numbers you were given. If the data is genuinely sparse, say so in one neutral line rather than inventing a narrative.`
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 320,
        system: sys,
        messages: [{ role: 'user', content: `Customer data (JSON):\n${JSON.stringify(facts, null, 2)}` }],
      }),
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      console.error('Anthropic brief error', r.status, t.slice(0, 200))
      return null
    }
    const data = await r.json()
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim() || null
  } catch (e) {
    console.error('generateBrief error:', e.message)
    return null
  }
}

app.get('/api/st/intelligence/:id', async (req, res) => {
  const id = req.params.id
  const force = req.query.refresh === '1'
  try {
    // Serve fresh cache if present
    if (!force) {
      const { data: cached } = await supabase
        .from('customer_briefs').select('*').eq('customer_id', id).maybeSingle()
      if (cached?.generated_at) {
        const ageHrs = (Date.now() - new Date(cached.generated_at)) / 36e5
        if (ageHrs < BRIEF_TTL_HOURS) {
          return res.json({ brief: cached.brief, facts: cached.facts, generated_at: cached.generated_at, cached: true, _version: 'intel-v3-jobid' })
        }
      }
    }

    const facts = await gatherCustomerFacts(id)
    const debug = facts._debug || null
    delete facts._debug   // keep debug out of Claude prompt + cache
    const brief = await generateBrief(facts)
    const generated_at = new Date().toISOString()

    // Cache (best-effort — don't fail the response if the upsert errors)
    try {
      await supabase.from('customer_briefs')
        .upsert({ customer_id: id, brief, facts, generated_at }, { onConflict: 'customer_id' })
    } catch (e) { console.warn('brief cache upsert:', e.message) }

    res.json({ brief, facts, generated_at, cached: false, _version: 'intel-v3-jobid', _debug: debug })
  } catch (err) {
    console.error('Intelligence brief error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Inbound call webhook
app.post('/api/twilio/inbound', async (req, res) => {
  const { From, CallSid, To } = req.body
  console.log(`Inbound call from ${From}, SID: ${CallSid}`)
  const normalizedPhone = From.replace(/\D/g, '').slice(-10)

  // Look up contact by phone
  const { data: contact } = await supabase
    .from('contacts')
    .select('*')
    .ilike('phone', `%${normalizedPhone}%`)
    .limit(1)
    .single()

  // Log the call
  await supabase.from('active_calls').insert({
    call_sid: CallSid,
    direction: 'inbound',
    from_number: From,
    to_number: To,
    contact_id: contact?.id || null,
    contact_name: contact?.name || null,
    status: 'ringing',
    started_at: new Date().toISOString(),
  })

  // Only ring reps who are set to "Available"
  const { data: inboundReps } = await supabase
    .from('profiles')
    .select('name, email, status')
    .eq('status', 'Available')
    .not('name', 'is', null)

  const twiml = new VoiceResponse()

  if (!inboundReps || inboundReps.length === 0) {
    // Nobody is taking inbound calls
    twiml.say({ voice: 'alice' }, 'Thank you for calling Awesome Home Services. All of our representatives are currently unavailable. Please leave a message after the tone and we will return your call shortly.')
    twiml.record({ maxLength: 120, action: `${appUrl}/api/twilio/inbound/complete`, transcribe: false })
    res.type('text/xml')
    return res.send(twiml.toString())
  }

  twiml.say({ voice: 'alice' }, 'Thank you for calling Awesome Home Services. This call may be recorded for quality purposes. Please hold while we connect you.')
  const dial = twiml.dial({
    timeout: 30,
    action: `${appUrl}/api/twilio/inbound/complete`,
    record: 'record-from-answer-dual',
    recordingStatusCallback: `${appUrl}/api/twilio/recording`,
    recordingStatusCallbackEvent: 'completed',
  })
  inboundReps.forEach(rep => {
    const identity = (rep.name || rep.email || '').replace(/[^a-zA-Z0-9_]/g, '_')
    if (identity) dial.client(identity)
  })

  res.type('text/xml')
  res.send(twiml.toString())
})

// ── Inbound complete
app.post('/api/twilio/inbound/complete', async (req, res) => {
  const { CallSid, DialCallStatus } = req.body
  await supabase.from('active_calls').update({ status: DialCallStatus, ended_at: new Date().toISOString() }).eq('call_sid', CallSid)
  const twiml = new VoiceResponse()
  if (DialCallStatus !== 'answered') {
    twiml.say({ voice: 'alice' }, 'We missed your call. Please call back during business hours.')
  }
  res.type('text/xml')
  res.send(twiml.toString())
})

// ── Call status updates
app.post('/api/twilio/status', async (req, res) => {
  const { CallSid, CallStatus, Duration } = req.body
  await supabase.from('active_calls').update({
    status: CallStatus,
    duration: Duration ? parseInt(Duration) : null,
    ended_at: ['completed','failed','busy','no-answer','canceled'].includes(CallStatus) ? new Date().toISOString() : null,
  }).eq('call_sid', CallSid)
  res.sendStatus(200)
})

// ── Hangup
app.post('/api/twilio/hangup', async (req, res) => {
  const { callSid } = req.body
  try {
    await twilioClient.calls(callSid).update({ status: 'completed' })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────
// ── SERVE REACT FRONTEND (must be last)
// ─────────────────────────────────────────────
const distPath = join(__dirname, 'dist')
if (existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get('*', (req, res) => {
    res.sendFile(join(distPath, 'index.html'))
  })
}

const PORT = process.env.PORT || 3001
app.listen(PORT, '0.0.0.0', () => console.log(`Andi server running on port ${PORT}`))
