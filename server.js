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

// ── ST: Get customer by ID
app.get('/api/st/customer/:id', async (req, res) => {
  try {
    const data = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers/${req.params.id}`)
    res.json(data)
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

    // ST returns UTC times. Filter to known AHS arrival windows by their UTC equivalents (MDT = UTC+6 ahead)
    // e.g. 8:00 AM MDT = 14:00 UTC, 12:00 PM MDT = 18:00 UTC
    const VALID_WINDOWS_UTC = [
      { start: '14:00', end: '18:00' },  // 8:00 AM - 12:00 PM MDT
      { start: '16:00', end: '20:00' },  // 10:00 AM - 2:00 PM MDT
      { start: '18:00', end: '22:00' },  // 12:00 PM - 4:00 PM MDT
      { start: '20:00', end: '00:00' },  // 2:00 PM - 6:00 PM MDT
      { start: '22:00', end: '02:00' },  // 4:00 PM - 8:00 PM MDT
      { start: '00:00', end: '04:00' },  // 6:00 PM - 10:00 PM MDT
    ]

    const toHHMM = (isoString) => {
      if (!isoString) return ''
      return isoString.slice(11, 16)
    }

    // Convert UTC ISO to MT display string for the frontend
    const toMTDisplay = (isoString) => {
      if (!isoString) return isoString
      const d = new Date(isoString)
      const localMs = d.getTime() + (-6 * 60 * 60 * 1000)
      const local = new Date(localMs)
      const pad = (n) => String(n).padStart(2, '0')
      return `${local.getUTCFullYear()}-${pad(local.getUTCMonth()+1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00`
    }

    const rawSlots = data?.availabilities || data?.data || []
    console.log('ST raw UTC windows:', [...new Set(rawSlots.map(s => `${toHHMM(s.start)}-${toHHMM(s.end)}`))].sort())

    const availabilities = rawSlots
      .filter(slot => {
        const startHH = toHHMM(slot.start)
        const endHH = toHHMM(slot.end)
        return VALID_WINDOWS_UTC.some(w => w.start === startHH && w.end === endHH)
      })
      .map(slot => ({
        ...slot,
        start: toMTDisplay(slot.start),
        end: toMTDisplay(slot.end),
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

// ── TwiML for outbound
app.post('/api/twilio/twiml/outbound', (req, res) => {
  const twiml = new VoiceResponse()
  const dial = twiml.dial({ callerId: twilioPhone, timeout: 30 })
  dial.number(req.query.to || req.body.To)
  res.type('text/xml')
  res.send(twiml.toString())
})

// ── Inbound call webhook
app.post('/api/twilio/inbound', async (req, res) => {
  const { From, CallSid, To } = req.body
  console.log(`Inbound call from ${From}, SID: ${CallSid}`)
  const normalizedPhone = From.replace(/\D/g, '').slice(-10)
  const { data: contact } = await supabase
    .from('contacts')
    .select('*')
    .ilike('phone', `%${normalizedPhone}%`)
    .limit(1)
    .single()
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
  const twiml = new VoiceResponse()
  twiml.say({ voice: 'alice' }, 'Please hold while we connect you.')
  const dial = twiml.dial({ timeout: 30, action: `${appUrl}/api/twilio/inbound/complete` })
  dial.client('andi-csr')
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
