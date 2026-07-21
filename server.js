import express from 'express'
import twilio from 'twilio'
import { createClient } from '@supabase/supabase-js'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { renderBoardEmail, boardEmailSubject } from './lib/boardEmail.js'
import { computeBattingOrder, computeZipValue, computeJobTypeOrder, DEFAULT_WEIGHTS, NON_DISPATCH_TEAM } from './lib/dispatchMetrics.js'
import { driveTimes, straightLine, pairKey, driveTimeEnabled, geocode, suggestAddresses } from './lib/driveTime.js'

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

// ── TaskRouter (inbound queue). Provisioned once; SIDs live in Railway env.
const TWILIO_WORKSPACE_SID = process.env.TWILIO_WORKSPACE_SID
const TWILIO_WORKFLOW_SID  = process.env.TWILIO_WORKFLOW_SID
const TWILIO_TASKQUEUE_SID = process.env.TWILIO_TASKQUEUE_SID

// Default activity SIDs from the workspace. Overridable via env if the
// workspace is ever rebuilt.
const TWILIO_ACTIVITY_AVAILABLE = process.env.TWILIO_ACTIVITY_AVAILABLE || 'WA73533af658a7fc3d61ce68abc3198f1f'
const TWILIO_ACTIVITY_OFFLINE   = process.env.TWILIO_ACTIVITY_OFFLINE   || 'WA8f3951f7b7549d73745f66b6aca848a2'

// A caller who hangs up faster than this is a misdial, not an abandon. Stored
// on the row when the task is canceled, so changing it never rewrites history.
const ABANDON_GRACE_SECONDS = Number(process.env.ABANDON_GRACE_SECONDS ?? 10)

// ─────────────────────────────────────────────
// ── SERVICETITAN API LAYER
// ─────────────────────────────────────────────

const ST_CLIENT_ID     = process.env.ST_CLIENT_ID
const ST_CLIENT_SECRET = process.env.ST_CLIENT_SECRET
const ST_TENANT_ID     = process.env.ST_TENANT_ID || '3101065365'

// Job types that are not a truck roll: follow-ups, callbacks, permitting and
// phone-only calls. Shared by the 3-Day Board (where they don't count as a
// booked call) and Dispatch (where they don't consume a tech's capacity).
export const EXCLUDE_CALL = /follow[- ]?up|callback|permitting|phone call/i

// Phone/follow-up work is RELATIONSHIP-BOUND — it's the same tech continuing a
// financing conversation or a callback with a customer they already met. Moving
// it to whoever ranks higher would break the thing that makes it work, so these
// are never reassigned, never swapped, and never offered as the call to bump.
const STICKY_TO_TECH = /phone call|follow[- ]?up|financ/i
const INSTALL_TYPE = /install|replacement/i

// Trade of a technician team ("HVAC - Sales" -> "HVAC"). Module scope so both
// the Live Board and the Decision Maker read it the same way.
function tradeOfTeam(team) {
  const t = String(team || '')
  if (/hvac/i.test(t)) return 'HVAC'
  if (/plumb/i.test(t)) return 'Plumbing'
  if (/electric/i.test(t)) return 'Electrical'
  if (/garage/i.test(t)) return 'Garage Door'
  return 'Other'
}
function tradeOfJobType(name) {
  const t = String(name || '')
  // Job types are prefixed with their trade ("Garage Door - Panel
  // Repair/Replace"), so trust the prefix before any keyword: 'Panel' in that
  // name matched the Electrical keywords and sent a garage job to electricians.
  if (/^garage/i.test(t)) return 'Garage Door'
  if (/^electrical/i.test(t)) return 'Electrical'
  if (/^plumbing/i.test(t)) return 'Plumbing'
  if (/^hvac/i.test(t)) return 'HVAC'
  // Free-typed text without a prefix falls back to keywords — garage checked
  // before electrical for the same 'panel' reason.
  if (/garage|overhead door|opener/i.test(t)) return 'Garage Door'
  if (/hvac|a\/?c|furnace|heat|cool|mini.?split|boiler/i.test(t)) return 'HVAC'
  if (/plumb|water heater|drain|sewer|faucet|toilet|tankless/i.test(t)) return 'Plumbing'
  if (/electric|panel|breaker|generator|wiring|rewire/i.test(t)) return 'Electrical'
  return null
}
const ST_AUTH_URL      = 'https://auth.servicetitan.io/connect/token'
const ST_API_BASE      = `https://api.servicetitan.io`

let stTokenCache = null

// Wrap fetch with a hard timeout so a slow/hung ServiceTitan call returns a
// clean error instead of hanging until the browser/edge drops the connection
// (which surfaces to the user as "Failed to fetch").
async function fetchWithTimeout(url, opts = {}, ms = 25000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

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
  const res = await fetchWithTimeout(ST_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  }, 15000)
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

async function stGet(path, _retry = true) {
  const token = await getSTToken()
  let res
  try {
    res = await fetchWithTimeout(`${ST_API_BASE}${path}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'ST-App-Key': process.env.ST_APP_KEY,
      },
    })
  } catch (e) {
    if (_retry) return stGet(path, false)   // one retry on timeout/network blip
    throw new Error(e.name === 'AbortError' ? `ST GET ${path} timed out` : `ST GET ${path} network error: ${e.message}`)
  }
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ST GET ${path} failed: ${err}`)
  }
  return res.json()
}

async function stPost(path, body, _retry = true) {
  const token = await getSTToken()
  let res
  try {
    res = await fetchWithTimeout(`${ST_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'ST-App-Key': process.env.ST_APP_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    if (_retry) return stPost(path, body, false)   // one retry on timeout/network blip
    throw new Error(e.name === 'AbortError' ? `ST POST ${path} timed out` : `ST POST ${path} network error: ${e.message}`)
  }
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ST POST ${path} failed: ${err}`)
  }
  return res.json()
}

async function stPatch(path, body, _retry = true) {
  const token = await getSTToken()
  let res
  try {
    res = await fetchWithTimeout(`${ST_API_BASE}${path}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'ST-App-Key': process.env.ST_APP_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    if (_retry) return stPatch(path, body, false)   // one retry on timeout/network blip
    throw new Error(e.name === 'AbortError' ? `ST PATCH ${path} timed out` : `ST PATCH ${path} network error: ${e.message}`)
  }
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ST PATCH ${path} failed: ${err}`)
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

// ── ST: employees (for CSR ↔ ST user mapping in the commission engine)
app.get('/api/st/employees', async (req, res) => {
  try {
    const data = await stGet(`/settings/v2/tenant/${ST_TENANT_ID}/employees?active=true&pageSize=500`)
    res.json(data)
  } catch (err) {
    console.error('ST employees error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── ST: membership types (for spiff amount mapping)
app.get('/api/st/membership-types', async (req, res) => {
  try {
    const data = await stGet(`/memberships/v2/tenant/${ST_TENANT_ID}/membership-types?active=true&pageSize=200`)
    res.json(data)
  } catch (err) {
    console.error('ST membership types error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Commission mapping: everything the mapping UI needs in one call
app.get('/api/commission/config', async (req, res) => {
  try {
    const [jt, emp, mt] = await Promise.all([
      stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/job-types?active=true&pageSize=500`).then(r => r?.data || []).catch(() => []),
      stGet(`/settings/v2/tenant/${ST_TENANT_ID}/employees?active=true&pageSize=500`).then(r => r?.data || []).catch(() => []),
      stGet(`/memberships/v2/tenant/${ST_TENANT_ID}/membership-types?active=true&pageSize=200`).then(r => r?.data || []).catch(() => []),
    ])
    const [jobTypeSpiffs, csrUsers, membershipTypeSpiffs, profiles] = await Promise.all([
      supabase.from('job_type_spiffs').select('*'),
      supabase.from('csr_st_users').select('*'),
      supabase.from('membership_type_spiffs').select('*'),
      supabase.from('profiles').select('id, name, email, role').eq('active', true).order('name'),
    ])
    res.json({
      stJobTypes: jt.map(j => ({ id: j.id, name: j.name })),
      stEmployees: emp.map(e => ({ id: e.id, name: e.name, email: e.email })).sort((a,b)=>(a.name||'').localeCompare(b.name||'')),
      stMembershipTypes: mt.map(m => ({ id: m.id, name: m.name })),
      jobTypeSpiffs: jobTypeSpiffs.data || [],
      csrUsers: csrUsers.data || [],
      membershipTypeSpiffs: membershipTypeSpiffs.data || [],
      profiles: profiles.data || [],
    })
  } catch (err) {
    console.error('commission config error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Save job-type → category/amount
app.post('/api/commission/job-types', async (req, res) => {
  try {
    const rows = (req.body?.rows || []).map(r => ({
      st_job_type_id: r.st_job_type_id, name: r.name || null,
      category: r.category || 'other',
      amount: (r.amount === '' || r.amount == null) ? null : Number(r.amount),
      updated_at: new Date().toISOString(),
    }))
    if (rows.length) {
      const { error } = await supabase.from('job_type_spiffs').upsert(rows, { onConflict: 'st_job_type_id' })
      if (error) throw new Error(error.message)
    }
    res.json({ ok: true, count: rows.length })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Save CSR ↔ ST user map (replace-all)
app.post('/api/commission/csr-users', async (req, res) => {
  try {
    const rows = (req.body?.rows || []).filter(r => r.st_user_id && r.profile_id).map(r => ({
      profile_id: r.profile_id, st_user_id: Number(r.st_user_id), st_user_name: r.st_user_name || null,
    }))
    await supabase.from('csr_st_users').delete().neq('st_user_id', 0)
    if (rows.length) {
      const { error } = await supabase.from('csr_st_users').upsert(rows, { onConflict: 'st_user_id' })
      if (error) throw new Error(error.message)
    }
    res.json({ ok: true, count: rows.length })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── ST: Pricebook services — the candidate "sale tasks" for a membership.
// ServiceTitan calls Pricebook items "tasks" in the sale/invoice APIs, which is
// why POST /memberships/sale wants a saleTaskId. Nothing in the API says which
// service sells which membership type, so an admin picks it from this list.
// The pricebook has ~1,600 services, so this is ALWAYS a search — an unfiltered
// list silently returns an arbitrary first page and the item you want (e.g. the
// membership sale tasks) simply isn't in it. totalCount is returned so the UI
// can say when results are truncated rather than pretending it showed you
// everything. Paging the whole book here would be ~9 sequential ST calls and
// blow the request timeout.
app.get('/api/st/pricebook-services', async (req, res) => {
  try {
    const q = (req.query.q || '').trim()
    const search = q ? `&searchText=${encodeURIComponent(q)}` : ''
    const data = await stGet(`/pricebook/v2/tenant/${ST_TENANT_ID}/services?active=True&pageSize=200&includeTotal=true${search}`)
    const rows = (data?.data || []).map(s => ({
      id: s.id, code: s.code, name: s.displayName || s.description || s.code, price: s.price,
    })).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    res.json({ data: rows, totalCount: data?.totalCount ?? null, truncated: (data?.totalCount ?? 0) > rows.length })
  } catch (err) {
    console.error('ST pricebook services error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── ST: Duration/billing options for a membership type. These carry the id that
// POST /memberships/sale needs — the durationBilling array on the membership
// type itself has no ids, so it has to come from here.
app.get('/api/st/membership-types/:id/duration-billing', async (req, res) => {
  try {
    const data = await stGet(`/memberships/v2/tenant/${ST_TENANT_ID}/membership-types/${req.params.id}/duration-billing-items`)
    const rows = (Array.isArray(data) ? data : data?.data || []).map(d => ({
      id: d.id,
      duration: d.duration,
      billingFrequency: typeof d.billingFrequency === 'string' ? d.billingFrequency : d.billingFrequency?.name || '',
      salePrice: d.salePrice,
      billingPrice: d.billingPrice,
      active: d.active,
    }))
    res.json({ data: rows })
  } catch (err) {
    console.error('ST duration-billing error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Save membership-type → payout
app.post('/api/commission/membership-types', async (req, res) => {
  try {
    const rows = (req.body?.rows || []).map(r => ({
      st_membership_type_id: r.st_membership_type_id, name: r.name || null,
      amount: (r.amount === '' || r.amount == null) ? 20 : Number(r.amount),
      sale_task_id: r.sale_task_id ? Number(r.sale_task_id) : null,
      sale_task_name: r.sale_task_name || null,
      duration_billing_id: r.duration_billing_id ? Number(r.duration_billing_id) : null,
      business_unit_id: r.business_unit_id ? Number(r.business_unit_id) : null,
      updated_at: new Date().toISOString(),
    }))
    if (rows.length) {
      const { error } = await supabase.from('membership_type_spiffs').upsert(rows, { onConflict: 'st_membership_type_id' })
      if (error) throw new Error(error.message)
    }
    res.json({ ok: true, count: rows.length })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─────────────────────────────────────────────
// ── COMMISSION SYNC (ServiceTitan → commissions)
// ─────────────────────────────────────────────
// Reps are paid when ServiceTitan reports the job Completed, at the amount
// tagged against the job type in job_type_spiffs.
//
// Attribution is LOCAL, not from ServiceTitan: andi_bookings already records
// st_job_id → profile_id at booking time. We deliberately don't use the job's
// soldById, which is a *technician* id (the tech who ran the call), not the
// CSR who booked it.
//
// Idempotency is at the database: commissions has a unique index on st_job_id
// and st_membership_id, and every write here is an upsert on those, so a job
// cannot be paid twice even if two instances sync concurrently.

const JOB_TERMINAL = ['Completed', 'Canceled']

// app_settings key holding { category: dollars }, e.g. { "repair": 2 }.
const JOB_CATEGORY_PAYOUTS_KEY = 'job_category_payouts'

// Jobs complete throughout the day; 15 minutes keeps reps' earnings close to
// live without hammering ServiceTitan. COMMISSION_SYNC_MINUTES=0 disables the
// loop (the manual sync endpoint still works).
const SYNC_INTERVAL_MIN = Number(process.env.COMMISSION_SYNC_MINUTES ?? 15)

// ST allows 50 ids per lookup.
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))

async function syncJobCommissions() {
  // Only bookings we haven't already settled. Once a job is Completed (paid)
  // or Canceled (never paid), commission_synced_at is set and we stop asking.
  const { data: open, error } = await supabase
    .from('andi_bookings').select('*').is('commission_synced_at', null).limit(500)
  if (error) throw new Error(`andi_bookings read: ${error.message}`)
  if (!open?.length) return { checked: 0, paid: 0, canceled: 0 }

  // Payouts are per CATEGORY, not per job type: job_type_spiffs tags each of
  // the ~112 ST job types with a category (repair / maintenance /
  // free_estimate / other / non_commissionable) and the amount for each
  // category lives in app_settings. job_type_spiffs.amount is unused.
  const { data: spiffs } = await supabase.from('job_type_spiffs').select('st_job_type_id, category')
  const catByType = {}
  ;(spiffs || []).forEach(s => { catByType[String(s.st_job_type_id)] = s.category })

  const { data: setting } = await supabase
    .from('app_settings').select('value').eq('key', JOB_CATEGORY_PAYOUTS_KEY).maybeSingle()
  let payouts = {}
  try { payouts = JSON.parse(setting?.value || '{}') } catch (e) {
    console.error('job_category_payouts is not valid JSON — no job commissions will be paid')
  }

  let paid = 0, canceled = 0, checked = 0
  for (const batch of chunk(open.filter(b => b.st_job_id), 50)) {
    const ids = batch.map(b => b.st_job_id).join(',')
    const data = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs?ids=${ids}&pageSize=50`)
    const jobs = data?.data || []
    checked += jobs.length

    for (const job of jobs) {
      const booking = batch.find(b => String(b.st_job_id) === String(job.id))
      if (!booking) continue

      // Not finished yet — record status for visibility and check again later.
      if (!JOB_TERMINAL.includes(job.jobStatus)) {
        await supabase.from('andi_bookings').update({ job_status: job.jobStatus }).eq('st_job_id', job.id)
        continue
      }

      if (job.jobStatus === 'Canceled') {
        await supabase.from('andi_bookings')
          .update({ job_status: 'Canceled', commission_synced_at: new Date().toISOString() })
          .eq('st_job_id', job.id)
        canceled++
        continue
      }

      // Completed. Price from the completed job's category — job.jobTypeId is
      // authoritative, since the type can be changed after booking.
      const category = catByType[String(job.jobTypeId)]
      const raw = category == null ? null : payouts[category]
      const amount = raw == null || raw === '' ? null : Number(raw)

      // An unpriced category pays nothing. Leave it UNSETTLED and log it rather
      // than silently paying $0 — setting the amount later should still pay out.
      if (amount == null || Number.isNaN(amount)) {
        console.warn(`Commission sync: job ${job.id} completed but category ${category || `(job type ${job.jobTypeId} untagged)`} has no payout — leaving unsettled`)
        await supabase.from('andi_bookings').update({ job_status: 'Completed' }).eq('st_job_id', job.id)
        continue
      }

      // A deliberate $0 (non_commissionable). Settle it so it stops being
      // polled, but don't write a payout row nobody wants to see.
      if (amount === 0) {
        await supabase.from('andi_bookings')
          .update({ job_status: 'Completed', commission_synced_at: new Date().toISOString() })
          .eq('st_job_id', job.id)
        continue
      }

      const { error: upErr } = await supabase.from('commissions').upsert({
        profile_id: booking.profile_id,
        rep_name: booking.csr_name || 'Unknown',
        event_type: 'booking',
        amount,
        contact_name: booking.customer_name || 'Unknown',
        st_job_id: job.id,
        st_job_type_id: job.jobTypeId,
        st_customer_id: job.customerId,
        job_number: job.jobNumber || null,
        booked_at: booking.booked_at || job.createdOn || null,
        completed_at: job.completedOn || null,
        // Earned when the work was completed, which is what the pay period keys on.
        earned_at: job.completedOn || new Date().toISOString(),
        also_membership: false,
        membership_amount: 0,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'st_job_id' })
      if (upErr) throw new Error(`commission upsert job ${job.id}: ${upErr.message}`)

      await supabase.from('andi_bookings')
        .update({ job_status: 'Completed', commission_synced_at: new Date().toISOString() })
        .eq('st_job_id', job.id)
      paid++
    }
  }
  return { checked, paid, canceled }
}

async function syncMembershipCommissions() {
  // Memberships have no andi_bookings anchor, so page forward from a watermark.
  const { data: state } = await supabase
    .from('sync_state').select('*').eq('key', 'memberships').maybeSingle()
  // First run: look back 30 days rather than all of history.
  const since = state?.last_synced_at || new Date(Date.now() - 30 * 864e5).toISOString()

  const { data: csrUsers } = await supabase.from('csr_st_users').select('*')
  const profileByStUser = {}
  ;(csrUsers || []).forEach(u => { profileByStUser[String(u.st_user_id)] = u })
  if (!Object.keys(profileByStUser).length) return { checked: 0, paid: 0, unattributed: 0 }

  const { data: spiffs } = await supabase.from('membership_type_spiffs').select('*')
  const spiffByType = {}
  ;(spiffs || []).forEach(s => { spiffByType[String(s.st_membership_type_id)] = s })

  let page = 1, paid = 0, checked = 0, unattributed = 0, more = true
  const startedAt = new Date().toISOString()

  while (more && page <= 20) {
    const data = await stGet(`/memberships/v2/tenant/${ST_TENANT_ID}/memberships?createdOnOrAfter=${encodeURIComponent(since)}&page=${page}&pageSize=100`)
    const rows = data?.data || []
    checked += rows.length
    more = rows.length === 100
    page++

    // Only the ones we'll actually pay — no point naming customers we skip.
    const payable = rows.filter(m => m.soldById != null && profileByStUser[String(m.soldById)])
    unattributed += rows.length - payable.length

    // "to which customer" — resolve names in one batched call per 50.
    const nameById = {}
    for (const ids of chunk([...new Set(payable.map(m => m.customerId).filter(Boolean))], 50)) {
      try {
        const cust = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers?ids=${ids.join(',')}&pageSize=50`)
        ;(cust?.data || []).forEach(c => { nameById[String(c.id)] = c.name })
      } catch (e) {
        console.warn('Membership customer name lookup failed:', e.message)
      }
    }

    for (const m of payable) {
      const mapped = profileByStUser[String(m.soldById)]
      const spiff = spiffByType[String(m.membershipTypeId)]
      const amount = spiff?.amount == null ? 20 : Number(spiff.amount)

      const { error: upErr } = await supabase.from('commissions').upsert({
        profile_id: mapped.profile_id,
        rep_name: mapped.st_user_name || 'Unknown',
        event_type: 'membership',
        amount,
        contact_name: nameById[String(m.customerId)] || `Customer ${m.customerId}`,
        st_membership_id: m.id,
        st_membership_type_id: m.membershipTypeId,
        st_customer_id: m.customerId,
        // "when was the membership sold" — createdOn is when the sale was recorded.
        earned_at: m.createdOn || m.from || new Date().toISOString(),
        booked_at: m.createdOn || null,
        also_membership: true,
        membership_amount: amount,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'st_membership_id' })
      if (upErr) throw new Error(`commission upsert membership ${m.id}: ${upErr.message}`)
      paid++
    }
  }

  await supabase.from('sync_state').upsert(
    { key: 'memberships', last_synced_at: startedAt, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  )
  return { checked, paid, unattributed }
}

let syncRunning = false
let lastSync = null

async function syncCommissions() {
  // ST is slow; skip rather than pile up if the previous run is still going.
  if (syncRunning) return { skipped: true }
  syncRunning = true
  const startedAt = new Date().toISOString()
  try {
    const jobs = await syncJobCommissions()
    const memberships = await syncMembershipCommissions()
    lastSync = { at: startedAt, ok: true, jobs, memberships }
    console.log(`Commission sync: ${jobs.paid} job(s) paid, ${jobs.canceled} canceled, ${memberships.paid} membership(s) paid`)
    return lastSync
  } catch (err) {
    lastSync = { at: startedAt, ok: false, error: err.message }
    console.error('Commission sync failed:', err.message)
    return lastSync
  } finally {
    syncRunning = false
  }
}

// Admin-triggered sync — also how you verify the wiring without waiting.
app.post('/api/admin/commission/sync', async (req, res) => {
  const admin = await requireAdmin(req, res)
  if (!admin) return
  const result = await syncCommissions()
  if (result?.ok === false) return res.status(500).json(result)
  res.json(result)
})

app.get('/api/admin/commission/sync-status', async (req, res) => {
  const admin = await requireAdmin(req, res)
  if (!admin) return
  res.json({ lastSync, running: syncRunning, intervalMinutes: SYNC_INTERVAL_MIN })
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

    // Record attribution for the commission engine (best-effort; never blocks booking)
    try {
      if (jobId) {
        let profileId = null
        if (repName) {
          const { data: prof } = await supabase.from('profiles').select('id').eq('name', repName).maybeSingle()
          profileId = prof?.id || null
        }
        await supabase.from('andi_bookings').upsert({
          st_job_id: jobId,
          profile_id: profileId,
          csr_name: repName || null,
          customer_name: contactName || null,
          st_job_type_id: jobTypeId || null,
          booked_at: new Date().toISOString(),
        }, { onConflict: 'st_job_id' })
      }
    } catch (e) { console.warn('andi_bookings insert:', e.message) }

    res.json({ ok: true, jobId, jobNumber, locationId: location.id })
  } catch (err) {
    console.error('ST booking error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── ST: Sell a membership from the dialer.
//
// ⚠ THIS CREATES A REAL INVOICE against a real customer in production
// ServiceTitan — POST /memberships/sale is documented as "Creates membership
// sale invoice" and returns { invoiceId, customerMembershipId }. It is
// deliberately admin-only until it has been proven on a real sale; flip
// MEMBERSHIP_SALE_ALL_REPS=1 to open it to every rep.
//
// saleTaskId/durationBillingId come from the per-type mapping an admin sets in
// Commission Mapping — ServiceTitan exposes no way to derive them.
const MEMBERSHIP_SALE_ALL_REPS = process.env.MEMBERSHIP_SALE_ALL_REPS === '1'

app.post('/api/st/membership/sell', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Not signed in' })
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' })

  const { data: caller } = await supabase
    .from('profiles').select('id, name, email, role, active').eq('id', user.id).maybeSingle()
  if (!caller || caller.active === false) return res.status(403).json({ error: 'Inactive user' })
  if (!MEMBERSHIP_SALE_ALL_REPS && caller.role !== 'admin') {
    return res.status(403).json({ error: 'Selling memberships is limited to admins right now' })
  }

  const { customerId, membershipTypeId, contactId } = req.body
  if (!customerId || !membershipTypeId) {
    return res.status(400).json({ error: 'customerId and membershipTypeId required' })
  }

  const csrName = caller.name || caller.email
  const audit = {
    profile_id: caller.id, csr_name: csrName, contact_id: contactId || null,
    st_customer_id: Number(customerId), st_membership_type_id: Number(membershipTypeId),
  }

  try {
    const { data: spiff } = await supabase
      .from('membership_type_spiffs').select('*')
      .eq('st_membership_type_id', membershipTypeId).maybeSingle()

    if (!spiff?.sale_task_id || !spiff?.duration_billing_id) {
      throw new Error('This membership type has no sale task / duration billing set. An admin must map it under Settings → Commission → Commission Mapping.')
    }

    // Business unit: the mapped one, else the customer's location's.
    let businessUnitId = spiff.business_unit_id
    if (!businessUnitId) {
      const locData = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/locations?customerId=${customerId}&pageSize=1`)
      businessUnitId = locData?.data?.[0]?.businessUnitId
      if (!businessUnitId) throw new Error('No business unit found for this customer — set one on the membership type mapping.')
    }

    audit.st_sale_task_id = spiff.sale_task_id
    audit.st_duration_billing_id = spiff.duration_billing_id

    // NOTE the explicit `false`: stPost retries once on timeout, which is fine
    // for reads and safe-ish for jobs, but NOT here. A timeout on a request that
    // actually succeeded would bill this customer twice. Fail loudly instead —
    // a missing invoice is recoverable, a duplicate one is not.
    const sale = await stPost(`/memberships/v2/tenant/${ST_TENANT_ID}/memberships/sale`, {
      customerId: Number(customerId),
      businessUnitId: Number(businessUnitId),
      saleTaskId: Number(spiff.sale_task_id),
      durationBillingId: Number(spiff.duration_billing_id),
      // 'None' touches no recurring services — the conservative choice. ST only
      // requires this when recurringLocationId is set, which we don't set.
      recurringServiceAction: 'None',
    }, false)

    audit.st_customer_membership_id = sale?.customerMembershipId || null
    audit.st_invoice_id = sale?.invoiceId || null

    // Credit the CSR. soldById is what the membership commission sync reads, so
    // without this the rep never gets paid for it. Best-effort: the sale already
    // happened and must not be reported as failed if only the credit misses.
    let creditWarning = null
    const { data: stUser } = await supabase
      .from('csr_st_users').select('st_user_id').eq('profile_id', caller.id).maybeSingle()

    if (!stUser?.st_user_id) {
      creditWarning = `${csrName} is not mapped to a ServiceTitan user, so the sale is not credited to them.`
    } else if (sale?.customerMembershipId) {
      try {
        await stPatch(`/memberships/v2/tenant/${ST_TENANT_ID}/memberships/${sale.customerMembershipId}`,
          { soldById: Number(stUser.st_user_id) })
      } catch (e) {
        creditWarning = `Membership sold, but crediting ${csrName} failed: ${e.message}`
        console.warn('membership soldById patch:', e.message)
      }
    }

    audit.ok = true
    await supabase.from('andi_membership_sales').insert(audit)
    console.log(`Membership sold by ${csrName}: customer ${customerId}, membership ${sale?.customerMembershipId}, invoice ${sale?.invoiceId}`)

    res.json({
      ok: true,
      customerMembershipId: sale?.customerMembershipId,
      invoiceId: sale?.invoiceId,
      warning: creditWarning,
    })
  } catch (err) {
    audit.ok = false
    audit.error = err.message
    await supabase.from('andi_membership_sales').insert(audit).catch(() => {})
    console.error('Membership sale error:', err.message)
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
// ── ADMIN: USER MANAGEMENT
// ─────────────────────────────────────────────

// Resolve the caller from their Supabase access token and confirm they're an
// admin. These routes use the service key, which bypasses RLS entirely, so the
// check here is the ONLY thing standing between the anon internet and the
// user table. Never mount an /api/admin route without it.
async function requireAdmin(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) { res.status(401).json({ error: 'Not signed in' }); return null }

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) { res.status(401).json({ error: 'Invalid session' }); return null }

  const { data: prof } = await supabase
    .from('profiles').select('id, role, active').eq('id', user.id).maybeSingle()
  if (prof?.role !== 'admin' || prof?.active === false) {
    res.status(403).json({ error: 'Admins only' }); return null
  }
  return prof
}

// Ban for ~100 years. Supabase has no "ban forever", so this is the idiom.
const FOREVER = '876000h'

// ── Deactivate a user: revoke login, hide them app-wide, free their leads.
// Their call_logs and commissions are intentionally left untouched — they're
// historical pay records. Reversible via /reactivate.
app.post('/api/admin/user/deactivate', async (req, res) => {
  const admin = await requireAdmin(req, res)
  if (!admin) return

  const { userId } = req.body
  if (!userId) return res.status(400).json({ error: 'userId required' })
  if (userId === admin.id) return res.status(400).json({ error: "You can't deactivate yourself" })

  try {
    const { data: target } = await supabase
      .from('profiles').select('id, name, email, role').eq('id', userId).maybeSingle()
    if (!target) return res.status(404).json({ error: 'User not found' })

    // Don't allow removing the last admin — it would lock everyone out of /settings.
    if (target.role === 'admin') {
      const { count } = await supabase
        .from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('active', true)
      if ((count ?? 0) <= 1) return res.status(400).json({ error: 'Cannot deactivate the last admin' })
    }

    // 1. Kill the login. Existing access tokens stay valid until they expire,
    //    so AuthContext also signs out any profile with active === false.
    const { error: banErr } = await supabase.auth.admin.updateUserById(userId, { ban_duration: FOREVER })
    if (banErr) throw new Error(`Could not revoke login: ${banErr.message}`)

    // 2. Hide from Live/Attendance/Leaderboard and stop status tracking.
    const { error: profErr } = await supabase.from('profiles').update({
      active: false,
      deactivated_at: new Date().toISOString(),
      status: 'Offline',
      status_since: new Date().toISOString(),
    }).eq('id', userId)
    if (profErr) throw new Error(`Could not update profile: ${profErr.message}`)

    // 3. Release their claimed leads back into the pool. contacts.claimed_by is
    //    a display-name string (DialerPage: profile.name || profile.email), so
    //    match on both — a rep who was renamed may have leads under either.
    const claimNames = [target.name, target.email].filter(Boolean)
    let released = 0
    for (const claimName of claimNames) {
      const { data, error } = await supabase.from('contacts')
        .update({ claimed_by: null, claimed_at: null })
        .eq('claimed_by', claimName).select('id')
      if (error) throw new Error(`Could not release leads: ${error.message}`)
      released += data?.length || 0
    }

    // 4. Drop campaign assignments so the lead router skips them.
    await supabase.from('csr_campaigns').delete().eq('profile_id', userId)

    // 5. Close any open status event so Attendance doesn't show an endless shift.
    await supabase.from('status_events')
      .update({ ended_at: new Date().toISOString() })
      .eq('profile_id', userId).is('ended_at', null)

    console.log(`Admin ${admin.id} deactivated user ${userId} (${released} leads released)`)
    res.json({ ok: true, released })
  } catch (err) {
    console.error('Deactivate user error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Reactivate: restore login and visibility. Campaign assignments were
// dropped on deactivate and must be reassigned by hand.
app.post('/api/admin/user/reactivate', async (req, res) => {
  const admin = await requireAdmin(req, res)
  if (!admin) return

  const { userId } = req.body
  if (!userId) return res.status(400).json({ error: 'userId required' })

  try {
    const { error: banErr } = await supabase.auth.admin.updateUserById(userId, { ban_duration: 'none' })
    if (banErr) throw new Error(`Could not restore login: ${banErr.message}`)

    const { error: profErr } = await supabase.from('profiles')
      .update({ active: true, deactivated_at: null }).eq('id', userId)
    if (profErr) throw new Error(`Could not update profile: ${profErr.message}`)

    console.log(`Admin ${admin.id} reactivated user ${userId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Reactivate user error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────
// ── 3-DAY CALL BOARD
// ─────────────────────────────────────────────
// Repair/replacement capacity board per trade for today + next two days, live
// from ServiceTitan. Business unit names encode trade + role ("COS - HVAC
// Service" / "COS - HVAC Install"), so no manual mapping is needed.

const BOARD_TRADES = ['HVAC', 'Plumbing', 'Electrical', 'Garage Door']

function classifyBU(name) {
  const n = (name || '').toLowerCase()
  const trade = n.includes('hvac') ? 'HVAC'
    : n.includes('plumb') ? 'Plumbing'
    : n.includes('electric') ? 'Electrical'
    : n.includes('garage') ? 'Garage Door' : null
  const role = n.includes('install') ? 'install'
    : n.includes('service') ? 'service'
    : n.includes('maint') ? 'maintenance' : null
  return { trade, role }
}

// Minutes to add to a Denver wall-clock time to get UTC (handles MST/MDT).
function denverOffsetMs() {
  const d = new Date()
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }))
  const den = new Date(d.toLocaleString('en-US', { timeZone: 'America/Denver' }))
  return utc.getTime() - den.getTime()
}

// The UTC window for a shop-local (Denver) day, `offset` days from today.
function boardDay(offset) {
  const now = new Date()
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(now.getTime() + offset * 864e5))
  const off = denverOffsetMs()
  const startUtc = new Date(Date.parse(dateStr + 'T00:00:00Z') + off)
  const endUtc = new Date(startUtc.getTime() + 864e5)
  return { date: dateStr, startUtc, endUtc }
}

// Cache technicians (rarely change) so a 2-min poll doesn't refetch every time.
let techCache = null
async function getBoardTechs() {
  if (techCache && techCache.expires > Date.now()) return techCache.data
  const res = await stGet(`/settings/v2/tenant/${ST_TENANT_ID}/technicians?active=true&pageSize=500`)
  const data = (res?.data || []).map(t => ({ id: t.id, name: t.name, businessUnitId: t.businessUnitId, team: t.team }))
  techCache = { data, expires: Date.now() + 10 * 60_000 }
  return data
}

const chunkIds = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))

async function build3DayBoard() {
  const days = [0, 1, 2].map(boardDay)

  // Defined up here on purpose: the install-consumption lookup below needs it,
  // and a `const` arrow is not hoisted — declaring it further down threw a
  // temporal-dead-zone ReferenceError that the lookup's own try/catch quietly
  // swallowed, silently reverting the board to the raw head count.
  const overlapHours = (sh, day) => {
    const s = Math.max(sh.start.getTime(), day.startUtc.getTime())
    const e = Math.min(sh.end.getTime(), day.endUtc.getTime())
    return e > s ? (e - s) / 3600_000 : 0
  }

  // Business unit map: id → { trade, role }
  const buRes = await stGet(`/settings/v2/tenant/${ST_TENANT_ID}/business-units?active=true&pageSize=200`)
  const buMap = {}
  ;(buRes?.data || []).forEach(b => { buMap[b.id] = classifyBU(b.name) })
  const serviceBU = {}, installBU = {}
  Object.entries(buMap).forEach(([id, c]) => {
    if (c.role === 'service' && c.trade) serviceBU[c.trade] = Number(id)
    if (c.role === 'install' && c.trade) installBU[c.trade] = Number(id)
  })

  // Techs by home BU (for the Service-tech head count). Exclude the Leadership
  // team — ops managers (Dale Chason, Dean Christian, Ed Acosta, Cedric
  // Hendricks…) have a service BU as their home but aren't field capacity.
  const techs = await getBoardTechs()
  const techsByBU = {}
  techs.forEach(t => { if (t.businessUnitId != null && t.team !== 'Leadership') (techsByBU[t.businessUnitId] ||= []).push(t.id) })

  // All shifts across the 3-day window. A tech counts as scheduled that day only
  // if they have a WORKING shift (not TimeOff) — no shift means they're off, so
  // on weekends only the handful actually scheduled show up. TimeOff overlapping
  // a working shift prorates it (half-day = 0.5).
  const shiftRes = await stGet(`/dispatch/v2/tenant/${ST_TENANT_ID}/technician-shifts?startsOnOrAfter=${days[0].startUtc.toISOString()}&endsOnOrBefore=${days[2].endUtc.toISOString()}&pageSize=500`)
  const shifts = (shiftRes?.data || []).map(s => ({ tech: s.technicianId, type: s.shiftType, start: new Date(s.start), end: new Date(s.end) }))

  // Job-type → category (splits opportunities from warranty/callback) and name
  // (for drill-downs).
  const { data: spiffs } = await supabase.from('job_type_spiffs').select('st_job_type_id, category, name')
  const catByType = {}, nameByType = {}
  ;(spiffs || []).forEach(s => { catByType[String(s.st_job_type_id)] = s.category; nameByType[String(s.st_job_type_id)] = s.name })

  // Calls-per-tech per trade (default 3), admin-tunable in app_settings.
  const { data: cptRow } = await supabase.from('app_settings').select('value').eq('key', 'board_calls_per_tech').maybeSingle()
  let callsPerTech = {}
  try { callsPerTech = JSON.parse(cptRow?.value || '{}') } catch {}
  const cpt = (trade) => Number(callsPerTech[trade]) || 3

  // How much install work has to land on a service tech before it counts
  // against service capacity. A short install tacked onto a service day doesn't
  // stop them running calls — only a big block genuinely takes the day. Below
  // the threshold the tech stays fully available; at or above it, the hours
  // prorate as normal. Admin-tunable; 4h default.
  const { data: insThRow } = await supabase.from('app_settings').select('value').eq('key', 'board_install_threshold_hours').maybeSingle()
  const INSTALL_MIN_HOURS = Number(String(insThRow?.value ?? '').replace(/"/g, '')) || 4

  // Jobs per day (one ST call per day). Keep the fields the board + drill-down need.
  const jobsByDay = await Promise.all(days.map(d =>
    stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs?appointmentStartsOnOrAfter=${d.startUtc.toISOString()}&appointmentStartsBefore=${d.endUtc.toISOString()}&pageSize=500`)
      .then(r => r?.data || []).catch(() => [])
  ))

  // ── Install consumption ────────────────────────────────────────────────
  // A service tech pulled onto an install is NOT available for service calls,
  // but they still have a working shift, so the head count counted them and the
  // board asked CSRs to fill slots that don't exist. Real case: Nick Jacquez
  // and Bryce Russell, both COS - Plumbing Service techs, on a 12.5h Whole Home
  // Water Treatment Install — the board still showed 6 plumbing techs and
  // "6 calls needed".
  //
  // ST filter behaviour here is treacherous (all verified):
  //  - appointments: startsOnOrAfter works, startsOnOrBefore is IGNORED.
  //  - appointment-assignments: jobIds and date filters are IGNORED, but
  //    appointmentIds works and batches (~50 ids per call).
  //  - Do NOT try to find assignments via modifiedOnOrAfter: installs get
  //    scheduled weeks ahead (this one was assigned 3 weeks prior), so any
  //    recent-modification window silently misses exactly the long jobs that
  //    matter most.
  // Look back 3 days so multi-day installs that STARTED earlier still count.
  const apptLookback = new Date(days[0].startUtc.getTime() - 3 * 864e5)
  let installHours = {}   // `${techId}|${dayIndex}` → hours
  try {
    const apptRes = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/appointments?startsOnOrAfter=${apptLookback.toISOString()}&pageSize=500`)
    const appts = (apptRes?.data || []).filter(a => a.start && a.end && a.active !== false)

    // Only appointments that actually overlap a board day are worth resolving.
    const relevant = appts.filter(a => {
      const s = new Date(a.start), e = new Date(a.end)
      return days.some(d => s < d.endUtc && e > d.startUtc)
    })

    // jobId → business unit, so we can tell install work from service work.
    const jobBU = {}
    jobsByDay.flat().forEach(j => { jobBU[j.id] = j.businessUnitId })
    const missing = [...new Set(relevant.map(a => a.jobId).filter(id => id && jobBU[id] === undefined))]
    for (let i = 0; i < missing.length; i += 50) {
      try {
        const r = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs?ids=${missing.slice(i, i + 50).join(',')}&pageSize=50`)
        ;(r?.data || []).forEach(j => { jobBU[j.id] = j.businessUnitId })
      } catch (e) { console.warn('board install jobs:', e.message) }
    }

    const installBUIds = new Set(Object.values(installBU))
    const installAppts = relevant.filter(a => installBUIds.has(jobBU[a.jobId]))
    if (installAppts.length) {
      const byId = {}
      installAppts.forEach(a => { byId[a.id] = a })
      const ids = Object.keys(byId)
      for (let i = 0; i < ids.length; i += 50) {
        try {
          const r = await stGet(`/dispatch/v2/tenant/${ST_TENANT_ID}/appointment-assignments?appointmentIds=${ids.slice(i, i + 50).join(',')}&pageSize=200`)
          for (const asg of (r?.data || [])) {
            if (asg.active === false) continue
            const a = byId[asg.appointmentId]; if (!a) continue
            days.forEach((d, di) => {
              const h = overlapHours({ start: new Date(a.start), end: new Date(a.end) }, d)
              if (h > 0) {
                const k = `${asg.technicianId}|${di}`
                installHours[k] = (installHours[k] || 0) + h
              }
            })
          }
        } catch (e) { console.warn('board assignments:', e.message) }
      }
    }
  } catch (e) {
    // Degrade to the old head count rather than failing the whole board — but
    // shout about it. This catch once hid a ReferenceError of mine and the
    // board just quietly kept over-reporting capacity, which is worse than a
    // visible failure.
    console.error('BOARD: install-consumption lookup FAILED, capacity will be overstated:', e.stack || e.message)
    installHours = {}
  }
  console.log(`BOARD: install consumption computed for ${Object.keys(installHours).length} tech-days`)

  // HVAC maintenance is an opportunity only when the system is 12+ years old.
  // Find which locations (across all 3 days' HVAC maint jobs) qualify, in as
  // few equipment calls as possible.
  const hvacMaintLocs = new Set()
  jobsByDay.flat().forEach(j => {
    const t = buMap[j.businessUnitId]?.trade
    if (t === 'HVAC' && catByType[String(j.jobTypeId)] === 'maintenance' && j.locationId) hvacMaintLocs.add(j.locationId)
  })
  const oldSystemLocs = new Set()
  for (const batch of chunkIds([...hvacMaintLocs], 50)) {
    try {
      const eq = await stGet(`/equipmentsystems/v2/tenant/${ST_TENANT_ID}/installed-equipment?locationIds=${batch.join(',')}&pageSize=500`)
      const ageByLoc = {}
      ;(eq?.data || []).forEach(e => {
        const d = e.installedOn || e.createdOn
        if (!d || e.locationId == null) return
        const yrs = (Date.now() - new Date(d).getTime()) / (365.25 * 864e5)
        ageByLoc[e.locationId] = Math.max(ageByLoc[e.locationId] || 0, yrs)
      })
      Object.entries(ageByLoc).forEach(([lid, yrs]) => { if (yrs >= 12) oldSystemLocs.add(Number(lid)) })
    } catch (e) { console.warn('board equipment age:', e.message) }
  }

  const isCountedCall = (j) => !EXCLUDE_CALL.test(nameByType[String(j.jobTypeId)] || '')

  // An opportunity = a job with a real shot at a repair/replacement sale.
  // Excludes installs, warranty/callback (non_commissionable), the non-productive
  // types above, and maintenance — except HVAC maintenance on a 12+ year system.
  const isOpportunity = (j) => {
    const cat = catByType[String(j.jobTypeId)]
    const trade = buMap[j.businessUnitId]?.trade
    const role = buMap[j.businessUnitId]?.role
    if (role === 'install' || cat === 'non_commissionable' || !isCountedCall(j)) return false
    if (cat === 'maintenance') return trade === 'HVAC' && oldSystemLocs.has(j.locationId)
    return true
  }
  // id is carried alongside jobNumber because ServiceTitan deep links key on
  // the internal id (#/Job/Index/{id}), not the human-facing job number.
  const jobRow = (j) => ({ id: j.id, jobNumber: j.jobNumber, type: nameByType[String(j.jobTypeId)] || 'Job' })

  // Hours of a shift that fall within a given day.
  const techName = (id) => (techs.find(t => t.id === id)?.name) || `Tech ${id}`

  const board = BOARD_TRADES.map(trade => {
    const svc = serviceBU[trade], ins = installBU[trade]
    const svcTechIds = techsByBU[svc] || []
    const perDay = days.map((day, di) => {
      const jobs = jobsByDay[di]

      // Techs scheduled: only those with a working shift that day. A scheduled
      // tech is one full tech regardless of shift LENGTH — Sundays run a full day
      // on shorter hours, so proration is against the tech's own shift, not a
      // fixed 8h. Only time-off inside their shift reduces them (half-day = 0.5).
      // No working shift that day = not scheduled = 0. Roster kept for drill-down.
      let techsAvail = 0
      const techList = []
      for (const techId of svcTechIds) {
        const my = shifts.filter(s => s.tech === techId)
        const workH = my.filter(s => s.type !== 'TimeOff').reduce((a, s) => a + overlapHours(s, day), 0)
        if (workH <= 0) continue   // not scheduled today
        const offH = my.filter(s => s.type === 'TimeOff').reduce((a, s) => a + overlapHours(s, day), 0)
        // Hours already sold to an install come off the same way time off does:
        // a tech on a 12h install has no service capacity left, even though
        // they're on shift. Capped at their shift so a long install can't push
        // availability negative. Ignored entirely below INSTALL_MIN_HOURS — an
        // hour of install tacked onto a service day shouldn't shave the board.
        const rawInsH = installHours[`${techId}|${di}`] || 0
        const insH = rawInsH >= INSTALL_MIN_HOURS ? Math.min(rawInsH, workH) : 0
        const avail = Math.max(0, Math.min((workH - offH - insH) / workH, 1))
        techsAvail += avail
        techList.push({
          name: techName(techId),
          off: avail >= 1 ? null
            : avail <= 0 ? (insH > 0 ? 'on install' : 'off')
            : `${Math.round(avail * 100)}%${insH > 0 ? ' (install)' : ''}`,
        })
      }
      techsAvail = Math.round(techsAvail * 10) / 10

      // Booked calls exclude follow-up / callback / permitting / phone-call types.
      const svcJobs = jobs.filter(j => j.businessUnitId === svc && isCountedCall(j))
      const oppJobs = jobs.filter(j => buMap[j.businessUnitId]?.trade === trade && isOpportunity(j))
      const installJobs = jobs.filter(j => j.businessUnitId === ins)

      const capacity = Math.round(techsAvail * cpt(trade) * 10) / 10
      const pct = capacity > 0 ? svcJobs.length / capacity : (svcJobs.length > 0 ? 1 : 0)
      const needed = Math.max(0, Math.round(capacity - svcJobs.length))
      // Target is 80%: green at/over, amber climbing, red well below.
      const status = capacity === 0 ? 'none' : pct >= 0.8 ? 'good' : pct >= 0.6 ? 'warn' : 'under'
      return {
        date: day.date, techs: techsAvail, calls: svcJobs.length, capacity,
        pct: Math.round(pct * 100), needed, opps: oppJobs.length, installs: installJobs.length, status,
        detail: {
          techs: techList,
          calls: svcJobs.map(jobRow),
          opps: oppJobs.map(jobRow),
          installs: installJobs.map(jobRow),
        },
      }
    })
    return { trade, days: perDay }
  })

  return { generatedAt: new Date().toISOString(), target: 80, dates: days.map(d => d.date), board }
}

app.get('/api/board/3day', async (req, res) => {
  try {
    res.json(await build3DayBoard())
  } catch (err) {
    console.error('3-day board error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Calls-per-tech per trade (admin-tunable). GET returns current + defaults.
app.get('/api/board/config', async (req, res) => {
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'board_calls_per_tech').maybeSingle()
  let cpt = {}
  try { cpt = JSON.parse(data?.value || '{}') } catch {}
  res.json({ trades: BOARD_TRADES, callsPerTech: cpt, default: 3 })
})
app.post('/api/board/config', async (req, res) => {
  const admin = await requireAdmin(req, res)
  if (!admin) return
  const clean = {}
  BOARD_TRADES.forEach(t => { const v = Number(req.body?.callsPerTech?.[t]); if (v > 0) clean[t] = v })
  const { error } = await supabase.from('app_settings').upsert(
    { key: 'board_calls_per_tech', value: JSON.stringify(clean) }, { onConflict: 'key' })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true, callsPerTech: clean })
})

// ─────────────────────────────────────────────
// ── TWILIO
// ─────────────────────────────────────────────

// ── Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', phone: twilioPhone })
})

// ── Rep status → TaskRouter Worker Activity.
//
// The queue only routes to workers whose activity is Available. If this doesn't
// fire, a rep can show "Available" in Andi and still never get a call — so it's
// called from the client whenever status changes, and is safe to call often.
app.post('/api/twilio/worker-activity', async (req, res) => {
  try {
    if (!TWILIO_WORKSPACE_SID) return res.json({ ok: false, skipped: 'no workspace configured' })
    const { profileId, status } = req.body
    if (!profileId) return res.status(400).json({ error: 'profileId required' })

    const workers = await twilioClient.taskrouter.v1.workspaces(TWILIO_WORKSPACE_SID).workers.list({ limit: 100 })
    const worker = workers.find(w => {
      try { return JSON.parse(w.attributes || '{}').profile_id === profileId } catch { return false }
    })
    if (!worker) return res.json({ ok: false, skipped: 'no worker for this profile' })

    // Read the skill state from the DB rather than trusting only the passed
    // status, so this is correct whether it's poked by a status change or a
    // queue-availability toggle.
    const { data: prof } = await supabase
      .from('profiles').select('status, inbound_skill, inbound_available').eq('id', profileId).maybeSingle()
    const effStatus = status || prof?.status

    // A rep takes inbound only while their status is Available AND — if they've
    // been granted the inbound skill — they've toggled that queue on. Reps with
    // no inbound skill granted keep the pre-skills behavior (Available → inbound)
    // so nothing changes until the admin starts assigning skills.
    const takesInbound = effStatus === 'Available' && (prof?.inbound_skill ? prof.inbound_available : true)
    const target = takesInbound ? TWILIO_ACTIVITY_AVAILABLE : TWILIO_ACTIVITY_OFFLINE
    if (worker.activitySid === target) return res.json({ ok: true, unchanged: true })

    await twilioClient.taskrouter.v1.workspaces(TWILIO_WORKSPACE_SID)
      .workers(worker.sid).update({ activitySid: target })
    res.json({ ok: true, activitySid: target })
  } catch (err) {
    // Never block the UI on this — the rep's Andi status still updates.
    console.warn('worker-activity sync failed:', err.message)
    res.status(500).json({ error: err.message })
  }
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
  const p = { ...req.query, ...req.body }
  const to = p.to || p.To

  // Record the outbound leg. The dialer places calls through the Voice SDK →
  // TwiML app → here, NOT through /api/twilio/call — so without this, outbound
  // calls never reached active_calls at all and the Live board only ever saw
  // inbound. Fire-and-forget: never delay the TwiML response for a log write.
  if (p.CallSid) {
    supabase.from('active_calls').upsert({
      call_sid: p.CallSid,
      direction: 'outbound',
      rep_identity: p.identity || null,
      contact_id: p.contactId || null,
      contact_name: p.contactName || null,
      to_number: to,
      from_number: twilioPhone,
      status: 'initiated',
      started_at: new Date().toISOString(),
    }, { onConflict: 'call_sid' })
      .then(({ error }) => { if (error) console.warn('outbound active_calls:', error.message) })
  }

  const twiml = new VoiceResponse()
  const dial = twiml.dial({
    callerId: twilioPhone,
    timeout: 30,
    record: 'record-from-answer-dual',
    recordingStatusCallback: `${appUrl}/api/twilio/recording`,
    recordingStatusCallbackEvent: 'completed',
  })
  // statusCallback closes the row out — otherwise it sticks at 'initiated'
  // forever, exactly the stale-row bug inbound had.
  dial.number({
    statusCallback: `${appUrl}/api/twilio/status`,
    statusCallbackEvent: 'initiated ringing answered completed',
    statusCallbackMethod: 'POST',
  }, to)
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
      // Only surface estimates from the last 6 months — an older open estimate is
      // stale pricing the rep shouldn't pitch. Keyed on createdOn (when quoted),
      // falling back to modifiedOn; an estimate with no usable date is dropped.
      const sixMonthsAgo = Date.now() - 182 * 864e5
      const isRecent = e => {
        const d = e.createdOn || e.modifiedOn
        return d && new Date(d).getTime() >= sixMonthsAgo
      }
      const open = all.filter(e => {
        const s = (e.status?.name || '').toLowerCase()
        const isOpen = s === 'open' || (s === '' && e.active !== false && !e.soldOn)
        return isOpen && isRecent(e)
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

  // Lead context. When this customer arrived as a paid lead, the partner's
  // record holds the single richest thing we have: the customer's own words.
  // A Scorpion chat transcript can say the AC blows warm, they already changed
  // the capacitor, AHS installed the unit, and money is tight — none of which
  // exists anywhere in ServiceTitan. Feed it to the brief so the rep opens the
  // call already knowing it.
  try {
    // Match on EITHER key. A brand-new lead has no ServiceTitan customer yet,
    // so promote falls back to storing the booking id in external_id — and that
    // is exactly the case where the transcript matters most, since ST knows
    // nothing about them. Keying only on st_customer_id missed every new lead.
    const { data: lead } = /^\d+$/.test(String(id)) ? await supabase.from('st_leads')
      .select('provider, summary, urgency, job_type, lead_fee, already_booked, booked_job_number, booked_at, submitted_at')
      .or(`st_customer_id.eq.${id},booking_id.eq.${id}`)
      .order('submitted_at', { ascending: false }).limit(1).maybeSingle() : { data: null }
    if (lead?.summary) {
      facts.leadContext = {
        source: lead.provider || null,
        submittedAt: lead.submitted_at || null,
        wants: lead.job_type || null,
        urgency: lead.urgency || null,
        // Trimmed: the brief only needs the substance, not the UTM footer.
        conversation: String(lead.summary).slice(0, 2500),
        alreadyScheduled: lead.already_booked
          ? { job: lead.booked_job_number || null, at: lead.booked_at || null }
          : null,
      }
    }
  } catch (e) { console.warn('facts lead context:', e.message) }

  delete facts._membership
  return facts
}

// Render a structured brief to a single plain-text string (used for the DB
// text column + backward-compatible `brief` field in the response).
function briefToText(bd) {
  if (!bd) return ''
  if (typeof bd === 'string') return bd
  const parts = []
  if (bd.headline) parts.push(bd.headline)
  if (Array.isArray(bd.actions)) bd.actions.forEach(a => a && parts.push('- ' + a))
  if (bd.flag) parts.push('Flag: ' + bd.flag)
  return parts.join('\n')
}

// Normalize whatever the model returned into { headline, actions[], flag }.
function normalizeBrief(parsed, rawText) {
  if (!parsed || !parsed.headline) {
    return rawText ? { headline: rawText, actions: [], flag: null } : null
  }
  return {
    headline: String(parsed.headline || '').trim(),
    actions: Array.isArray(parsed.actions)
      ? parsed.actions.map(a => String(a).trim()).filter(Boolean).slice(0, 3)
      : [],
    flag: parsed.flag ? String(parsed.flag).trim() : null,
  }
}

async function generateBrief(facts) {
  if (!ANTHROPIC_KEY) return null
  const sys = `You produce a pre-call cheat sheet for a call-center rep at Awesome Home Services (HVAC, plumbing, electrical, garage doors) who is LIVE on the phone and can only glance for a second. Optimize every word for customer experience, booking the job, and revenue. You are given ServiceTitan data (JSON).

Return ONLY a JSON object — no markdown, no backticks, no preamble:
{
  "headline": "at most 12 words: who they are plus the single most important thing",
  "actions": ["1 to 3 items, each a short verb-first instruction, highest booking/revenue impact first"],
  "flag": "one critical staff pinned-note warning the rep must not miss, or an empty string"
}

Writing rules:
- headline is glanceable, not a full sentence with filler. Include the sharpest number or status (e.g. equipment age, unresolved issue, open-estimate total, member vs non-member).
- each action is what to DO on THIS call and at most 14 words: book a specific due inspection by name, move a named open estimate forward with its dollar amount, raise the unresolved problem, or offer membership. Concrete over generic.
- MEMBERSHIP — ${MEMBERSHIP_INFO} If isMember is true: one action can thank them and book any maintenanceVisits.due (name it, it's included), and note open estimates get the 15% member discount. If not a member and memberSavings is present: one action offers membership using "up to ~$X" language plus the $49 service fee / included inspections hook. Natural and helpful, never pushy.
- flag: if pinnedNotes exist, put the most important one here; otherwise empty string.
- LEAD CONTEXT — if leadContext is present this person came in as a paid lead and leadContext.conversation is what they actually said (often an AI chat transcript). Mine it hard, it is usually the most valuable data here: the specific symptom, what they've already tried, who installed the equipment, budget worries, the time window they asked for. Put the concrete problem in the headline over anything generic. If leadContext.alreadyScheduled is set, the customer ALREADY has an appointment — the flag must say so with the job number and time, and the actions must be about confirming/preparing that visit, never about booking them again.

CRITICAL: only use what the data supports. Never invent visit names, dates, or savings figures. A missing or zero lifetimeValue is just absent data — never imply non-payment, debt, or anything negative; omit it. If data is sparse, say so in the headline and give one sensible action.`
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
        max_tokens: 400,
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
    let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim()
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return normalizeBrief(parsed, text)
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
          let bd = null
          try { bd = JSON.parse(cached.brief) } catch {}
          if (bd && !bd.headline) bd = null        // legacy plain-text cache row
          const briefText = bd ? briefToText(bd) : cached.brief
          return res.json({ brief: briefText, brief_data: bd, facts: cached.facts, generated_at: cached.generated_at, cached: true, _version: 'intel-v4-structured' })
        }
      }
    }

    const facts = await gatherCustomerFacts(id)
    const debug = facts._debug || null
    delete facts._debug   // keep debug out of Claude prompt + cache
    const briefData = await generateBrief(facts)
    const briefText = briefToText(briefData)
    const generated_at = new Date().toISOString()

    // Cache (best-effort — store the structured brief as JSON in the text column)
    try {
      await supabase.from('customer_briefs')
        .upsert({ customer_id: id, brief: briefData ? JSON.stringify(briefData) : null, facts, generated_at }, { onConflict: 'customer_id' })
    } catch (e) { console.warn('brief cache upsert:', e.message) }

    res.json({ brief: briefText, brief_data: briefData, facts, generated_at, cached: false, _version: 'intel-v4-structured', _debug: debug })
  } catch (err) {
    console.error('Intelligence brief error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Inbound call webhook: put the caller in the TaskRouter queue.
//
// This used to be a ring-all <Dial> to every Available rep. That meant there was
// no queue to measure: no wait time, no answer timestamp, and a caller who hung
// up mid-ring left a row stuck at 'ringing' forever. Callers now enter a real
// queue, and /taskrouter/events records every state change into call_tasks.
//
// Agents still answer through the Voice SDK exactly as before — the assignment
// callback below dequeues the task to client:<identity>.
app.post('/api/twilio/inbound', async (req, res) => {
  const { From, CallSid } = req.body
  console.log(`Inbound call from ${From}, SID: ${CallSid}`)
  const normalizedPhone = (From || '').replace(/\D/g, '').slice(-10)

  let contact = null
  if (normalizedPhone) {
    const { data } = await supabase.from('contacts').select('id, name')
      .ilike('phone', `%${normalizedPhone}%`).limit(1).maybeSingle()
    contact = data
  }

  const twiml = new VoiceResponse()

  // No workflow configured — fall back to voicemail rather than dropping the
  // caller into a queue that can never route them.
  if (!TWILIO_WORKFLOW_SID) {
    console.error('TWILIO_WORKFLOW_SID not set — inbound call cannot be queued')
    twiml.say({ voice: 'alice' }, 'Thank you for calling Awesome Home Services. Please leave a message after the tone.')
    twiml.record({ maxLength: 120, action: `${appUrl}/api/twilio/inbound/complete`, transcribe: false })
    res.type('text/xml')
    return res.send(twiml.toString())
  }

  twiml.say({ voice: 'alice' }, 'Thank you for calling Awesome Home Services. This call may be recorded for quality purposes. Please hold while we connect you.')
  const enqueue = twiml.enqueue({
    workflowSid: TWILIO_WORKFLOW_SID,
    waitUrl: `${appUrl}/api/twilio/queue/wait`,
    waitUrlMethod: 'POST',
  })
  // Attributes ride along to the assignment callback and the events webhook, so
  // we know who's calling without a second lookup.
  enqueue.task(JSON.stringify({
    call_sid: CallSid,
    from_number: From,
    contact_id: contact?.id || null,
    contact_name: contact?.name || null,
  }))

  res.type('text/xml')
  res.send(twiml.toString())
})

// Hold music while queued. Twilio re-requests this as it loops.
app.post('/api/twilio/queue/wait', (req, res) => {
  const twiml = new VoiceResponse()
  twiml.play({ loop: 0 }, 'http://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3')
  res.type('text/xml')
  res.send(twiml.toString())
})

// ── TaskRouter assignment: send the queued caller to the reserved agent.
//
// The dequeue instruction dials the worker's contact_uri (client:<identity>),
// which is the same Voice SDK identity the browser already registers — so reps
// answer exactly as they do today and no worker SDK is needed in the browser.
app.post('/api/twilio/taskrouter/assignment', async (req, res) => {
  try {
    const workerAttrs = JSON.parse(req.body.WorkerAttributes || '{}')
    const taskAttrs = JSON.parse(req.body.TaskAttributes || '{}')
    const contactUri = workerAttrs.contact_uri
    if (!contactUri) {
      console.error('TaskRouter assignment: worker has no contact_uri —', req.body.WorkerSid)
      return res.json({ instruction: 'reject' })
    }
    res.json({
      instruction: 'dequeue',
      to: contactUri,
      // The CALLER's number, not ours. The browser reads call.parameters.From to
      // identify who's ringing (DialerPage 'incoming' handler) — passing
      // twilioPhone here made every inbound call show up as our own number
      // against a blank contact.
      from: taskAttrs.from_number || twilioPhone,
      post_work_activity_sid: TWILIO_ACTIVITY_AVAILABLE || undefined,
      record: 'record-from-answer-dual',
      recording_status_callback: `${appUrl}/api/twilio/recording`,
      recording_status_callback_event: 'completed',
    })
  } catch (err) {
    console.error('TaskRouter assignment error:', err.message)
    res.json({ instruction: 'reject' })
  }
})

// ── TaskRouter events: the only place queue metrics come from.
//
// task.created        -> caller entered the queue        (queued_at)
// reservation.accepted-> an agent picked up              (answered_at, wait_seconds)
// task.canceled       -> caller hung up while waiting    (abandoned, unless inside the grace window)
// task.completed      -> call finished                   (ended_at, talk_seconds)
app.post('/api/twilio/taskrouter/events', async (req, res) => {
  // Always 200: Twilio retries on failure, and a retry storm helps nobody.
  res.sendStatus(200)
  try {
    const type = req.body.EventType
    const taskSid = req.body.TaskSid
    if (!taskSid || !type) return

    let attrs = {}
    try { attrs = JSON.parse(req.body.TaskAttributes || '{}') } catch {}
    const now = new Date().toISOString()

    if (type === 'task.created') {
      await supabase.from('call_tasks').upsert({
        task_sid: taskSid,
        call_sid: attrs.call_sid || null,
        from_number: attrs.from_number || null,
        contact_id: attrs.contact_id || null,
        contact_name: attrs.contact_name || null,
        state: 'queued',
        queued_at: now,
      }, { onConflict: 'task_sid' })
      return
    }

    if (type === 'reservation.accepted') {
      let wattrs = {}
      try { wattrs = JSON.parse(req.body.WorkerAttributes || '{}') } catch {}
      const { data: task } = await supabase.from('call_tasks')
        .select('queued_at').eq('task_sid', taskSid).maybeSingle()
      const wait = task?.queued_at
        ? Math.max(0, Math.round((Date.now() - new Date(task.queued_at).getTime()) / 1000))
        : null
      await supabase.from('call_tasks').update({
        state: 'answered',
        answered_at: now,
        wait_seconds: wait,
        agent_profile_id: wattrs.profile_id || null,
        agent_name: wattrs.name || req.body.WorkerName || null,
      }).eq('task_sid', taskSid)
      return
    }

    if (type === 'task.canceled') {
      // Caller hung up while waiting. Only an abandon if they waited longer than
      // the grace window — anything shorter is a misdial, not a service failure.
      const { data: task } = await supabase.from('call_tasks')
        .select('queued_at, answered_at').eq('task_sid', taskSid).maybeSingle()
      const waited = task?.queued_at
        ? Math.max(0, Math.round((Date.now() - new Date(task.queued_at).getTime()) / 1000))
        : 0
      const isAbandon = !task?.answered_at && waited >= ABANDON_GRACE_SECONDS
      await supabase.from('call_tasks').update({
        state: task?.answered_at ? 'answered' : (isAbandon ? 'abandoned' : 'missed'),
        abandoned: isAbandon,
        wait_seconds: waited,
        ended_at: now,
      }).eq('task_sid', taskSid)
      return
    }

    // task.wrapup fires the moment the call ends; task.completed only fires once
    // the task is closed out. Both must end the row — relying on task.completed
    // alone left calls showing as live forever while the task sat in 'wrapping'.
    if (type === 'task.completed' || type === 'task.deleted' || type === 'task.wrapup') {
      const { data: task } = await supabase.from('call_tasks')
        .select('answered_at, ended_at').eq('task_sid', taskSid).maybeSingle()

      if (!task?.ended_at) {   // may already be closed by task.canceled
        const talk = task?.answered_at
          ? Math.max(0, Math.round((Date.now() - new Date(task.answered_at).getTime()) / 1000))
          : null
        await supabase.from('call_tasks').update({ ended_at: now, talk_seconds: talk }).eq('task_sid', taskSid)
      }

      // Close the task out in TaskRouter too. Nothing else does — a task left
      // in 'wrapping' lingers indefinitely and keeps the worker tied up.
      if (type === 'task.wrapup' && TWILIO_WORKSPACE_SID) {
        try {
          await twilioClient.taskrouter.v1.workspaces(TWILIO_WORKSPACE_SID)
            .tasks(taskSid).update({ assignmentStatus: 'completed', reason: 'call ended' })
        } catch (e) {
          console.warn(`could not complete task ${taskSid}:`, e.message)
        }
      }
    }
  } catch (err) {
    console.error('TaskRouter events error:', err.message)
  }
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

// ═══════════════════════════════════════════════════════════════════════════
// DISPATCH FOR PROFIT
//
// Two surfaces:
//  - Batting Order: which tech to send, ranked within each business unit.
//    CACHED — computing it touches ~100 ST endpoints over 45 days and takes
//    minutes, so a scheduled job writes dispatch_tech_scores and the UI reads
//    that. Never compute this on request.
//  - Live Board Analyzer: today's dispatch board scored against those ranks.
//    Cheap enough to compute per request (today only).
//
// Scoring definitions and the ST filter traps live in lib/dispatchMetrics.js —
// read that before changing any metric.
// ═══════════════════════════════════════════════════════════════════════════

const DISPATCH_WINDOW_DAYS = Number(process.env.DISPATCH_WINDOW_DAYS || 45)
const DISPATCH_REFRESH_HOURS = Number(process.env.DISPATCH_REFRESH_HOURS || 6)
const DISPATCH_WEIGHTS_KEY = 'dispatch_weights'

async function getDispatchWeights() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', DISPATCH_WEIGHTS_KEY).maybeSingle()
  try {
    const w = JSON.parse(data?.value || '{}')
    if (w && Number(w.expectedValue) >= 0) return { expectedValue: +w.expectedValue, closeRate: +w.closeRate, membership: +w.membership }
  } catch {}
  return DEFAULT_WEIGHTS
}

// Resolve technician per job. appointment-assignments ignores jobIds and date
// filters (verified — asking for a date range returns 2024 data); only
// appointmentIds works, batched ~50 at a time.
async function assignmentsForAppointments(appointmentIds) {
  const out = []
  for (let i = 0; i < appointmentIds.length; i += 50) {
    try {
      const d = await stGet(`/dispatch/v2/tenant/${ST_TENANT_ID}/appointment-assignments?appointmentIds=${appointmentIds.slice(i, i + 50).join(',')}&pageSize=200`)
      out.push(...(d?.data || []))
    } catch (e) { console.warn('dispatch assignments batch failed:', e.message) }
  }
  return out
}

async function fetchDispatchWindow(days = DISPATCH_WINDOW_DAYS) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const [jobs, estimates, invoices, memberships, buRes, jtRes] = await Promise.all([
    stPageAll(p => `/jpm/v2/tenant/${ST_TENANT_ID}/jobs?jobStatus=Completed&completedOnOrAfter=${since}&pageSize=200&page=${p}`, 20000),
    stPageAll(p => `/sales/v2/tenant/${ST_TENANT_ID}/estimates?createdOnOrAfter=${since}&pageSize=500&page=${p}`, 20000),
    stPageAll(p => `/accounting/v2/tenant/${ST_TENANT_ID}/invoices?createdOnOrAfter=${since}&pageSize=500&page=${p}`, 20000),
    stPageAll(p => `/memberships/v2/tenant/${ST_TENANT_ID}/memberships?createdOnOrAfter=${since}&pageSize=500&page=${p}`, 20000),
    stGet(`/settings/v2/tenant/${ST_TENANT_ID}/technicians?pageSize=500`),
    stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/job-types?pageSize=500`),
  ])
  const appts = await stPageAll(p => `/jpm/v2/tenant/${ST_TENANT_ID}/appointments?startsOnOrAfter=${since}T00:00:00Z&pageSize=500&page=${p}`, 20000)
  const assignments = await assignmentsForAppointments(appts.map(a => a.id))
  return { jobs, estimates, invoices, memberships, assignments,
           technicians: buRes?.data || [], jobTypes: jtRes?.data || [] }
}

async function refreshDispatchScores() {
  const started = Date.now()
  try {
    const weights = await getDispatchWeights()
    const data = await fetchDispatchWindow()
    const ranked = computeBattingOrder(data, weights, { now: Date.now() })
    const stamp = new Date().toISOString()

    if (ranked.length) {
      const rows = ranked.map(r => ({
        tech_id: r.techId, tech_name: r.techName, business_unit: r.businessUnit,
        jobs: r.jobs, close_rate: r.closeRate, avg_sale: r.avgSale,
        expected_value: r.expectedValue, total_sold: r.totalSold,
        opportunities: r.opportunities, options_per_opp: r.optionsPerOpp,
        membership_pct: r.membershipPct, score: r.score, tier: r.tier, rank: r.rank,
        window_days: DISPATCH_WINDOW_DAYS, refreshed_at: stamp,
      }))
      const { error } = await supabase.from('dispatch_tech_scores')
        .upsert(rows, { onConflict: 'tech_id,business_unit' })
      if (error) throw new Error('scores upsert: ' + error.message)
      // Drop stale rows — a tech who moved BUs would otherwise linger forever.
      await supabase.from('dispatch_tech_scores').delete().lt('refreshed_at', stamp)
    }

    const byType = computeJobTypeOrder(data, { now: Date.now() })
    if (byType.length) {
      const { error: jtErr } = await supabase.from('dispatch_jobtype_scores').upsert(
        byType.map(r => ({
          tech_id: r.techId, tech_name: r.techName, team: r.team,
          job_type_id: r.jobTypeId, job_type: r.jobType,
          opportunities: r.opps, won: r.won, close_rate: r.closeRate,
          avg_sale: r.avgSale, total_sold: r.revenue, expected_value: r.expectedValue,
          thin: r.thin, refreshed_at: stamp,
        })), { onConflict: 'tech_id,job_type_id' })
      if (jtErr) console.error('jobtype upsert:', jtErr.message)
      else await supabase.from('dispatch_jobtype_scores').delete().lt('refreshed_at', stamp)
    }

    const zips = computeZipValue(data.invoices)
    if (zips.length) {
      await supabase.from('dispatch_zip_value').upsert(
        zips.map(z => ({ zip: z.zip, avg_ticket: z.avgTicket, job_count: z.jobCount, tier: z.tier, refreshed_at: stamp })),
        { onConflict: 'zip' })
    }
    console.log(`DISPATCH: scored ${ranked.length} tech-groups, ${byType.length} job-type rows, ${zips.length} zips in ${Math.round((Date.now() - started) / 1000)}s`)
    return { ranked: ranked.length, zips: zips.length, refreshedAt: stamp }
  } catch (err) {
    console.error('DISPATCH: refresh FAILED:', err.stack || err.message)
    throw err
  }
}

app.get('/api/dispatch/batting-order', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const [{ data: rows }, weights] = await Promise.all([
      supabase.from('dispatch_tech_scores').select('*').order('business_unit').order('rank', { nullsFirst: false }),
      getDispatchWeights(),
    ])
    res.json({
      weights,
      windowDays: DISPATCH_WINDOW_DAYS,
      refreshedAt: rows?.[0]?.refreshed_at || null,
      groups: rows || [],
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/dispatch/job-types', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const { data: rows } = await supabase.from('dispatch_jobtype_scores')
      .select('*').order('job_type').order('expected_value', { ascending: false })
    const types = [...new Set((rows || []).map(r => r.job_type))].sort()
    res.json({ types, rows: rows || [], refreshedAt: rows?.[0]?.refreshed_at || null })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/dispatch/refresh', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try { res.json(await refreshDispatchScores()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/dispatch/weights', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const w = req.body?.weights || {}
    const clean = {
      expectedValue: Math.max(0, Number(w.expectedValue) || 0),
      closeRate: Math.max(0, Number(w.closeRate) || 0),
      membership: Math.max(0, Number(w.membership) || 0),
    }
    if (clean.expectedValue + clean.closeRate + clean.membership === 0) {
      return res.status(400).json({ error: 'Weights cannot all be zero.' })
    }
    const { error } = await supabase.from('app_settings')
      .upsert({ key: DISPATCH_WEIGHTS_KEY, value: JSON.stringify(clean) }, { onConflict: 'key' })
    if (error) throw new Error(error.message)
    res.json({ ok: true, weights: clean, note: 'Applies on the next refresh.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Live Board Analyzer ─────────────────────────────────────────────────────
// How valuable is this call likely to be? Deliberately explainable: a
// dispatcher who can't see WHY a call is flagged won't trust the flag.
// Dispatchers read the notes to find the 20-year-old unit — that context never
// reaches the structured equipment records (installed-equipment.installedOn is
// the 2024-26 ServiceTitan onboarding date for every unit, and manufacturedOn
// is empty), so the notes ARE the age signal. ~25% of jobs carry one.
const AGE_PHRASE_RE = /(\d{1,2})\s*\+?\s*(?:year|yr)s?\s*old/i
const AGE_YEAR_RE = /\b(19[89]\d|20[01]\d)\b/g
const stripHtml = (v) => String(v || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')

// Returns the age in years of the oldest system mentioned, or null.
function systemAgeFromNotes(job, nowYear) {
  const txt = stripHtml(`${job?.summary || ''} ${job?.summaryOfWork || ''}`)
  let best = null
  const m = txt.match(AGE_PHRASE_RE)
  if (m) {
    const n = Number(m[1])
    if (n >= 8 && n <= 40) best = n
  }
  // Bare 4-digit years: only trust ones old enough to be an install year rather
  // than a date reference, and cap at 40 so a stray "1985" in prose can't
  // dominate.
  for (const y of (txt.match(AGE_YEAR_RE) || [])) {
    const age = nowYear - Number(y)
    if (age >= 10 && age <= 40) best = Math.max(best ?? 0, age)
  }
  return best
}

const HIGH_VALUE_RE = /replace|replacement|install|estimate|system|upgrade|new /i
const LOW_VALUE_RE = /maintenance|tune|inspection|filter|follow.?up|callback|warranty|permit/i

function scoreOpportunity(jobTypeName, zipTier, isMember, systemAge, isHvac) {
  const reasons = []
  let score = 0
  // Age is the strongest signal in HVAC — an old system turns a no-cool call
  // into a replacement conversation, which is why a dispatcher will hand a
  // routine-looking maintenance to their best closer.
  if (systemAge != null && systemAge >= 12) {
    score += isHvac ? 3 : 1
    reasons.push(`~${systemAge} yr old system`)
  } else if (systemAge != null && systemAge <= 8) {
    // Age cuts BOTH ways: a 2-year-old no-cool is a warranty-flavored repair,
    // not a replacement conversation — don't spend a closer's slot on it.
    score -= isHvac ? 2 : 1
    reasons.push(`young system (~${systemAge} yr) — repair, not replacement`)
  }
  if (HIGH_VALUE_RE.test(jobTypeName || '')) { score += 3; reasons.push('replacement/install job type') }
  // "13+" in the type name means an aging system even when the notes are
  // silent — bumping "HVAC - 13+ Any Repair" hands away a replacement lead.
  if (/\b1[3-9]\s*\+|\b[2-9]\d\s*\+/.test(jobTypeName || '')) { score += isHvac ? 2 : 1; reasons.push('aging-system job type (13+)') }
  if (LOW_VALUE_RE.test(jobTypeName || '')) { score -= 2; reasons.push('routine job type') }
  if (zipTier === 'high') { score += 2; reasons.push('high-ticket zip') }
  if (zipTier === 'low') { score -= 1 }
  if (isMember === false) { score += 1; reasons.push('non-member — membership opportunity') }
  return { score, reasons }
}

// The live board costs ~35 ServiceTitan calls to compute. Cache the finished
// response for 3 minutes so ten open tabs cost one compute, not ten — the UI
// only auto-refreshes every 15 minutes anyway. The manual Refresh button
// sends ?force=1 to bypass.
let _liveBoardCache = null
async function computeLiveBoardPayload() {
    const today = boardDay(0)
    const appts = (await stPageAll(p => `/jpm/v2/tenant/${ST_TENANT_ID}/appointments?startsOnOrAfter=${today.startUtc.toISOString()}&pageSize=500&page=${p}`, 3000))
      .filter(a => {
        const t = Date.parse(a.start || '')
        return t >= today.startUtc.getTime() && t < today.endUtc.getTime()
      })
    const assignments = await assignmentsForAppointments(appts.map(a => a.id))

    const jobIds = [...new Set(assignments.map(a => a.jobId).filter(Boolean))]
    const jobs = []
    for (let i = 0; i < jobIds.length; i += 50) {
      try {
        const d = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs?ids=${jobIds.slice(i, i + 50).join(',')}&pageSize=50`)
        jobs.push(...(d?.data || []))
      } catch (e) { console.warn('live-board jobs batch:', e.message) }
    }
    const [jtCat, boardTechs, { data: scores }, { data: zipRows }] = await Promise.all([
      getJobTypeCatalog(),    // 6h cache — fetching 112 rows fresh per load was waste
      getBoardTechs(),        // 10min cache
      supabase.from('dispatch_tech_scores').select('*'),
      supabase.from('dispatch_zip_value').select('zip, tier, avg_ticket'),
    ])
    const jtName = new Map(jtCat.map(t => [t.id, t.name || '']))
    // Bench = technician team, matching the Batting Order and the ST dispatch
    // board. A tech's team, not the job's business unit, is what says whether
    // they are a closer or a service tech.
    const teamOf = new Map(boardTechs.map(t => [t.id, (t.team || 'Unassigned').trim()]))
    const zipTier = new Map((zipRows || []).map(z => [z.zip, z.tier]))
    const scoreOf = new Map((scores || []).map(s => [`${s.tech_id}|${s.business_unit}`, s]))

    // Jobs carry locationId and customerId but not the zip or membership status,
    // so resolve both in batches. Today-only, so this is a handful of calls —
    // without it the zip and membership signals silently never fire and every
    // opportunity score collapses to "job type name".
    const locIds = [...new Set(jobs.map(j => j.locationId).filter(Boolean))]
    const zipOfLoc = new Map(), geoOfLoc = new Map()
    for (let i = 0; i < locIds.length; i += 50) {
      try {
        const d = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/locations?ids=${locIds.slice(i, i + 50).join(',')}&pageSize=50`)
        for (const l of (d?.data || [])) {
          zipOfLoc.set(l.id, String(l.address?.zip || '').trim().slice(0, 5))
          const la = l.address?.latitude, lo = l.address?.longitude
          if (typeof la === 'number' && typeof lo === 'number') geoOfLoc.set(l.id, { lat: la, lng: lo })
        }
      } catch (e) { console.warn('live-board locations batch:', e.message) }
    }
    const custIds = [...new Set(jobs.map(j => j.customerId).filter(Boolean))]
    const memberCust = new Set()
    for (let i = 0; i < custIds.length; i += 50) {
      try {
        const d = await stGet(`/memberships/v2/tenant/${ST_TENANT_ID}/memberships?customerIds=${custIds.slice(i, i + 50).join(',')}&status=Active&pageSize=200`)
        for (const m of (d?.data || [])) if (m.customerId) memberCust.add(m.customerId)
      } catch (e) { console.warn('live-board memberships batch:', e.message) }
    }

    const jobById = new Map(jobs.map(j => [j.id, j]))
    const apptById = new Map(appts.map(a => [a.id, a]))
    const calls = []
    for (const a of assignments) {
      const j = jobById.get(a.jobId)
      if (!j) continue
      const bu = teamOf.get(a.technicianId) || 'Unassigned'
      const jt = jtName.get(j.jobTypeId) || ''
      const zip = zipOfLoc.get(j.locationId) || ''
      const isMember = j.customerId ? memberCust.has(j.customerId) : null
      const isHvac = /hvac/i.test(bu) || /hvac/i.test(jt)
      const systemAge = systemAgeFromNotes(j, new Date().getFullYear())
      const opp = scoreOpportunity(jt, zipTier.get(zip), isMember, systemAge, isHvac)
      const techScore = scoreOf.get(`${a.technicianId}|${bu}`) || null

      const ap = apptById.get(a.appointmentId) || {}
      // ST appointment status: Scheduled | Working | Done | Hold | Canceled.
      // Only Scheduled work is still actionable — you cannot reassign a call
      // that finished at 9am or reschedule one a tech is standing in front of.
      const apStatus = ap.status || 'Scheduled'
      if (apStatus === 'Canceled') continue          // not on the board at all
      calls.push({
        appointmentId: a.appointmentId, jobId: j.id, jobNumber: j.jobNumber,
        start: ap.start || null,
        // The arrival WINDOW is what the customer was promised and how the
        // dispatch board is laid out (8-12, 2-6...). It is wider than
        // start/end — a 30-minute job can sit in a 4-hour window — so group
        // by it, falling back to start/end when a window wasn't set.
        windowStart: ap.arrivalWindowStart || ap.start || null,
        windowEnd: ap.arrivalWindowEnd || ap.end || null,
        businessUnit: bu, jobType: jt,
        zip, isMember, systemAge, geo: geoOfLoc.get(j.locationId) || null,
        status: apStatus,
        actionable: apStatus === 'Scheduled',
        windowPassed: Boolean(ap.arrivalWindowEnd && Date.parse(ap.arrivalWindowEnd) < Date.now()),
        sticky: STICKY_TO_TECH.test(jt), countsToCapacity: !EXCLUDE_CALL.test(jt),
        techId: a.technicianId, techName: a.technicianName,
        techTier: techScore?.tier || 'unranked',
        techCloseRate: techScore?.close_rate ?? null,
        techAvgSale: techScore?.avg_sale ?? null,
        techExpectedValue: techScore?.expected_value ?? null,
        opportunity: opp.score, opportunityReasons: opp.reasons,
        rankable: !NON_DISPATCH_TEAM.test(bu),
        flags: [],
      })
    }

    // ── Reassignment suggestions ────────────────────────────────────────────
    // Route logic is about the tech's DAY, not two jobs in isolation: if a
    // strong tech already has calls in Pueblo, another Pueblo job costs him
    // almost nothing, while pulling someone down from Colorado Springs costs
    // an hour each way. KPIs still lead — proximity only chooses BETWEEN techs
    // who are good enough for the work, and never promotes a weak one.
    const SWAP_MAX_MILES = 12
    const SWAP_MAX_MIN = 25   // a swap that costs more than this in drive time isn't worth it
    // Declared here, above its use in the flag loop: `const` is not hoisted and
    // a TDZ ReferenceError here would be swallowed by the route's catch.
    const money0 = (v) => (v == null ? '—' : `$${Math.round(Number(v)).toLocaleString()}`)
    const NEARBY_MILES = 15        // "already working that area" (fallback units)
    const DETOUR_MILES = 35        // beyond this, moving a tech is its own problem
    const NEARBY_MIN = 20          // same idea once real drive time is available
    const DETOUR_MIN = 45


    // Where is each tech working today?
    const techGeos = new Map()
    for (const c of calls) {
      if (!c.techId || !c.geo) continue
      if (!techGeos.has(c.techId)) techGeos.set(c.techId, [])
      techGeos.get(c.techId).push(c.geo)
    }

    // Resolve travel for every (candidate tech's job -> target job) pair we
    // might reason about, in one batched, cached call. With no Mapbox token
    // this returns empty and we fall back to straight-line below.
    // Swap candidates, identified up front so their pairs ride along in the
    // same batched travel lookup as the reassignment candidates.
    const swapPool = new Map()   // team -> { misplaced, underused }
    for (const c of calls) {
      if (!c.rankable) continue
      if (!swapPool.has(c.businessUnit)) swapPool.set(c.businessUnit, { misplaced: [], underused: [] })
      const pool = swapPool.get(c.businessUnit)
      if (!c.actionable) continue                          // can't swap finished work
      if (STICKY_TO_TECH.test(c.jobType || '')) continue   // relationship-bound
      if (c.opportunity >= 3 && c.techTier === 'red') pool.misplaced.push(c)
      else if (c.opportunity <= 0 && c.techTier === 'green') pool.underused.push(c)
    }

    const travelPairs = []
    for (const c of calls) {
      if (!c.rankable || c.opportunity < 3 || !c.geo) continue
      for (const [tid, gs] of techGeos) {
        if (tid === c.techId) continue
        for (const g of gs) travelPairs.push({ from: g, to: c.geo })
      }
    }
    for (const { misplaced, underused } of swapPool.values()) {
      for (const m of misplaced) for (const u of underused) {
        if (m.geo && u.geo) travelPairs.push({ from: m.geo, to: u.geo })
      }
    }
    let travel = new Map()
    try { travel = await driveTimes(travelPairs, supabase) }
    catch (e) { console.warn('drive-time lookup failed, using straight-line:', e.message) }

    // Nearest of this tech's other jobs to the target — by drive time when we
    // have it, straight-line miles otherwise. One shape either way.
    const nearestTravel = (techId, geo) => {
      const gs = techGeos.get(techId)
      if (!gs || !geo) return null
      let best = null
      for (const g of gs) {
        const t = travel.get(pairKey(g, geo)) || straightLine(g, geo)
        if (!t) continue
        const cur = t.minutes ?? t.miles
        const prev = best ? (best.minutes ?? best.miles) : Infinity
        if (cur != null && cur < prev) best = t
      }
      return best
    }

    // Callboard capacity: HVAC runs 3 calls a day (4 if pushed), other trades 4
    // (5 if pushed). Shared with the 3-Day Board via app_settings so the two
    // screens can't disagree about what a full day is.
    const { data: cptRow } = await supabase.from('app_settings')
      .select('value').eq('key', 'board_calls_per_tech').maybeSingle()
    let callsPerTech = {}
    try { callsPerTech = JSON.parse(cptRow?.value || '{}') } catch {}
    const capacityFor = (team) => {
      const base = Number(callsPerTech[tradeOfTeam(team)]) || 3   // HVAC default 3
      return { target: base, stretch: base + 1 }
    }

    // Capacity counts truck rolls only — a phone-only call or a follow-up
    // doesn't consume a slot in a tech's day the way a dispatched call does.
    const loadByTech = new Map()
    for (const c of calls) {
      if (!c.techId || EXCLUDE_CALL.test(c.jobType || '')) continue
      loadByTech.set(c.techId, (loadByTech.get(c.techId) || 0) + 1)
    }
    // If a suggested tech is already full, the lowest-value call on their plate
    // is the one to move — low-dollar work is what gets rescheduled to make room
    // for demand opportunities.
    const bumpCandidate = (techId, exceptJobId) => {
      const theirs = calls.filter(c => c.techId === techId && c.jobId !== exceptJobId
        && c.actionable   // can't move a call that's Working, Done, or on Hold
        && !STICKY_TO_TECH.test(c.jobType || ''))
      if (!theirs.length) return null
      return [...theirs].sort((a, b) => (a.opportunity - b.opportunity))[0]
    }

    // Revenue already BOOKED for today: installs carry their invoice from when
    // the sale was made (verified — every install scheduled today has one).
    // The install job's own estimates are empty because the sale happened on a
    // separate sales job, so the invoice is the only reliable route.
    const installJobs = calls.filter(c => INSTALL_TYPE.test(c.jobType || ''))
    const bookedByJob = new Map()
    // MULTI-DAY INSTALLS: the invoice is the whole project value, not a daily
    // figure — count it once, on the day the job finishes (see the $130k-vs-$65k
    // incident). This loop was the page's dominant cost: 2 serial ST calls per
    // install (~24 round-trips at 1-2s each). Now a concurrency-4 pool, so a
    // 12-install day is ~6 waves instead of 24.
    // Cross-day double-count ledger. If day 2 of an install isn't booked in ST
    // yet when we compute, the job's last KNOWN appointment is today — so it
    // counts today, and would count AGAIN tomorrow once day 2 appears (the
    // Zachary Herman case). A job counted on any earlier date never counts
    // again, so revenue can land a day early but never lands twice.
    let counted = {}
    try {
      const { data: cRow } = await supabase.from('app_settings').select('value').eq('key', 'board_revenue_counted').maybeSingle()
      counted = JSON.parse(cRow?.value || '{}')
    } catch {}
    // keep the ledger from growing forever — entries older than 14 days drop
    for (const [jid, d] of Object.entries(counted)) {
      if (Date.parse(d) < Date.now() - 14 * 864e5) delete counted[jid]
    }
    const denverDate = (iso) => {
      const t = Date.parse(iso || '')
      if (Number.isNaN(t)) return null
      // Appointment dates must be compared in DENVER days: slicing the UTC
      // string put any 6pm+ appointment on "tomorrow" and misfiled the job.
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t))
    }
    let ledgerDirty = false
    const installQueue = installJobs.slice(0, 40).filter((c, i, arr) =>
      arr.findIndex(x => x.jobId === c.jobId) === i && !bookedByJob.has(c.jobId))
    let qi = 0
    await Promise.all(Array.from({ length: Math.min(4, installQueue.length) }, async () => {
      while (qi < installQueue.length) {
        const c = installQueue[qi++]
        try {
          const prior = counted[String(c.jobId)]
          if (prior && prior !== today.date) continue        // already counted a previous day
          const ja = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/appointments?jobId=${c.jobId}&pageSize=20`)
          const days = (ja?.data || [])
            .filter(a => a.status !== 'Canceled')            // canceled appts don't define the schedule
            .map(a => denverDate(a.start)).filter(Boolean).sort()
          const lastDay = days[days.length - 1]
          if (lastDay && lastDay !== today.date) continue    // finishes another day
          const iv = await stGet(`/accounting/v2/tenant/${ST_TENANT_ID}/invoices?jobNumber=${encodeURIComponent(c.jobNumber)}&pageSize=5`)
          const tot = (iv?.data || []).reduce((a, x) => a + Number(x.total || 0), 0)
          if (tot > 0) {
            bookedByJob.set(c.jobId, tot)
            if (counted[String(c.jobId)] !== today.date) { counted[String(c.jobId)] = today.date; ledgerDirty = true }
          }
        } catch (e) { /* leave it out rather than guess */ }
      }
    }))
    if (ledgerDirty) {
      try {
        await supabase.from('app_settings').upsert(
          { key: 'board_revenue_counted', value: JSON.stringify(counted) }, { onConflict: 'key' })
      } catch (e) { console.warn('revenue ledger save:', e.message) }
    }

    // Outcomes for work that finished today. Fetched as two paged queries and
    // indexed by job rather than per-job lookups, which at ~29 completed calls
    // would have doubled this route's API cost every 15 minutes.
    const todayIso = today.startUtc.toISOString().slice(0, 10)
    const soldByJob = new Map(), quotedByJob = new Map(), invoicedByJob = new Map()
    try {
      const est = await stPageAll(p => `/sales/v2/tenant/${ST_TENANT_ID}/estimates?createdOnOrAfter=${todayIso}&pageSize=500&page=${p}`, 4000)
      for (const e of est) {
        if (!e?.jobId) continue
        const v = Number(e.subtotal || 0)
        const st = (e.status && typeof e.status === 'object') ? e.status.name : e.status
        if (st === 'Sold') soldByJob.set(e.jobId, (soldByJob.get(e.jobId) || 0) + v)
        else quotedByJob.set(e.jobId, Math.max(quotedByJob.get(e.jobId) || 0, v))
      }
    } catch (e) { console.warn('live-board estimates:', e.message) }
    try {
      const inv = await stPageAll(p => `/accounting/v2/tenant/${ST_TENANT_ID}/invoices?createdOnOrAfter=${todayIso}&pageSize=500&page=${p}`, 4000)
      for (const x of inv) {
        const jid = x?.job?.id
        if (jid) invoicedByJob.set(jid, (invoicedByJob.get(jid) || 0) + Number(x.total || 0))
      }
    } catch (e) { console.warn('live-board invoices:', e.message) }

    // Shift-awareness for SUGGESTIONS — the same rule the Decision Maker
    // learned when it recommended a tech who'd gone home: a candidate must
    // have a working shift covering the call's window, minus TimeOff.
    let shiftsByTech = null
    try {
      const sh = await stGet(`/dispatch/v2/tenant/${ST_TENANT_ID}/technician-shifts?startsOnOrAfter=${today.startUtc.toISOString()}&endsOnOrBefore=${today.endUtc.toISOString()}&pageSize=500`)
      shiftsByTech = new Map()
      for (const x of (sh?.data || [])) {
        if (!x.technicianId) continue
        if (!shiftsByTech.has(x.technicianId)) shiftsByTech.set(x.technicianId, [])
        shiftsByTech.get(x.technicianId).push({ type: x.shiftType, start: Date.parse(x.start || ''), end: Date.parse(x.end || '') })
      }
    } catch (e) { console.warn('live-board shifts:', e.message) }
    const canWork = (techId, ws, we) => {
      if (!shiftsByTech) return true                      // no data — don't block
      const list = shiftsByTech.get(techId) || []
      let s0 = Date.parse(ws || ''), e0 = Date.parse(we || '')
      if (Number.isNaN(s0) || Number.isNaN(e0)) { s0 = Date.now(); e0 = today.endUtc.getTime() }
      const on = list.some(x => x.type !== 'TimeOff' && x.start < e0 && x.end > s0)
      const off = list.some(x => x.type === 'TimeOff' && x.start < e0 && x.end > s0)
      return on && !off
    }

    // Skill rules (boilers -> Craig Rehm): a rule-bound call is never suggested
    // for anyone outside its list. Same app_settings the Decision Maker reads.
    let typeRules = []
    try {
      const { data: rr } = await supabase.from('app_settings').select('value').eq('key', 'dispatch_type_rules').maybeSingle()
      typeRules = JSON.parse(rr?.value || '[]')
    } catch {}
    const allowedByRule = (jt, techName) => {
      const r = typeRules.find(x => x?.pattern && String(jt || '').toLowerCase().includes(String(x.pattern).toLowerCase()))
      return !r || (r.techs || []).some(n => String(n).toLowerCase() === String(techName || '').toLowerCase())
    }

    const scoresByTeam = new Map()
    for (const sc of (scores || [])) {
      if (!scoresByTeam.has(sc.business_unit)) scoresByTeam.set(sc.business_unit, [])
      scoresByTeam.get(sc.business_unit).push(sc)
    }

    for (const c of calls) {
      if (!c.rankable || c.opportunity < 3) continue
      if (!c.actionable) continue            // already done, working, or on hold
      // Follow-ups and financing calls belong to the tech who owns the
      // relationship — reassigning them by rank would destroy their value.
      if (STICKY_TO_TECH.test(c.jobType || '')) continue
      const weak = !c.techTier || c.techTier === 'red' || c.techTier === 'unranked'
      if (!weak) continue

      const mine = scoreOf.get(`${c.techId}|${c.businessUnit}`)
      const myEV = Number(mine?.expected_value || 0)

      // Candidates: same bench, materially stronger than who's on it now.
      const candidates = (scoresByTeam.get(c.businessUnit) || [])
        .filter(s => s.tech_id !== c.techId && s.tier !== 'unranked')
        .filter(s => canWork(s.tech_id, c.windowStart, c.windowEnd))
        .filter(s => allowedByRule(c.jobType, s.tech_name))
        .filter(s => Number(s.expected_value || 0) > myEV)
        .map(s => ({ s, t: nearestTravel(s.tech_id, c.geo) }))
        .filter(x => {
          if (!x.t) return true                                   // unknown: don't exclude
          if (x.t.minutes != null) return x.t.minutes <= DETOUR_MIN
          return x.t.miles == null || x.t.miles <= DETOUR_MILES
        })

      if (!candidates.length) continue

      // KPIs lead: work down the list by earning power, and take the first one
      // already working nearby. Only if nobody strong is in the area do we fall
      // back to the top earner regardless of distance — and say what it costs.
      const byEarning = [...candidates].sort((a, b) => Number(b.s.expected_value || 0) - Number(a.s.expected_value || 0))
      const isNear = (x) => x.t && (x.t.minutes != null ? x.t.minutes <= NEARBY_MIN : (x.t.miles != null && x.t.miles <= NEARBY_MILES))
      const nearby = byEarning.find(isNear)
      const pick = nearby || byEarning[0]

      // Say it in minutes when it's real drive time, miles when it's the
      // straight-line estimate — never dress an estimate up as a measurement.
      const t = pick.t
      const where = !t
        ? 'no other work scheduled today'
        : t.minutes != null
          ? (isNear(pick) ? `already working ${t.minutes} min away` : `${t.minutes} min drive from their nearest job today`)
          : (isNear(pick) ? `already working ~${t.miles} mi away (straight line)` : `~${t.miles} mi away (straight line)`)

      const cap = capacityFor(c.businessUnit)
      const load = loadByTech.get(pick.s.tech_id) || 0
      const why = [...c.opportunityReasons,
                   `${pick.s.tech_name}: ${Math.round(Number(pick.s.close_rate || 0))}% close · ${money0(pick.s.avg_sale)} avg sale`,
                   where]

      // Never suggest a move without saying what it costs the receiving tech.
      if (load >= cap.target) {
        const bump = bumpCandidate(pick.s.tech_id, c.jobId)
        const atCap = load >= cap.stretch
        why.push(
          `${pick.s.tech_name} already has ${load} call${load === 1 ? '' : 's'} (${tradeOfTeam(c.businessUnit)} runs ${cap.target}, ${cap.stretch} if pushed)` +
          (atCap ? ' — at the stretch limit' : ''))
        if (bump) {
          why.push(`Lowest-value call on their plate to move: #${bump.jobNumber} (${bump.jobType}${bump.opportunity <= 0 ? ', routine' : ''})`)
        }
      } else {
        why.push(`${pick.s.tech_name} has room today (${load} of ${cap.target})`)
      }

      c.flags.push({
        level: c.techTier === 'red' ? 'warn' : 'info',
        text: `High-opportunity call on ${c.techTier === 'red' ? 'a red-tier tech' : 'an unranked tech'} — consider ${pick.s.tech_name}`,
        why,
      })
    }


    // Swap suggestion: within one team, a high-opportunity call sitting on a
    // red tech while a green tech has a routine one — and the two jobs close
    // enough that trading them doesn't blow up the route. Suggestion only;
    // Andi never writes assignments back to ServiceTitan.
    const swaps = []
    const usedForSwap = new Set()
    for (const [bu, pool] of swapPool) {
      const { misplaced, underused } = pool
      if (!misplaced.length || !underused.length) continue

      for (const m of misplaced) {
        const mEV = Number(scoreOf.get(`${m.techId}|${bu}`)?.expected_value || 0)

        const partner = underused
          .filter(u => !usedForSwap.has(u.jobId))
          // A swap trades windows too: each tech must be on shift for the
          // OTHER call's window, and skill rules must hold in both directions.
          .filter(u => canWork(u.techId, m.windowStart, m.windowEnd)
            && canWork(m.techId, u.windowStart, u.windowEnd)
            && allowedByRule(m.jobType, u.techName)
            && allowedByRule(u.jobType, m.techName))
          .map(u => {
            const t = (m.geo && u.geo) ? (travel.get(pairKey(m.geo, u.geo)) || straightLine(m.geo, u.geo)) : null
            return { u, t, uEV: Number(scoreOf.get(`${u.techId}|${bu}`)?.expected_value || 0) }
          })
          // Travel is a VETO, not a tiebreak: a swap that wrecks the route is
          // not worth any revenue upside on a single call.
          .filter(x => !x.t || (x.t.minutes != null ? x.t.minutes <= SWAP_MAX_MIN : x.t.miles <= SWAP_MAX_MILES))
          .sort((a, b) => {
            const ta = a.t?.minutes ?? a.t?.miles ?? 999
            const tb = b.t?.minutes ?? b.t?.miles ?? 999
            return (b.uEV - a.uEV) || (ta - tb)      // strongest partner, then closest
          })[0]

        if (!partner) continue
        usedForSwap.add(partner.u.jobId)

        const t = partner.t
        const travelText = !t ? 'distance unknown — check the map'
          : t.minutes != null ? `${t.minutes} min drive between the two jobs`
          : `~${t.miles} mi between the two jobs (straight line)`

        const upside = Math.max(0, Math.round(partner.uEV - mEV))
        const why = [
          `#${m.jobNumber} scores ${m.opportunity} on opportunity (${m.opportunityReasons.join(' · ') || 'high-value job type'}) but is on ${m.techName}, your lowest earner on this bench`,
          `${partner.u.techName} is rated "deploy here" (${money0(partner.uEV)}/opportunity vs ${money0(mEV)}) and is currently on a routine ${partner.u.jobType}`,
          upside > 0 ? `Expected upside on #${m.jobNumber}: about ${money0(upside)}` : 'Similar earning power — swap only if convenient',
          travelText,
        ]

        swaps.push({
          businessUnit: bu,
          travelMinutes: t?.minutes ?? null,
          travelMiles: t?.miles ?? null,
          upside,
          from: { jobNumber: m.jobNumber, jobId: m.jobId, tech: m.techName, jobType: m.jobType, opportunity: m.opportunity },
          to: { jobNumber: partner.u.jobNumber, jobId: partner.u.jobId, tech: partner.u.techName, jobType: partner.u.jobType },
          text: `Give #${m.jobNumber} (${m.jobType}) to ${partner.u.techName}, and #${partner.u.jobNumber} (${partner.u.jobType}) to ${m.techName}`,
          why,
        })
      }
    }

    // Per-call money view.
    //  - booked: an install's invoice — real, already sold.
    //  - expected: the assigned tech's earning power per opportunity. This is a
    //    probability-weighted figure, never money in hand, and is labelled as
    //    such in the UI so nobody adds it to a P&L.
    for (const c of calls) {
      const sc = scoreOf.get(`${c.techId}|${c.businessUnit}`)
      c.bookedRevenue = bookedByJob.get(c.jobId) || 0

      // EXPECTED SALES. Two corrections live here, both learned the hard way:
      //
      // 1) A SALES-BENCH call is inherently a sales opportunity — that's what
      //    the bench is for. Gating on job-type keywords scored Arber's
      //    "HVAC - No Cool" at zero, which is precisely the call where he sells
      //    a $12-20k system. Sales benches always count; other benches still
      //    need a real signal (old system, replacement type, high-ticket zip).
      //
      // 2) EV is revenue per OPPORTUNITY, not per dispatched call, and only
      //    ~35% of a sales tech's calls produce an estimate at all (Arber: 32
      //    opportunities across 92 jobs). Multiplying EV by every call assumed
      //    every visit becomes a quote and overstated the day ~3x. Scale by the
      //    tech's own opportunity rate so this is what a DISPATCHED call is
      //    worth before we know whether it turns into one.
      const oppRate = Number(sc?.jobs) > 0
        ? Math.min(1, Number(sc.opportunities || 0) / Number(sc.jobs))
        : 0
      const salesBench = /sales/i.test(c.businessUnit || '')
      const countsAsSales = !c.bookedRevenue
        && !INSTALL_TYPE.test(c.jobType || '')
        && !STICKY_TO_TECH.test(c.jobType || '')
        && (salesBench || c.opportunity >= 1)
      // Only work still to run counts as EXPECTED — a call that's already Done
      // either sold or didn't, so leaving it in makes the forecast stop moving
      // and quietly overstate the rest of the day.
      c.expectedRevenue = (countsAsSales && c.actionable)
        ? Math.round(Number(sc?.expected_value || 0) * oppRate)
        : 0
      // Reschedule candidates: what to move when demand walks in. Installs are
      // sold work and phone/follow-ups take no truck time and must happen, so
      // both are out. Ranked by how little the call is likely to produce.
      c.rescheduleCandidate = c.actionable
        && !c.bookedRevenue
        && !STICKY_TO_TECH.test(c.jobType || '')
        && !INSTALL_TYPE.test(c.jobType || '')
        && c.opportunity <= 0

      // Say WHY it's movable — and, just as important, where moving it has a
      // cost that the revenue number doesn't show. A callback produces no
      // revenue, which makes it look like the cheapest thing on the board,
      // but there's a customer waiting on a fix that already went wrong.
      // What actually happened on finished work.
      if (!c.actionable && c.status === 'Done') {
        const sold = soldByJob.get(c.jobId) || 0
        const quoted = quotedByJob.get(c.jobId) || 0
        const invoiced = invoicedByJob.get(c.jobId) || 0
        c.outcome = sold > 0
          ? { kind: 'sold', amount: Math.round(sold), text: `Sold $${Math.round(sold).toLocaleString()}` }
          : invoiced > 0
            ? { kind: 'invoiced', amount: Math.round(invoiced), text: `Invoiced $${Math.round(invoiced).toLocaleString()}` }
            : quoted > 0
              ? { kind: 'quoted', amount: Math.round(quoted), text: `Quoted $${Math.round(quoted).toLocaleString()} — not sold` }
              : { kind: 'none', amount: 0, text: 'No sale recorded' }
      }

      if (c.rescheduleCandidate) {
        const jtl = c.jobType || ''
        const why = []
        let caution = null
        if (/maint|tune|inspection/i.test(jtl)) {
          why.push('Recurring maintenance — periodic, not urgent')
        } else if (/callback|warranty/i.test(jtl)) {
          why.push('Callback — no revenue attached')
          caution = 'Customer is already waiting on a fix — move only if you must'
        } else if (/permit/i.test(jtl)) {
          why.push('Permitting — administrative, nobody waiting on site')
        } else {
          why.push('No replacement or upgrade signals on this call')
        }
        if (c.isMember) caution = caution || 'Member — worth a courtesy call before moving'
        why.push(c.expectedRevenue > 0
          ? `Only ~$${c.expectedRevenue.toLocaleString()} expected if it runs`
          : 'No sale expected from it')
        c.moveReason = why
        c.moveCaution = caution
      }
    }
    const dayRevenue = {
      booked: Math.round([...bookedByJob.values()].reduce((a, b) => a + b, 0)),
      bookedJobs: bookedByJob.size,
      expected: Math.round(calls.reduce((a, c) => a + (c.expectedRevenue || 0), 0)),
      opportunityCalls: calls.filter(c => c.expectedRevenue > 0).length,
      rescheduleCandidates: calls.filter(c => c.rescheduleCandidate).length,
      remaining: calls.filter(c => c.actionable).length,
      soldToday: Math.round(calls.reduce((a, c) => a + (c.outcome?.kind === 'sold' ? c.outcome.amount : 0), 0)),
      invoicedToday: Math.round(calls.reduce((a, c) => a + (c.outcome?.kind === 'invoiced' ? c.outcome.amount : 0), 0)),
      done: calls.filter(c => c.status === 'Done').length,
      working: calls.filter(c => c.status === 'Working').length,
    }

    // Sort by window open, then by start within the window.
    const ts = (v) => { const t = Date.parse(v || ''); return Number.isNaN(t) ? Infinity : t }
    calls.sort((a, b) => (ts(a.windowStart) - ts(b.windowStart)) || (ts(a.start) - ts(b.start)))
    // Who can actually take work TODAY. Bench scores carry no availability, so
    // the analyst brief once told dispatch to route calls to a tech buried on
    // an all-day install and away from a tech who was off. Every scored tech
    // gets a plain-language status here, and the brief must respect it.
    const techLoad = new Map()
    for (const c of calls) {
      if (!c.techId || EXCLUDE_CALL.test(c.jobType || '')) continue
      const t = techLoad.get(c.techId) || { calls: 0, allDayInstall: false }
      t.calls++
      const hrs = (Date.parse(c.windowEnd || '') - Date.parse(c.windowStart || '')) / 36e5
      if (INSTALL_TYPE.test(c.jobType || '') && hrs >= 7) t.allDayInstall = true
      techLoad.set(c.techId, t)
    }
    const techsToday = []
    const seenTech = new Set()
    for (const sc of (scores || [])) {
      const tid = Number(sc.tech_id)
      if (!tid || seenTech.has(tid)) continue
      seenTech.add(tid)
      const load = techLoad.get(tid) || { calls: 0, allDayInstall: false }
      let status
      if (!canWork(tid)) status = 'off today / no working time left'
      else if (load.allDayInstall) status = 'on an all-day install — cannot take calls'
      else status = `${load.calls} call${load.calls === 1 ? '' : 's'} on board`
      techsToday.push({ techId: tid, name: sc.tech_name, status })
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      scoresRefreshedAt: (scores || [])[0]?.refreshed_at || null,
      driveTime: driveTimeEnabled(),
      dayRevenue,
      techsToday,
      calls, swaps,
      counts: {
        total: calls.length,
        flagged: calls.filter(c => c.flags.length).length,
        unrankedTechs: calls.filter(c => c.techTier === 'unranked').length,
      },
    }
    _liveBoardCache = { data: payload, expires: Date.now() + 3 * 60_000 }
  return _liveBoardCache.data
}

app.get('/api/dispatch/live-board', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    if (req.query.force !== '1' && _liveBoardCache && _liveBoardCache.expires > Date.now()) {
      return res.json({ ..._liveBoardCache.data, cached: true })
    }
    res.json(await computeLiveBoardPayload())
  } catch (err) {
    console.error('live-board error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Andi's read of the board ────────────────────────────────────────────────
// Claude analysis of the live board + batting order + 3-day capacity: what's
// happening, what to do about it, in dispatcher language. Cached in
// app_settings so it survives restarts; regenerated on demand or when stale.
let _briefBusy = false
async function generateDispatchBrief() {
  if (!ANTHROPIC_KEY) throw new Error('No ANTHROPIC_API_KEY configured')
  const board = (_liveBoardCache && _liveBoardCache.expires > Date.now())
    ? _liveBoardCache.data : await computeLiveBoardPayload()
  const { data: scores } = await supabase.from('dispatch_tech_scores').select('*')
  let capacity = []
  try {
    const b3 = await build3DayBoard()
    capacity = (b3?.board || []).map(r => ({
      trade: r.trade,
      days: (r.days || []).map(d => ({ date: d.date, pct: d.pct, needed: d.needed, status: d.status })),
    }))
  } catch (e) { console.warn('brief 3day:', e.message) }

  // Compact facts only — the model reasons over this, so keep it signal-dense.
  const calls = board.calls || []
  const facts = {
    now: new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }),
    counts: board.counts,
    revenue: board.dayRevenue,
    flagged: calls.filter(c => c.flags?.length).map(c => ({
      job: c.jobNumber, type: c.jobType, tech: c.techName, tier: c.techTier,
      window: c.windowStart, flag: c.flags[0]?.text, why: c.flags[0]?.why,
    })),
    swaps: (board.swaps || []).map(x => ({ text: x.text, why: x.why, upside: x.upside })),
    rescheduleCandidates: calls.filter(c => c.rescheduleCandidate)
      .map(c => ({ job: c.jobNumber, type: c.jobType, tech: c.techName })),
    completedOutcomes: calls.filter(c => c.outcome).map(c => ({
      job: c.jobNumber, type: c.jobType, tech: c.techName, outcome: c.outcome.text,
    })),
    benches: (() => {
      const avail = new Map((board.techsToday || []).map(t => [String(t.techId), t.status]))
      return Object.values((scores || []).reduce((a, r) => {
        if (r.tier === 'unranked') return a
        ;(a[r.business_unit] = a[r.business_unit] || { bench: r.business_unit, techs: [] }).techs.push({
          name: r.tech_name, tier: r.tier, evPerOpp: Math.round(r.expected_value || 0),
          today: avail.get(String(r.tech_id)) || 'unknown',
        })
        return a
      }, {}))
    })(),
    next3DaysCapacity: capacity,
  }

  const sys = `You are the dispatch analyst for Awesome Home Services (HVAC, plumbing, electrical, garage doors — Colorado Springs). You are given a JSON snapshot of today's live dispatch board, tech performance benches, and 3-day capacity. Write the read a sharp dispatch manager would give at the huddle: concrete, numbers-first, in plain dispatcher language. Only use what is in the data; never invent jobs, names, or numbers.

Every bench tech carries a 'today' field with their REAL availability right now. Treat it as law: never build an action around routing work to (or comparing against) a tech whose 'today' says they are off, have no working time left, or are on an all-day install — those techs cannot take calls no matter how good their numbers are. Recommendations may only name techs whose 'today' shows calls on board or room.

Submit the analysis via the submit_brief tool. 3-6 actions, ordered by priority; empty arrays are fine. 'now' means act this hour; 'plan' means tomorrow/this week.`

  // Forced tool call, not free-text JSON: the API validates the arguments
  // against the schema, so a stray quote or preamble can't produce the
  // 'Expected double-quoted property name' parse failure this shipped with.
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 1400, system: sys,
      tools: [{
        name: 'submit_brief',
        description: 'Submit the dispatch board analysis',
        input_schema: {
          type: 'object',
          properties: {
            headline: { type: 'string', maxLength: 160, description: 'ONE short sentence — the single most important thing about the board right now. Plain text only.' },
            situation: { type: 'string', maxLength: 400, description: 'AT MOST 3 short plain-English sentences. Never include JSON, brackets, quotes, or field names — the other fields carry the details.' },
            actions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  priority: { type: 'string', enum: ['now', 'today', 'plan'] },
                  text: { type: 'string', description: 'specific action, name the tech and job number where possible, max 20 words' },
                },
                required: ['priority', 'text'],
              },
            },
            watchouts: { type: 'array', items: { type: 'string' } },
            wins: { type: 'array', items: { type: 'string' } },
          },
          required: ['headline', 'situation', 'actions', 'watchouts', 'wins'],
        },
      }],
      tool_choice: { type: 'tool', name: 'submit_brief' },
      messages: [{ role: 'user', content: JSON.stringify(facts) }],
    }),
  })
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 160)}`)
  const data = await r.json()
  const brief = (data.content || []).find(b => b.type === 'tool_use')?.input
  if (!brief?.headline) throw new Error('Analysis came back empty — retry')
  // Belt and braces: the first live run stuffed the entire answer (JSON
  // syntax included) into `situation`. The schema now constrains it, and this
  // clamp guarantees the panel stays readable even if the model misbehaves.
  const clean = (t, max) => String(t || '').replace(/["{}\[\]]+/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
  brief.headline = clean(brief.headline, 160)
  brief.situation = clean((String(brief.situation || '').match(/[^.!?]+[.!?]/g) || [brief.situation || '']).slice(0, 3).join(' '), 420)
  brief.actions = (brief.actions || []).slice(0, 6).map(a => ({ priority: a.priority, text: clean(a.text, 140) }))
  brief.watchouts = (brief.watchouts || []).slice(0, 4).map(w => clean(w, 120))
  brief.wins = (brief.wins || []).slice(0, 3).map(w => clean(w, 120))
  const record = { brief, generatedAt: new Date().toISOString() }
  await supabase.from('app_settings').upsert(
    { key: 'dispatch_brief', value: JSON.stringify(record) }, { onConflict: 'key' })
  return record
}

app.get('/api/dispatch/brief', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const { data: row } = await supabase.from('app_settings').select('value').eq('key', 'dispatch_brief').maybeSingle()
    let record = null
    try { record = JSON.parse(row?.value || 'null') } catch {}
    const ageMs = record?.generatedAt ? Date.now() - Date.parse(record.generatedAt) : Infinity
    const wantFresh = req.query.refresh === '1' || ageMs > 6 * 3600_000
    if (wantFresh && !_briefBusy) {
      _briefBusy = true
      try { record = await generateDispatchBrief() }
      finally { _briefBusy = false }
    }
    if (!record) return res.status(503).json({ error: 'No analysis yet — try refresh.' })
    res.json(record)
  } catch (err) {
    console.error('brief error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Decision Maker ──────────────────────────────────────────────────────────
// "A tankless estimate just came in — where does it go?" Given a job type and
// address, score every placement against the current board and return ranked
// recommendations. RECOMMEND ONLY — it writes nothing to ServiceTitan; the
// dispatcher books and assigns. That's deliberate: it never silently rearranges
// a live board, and it sidesteps assign/reschedule writes entirely.
app.get('/api/dispatch/all-job-types', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const cat = await getJobTypeCatalog()
    res.json({ types: cat.map(t => t.name).filter(Boolean).sort() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/dispatch/geocode-suggest', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    res.json({ suggestions: await suggestAddresses(req.query.q) })
  } catch (err) {
    res.json({ suggestions: [] })
  }
})

app.post('/api/dispatch/decide', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const jobType = String(req.body?.jobType || '').trim()
    const address = String(req.body?.address || '').trim()
    const urgent = Boolean(req.body?.urgent)   // "must run today" override
    // What the dispatcher already knows from the call. A new job has no ST
    // notes yet, so this is the only way a "2-year-old no cool" reaches the
    // model. Age can be typed directly or parsed out of the notes text.
    const givenAge = req.body?.systemAge != null && req.body.systemAge !== '' ? Number(req.body.systemAge) : null
    const callNotes = String(req.body?.notes || '').trim()
    if (!jobType) return res.status(400).json({ error: 'A job type is required.' })

    const trade = tradeOfJobType(jobType)
    if (!trade) return res.status(400).json({ error: `Couldn't tell which trade "${jobType}" belongs to. Try including the trade name.` })

    // Where is it? Zip value + a point to measure drive time from.
    const geo = address ? await geocode(address, supabase) : null
    // Zip tiers loaded once — used for the new job AND to judge which existing
    // call is safe to bump.
    const { data: zipAll } = await supabase.from('dispatch_zip_value').select('zip, tier')
    const zipTierMap = new Map((zipAll || []).map(z => [z.zip, z.tier]))
    const zip = (address.match(/\b(\d{5})\b/) || [])[1] || null
    const zipTier = zip ? (zipTierMap.get(zip) || null) : null

    const isHvac = trade === 'HVAC'
    const knownAge = givenAge ?? systemAgeFromNotes({ summary: callNotes }, new Date().getFullYear())
    const opp = scoreOpportunity(jobType, zipTier, null, knownAge, isHvac)

    // Today's board: assignments + jobs + tech geos, same gather as the live board.
    const today = boardDay(0)
    const appts = (await stPageAll(p => `/jpm/v2/tenant/${ST_TENANT_ID}/appointments?startsOnOrAfter=${today.startUtc.toISOString()}&pageSize=500&page=${p}`, 3000))
      .filter(a => { const t = Date.parse(a.start || ''); return t >= today.startUtc.getTime() && t < today.endUtc.getTime() && a.status !== 'Canceled' })
    const assignments = await assignmentsForAppointments(appts.map(a => a.id))
    const apptById = new Map(appts.map(a => [a.id, a]))
    const jobIds = [...new Set(assignments.map(a => a.jobId).filter(Boolean))]
    const jobs = []
    for (let i = 0; i < jobIds.length; i += 50) {
      try { const d = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs?ids=${jobIds.slice(i, i + 50).join(',')}&pageSize=50`); jobs.push(...(d?.data || [])) } catch {}
    }
    const jobById = new Map(jobs.map(j => [j.id, j]))
    const jtCat = await getJobTypeCatalog()   // 6h-cached; a fresh fetch here was pure waste
    const jtName = new Map(jtCat.map(t => [t.id, t.name || '']))

    // location coords for each job (for drive time), batched
    const locIds = [...new Set(jobs.map(j => j.locationId).filter(Boolean))]
    const geoOfLoc = new Map(), zipOfLoc = new Map()
    for (let i = 0; i < locIds.length; i += 50) {
      try {
        const d = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/locations?ids=${locIds.slice(i, i + 50).join(',')}&pageSize=50`)
        for (const l of (d?.data || [])) {
          const la = l.address?.latitude, lo = l.address?.longitude
          if (typeof la === 'number' && typeof lo === 'number') geoOfLoc.set(l.id, { lat: la, lng: lo })
          const z = String(l.address?.zip || '').trim().slice(0, 5)
          if (z) zipOfLoc.set(l.id, z)
        }
      } catch {}
    }

    // Load per tech + where they are today.
    const { data: cptRow } = await supabase.from('app_settings').select('value').eq('key', 'board_calls_per_tech').maybeSingle()
    let callsPerTech = {}; try { callsPerTech = JSON.parse(cptRow?.value || '{}') } catch {}
    const capOf = () => (Number(callsPerTech[trade]) || 3)

    const loadByTech = new Map(), geosByTech = new Map()
    for (const a of assignments) {
      const j = jobById.get(a.jobId)
      if (!j || !a.technicianId) continue
      const jn = jtName.get(j.jobTypeId) || ''
      if (!EXCLUDE_CALL.test(jn)) loadByTech.set(a.technicianId, (loadByTech.get(a.technicianId) || 0) + 1)
      const g = geoOfLoc.get(j.locationId)
      if (g) { if (!geosByTech.has(a.technicianId)) geosByTech.set(a.technicianId, []); geosByTech.get(a.technicianId).push(g) }
    }

    // Who's actually working today? A tech with a non-TimeOff shift is on; no
    // shift means off (this is how the 3-Day Board decides). Without this the
    // picker cheerfully recommended a tech who's off — his 0-load, no-drive row
    // is the giveaway. Techs already carrying a call today are trivially working
    // too, so union both signals.
    // Available for NEW work, not just "worked at some point today". The first
    // version counted anyone with a call today as available all day — which
    // recommended a tech who ran one morning call and left. A tech is available
    // only if a working shift still has time left, minus any TimeOff covering
    // the rest of the day.
    let workingTechs = null
    try {
      const shiftRes = await stGet(`/dispatch/v2/tenant/${ST_TENANT_ID}/technician-shifts?startsOnOrAfter=${today.startUtc.toISOString()}&endsOnOrBefore=${today.endUtc.toISOString()}&pageSize=500`)
      const nowMs = Date.now()
      const stillOn = new Set(), offNow = new Set()
      for (const sh of (shiftRes?.data || [])) {
        if (!sh.technicianId) continue
        const st = Date.parse(sh.start || ''), en = Date.parse(sh.end || '')
        if (sh.shiftType === 'TimeOff') {
          if (!Number.isNaN(st) && !Number.isNaN(en) && st <= nowMs && en > nowMs) offNow.add(sh.technicianId)
        } else if (!Number.isNaN(en) && en > nowMs) {
          stillOn.add(sh.technicianId)   // working shift with time remaining
        }
      }
      workingTechs = new Set([...stillOn].filter(t => !offNow.has(t)))
    } catch (e) { console.warn('decide shifts:', e.message) }

    // Candidate techs = this trade's dispatchable benches. Prefer their EV on
    // THIS job type (from the By Job Type board) over their bench EV.
    const [{ data: bench }, { data: jtScores }] = await Promise.all([
      supabase.from('dispatch_tech_scores').select('*'),
      supabase.from('dispatch_jobtype_scores').select('*'),
    ])
    const jtEvByTech = new Map((jtScores || []).filter(r => (r.job_type || '').toLowerCase() === jobType.toLowerCase())
      .map(r => [r.tech_id, r]))
    // Skill rules: some job types only specific techs can run (boilers are
    // Craig Rehm only, per AHS). Stored in app_settings.dispatch_type_rules as
    // [{"pattern":"boiler","techs":["Craig Rehm"]}] so new rules need no deploy.
    // A matching rule OVERRIDES trade routing — the named techs are the bench,
    // whatever team they sit on.
    let restriction = null
    try {
      const { data: ruleRow } = await supabase.from('app_settings').select('value').eq('key', 'dispatch_type_rules').maybeSingle()
      const rules = JSON.parse(ruleRow?.value || '[]')
      restriction = rules.find(r => r?.pattern && jobType.toLowerCase().includes(String(r.pattern).toLowerCase())) || null
    } catch {}

    let candidates = (bench || [])
      .filter(b => tradeOfTeam(b.business_unit) === trade && !NON_DISPATCH_TEAM.test(b.business_unit) && b.tier !== 'unranked')
    if (restriction) {
      const allowed = new Set((restriction.techs || []).map(n => String(n).toLowerCase()))
      candidates = (bench || []).filter(b => allowed.has(String(b.tech_name || '').toLowerCase()))
    }
    // Only techs on the schedule today. If the shift lookup failed entirely
    // we don't have the data, so fall back to showing everyone rather than an
    // empty board — but note it.
    candidates = candidates.filter(b => !workingTechs || workingTechs.has(b.tech_id))

    // Drive time from each candidate's nearest current job to the new address.
    const travelPairs = []
    if (geo) for (const b of candidates) for (const g of (geosByTech.get(b.tech_id) || [])) travelPairs.push({ from: g, to: geo })
    let travel = new Map()
    try { travel = await driveTimes(travelPairs, supabase) } catch {}
    const nearestMin = (techId) => {
      if (!geo) return null
      const gs = geosByTech.get(techId) || []
      let best = null
      for (const g of gs) {
        const t = travel.get(pairKey(g, geo)) || straightLine(g, geo)
        const v = t?.minutes ?? (t?.miles != null ? t.miles * 2 : null)   // rough min if only miles
        if (v != null && (best == null || v < best)) best = v
      }
      return best
    }

    const cap = capOf()
    const options = candidates.map(b => {
      const jt = jtEvByTech.get(b.tech_id)
      const ev = Number((jt && jt.expected_value) ?? b.expected_value ?? 0)
      const load = loadByTech.get(b.tech_id) || 0
      const drive = nearestMin(b.tech_id)
      const hasRoom = load < cap
      return {
        techId: b.tech_id, techName: b.tech_name, team: b.business_unit, tier: b.tier,
        expectedValue: Math.round(ev),
        closeRate: jt ? Math.round(Number(jt.close_rate || 0)) : Math.round(Number(b.close_rate || 0)),
        avgSale: Math.round(Number((jt && jt.avg_sale) ?? b.avg_sale ?? 0)),
        onThisJobType: Boolean(jt),
        load, cap, hasRoom,
        driveMinutes: drive == null ? null : Math.round(drive),
      }
    })

    // Rank: best expected value, but a tech with room and a short drive beats a
    // marginally-higher earner who's full and far. Simple, explainable score.
    const scoreOption = (o) => {
      let s = o.expectedValue
      if (!o.hasRoom) s -= 400                        // needs a bump
      if (o.driveMinutes != null) s -= o.driveMinutes * 8   // ~$8/min of windshield
      return s
    }
    options.sort((a, b) => scoreOption(b) - scoreOption(a))

    // For a full top pick, find the call they'd bump (lowest opportunity, and
    // not sold/sticky). Members are movable per policy.
    // Which of a tech's calls is SAFEST to move? Scored exactly like the Live
    // Board scores calls — job notes (system age), type name, zip value — and
    // the lowest-opportunity one wins. The first version took the first
    // movable call unscored, and its very first real suggestion was to bump
    // "HVAC - 13+ Any Repair": an aging-system repair, one of the most
    // fruitful calls on the board.
    const nowYear = new Date().getFullYear()
    const bumpFor = (techId) => {
      const scored = assignments
        .filter(a => a.technicianId === techId)
        // Whitelist: only Scheduled work can move. Working means the tech is
        // standing in the customer's house; Done is history; Hold is somebody
        // else's decision. Same rule the Live Board applies to its own flags.
        .filter(a => (apptById.get(a.appointmentId)?.status || 'Scheduled') === 'Scheduled')
        .map(a => jobById.get(a.jobId)).filter(Boolean)
        .map(j => {
          const name = jtName.get(j.jobTypeId) || ''
          return { j, name }
        })
        .filter(x => !STICKY_TO_TECH.test(x.name) && !INSTALL_TYPE.test(x.name))
        .map(({ j, name }) => {
          const o = scoreOpportunity(name, zipTierMap.get(zipOfLoc.get(j.locationId)) || null, null,
            systemAgeFromNotes(j, nowYear), /hvac/i.test(name) || trade === 'HVAC')
          return { jobNumber: j.jobNumber, name, score: o.score, reasons: o.reasons }
        })
        .sort((a, b) => a.score - b.score)
      const pick = scored[0]
      if (!pick) return null
      return {
        jobNumber: pick.jobNumber,
        name: pick.name,
        score: pick.score,
        why: pick.reasons.length ? pick.reasons.join(' · ') : 'no age, value or area signals — routine work',
        // Even the SAFEST call carrying opportunity signals is a real cost;
        // say so instead of presenting the bump as free.
        caution: pick.score >= 3 ? `every call on this plate carries opportunity signals (${pick.reasons.join(' · ')})` : null,
      }
    }

    // Which arrival windows does each tech still have open? Derived from
    // today's board: the day's distinct windows, minus ones where the tech
    // already has a commitment. Heuristic (windows overlap each other), so the
    // UI says "looks open" rather than promising.
    const winLabel = (ws, we) => {
      const f = (iso) => { const d = new Date(iso); const h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; const h12 = h % 12 === 0 ? 12 : h % 12; return `${h12} ${ap}` }
      return `${f(ws)}–${f(we)}`
    }
    const dayWindows = new Map()   // key -> {start,label}
    for (const a of appts) {
      const ws = a.arrivalWindowStart || a.start, we = a.arrivalWindowEnd || a.end
      if (!ws || !we) continue
      const k = `${ws}|${we}`
      if (!dayWindows.has(k)) dayWindows.set(k, { start: Date.parse(ws), end: Date.parse(we), label: winLabel(ws, we) })
    }
    const techWins = new Map()   // techId -> Set(windowKey)
    for (const a of assignments) {
      const ap = apptById.get(a.appointmentId)
      if (!ap || !a.technicianId) continue
      const ws = ap.arrivalWindowStart || ap.start, we = ap.arrivalWindowEnd || ap.end
      if (ws && we) {
        if (!techWins.has(a.technicianId)) techWins.set(a.technicianId, new Set())
        techWins.get(a.technicianId).add(`${ws}|${we}`)
      }
    }
    const nowMs2 = Date.now()
    const openWindowsFor = (techId) => [...dayWindows.entries()]
      .filter(([k, w]) => w.end > nowMs2 && !(techWins.get(techId)?.has(k)))
      .sort((a, b) => a[1].start - b[1].start)
      .map(([, w]) => w.label)

    // How deep into their day is each tech? A validated burnout penalty needs
    // the historical study first — until then this is surfaced, not scored.
    const runByTech = new Map()
    for (const a of assignments) {
      const st = apptById.get(a.appointmentId)?.status
      if (a.technicianId && (st === 'Done' || st === 'Working')) {
        runByTech.set(a.technicianId, (runByTech.get(a.technicianId) || 0) + 1)
      }
    }

    // Every option carries its bump cost, open windows and day-depth, so the
    // ranking table explains each alternative — not just the chosen one.
    for (const o of options) {
      o.bump = o.hasRoom ? null : bumpFor(o.techId)
      o.openWindows = o.hasRoom ? openWindowsFor(o.techId).slice(0, 3) : []
      o.callsRun = runByTech.get(o.techId) || 0
    }

    const top = options[0]
    let recommendation
    if (!top) {
      recommendation = {
        action: 'no_tech',
        text: restriction
          ? `${(restriction.techs || []).join(' / ')} ${restriction.techs?.length === 1 ? 'is' : 'are'} the only tech${restriction.techs?.length === 1 ? '' : 's'} for this job type — not on the schedule today. Hold until they're next on.`
          : `No ranked ${trade} tech is on the schedule for this today.`,
      }
    } else if (top.hasRoom) {
      recommendation = {
        action: 'book_assign',
        text: `Book it and put it on ${top.techName}${top.openWindows?.[0] ? ` — ${top.openWindows[0]} looks open` : ''}`,
        tech: top,
      }
    } else {
      // Full — a bump has to BUY something. The first version only asked "is
      // the new job valuable?", never "more valuable than what it displaces?"
      // — so it recommended evicting an HVAC Estimate to book an identical
      // HVAC Estimate: zero net revenue plus one rescheduled customer.
      //
      // Decision order when the top tech is full:
      //   normal: profitable bump (new call out-scores displaced by 2+, on a
      //           tech worth sending) → a lower tech with room → hold.
      //   override: someone with room → profitable bump → any bump → the day
      //             is physically closed.
      const bumped = options.filter(o => o.bump).map(o => ({ o, b: o.bump }))
      const profitable = bumped.find(x =>
        x.o.expectedValue >= 800 && (opp.score - x.b.score) >= 2)
      const roomy = options.find(o => o.hasRoom)   // top is full; someone below may not be

      if (!urgent) {
        if (profitable) {
          recommendation = {
            action: 'book_bump',
            text: `Book it on ${profitable.o.techName}, and reschedule #${profitable.b.jobNumber} (${profitable.b.name})`,
            tech: profitable.o, bump: profitable.b,
          }
        } else if (roomy) {
          recommendation = {
            action: 'book_assign',
            text: `Book it and put it on ${roomy.techName} — stronger techs are full, and swapping their work buys nothing`,
            tech: roomy,
          }
        } else {
          recommendation = {
            action: 'hold',
            text: opp.score < 2
              ? 'Not worth disrupting today — schedule it for the next open day'
              : bumped.length
                ? `Everyone is full and nothing on their plates is worth less than this call — a swap buys nothing. Hold for the next open day, or check "Must run today" to force it.`
                : `Everyone is full with work that can't move — hold for the next open day`,
          }
        }
      } else {
        if (roomy) {
          recommendation = { action: 'book_assign', text: `Override — book it and put it on ${roomy.techName}`, tech: roomy }
        } else if (bumped.length) {
          const pick2 = profitable || bumped[0]
          recommendation = {
            action: 'book_bump',
            text: `Override — book it on ${pick2.o.techName}, and reschedule #${pick2.b.jobNumber} (${pick2.b.name})`,
            tech: pick2.o, bump: pick2.b,
          }
        } else {
          recommendation = {
            action: 'no_slot',
            text: 'Every available tech is full and nothing on their plates can move — it physically has to go to another day.',
          }
        }
      }
    }

    res.json({
      trade, jobType, address: address || null,
      resolvedAddress: geo?.placeName || null,
      shiftDataMissing: geo && !workingTechs ? true : undefined,
      zip, zipTier,
      opportunity: opp.score, opportunityReasons: opp.reasons,
      located: Boolean(geo),
      restriction: restriction ? { pattern: restriction.pattern, techs: restriction.techs || [] } : null,
      urgent,
      recommendation,
      options: options.slice(0, 6),
      boardContext: { totalAssigned: assignments.length, benchSize: candidates.length, capacity: cap },
    })
  } catch (err) {
    console.error('decide error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 3-DAY CALL BOARD — daily email to leadership.
//
// SAFETY: the scheduled send is inert unless BOARD_EMAIL_TO is set. Deploying
// this cannot email anyone by accident; the recipient list is a deliberate,
// separate action. /test always requires an explicit recipient.
//
// The Resend key currently lives in .env as VITE_RESEND_API_KEY. That prefix is
// a Vite convention meaning "safe to expose to the browser", which an API key
// is NOT — it is only safe today because no frontend file references it (a
// VITE_ var is inlined into the bundle when, and only when, it is imported in
// client code). Read RESEND_API_KEY first so it can be renamed without a code
// change; the VITE_ fallback keeps it working until then.
// ═══════════════════════════════════════════════════════════════════════════

const RESEND_KEY = process.env.RESEND_API_KEY || process.env.VITE_RESEND_API_KEY
const BOARD_EMAIL_FROM = process.env.BOARD_EMAIL_FROM || 'Andi <andi@awesomeservice.com>'
const BOARD_EMAIL_TO = process.env.BOARD_EMAIL_TO || ''          // unset = no scheduled send
const BOARD_EMAIL_HOUR = Number(process.env.BOARD_EMAIL_HOUR || 7)  // local hour, 24h
const BOARD_EMAIL_TZ = process.env.BOARD_EMAIL_TZ || 'America/Denver'

async function sendResend({ to, subject, html }) {
  if (!RESEND_KEY) throw new Error('No Resend API key configured')
  const list = (Array.isArray(to) ? to : String(to).split(',')).map(s => s.trim()).filter(Boolean)
  if (!list.length) throw new Error('No recipient')
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: BOARD_EMAIL_FROM, to: list, subject, html }),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Resend ${r.status}: ${body?.message || JSON.stringify(body).slice(0, 200)}`)
  return body
}

async function buildBoardEmail() {
  const data = await build3DayBoard()
  return {
    data,
    subject: boardEmailSubject(data),
    html: renderBoardEmail(data, { appUrl: process.env.APP_URL || 'https://andi.awesomeservice.com' }),
  }
}

// Is the daily send actually armed? Without this the only way to tell a
// misconfigured scheduler from a broken one is to wait until 7am and see
// whether anything arrives — which is how the first morning was lost.
app.get('/api/board/email/status', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const { data: row } = await supabase.from('app_settings')
      .select('value').eq('key', BOARD_EMAIL_SENT_KEY).maybeSingle()
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: BOARD_EMAIL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {})
    res.json({
      enabled: Boolean(BOARD_EMAIL_TO && RESEND_KEY),
      recipients: BOARD_EMAIL_TO || null,
      missing: [!BOARD_EMAIL_TO && 'BOARD_EMAIL_TO', !RESEND_KEY && 'RESEND_API_KEY'].filter(Boolean),
      sendHour: BOARD_EMAIL_HOUR,
      windowHours: BOARD_EMAIL_WINDOW_HOURS,
      timezone: BOARD_EMAIL_TZ,
      localTime: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
      lastSentDate: row?.value ? String(row.value).replace(/"/g, '') : null,
      from: BOARD_EMAIL_FROM,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Preview only — renders and returns the HTML, sends nothing.
app.get('/api/board/email/preview', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const { html } = await buildBoardEmail()
    res.set('Content-Type', 'text/html; charset=utf-8').send(html)
  } catch (err) {
    console.error('board email preview error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Explicit send. `to` is required — there is deliberately no default recipient,
// so a stray call can't reach the leadership list.
app.post('/api/board/email/test', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const to = (req.body?.to || '').toString().trim()
    if (!to) return res.status(400).json({ error: 'A recipient is required.' })
    const { subject, html } = await buildBoardEmail()
    const out = await sendResend({ to, subject, html })
    console.log(`BOARD EMAIL: sent to ${to} (${out?.id || 'no id'})`)
    res.json({ ok: true, to, subject, id: out?.id || null })
  } catch (err) {
    console.error('board email send error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Daily scheduler, checked every 5 minutes.
//
// The "already sent today" guard lives in the DATABASE, not in memory. Two
// reasons, both of which would embarrass us in front of the leadership team:
//  - Railway restarts the process on every deploy, which would reset an
//    in-memory flag and fire a second email on any deploy after 7am.
//  - Two Railway replicas each hold their own memory, so both would send.
// The claim is a conditional update: whichever replica flips the stored date
// first wins, the other updates 0 rows and stands down.
//
// The send window is bounded (7:00–9:59 by default) rather than "any time at or
// after 7am", so a restart at 11pm can't fire a daily digest in the middle of
// the night — while still catching up if the server was down at 7.
const BOARD_EMAIL_SENT_KEY = 'board_email_last_sent'
const BOARD_EMAIL_WINDOW_HOURS = 3

async function maybeSendDailyBoardEmail() {
  if (!BOARD_EMAIL_TO || !RESEND_KEY) return
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BOARD_EMAIL_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {})
  const localDate = `${parts.year}-${parts.month}-${parts.day}`
  const localHour = Number(parts.hour === '24' ? 0 : parts.hour)
  if (localHour < BOARD_EMAIL_HOUR || localHour >= BOARD_EMAIL_HOUR + BOARD_EMAIL_WINDOW_HOURS) return

  try {
    const { data: row } = await supabase.from('app_settings')
      .select('value').eq('key', BOARD_EMAIL_SENT_KEY).maybeSingle()
    const prev = row?.value ?? null
    if (String(prev).replace(/"/g, '') === localDate) return   // already sent today

    // Claim the day. If another replica already moved it, we update 0 rows.
    if (row) {
      const { data: claimed } = await supabase.from('app_settings')
        .update({ value: localDate }).eq('key', BOARD_EMAIL_SENT_KEY).eq('value', prev).select()
      if (!claimed || claimed.length === 0) return
    } else {
      const { error } = await supabase.from('app_settings')
        .insert({ key: BOARD_EMAIL_SENT_KEY, value: localDate })
      if (error) return   // lost the insert race to another replica
    }

    const { subject, html } = await buildBoardEmail()
    await sendResend({ to: BOARD_EMAIL_TO, subject, html })
    console.log(`BOARD EMAIL: daily send to ${BOARD_EMAIL_TO} — ${subject}`)
  } catch (err) {
    // Leave the claim in place: a failed send is better than a retry loop
    // emailing leadership repeatedly. The next morning proceeds normally.
    console.error('BOARD EMAIL: daily send FAILED:', err.message)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LEAD INBOX — mirrors the ServiceTitan Bookings tab into `st_leads`.
//
// These are PAID leads (Angi/HomeAdvisor ~$52 each, Scorpion, etc). Revin AI
// texts and calls them immediately as a safety net; CSRs call back right away,
// or first thing in the morning for overnight arrivals. So this poller
// deliberately does NOT alert out-of-hours — the rail just accumulates.
//
// Verified ST constraints (Jul 2026), do not "simplify" these away:
//  - Bookings are READ-ONLY. PATCH/PUT/POST on /bookings/{id} and every
//    dismiss/convert/notes/status route return 404 "unable to match operation".
//    There is NO way to write a claim back onto a booking — Andi is the claim
//    authority, and ST only learns the truth when the job is booked (which
//    flips the booking to Converted on its own).
//  - The ?status= filter is IGNORED — asking for New returns Dismissed and
//    Converted rows too. Status MUST be re-checked client-side.
//  - Phone/email are not on the booking; they need /bookings/{id}/contacts.
// ═══════════════════════════════════════════════════════════════════════════

const LEAD_POLL_SECONDS = Number(process.env.LEAD_POLL_SECONDS || 60)

// ST returns "LeadsIntegration#33"; the UI resolves 33 → Angi + logo, but the
// API never gives the name. Hand-maintained — extend as providers are added.
const LEAD_PROVIDERS = { 33: 'Angi' }
function resolveProvider(source) {
  const raw = String(source || '')
  const m = raw.match(/^LeadsIntegration#(\d+)/)
  if (m) return LEAD_PROVIDERS[m[1]] || `Lead partner #${m[1]}`
  return raw.split('#')[0] || 'Unknown'
}

// Partner summaries arrive HTML-escaped (&#x0D; for every newline in a Scorpion
// chat transcript), which is unreadable raw. Note the mojibake in the source —
// Scorpion sends '?' where an apostrophe belongs ("I?m seeing") — that's lossy
// before it reaches us and can't be recovered, only tidied.
function decodeSummary(s) {
  if (!s) return s
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Has this lead ALREADY got a job on the books?
//
// Scorpion books through a path that never converts the booking record, so the
// booking sits as "New" with jobId 0 while a tech is genuinely scheduled
// (verified: Cruz Rangel, booking 62076455 New/jobId 0, but job #34585
// Scheduled with an appointment). Without this a rep calls someone who already
// has an appointment and tries to book them a second time.
//
// Two calls per lead, and only for leads still open, so the cost is trivial.
const OPEN_JOB_STATUSES = ['Scheduled', 'Dispatched', 'InProgress', 'In Progress']
async function findExistingBooking(phone) {
  const digits = (phone || '').replace(/\D/g, '').slice(-10)
  if (digits.length !== 10) return null
  try {
    const cust = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers?phone=${digits}&pageSize=5`)
    const customers = cust?.data || []
    if (!customers.length) return null

    for (const c of customers) {
      const jobs = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs?customerId=${c.id}&pageSize=10&sort=-createdOn`)
      const open = (jobs?.data || []).find(j => OPEN_JOB_STATUSES.includes(j.jobStatus))
      if (!open) { if (customers.length === 1) return { customerId: c.id } ; continue }

      let apptAt = null
      try {
        const appts = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/appointments?jobId=${open.id}&pageSize=5`)
        apptAt = (appts?.data || [])[0]?.start || null
      } catch { /* the job alone is enough to badge it */ }

      return { customerId: c.id, jobId: open.id, jobNumber: open.jobNumber || null, appointmentAt: apptAt }
    }
    return { customerId: customers[0].id }
  } catch (e) {
    console.warn('findExistingBooking failed:', e.message)
    return null
  }
}

// The booking `summary` is a semi-structured blob from the lead partner. Pull
// out the bits a rep needs at a glance; everything stays in summary regardless.
function parseLeadSummary(summary) {
  const s = decodeSummary(summary) || ''
  const grab = (re) => { const m = s.match(re); return m ? m[1].trim() : null }
  const fee = grab(/Lead Fee:\s*\$?([\d.]+)/i)

  // Angi/HomeAdvisor ship labelled fields. Scorpion ships a chat transcript
  // with none of them, which left Scorpion cards showing nothing but a name and
  // a number — so fall back to the customer's own first message, which is the
  // most useful line in the whole blob ("My home air conditioner").
  let jobType = grab(/Partner Job type:\s*(.+)/i) || grab(/Job type\(s\):\s*(.+)/i)
  if (!jobType) {
    const asks = [...s.matchAll(/^\s*User:\s*(.+)$/gim)].map(m => m[1].trim())
      .filter(t => t.length > 12 && !/^(ok|yes|no|thanks|sounds good)\b/i.test(t))
    // Third shape: LSA/Google sends a flat "Message: <what they want>" with no
    // chat at all — e.g. "Installation of a 240 vault outlet [Notes from LSA:
    // This customer has requested a quote]". Strip the bracketed partner note
    // out of the headline; it's surfaced separately as the ask type.
    jobType = asks[0] || (grab(/^\s*Message:\s*(.+)$/im) || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim() || null
  }
  if (jobType && jobType.length > 120) jobType = jobType.slice(0, 117) + '…'

  return {
    lead_fee: fee ? Number(fee) : null,
    urgency: grab(/When do you need this work done\?:\s*(.+)/i),
    job_type: jobType,
    message: grab(/Message from Customer:\s*(.+)/i),
  }
}

async function syncLeadInbox() {
  try {
    // ST ignores ?status=New, so pull a recent window and filter here.
    const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10)
    const data = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/bookings?createdOnOrAfter=${since}&pageSize=500&sort=-createdOn`)
    const rows = data?.data || []
    if (!rows.length) return

    const open = rows.filter(b => b.status === 'New')
    const closed = rows.filter(b => b.status && b.status !== 'New').map(b => b.id)

    // Anything no longer New leaves the inbox — this is how a dismissal or
    // conversion made inside ServiceTitan disappears from the rail.
    if (closed.length) {
      await supabase.from('st_leads')
        .update({ resolved_at: new Date().toISOString(), last_synced_at: new Date().toISOString() })
        .in('booking_id', closed).is('resolved_at', null)
    }
    if (!open.length) return

    // Only fetch contacts for bookings we don't already hold — phone/email is
    // one call per booking, so never re-fetch what's already mirrored.
    const { data: existing } = await supabase.from('st_leads')
      .select('booking_id').in('booking_id', open.map(b => b.id))
    const have = new Set((existing || []).map(r => Number(r.booking_id)))
    const fresh = open.filter(b => !have.has(b.id))

    for (const b of fresh) {
      let phone = null, email = null
      try {
        const c = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/bookings/${b.id}/contacts`)
        const cs = c?.data || []
        phone = (cs.find(x => (x.type || '').toLowerCase().includes('phone')) || {}).value || null
        email = (cs.find(x => (x.type || '').toLowerCase().includes('email')) || {}).value || null
      } catch (e) { console.warn(`lead ${b.id} contacts failed:`, e.message) }

      const parsed = parseLeadSummary(b.summary)
      const a = b.address || {}
      const { error } = await supabase.from('st_leads').upsert({
        booking_id: b.id,
        name: b.name || null,
        phone, email,
        address: a.street || null, city: a.city || null, state: a.state || null, zip: a.zip || null,
        source: b.source || null,
        provider: resolveProvider(b.source),
        summary: decodeSummary(b.summary) || null,
        lead_fee: parsed.lead_fee,
        urgency: parsed.urgency,
        job_type: parsed.job_type,
        st_status: b.status,
        submitted_at: b.createdOn || null,
        last_synced_at: new Date().toISOString(),
      }, { onConflict: 'booking_id' })
      if (error) console.error('lead upsert failed:', error.message)
    }
    if (fresh.length) console.log(`Lead inbox: +${fresh.length} new, ${closed.length} resolved`)

    // Re-check every open lead for an existing appointment. Deliberately not
    // limited to freshly-inserted ones: a partner (or Revin) can book a lead
    // minutes AFTER it lands, so a one-shot check at insert would leave the
    // rail telling a rep to call someone who has since been scheduled.
    const { data: openLeads } = await supabase.from('st_leads')
      .select('id, phone, already_booked, st_customer_id, summary, job_type, urgency, lead_fee').is('resolved_at', null)
    for (const lead of (openLeads || [])) {
      // Re-parse from the stored summary. Rows are parsed once at insert, so
      // without this any improvement to the parser only ever reaches leads that
      // arrive afterwards — existing open leads keep whatever the old parser
      // produced (or nothing). Costs no ST calls.
      if (lead.summary && (!lead.job_type || !lead.urgency || lead.lead_fee == null)) {
        const reparsed = parseLeadSummary(lead.summary)
        const fix = {}
        if (!lead.job_type && reparsed.job_type) fix.job_type = reparsed.job_type
        if (!lead.urgency && reparsed.urgency) fix.urgency = reparsed.urgency
        if (lead.lead_fee == null && reparsed.lead_fee != null) fix.lead_fee = reparsed.lead_fee
        if (Object.keys(fix).length) await supabase.from('st_leads').update(fix).eq('id', lead.id)
      }

      if (lead.already_booked) continue
      const hit = await findExistingBooking(lead.phone)
      if (!hit) continue
      const patch = { st_customer_id: hit.customerId || null, last_synced_at: new Date().toISOString() }
      if (hit.jobId) {
        patch.already_booked = true
        patch.booked_job_id = hit.jobId
        patch.booked_job_number = hit.jobNumber
        patch.booked_at = hit.appointmentAt
        console.log(`Lead ${lead.id} is already booked (job ${hit.jobNumber || hit.jobId})`)
      }
      await supabase.from('st_leads').update(patch).eq('id', lead.id)
    }
  } catch (err) {
    console.error('syncLeadInbox error:', err.message)
  }
}

// Claim a lead. Andi is the claim authority — ST has no field to write this to.
// Conditional on being unclaimed so two reps racing can't both win a paid lead.
app.post('/api/leads/:id/claim', async (req, res) => {
  try {
    const rep = (req.body?.rep || '').toString().trim()
    if (!rep) return res.status(400).json({ error: 'rep required' })

    const { data, error } = await supabase.from('st_leads')
      .update({ claimed_by: rep, claimed_at: new Date().toISOString() })
      .eq('id', req.params.id).is('claimed_by', null).is('resolved_at', null)
      .select().maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) {
      const { data: cur } = await supabase.from('st_leads').select('claimed_by, resolved_at').eq('id', req.params.id).maybeSingle()
      return res.status(409).json({ error: cur?.resolved_at ? 'This lead is no longer open.' : `Already claimed by ${cur?.claimed_by || 'someone else'}.` })
    }
    res.json({ lead: data })
  } catch (err) {
    console.error('lead claim error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/leads/:id/release', async (req, res) => {
  try {
    const { error } = await supabase.from('st_leads')
      .update({ claimed_by: null, claimed_at: null }).eq('id', req.params.id)
    if (error) throw new Error(error.message)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Promote a claimed lead into a real contact so the whole dialer machinery
// (call logs, dispositions, DNC, AI brief, commissions) applies unchanged.
// Re-checks the booking's live ST status first — a lead dismissed in ST up to a
// minute ago would otherwise still look open here.
app.post('/api/leads/:id/promote', async (req, res) => {
  try {
    const { data: lead } = await supabase.from('st_leads').select('*').eq('id', req.params.id).maybeSingle()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })
    // Already promoted (a re-open, or two clicks racing). Return the FULL
    // contact, not just the id — the caller seeds it into its cache before
    // navigating, and an id alone renders an empty customer tab.
    if (lead.contact_id) {
      const { data: existing } = await supabase.from('contacts').select('*').eq('id', lead.contact_id).maybeSingle()
      // Still resolve it. Without this a re-opened lead never leaves the rail,
      // because the resolve below is skipped by this early return.
      if (!lead.resolved_at) {
        await supabase.from('st_leads').update({ resolved_at: new Date().toISOString() }).eq('id', lead.id)
      }
      return res.json({ contactId: lead.contact_id, contact: existing || null, alreadyPromoted: true })
    }

    try {
      const live = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/bookings/${lead.booking_id}`)
      if (live?.status && live.status !== 'New') {
        await supabase.from('st_leads').update({ st_status: live.status, resolved_at: new Date().toISOString() }).eq('id', lead.id)
        return res.status(409).json({ error: `This lead was ${String(live.status).toLowerCase()} in ServiceTitan.` })
      }
    } catch (e) { console.warn('lead pre-dial status check failed:', e.message) }

    // Park leads in their own campaign so they're reportable separately.
    let campaignId = null
    const { data: camp } = await supabase.from('campaigns').select('id').eq('name', 'Leads').maybeSingle()
    if (camp) campaignId = camp.id
    else {
      const { data: made } = await supabase.from('campaigns')
        .insert({ name: 'Leads', description: 'Paid leads from ServiceTitan Bookings', status: 'Active' })
        .select().single()
      campaignId = made?.id || null
    }

    const { data: contact, error } = await supabase.from('contacts').insert({
      name: lead.name || 'Unknown',
      phone: lead.phone, email: lead.email,
      address: lead.address, city: lead.city, state: lead.state, zip: lead.zip,
      source: lead.provider || 'Lead',
      import_notes: lead.summary || null,
      // external_id must be the ServiceTitan CUSTOMER id — the intelligence
      // brief, recent jobs and membership panels all look up by it. It was the
      // booking id, which matches no customer, so every promoted lead showed
      // "no service history" even when ST knew them. Falls back to the booking
      // id only when the customer genuinely doesn't exist in ST yet.
      external_id: lead.st_customer_id ? String(lead.st_customer_id) : String(lead.booking_id),
      status: 'Pending', attempts: 0,
      campaign_id: campaignId,
      claimed_by: lead.claimed_by || null,
      claimed_at: lead.claimed_at || null,
    }).select().single()
    if (error) throw new Error('contact create: ' + error.message)

    await supabase.from('st_leads')
      .update({ contact_id: contact.id, resolved_at: new Date().toISOString() }).eq('id', lead.id)
    res.json({ contactId: contact.id, contact })
  } catch (err) {
    console.error('lead promote error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Recent CALLS involving this lead's number, so a rep doesn't dial someone who
// was just spoken to.
//
// Two ST traps, both verified — do not "simplify" this back:
//  - ?phoneNumber= is IGNORED. Two different numbers return byte-identical
//    rows, none matching what was asked for. Filtering MUST happen here, or
//    reps get shown unrelated strangers' calls.
//  - ?sort= is IGNORED (a -createdOn request returned 2024 rows first), so the
//    ordering is done here too. createdOnOrAfter DOES work, which is what makes
//    the window small enough to filter in memory (~186 calls over 2 days).
//
// SCOPE: calls only. Revin AI texts every lead immediately and those texts do
// NOT exist in ST telecom, so an empty result here does NOT mean "untouched".
// Real texting visibility needs an API/webhook from Revin.
app.get('/api/leads/:id/touches', async (req, res) => {
  try {
    const { data: lead } = await supabase.from('st_leads').select('phone, submitted_at').eq('id', req.params.id).maybeSingle()
    const digits = (lead?.phone || '').replace(/\D/g, '').slice(-10)
    if (!digits) return res.json({ touches: [], callsOnly: true })

    // Window back to just before the lead landed (min 2 days, cap 14).
    const from = lead?.submitted_at ? new Date(lead.submitted_at) : new Date()
    from.setDate(from.getDate() - 1)
    const floor = new Date(Date.now() - 14 * 864e5)
    const since = (from < floor ? floor : from).toISOString().slice(0, 10)

    const data = await stGet(`/telecom/v2/tenant/${ST_TENANT_ID}/calls?createdOnOrAfter=${since}&pageSize=500`)
    const tenOf = (v) => String(v || '').replace(/\D/g, '').slice(-10)
    const touches = (data?.data || [])
      .map(c => c.leadCall || c)
      .filter(lc => tenOf(lc.from) === digits || tenOf(lc.to) === digits)
      .map(lc => ({
        at: lc.createdOn || null,
        direction: lc.direction || null,
        agent: (lc.agent && (lc.agent.name || lc.agent)) || null,
        reason: (lc.reason && (lc.reason.name || lc.reason)) || null,
      }))
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      .slice(0, 10)
    res.json({ touches, callsOnly: true })
  } catch (err) {
    res.json({ touches: [], callsOnly: true, error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// AI CAMPAIGN BUILDER — natural language → ServiceTitan audience → contacts.
//
// Claude maps a request onto ONE of a fixed catalog of recipes; it does NOT get
// to invent queries. Each recipe is backed by ST endpoints verified live to
// return data for this tenant (Jul 2026). Admin-only, previews before it
// inserts, skips DNC + ST's own doNotService flag.
//
// ST realities baked in here (all verified live, do not "optimize" away):
//  - Filter params are silently IGNORED (tagTypeIds, date windows) → we page the
//    resource and filter in memory. The datasets are small (939 memberships,
//    1087 equipment) except customers, which we pull via the 5k/page export feed.
//  - No bulk phone feed: phone is per-customer via /customers/{id}/contacts.
//  - installed-equipment.type is null → trade inferred from manufacturer/model.
//  - membership.to is null for open-ended monthly plans → those never "expire".
//  - Offset paging (?page=N) works on memberships/equipment/customers.
// ═══════════════════════════════════════════════════════════════════════════

const AUD_CAP = 20000              // hard ceiling on rows scanned per recipe
const PHONE_CAP = 750              // max customers we resolve phones for per build
const PHONE_CONCURRENCY = 8

const normPhone10 = (v) => (v || '').replace(/\D/g, '').slice(-10)

// Page an offset-paginated ST list (page=1..) until hasMore is false or cap hit.
async function stPageAll(pathForPage, cap = AUD_CAP) {
  const out = []
  for (let page = 1; page <= 500; page++) {
    const d = await stGet(pathForPage(page))
    const rows = d?.data || []
    out.push(...rows)
    if (!d?.hasMore || out.length >= cap) break
  }
  return out
}

// Page the CRM export feed (5k/page, continuation-token). Far fewer calls than
// offset paging for the full customer base.
async function stExportAll(base, cap = AUD_CAP) {
  const out = []
  let token = null
  for (let i = 0; i < 200; i++) {
    const url = base + (token ? `${base.includes('?') ? '&' : '?'}from=${encodeURIComponent(token)}` : '')
    const d = await stGet(url)
    out.push(...(d?.data || []))
    token = d?.continueFrom
    if (!d?.hasMore || !token || out.length >= cap) break
  }
  return out
}

const dedupeByCustomer = (rows) => {
  const seen = new Map()
  for (const r of rows) if (r.customerId && !seen.has(r.customerId)) seen.set(r.customerId, r)
  return [...seen.values()]
}

// The next-anniversary of a membership's start date, from today. Annual
// maintenance recurs on the membership anniversary, so this is the due anchor —
// deterministic and independent of ST's sparse/undated service-event records.
function nextAnniversary(fromISO) {
  if (!fromISO) return null
  const from = new Date(fromISO)
  if (Number.isNaN(from.getTime())) return null
  const now = new Date()
  const d = new Date(now.getFullYear(), from.getMonth(), from.getDate())
  if (d < now) d.setFullYear(d.getFullYear() + 1)
  return d
}

// ── Recipes. Each returns [{ customerId, reason, name?, address? }] ───────────

async function recipeMembershipExpiring(plan) {
  const months = Math.max(1, Math.min(24, plan.window_months || 3))
  const now = new Date()
  const soon = new Date(now); soon.setMonth(soon.getMonth() + months)
  const past = new Date(now); past.setMonth(past.getMonth() - months)

  const active = await stPageAll(p => `/memberships/v2/tenant/${ST_TENANT_ID}/memberships?status=Active&pageSize=200&page=${p}`)
  const expiring = active
    .filter(m => m.to && new Date(m.to) >= now && new Date(m.to) <= soon)
    .map(m => ({ customerId: m.customerId, reason: `Membership expires ${String(m.to).slice(0, 10)}` }))

  let cancelled = []
  if (plan.include_cancelled) {
    try {
      const canc = await stPageAll(p => `/memberships/v2/tenant/${ST_TENANT_ID}/memberships?status=Canceled&pageSize=200&page=${p}`)
      cancelled = canc
        .filter(m => { const d = m.cancellationDate || m.to; return d && new Date(d) >= past && new Date(d) <= now })
        .map(m => ({ customerId: m.customerId, reason: `Membership cancelled ${String(m.cancellationDate || m.to).slice(0, 10)}` }))
    } catch (e) { console.warn('membership_expiring cancelled fetch failed:', e.message) }
  }
  return dedupeByCustomer([...expiring, ...cancelled])
}

async function recipeMaintenanceDue(plan) {
  const trade = plan.trade || 'HVAC'
  const months = Math.max(1, Math.min(24, plan.window_months || 3))
  const now = new Date()
  const soon = new Date(now); soon.setMonth(soon.getMonth() + months)

  const services = await stPageAll(p => `/memberships/v2/tenant/${ST_TENANT_ID}/recurring-services?active=true&pageSize=200&page=${p}`)
  const tradeRe = new RegExp(trade === 'Garage' ? 'garage' : trade, 'i')
  const membIdsWithService = new Set(
    services.filter(s => tradeRe.test(s.name || '')).map(s => s.membershipId))
  if (!membIdsWithService.size) return []

  const active = await stPageAll(p => `/memberships/v2/tenant/${ST_TENANT_ID}/memberships?status=Active&pageSize=200&page=${p}`)
  return dedupeByCustomer(active
    .filter(m => membIdsWithService.has(m.id))
    .map(m => ({ m, due: nextAnniversary(m.from) }))
    .filter(x => x.due && x.due >= now && x.due <= soon)
    .map(x => ({ customerId: x.m.customerId, reason: `${trade} maintenance due ~${x.due.toISOString().slice(0, 10)}` })))
}

// Customers who had a matching job completed in the window. The planner picks
// job_type_ids from the job-type catalog (empty = any job). ST's
// completedOnOrAfter/jobStatus filters can be unreliable, so re-check both
// client-side.
async function recipeJobHistory(plan) {
  const months = Math.max(1, Math.min(24, plan.window_months || 6))
  const since = new Date(); since.setMonth(since.getMonth() - months)
  const sinceISO = since.toISOString().slice(0, 10)
  const ids = new Set((plan.job_type_ids || []).map(Number).filter(Boolean))

  const jt = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/job-types?active=true&pageSize=500`)
  const typeById = new Map((jt?.data || []).map(t => [t.id, t.name || '']))

  const jobs = await stPageAll(p => `/jpm/v2/tenant/${ST_TENANT_ID}/jobs?jobStatus=Completed&completedOnOrAfter=${sinceISO}&pageSize=500&page=${p}`)
  return dedupeByCustomer(jobs
    .filter(j => j.customerId && j.jobStatus === 'Completed' && j.completedOn && new Date(j.completedOn) >= since)
    .filter(j => !ids.size || ids.has(j.jobTypeId))
    .map(j => ({ customerId: j.customerId, reason: `${typeById.get(j.jobTypeId) || 'Job'} completed ${String(j.completedOn).slice(0, 10)}` })))
}

async function recipeTagType(plan) {
  const tagId = Number(plan.tag_id)
  if (!tagId) return []
  const custs = await stExportAll(`/crm/v2/tenant/${ST_TENANT_ID}/export/customers`, 60000)
  return custs
    .filter(c => c.active !== false && !c.doNotService && (c.tagTypeIds || []).includes(tagId))
    .map(c => ({ customerId: c.id, name: c.name, address: c.address, reason: `Tagged "${plan.tag_name || tagId}"` }))
}

const RECIPES = {
  membership_expiring: recipeMembershipExpiring,
  maintenance_due: recipeMaintenanceDue,
  job_history: recipeJobHistory,
  tag_type: recipeTagType,
}

// Turn matched customerIds into dialable contact rows: bulk-fetch names/addresses
// where the recipe didn't already have them, then resolve one phone each.
async function enrichAudience(matched) {
  const need = matched.filter(m => !m.name || !m.address).map(m => m.customerId)
  const custById = new Map()
  for (let i = 0; i < need.length; i += 50) {
    const ids = need.slice(i, i + 50).join(',')
    try {
      const d = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers?ids=${ids}&pageSize=50`)
      for (const c of (d?.data || [])) custById.set(c.id, c)
    } catch (e) { console.warn('enrich bulk customer failed:', e.message) }
  }

  const capped = matched.slice(0, PHONE_CAP)
  const out = new Array(capped.length)
  let idx = 0
  await Promise.all(Array.from({ length: Math.min(PHONE_CONCURRENCY, capped.length) }, async () => {
    while (idx < capped.length) {
      const i = idx++
      const m = capped[i]
      const cust = custById.get(m.customerId)
      const name = m.name || cust?.name || null
      const addr = m.address || cust?.address || {}
      let phone = null, email = null
      try {
        const d = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers/${m.customerId}/contacts`)
        const rows = d?.data || []
        const ph = rows.find(c => c.type === 'MobilePhone') || rows.find(c => (c.type || '').includes('Phone'))
        const em = rows.find(c => c.type === 'Email' || c.type === 'MobileEmail')
        phone = ph?.value || null; email = em?.value || null
      } catch { /* no contacts → dropped as no-phone below */ }
      out[i] = {
        customerId: m.customerId, name, reason: m.reason, phone, email,
        address: addr?.street || null, city: addr?.city || null,
        state: addr?.state || null, zip: addr?.zip || null,
      }
    }
  }))
  return { rows: out.filter(Boolean), truncated: matched.length > PHONE_CAP, total: matched.length }
}

// Short-lived catalog caches (each one page: ~186 tags, ~112 job types).
let _tagCatalog = null, _tagCatalogAt = 0
async function getTagCatalog() {
  if (_tagCatalog && Date.now() - _tagCatalogAt < 6 * 36e5) return _tagCatalog
  const d = await stGet(`/settings/v2/tenant/${ST_TENANT_ID}/tag-types?pageSize=500&active=true`)
  _tagCatalog = (d?.data || []).map(t => ({ id: t.id, name: (t.name || '').trim() }))
  _tagCatalogAt = Date.now()
  return _tagCatalog
}
let _jobTypeCatalog = null, _jobTypeCatalogAt = 0
async function getJobTypeCatalog() {
  if (_jobTypeCatalog && Date.now() - _jobTypeCatalogAt < 6 * 36e5) return _jobTypeCatalog
  const d = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/job-types?active=true&pageSize=500`)
  _jobTypeCatalog = (d?.data || []).map(t => ({ id: t.id, name: (t.name || '').trim() }))
  _jobTypeCatalogAt = Date.now()
  return _jobTypeCatalog
}

// ── Planner: English → structured plan (Claude Haiku, strict JSON) ────────────
async function planAudience(request, tagCatalog, jobTypeCatalog) {
  if (!ANTHROPIC_KEY) throw new Error('AI planner unavailable (no ANTHROPIC_API_KEY)')
  const sys = `You convert a call-center manager's plain-English request into a ServiceTitan audience plan for Awesome Home Services (HVAC, plumbing, electrical, garage doors). You may ONLY use the four recipes below. If the request doesn't fit one, return recipe "unsupported" and explain.

RECIPES:
- "membership_expiring": members whose membership is ending soon (and, if include_cancelled, recently-cancelled members to win back). Params: window_months (default 3), include_cancelled (bool — set true if they mention win-back, lapsed, or cancelled members).
- "maintenance_due": active members whose annual maintenance for a trade is coming due. Params: trade (HVAC|Plumbing|Electrical|Garage), window_months (default 3).
- "job_history": customers who had a particular kind of job completed recently (follow-up / win-back on past work). Params: job_type_ids (array of ids from the JOB TYPE CATALOG below — pick every type that fits, e.g. all "...Repair" types for "repairs"; leave empty for any job), window_months (default 6). A "tune-up" is a Maintenance job type.
- "tag_type": customers carrying a specific ServiceTitan tag. Param: tag_id + tag_name, chosen from the TAG CATALOG below. Pick the single best-matching tag; if none clearly matches, set recipe "unsupported".

TAG CATALOG (id: name):
${tagCatalog.map(t => `${t.id}: ${t.name}`).join('\n')}

JOB TYPE CATALOG (id: name):
${jobTypeCatalog.map(t => `${t.id}: ${t.name}`).join('\n')}

Return ONLY a JSON object, no markdown:
{
  "recipe": "membership_expiring|maintenance_due|job_history|tag_type|unsupported",
  "trade": "HVAC|Plumbing|Electrical|Garage or null",
  "window_months": number or null,
  "include_cancelled": boolean,
  "job_type_ids": [numbers] or [],
  "tag_id": number or null,
  "tag_name": "string or null",
  "readback": "one plain sentence restating exactly who will be pulled",
  "campaign_name": "short suggested campaign name (<= 5 words)",
  "note": "if unsupported, one sentence on what ServiceTitan can't answer; else empty"
}`
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 500, system: sys,
      messages: [{ role: 'user', content: request }],
    }),
  })
  if (!r.ok) throw new Error(`AI planner error ${r.status}`)
  const data = await r.json()
  let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const plan = JSON.parse(text)
  if (!RECIPES[plan.recipe] && plan.recipe !== 'unsupported') plan.recipe = 'unsupported'
  return plan
}

app.post('/api/st/audience/plan', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const request = (req.body?.request || '').toString().slice(0, 1000)
    if (!request.trim()) return res.status(400).json({ error: 'Describe who you want to reach.' })
    const [tagCatalog, jobTypeCatalog] = await Promise.all([getTagCatalog(), getJobTypeCatalog()])
    const plan = await planAudience(request, tagCatalog, jobTypeCatalog)
    res.json({ plan })
  } catch (err) {
    console.error('audience/plan error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/st/audience/build', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const plan = req.body?.plan
    const commit = req.body?.commit === true
    if (!plan || !RECIPES[plan.recipe]) return res.status(400).json({ error: 'No runnable plan.' })

    const matched = await RECIPES[plan.recipe](plan)
    const { rows, truncated, total } = await enrichAudience(matched)

    // DNC = any contact already marked DNC in Andi (the app's DNC cascade is by
    // normalized phone). Also skip anything already in the contacts table.
    const { data: existing } = await supabase.from('contacts').select('phone, status')
    const dnc = new Set(), have = new Set()
    for (const c of (existing || [])) {
      const p = normPhone10(c.phone); if (!p) continue
      have.add(p)
      if (c.status === 'DNC') dnc.add(p)
    }

    let noPhone = 0, dncSkipped = 0, dupSkipped = 0
    const keep = []
    for (const r of rows) {
      const p = normPhone10(r.phone)
      if (!p) { noPhone++; continue }
      if (dnc.has(p)) { dncSkipped++; continue }
      if (have.has(p)) { dupSkipped++; continue }
      keep.push(r)
    }

    const stats = { matched: total, truncated, resolved: rows.length, noPhone, dncSkipped, dupSkipped, dialable: keep.length }

    if (!commit) {
      return res.json({ stats, sample: keep.slice(0, 25).map(r => ({ name: r.name, phone: r.phone, reason: r.reason })) })
    }

    // Commit — create the campaign, then insert the dialable contacts.
    const name = (req.body?.campaign_name || plan.campaign_name || 'AI Campaign').toString().slice(0, 120)
    const { data: camp, error: ce } = await supabase.from('campaigns')
      .insert({ name, description: plan.readback || '', status: 'Active', source_query: plan }).select().single()
    if (ce) throw new Error('campaign create: ' + ce.message)

    const contactRows = keep.map(r => ({
      name: r.name || 'Unknown', phone: r.phone, email: r.email || null,
      address: r.address || null, city: r.city || null, state: r.state || null, zip: r.zip || null,
      source: 'ServiceTitan (AI)', import_notes: r.reason || null,
      external_id: r.customerId ? String(r.customerId) : null,
      status: 'Pending', attempts: 0, campaign_id: camp.id,
    }))
    let created = 0
    for (let i = 0; i < contactRows.length; i += 1000) {
      const { data, error } = await supabase.from('contacts').insert(contactRows.slice(i, i + 1000)).select('id')
      if (error) throw new Error('contact insert: ' + error.message)
      created += data?.length || 0
    }
    res.json({ stats, campaignId: camp.id, campaignName: name, created })
  } catch (err) {
    console.error('audience/build error:', err.message)
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

// ── Commission sync loop (interval configured next to the sync engine above).
// A second Railway replica double-syncing is harmless — the upserts are
// idempotent on the ST id — just wasteful.
if (SYNC_INTERVAL_MIN > 0) {
  // Wait a beat after boot so a deploy doesn't sync before the app is serving.
  setTimeout(() => {
    syncCommissions()
    setInterval(syncCommissions, SYNC_INTERVAL_MIN * 60_000)
  }, 30_000)
  console.log(`Commission sync every ${SYNC_INTERVAL_MIN}m`)
} else {
  console.log('Commission sync disabled (COMMISSION_SYNC_MINUTES=0)')
}

// ── Lead inbox poll. Faster than the commission sync because these are paid
// leads competitors are also calling — a minute of staleness is a lost job.
// A second Railway replica double-polling is harmless (upsert on booking_id).
// Daily leadership email. Inert until BOARD_EMAIL_TO is set — deploying this
// cannot email anyone by accident.
if (BOARD_EMAIL_TO && RESEND_KEY) {
  setInterval(maybeSendDailyBoardEmail, 60_000)   // 1-min tick: a 5-min one made 7:00 land as late as 7:04
  setTimeout(maybeSendDailyBoardEmail, 20_000)
  console.log(`Board email daily at ${BOARD_EMAIL_HOUR}:00 ${BOARD_EMAIL_TZ} to ${BOARD_EMAIL_TO}`)
} else {
  console.log('Board email scheduler off (set BOARD_EMAIL_TO to enable)')
}

// Dispatch scores: expensive (~100 ST calls), so refreshed on a slow cycle
// rather than on demand. Staggered past boot so a deploy doesn't stampede ST.
if (DISPATCH_REFRESH_HOURS > 0) {
  setTimeout(() => {
    refreshDispatchScores().catch(() => {})
    setInterval(() => refreshDispatchScores().catch(() => {}), DISPATCH_REFRESH_HOURS * 3600_000)
  }, 120_000)
  console.log(`Dispatch scores refresh every ${DISPATCH_REFRESH_HOURS}h (${DISPATCH_WINDOW_DAYS}d window)`)
}

if (LEAD_POLL_SECONDS > 0) {
  setTimeout(() => {
    syncLeadInbox()
    setInterval(syncLeadInbox, LEAD_POLL_SECONDS * 1000)
  }, 10_000)
  console.log(`Lead inbox poll every ${LEAD_POLL_SECONDS}s`)
} else {
  console.log('Lead inbox poll disabled (LEAD_POLL_SECONDS=0)')
}
