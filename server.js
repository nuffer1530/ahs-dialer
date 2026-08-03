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
// Dedicated tech/dispatch DID — bought Jul 31 2026, routes to the Dispatch
// TaskRouter queue (workers with dispatch == 1) instead of the CSR floor.
const DISPATCH_NUMBER = process.env.TWILIO_DISPATCH_NUMBER || '+17192592681'
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
// The env var is the fallback; admins tune the live value in Settings →
// Thresholds (app_settings.ops_config), read through getOpsConfig().
const ABANDON_GRACE_SECONDS = Number(process.env.ABANDON_GRACE_SECONDS ?? 10)
let _opsCfg = null, _opsCfgAt = 0
async function getOpsConfig() {
  if (_opsCfg && Date.now() - _opsCfgAt < 60_000) return _opsCfg
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'ops_config').maybeSingle()
    _opsCfg = JSON.parse(data?.value || '{}')
  } catch { _opsCfg = {} }
  _opsCfgAt = Date.now()
  return _opsCfg
}

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
    // The note AUTHOR in ST is always the API account (ST offers no
    // impersonation), so the rep's name leads the text where eyes land.
    const noteText = `${repName || 'CSR'} (via Andi): ${note}`

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
// Tag-type catalog (id → name + ST's hex color). ~Static; cached 6 hours.
let _tagTypeCache = null
async function getTagTypes() {
  if (_tagTypeCache && _tagTypeCache.expires > Date.now()) return _tagTypeCache.map
  const map = new Map()
  let p = 1
  while (p <= 10) {
    const d = await stGet(`/settings/v2/tenant/${ST_TENANT_ID}/tag-types?pageSize=200&page=${p}`)
    for (const t of (d?.data || [])) map.set(t.id, { name: t.name, color: t.color || null })
    if (!d?.hasMore) break
    p++
  }
  _tagTypeCache = { map, expires: Date.now() + 6 * 3600_000 }
  return map
}

// Create a brand-new ST customer + primary location so a first-time caller
// can be booked without leaving Andi. _retry = false: stPost retries on
// timeout, and a doubled create means a duplicate customer record in ST.
app.post('/api/st/customer/create', async (req, res) => {
  try {
    const { name, phone, email, street, city, state, zip } = req.body || {}
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Customer name is required' })
    if (!String(street || '').trim() || !String(city || '').trim() || !String(zip || '').trim()) {
      return res.status(400).json({ error: 'Street, city and zip are required — ST needs a service location' })
    }
    const address = {
      street: String(street).trim(), city: String(city).trim(),
      state: String(state || 'CO').trim() || 'CO', zip: String(zip).trim(), country: 'USA',
    }
    const contacts = []
    if (String(phone || '').trim()) contacts.push({ type: 'MobilePhone', value: String(phone).trim() })
    if (String(email || '').trim()) contacts.push({ type: 'Email', value: String(email).trim() })
    const body = {
      name: String(name).trim(),
      type: 'Residential',
      address,
      contacts,
      locations: [{ name: String(name).trim(), address, contacts }],
    }
    const created = await stPost(`/crm/v2/tenant/${ST_TENANT_ID}/customers`, body, false)
    if (!created?.id) throw new Error('ServiceTitan returned no customer id')
    res.json({ id: created.id, name: created.name || body.name })
  } catch (err) {
    console.error('ST customer create error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Full ST tag catalog for the picker (6h-cached upstream).
app.get('/api/st/tag-types', async (req, res) => {
  try {
    const map = await getTagTypes()
    res.json({ tags: [...map.entries()].map(([id, t]) => ({ id, name: t.name, color: t.color }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Add/remove customer tags — writes straight to the ST account. Read-modify-
// write on tagTypeIds; _retry stays on (a repeated PATCH of the same set is
// idempotent, unlike a create).
app.post('/api/st/customer/:id/tags', async (req, res) => {
  try {
    const id = req.params.id
    const add = (req.body?.add || []).map(Number).filter(Boolean)
    const remove = (req.body?.remove || []).map(Number).filter(Boolean)
    if (!add.length && !remove.length) return res.status(400).json({ error: 'Nothing to change' })
    const cust = await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers/${id}`)
    const cur = new Set((cust?.tagTypeIds || []).map(Number))
    add.forEach(t => cur.add(t))
    remove.forEach(t => cur.delete(t))
    const updated = await stPatch(`/crm/v2/tenant/${ST_TENANT_ID}/customers/${id}`, { tagTypeIds: [...cur] })
    const map = await getTagTypes().catch(() => new Map())
    const tags = (updated?.tagTypeIds || [...cur]).map(tid => {
      const t = map.get(Number(tid))
      return t ? { id: Number(tid), ...t } : null
    }).filter(Boolean)
    res.json({ ok: true, tags })
  } catch (err) {
    console.error('ST tag update error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

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

    // Customer tags + the 5 freshest notes across the customer AND their
    // primary location (Andi's own booking notes land on the location).
    let tags = [], notes = []
    try {
      const [tagTypes, custNotes, locData] = await Promise.all([
        getTagTypes().catch(() => new Map()),
        stGet(`/crm/v2/tenant/${ST_TENANT_ID}/customers/${id}/notes?pageSize=10`).catch(() => null),
        stGet(`/crm/v2/tenant/${ST_TENANT_ID}/locations?customerId=${id}&pageSize=1`).catch(() => null),
      ])
      const locId = locData?.data?.[0]?.id
      const locNotes = locId
        ? await stGet(`/crm/v2/tenant/${ST_TENANT_ID}/locations/${locId}/notes?pageSize=10`).catch(() => null)
        : null
      tags = (customer?.tagTypeIds || []).map(tid => {
        const t = tagTypes.get(tid)
        return t ? { id: tid, ...t } : null
      }).filter(Boolean)
      notes = [...(custNotes?.data || []), ...(locNotes?.data || [])]
        .filter(n => n?.text)
        .sort((a, b) => Date.parse(b.createdOn || 0) - Date.parse(a.createdOn || 0))
        .slice(0, 5)
        .map(n => ({ text: stripHtml(String(n.text)).trim().slice(0, 600), createdOn: n.createdOn || null }))
    } catch (e) { console.warn('ST customer tags/notes:', e.message) }

    res.json({ ...customer, email, membership, tags, notes })
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

    // ST's capacity API speaks DENVER WALL TIME with a fake Z suffix (its slot
    // starts like 16:00:00Z mean 4 PM Denver — verified against the ST UI).
    // Anchoring the request at true-UTC "now" therefore asked for availability
    // starting SIX HOURS in the future: today's mid-day windows vanished and
    // the rest showed slivers ("0.28 open" = minutes left after the phantom
    // anchor). Convert the anchor instants to Denver wall time first.
    const denverWallISO = (d) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Denver', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(d).map(x => [x.type, x.value]))
      return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}Z`
    }
    const body = {
      startsOnOrAfter: denverWallISO(from ? new Date(from) : new Date()),
      endsOnOrBefore: denverWallISO(to ? new Date(to) : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)),
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

      // INSERT, not upsert: st_job_id's guard is a PARTIAL unique index,
      // which Postgres refuses as an ON CONFLICT arbiter (42P10) — the
      // upsert version threw on the FIRST completed job of every run and
      // aborted the whole sync, so no job payout ever landed. The index
      // still enforces no-double-pay; a duplicate insert just means another
      // replica (or an earlier run) already paid it — settle and move on.
      const { error: upErr } = await supabase.from('commissions').insert({
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
      })
      if (upErr && upErr.code !== '23505' && !/duplicate key/i.test(upErr.message)) {
        // One poisoned row must not starve every other rep's payout.
        console.error(`Commission insert failed for job ${job.id}: ${upErr.message}`)
        continue
      }

      await supabase.from('andi_bookings')
        .update({ job_status: 'Completed', commission_synced_at: new Date().toISOString() })
        .eq('st_job_id', job.id)
      paid++
    }
  }

  // ── Clawback pass: a job that PAID and is later canceled in ST reverses.
  // Paid bookings stay under watch for 14 days after settlement (covers a
  // bi-weekly pay cycle). A reversal is a NEGATIVE row — the original stays,
  // so pay history never silently rewrites — with st_job_id null because the
  // no-double-pay unique index owns that id; linkage lives in job_number.
  // The booking flips to job_status 'Reversed' so it can't reverse twice.
  let reversed = 0
  const watchSince = new Date(Date.now() - 14 * 864e5).toISOString()
  const { data: paidRows } = await supabase.from('andi_bookings').select('*')
    .eq('job_status', 'Completed').not('commission_synced_at', 'is', null)
    .gte('commission_synced_at', watchSince).limit(500)
  for (const batch of chunk((paidRows || []).filter(b => b.st_job_id), 50)) {
    let jobs = []
    try {
      const ids = batch.map(b => b.st_job_id).join(',')
      jobs = (await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs?ids=${ids}&pageSize=50`))?.data || []
    } catch (e) { console.warn('clawback job fetch:', e.message); continue }
    for (const job of jobs) {
      if (job.jobStatus !== 'Canceled') continue
      try {
        const { data: orig } = await supabase.from('commissions').select('*')
          .eq('st_job_id', job.id).eq('event_type', 'booking').maybeSingle()
        if (!orig || !(Number(orig.amount) > 0)) {
          await supabase.from('andi_bookings').update({ job_status: 'Reversed' }).eq('st_job_id', job.id)
          continue
        }
        // Crash safety: if the reversal row landed but the flag write didn't,
        // the next run must not reverse again.
        const { data: dupe } = await supabase.from('commissions').select('id')
          .eq('event_type', 'reversal').eq('profile_id', orig.profile_id)
          .eq('job_number', orig.job_number || String(job.jobNumber || '')).limit(1)
        if (!dupe?.length) {
          const { error: revErr } = await supabase.from('commissions').insert({
            profile_id: orig.profile_id,
            rep_name: orig.rep_name,
            event_type: 'reversal',
            amount: -Math.abs(Number(orig.amount)),
            contact_name: orig.contact_name,
            st_job_id: null,
            st_job_type_id: orig.st_job_type_id,
            st_customer_id: orig.st_customer_id,
            job_number: orig.job_number || String(job.jobNumber || '') || null,
            notes: `Reversed — job ${orig.job_number || job.id} canceled in ServiceTitan after payout`,
            // Lands in the CURRENT pay period, where the correction belongs.
            earned_at: new Date().toISOString(),
            also_membership: false,
            membership_amount: 0,
            synced_at: new Date().toISOString(),
          })
          if (revErr) { console.error(`clawback insert job ${job.id}: ${revErr.message}`); continue }
        }
        await supabase.from('andi_bookings').update({ job_status: 'Reversed' }).eq('st_job_id', job.id)
        reversed++
        console.log(`Commission reversed: job ${orig.job_number || job.id} (-$${Math.abs(Number(orig.amount))}) for ${orig.rep_name}`)
      } catch (e) { console.error(`clawback job ${job.id}: ${e.message}`) }
    }
  }
  return { checked, paid, canceled, reversed }
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

      // Same 42P10 trap as job payouts: st_membership_id's unique index is
      // partial, so INSERT and treat a duplicate as already-paid.
      const { error: upErr } = await supabase.from('commissions').insert({
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
      })
      if (upErr) {
        if (upErr.code !== '23505' && !/duplicate key/i.test(upErr.message)) {
          console.error(`Commission insert failed for membership ${m.id}: ${upErr.message}`)
          continue
        }
      } else {
        paid++
      }
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
    const { customerId, contactId, jobTypeId, businessUnitId, notes, repName, contactName, phone, zip, start, end, campaignId, andiRec } = req.body
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
      // The book-time recommendation travels ON the job so dispatch sees it
      // in ST and the Live Board can flag pick-vs-assignment mismatches.
      summary: `${notes || `Booked via Andi — ${repName || 'CSR'}`}${andiRec ? `\n\n${andiRec}` : ''}`,
      body: `${notes || `Booked via Andi — ${repName || 'CSR'}`}${andiRec ? `\n\n${andiRec}` : ''}`,
      tagTypeIds: [],
    }

    // If a specific slot was selected, schedule it with an appointment.
    // The availability endpoint hands the browser BARE Denver times with no
    // offset ("2026-07-21T16:00:00"). new Date() parses those in the SERVER's
    // zone — UTC on Railway — which booked Brittany's 4-8 PM window as
    // 16:00Z = 10 AM Denver (job #34734, Deanna Taylor). Convert explicitly
    // from America/Denver; strings that already carry an offset are trusted.
    if (start && end) {
      const denverWallOffset = (utcMs) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Denver', hour12: false,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(new Date(utcMs)).map(x => [x.type, x.value]))
        return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - utcMs
      }
      const toUTC = (localISO) => {
        const s = String(localISO || '')
        if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).toISOString()
        const asIfUTC = Date.parse(s + 'Z')            // pin the wall time, then shift
        return new Date(asIfUTC - denverWallOffset(asIfUTC)).toISOString()
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
      text: `${repName || 'CSR'} (via Andi) booked: ${notes || 'call booking'}`,
      pinToTop: false,
    }).catch(e => console.warn('Note post failed:', e.message))

    // The call notes carry "Can Go Early: Yes" (the live transcription asks).
    // Remember it per job — dispatch treats those customers as flexible, and
    // the board AI may only propose window changes on flagged jobs.
    if (jobId && /can\s*go\s*early\s*[:\-]?\s*yes/i.test(notes || '')) {
      try {
        const { data: geRow } = await supabase.from('app_settings').select('value').eq('key', 'can_go_early_jobs').maybeSingle()
        let ge = {}
        try { ge = JSON.parse(geRow?.value || '{}') } catch {}
        for (const [jid, d] of Object.entries(ge)) if (Date.parse(d) < Date.now() - 14 * 864e5) delete ge[jid]
        ge[String(jobId)] = new Date().toISOString()
        await supabase.from('app_settings').upsert({ key: 'can_go_early_jobs', value: JSON.stringify(ge) }, { onConflict: 'key' })
      } catch (e) { console.warn('can-go-early save:', e.message) }
    }

    // Record attribution for the commission engine (best-effort; never blocks booking)
    try {
      if (jobId) {
        let profileId = null
        if (repName) {
          const { data: prof } = await supabase.from('profiles').select('id').eq('name', repName).maybeSingle()
          profileId = prof?.id || null
        }
        const bookingRow = {
          st_job_id: jobId,
          profile_id: profileId,
          csr_name: repName || null,
          customer_name: contactName || null,
          st_job_type_id: jobTypeId || null,
          booked_at: new Date().toISOString(),
        }
        // contact_id/st_job_number are newer columns — if that migration
        // hasn't run yet, retry without them: attribution (= the rep's pay)
        // must never be lost to a linkage nicety.
        const { error: bkErr } = await supabase.from('andi_bookings').upsert({
          ...bookingRow,
          st_job_number: jobNumber ? String(jobNumber) : null,
          contact_id: contactId || null,
        }, { onConflict: 'st_job_id' })
        if (bkErr) await supabase.from('andi_bookings').upsert(bookingRow, { onConflict: 'st_job_id' })

        // Link the booking back onto the call recording. saveRecording links
        // forward (booking-then-hangup), but wrap-up bookings land AFTER the
        // recording row exists — backfill the most recent unlinked recording
        // for this contact.
        if (contactId) {
          try {
            const { data: recRows } = await supabase.from('call_recordings')
              .select('id').eq('contact_id', contactId).is('st_job_id', null)
              .gte('call_started_at', new Date(Date.now() - 4 * 3600_000).toISOString())
              .order('call_started_at', { ascending: false }).limit(1)
            if (recRows?.length) {
              await supabase.from('call_recordings')
                .update({ st_job_id: jobId, st_job_number: jobNumber ? String(jobNumber) : null })
                .eq('id', recRows[0].id)
            }
          } catch (e) { console.warn('recording booking link:', e.message) }
        }
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
    await supabase.from('andi_membership_sales').insert(audit).then(() => {}, () => {})
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
    .from('profiles').select('id, name, role, active').eq('id', user.id).maybeSingle()
  if (prof?.role !== 'admin' || prof?.active === false) {
    res.status(403).json({ error: 'Admins only' }); return null
  }
  return prof
}

// Any signed-in ACTIVE user — the gate for self-service routes (PTO etc.).
async function requireUser(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) { res.status(401).json({ error: 'Not signed in' }); return null }
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) { res.status(401).json({ error: 'Invalid session' }); return null }
  const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
  if (!prof || prof.active === false) { res.status(403).json({ error: 'No active profile' }); return null }
  return prof
}

// Dispatch surfaces admit admins AND the dispatcher role. Everything else
// admin-gated stays admin-only — dispatcher is "rep plus the Dispatch tab".
async function requireDispatch(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) { res.status(401).json({ error: 'Not signed in' }); return null }
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) { res.status(401).json({ error: 'Invalid session' }); return null }
  const { data: prof } = await supabase
    .from('profiles').select('id, role, active').eq('id', user.id).maybeSingle()
  if (!['admin', 'dispatcher'].includes(prof?.role) || prof?.active === false) {
    res.status(403).json({ error: 'Admins or dispatchers only' }); return null
  }
  return prof
}

// Ban for ~100 years. Supabase has no "ban forever", so this is the idiom.
const FOREVER = '876000h'

const esc2 = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ── PTO / sick requests ─────────────────────────────────────────────────────
// CSR submits from My Page; the manager on their profile gets an email and a
// red-dot badge, decides from their own My Page, and an approval writes the
// day(s) straight onto the WFM schedule (schedules.day_type pto/sick).
const dateRangeDays = (start, end) => {
  const out = []
  const d0 = new Date(`${start}T12:00:00`)
  const d1 = new Date(`${end || start}T12:00:00`)
  for (let d = d0; d <= d1 && out.length < 30; d.setDate(d.getDate() + 1)) out.push(d.toISOString().slice(0, 10))
  return out
}

app.post('/api/pto/request', async (req, res) => {
  const me = await requireUser(req, res)
  if (!me) return
  try {
    const { date, endDate, kind, reason } = req.body || {}
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return res.status(400).json({ error: 'Pick a date' })
    const k = kind === 'sick' ? 'sick' : 'pto'
    if (!me.manager_id) return res.status(400).json({ error: 'No manager is set on your profile yet — ask an admin to assign one in Settings → Users.' })
    const { data: row, error } = await supabase.from('pto_requests').insert({
      profile_id: me.id, manager_id: me.manager_id,
      date, end_date: endDate && endDate !== date ? endDate : null,
      kind: k, reason: String(reason || '').slice(0, 500),
    }).select().single()
    if (error) throw new Error(error.message)
    // Email the manager — best effort, the badge is the reliable channel.
    try {
      const { data: mgr } = await supabase.from('profiles').select('name, email').eq('id', me.manager_id).maybeSingle()
      if (mgr?.email) {
        const who = me.name || me.email
        const span = row.end_date ? `${row.date} → ${row.end_date}` : row.date
        await sendResend({
          to: mgr.email,
          subject: `${who} requested ${k === 'sick' ? 'sick time' : 'PTO'} — ${span}`,
          html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px 20px;color:#111827;">
  <div style="font-size:20px;font-weight:800;color:#ff751f;margin-bottom:10px;">andi</div>
  <p style="font-size:14px;"><b>${esc2(who)}</b> requested <b>${k === 'sick' ? 'sick time' : 'PTO'}</b> for <b>${esc2(span)}</b>.</p>
  ${reason ? `<p style="font-size:13px;color:#374151;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:10px 14px;">"${esc2(reason)}"</p>` : ''}
  <p style="margin:20px 0;"><a href="${appUrl}/mypage?tab=time-off" style="background:#ff751f;color:#fff;text-decoration:none;font-size:13px;font-weight:700;padding:10px 20px;border-radius:8px;">Review in Andi</a></p>
</div>`,
        })
      }
    } catch (e) { console.warn('pto email:', e.message) }
    res.json({ ok: true, request: row })
  } catch (err) {
    console.error('pto request:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Cancel / remove a request. The requester can cancel their own (pending or
// upcoming approved — plans change); the manager or an admin can remove any.
// An approved cancellation CLEARS the schedule day(s) back to unscheduled —
// the original shift times were overwritten at approval and can't be
// restored, so WFM re-adds the shift if they're actually working.
app.post('/api/pto/cancel', async (req, res) => {
  const me = await requireUser(req, res)
  if (!me) return
  try {
    const { id } = req.body || {}
    const { data: row } = await supabase.from('pto_requests').select('*').eq('id', id).maybeSingle()
    if (!row) return res.status(404).json({ error: 'Request not found' })
    const isRequester = row.profile_id === me.id
    const isManager = row.manager_id === me.id || me.role === 'admin'
    if (!isRequester && !isManager) return res.status(403).json({ error: 'Not yours to cancel' })
    const lastDay = row.end_date || row.date
    if (row.status === 'approved' && lastDay < new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ error: 'That time off is in the past — history stays' })
    }
    if (row.status === 'approved') {
      for (const d of dateRangeDays(row.date, row.end_date)) {
        await supabase.from('schedules').delete()
          .eq('profile_id', row.profile_id).eq('date', d).eq('day_type', row.kind)
      }
    }
    const { error } = await supabase.from('pto_requests').delete().eq('id', id)
    if (error) throw new Error(error.message)

    // Tell the other side — best effort.
    try {
      const otherId = isRequester ? row.manager_id : row.profile_id
      const { data: other } = otherId
        ? await supabase.from('profiles').select('name, email').eq('id', otherId).maybeSingle()
        : { data: null }
      if (other?.email) {
        const span = row.end_date ? `${row.date} → ${row.end_date}` : row.date
        const who = me.name || me.email
        await sendResend({
          to: other.email,
          subject: isRequester
            ? `${who} canceled their ${row.kind === 'sick' ? 'sick time' : 'PTO'} request — ${span}`
            : `Your ${row.kind === 'sick' ? 'sick time' : 'PTO'} for ${span} was removed`,
          html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px 20px;color:#111827;">
  <div style="font-size:20px;font-weight:800;color:#ff751f;margin-bottom:10px;">andi</div>
  <p style="font-size:14px;">${isRequester
    ? `<b>${esc2(who)}</b> canceled their ${row.kind === 'sick' ? 'sick time' : 'PTO'} request for <b>${esc2(span)}</b>.`
    : `Your ${row.kind === 'sick' ? 'sick time' : 'PTO'} for <b>${esc2(span)}</b> was removed by ${esc2(who)}.`}</p>
  ${row.status === 'approved' ? `<p style="font-size:13px;color:#374151;">The day${row.end_date ? 's were' : ' was'} cleared from the schedule — WFM should re-add the shift if ${isRequester ? 'they are' : 'you are'} working.</p>` : ''}
</div>`,
        })
      }
    } catch (e) { console.warn('pto cancel email:', e.message) }
    res.json({ ok: true })
  } catch (err) {
    console.error('pto cancel:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/pto/decide', async (req, res) => {
  const me = await requireUser(req, res)
  if (!me) return
  try {
    const { id, decision, note } = req.body || {}
    if (!['approved', 'denied'].includes(decision)) return res.status(400).json({ error: 'Decision must be approved or denied' })
    const { data: row } = await supabase.from('pto_requests').select('*').eq('id', id).maybeSingle()
    if (!row) return res.status(404).json({ error: 'Request not found' })
    if (row.status !== 'pending') return res.status(400).json({ error: `Already ${row.status}` })
    if (row.manager_id !== me.id && me.role !== 'admin') return res.status(403).json({ error: "Only this person's manager (or an admin) can decide" })

    const { error } = await supabase.from('pto_requests').update({
      status: decision, decided_by: me.id, decided_at: new Date().toISOString(),
      decision_note: String(note || '').slice(0, 300) || null,
    }).eq('id', id)
    if (error) throw new Error(error.message)

    if (decision === 'approved') {
      // Write the day(s) onto the WFM schedule. An existing work day flips to
      // pto/sick (shift fields cleared); a missing day gets a fresh row.
      for (const d of dateRangeDays(row.date, row.end_date)) {
        const { data: existing } = await supabase.from('schedules')
          .select('id').eq('profile_id', row.profile_id).eq('date', d).maybeSingle()
        // Approved PTO is official, not a draft — publish it immediately.
        if (existing) {
          const upd = {
            day_type: row.kind, shift_start: null, shift_end: null,
            break1_start: null, break1_end: null, break2_start: null, break2_end: null,
            lunch_start: null, lunch_end: null,
          }
          const { error: e1 } = await supabase.from('schedules').update({ ...upd, published_at: new Date().toISOString() }).eq('id', existing.id)
          if (e1) await supabase.from('schedules').update(upd).eq('id', existing.id)
        } else {
          const ins = { profile_id: row.profile_id, date: d, day_type: row.kind, created_by: me.id }
          const { error: e2 } = await supabase.from('schedules').insert({ ...ins, published_at: new Date().toISOString() })
          if (e2) await supabase.from('schedules').insert(ins)
        }
      }
    }

    // Tell the requester — best effort.
    try {
      const { data: reqr } = await supabase.from('profiles').select('name, email').eq('id', row.profile_id).maybeSingle()
      if (reqr?.email) {
        const span = row.end_date ? `${row.date} → ${row.end_date}` : row.date
        await sendResend({
          to: reqr.email,
          subject: `Your ${row.kind === 'sick' ? 'sick time' : 'PTO'} request for ${span} was ${decision}`,
          html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px 20px;color:#111827;">
  <div style="font-size:20px;font-weight:800;color:#ff751f;margin-bottom:10px;">andi</div>
  <p style="font-size:14px;">Your <b>${row.kind === 'sick' ? 'sick time' : 'PTO'}</b> request for <b>${esc2(span)}</b> was
  <b style="color:${decision === 'approved' ? '#16A34A' : '#DC2626'};">${decision}</b> by ${esc2(me.name || me.email)}.</p>
  ${note ? `<p style="font-size:13px;color:#374151;">"${esc2(String(note))}"</p>` : ''}
  ${decision === 'approved' ? '<p style="font-size:13px;color:#374151;">It\'s on the schedule.</p>' : ''}
</div>`,
        })
      }
    } catch (e) { console.warn('pto decision email:', e.message) }
    res.json({ ok: true })
  } catch (err) {
    console.error('pto decide:', err.message)
    res.status(500).json({ error: err.message })
  }
})


// ── Invite a user by email. generateLink creates the auth user immediately
// (the signup trigger writes their profiles row), returns a one-time invite
// link, and we deliver it through Resend — Supabase's own mailer is rate-
// limited and unbranded. The invitee sets name + password on /welcome; the
// `invited` metadata flag (cleared by setup_done) is what routes them there,
// so the flow works even if the Supabase redirect allowlist sends them to
// the app root instead.
// 📣 Floor notification send. The browser can't send these itself: every page
// already holds the 'floor-alerts' subscription (ScheduleAlerts) and Supabase
// won't join the same topic twice on one connection — the client-side send
// hung forever. The server has its own connection, and its broadcast reaches
// the SENDER's screen too, which doubles as the delivery receipt.
async function sendFloorAnnounce(payload) {
  const ch = supabase.channel('floor-alerts')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('realtime timeout')), 8000)
    ch.subscribe(st => {
      if (st === 'SUBSCRIBED') { clearTimeout(timer); resolve() }
      else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') { clearTimeout(timer); reject(new Error(st)) }
    })
  })
  await ch.send({ type: 'broadcast', event: 'announce', payload })
  supabase.removeChannel(ch)
}

const FLOOR_SCHED_KEY = 'floor_scheduled_msgs'
async function loadFloorScheduled() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', FLOOR_SCHED_KEY).maybeSingle()
  try { return JSON.parse(data?.value || '[]') } catch { return [] }
}
async function saveFloorScheduled(list) {
  await supabase.from('app_settings').upsert({ key: FLOOR_SCHED_KEY, value: JSON.stringify(list.slice(0, 50)) }, { onConflict: 'key' })
}

// ═══ ASK ANDI — internal knowledge assistant ═══════════════════════════════
// KB lives in kb_articles (admin-edited, revisioned); every Q&A is logged
// with the article titles it cited, so what the floor is being told is
// auditable and knowledge gaps show up as real questions.
app.get('/api/kb/list', async (req, res) => {
  if (!(await requireUser(req, res))) return
  try {
    const { data } = await supabase.from('kb_articles').select('*').order('category').order('title')
    res.json({ articles: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/kb/save', async (req, res) => {
  const prof = await requireAdmin(req, res)
  if (!prof) return
  try {
    const { id, title, body, category, active, note } = req.body || {}
    if (!String(title || '').trim()) return res.status(400).json({ error: 'Title required' })
    const fields = {
      title: String(title).trim().slice(0, 200),
      body: String(body || '').slice(0, 20000),
      category: String(category || 'general').slice(0, 40),
      active: active !== false,
      updated_by: prof.name || prof.id,
      updated_at: new Date().toISOString(),
      last_reviewed_at: new Date().toISOString(),
    }
    if (id) {
      // Revision first — the ledger of what the assistant was being fed.
      const { data: prev } = await supabase.from('kb_articles').select('*').eq('id', id).maybeSingle()
      if (prev) {
        await supabase.from('kb_revisions').insert({
          article_id: id, title: prev.title, body: prev.body, category: prev.category,
          edited_by: fields.updated_by, note: String(note || '').slice(0, 300) || null,
        })
      }
      const { data, error } = await supabase.from('kb_articles').update(fields).eq('id', id).select().single()
      if (error) throw new Error(error.message)
      return res.json({ article: data })
    }
    const { data, error } = await supabase.from('kb_articles').insert(fields).select().single()
    if (error) throw new Error(error.message)
    res.json({ article: data })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/kb/delete', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    await supabase.from('kb_articles').delete().eq('id', String(req.body?.id || ''))
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/kb/revisions', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const { data } = await supabase.from('kb_revisions').select('*')
      .eq('article_id', String(req.query.articleId || '')).order('edited_at', { ascending: false }).limit(30)
    res.json({ revisions: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// 🌐 Website import: crawl the public site into kb_articles (source=website,
// keyed by URL). Re-imports DIFF: changed pages get a revision + update,
// unchanged pages are left alone — the site never silently rewrites the KB.
const htmlToText = (html) => {
  let t = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
  return t.replace(/\s+/g, ' ').trim()
}

app.post('/api/kb/import-website', async (req, res) => {
  const prof = await requireAdmin(req, res)
  if (!prof) return
  try {
    const rootUrl = String(req.body?.url || 'https://awesomeservice.com').replace(/\/$/, '')
    const host = new URL(rootUrl).host
    const fetchPage = async (u) => {
      const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'AndiKB/1.0 (internal knowledge import)' } })
      if (!r.ok) throw new Error(`${r.status}`)
      return r.text()
    }
    const rootHtml = await fetchPage(rootUrl)
    const links = new Set([rootUrl])
    for (const m of rootHtml.matchAll(/href=["']([^"'#?]+)["']/gi)) {
      let u = m[1]
      try {
        u = new URL(u, rootUrl + '/').toString().replace(/\/$/, '')
        if (new URL(u).host !== host) continue
        if (/\.(pdf|jpg|jpeg|png|gif|svg|css|js|ico|xml|webp|mp4)$/i.test(u)) continue
        links.add(u)
      } catch {}
      if (links.size >= 30) break
    }
    const { data: existing } = await supabase.from('kb_articles').select('id, source_url, body').eq('source', 'website')
    const byUrl = new Map((existing || []).map(a => [a.source_url, a]))
    let added = 0, changed = 0, unchanged = 0, skipped = 0
    const pages = []
    for (const u of links) {
      try {
        const html = u === rootUrl ? rootHtml : await fetchPage(u)
        const title = htmlToText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '') ||
          decodeURIComponent(u.split('/').pop() || 'Home')
        const text = htmlToText(html).slice(0, 12000)
        if (text.length < 250) { skipped++; continue }
        const body = `From ${u}\n\n${text}`
        const prev = byUrl.get(u)
        if (prev) {
          if (prev.body === body) { unchanged++; continue }
          await supabase.from('kb_revisions').insert({
            article_id: prev.id, body: prev.body, edited_by: prof.name || 'website import',
            note: 'Website re-import — page content changed',
          })
          await supabase.from('kb_articles').update({
            body, title: `Website: ${title}`.slice(0, 200),
            updated_by: prof.name || 'website import', updated_at: new Date().toISOString(),
          }).eq('id', prev.id)
          changed++
        } else {
          await supabase.from('kb_articles').insert({
            title: `Website: ${title}`.slice(0, 200), body, category: 'website',
            source: 'website', source_url: u, updated_by: prof.name || 'website import',
          })
          added++
        }
        pages.push(title)
      } catch (e) { skipped++ }
    }
    res.json({ added, changed, unchanged, skipped, pages: pages.slice(0, 30) })
  } catch (err) {
    console.error('website import:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Knowledge gaps: real questions the KB couldn't cover (or answers that got a
// thumbs-down) — the "what to write next" list.
app.get('/api/kb/gaps', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const since = new Date(Date.now() - 30 * 864e5).toISOString()
    const { data } = await supabase.from('assistant_logs')
      .select('id, rep_name, question, covered, helpful, created_at')
      .gte('created_at', since)
      .or('covered.eq.false,helpful.eq.false')
      .order('created_at', { ascending: false }).limit(50)
    res.json({ gaps: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/assistant/ask', async (req, res) => {
  const prof = await requireUser(req, res)
  if (!prof) return
  try {
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'No ANTHROPIC_API_KEY configured' })
    const question = String(req.body?.question || '').trim().slice(0, 1000)
    if (question.length < 2) return res.status(400).json({ error: 'Ask something first' })
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : []

    const [{ data: articles }, { data: scriptRow }] = await Promise.all([
      supabase.from('kb_articles').select('title, category, body, updated_at').eq('active', true),
      supabase.from('app_settings').select('value').eq('key', 'inbound_script').maybeSingle(),
    ])
    let kb = ''
    for (const a of (articles || [])) {
      const chunk = `\n\n## ${a.title} [${a.category}] (updated ${String(a.updated_at).slice(0, 10)})\n${stripHtml(a.body)}`
      if (kb.length + chunk.length > 150_000) break
      kb += chunk
    }
    let script = ''
    try {
      const inb = JSON.parse(scriptRow?.value || '{}')
      if (inb.script) script += `\n\n## Inbound call script [scripts]\n${stripHtml(inb.script)}`
      if (inb.tips) script += `\n\n## Inbound call tips [scripts]\n${stripHtml(inb.tips)}`
    } catch {}

    const sys = `You are Ask Andi, the internal assistant for Awesome Home Services (HVAC, plumbing, electrical, garage doors — Colorado Springs). You help CSRs and dispatchers on live calls: policies, objection handling, what to say, how things work.

Answer from the COMPANY KNOWLEDGE below plus your own call-center and sales expertise, blended seamlessly. Rules:
- Company FACTS (prices, fees, policies, service areas, guarantees) may ONLY come from the knowledge below. If a needed fact isn't covered, say plainly "That's not in the knowledge base" for that part and suggest asking a manager — NEVER guess or invent a policy, price, or promise. Set covered=false ONLY in that case.
- Objection handling and coaching: draw on BOTH the company playbook and proven sales craft (acknowledge, isolate the real concern, reframe value, close soft) in one confident answer — no disclaimers about what the playbook does or doesn't cover. Cite the KB articles you drew from in sources, and set usedCraft=true whenever your general expertise contributed beyond the articles.
- Keep answers tight: a rep is often mid-call. Lead with the answer, no preamble.
- FORMAT for fast reading with light markdown: **bold** lead-ins, hyphen bullets for options, numbered steps for sequences, and word-for-word lines in "quotes" on their own line. Short paragraphs with blank lines between — never a wall of text.

COMPANY KNOWLEDGE:${kb}${script || ''}${!kb && !script ? '\n(The knowledge base is empty so far.)' : ''}`

    const messages = [
      ...history.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
      { role: 'user', content: question },
    ]
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 1200, system: sys,
        tools: [{
          name: 'submit_answer',
          description: 'Submit the answer for the rep',
          input_schema: {
            type: 'object',
            properties: {
              answer: { type: 'string', description: 'The answer in light markdown: **bold**, - bullets, 1. numbered steps, "quoted" word tracks on their own lines, blank lines between short paragraphs.' },
              sources: { type: 'array', items: { type: 'string' }, description: 'Exact titles of knowledge articles used. Empty if none.' },
              covered: { type: 'boolean', description: 'false ONLY if a needed company fact was missing from the knowledge base' },
              usedCraft: { type: 'boolean', description: 'true if general sales/call-center expertise contributed beyond the articles' },
            },
            required: ['answer', 'sources', 'covered', 'usedCraft'],
          },
        }],
        tool_choice: { type: 'tool', name: 'submit_answer' },
        messages,
      }),
    })
    if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 160)}`)
    const out = ((await r.json()).content || []).find(b => b.type === 'tool_use')?.input
    if (!out?.answer) throw new Error('No answer came back — try again')

    let logId = null
    try {
      const { data: logRow } = await supabase.from('assistant_logs').insert({
        profile_id: prof.id, rep_name: prof.name || null,
        question, answer: String(out.answer).slice(0, 8000),
        sources: (out.sources || []).slice(0, 10), covered: out.covered !== false,
      }).select('id').single()
      logId = logRow?.id ?? null
    } catch (e) { console.warn('assistant log:', e.message) }

    res.json({ answer: out.answer, sources: out.sources || [], covered: out.covered !== false, usedCraft: Boolean(out.usedCraft), logId })
  } catch (err) {
    console.error('assistant ask:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/assistant/feedback', async (req, res) => {
  if (!(await requireUser(req, res))) return
  try {
    const { logId, helpful } = req.body || {}
    if (logId == null) return res.status(400).json({ error: 'logId required' })
    await supabase.from('assistant_logs').update({ helpful: Boolean(helpful) }).eq('id', logId)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/admin/notify-floor', async (req, res) => {
  const prof = await requireAdmin(req, res)
  if (!prof) return
  try {
    const message = String(req.body?.message || '').trim().slice(0, 300)
    if (!message) return res.status(400).json({ error: 'Message required' })
    const to = req.body?.to === 'all' ? 'all'
      : Array.isArray(req.body?.to) ? req.body.to.filter(Boolean).slice(0, 100) : []
    if (to !== 'all' && !to.length) return res.status(400).json({ error: 'Pick at least one person' })
    const payload = {
      to, fromId: prof.id,
      from: String(req.body?.from || 'Admin').slice(0, 80),
      toNames: String(req.body?.toNames || '').slice(0, 200),
      message,
    }
    const sendAt = req.body?.sendAt ? Date.parse(req.body.sendAt) : null
    if (sendAt && sendAt > Date.now() + 60_000) {
      // Scheduled: persisted, a 60s sweep sends it — survives deploys.
      const list = await loadFloorScheduled()
      const id = `fs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      list.push({ id, ...payload, sendAt: new Date(sendAt).toISOString(), createdAt: new Date().toISOString() })
      await saveFloorScheduled(list)
      return res.json({ ok: true, scheduled: true, id })
    }
    await sendFloorAnnounce(payload)
    res.json({ ok: true })
  } catch (err) {
    console.error('notify-floor:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/admin/notify-floor/scheduled', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const list = await loadFloorScheduled()
    res.json({ items: list.filter(x => Date.parse(x.sendAt) > Date.now()).sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt)) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/admin/notify-floor/unschedule', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const id = String(req.body?.id || '')
    const list = await loadFloorScheduled()
    await saveFloorScheduled(list.filter(x => x.id !== id))
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/admin/user/invite', async (req, res) => {
  const admin = await requireAdmin(req, res)
  if (!admin) return
  const email = String(req.body?.email || '').trim().toLowerCase()
  const role = ['admin', 'dispatcher'].includes(req.body?.role) ? req.body.role : 'rep'
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' })
  }
  try {
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'invite',
      email,
      options: {
        data: { invited: true },
        redirectTo: `${appUrl}/welcome`,
      },
    })
    if (error) {
      const msg = /already|registered|exist/i.test(error.message)
        ? 'That email already has an account. If they were removed, use Restore instead.'
        : error.message
      return res.status(400).json({ error: msg })
    }
    const link = data?.properties?.action_link
    if (!link) return res.status(500).json({ error: 'Supabase returned no invite link' })
    if (data?.user?.id && role !== 'rep') {
      try { await supabase.from('profiles').update({ role }).eq('id', data.user.id) }
      catch (e) { console.warn('invite role set:', e.message) }
    }
    let emailed = false, emailError = null
    try {
      await sendResend({
        to: email,
        subject: "You're invited to Andi — Awesome Home Services",
        html: `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 20px;color:#111827;">
  <div style="font-size:22px;font-weight:800;color:#ff751f;margin-bottom:4px;">andi</div>
  <div style="font-size:15px;font-weight:700;margin-bottom:12px;">You've been invited to join the Awesome Home Services team on Andi.</div>
  <p style="font-size:13px;color:#374151;line-height:1.5;">Click below to accept the invite and set up your account — you'll pick your own password.</p>
  <p style="margin:22px 0;">
    <a href="${link}" style="background:#ff751f;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:11px 22px;border-radius:8px;display:inline-block;">Accept invite &amp; create account</a>
  </p>
  <p style="font-size:11px;color:#9CA3AF;line-height:1.5;">This link is for ${esc2(email)} and expires in 24 hours. If it expires, ask your admin to send a new one. If you weren't expecting this, you can ignore it.</p>
</div>`,
      })
      emailed = true
    } catch (e) {
      emailError = e.message
      console.warn('invite email failed:', e.message)
    }
    // If Resend failed the invite still exists — hand the admin the link so
    // they can deliver it themselves rather than dead-ending.
    res.json({ ok: true, emailed, ...(emailed ? {} : { link, emailError }) })
  } catch (e) {
    console.error('invite error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

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
      interaction_type: null,
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
  // A SERVICE-typed appointment stretched past this many hours is an install
  // in disguise (job 35317: "Plumbing - Repair", 6h pressure-tank replacement,
  // install only mentioned in the notes). It still counts as one booked call —
  // but the hours beyond one standard call's worth come off the tech's
  // capacity. Admin-tunable via app_settings 'board_long_call_hours'.
  const { data: longThRow } = await supabase.from('app_settings').select('value').eq('key', 'board_long_call_hours').maybeSingle()
  const LONG_CALL_HOURS = Number(String(longThRow?.value ?? '').replace(/"/g, '')) || 5

  // Jobs per day (one ST call per day). Keep the fields the board + drill-down need.
  const jobsByDayRaw = await Promise.all(days.map(d =>
    stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs?appointmentStartsOnOrAfter=${d.startUtc.toISOString()}&appointmentStartsBefore=${d.endUtc.toISOString()}&pageSize=500`)
      .then(r => r?.data || []).catch(() => [])
  ))

  // CANCELED calls must come OFF the board. The jobs query above matches on
  // appointment dates with no status filter, so a canceled job — or a live
  // job whose appointment that day was canceled/rescheduled — kept counting.
  // Two layers: drop Canceled jobs outright, and require a non-canceled
  // appointment actually ON that day (one paged appointments fetch covers all
  // three days). If the appointment fetch fails we fall back to job status
  // alone rather than blanking the board.
  let liveApptJobs = null
  // Earliest live appointment start per job per day — lets today's "needed"
  // decay with the clock (a call already run isn't remaining demand).
  let apptStartByJobDay = null
  try {
    const horizon = days[days.length - 1].endUtc.getTime()
    const allAppts = (await stPageAll(p => `/jpm/v2/tenant/${ST_TENANT_ID}/appointments?startsOnOrAfter=${days[0].startUtc.toISOString()}&pageSize=500&page=${p}`, 6000))
      .filter(a => { const t = Date.parse(a.start || ''); return !Number.isNaN(t) && t < horizon })
    liveApptJobs = days.map(() => new Set())
    apptStartByJobDay = days.map(() => new Map())
    days.forEach((d, di) => {
      for (const a of allAppts) {
        const t = Date.parse(a.start || '')
        if (a.status !== 'Canceled' && a.jobId && t >= d.startUtc.getTime() && t < d.endUtc.getTime()) {
          liveApptJobs[di].add(a.jobId)
          const prev = apptStartByJobDay[di].get(a.jobId)
          if (prev == null || t < prev) apptStartByJobDay[di].set(a.jobId, t)
        }
      }
    })
  } catch (e) { console.warn('board live appointments:', e.message) }
  const jobsByDay = jobsByDayRaw.map((jobs, di) => jobs.filter(j =>
    j.jobStatus !== 'Canceled' && (!liveApptJobs || liveApptJobs[di].has(j.id))))

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
  // Callbacks / permits / follow-ups / phone calls are excluded from the BOOKED
  // count as non-productive — but they still eat the tech's clock. Leaving them
  // out of capacity was asymmetric: Jason Tse's callback block read as "room
  // for 2 more" while his morning was physically spoken for.
  let excludedHours = {}   // `${techId}|${dayIndex}` → hours
  let longCallHours = {}   // `${techId}|${dayIndex}` → hours on marathon service jobs
  try {
    // ST returns appointments in DESCENDING start order, so one 500 page is
    // the far-future book, not the board window — today's appointments fell
    // off the end and consumption silently under-sampled (job 35317's 6h
    // repair never made the page). Page it all; the forward book is only a
    // few hundred rows (verified 601 on Jul 30).
    const apptRaw = await stPageAll(p => `/jpm/v2/tenant/${ST_TENANT_ID}/appointments?startsOnOrAfter=${apptLookback.toISOString()}&pageSize=500&page=${p}`, 6000)
    const appts = apptRaw.filter(a => a.start && a.end && a.active !== false && a.status !== 'Canceled')

    // Only appointments that actually overlap a board day are worth resolving.
    const relevant = appts.filter(a => {
      const s = new Date(a.start), e = new Date(a.end)
      return days.some(d => s < d.endUtc && e > d.startUtc)
    })

    // jobId → business unit + type, so we can tell install work and
    // non-productive call types from countable service work.
    const jobBU = {}, jobTypeOf = {}
    jobsByDayRaw.flat().forEach(j => { jobBU[j.id] = j.businessUnitId; jobTypeOf[j.id] = j.jobTypeId })
    const missing = [...new Set(relevant.map(a => a.jobId).filter(id => id && jobBU[id] === undefined))]
    for (let i = 0; i < missing.length; i += 50) {
      try {
        const r = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs?ids=${missing.slice(i, i + 50).join(',')}&pageSize=50`)
        ;(r?.data || []).forEach(j => { jobBU[j.id] = j.businessUnitId; jobTypeOf[j.id] = j.jobTypeId })
      } catch (e) { console.warn('board install jobs:', e.message) }
    }

    const installBUIds = new Set(Object.values(installBU))
    const byId = {}
    for (const a of relevant) {
      const durH = (new Date(a.end) - new Date(a.start)) / 3600e3
      if (installBUIds.has(jobBU[a.jobId])) byId[a.id] = { a, bucket: installHours }
      else if (EXCLUDE_CALL.test(nameByType[String(jobTypeOf[a.jobId])] || '')) byId[a.id] = { a, bucket: excludedHours }
      else if (durH >= LONG_CALL_HOURS) byId[a.id] = { a, bucket: longCallHours }
    }
    const ids = Object.keys(byId)
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const r = await stGet(`/dispatch/v2/tenant/${ST_TENANT_ID}/appointment-assignments?appointmentIds=${ids.slice(i, i + 50).join(',')}&pageSize=200`)
        for (const asg of (r?.data || [])) {
          if (asg.active === false) continue
          const hit = byId[asg.appointmentId]; if (!hit) continue
          days.forEach((d, di) => {
            const h = overlapHours({ start: new Date(hit.a.start), end: new Date(hit.a.end) }, d)
            if (h > 0) {
              const k = `${asg.technicianId}|${di}`
              hit.bucket[k] = (hit.bucket[k] || 0) + h
            }
          })
        }
      } catch (e) { console.warn('board assignments:', e.message) }
    }
  } catch (e) {
    // Degrade to the old head count rather than failing the whole board — but
    // shout about it. This catch once hid a ReferenceError of mine and the
    // board just quietly kept over-reporting capacity, which is worse than a
    // visible failure.
    console.error('BOARD: install-consumption lookup FAILED, capacity will be overstated:', e.stack || e.message)
    installHours = {}
    excludedHours = {}
    longCallHours = {}
  }
  console.log(`BOARD: consumption computed — ${Object.keys(installHours).length} install tech-days, ${Object.keys(excludedHours).length} excluded-call tech-days, ${Object.keys(longCallHours).length} long-call tech-days`)

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
  // The NOTES can also disqualify: job #34454 was a normal-looking No Cool whose
  // summary said "Coll $: warranty" — a booked call, but nothing to collect.
  const isOpportunity = (j) => {
    const cat = catByType[String(j.jobTypeId)]
    const trade = buMap[j.businessUnitId]?.trade
    const role = buMap[j.businessUnitId]?.role
    if (role === 'install' || cat === 'non_commissionable' || !isCountedCall(j)) return false
    if (noCollectFromNotes(j)) return false
    if (cat === 'maintenance') return trade === 'HVAC' && oldSystemLocs.has(j.locationId)
    return true
  }
  // id is carried alongside jobNumber because ServiceTitan deep links key on
  // the internal id (#/Job/Index/{id}), not the human-facing job number.
  // `note` marks a call the notes disqualified, so the booked-calls drill-down
  // can show WHY it isn't in the opportunity count.
  const jobRow = (j) => ({
    id: j.id, jobNumber: j.jobNumber, type: nameByType[String(j.jobTypeId)] || 'Job',
    note: noCollectFromNotes(j) ? 'warranty/no-collect' : undefined,
  })

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
      let techsAvailRemaining = 0   // today only: the fraction of capacity still AHEAD of the clock
      const nowMs = Date.now()
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
        // Non-productive call types (callback/permit/follow-up/phone call) are
        // excluded from the booked count, so they must ALSO come off capacity —
        // no threshold: every hour on a callback is an hour nobody can book.
        const excH = Math.min(excludedHours[`${techId}|${di}`] || 0, Math.max(0, workH - offH - insH))
        // Marathon service job: it stays booked as ONE call, so only its hours
        // BEYOND one standard call's worth (shift ÷ calls-per-tech) consume
        // capacity — Clay on a 6h "repair" with a tank install in the notes is
        // half a tech, not a full one.
        const rawLongH = Math.min(longCallHours[`${techId}|${di}`] || 0, Math.max(0, workH - offH - insH - excH))
        const longEx = Math.max(0, rawLongH - workH / cpt(trade))
        const avail = Math.max(0, Math.min((workH - offH - insH - excH - longEx) / workH, 1))
        techsAvail += avail
        if (di === 0) {
          // Productive hours that are still ahead of the clock, against the
          // FULL shift — calls-per-tech is a whole-day rate, so half a day
          // left means half the tech's calls left.
          const dayRem = { startUtc: new Date(Math.max(nowMs, day.startUtc.getTime())), endUtc: day.endUtc }
          const workRemH = my.filter(s => s.type !== 'TimeOff').reduce((a, s) => a + overlapHours(s, dayRem), 0)
          const productiveH = Math.max(0, workH - offH - insH - excH - longEx)
          techsAvailRemaining += Math.min(productiveH, workRemH) / workH
        }
        techList.push({
          name: techName(techId),
          off: avail >= 1 ? null
            : avail <= 0 ? (insH > 0 ? 'on install' : excH > 0 ? 'on callbacks/permits' : longEx > 0 ? 'on a long job' : 'off')
            : `${Math.round(avail * 100)}%${insH > 0 ? ' (install)' : excH > 0 ? ' (callbacks/permits)' : longEx > 0 ? ' (long job)' : ''}`,
        })
      }
      techsAvail = Math.round(techsAvail * 10) / 10

      // Booked calls exclude follow-up / callback / permitting / phone-call types.
      const svcJobs = jobs.filter(j => j.businessUnitId === svc && isCountedCall(j))
      const oppJobs = jobs.filter(j => buMap[j.businessUnitId]?.trade === trade && isOpportunity(j))
      const installJobs = jobs.filter(j => j.businessUnitId === ins)

      const capacity = Math.round(techsAvail * cpt(trade) * 10) / 10
      const pct = capacity > 0 ? svcJobs.length / capacity : (svcJobs.length > 0 ? 1 : 0)
      let needed = Math.max(0, Math.round(capacity - svcJobs.length))
      // FULL is not CLOSED. When the board is (or becomes) completely filled,
      // the flag flips to Opportunity Watch: keep booking high-value calls —
      // dispatch makes room by moving low-value ones. Full means the ROUNDED
      // calls-needed hits zero — fractional capacity (3.8 techs → 15.2 slots)
      // left a dead zone where the board said '0 needed' and 'at target'
      // without flipping the watch (Electrical at 15/15.2).
      let oppWatch = capacity > 0 && needed <= 0
      if (di === 0) {
        // Today's "needed" respects the clock: only capacity still ahead of
        // now can be filled, and only calls still ahead of now occupy it. At
        // 11am the morning windows are history — ST's Check Availability and
        // this number should agree by mid-day.
        const capRem = techsAvailRemaining * cpt(trade)
        const bookedRem = svcJobs.filter(j => {
          const t = apptStartByJobDay?.[0]?.get(j.id)
          return t != null && t >= nowMs
        }).length
        needed = Math.min(needed, Math.max(0, Math.round(capRem - bookedRem)))
        // Watch flips mid-day when what's left is spoken for — but a quiet
        // evening (no capacity left at all) is just the day ending, not a
        // full board.
        if (capRem >= 0.5 && bookedRem >= capRem) oppWatch = true
      }
      // Target is 80%: green at/over, amber climbing, red well below.
      const status = capacity === 0 ? 'none' : pct >= 0.8 ? 'good' : pct >= 0.6 ? 'warn' : 'under'
      return {
        date: day.date, techs: techsAvail, calls: svcJobs.length, capacity,
        pct: Math.round(pct * 100), needed, oppWatch, opps: oppJobs.length, installs: installJobs.length, status,
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

// ── Weather ─────────────────────────────────────────────────────────────────
// National Weather Service — free, no key, and it publishes the official
// alerts (heat advisories, winter storms) for our counties. The server owns
// the fetch and caches 15 minutes; the browser only ever talks to Andi.
// Weather is also a demand signal: hot days are no-cool calls, cold snaps
// are no-heats and burst pipes — the same data feeds the board analyst.
const WEATHER_CITIES = [
  { key: 'COS', name: 'Colorado Springs', lat: 38.8339, lng: -104.8214 },
  { key: 'Pueblo', name: 'Pueblo', lat: 38.2544, lng: -104.6091 },
  { key: 'Castle Rock', name: 'Castle Rock', lat: 39.3722, lng: -104.8561 },
]
const _wxGrid = new Map()   // "lat,lng" → forecast URLs (never change; cached forever)
let _wxCache = null
async function nwsGet(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'andi-dialer (andi@awesomeservice.com)', Accept: 'application/geo+json' },
    signal: AbortSignal.timeout(15000),
  })
  if (!r.ok) throw new Error(`NWS ${r.status}`)
  return r.json()
}
const wxIcon = (s) => {
  const t = String(s || '').toLowerCase()
  if (/thunder|storm/.test(t)) return 'storm'
  if (/snow|sleet|ice|wintry|blizzard/.test(t)) return 'snow'
  if (/rain|shower|drizzle/.test(t)) return 'rain'
  if (/fog|haze|smoke/.test(t)) return 'fog'
  if (/mostly cloudy|overcast/.test(t)) return 'cloud'
  if (/partly|mostly sunny/.test(t)) return 'partcloud'
  return 'sun'
}
async function computeWeather() {
  // Locations are admin-configurable (Settings → Thresholds). Bad or empty
  // config falls back to the built-in three.
  let cityList = WEATHER_CITIES
  try {
    const { data: locRow } = await supabase.from('app_settings').select('value').eq('key', 'weather_locations').maybeSingle()
    const parsed = JSON.parse(locRow?.value || 'null')
    if (Array.isArray(parsed)) {
      const good = parsed.filter(l => l?.key && Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng)))
        .map(l => ({ key: String(l.key), name: String(l.name || l.key), lat: Number(l.lat), lng: Number(l.lng) }))
      if (good.length) cityList = good.slice(0, 5)
    }
  } catch {}
  const cities = await Promise.all(cityList.map(async (c) => {
    const gk = `${c.lat},${c.lng}`
    if (!_wxGrid.has(gk)) {
      const p = await nwsGet(`https://api.weather.gov/points/${c.lat},${c.lng}`)
      _wxGrid.set(gk, { forecast: p?.properties?.forecast, hourly: p?.properties?.forecastHourly })
    }
    const g = _wxGrid.get(gk)
    const [fc, hr, al] = await Promise.all([
      nwsGet(g.forecast),
      nwsGet(g.hourly).catch(() => null),
      nwsGet(`https://api.weather.gov/alerts/active?point=${c.lat},${c.lng}`).catch(() => null),
    ])
    const periods = fc?.properties?.periods || []
    const high = periods.find(p => p.isDaytime)?.temperature ?? null
    const low = periods.find(p => !p.isDaytime)?.temperature ?? null
    const nowP = (hr?.properties?.periods || [])[0] || {}
    // Air Quality Alerts run near-daily in CO summers — wallpaper, not signal.
    const alerts = (al?.features || []).map(f => f.properties)
      .filter(a => a?.event && !/air quality/i.test(a.event))
    return {
      key: c.key, name: c.name,
      temp: nowP.temperature ?? high, short: nowP.shortForecast || '',
      icon: wxIcon(nowP.shortForecast), high, low, alerts,
    }
  }))
  // One chip: the most severe active alert across the three counties.
  const sevRank = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 }
  let best = null
  for (const c of cities) for (const a of (c.alerts || [])) {
    const rank = sevRank[a.severity] || 0
    if (!best || rank > best.rank) best = { rank, a }
  }
  let alert = null
  if (best) {
    const end = Date.parse(best.a.ends || best.a.expires || '')
    const until = Number.isNaN(end) ? '' :
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', weekday: 'short', hour: 'numeric' }).format(new Date(end))
    alert = { event: best.a.event, until }
  }
  // Demand signal — ours, not NWS's. Thresholds per Brandyn: heat drives
  // no-cools, deep cold drives no-heats, a hard freeze bursts pipes.
  const highs = cities.map(c => c.high).filter(n => n != null)
  const lows = cities.map(c => c.low).filter(n => n != null)
  const maxHigh = highs.length ? Math.max(...highs) : null
  const minLow = lows.length ? Math.min(...lows) : null
  let signal = null
  if (maxHigh != null && maxHigh >= 95) signal = { kind: 'heat', text: 'No-cool surge likely' }
  else if (minLow != null && minLow <= 20) signal = { kind: 'cold', text: 'No-heat surge likely' }
  else if (minLow != null && minLow <= 28) signal = { kind: 'freeze', text: 'Hard freeze — burst pipe risk' }
  const data = {
    generatedAt: new Date().toISOString(),
    cities: cities.map(({ alerts: _a, ...rest }) => rest),
    alert, signal,
  }
  _wxCache = { data, expires: Date.now() + 15 * 60_000 }
  return data
}
app.get('/api/weather', async (req, res) => {
  try {
    if (_wxCache && _wxCache.expires > Date.now()) return res.json(_wxCache.data)
    res.json(await computeWeather())
  } catch (e) {
    console.warn('weather:', e.message)
    // Stale beats blank on a wallboard.
    if (_wxCache) return res.json({ ..._wxCache.data, stale: true })
    res.status(502).json({ error: e.message })
  }
})

// Estimates SOLD today — the Call Center TV celebrates tech sales in its
// live feed alongside CSR bookings. 2-minute cache; open like the board.
let _salesTodayCache = null
app.get('/api/tv/sales-today', async (req, res) => {
  try {
    if (_salesTodayCache && _salesTodayCache.expires > Date.now()) return res.json(_salesTodayCache.data)
    const today = boardDay(0)
    const rows = []
    let p = 1
    while (p <= 6) {
      const d = await stGet(`/sales/v2/tenant/${ST_TENANT_ID}/estimates?soldAfter=${today.startUtc.toISOString()}&pageSize=200&page=${p}`)
      rows.push(...(d?.data || []))
      if (!d?.hasMore) break
      p++
    }
    const techs = await getBoardTechs().catch(() => [])
    const nameOf = new Map(techs.map(t => [t.id, t.name]))
    const sales = rows
      .filter(e => {
        const st = (e.status && typeof e.status === 'object') ? e.status.name : e.status
        return st === 'Sold' && Number(e.subtotal || 0) > 0
      })
      .map(e => ({
        id: `est-${e.id}`,
        soldOn: e.soldOn || null,
        tech: nameOf.get(e.soldBy) || 'A technician',
        amount: Math.round(Number(e.subtotal || 0)),
        what: String(e.name || '').slice(0, 60) || 'an estimate',
      }))
      .sort((a, b) => Date.parse(b.soldOn || 0) - Date.parse(a.soldOn || 0))
      .slice(0, 30)
    const data = { generatedAt: new Date().toISOString(), sales }
    _salesTodayCache = { data, expires: Date.now() + 2 * 60_000 }
    res.json(data)
  } catch (err) {
    console.error('sales-today:', err.message)
    if (_salesTodayCache) return res.json(_salesTodayCache.data)
    res.status(500).json({ error: err.message })
  }
})

// TV extras: today's 5★ reviews, membership sales, and the Opportunity Watch
// Bonus unlock — one cached call so the wallboard stays cheap.
let _tvWinsCache = null
app.get('/api/tv/wins-today', async (req, res) => {
  try {
    if (_tvWinsCache && _tvWinsCache.expires > Date.now()) return res.json(_tvWinsCache.data)
    const today = boardDay(0)
    const denverToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

    const [reviewsRaw, membsRaw, techs, csrRows, profRows, bonusRow] = await Promise.all([
      stGet(`/marketingreputation/v2/tenant/${ST_TENANT_ID}/reviews?fromDate=${denverToday}&pageSize=100`).then(d => d?.data || []).catch(() => []),
      stGet(`/memberships/v2/tenant/${ST_TENANT_ID}/memberships?createdOnOrAfter=${today.startUtc.toISOString()}&pageSize=100`).then(d => d?.data || []).catch(() => []),
      getBoardTechs().catch(() => []),
      supabase.from('csr_st_users').select('st_user_id, profile_id').then(r => r.data || []),
      supabase.from('profiles').select('id, name, email').then(r => r.data || []),
      supabase.from('app_settings').select('value').eq('key', OPP_BONUS_LOG).maybeSingle().then(r => r.data),
    ])
    const techName = new Map(techs.map(t => [t.id, t.name]))
    const profName = new Map(profRows.map(p => [p.id, p.name || p.email]))
    const csrName = new Map(csrRows.map(c => [c.st_user_id, profName.get(c.profile_id)]))

    const reviews = reviewsRaw
      .filter(r => (r.rating || 0) === 5)
      .map(r => ({
        id: `rev-${r.internalId || r.externalId}`,
        at: r.publishDate || null,
        tech: r.technicianFullName || null,
        author: r.authorName || 'A customer',
        platform: r.platform || 'Google',
      }))

    const memberships = membsRaw.map(m => ({
      id: `memb-${m.id}`,
      at: m.createdOn || null,
      seller: techName.get(m.soldById) || csrName.get(m.soldById) || 'The team',
      type: m.membershipTypeName || m.type?.name || 'Awesome Club',
    }))

    let bonus = null
    try {
      const log = JSON.parse(bonusRow?.value || '{}')
      if (log[denverToday]) bonus = { id: `bonus-${denverToday}`, at: log[denverToday].at, pool: log[denverToday].pool, n: log[denverToday].n }
    } catch {}

    const data = { generatedAt: new Date().toISOString(), reviews: reviews.slice(0, 20), memberships: memberships.slice(0, 20), bonus }
    _tvWinsCache = { data, expires: Date.now() + 5 * 60_000 }
    res.json(data)
  } catch (err) {
    console.error('tv wins:', err.message)
    if (_tvWinsCache) return res.json(_tvWinsCache.data)
    res.status(500).json({ error: err.message })
  }
})

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
    const { profileId, status, skillsOnly } = req.body
    if (!profileId) return res.status(400).json({ error: 'profileId required' })

    // select('*') deliberately: dispatch_skill may predate its migration and
    // an explicit column list would 42703 the whole read.
    const { data: prof } = await supabase.from('profiles').select('*').eq('id', profileId).maybeSingle()
    if (!prof) return res.status(404).json({ error: 'profile not found' })

    const workers = await twilioClient.taskrouter.v1.workspaces(TWILIO_WORKSPACE_SID).workers.list({ limit: 100 })
    let worker = workers.find(w => {
      try { return JSON.parse(w.attributes || '{}').profile_id === profileId } catch { return false }
    })

    // Skills live on the worker ATTRIBUTES; the queues target them
    // (Inbound: inbound == 1, Dispatch: dispatch == 1). Activity only says
    // "at the desk right now" — so a dispatcher with inbound toggled off is
    // Available for dispatch without ever matching the CSR queue.
    const repName = prof.name || prof.email || 'Rep'
    const identity = repName.replace(/[^a-zA-Z0-9_]/g, '_')
    let attrs = {}
    try { attrs = JSON.parse(worker?.attributes || '{}') } catch {}
    const wanted = {
      ...attrs,
      // ALWAYS derived from the current name — the browser registers as
      // client:<current name>, so a stale stored contact_uri means Twilio
      // dials an identity nobody is registered under and the rep never
      // rings (Brittany, renamed to BK ages ago, was unreachable).
      contact_uri: `client:${identity}`,
      profile_id: profileId,
      name: repName,
      inbound: (prof.inbound_skill ? (prof.inbound_available ? 1 : 0) : 1),
      dispatch: (prof.dispatch_skill && prof.dispatch_available !== false) ? 1 : 0,
    }

    if (!worker) {
      // New hire — create their worker on the fly so routing works day one.
      worker = await twilioClient.taskrouter.v1.workspaces(TWILIO_WORKSPACE_SID)
        .workers.create({ friendlyName: repName, attributes: JSON.stringify(wanted) })
    } else if (JSON.stringify(wanted) !== JSON.stringify(attrs)) {
      await twilioClient.taskrouter.v1.workspaces(TWILIO_WORKSPACE_SID)
        .workers(worker.sid).update({ attributes: JSON.stringify(wanted) })
    }

    if (skillsOnly) return res.json({ ok: true, skills: { inbound: wanted.inbound, dispatch: wanted.dispatch } })

    const effStatus = status || prof.status
    const target = effStatus === 'Available' ? TWILIO_ACTIVITY_AVAILABLE : TWILIO_ACTIVITY_OFFLINE
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
    // Log it. NOTE: supabase builders have .then but NO .catch — chaining
    // .catch throws AFTER the text already sent and fails the whole request.
    const { error: logErr } = await supabase.from('call_logs').insert({
      contact_id: contactId || null,
      rep: repName || 'CSR',
      outcome: 'Text Sent',
      notes: body,
    })
    if (logErr) console.warn('sms log:', logErr.message)
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
  if (p.CallSid && !String(to || '').startsWith('client:')) {
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

  // Teammate call: dial the co-worker's browser directly. Internal calls are
  // NOT recorded or transcribed and never touch active_calls — they're not
  // customer calls and shouldn't show on boards or in recordings.
  if (String(to || '').startsWith('client:')) {
    const idial = twiml.dial({ callerId: `client:${p.identity || 'Andi'}`, timeout: 25 })
    idial.client(String(to).slice(7))
    res.type('text/xml')
    return res.send(twiml.toString())
  }

  const dial = twiml.dial({
    callerId: twilioPhone,
    timeout: 30,
    record: 'record-from-answer-dual',
    recordingStatusCallback: `${appUrl}/api/twilio/recording`,
    recordingStatusCallbackEvent: 'completed',
    // Hold/transfer parking: when the customer leg is redirected into a
    // conference, this rep leg falls through here and joins it.
    action: `${appUrl}/api/twilio/routing/after-dial`,
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
// ── Wrap-up autopilot ───────────────────────────────────────────────────────
// Call ends -> Twilio recording -> Whisper transcript -> Claude drafts the
// job notes in the house format (Date/Time/Early/Fee/Age/Tech notes/Synopsis)
// -> the dialer pre-fills the notes box during the rep's wrap-up. Held in
// memory keyed by call: transcripts land in ~10-30s and wrap-up is a minute,
// so persistence buys nothing a deploy mid-call would not lose anyway.
const OPENAI_KEY = process.env.OPENAI_API_KEY
const _callNotes = new Map()   // callSid -> { contactId, phone, text, at }
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10)
const pruneCallNotes = () => {
  const cutoff = Date.now() - 30 * 60_000
  for (const [k, v] of _callNotes) if (v.at < cutoff) _callNotes.delete(k)
}

// Claude turns a transcript (partial or full) into the house-format note.
async function draftNotesFromTranscript(transcript) {
  if (!ANTHROPIC_KEY) return null

  if (String(transcript || "").trim().length < 40) return null

  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Denver', weekday: 'short', month: 'short', day: 'numeric' })
  const cRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 800,
      system: `You extract job-booking notes from a home-services call transcript (HVAC/plumbing/electrical/garage door company in Colorado Springs). Today is ${today}. Extract ONLY what was actually said — never invent details. Amounts, dates and windows must come from the transcript.`,
      tools: [{
        name: 'submit_notes',
        description: 'Submit the extracted call notes',
        input_schema: {
          type: 'object',
          properties: {
            booked_window: { type: ['string', 'null'], description: "Date and time window agreed on the call, e.g. 'Thu, Jul 24 · 10-2' or 'tomorrow 8-12'. null if nothing was booked/agreed." },
            can_go_early: { type: 'string', enum: ['Yes', 'No', 'Not asked'], description: 'Did the customer say the tech may come earlier than the window?' },
            reason: { type: 'string', description: 'Reason for the call / the issue, one short line' },
            fee_quoted: { type: 'boolean', description: 'Was a dispatch/service/diagnostic fee stated on the call?' },
            fee_amount: { type: ['string', 'null'], description: "The fee as said, e.g. '$99' or '$49 member'. null if not stated." },
            tech_notes: { type: ['string', 'null'], description: 'Details that set the technician up for success: gate codes, pets, prior repairs, access notes, who will be home, equipment location. null if none.' },
            age_info: { type: ['string', 'null'], description: "Age of the home or equipment if mentioned, e.g. '~20 yr old system', 'home built 2005'. null if not mentioned." },
            synopsis: { type: 'string', description: "One to two sentence plain-English summary of anything NOT already captured by the other fields — how the call went, customer mood, follow-ups promised. Do NOT restate the window, fee, issue, or equipment age; those print right above the synopsis." },
          },
          required: ['can_go_early', 'reason', 'fee_quoted', 'synopsis'],
        },
      }],
      tool_choice: { type: 'tool', name: 'submit_notes' },
      messages: [{ role: 'user', content: `Transcript of the call:\n\n${transcript.slice(0, 24000)}` }],
    }),
  })
  if (!cRes.ok) throw new Error(`claude ${cRes.status}: ${(await cRes.text()).slice(0, 160)}`)
  const n = ((await cRes.json()).content || []).find(b => b.type === 'tool_use')?.input
  if (!n?.synopsis) return

  // The house format techs and dispatch already read every day.
  const lines = []
  if (n.booked_window) lines.push(`Date/Time \u{1F4C5}: ${n.booked_window}`)
  lines.push(`Can Go Early: ${n.can_go_early}`)
  lines.push(`Reason for Call \u2757: ${n.reason}`)
  lines.push(`Dispatch Fee \u{1F4B2}: ${n.fee_quoted ? `Quoted${n.fee_amount ? ` — ${n.fee_amount}` : ''}` : 'Unquoted'}`)
  if (n.age_info) lines.push(`Home/Equipment Age: ${n.age_info}`)
  if (n.tech_notes) lines.push(`Tech Setup Notes \u{1F527}: ${n.tech_notes}`)
  lines.push(`Synopsis: ${n.synopsis}`)

  return lines.join('\n')
}

// Whisper-pass breadcrumbs: this runs fire-and-forget from a webhook, so
// failures were invisible outside Railway logs. Health exposes the last few.
const _wuTrace = []
const _wu = (sid, msg) => { _wuTrace.push({ at: new Date().toISOString(), sid: String(sid || '').slice(-8), msg }); if (_wuTrace.length > 20) _wuTrace.shift() }

// Post-call pass: Whisper on the finished recording — the final, highest-
// quality draft (overwrites any live draft for the same call).
const _whispered = new Set()
async function transcribeAndDraftNotes({ callSid, contactId, phone, mp3Url, duration }) {
  if (!OPENAI_KEY || !ANTHROPIC_KEY) { _wu(callSid, 'skipped: key missing'); return }
  if (duration != null && duration < 15) { _wu(callSid, `skipped: ${duration}s too short`); return }   // too short to be a conversation
  if (_whispered.has(callSid)) { _wu(callSid, 'skipped: already transcribed'); return }
  _whispered.add(callSid)
  if (_whispered.size > 500) _whispered.delete(_whispered.values().next().value)
  _wu(callSid, 'start')
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')
  const audioRes = await fetch(mp3Url, { headers: { Authorization: `Basic ${auth}` } })
  if (!audioRes.ok) { _wu(callSid, `download failed ${audioRes.status}`); throw new Error(`recording download ${audioRes.status}`) }
  const audioBuf = Buffer.from(await audioRes.arrayBuffer())
  const fd = new FormData()
  fd.append('file', new Blob([audioBuf], { type: 'audio/mpeg' }), 'call.mp3')
  fd.append('model', 'whisper-1')
  fd.append('language', 'en')
  const wRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: fd,
  })
  if (!wRes.ok) { const t = (await wRes.text()).slice(0, 160); _wu(callSid, `whisper ${wRes.status}: ${t}`); throw new Error(`whisper ${wRes.status}: ${t}`) }
  const transcript = (await wRes.json())?.text || ''
  _wu(callSid, `whisper ok, ${transcript.length} chars`)
  const text = await draftNotesFromTranscript(transcript)
  if (!text) { _wu(callSid, 'no draft (transcript too thin)'); return }
  pruneCallNotes()
  _callNotes.set(callSid, { contactId, phone: last10(phone), text, at: Date.now() })
  _wu(callSid, `drafted final, ${text.length} chars`)
  console.log(`Call notes drafted (final) for contact ${contactId} (${callSid})`)
}

// ── LIVE transcription: Twilio Real-Time Transcription streams utterances to
// a webhook DURING the call; every ~20s of new speech Claude re-drafts the
// notes so the CSR's box (and the booking guidance that reads it) fills
// while the customer is still talking.
const _liveTx = new Map()   // callSid -> { contactId, parts: [], lastRun, running }
async function startLiveTranscription(callSid, contactId, label, phone, repName, contactName) {
  if (!ANTHROPIC_KEY || !callSid || _liveTx.has(callSid)) return
  _liveTx.set(callSid, { contactId, phone: last10(phone), repName: repName || null, contactName: contactName || null,
    direction: label, startedAt: Date.now(), parts: [], lastRun: 0, running: false })
  try {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')
    const form = new URLSearchParams({
      StatusCallbackUrl: `${appUrl}/api/twilio/live-transcript`,
      Track: 'both_tracks',
      PartialResults: 'false',
    })
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls/${callSid}/Transcriptions.json`, {
      method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
    })
    if (!r.ok) {
      _liveTx.delete(callSid)
      console.warn(`live transcription start failed (${label}):`, r.status, (await r.text()).slice(0, 160))
    } else {
      console.log(`live transcription started (${label}) on ${callSid}`)
    }
  } catch (e) { _liveTx.delete(callSid); console.warn('live transcription start:', e.message) }
}

// ── 🎧 LIVE OBJECTION COACH ─────────────────────────────────────────────────
// The customer's own words trigger the matching playbook article, delivered
// through the same poll the live notes ride — Ask Andi pops open with the
// play while the customer is still talking. Regex-first: instant and free.
// Each category fires at most once per call so the rep isn't spammed.
const COACH_TRIGGERS = [
  { cat: 'price_phone', label: 'Asking for a price over the phone',
    article: 'Objections: price over the phone, time windows, talking to a tech',
    re: /how much (is|does|would|will)|what does (it|that|this) cost|what('s| is) (it|that|this) (gonna|going to) (cost|run)|ballpark|price over the phone|give me a price|quote (me )?over the phone|what (do|would) you (guys )?charge/i },
  { cat: 'fee', label: 'Pushing back on the dispatch fee',
    article: '$89 fee: objection-by-objection answers',
    re: /(that|the|a) fee|eighty.?nine dollar|\$ ?89|charge (just )?to (come|send (someone|somebody)) out|pay (just )?for (an estimate|someone to (come|look))|free estimate|never (had to )?pa(y|id) for|waive (the|that)/i },
  { cat: 'think', label: '"Let me think about it"',
    article: 'Objection: I want to think about it',
    re: /think about it|talk it over|sleep on it|have to get back to you/i },
  { cat: 'other_co', label: 'They already have a company',
    article: 'Objection: I already have a company I use',
    re: /(another|other|different) company (we|i) (use|call)|(my|our) (guy|regular (guy|company)|plumber|electrician|hvac (guy|company))|already (have|use) (someone|somebody|a company|a guy)/i },
]
let _coachKb = { at: 0, map: new Map() }
async function coachArticleBody(title) {
  if (Date.now() - _coachKb.at > 5 * 60_000) {
    const { data } = await supabase.from('kb_articles').select('title, body').eq('active', true)
    _coachKb = { at: Date.now(), map: new Map((data || []).map(a => [a.title, a.body])) }
  }
  return _coachKb.map.get(title) || null
}
const _coachTips = new Map()   // callSid -> { contactId, phone, tips: [], fired: Set }
async function detectCoach(callSid, txEntry, text) {
  let ct = _coachTips.get(callSid)
  if (!ct) { ct = { contactId: txEntry.contactId, phone: txEntry.phone, tips: [], fired: new Set() }; _coachTips.set(callSid, ct) }
  ct.contactId = ct.contactId || txEntry.contactId
  ct.phone = ct.phone || txEntry.phone
  for (const t of COACH_TRIGGERS) {
    if (ct.fired.has(t.cat) || !t.re.test(text)) continue
    ct.fired.add(t.cat)
    const body = await coachArticleBody(t.article)
    if (!body) { console.warn(`coach: article "${t.article}" missing/inactive — trigger skipped`); continue }
    ct.tips.push({
      id: `${callSid}-${t.cat}`, cat: t.cat, label: t.label,
      articleTitle: t.article, text: String(body).slice(0, 1600),
      heard: String(text).slice(0, 140), at: Date.now(),
    })
  }
}

// ── Restart resilience ──────────────────────────────────────────────────────
// _liveTx is in-memory, so a deploy mid-call wiped the transcript: the X-ray
// showed 'call ended' while the call was still live, and notes stopped
// (bit Deanna+Brittany on Jul 28). Two layers: every utterance writes through
// to live_call_state (survives restarts once the table exists — tolerate its
// absence quietly), and an unrecognized CallSid RECREATES the session and
// re-links the contact so transcription self-heals within one sentence even
// with no table.
function persistTx(callSid, e) {
  supabase.from('live_call_state').upsert({
    call_sid: callSid,
    data: { contactId: e.contactId, phone: e.phone, repName: e.repName, contactName: e.contactName,
            direction: e.direction, line: e.line || null, startedAt: e.startedAt, parts: e.parts.slice(-400) },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'call_sid' }).then(({ error }) => {
    if (error && !/live_call_state/.test(error.message)) console.warn('liveTx persist:', error.message)
  })
}

async function restoreOrRecreateTx(callSid) {
  // Try the durable copy first (full transcript back), else start fresh.
  try {
    const { data: row } = await supabase.from('live_call_state').select('data').eq('call_sid', callSid).maybeSingle()
    if (row?.data) {
      const d = row.data
      const e = { contactId: d.contactId || null, phone: d.phone || null, repName: d.repName || null,
                  contactName: d.contactName || null, direction: d.direction || null, line: d.line || null,
                  startedAt: d.startedAt || Date.now(), parts: d.parts || [], lastRun: 0, running: false }
      _liveTx.set(callSid, e)
      console.log(`liveTx restored from DB for ${callSid} (${e.parts.length} lines)`)
      return e
    }
  } catch {}
  const e = { contactId: null, phone: null, repName: null, contactName: null,
              direction: null, startedAt: Date.now(), parts: [], lastRun: 0, running: false }
  _liveTx.set(callSid, e)
  console.log(`liveTx recreated after restart for ${callSid}`)
  // Re-link the contact/rep in the background — same sources the recording
  // webhook uses.
  ;(async () => {
    try {
      const { data: ac } = await supabase.from('active_calls').select('contact_id, to_number, rep_identity, contact_name')
        .eq('call_sid', callSid).maybeSingle()
      if (ac) {
        e.contactId = e.contactId || ac.contact_id
        e.phone = e.phone || last10(ac.to_number)
        e.repName = e.repName || (ac.rep_identity ? String(ac.rep_identity).replace(/_/g, ' ') : null)
        e.contactName = e.contactName || ac.contact_name
        e.direction = e.direction || 'outbound'
        return
      }
      const { data: ct } = await supabase.from('call_tasks').select('contact_id, from_number, agent_name')
        .eq('call_sid', callSid).maybeSingle()
      if (ct) {
        e.contactId = e.contactId || ct.contact_id
        e.phone = e.phone || last10(ct.from_number)
        e.repName = e.repName || ct.agent_name
        e.direction = e.direction || 'inbound'
      }
    } catch (err) { console.warn('liveTx relink:', err.message) }
  })()
  return e
}

async function runLiveDraft(callSid, entry) {
  const e = entry || _liveTx.get(callSid)
  if (!e || e.running) return
  const text = e.parts.map(p => `${p.who}: ${p.text}`).join('\n')
  if (text.length < 80) return
  e.running = true; e.lastRun = Date.now()
  if (e.line !== 'dispatch') classifyBooking(callSid, e).catch(() => {})   // dropdowns fill alongside the notes
  try {
    const draft = await draftNotesFromTranscript(text)
    if (draft) {
      pruneCallNotes()
      _callNotes.set(callSid, { contactId: e.contactId, phone: e.phone, text: draft, at: Date.now() })
    }
  } catch (err) { console.warn('live draft:', err.message) }
  e.running = false
}

// ── LIVE BOOKING CLASSIFIER ─────────────────────────────────────────────────
// While the notes draft themselves, the same transcript picks the ST business
// unit + job type so the booking dropdowns are already right when the CSR
// opens the panel. Suggestions ride /api/call-notes/latest like coach tips;
// the client only auto-fills dropdowns the rep hasn't touched.
const _bookMeta = { at: 0, jobTypes: [], bus: [] }
async function getBookMeta() {
  if (_bookMeta.jobTypes.length && Date.now() - _bookMeta.at < 6 * 3600_000) return _bookMeta
  const [jt, bu] = await Promise.all([
    stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/job-types?active=true&pageSize=500`).catch(() => null),
    stGet(`/settings/v2/tenant/${ST_TENANT_ID}/business-units?active=true&pageSize=200`).catch(() => null),
  ])
  if (jt?.data?.length) _bookMeta.jobTypes = jt.data.map(j => ({ id: j.id, name: j.name, buIds: j.businessUnitIds || [] }))
  if (bu?.data?.length) _bookMeta.bus = bu.data.map(b => ({ id: b.id, name: b.name }))
  if (_bookMeta.jobTypes.length && _bookMeta.bus.length) _bookMeta.at = Date.now()
  return _bookMeta
}

const _bookSuggest = new Map()   // callSid -> { contactId, phone, at, businessUnitId, jobTypeId, buName, jtName }
async function classifyBooking(callSid, e) {
  if (!ANTHROPIC_KEY || !e || e.classifying) return
  const text = e.parts.map(p => `${p.who}: ${p.text}`).join('\n')
  if (text.length < 120 || text.length === e.lastClassifyLen) return   // wait for real conversation, skip if no new speech
  e.classifying = true
  try {
    const meta = await getBookMeta()
    if (!meta.bus.length || !meta.jobTypes.length) return
    const buList = meta.bus.map(b => `${b.id}: ${b.name}`).join('\n')
    const jtList = meta.jobTypes.map(j => `${j.id}: ${j.name}${j.buIds.length ? ` [BU ${j.buIds.join(',')}]` : ''}`).join('\n')
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300,
        system: 'You classify live home-services calls (HVAC, plumbing, electrical, garage doors — Colorado Springs) into the ServiceTitan business unit and job type the CSR should book. Pick ONLY ids from the provided lists, and base the pick on the customer\'s own description of the problem. A wrong guess books a wrong job — if the trade or service is not clear yet, submit nulls.',
        tools: [{
          name: 'pick_booking',
          description: 'Submit the booking classification for this call',
          input_schema: {
            type: 'object',
            properties: {
              businessUnitId: { type: ['integer', 'null'], description: 'Business unit id from the list, or null if unclear' },
              jobTypeId: { type: ['integer', 'null'], description: 'Job type id from the list, or null if unclear. Must belong to the chosen business unit.' },
              confident: { type: 'boolean', description: 'true only if the transcript clearly supports the choice' },
            },
            required: ['businessUnitId', 'jobTypeId', 'confident'],
          },
        }],
        tool_choice: { type: 'tool', name: 'pick_booking' },
        messages: [{ role: 'user', content: `BUSINESS UNITS:\n${buList}\n\nJOB TYPES (with their business unit ids):\n${jtList}\n\nLIVE TRANSCRIPT SO FAR:\n${text.slice(-6000)}` }],
      }),
    })
    if (!r.ok) return
    const out = (await r.json())?.content?.find(c => c.type === 'tool_use')?.input || {}
    e.lastClassifyLen = text.length
    if (!out.confident) return
    const jt = meta.jobTypes.find(j => j.id === out.jobTypeId) || null
    let buId = out.businessUnitId || null
    // The pair must be real — a job type outside the picked BU books wrong.
    if (jt && buId && jt.buIds.length && !jt.buIds.includes(buId)) buId = jt.buIds[0]
    if (jt && !buId) buId = jt.buIds[0] || null
    if (!jt && !buId) return
    const bu = meta.bus.find(b => b.id === buId) || null
    _bookSuggest.set(callSid, {
      contactId: e.contactId || null, phone: e.phone || null, at: Date.now(),
      businessUnitId: buId, jobTypeId: jt?.id || null,
      buName: bu?.name || null, jtName: jt?.name || null,
    })
  } catch (err) { console.warn('booking classify:', err.message) }
  finally { e.classifying = false }
}

// TaskRouter's dequeue instruction records the call but supports NO recording
// status callback — the recording_status_callback keys in the assignment
// response are silently ignored, so /api/twilio/recording never fires for
// inbound. Twilio DOES tell us when the call ends (transcription-stopped), so
// we fetch the recording by REST and run the same final pass from here.
async function finalPassFromRest(callSid, e) {
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')
  const recsFor = async (sid) => {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings.json?CallSid=${sid}`, {
      headers: { Authorization: `Basic ${auth}` } })
    return ((await r.json()).recordings || []).find(x => x.status === 'completed') || null
  }
  let rec = null
  for (const delay of [10_000, 20_000]) {   // recording finishes processing a few seconds after hangup
    await new Promise(r => setTimeout(r, delay))
    try {
      rec = await recsFor(callSid)
      if (!rec) {
        // TaskRouter's dequeue records the REP's leg — a child call of the
        // customer's. Walk the children and take the first recording found.
        const cr = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls.json?ParentCallSid=${callSid}`, {
          headers: { Authorization: `Basic ${auth}` } })
        const kids = (await cr.json()).calls || []
        _wu(callSid, `no rec on parent; ${kids.length} child leg(s)`)
        for (const k of kids) { rec = await recsFor(k.sid); if (rec) break }
      }
      if (rec) break
    } catch (err) { _wu(callSid, `rest recordings: ${err.message}`) }
  }
  if (!rec) { _wu(callSid, 'no recording via REST'); return }
  const mp3 = `https://api.twilio.com${rec.uri.replace('.json', '.mp3')}`
  const dur = rec.duration ? parseInt(rec.duration) : null
  await saveRecording({
    recording_sid: rec.sid,
    call_sid: callSid,
    url: mp3,
    duration: dur,
    direction: e.direction || 'inbound',
    rep: e.repName || null,
    contact_id: e.contactId || null,
    contact_name: e.contactName || null,
    phone: e.phone || null,
    call_started_at: e.startedAt ? new Date(e.startedAt).toISOString() : new Date().toISOString(),
  }).catch(err => _wu(callSid, `registry: ${err.message}`))
  // Automated QA — inbound conversations only.
  if ((e.direction || 'inbound') === 'inbound') {
    evaluateCall({ callSid, recordingSid: rec.sid, duration: dur, e })
      .catch(err => console.warn('call eval:', err.message))
  }
  // Attach to the rep's call log so inbound recordings show in the app too.
  if (e.contactId) {
    const { data: recentLog } = await supabase.from('call_logs').select('id')
      .eq('contact_id', e.contactId).is('recording_url', null)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (recentLog) await supabase.from('call_logs').update({ recording_url: mp3, recording_duration: dur, call_sid: callSid }).eq('id', recentLog.id)
  }
  await transcribeAndDraftNotes({ callSid, contactId: e.contactId, phone: e.phone, mp3Url: mp3, duration: dur })
}

app.post('/api/twilio/live-transcript', async (req, res) => {
  res.sendStatus(200)
  try {
    const { TranscriptionEvent, CallSid, Track } = req.body
    if (!CallSid) return
    if (TranscriptionEvent === 'transcription-stopped') {
      supabase.from('live_call_state').delete().eq('call_sid', CallSid).then(() => {}, () => {})
      setTimeout(() => _coachTips.delete(CallSid), 5 * 60_000)   // linger briefly for the last poll
      setTimeout(() => _bookSuggest.delete(CallSid), 15 * 60_000)   // survives wrap-up, then goes
      const e = _liveTx.get(CallSid)
      _liveTx.delete(CallSid)
      if (e) {
        runLiveDraft(CallSid, e)   // flush any tail utterances into the live draft
        finalPassFromRest(CallSid, e).catch(err => _wu(CallSid, `final pass: ${err.message}`.slice(0, 200)))
      }
      return
    }
    if (TranscriptionEvent !== 'transcription-content') return
    let data = {}
    try { data = JSON.parse(req.body.TranscriptionData || '{}') } catch {}
    const text = String(data.transcript || '').trim()
    if (!text) return
    let e = _liveTx.get(CallSid)
    if (!e) e = await restoreOrRecreateTx(CallSid)
    e.parts.push({ who: Track === 'inbound_track' ? 'Customer' : 'Rep', text, at: Date.now() })
    persistTx(CallSid, e)
    if (Track === 'inbound_track' && e.line !== 'dispatch') detectCoach(CallSid, e, text).catch(() => {})
    if (Date.now() - e.lastRun > 20_000) runLiveDraft(CallSid)
  } catch (err) { console.warn('live-transcript webhook:', err.message) }
})

// Diagnostics: is the pipeline armed, and is anything flowing?
// 👁 LIVE CALL X-RAY — admins can read any in-progress call's transcript as
// it happens, straight from the same in-memory stream that feeds the notes
// and the coach. Nothing new is recorded; the tail dies with the call.
app.get('/api/live-calls', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  const calls = [..._liveTx.entries()].map(([sid, e]) => ({
    id: sid, contactId: e.contactId || null, phone: e.phone || null,
    rep: e.repName || null, contactName: e.contactName || null,
    direction: e.direction || null, startedAt: e.startedAt || null, lines: e.parts.length,
  }))
  res.json({ calls })
})

app.get('/api/live-calls/:sid/transcript', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  const e = _liveTx.get(String(req.params.sid || ''))
  if (!e) return res.json({ active: false, lines: [] })
  res.json({
    active: true, rep: e.repName || null, contactName: e.contactName || null,
    contactId: e.contactId || null, phone: e.phone || null, startedAt: e.startedAt || null,
    lines: e.parts,
  })
})

app.get('/api/call-notes/health', (req, res) => {
  res.json({
    openaiKey: Boolean(OPENAI_KEY), anthropicKey: Boolean(ANTHROPIC_KEY), uptimeSec: Math.round(process.uptime()),
    liveCalls: _liveTx.size, drafts: _callNotes.size, whisper: _wuTrace, inboundTrace: _fwdTrace, netTrace: _netTrace,
    entries: [..._callNotes.entries()].map(([sid, v]) => ({
      sid: sid.slice(-8), contactId: v.contactId, phone: v.phone || null,
      chars: v.text.length, ageSec: Math.round((Date.now() - v.at) / 1000),
    })),
  })
})

// The dialer polls this during wrap-up to pre-fill the notes box.
app.get('/api/call-notes/latest', (req, res) => {
  const contactId = String(req.query.contactId || '')
  const phone = last10(req.query.phone)
  if (!contactId && !phone) return res.json({})
  const match = (v) => (contactId && String(v.contactId) === contactId) || (phone && v.phone && v.phone === phone)
  let best = null
  for (const v of _callNotes.values()) {
    if (Date.now() - v.at >= 15 * 60_000) continue
    // Duplicate contacts share a phone — match either key so the draft can't
    // hide behind whichever duplicate the server happened to link.
    if (match(v) && (!best || v.at > best.at)) best = v
  }
  // Live objection-coach tips ride the same poll — no extra request loop.
  const coach = []
  for (const ct of _coachTips.values()) {
    if (match(ct)) coach.push(...ct.tips)
  }
  // The booking classifier's pick rides along too. Kept 15 min so it still
  // fills the panel when the rep books during wrap-up, after hangup.
  let suggest = null
  for (const [sid, s] of _bookSuggest) {
    if (Date.now() - s.at >= 15 * 60_000) { _bookSuggest.delete(sid); continue }
    if (match(s) && (!suggest || s.at > suggest.at)) suggest = s
  }
  // Which marketing channel did they call in on? (ST telecom lookup.)
  let channel = null, channelId = null
  if (phone) {
    const ch = _mktChannel.get(phone)
    if (ch && Date.now() - ch.at < 3600_000) { channel = ch.name; channelId = ch.id || null }
  }
  res.json({ ...(best ? { text: best.text, at: best.at } : {}), coach, ...(suggest ? { suggest } : {}), ...(channel ? { channel, channelId } : {}) })
})

// ── Call recording registry ─────────────────────────────────────────────────
// Every completed recording lands in call_recordings the moment it exists —
// independent of whether the rep ever files an outcome (most calls never get
// a call_logs row, so hanging recordings off outcome logs lost nearly all of
// them). The Recordings tab reads this table and joins outcome/notes/booking
// back on at read time.
async function saveRecording(row) {
  if (!row?.recording_sid || !row?.url) return
  try {
    // Booked on this call? The booking lands mid-call and the recording only
    // arrives after hangup, so the andi_bookings row already exists by now.
    if (row.contact_id && !row.st_job_id) {
      const since = new Date((Date.parse(row.call_started_at) || Date.now()) - 10 * 60_000).toISOString()
      const { data: bk } = await supabase.from('andi_bookings')
        .select('st_job_id, st_job_number').eq('contact_id', row.contact_id)
        .gte('booked_at', since).order('booked_at', { ascending: false }).limit(1).maybeSingle()
      if (bk) { row.st_job_id = bk.st_job_id; row.st_job_number = bk.st_job_number || null }
    }
  } catch {}
  const { error } = await supabase.from('call_recordings').upsert(row, { onConflict: 'recording_sid' })
  if (error) console.warn('call_recordings save:', error.message)
}

// Safety net: webhooks get missed (deploy restart mid-call, TaskRouter paths
// that never fire a recording callback). Every 30 minutes, pull recent
// recordings straight from Twilio and upsert any the registry doesn't have —
// the Recordings tab must be the complete record of inbound AND outbound,
// not just the calls whose callbacks happened to land.
async function sweepRecordings(hoursBack = 26) {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
  const tw = async (path) => {
    const r = await fetch(`https://api.twilio.com${path}`, { headers: { Authorization: `Basic ${auth}` } })
    return r.json()
  }
  const since = new Date(Date.now() - hoursBack * 3600_000)
  const { data: have, error: haveErr } = await supabase.from('call_recordings')
    .select('recording_sid').gte('created_at', new Date(since.getTime() - 86400_000).toISOString()).limit(5000)
  if (haveErr) return false   // table not migrated yet — nothing to sweep into
  const haveSet = new Set((have || []).map(x => x.recording_sid))

  let page = `/2010-04-01/Accounts/${accountSid}/Recordings.json?PageSize=500&${encodeURIComponent('DateCreated>')}=${since.toISOString().slice(0, 10)}`
  let added = 0
  for (let p = 0; p < 6 && page; p++) {
    const d = await tw(page)
    page = d.next_page_uri || null
    for (const rec of d.recordings || []) {
      if (rec.status !== 'completed' || haveSet.has(rec.sid)) continue
      if (new Date(rec.date_created) < since) continue
      try {
        const call = await tw(`/2010-04-01/Accounts/${accountSid}/Calls/${rec.call_sid}.json`)
        let root = call
        if (call.parent_call_sid) {
          try { root = await tw(`/2010-04-01/Accounts/${accountSid}/Calls/${call.parent_call_sid}.json`) } catch {}
        }
        const sids = [rec.call_sid, call.parent_call_sid].filter(Boolean)
        const { data: ac } = await supabase.from('active_calls')
          .select('direction, rep_identity, contact_id, contact_name, from_number, to_number, started_at')
          .in('call_sid', sids).limit(1).maybeSingle()
        const { data: ct } = ac ? { data: null } : await supabase.from('call_tasks')
          .select('contact_id, contact_name, from_number, agent_name, answered_at')
          .in('call_sid', sids).limit(1).maybeSingle()

        // Direction: a browser-originated leg means WE placed the call.
        const isClient = (s) => String(s || '').startsWith('client:')
        const outbound = ac ? ac.direction === 'outbound'
          : ct ? false
          : isClient(root.from) || isClient(call.from)
        // Customer number: whichever end isn't us and isn't a browser identity.
        const ourNum = last10(twilioPhone)
        const external = [call.to, call.from, root.to, root.from]
          .find(n => n && !isClient(n) && last10(n) && last10(n) !== ourNum)
        let phone = last10(ac ? (outbound ? ac.to_number : ac.from_number) : ct ? ct.from_number : external)
        let contactId = ac?.contact_id || ct?.contact_id || null
        let contactName = ac?.contact_name || ct?.contact_name || null
        if (!contactId && phone) {
          const { data: cands } = await supabase.from('contacts').select('id, name, phone')
            .ilike('phone', `%${phone.slice(-4)}%`).limit(50)
          const c = (cands || []).find(x => last10(x.phone) === phone)
          if (c) { contactId = c.id; contactName = c.name }
        }
        await saveRecording({
          recording_sid: rec.sid,
          call_sid: root.sid || rec.call_sid,
          url: `https://api.twilio.com${rec.uri.replace('.json', '.mp3')}`,
          duration: rec.duration ? parseInt(rec.duration) : null,
          direction: outbound ? 'outbound' : 'inbound',
          rep: ac?.rep_identity || ct?.agent_name || null,
          contact_id: contactId, contact_name: contactName, phone: phone || null,
          call_started_at: root.start_time ? new Date(root.start_time).toISOString()
            : ac?.started_at || ct?.answered_at || new Date(rec.date_created).toISOString(),
        })
        haveSet.add(rec.sid)
        added++
      } catch (e) { console.warn('recording sweep item:', e.message) }
    }
  }
  if (added) console.log(`Recording sweep: ${added} recording(s) backfilled`)
  return true
}

// ── 📋 AUTOMATED CALL EVALUATIONS (inbound only) ────────────────────────────
// Every answered inbound call over the minimum length gets scored against the
// admin-editable rubric (Settings → Call QA). The rubric is plain text the AI
// re-parses on every call — edit it and the very next evaluation uses it.
// N/A criteria are EXCLUDED from the denominator (a no-hold call scores out
// of fewer points, per Brandyn). Monthly averages auto-fill the scorecard's
// call_quality KPI.
const DEFAULT_EVAL_SECTIONS = [
  {
    name: 'Accuracy & Procedure', weight: 50,
    items: [
      { question: 'Greeting used', points: 5, guidance: 'Opened with the company greeting: "Thank you for calling Awesome Home Services, this is {name} speaking. How can we make your day Awesome?" Close variations acceptable; missing the Awesome greeting entirely is 0.' },
      { question: 'Verified homeowner status', points: 10, guidance: 'Asked whether we\'re speaking with the property owner ("Are you the homeowner?" / "Do you rent or own the property?").' },
      { question: 'Verified address', points: 5, guidance: 'Asked for or confirmed the service/property address.' },
      { question: 'Verified email', points: 5, guidance: 'Asked for or confirmed an email address ("Let me make sure I have the right email — is it …?").' },
      { question: 'Asked age of home/unit', points: 5, guidance: 'Asked how old the home or the equipment is.' },
      { question: 'Confirmed best phone number', points: 5, guidance: 'Asked for or confirmed the best number to reach the customer.' },
      { question: 'Used/confirmed client name', points: 5, guidance: 'Got the caller\'s full name or confirmed it, and used it during the call.' },
      { question: 'Offered in-house plan', points: 5, guidance: 'If the caller is not a member, offered the club membership plan. If they ARE a member, thanked them for being a member (that earns the points).' },
      { question: 'Attempted/overcame objections', points: 5, guidance: 'Acknowledged concerns and worked through them ("I understand your concern, here\'s how this works…"). N/A if the caller raised no objections.' },
    ],
  },
  {
    name: 'Soft Skills & Customer Experience', weight: 50,
    items: [
      { question: 'Expressed empathy', points: 10, guidance: 'Acknowledged the customer\'s situation or feelings in words at least once ("I understand how frustrating that must be", "Sorry you\'re dealing with no AC in this heat"). ONE genuine, well-placed acknowledgment earns full points — it does not need repeating. N/A when the call is purely routine and the customer expressed no problem, frustration, or worry (quick reschedule, simple confirmation, routine maintenance booking with a happy customer).' },
      { question: 'Minimal dead air/silence', points: 5, guidance: 'Responded promptly; narrated pauses ("Let me check that for you") instead of going silent.' },
      { question: 'Did not interrupt client', points: 5, guidance: 'Let the caller explain fully before responding.' },
      { question: 'Actively listened', points: 5, guidance: 'Repeated or confirmed details back; referenced things the caller said earlier.' },
      { question: 'Avoided slang/jargon', points: 5, guidance: 'Professional language; no in-house acronyms or day-to-day slang.' },
      { question: 'Friendly, polite, professional', points: 5, guidance: 'Positive tone throughout, used the client\'s name, said please and thank you.' },
      { question: 'Compliant & confident with company policies', points: 5, guidance: 'Explained pricing, warranties, or fees per company rules; stayed calm and factual if questioned.' },
      { question: 'Correct hold procedure', points: 5, guidance: 'Asked permission before placing the caller on hold. N/A if no hold occurred.' },
      { question: 'Checked in if hold over 3 minutes', points: 5, guidance: 'After a long hold, thanked the caller and gave an update. N/A if no hold that long.' },
    ],
  },
]

function cleanEvalSections(raw) {
  if (!Array.isArray(raw)) return null
  const secs = raw.map(s => ({
    name: String(s?.name || '').trim().slice(0, 80),
    weight: Math.max(0, Number(s?.weight) || 0),
    items: (Array.isArray(s?.items) ? s.items : []).map(i => ({
      question: String(i?.question || '').trim().slice(0, 160),
      points: Math.max(1, parseInt(i?.points) || 5),
      guidance: String(i?.guidance || '').trim().slice(0, 600),
    })).filter(i => i.question),
  })).filter(s => s.name && s.items.length)
  return secs.length ? secs : null
}

// The exact text the AI scores against, built from the structure.
function evalRubricText(sections) {
  return sections.map(s =>
    `SECTION: ${s.name} — worth ${s.weight}% of the final score\n` +
    s.items.map((i, n) => `${n + 1}. ${i.question} (${i.points} pts)${i.guidance ? ` — ${i.guidance}` : ''}`).join('\n')
  ).join('\n\n')
}

let _evalCfgCache = { at: 0, cfg: null }
async function getEvalCfg() {
  if (_evalCfgCache.cfg && Date.now() - _evalCfgCache.at < 60_000) return _evalCfgCache.cfg
  let saved = null
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'call_eval_rubric').maybeSingle()
    saved = data?.value ? JSON.parse(data.value) : null
  } catch {}
  const cfg = {
    enabled: saved?.enabled !== false,
    minSeconds: Number(saved?.minSeconds) || 60,
    sections: cleanEvalSections(saved?.sections) || JSON.parse(JSON.stringify(DEFAULT_EVAL_SECTIONS)),
  }
  _evalCfgCache = { at: Date.now(), cfg }
  return cfg
}

app.get('/api/admin/call-eval-config', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  res.json({ cfg: await getEvalCfg(), defaultSections: DEFAULT_EVAL_SECTIONS })
})
app.post('/api/admin/call-eval-config', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const { sections, minSeconds, enabled } = req.body || {}
    const cleaned = cleanEvalSections(sections)
    if (!cleaned) return res.status(400).json({ error: 'At least one section with one question is required' })
    const val = {
      sections: cleaned,
      minSeconds: Math.max(0, parseInt(minSeconds) || 60),
      enabled: enabled !== false,
    }
    const { error } = await supabase.from('app_settings').upsert({ key: 'call_eval_rubric', value: JSON.stringify(val) }, { onConflict: 'key' })
    if (error) throw error
    _evalCfgCache = { at: 0, cfg: null }   // next call scores against the new rubric
    res.json({ ok: true, cfg: await getEvalCfg() })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

async function evaluateCall({ callSid, recordingSid, duration, e }) {
  if (!ANTHROPIC_KEY) return
  if (e.line === 'dispatch') return   // tech calls aren't QA'd against the CSR rubric
  const cfg = await getEvalCfg()
  if (!cfg.enabled) return
  if (duration != null && duration < cfg.minSeconds) return
  const transcript = (e.parts || []).map(p => `${p.who}: ${p.text}`).join('\n')
  if (transcript.length < 200) return   // no real conversation captured

  // Who took the call — call_tasks knows the agent AND their profile id.
  let rep = e.repName || null, profileId = null
  try {
    const { data: ct } = await supabase.from('call_tasks')
      .select('agent_name, agent_profile_id').eq('call_sid', callSid).maybeSingle()
    if (ct) { rep = ct.agent_name || rep; profileId = ct.agent_profile_id || null }
  } catch {}

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 2500,
      system: `You are a strict but fair call-quality evaluator for Awesome Home Services' inbound CSRs. Score ONLY from the transcript. The rubric below is the single source of truth — score exactly the questions it lists, with their point values, under their exact section names (it changes over time; never assume a question that isn't in it). Transcription is imperfect: judge intent rather than exact wording, EXCEPT where the rubric demands specific phrasing (then accept close variations). Mark a question applicable=false when the situation never arose on this call (no hold → hold questions N/A; no objections raised → objection question N/A). Partial credit is allowed where earned. Evidence must be a short quote from the transcript or a one-line reason.`,
      tools: [{
        name: 'submit_evaluation',
        description: 'Submit the scored call evaluation',
        input_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  section: { type: 'string', description: 'Section name EXACTLY as written in the rubric' },
                  criterion: { type: 'string', description: 'Question text as written in the rubric' },
                  max_points: { type: 'integer' },
                  earned_points: { type: 'integer' },
                  applicable: { type: 'boolean', description: 'false only when the situation never arose on this call' },
                  evidence: { type: 'string', description: 'Short quote or one-line reason' },
                },
                required: ['section', 'criterion', 'max_points', 'earned_points', 'applicable', 'evidence'],
              },
            },
            summary: { type: 'string', description: '2-3 sentence coaching summary addressed to the rep' },
            coaching_tip: { type: 'string', description: 'The ONE thing to do better on the next call' },
          },
          required: ['items', 'summary', 'coaching_tip'],
        },
      }],
      tool_choice: { type: 'tool', name: 'submit_evaluation' },
      messages: [{ role: 'user', content: `RUBRIC:\n${evalRubricText(cfg.sections)}\n\nTHE CSR BEING EVALUATED IS: ${rep || 'unknown'}. Address the summary and coaching tip to them by exactly this name — never guess or use any other name, even if other names come up in the call.\n\nCALL TRANSCRIPT (Rep = our CSR, Customer = the caller):\n${transcript.slice(0, 24000)}` }],
    }),
  })
  if (!r.ok) { console.warn('call eval api:', r.status, (await r.text()).slice(0, 160)); return }
  const out = (await r.json())?.content?.find(c => c.type === 'tool_use')?.input
  if (!out?.items?.length) return

  const items = out.items.map(i => ({
    section: String(i.section || '').slice(0, 80),
    criterion: String(i.criterion || '').slice(0, 160),
    max: Math.max(0, parseInt(i.max_points) || 0),
    earned: Math.max(0, Math.min(parseInt(i.earned_points) || 0, parseInt(i.max_points) || 0)),
    applicable: i.applicable !== false,
    evidence: String(i.evidence || '').slice(0, 300),
  }))

  // Section-weighted score: each section scores on its own applicable items,
  // then combines by its % weight (renormalized if a whole section was N/A).
  const secAgg = cfg.sections.map(s => ({ name: s.name, weight: s.weight, earned: 0, possible: 0 }))
  const secOf = (name) => secAgg.find(s => s.name.toLowerCase() === String(name).toLowerCase()) || secAgg[0]
  for (const it of items) {
    if (!it.applicable) continue
    const s = secOf(it.section)
    s.possible += it.max
    s.earned += it.earned
  }
  const active = secAgg.filter(s => s.possible > 0)
  const possible = active.reduce((a, s) => a + s.possible, 0)
  const earned = active.reduce((a, s) => a + s.earned, 0)
  if (possible <= 0) return
  const wSum = active.reduce((a, s) => a + (Number(s.weight) || 0), 0)
  const pct = wSum > 0
    ? Math.round(active.reduce((a, s) => a + (s.earned / s.possible) * (Number(s.weight) || 0), 0) / wSum * 1000) / 10
    : Math.round((earned / possible) * 1000) / 10
  const sections = secAgg.map(s => ({
    ...s, pct: s.possible > 0 ? Math.round((s.earned / s.possible) * 1000) / 10 : null,
  }))

  const { error } = await supabase.from('call_evaluations').insert({
    call_sid: callSid, recording_sid: recordingSid || null,
    contact_id: e.contactId || null, contact_name: e.contactName || null,
    phone: e.phone || null, rep, profile_id: profileId,
    scores: { items, sections, coaching_tip: out.coaching_tip || null },
    earned, possible, pct, summary: out.summary || null,
  })
  if (error) { console.warn('call eval save:', error.message); return }
  console.log(`Call eval: ${rep || 'unknown'} scored ${pct}% (${earned}/${possible}) on ${callSid}`)
  if (profileId) syncEvalScorecard(profileId).catch(err => console.warn('eval scorecard sync:', err.message))
}

// ── Scorecard auto-fill ─────────────────────────────────────────────────────
// Attendance (points log) and Call Quality (eval averages) already populate
// themselves; this fills the remaining KPIs hourly so nobody hand-enters
// numbers: booked_calls = real ST jobs booked through Andi (andi_bookings),
// booking_pct = inbound calls that produced a booking ÷ inbound answered,
// memberships = ST-attributed membership sales (commission rows). These
// columns are automated now — manual edits get overwritten.
async function syncScorecardActuals() {
  // Current month AND the previous one: early-month reviews look at last
  // month, and late-arriving data (membership commissions sync after
  // month-end) must keep landing there.
  await syncScorecardMonth(0)
  await syncScorecardMonth(1)
}
async function syncScorecardMonth(monthsBack) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date()).map(x => [x.type, x.value]))
  let y = +p.year, m = +p.month - monthsBack
  while (m < 1) { m += 12; y -= 1 }
  const month = `${y}-${String(m).padStart(2, '0')}-01`
  const startIso = new Date(Date.UTC(y, m - 1, 1, 7)).toISOString()
  const endIso = new Date(Date.UTC(y, m, 1, 7)).toISOString()

  const [{ data: profs }, { data: bks }, { data: tasks }, { data: recs }, { data: mems }] = await Promise.all([
    supabase.from('profiles').select('id, name, email, role').eq('active', true),
    supabase.from('andi_bookings').select('profile_id').gte('booked_at', startIso).lt('booked_at', endIso).limit(5000),
    supabase.from('call_tasks').select('agent_profile_id').eq('state', 'answered').gte('answered_at', startIso).lt('answered_at', endIso).limit(5000),
    supabase.from('call_recordings').select('rep').eq('direction', 'inbound').not('st_job_id', 'is', null).gte('call_started_at', startIso).lt('call_started_at', endIso).limit(5000),
    supabase.from('commissions').select('profile_id').not('st_membership_id', 'is', null).gte('earned_at', startIso).lt('earned_at', endIso).limit(5000),
  ])

  const count = (rows, key) => {
    const m = new Map()
    for (const r of (rows || [])) { const k = r[key]; if (k) m.set(String(k), (m.get(String(k)) || 0) + 1) }
    return m
  }
  const booked = count(bks, 'profile_id')
  const answered = count(tasks, 'agent_profile_id')
  const inbBookedByName = count(recs, 'rep')
  const memCount = count(mems, 'profile_id')

  let weights = null
  try {
    const { data: w } = await supabase.from('app_settings').select('value').eq('key', 'scorecard_weights').maybeSingle()
    weights = w?.value ? JSON.parse(w.value) : null
  } catch {}

  for (const prof of (profs || [])) {
    const pid = String(prof.id)
    const name = prof.name || prof.email
    const bookedN = booked.get(pid) || 0
    const answeredN = answered.get(pid) || 0
    const inbBookedN = inbBookedByName.get(name) || 0
    const memsN = memCount.get(pid) || 0
    if (!bookedN && !answeredN && !memsN) continue   // no phone activity, nothing to write
    const patch = {
      booked_calls: bookedN,
      memberships: memsN,
      booking_pct: answeredN > 0 ? Math.round(Math.min(inbBookedN, answeredN) / answeredN * 100) : null,
      updated_at: new Date().toISOString(),
    }
    const { data: existing } = await supabase.from('scorecard_actuals')
      .select('id').eq('profile_id', prof.id).eq('month', month).maybeSingle()
    if (existing) await supabase.from('scorecard_actuals').update(patch).eq('id', existing.id)
    else await supabase.from('scorecard_actuals').insert({ profile_id: prof.id, month, ...patch, weights })
  }
}

// Roll this month's average into the scorecard's call_quality KPI. The KPI
// becomes automated: manual edits to call_quality get overwritten by this.
async function syncEvalScorecard(profileId) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date()).map(x => [x.type, x.value]))
  const month = `${p.year}-${p.month}-01`
  const monthStartUtc = new Date(Date.UTC(+p.year, +p.month - 1, 1, 7)).toISOString()
  const { data: rows } = await supabase.from('call_evaluations')
    .select('pct').eq('profile_id', profileId).gte('created_at', monthStartUtc).limit(1000)
  if (!rows?.length) return
  const avg = Math.round(rows.reduce((s, r) => s + Number(r.pct || 0), 0) / rows.length)
  const { data: existing } = await supabase.from('scorecard_actuals')
    .select('id').eq('profile_id', profileId).eq('month', month).maybeSingle()
  if (existing) {
    await supabase.from('scorecard_actuals').update({ call_quality: avg, updated_at: new Date().toISOString() }).eq('id', existing.id)
  } else {
    let weights = null
    try {
      const { data: w } = await supabase.from('app_settings').select('value').eq('key', 'scorecard_weights').maybeSingle()
      weights = w?.value ? JSON.parse(w.value) : null
    } catch {}
    await supabase.from('scorecard_actuals').insert({ profile_id: profileId, month, call_quality: avg, weights })
  }
}

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

    // Attach to the matching call log if one exists.
    // Inbound calls stopped writing active_calls when TaskRouter landed — the
    // contact for those lives on call_tasks. Check both.
    let { data: ac } = await supabase.from('active_calls').select('*').eq('call_sid', CallSid).maybeSingle()
    let inboundTask = null
    if (!ac?.contact_id) {
      const { data: ct } = await supabase.from('call_tasks').select('*').eq('call_sid', CallSid).maybeSingle()
      if (ct) {
        inboundTask = ct
        ac = { direction: 'inbound', contact_id: ct.contact_id, contact_name: ct.contact_name,
          from_number: ct.from_number, rep_identity: ct.agent_name, started_at: ct.answered_at }
      }
    }
    if (!ac?.contact_id) _wu(CallSid, 'no contact match — whisper skipped')

    // Registry first — this must not depend on a contact match or a call log.
    await saveRecording({
      recording_sid: RecordingSid,
      call_sid: CallSid,
      url: mp3,
      duration: RecordingDuration ? parseInt(RecordingDuration) : null,
      direction: ac?.direction || null,
      rep: ac?.rep_identity || null,
      contact_id: ac?.contact_id || null,
      contact_name: ac?.contact_name || null,
      phone: last10(ac?.direction === 'outbound' ? ac?.to_number : ac?.from_number) || null,
      call_started_at: ac?.started_at || new Date().toISOString(),
    })

    // Inbound QA eval rides the recording callback too — belt and suspenders
    // with finalPassFromRest (call_sid is unique in call_evaluations, so a
    // double fire is a harmless duplicate-insert error).
    if (inboundTask) {
      try {
        let e = _liveTx.get(CallSid)
        if (!e?.parts?.length) {
          const { data: st } = await supabase.from('live_call_state').select('data').eq('call_sid', CallSid).maybeSingle()
          if (st?.data?.parts?.length) e = { ...st.data, parts: st.data.parts }
        }
        if (e?.parts?.length) {
          evaluateCall({
            callSid: CallSid, recordingSid: RecordingSid,
            duration: RecordingDuration ? parseInt(RecordingDuration) : null,
            e: { parts: e.parts, line: e.line || inboundTask.line || null,
                 contactId: inboundTask.contact_id, contactName: inboundTask.contact_name,
                 phone: last10(inboundTask.from_number), repName: inboundTask.agent_name },
          }).catch(err => console.warn('call eval (webhook):', err.message))
        }
      } catch (err) { console.warn('call eval (webhook):', err.message) }
    }
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
      // Wrap-up autopilot: draft the job notes from the recording. Fire and
      // forget — a transcription failure must never break the webhook.
      // Backfill contact on any live draft that started before we knew it.
      for (const [sid, v] of _callNotes) {
        if (sid === CallSid) { if (!v.contactId) v.contactId = ac.contact_id; if (!v.phone) v.phone = last10(ac.from_number) }
      }
      const lt = _liveTx.get(CallSid)
      if (lt) { if (!lt.contactId) lt.contactId = ac.contact_id; if (!lt.phone) lt.phone = last10(ac.from_number) }
      transcribeAndDraftNotes({
        callSid: CallSid, contactId: ac.contact_id, phone: ac.from_number, mp3Url: mp3,
        duration: RecordingDuration ? parseInt(RecordingDuration) : null,
      }).catch(e => { _wu(CallSid, `error: ${e.message}`.slice(0, 200)); console.warn('wrap-up autopilot:', e.message) })
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
// Reads the call_recordings registry, then joins each recording to the
// outcome/notes the rep filed for that contact around the call — at read
// time, because the wrap-up log lands minutes AFTER the recording does.
app.get('/api/recordings', async (req, res) => {
  try {
    const { rep, direction, from, to, booked, limit = 200 } = req.query
    // Filter and sort on when the CALL happened, not when the row landed —
    // the sweep backfills old calls with a fresh created_at, which put
    // yesterday's recordings on the Today tab.
    let q = supabase.from('call_recordings').select('*')
      .order('call_started_at', { ascending: false, nullsFirst: false })
      .limit(Math.min(parseInt(limit) || 200, 500))
    if (rep) q = q.eq('rep', rep)
    if (direction) q = q.eq('direction', direction)
    if (from) q = q.gte('call_started_at', from)
    if (to) q = q.lte('call_started_at', to)
    if (booked === '1') q = q.not('st_job_id', 'is', null)
    const { data: recs, error } = await q
    if (error) throw error
    const rows = recs || []

    const cids = [...new Set(rows.map(r => r.contact_id).filter(Boolean))]
    let logs = [], cMap = new Map()
    if (cids.length) {
      const minStart = rows.reduce((m, r) => Math.min(m, Date.parse(r.call_started_at || r.created_at) || Date.now()), Date.now())
      const { data: lg } = await supabase.from('call_logs')
        .select('id, contact_id, rep, outcome, notes, created_at')
        .in('contact_id', cids)
        .gte('created_at', new Date(minStart - 5 * 60_000).toISOString())
      logs = lg || []
      const { data: cs } = await supabase.from('contacts').select('id, name, phone, external_id').in('id', cids)
      cMap = new Map((cs || []).map(c => [c.id, c]))
    }

    const out = rows.map(r => {
      const started = Date.parse(r.call_started_at || r.created_at) || 0
      // The matching log: same contact, filed between call start and +2h,
      // nearest wins (two calls to the same contact in a day stay separate).
      let log = null
      for (const l of logs) {
        if (l.contact_id !== r.contact_id) continue
        const t = Date.parse(l.created_at)
        if (t < started - 5 * 60_000 || t > started + 2 * 3600_000) continue
        if (!log || Math.abs(t - started) < Math.abs(Date.parse(log.created_at) - started)) log = l
      }
      const c = cMap.get(r.contact_id)
      return {
        ...r,
        contact_name: r.contact_name || c?.name || null,
        phone: r.phone || last10(c?.phone) || null,
        external_id: c?.external_id || null,
        rep: r.rep || log?.rep || null,
        outcome: log?.outcome || (r.st_job_id ? 'Booked' : null),
        notes: log?.notes || null,
      }
    })
    res.json({ data: out })
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
// ── ☎️ CALL ROUTING ─────────────────────────────────────────────────────────
// Everything about how inbound calls are handled lives in ONE app_settings
// JSON (key 'call_routing'), edited from Settings → Call Routing. The inbound
// webhook re-reads it (30s cache), so an admin edit is live on the next call.
// Defaults are chosen to exactly match the pre-settings behavior: open 24/7,
// same greeting, same hold music — nothing changes until an admin says so.
const HOLD_MUSIC = {
  classical:   'http://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3',
  waltz:       'http://com.twilio.music.classical.s3.amazonaws.com/ClockworkWaltz.mp3',
  ambient:     'http://com.twilio.music.ambient.s3.amazonaws.com/aerosolspray_-_Living_Taciturn.mp3',
  electronica: 'http://com.twilio.music.electronica.s3.amazonaws.com/teru_-_110_Downtempo_Electronic_4.mp3',
  guitars:     'http://com.twilio.music.guitars.s3.amazonaws.com/Pitx_-_Long_Winter.mp3',
  rock:        'http://com.twilio.music.rock.s3.amazonaws.com/nickleus_-_original_guitar_song_200907251723.mp3',
  softrock:    'http://com.twilio.music.soft-rock.s3.amazonaws.com/_ghost_-_promo_2_sample_pack.mp3',
}
// Twilio <Say> Amazon Polly neural voices — a bad voice string errors the
// whole call, so the UI only offers this vetted list (+ legacy alice).
const ROUTING_VOICES = ['Polly.Joanna-Neural', 'Polly.Matthew-Neural', 'Polly.Salli-Neural',
  'Polly.Joey-Neural', 'Polly.Kendra-Neural', 'Polly.Kimberly-Neural', 'alice']

const ROUTING_DEFAULTS = {
  voice: 'Polly.Joanna-Neural',
  hours: {
    mon: { closed: false, open: '00:00', close: '23:59' },
    tue: { closed: false, open: '00:00', close: '23:59' },
    wed: { closed: false, open: '00:00', close: '23:59' },
    thu: { closed: false, open: '00:00', close: '23:59' },
    fri: { closed: false, open: '00:00', close: '23:59' },
    sat: { closed: false, open: '00:00', close: '23:59' },
    sun: { closed: false, open: '00:00', close: '23:59' },
  },
  holidays: [],   // [{ date:'2026-11-26', name:'Thanksgiving', message:'' }]
  override: { active: false, message: '', until: null },
  greetings: {
    open: 'Thank you for calling Awesome Home Services. This call may be recorded for quality purposes. Please hold while we connect you.',
    closed: 'Thank you for calling Awesome Home Services. We are currently closed. Please leave a message and we will call you back as soon as we open.',
    holiday: '',   // empty = use the closed greeting
    voicemail: 'Please leave your name, number, and what you need help with after the tone, and we will get right back to you.',
  },
  afterHours: { action: 'forward', forwardNumber: '', floorWaitSec: 45 },
  queue: {
    holdMusic: 'classical', customMusicUrl: '',
    comfortMessage: 'Thanks for holding — the next available team member will be right with you.',
    overflow: { action: 'hold', maxWaitSec: 180, forwardNumber: '' },
  },
  voicemail: { maxSec: 120, emails: [], transcribe: true },
  // The tech line: always open, dispatchers-only, voicemail after a short
  // wait. None of the marketing/booking machinery touches these calls.
  dispatchLine: {
    greeting: 'Awesome Home Services dispatch. Hold tight — connecting you now.',
    voicemail: 'All dispatchers are on other calls. Leave your name, job number, and what you need, and dispatch will get right back to you.',
    maxWaitSec: 60,
  },
}

let _routingCache = { at: 0, cfg: null }
function mergeRouting(saved) {
  const d = JSON.parse(JSON.stringify(ROUTING_DEFAULTS))
  if (!saved || typeof saved !== 'object') return d
  for (const k of Object.keys(d)) {
    if (saved[k] == null) continue
    if (k === 'hours') { for (const day of Object.keys(d.hours)) if (saved.hours?.[day]) d.hours[day] = { ...d.hours[day], ...saved.hours[day] } }
    else if (Array.isArray(d[k])) d[k] = Array.isArray(saved[k]) ? saved[k] : d[k]
    else if (typeof d[k] === 'object') d[k] = { ...d[k], ...saved[k], ...(k === 'queue' && saved.queue?.overflow ? { overflow: { ...d.queue.overflow, ...saved.queue.overflow } } : {}) }
    else d[k] = saved[k]
  }
  if (!ROUTING_VOICES.includes(d.voice)) d.voice = ROUTING_DEFAULTS.voice
  return d
}
async function getRouting() {
  if (_routingCache.cfg && Date.now() - _routingCache.at < 30_000) return _routingCache.cfg
  let saved = null, legacyHolidays = null
  try {
    const { data } = await supabase.from('app_settings').select('key, value').in('key', ['call_routing', 'company_holidays'])
    const row = (k) => data?.find(r => r.key === k)?.value
    saved = row('call_routing') ? JSON.parse(row('call_routing')) : null
    legacyHolidays = row('company_holidays') ? JSON.parse(row('company_holidays')) : null
  } catch {}   // config unreachable → defaults; a call must never fail on this
  const cfg = mergeRouting(saved)
  // Holidays entered in the old Thresholds tab carry over until the routing
  // config saves its own list — Call Routing is the single source of truth.
  if (!cfg.holidays.length && Array.isArray(legacyHolidays)) {
    cfg.holidays = legacyHolidays.filter(h => h?.date).map(h => ({ date: h.date, name: h.name || '', message: '' }))
  }
  _routingCache = { at: Date.now(), cfg }
  return cfg
}

// Where are we right now, Denver wall clock? → { open, reason, holiday }
function routingStateNow(cfg) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).map(p => [p.type, p.value]))
  const hhmm = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`
  if (cfg.override?.active) {
    const expired = cfg.override.until && Date.parse(cfg.override.until) < Date.now()
    if (!expired) return { open: false, reason: 'override', now: hhmm, date: dateStr }
  }
  const hol = (cfg.holidays || []).find(h => h.date === dateStr)
  if (hol) return { open: false, reason: 'holiday', holiday: hol, now: hhmm, date: dateStr }
  const dayKey = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' }[parts.weekday]
  const day = cfg.hours[dayKey]
  if (!day || day.closed || hhmm < day.open || hhmm > day.close) return { open: false, reason: 'hours', now: hhmm, date: dateStr }
  return { open: true, reason: 'open', now: hhmm, date: dateStr }
}

const routingSay = (twiml, cfg, msg) => { if (msg) twiml.say({ voice: cfg.voice }, msg) }
function sendToVoicemail(twiml, cfg) {
  routingSay(twiml, cfg, cfg.greetings.voicemail)
  twiml.record({ maxLength: cfg.voicemail.maxSec || 120, playBeep: true, action: `${appUrl}/api/twilio/routing/voicemail-done` })
  routingSay(twiml, cfg, 'We did not receive a recording. Goodbye.')
}
function enqueueCall(twiml, cfg, { CallSid, From, contact, afterHours, line }) {
  const qs = [afterHours ? 'ah=1' : null, line ? `line=${line}` : null].filter(Boolean).join('&')
  const enqueue = twiml.enqueue({
    workflowSid: TWILIO_WORKFLOW_SID,
    waitUrl: `${appUrl}/api/twilio/queue/wait${qs ? `?${qs}` : ''}`,
    waitUrlMethod: 'POST',
    action: `${appUrl}/api/twilio/routing/queue-done${qs ? `?${qs}` : ''}`,
  })
  // Attributes ride along to the assignment callback and the events webhook, so
  // we know who's calling without a second lookup. `line` is what the workflow
  // routes on: 'dispatch' → the dispatchers-only queue.
  enqueue.task(JSON.stringify({
    call_sid: CallSid,
    from_number: From,
    contact_id: contact?.id || null,
    contact_name: contact?.name || null,
    ...(line ? { line } : {}),
  }))
}

// Marketing channel attribution. Dialpad strips the Diversion header
// (ForwardedFrom arrives empty — probed live), but the tracking number's ring
// lands in ST's call log WITH its campaign ~2s before the forward reaches us
// (verified: Yard Signs test, Jul 30). So: look the caller up in ST telecom
// and pin the campaign to the live call, delivered via the notes poll.
const _mktChannel = new Map()   // last10(caller) -> { name, at }
async function lookupSTChannel(fromNumber) {
  const p10 = last10(fromNumber)
  if (!p10) return
  for (const delay of [1500, 6000, 15000]) {   // ST usually has it by the first try
    await new Promise(r => setTimeout(r, delay))
    try {
      const since = new Date(Date.now() - 10 * 60_000).toISOString()
      const d = await stGet(`/telecom/v2/tenant/${ST_TENANT_ID}/calls?createdOnOrAfter=${encodeURIComponent(since)}&pageSize=50`)
      const hit = (d?.data || [])
        .map(c => c.leadCall || c)
        .filter(c => c.direction === 'Inbound' && last10(c.from) === p10 && c.campaign?.name)
        .sort((a, b) => Date.parse(b.receivedOn || 0) - Date.parse(a.receivedOn || 0))[0]
      if (hit) {
        _mktChannel.set(p10, { name: hit.campaign.name, id: hit.campaign.id || null, at: Date.now() })
        if (_mktChannel.size > 200) { for (const [k, v] of _mktChannel) if (Date.now() - v.at > 3600_000) _mktChannel.delete(k) }
        return
      }
    } catch (e) { console.warn('ST channel lookup:', e.message) }
  }
}

// Attribution probe: trace the last 20 inbound calls (ForwardedFrom stayed
// null through Dialpad — kept for future carriers) — /api/call-notes/health.
const _fwdTrace = []
app.post('/api/twilio/inbound', async (req, res) => {
  const { From, CallSid } = req.body
  console.log(`Inbound call from ${From}, SID: ${CallSid}`)
  _fwdTrace.unshift({
    at: new Date().toISOString(), from: From || null, to: req.body.To || null,
    forwardedFrom: req.body.ForwardedFrom || null, calledVia: req.body.CalledVia || null,
  })
  if (_fwdTrace.length > 20) _fwdTrace.pop()
  const isDispatch = last10(req.body.To || '') === last10(DISPATCH_NUMBER)
  if (!isDispatch) lookupSTChannel(From).catch(() => {})   // marketing attribution is a customer-line thing
  const normalizedPhone = (From || '').replace(/\D/g, '').slice(-10)

  let contact = null
  if (normalizedPhone) {
    const { data } = await supabase.from('contacts').select('id, name')
      .ilike('phone', `%${normalizedPhone}%`).limit(1).maybeSingle()
    contact = data
  }

  const cfg = await getRouting()
  const state = routingStateNow(cfg)
  const twiml = new VoiceResponse()

  // ── Dispatch line: techs calling in. Always open (no hours/holiday check),
  // routed to the dispatchers-only queue, voicemail after a short wait.
  if (isDispatch) {
    // Leading pause: forwarded calls (Dialpad) finish bridging a beat after
    // Twilio answers — TTS that starts instantly gets its first words clipped
    // ("the greeting has broken up").
    twiml.pause({ length: 1 })
    if (!TWILIO_WORKFLOW_SID) {
      routingSay(twiml, cfg, cfg.dispatchLine.voicemail)
      twiml.record({ maxLength: cfg.voicemail.maxSec || 120, playBeep: true, action: `${appUrl}/api/twilio/routing/voicemail-done` })
    } else {
      routingSay(twiml, cfg, cfg.dispatchLine.greeting)
      enqueueCall(twiml, cfg, { CallSid, From, contact, line: 'dispatch' })
    }
    res.type('text/xml')
    return res.send(twiml.toString())
  }

  // Same leading pause for the main line — forwarded legs clip instant TTS.
  twiml.pause({ length: 1 })

  // Closed — emergency override, holiday, or outside hours.
  if (!state.open) {
    const msg = state.reason === 'override' ? (cfg.override.message || cfg.greetings.closed)
      : state.reason === 'holiday' ? (state.holiday?.message || cfg.greetings.holiday || cfg.greetings.closed)
      : cfg.greetings.closed
    routingSay(twiml, cfg, msg)
    const act = cfg.afterHours.action
    if (act === 'forward' && cfg.afterHours.forwardNumber) {
      const dial = twiml.dial({
        timeout: 25, callerId: twilioPhone,
        action: `${appUrl}/api/twilio/routing/forward-result`,
        record: 'record-from-answer-dual',
        recordingStatusCallback: `${appUrl}/api/twilio/recording`,
        recordingStatusCallbackEvent: 'completed',
      })
      dial.number(cfg.afterHours.forwardNumber)
    } else if (act === 'floor' && TWILIO_WORKFLOW_SID) {
      enqueueCall(twiml, cfg, { CallSid, From, contact, afterHours: true })
    } else {
      sendToVoicemail(twiml, cfg)
    }
    res.type('text/xml')
    return res.send(twiml.toString())
  }

  // Open — greet and queue to the floor.
  if (!TWILIO_WORKFLOW_SID) {
    console.error('TWILIO_WORKFLOW_SID not set — inbound call cannot be queued')
    routingSay(twiml, cfg, cfg.greetings.closed)
    sendToVoicemail(twiml, cfg)
    res.type('text/xml')
    return res.send(twiml.toString())
  }
  routingSay(twiml, cfg, cfg.greetings.open)
  enqueueCall(twiml, cfg, { CallSid, From, contact, afterHours: false })

  res.type('text/xml')
  res.send(twiml.toString())
})

// Hold loop. Twilio re-requests this each time the track finishes, which is
// what lets the overflow check run — QueueTime rides in on every request.
app.post('/api/twilio/queue/wait', async (req, res) => {
  const cfg = await getRouting()
  const twiml = new VoiceResponse()
  const waited = parseInt(req.body?.QueueTime || '0') || 0
  const afterHours = req.query.ah === '1'
  const isDispatch = req.query.line === 'dispatch'
  // Dispatch line and after-hours "try the floor" cap the wait hard; during
  // open hours the overflow setting decides (hold = never leave).
  const maxWait = isDispatch ? (cfg.dispatchLine.maxWaitSec || 60)
    : afterHours ? (cfg.afterHours.floorWaitSec || 45)
    : cfg.queue.overflow.action !== 'hold' ? (cfg.queue.overflow.maxWaitSec || 180)
    : null
  if (maxWait != null && waited >= maxWait) {
    twiml.leave()
  } else {
    if (waited > 0) routingSay(twiml, cfg, cfg.queue.comfortMessage)
    const music = cfg.queue.holdMusic === 'custom' && cfg.queue.customMusicUrl
      ? cfg.queue.customMusicUrl : (HOLD_MUSIC[cfg.queue.holdMusic] || HOLD_MUSIC.classical)
    twiml.play(music)
  }
  res.type('text/xml')
  res.send(twiml.toString())
})

// The call left the queue. 'bridged' fires after a normal answered call ends
// (nothing to do); 'leave' means the overflow pulled them out — route it;
// 'hangup' means the caller gave up — kill any rep leg still ringing at them.
app.post('/api/twilio/routing/queue-done', async (req, res) => {
  // Park in progress? The rep leg was just redirected into the conference —
  // this (customer) leg follows it there instead of hanging up.
  const ctl = ctlOf(req.body?.CallSid)
  if (ctl?.pendingConf) {
    res.type('text/xml')
    return res.send(confTwiml(ctl.confName, true))
  }
  const cfg = await getRouting()
  const twiml = new VoiceResponse()
  const result = req.body?.QueueResult
  if (result === 'leave' && req.query.line === 'dispatch') {
    // No dispatcher grabbed it in time — dispatch voicemail, not the CSR flow.
    routingSay(twiml, cfg, cfg.dispatchLine.voicemail)
    twiml.record({ maxLength: cfg.voicemail.maxSec || 120, playBeep: true, action: `${appUrl}/api/twilio/routing/voicemail-done` })
    res.type('text/xml')
    return res.send(twiml.toString())
  }
  if (result === 'leave') {
    const afterHours = req.query.ah === '1'
    const act = afterHours ? 'voicemail' : cfg.queue.overflow.action
    routingSay(twiml, cfg, 'We are sorry for the wait.')
    if (act === 'forward' && cfg.queue.overflow.forwardNumber) {
      const dial = twiml.dial({
        timeout: 25, callerId: twilioPhone,
        action: `${appUrl}/api/twilio/routing/forward-result`,
        record: 'record-from-answer-dual',
        recordingStatusCallback: `${appUrl}/api/twilio/recording`,
        recordingStatusCallbackEvent: 'completed',
      })
      dial.number(cfg.queue.overflow.forwardNumber)
    } else {
      sendToVoicemail(twiml, cfg)
    }
  }
  res.type('text/xml')
  res.send(twiml.toString())

  // Ghost-ring killer. The dequeue instruction ACCEPTS the reservation the
  // moment TaskRouter offers it, so a caller who hangs up while the rep's
  // browser is still ringing leaves TaskRouter nothing pending to cancel —
  // the client: leg keeps ringing at a dead call for its full timeout. The
  // dequeue leg carries the CALLER's number as From (set in the assignment
  // response), so find any still-ringing client legs from them and end them.
  if (result === 'hangup' || result === 'error') {
    const from = req.body?.From
    if (!from) return
    const sweep = async () => {
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
      for (const status of ['ringing', 'queued']) {
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json?From=${encodeURIComponent(from)}&Status=${status}&PageSize=20`,
          { headers: { Authorization: `Basic ${auth}` } })
        const legs = ((await r.json()).calls || []).filter(c => String(c.to || '').startsWith('client:'))
        for (const c of legs) {
          await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${c.sid}.json`, {
            method: 'POST',
            headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ Status: 'completed' }),
          })
          console.log(`ghost ring canceled: ${c.sid} → ${c.to} (caller ${from} hung up in queue)`)
        }
      }
    }
    // Twice: now, and again in 4s for a leg that was mid-creation at hangup.
    sweep().catch(e => console.warn('ghost ring sweep:', e.message))
    setTimeout(() => sweep().catch(e => console.warn('ghost ring sweep:', e.message)), 4000)
  }
})

// After a forward attempt: answered → done; anything else → voicemail.
app.post('/api/twilio/routing/forward-result', async (req, res) => {
  const cfg = await getRouting()
  const twiml = new VoiceResponse()
  if (req.body?.DialCallStatus !== 'completed') sendToVoicemail(twiml, cfg)
  res.type('text/xml')
  res.send(twiml.toString())
})

// Voicemail landed: thank the caller, then (async) register the recording,
// transcribe it, and notify the team.
app.post('/api/twilio/routing/voicemail-done', async (req, res) => {
  const cfg = await getRouting()
  const twiml = new VoiceResponse()
  routingSay(twiml, cfg, 'Thank you. We will get back to you as soon as possible. Goodbye.')
  twiml.hangup()
  res.type('text/xml')
  res.send(twiml.toString())

  try {
    const { RecordingUrl, RecordingSid, RecordingDuration, From, CallSid } = req.body
    if (!RecordingUrl || !RecordingSid) return
    const mp3 = `${RecordingUrl}.mp3`
    const phone = last10(From)
    let contact = null
    if (phone) {
      const { data: cands } = await supabase.from('contacts').select('id, name, phone').ilike('phone', `%${phone.slice(-4)}%`).limit(50)
      contact = (cands || []).find(x => last10(x.phone) === phone) || null
    }
    await saveRecording({
      recording_sid: RecordingSid, call_sid: CallSid, url: mp3,
      duration: RecordingDuration ? parseInt(RecordingDuration) : null,
      direction: 'voicemail', rep: null,
      contact_id: contact?.id || null, contact_name: contact?.name || null,
      phone: phone || null, call_started_at: new Date().toISOString(),
    })

    let transcript = null
    if (cfg.voicemail.transcribe && OPENAI_KEY) {
      try {
        const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
        const audioRes = await fetch(mp3, { headers: { Authorization: `Basic ${auth}` } })
        if (audioRes.ok) {
          const fd = new FormData()
          fd.append('file', new Blob([Buffer.from(await audioRes.arrayBuffer())], { type: 'audio/mpeg' }), 'vm.mp3')
          fd.append('model', 'whisper-1')
          fd.append('language', 'en')
          const wRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: fd,
          })
          if (wRes.ok) transcript = (await wRes.json())?.text || null
        }
      } catch (e) { console.warn('voicemail transcribe:', e.message) }
      if (transcript) {
        await supabase.from('call_recordings').update({ transcript }).eq('recording_sid', RecordingSid)
          .then(({ error }) => { if (error) console.warn('voicemail transcript save:', error.message) })
      }
    }

    const emails = (cfg.voicemail.emails || []).filter(Boolean)
    if (emails.length) {
      const who = contact?.name ? `${contact.name} (${phone})` : (From || 'Unknown caller')
      const dur = RecordingDuration ? `${RecordingDuration}s` : ''
      await sendResend({
        to: emails,
        subject: `New voicemail from ${who}`,
        html: `<p><b>${esc2(who)}</b> left a ${dur} voicemail.</p>` +
          (transcript ? `<p style="padding:10px 14px;background:#f4f4f5;border-radius:8px">${esc2(transcript)}</p>` : '') +
          `<p><a href="${appUrl}/recordings">Listen in Andi → Recordings</a></p>`,
      }).catch(e => console.warn('voicemail email:', e.message))
    }
  } catch (err) { console.warn('voicemail-done:', err.message) }
})

// ── Admin: read/write the routing config ────────────────────────────────────
app.get('/api/admin/call-routing', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  const cfg = await getRouting()
  res.json({ cfg, state: routingStateNow(cfg), musicOptions: Object.keys(HOLD_MUSIC), voices: ROUTING_VOICES })
})
app.post('/api/admin/call-routing', async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  try {
    const cfg = mergeRouting(req.body?.cfg)
    const { error } = await supabase.from('app_settings')
      .upsert({ key: 'call_routing', value: JSON.stringify(cfg) }, { onConflict: 'key' })
    if (error) throw error
    _routingCache = { at: 0, cfg: null }   // next call reads the new config
    res.json({ ok: true, cfg, state: routingStateNow(cfg) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── 📞 HOLD & TRANSFER ──────────────────────────────────────────────────────
// A plain <Dial> bridge can't hold or add parties, so the first hold/transfer
// op "parks" the call: the CHILD leg is REST-redirected into a conference and
// the PARENT falls through its dial/enqueue action (after-dial / queue-done),
// which answers with the same conference. Outbound: parent = rep's browser,
// child = customer. Inbound (TaskRouter): parent = customer, child = rep.
// From there hold is a participant flag and transfers are added participants.
const _callCtl = new Map()   // any leg sid → shared ctl object
const ctlOf = (sid) => _callCtl.get(String(sid || '')) || null
const _recStarted = new Set()   // customer legs we've started a REST recording on

async function twApi(method, path, form) {
  let body
  if (form) {
    // Twilio wants repeated params for multi-value fields (StatusCallbackEvent)
    // — a space-joined string is silently ignored.
    body = new URLSearchParams()
    for (const [k, v] of Object.entries(form)) {
      if (Array.isArray(v)) v.forEach(x => body.append(k, x))
      else body.append(k, v)
    }
  }
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}${path}`, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  })
  const text = await r.text()
  let d = {}
  try { d = JSON.parse(text) } catch {}
  if (!r.ok) throw new Error(d.message || `Twilio ${r.status}`)
  return d
}

const confTwiml = (confName, endOnExit) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="${endOnExit}" waitUrl="">${confName}</Conference></Dial></Response>`

async function resolveCtl(browserSid) {
  const existing = ctlOf(browserSid)
  if (existing) return existing
  if (_callCtl.size > 400) {   // stale-entry sweep
    for (const [k, v] of _callCtl) if (Date.now() - v.at > 6 * 3600_000) _callCtl.delete(k)
  }
  const me = await twApi('GET', `/Calls/${browserSid}.json`)
  let customerSid, direction
  if (me.parent_call_sid) {           // inbound with real parentage
    customerSid = me.parent_call_sid
    direction = 'inbound'
  } else if (String(me.to || '').startsWith('client:')) {
    // TaskRouter dequeue leg: an independent call to the rep's browser with
    // NO parent linkage (verified live) — but its From is the CALLER's own
    // number, so the customer's in-progress leg is findable by number.
    direction = 'inbound'
    if (me.from) {
      const cand = await twApi('GET', `/Calls.json?From=${encodeURIComponent(me.from)}&To=${encodeURIComponent(twilioPhone)}&Status=in-progress&PageSize=5`)
      customerSid = ((cand.calls || []).find(c => c.sid !== browserSid) || {}).sid
    }
    if (!customerSid) {
      // Fallback: the answered call_task recorded the customer leg sid.
      const ident = String(me.to).slice(7)
      const { data: ct } = await supabase.from('call_tasks')
        .select('call_sid, from_number, agent_name, answered_at')
        .eq('state', 'answered').order('answered_at', { ascending: false }).limit(5)
      const hit = (ct || []).find(t =>
        (me.from && last10(t.from_number) === last10(me.from)) ||
        String(t.agent_name || '').replace(/[^a-zA-Z0-9_]/g, '_') === ident)
      customerSid = hit?.call_sid
    }
    if (!customerSid) throw new Error('Could not find the customer side of this call')
  } else {                            // outbound: the customer is the child
    const kids = await twApi('GET', `/Calls.json?ParentCallSid=${browserSid}&PageSize=5`)
    const live = (kids.calls || []).find(c => c.status === 'in-progress')
    if (!live) {
      const stillRinging = (kids.calls || []).some(c => ['ringing', 'queued', 'initiated'].includes(c.status))
      throw new Error(stillRinging ? 'The customer has not answered yet' : 'No live customer leg on this call')
    }
    customerSid = live.sid
    direction = 'outbound'
  }
  const ctl = {
    confName: `ctl_${customerSid}`, customerSid, repSid: browserSid, direction,
    parked: false, pendingConf: false, held: false, confSid: null, target: null, at: Date.now(),
  }
  _callCtl.set(customerSid, ctl)
  _callCtl.set(browserSid, ctl)
  return ctl
}

async function parkCall(ctl) {
  if (ctl.parked) return
  ctl.pendingConf = true
  // Redirect the CHILD leg; the parent's action callback joins right after.
  const childSid = ctl.direction === 'outbound' ? ctl.customerSid : ctl.repSid
  const endOnExit = ctl.direction === 'outbound'   // the customer leaving always ends it
  await twApi('POST', `/Calls/${childSid}.json`, { Twiml: confTwiml(ctl.confName, endOnExit) })
  for (let i = 0; i < 14; i++) {
    await new Promise(r => setTimeout(r, 500))
    try {
      const d = await twApi('GET', `/Conferences.json?FriendlyName=${encodeURIComponent(ctl.confName)}&Status=in-progress`)
      const conf = (d.conferences || [])[0]
      if (conf) {
        const parts = await twApi('GET', `/Conferences/${conf.sid}/Participants.json`)
        if ((parts.participants || []).length >= 2) { ctl.confSid = conf.sid; ctl.parked = true; return }
      }
    } catch {}
  }
  throw new Error('Could not move the call into hold mode — try again')
}

async function setCtlHold(ctl, on) {
  await twApi('POST', `/Conferences/${ctl.confSid}/Participants/${ctl.customerSid}.json`, {
    Hold: on ? 'True' : 'False',
    ...(on ? { HoldUrl: `${appUrl}/api/twilio/routing/hold-music`, HoldMethod: 'POST' } : {}),
  })
  ctl.held = on
}

app.post('/api/twilio/call/hold', async (req, res) => {
  try {
    const ctl = await resolveCtl(req.body?.callSid)
    await parkCall(ctl)
    await setCtlHold(ctl, req.body?.hold !== false)
    res.json({ ok: true, held: ctl.held })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/twilio/call/transfer', async (req, res) => {
  try {
    const { callSid, to, label, mode, fromIdentity } = req.body || {}
    if (!to) return res.status(400).json({ error: 'Transfer target required' })
    const ctl = await resolveCtl(callSid)
    await parkCall(ctl)
    await setCtlHold(ctl, true)
    const isClient = String(to).startsWith('client:')
    const p = await twApi('POST', `/Conferences/${ctl.confSid}/Participants.json`, {
      From: isClient ? `client:${String(fromIdentity || 'Andi').replace(/[^a-zA-Z0-9_]/g, '_')}` : twilioPhone,
      To: to,
      Timeout: '30',
      EndConferenceOnExit: 'false',
      Beep: 'false',
      StatusCallback: `${appUrl}/api/twilio/call/target-events`,
      StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    })
    ctl.target = { sid: p.call_sid, to, label: label || to, mode: mode === 'cold' ? 'cold' : 'warm', status: 'calling' }
    _callCtl.set(p.call_sid, ctl)
    res.json({ ok: true, target: ctl.target })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Warm consult done — let the customer through; the client drops the rep leg.
app.post('/api/twilio/call/transfer/complete', async (req, res) => {
  try {
    const ctl = ctlOf(req.body?.callSid)
    if (!ctl?.parked) return res.status(400).json({ error: 'No transfer in progress' })
    await setCtlHold(ctl, false)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/twilio/call/transfer/cancel', async (req, res) => {
  try {
    const ctl = ctlOf(req.body?.callSid)
    if (!ctl) return res.status(400).json({ error: 'No call control state' })
    if (ctl.target?.sid) { try { await twApi('DELETE', `/Conferences/${ctl.confSid}/Participants/${ctl.target.sid}.json`) } catch {} }
    ctl.target = null
    await setCtlHold(ctl, false)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/twilio/call/ctl-state', async (req, res) => {
  const ctl = ctlOf(req.query.callSid)
  if (!ctl) return res.json({})
  // Belt and suspenders: callbacks can drop, so while a consult leg is up,
  // refresh its status straight from Twilio and run the same transitions.
  if (ctl.target?.sid && !['left', 'failed'].includes(ctl.target.status)) {
    try {
      const c = await twApi('GET', `/Calls/${ctl.target.sid}.json`)
      if (c.status === 'ringing') ctl.target.status = 'ringing'
      else if (c.status === 'in-progress') {
        if (ctl.target.status !== 'connected') {
          ctl.target.status = 'connected'
          if (ctl.target.mode === 'cold') await setCtlHold(ctl, false).catch(() => {})
        }
      } else if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(c.status)) {
        ctl.target.status = ctl.target.status === 'connected' ? 'left' : 'failed'
      }
    } catch {}
  }
  res.json({ parked: ctl.parked, held: ctl.held, target: ctl.target })
})

// Transfer-target call progress (participant statusCallback).
app.post('/api/twilio/call/target-events', async (req, res) => {
  res.sendStatus(200)
  try {
    const { CallSid, CallStatus } = req.body
    const ctl = ctlOf(CallSid)
    if (!ctl?.target || ctl.target.sid !== CallSid) return
    if (CallStatus === 'ringing') ctl.target.status = 'ringing'
    else if (CallStatus === 'in-progress') {
      ctl.target.status = 'connected'
      if (ctl.target.mode === 'cold') await setCtlHold(ctl, false).catch(() => {})
    } else if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(CallStatus)) {
      const wasConnected = ctl.target.status === 'connected'
      const wasCold = ctl.target.mode === 'cold'
      ctl.target = { ...ctl.target, status: wasConnected ? 'left' : 'failed' }
      if (!wasConnected && wasCold) {
        // Cold transfer failed with the rep already gone — never strand the
        // customer on hold: apologize and take a voicemail.
        try {
          const cfg = await getRouting()
          const rescue = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${cfg.voice}">We are sorry, we could not complete the transfer. ${esc2(cfg.greetings.voicemail)}</Say><Record maxLength="${cfg.voicemail.maxSec || 120}" playBeep="true" action="${appUrl}/api/twilio/routing/voicemail-done"/></Response>`
          await twApi('POST', `/Calls/${ctl.customerSid}.json`, { Twiml: rescue })
        } catch (e) { console.warn('cold-transfer rescue:', e.message) }
      }
    }
  } catch (e) { console.warn('target-events:', e.message) }
})

// Hold music for parked customers — same music the queue uses.
app.post('/api/twilio/routing/hold-music', async (req, res) => {
  const cfg = await getRouting()
  const twiml = new VoiceResponse()
  const music = cfg.queue.holdMusic === 'custom' && cfg.queue.customMusicUrl
    ? cfg.queue.customMusicUrl : (HOLD_MUSIC[cfg.queue.holdMusic] || HOLD_MUSIC.classical)
  twiml.play({ loop: 0 }, music)
  res.type('text/xml')
  res.send(twiml.toString())
})

// Outbound parent lands here when its child leg leaves the bridge — either a
// normal hangup (empty response, same as before) or a park in progress.
app.post('/api/twilio/routing/after-dial', (req, res) => {
  const ctl = ctlOf(req.body?.CallSid)
  res.type('text/xml')
  if (ctl?.pendingConf) return res.send(confTwiml(ctl.confName, false))
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response/>')
})

// Browser-side call quality warnings — "calls are choppy" becomes whose
// network, when, and what kind. Last 50 in memory, visible in health.
const _netTrace = []
app.post('/api/twilio/net-warning', (req, res) => {
  res.json({ ok: true })
  _netTrace.unshift({ at: new Date().toISOString(), rep: String(req.body?.rep || '').slice(0, 60), warning: String(req.body?.warning || '').slice(0, 60) })
  if (_netTrace.length > 50) _netTrace.pop()
})

// Mark a voicemail heard (clears the New badge for everyone).
app.post('/api/recordings/heard', async (req, res) => {
  try {
    const { id } = req.body || {}
    if (!id) return res.status(400).json({ error: 'id required' })
    await supabase.from('call_recordings').update({ heard_at: new Date().toISOString() }).eq('id', id)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
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
      // NO record key here, deliberately. Its value proved unreliable for
      // recording (zero recordings Jul 31) and 'do-not-record' is flat-out
      // INVALID for a dequeue instruction — TaskRouter rejected the whole
      // assignment and reps stopped ringing. Absence = no recording;
      // reservation.accepted REST-records the customer leg instead.
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
      const row = {
        task_sid: taskSid,
        call_sid: attrs.call_sid || null,
        from_number: attrs.from_number || null,
        contact_id: attrs.contact_id || null,
        contact_name: attrs.contact_name || null,
        state: 'queued',
        queued_at: now,
      }
      // `line` is a newer column — retry without it until the migration runs.
      const { error: ctErr } = await supabase.from('call_tasks').upsert({ ...row, line: attrs.line || null }, { onConflict: 'task_sid' })
      if (ctErr) await supabase.from('call_tasks').upsert(row, { onConflict: 'task_sid' })
      return
    }

    if (type === 'reservation.accepted') {
      let wattrs = {}
      try { wattrs = JSON.parse(req.body.WorkerAttributes || '{}') } catch {}
      const { data: task } = await supabase.from('call_tasks')
        .select('queued_at, contact_id, from_number').eq('task_sid', taskSid).maybeSingle()
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
      // Inbound answered -> live note-taking on the caller's leg. The contact
      // is on the call_tasks row we just read — active_calls has been empty
      // for inbound since the TaskRouter migration.
      try {
        const tattrs = JSON.parse(req.body.TaskAttributes || '{}')
        if (tattrs.call_sid) {
          // Record the customer leg the moment a rep accepts. Twilio calls
          // /api/twilio/recording on completion, which registers it, drafts
          // notes, and triggers the QA eval.
          if (!_recStarted.has(tattrs.call_sid)) {
            _recStarted.add(tattrs.call_sid)
            if (_recStarted.size > 500) _recStarted.delete(_recStarted.values().next().value)
            twApi('POST', `/Calls/${tattrs.call_sid}/Recordings.json`, {
              RecordingChannels: 'dual',
              RecordingStatusCallback: `${appUrl}/api/twilio/recording`,
              RecordingStatusCallbackEvent: ['completed'],
            }).catch(e => console.warn('inbound recording start:', e.message))
          }
          startLiveTranscription(tattrs.call_sid, task?.contact_id || null, 'inbound',
            task?.from_number || tattrs.from_number, wattrs.name || req.body.WorkerName || null).catch(() => {})
          // Dispatch-line calls skip the customer-call machinery (coach,
          // booking classifier, QA evals) — flag the live entry.
          if (tattrs.line === 'dispatch') {
            const lt = _liveTx.get(tattrs.call_sid)
            if (lt) lt.line = 'dispatch'
          }
        }
      } catch (e) { console.warn('inbound live-tx:', e.message) }
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
      const graceS = Number((await getOpsConfig()).abandonGraceSeconds ?? ABANDON_GRACE_SECONDS)
      const isAbandon = !task?.answered_at && waited >= graceS
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
  const { CallSid, CallStatus, Duration, ParentCallSid } = req.body
  // Outbound leg just connected -> begin live note-taking. The active_calls
  // row is keyed by the PARENT (browser) leg; the transcription rides the
  // child (customer) leg, which carries both tracks.
  if (CallStatus === 'in-progress') {
    const { data: ac } = await supabase.from('active_calls').select('contact_id, to_number, from_number, rep_identity, contact_name')
      .in('call_sid', [ParentCallSid || '', CallSid].filter(Boolean)).not('contact_id', 'is', null).limit(1).maybeSingle()
    startLiveTranscription(CallSid, ac?.contact_id || null, 'outbound', ac?.to_number || req.body.To,
      ac?.rep_identity ? String(ac.rep_identity).replace(/_/g, ' ') : null, ac?.contact_name || null).catch(() => {})
  }
  // Outbound rows are keyed by the PARENT (browser) leg but the status
  // callbacks fire from the CHILD leg — matching only CallSid left every
  // outbound row stuck at 'initiated' forever (the TV counted 7 live calls
  // on an empty floor). Match either leg.
  await supabase.from('active_calls').update({
    status: CallStatus,
    duration: Duration ? parseInt(Duration) : null,
    ended_at: ['completed','failed','busy','no-answer','canceled'].includes(CallStatus) ? new Date().toISOString() : null,
  }).in('call_sid', [CallSid, ParentCallSid].filter(Boolean))
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
    if (w && Number(w.expectedValue) >= 0) return { expectedValue: +w.expectedValue, closeRate: +w.closeRate, membership: +w.membership, reviews: +(w.reviews || 0) }
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

let _reviewsFetchError = null   // surfaced in tech_review_stats for diagnosis
async function fetchDispatchWindow(days = DISPATCH_WINDOW_DAYS) {
  _reviewsFetchError = null
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const [jobs, estimates, invoices, memberships, buRes, jtRes, reviews] = await Promise.all([
    stPageAll(p => `/jpm/v2/tenant/${ST_TENANT_ID}/jobs?jobStatus=Completed&completedOnOrAfter=${since}&pageSize=200&page=${p}`, 20000),
    stPageAll(p => `/sales/v2/tenant/${ST_TENANT_ID}/estimates?createdOnOrAfter=${since}&pageSize=500&page=${p}`, 20000),
    stPageAll(p => `/accounting/v2/tenant/${ST_TENANT_ID}/invoices?createdOnOrAfter=${since}&pageSize=500&page=${p}`, 20000),
    stPageAll(p => `/memberships/v2/tenant/${ST_TENANT_ID}/memberships?createdOnOrAfter=${since}&pageSize=500&page=${p}`, 20000),
    stGet(`/settings/v2/tenant/${ST_TENANT_ID}/technicians?pageSize=500`),
    stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/job-types?pageSize=500`),
    // Marketing Reputation: Google/Facebook reviews, ~2/3 matched to a tech.
    stPageAll(p => `/marketingreputation/v2/tenant/${ST_TENANT_ID}/reviews?fromDate=${since}&pageSize=200&page=${p}`, 20000).catch(e => { _reviewsFetchError = e.message; console.warn('reviews fetch:', e.message); return [] }),
  ])
  const appts = await stPageAll(p => `/jpm/v2/tenant/${ST_TENANT_ID}/appointments?startsOnOrAfter=${since}T00:00:00Z&pageSize=500&page=${p}`, 20000)
  const assignments = await assignmentsForAppointments(appts.map(a => a.id))
  return { jobs, estimates, invoices, memberships, assignments, reviews,
           technicians: buRes?.data || [], jobTypes: jtRes?.data || [] }
}

// ═══ SHIFT SWAPS ════════════════════════════════════════════════════════════
// Trade ("my Tue for your Thu") or give-away (someone takes my shift). The
// co-worker agrees FIRST, then the requester's manager (any admin as backup)
// — so management only ever sees deals both parties already want. Approval
// physically swaps the schedule rows. 24-hour cutoff before the earliest
// involved shift, on the Denver clock.

const denverNowParts = (offsetMs = 0) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).formatToParts(new Date(Date.now() + offsetMs)).map(p => [p.type, p.value]))

const afterSwapCutoff = (date, shiftStart) => {
  const c = denverNowParts(24 * 3600e3)
  const cd = `${c.year}-${c.month}-${c.day}`
  return date > cd || (date === cd && String(shiftStart || '23:59') >= `${c.hour}:${c.minute}`)
}

const getScheduleRow = async (profileId, date) => {
  const row = (await supabase.from('schedules').select('*').eq('profile_id', profileId).eq('date', date).maybeSingle()).data
  // Drafts don't exist yet as far as swaps are concerned.
  if (row && 'published_at' in row && !row.published_at) return null
  return row
}

const shiftFieldsOf = (r) => ({
  day_type: 'work',
  shift_start: r.shift_start, shift_end: r.shift_end,
  break1_start: r.break1_start, break1_end: r.break1_end, break1_duration: r.break1_duration,
  break2_start: r.break2_start, break2_end: r.break2_end, break2_duration: r.break2_duration,
  lunch_start: r.lunch_start, lunch_end: r.lunch_end, lunch_duration: r.lunch_duration,
  template_color: r.template_color,
})

const swapEmail = async (to, subject, bodyHtml) => {
  if (!to) return
  await sendResend({
    to, subject,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px 20px;color:#111827;">
  <div style="font-size:20px;font-weight:800;color:#ff751f;margin-bottom:10px;">andi</div>
  ${bodyHtml}
  <p style="margin:20px 0;"><a href="${appUrl}/mypage?tab=team-schedule" style="background:#ff751f;color:#fff;text-decoration:none;font-size:13px;font-weight:700;padding:10px 20px;border-radius:8px;">Open in Andi</a></p>
</div>`,
  }).catch(e => console.warn('swap email:', e.message))
}

app.post('/api/swaps/request', async (req, res) => {
  const me = await requireUser(req, res)
  if (!me) return
  try {
    const { requesterDate, targetId, targetDate, note } = req.body || {}
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(requesterDate || ''))) return res.status(400).json({ error: 'Pick which of your shifts to swap' })
    if (!targetId || targetId === me.id) return res.status(400).json({ error: 'Pick a co-worker' })
    if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(targetDate))) return res.status(400).json({ error: 'Bad trade date' })

    const { data: target } = await supabase.from('profiles').select('id, name, email, active').eq('id', targetId).maybeSingle()
    if (!target || target.active === false) return res.status(400).json({ error: 'That co-worker is not active' })

    const mine = await getScheduleRow(me.id, requesterDate)
    if (!mine || (mine.day_type && mine.day_type !== 'work') || !mine.shift_start) {
      return res.status(400).json({ error: `You don't have a work shift on ${requesterDate}` })
    }
    if (!afterSwapCutoff(requesterDate, mine.shift_start)) {
      return res.status(400).json({ error: 'Swaps need to be requested more than 24 hours before the shift — for anything sooner, call your manager.' })
    }
    const theirsOnMyDay = await getScheduleRow(targetId, requesterDate)
    if (theirsOnMyDay?.shift_start && (!theirsOnMyDay.day_type || theirsOnMyDay.day_type === 'work')) {
      return res.status(400).json({ error: `${target.name || 'They'} already work${targetDate ? '' : 's'} on ${requesterDate} — they can't take your shift too.` })
    }
    if (targetDate) {
      const theirs = await getScheduleRow(targetId, targetDate)
      if (!theirs || (theirs.day_type && theirs.day_type !== 'work') || !theirs.shift_start) {
        return res.status(400).json({ error: `${target.name || 'They'} don't have a work shift on ${targetDate}` })
      }
      if (!afterSwapCutoff(targetDate, theirs.shift_start)) {
        return res.status(400).json({ error: 'The shift you want in trade starts within 24 hours — too late to swap it.' })
      }
      const mineOnTheirDay = await getScheduleRow(me.id, targetDate)
      if (mineOnTheirDay?.shift_start && (!mineOnTheirDay.day_type || mineOnTheirDay.day_type === 'work')) {
        return res.status(400).json({ error: `You already work on ${targetDate} — you can't take their shift too.` })
      }
    }

    const { data: dupes } = await supabase.from('shift_swaps').select('id')
      .eq('requester_id', me.id).eq('requester_date', requesterDate)
      .in('status', ['pending_peer', 'pending_manager'])
    if (dupes?.length) return res.status(400).json({ error: 'You already have a pending swap for that shift — cancel it first.' })

    const { data: row, error } = await supabase.from('shift_swaps').insert({
      requester_id: me.id, requester_date: requesterDate,
      target_id: targetId, target_date: targetDate || null,
      manager_id: me.manager_id || null,
      note: String(note || '').slice(0, 400) || null,
    }).select().single()
    if (error) throw new Error(error.message)

    const who = me.name || me.email
    await swapEmail(target.email, `${who} wants to swap a shift with you`,
      `<p style="font-size:14px;"><b>${esc2(who)}</b> is asking to ${targetDate
        ? `trade shifts: they take your <b>${esc2(targetDate)}</b> shift, you take their <b>${esc2(requesterDate)}</b> shift`
        : `give you their <b>${esc2(requesterDate)}</b> shift`}.</p>
      ${row.note ? `<p style="font-size:13px;color:#374151;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:10px 14px;">"${esc2(row.note)}"</p>` : ''}
      <p style="font-size:13px;color:#374151;">If you accept, it goes to management for the final sign-off.</p>`)
    res.json({ ok: true, swap: row })
  } catch (err) {
    console.error('swap request:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/swaps/peer', async (req, res) => {
  const me = await requireUser(req, res)
  if (!me) return
  try {
    const { id, accept } = req.body || {}
    const { data: row } = await supabase.from('shift_swaps').select('*').eq('id', id).maybeSingle()
    if (!row) return res.status(404).json({ error: 'Swap not found' })
    if (row.target_id !== me.id) return res.status(403).json({ error: 'This swap is not addressed to you' })
    if (row.status !== 'pending_peer') return res.status(400).json({ error: `Already ${row.status.replace('_', ' ')}` })

    const { data: reqr } = await supabase.from('profiles').select('id, name, email, manager_id').eq('id', row.requester_id).maybeSingle()
    if (!accept) {
      await supabase.from('shift_swaps').update({ status: 'declined', peer_decided_at: new Date().toISOString(), decided_by: me.name || me.email }).eq('id', id)
      await swapEmail(reqr?.email, `${me.name || me.email} declined your shift swap`,
        `<p style="font-size:14px;"><b>${esc2(me.name || me.email)}</b> declined the swap for <b>${esc2(row.requester_date)}</b>. Your shift is unchanged.</p>`)
      return res.json({ ok: true })
    }
    await supabase.from('shift_swaps').update({ status: 'pending_manager', peer_decided_at: new Date().toISOString() }).eq('id', id)
    // Route to the requester's manager; if none is set, every admin hears about it.
    let approvers = []
    if (row.manager_id) {
      const { data: mgr } = await supabase.from('profiles').select('email').eq('id', row.manager_id).maybeSingle()
      if (mgr?.email) approvers = [mgr.email]
    }
    if (!approvers.length) {
      const { data: admins } = await supabase.from('profiles').select('email').eq('role', 'admin').eq('active', true)
      approvers = (admins || []).map(a => a.email).filter(Boolean)
    }
    for (const to of approvers) {
      await swapEmail(to, `Shift swap needs your approval: ${reqr?.name || 'a rep'} ↔ ${me.name || me.email}`,
        `<p style="font-size:14px;"><b>${esc2(reqr?.name || reqr?.email || 'A rep')}</b> and <b>${esc2(me.name || me.email)}</b> agreed to ${row.target_date
          ? `trade: <b>${esc2(row.requester_date)}</b> ↔ <b>${esc2(row.target_date)}</b>`
          : `hand off the <b>${esc2(row.requester_date)}</b> shift`}. Both have signed off — it needs your approval.</p>`)
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('swap peer:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/swaps/decide', async (req, res) => {
  const me = await requireUser(req, res)
  if (!me) return
  try {
    const { id, decision, note } = req.body || {}
    if (!['approved', 'denied'].includes(decision)) return res.status(400).json({ error: 'Decision must be approved or denied' })
    const { data: row } = await supabase.from('shift_swaps').select('*').eq('id', id).maybeSingle()
    if (!row) return res.status(404).json({ error: 'Swap not found' })
    if (row.status !== 'pending_manager') return res.status(400).json({ error: `Not awaiting management (${row.status.replace('_', ' ')})` })
    if (row.manager_id !== me.id && me.role !== 'admin') return res.status(403).json({ error: "Only this person's manager (or an admin) can decide" })

    const [reqrRow, tgtRow] = await Promise.all([
      supabase.from('profiles').select('id, name, email').eq('id', row.requester_id).maybeSingle().then(r => r.data),
      supabase.from('profiles').select('id, name, email').eq('id', row.target_id).maybeSingle().then(r => r.data),
    ])

    if (decision === 'approved') {
      const mine = await getScheduleRow(row.requester_id, row.requester_date)
      if (!mine?.shift_start) return res.status(400).json({ error: 'The original shift no longer exists on the schedule — deny this one.' })
      if (!afterSwapCutoff(row.requester_date, mine.shift_start)) return res.status(400).json({ error: 'That shift is now inside the 24-hour window — too late to approve.' })
      const theirs = row.target_date ? await getScheduleRow(row.target_id, row.target_date) : null
      if (row.target_date && !theirs?.shift_start) return res.status(400).json({ error: "The trade-back shift no longer exists — deny this one." })

      // Physically swap: delete every row of both people on the involved
      // dates, then re-insert with traded owners. Sidesteps any unique
      // (profile,date) constraint no matter which off/pto rows exist.
      const dates = [row.requester_date, row.target_date].filter(Boolean)
      await supabase.from('schedules').delete()
        .in('profile_id', [row.requester_id, row.target_id]).in('date', dates)
      // An approved swap is agreed by both people + a manager — publish it.
      const pub = new Date().toISOString()
      const inserts = [{ profile_id: row.target_id, date: row.requester_date, ...shiftFieldsOf(mine), created_by: me.id, published_at: pub }]
      if (theirs) inserts.push({ profile_id: row.requester_id, date: row.target_date, ...shiftFieldsOf(theirs), created_by: me.id, published_at: pub })
      let { error: insErr } = await supabase.from('schedules').insert(inserts)
      if (insErr) ({ error: insErr } = await supabase.from('schedules').insert(inserts.map(({ published_at, ...r }) => r)))
      if (insErr) throw new Error('schedule swap: ' + insErr.message)
    }

    await supabase.from('shift_swaps').update({
      status: decision, decided_by: me.name || me.email, decided_at: new Date().toISOString(),
      decision_note: String(note || '').slice(0, 300) || null,
    }).eq('id', id)

    const what = row.target_date ? `${row.requester_date} ↔ ${row.target_date}` : `the ${row.requester_date} shift`
    for (const p of [reqrRow, tgtRow]) {
      await swapEmail(p?.email, `Shift swap ${decision}: ${what}`,
        `<p style="font-size:14px;">Your swap (${esc2(what)}) was <b>${decision}</b> by ${esc2(me.name || me.email)}.${decision === 'approved' ? ' The schedule has been updated.' : ' The schedule is unchanged.'}</p>
        ${note ? `<p style="font-size:13px;color:#374151;">"${esc2(note)}"</p>` : ''}`)
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('swap decide:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/swaps/cancel', async (req, res) => {
  const me = await requireUser(req, res)
  if (!me) return
  try {
    const { id } = req.body || {}
    const { data: row } = await supabase.from('shift_swaps').select('*').eq('id', id).maybeSingle()
    if (!row) return res.status(404).json({ error: 'Swap not found' })
    if (row.requester_id !== me.id && me.role !== 'admin') return res.status(403).json({ error: 'Not yours to cancel' })
    if (!['pending_peer', 'pending_manager'].includes(row.status)) return res.status(400).json({ error: `Already ${row.status}` })
    await supabase.from('shift_swaps').update({ status: 'canceled', decided_by: me.name || me.email, decided_at: new Date().toISOString() }).eq('id', id)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/swaps/mine', async (req, res) => {
  const me = await requireUser(req, res)
  if (!me) return
  try {
    const since = new Date(Date.now() - 60 * 864e5).toISOString()
    const [{ data: mine }, { data: queue }] = await Promise.all([
      supabase.from('shift_swaps').select('*')
        .or(`requester_id.eq.${me.id},target_id.eq.${me.id}`)
        .gte('created_at', since).order('created_at', { ascending: false }).limit(30),
      me.role === 'admin'
        ? supabase.from('shift_swaps').select('*').eq('status', 'pending_manager').order('created_at', { ascending: false })
        : supabase.from('shift_swaps').select('*').eq('status', 'pending_manager').eq('manager_id', me.id).order('created_at', { ascending: false }),
    ])
    res.json({ mine: mine || [], queue: queue || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/swaps/week', async (req, res) => {
  const me = await requireUser(req, res)
  if (!me) return
  try {
    const { start, end } = req.query
    const { data } = await supabase.from('shift_swaps').select('requester_id, target_id, requester_date, target_date, decided_at')
      .eq('status', 'approved')
      .or(`and(requester_date.gte.${start},requester_date.lte.${end}),and(target_date.gte.${start},target_date.lte.${end})`)
    res.json({ swaps: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

const OPP_BONUS_KEY = 'opp_watch_incentive'   // { enabled, pool, cutoff: 'HH:MM' }
const OPP_BONUS_LOG = 'opp_watch_bonus_log'   // { 'YYYY-MM-DD': { at, n, pool } } — the can't-pay-twice ledger
async function checkOppWatchBonus() {
  const { data: cfgRow } = await supabase.from('app_settings').select('value').eq('key', OPP_BONUS_KEY).maybeSingle()
  let cfg = { enabled: false, pool: 100, cutoff: '15:00' }
  try { cfg = { ...cfg, ...JSON.parse(cfgRow?.value || '{}') } } catch {}
  if (!cfg.enabled || !(Number(cfg.pool) > 0)) return

  // Everything on the Denver clock — the server runs UTC.
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date()).map(p => [p.type, p.value]))
  const today = `${parts.year}-${parts.month}-${parts.day}`
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return
  const hm = `${parts.hour}:${parts.minute}`
  if (hm < '07:00' || hm >= String(cfg.cutoff || '15:00')) return

  try {
    // Holidays live on the Call Routing config (legacy company_holidays rides
    // along inside getRouting until the new config is saved once).
    if (((await getRouting()).holidays || []).some(h => h?.date === today)) return
  } catch {}

  const { data: logRow } = await supabase.from('app_settings').select('value').eq('key', OPP_BONUS_LOG).maybeSingle()
  let log = {}
  try { log = JSON.parse(logRow?.value || '{}') } catch {}
  if (log[today]) return   // already unlocked today

  const b3 = await build3DayBoard()
  const withCapacity = (b3?.board || []).filter(t => (t.days?.[0]?.capacity || 0) > 0)
  if (!withCapacity.length) return
  if (!withCapacity.every(t => t.days[0].oppWatch)) return

  // Who shares: active reps + dispatchers with a WORK shift scheduled today.
  const [{ data: scheds }, { data: profs }] = await Promise.all([
    supabase.from('schedules').select('*').eq('date', today),
    supabase.from('profiles').select('id, name, email, role').eq('active', true),
  ])
  const eligible = new Map((profs || []).filter(p => ['rep', 'dispatcher'].includes(p.role)).map(p => [p.id, p]))
  const recipients = [...new Set((scheds || [])
    .filter(sc => (!sc.day_type || sc.day_type === 'work') && sc.shift_start && eligible.has(sc.profile_id)
      && (!('published_at' in sc) || sc.published_at))   // drafts aren't scheduled yet
    .map(sc => sc.profile_id))]
  if (!recipients.length) { console.warn('opp bonus: board unlocked but nobody scheduled — not paid'); return }

  // Claim the day in the ledger BEFORE inserting, so a crash can't double-pay.
  log[today] = { at: new Date().toISOString(), n: recipients.length, pool: Number(cfg.pool) }
  for (const k of Object.keys(log)) if (Date.now() - Date.parse(k) > 90 * 864e5) delete log[k]
  await supabase.from('app_settings').upsert({ key: OPP_BONUS_LOG, value: JSON.stringify(log) }, { onConflict: 'key' })

  // Split to exact cents — the pool must land exactly, remainder pennies to the first few.
  const cents = Math.round(Number(cfg.pool) * 100)
  const base = Math.floor(cents / recipients.length)
  let leftover = cents - base * recipients.length
  const rows = recipients.map(pid => {
    const p = eligible.get(pid)
    const c = base + (leftover-- > 0 ? 1 : 0)
    return {
      profile_id: pid,
      rep_name: p.name || p.email || null,
      // 'adjustment' keeps us inside the existing event_type vocabulary (the
      // report shows the notes for adjustments, which carry the story).
      event_type: 'adjustment',
      amount: c / 100,
      st_job_id: null, job_number: null,
      notes: `🎯 Opportunity Watch Bonus — board full across every trade before ${cfg.cutoff}, $${(cents / 100).toFixed(0)} pool split ${recipients.length} ways`,
      earned_at: new Date().toISOString(),
      also_membership: false,
    }
  })
  const { error } = await supabase.from('commissions').insert(rows)
  if (error) { console.error('opp bonus insert:', error.message); return }
  console.log(`OPP WATCH BONUS: $${cfg.pool} split ${recipients.length} ways`)
  await sendFloorAnnounce({
    to: 'all', from: 'Andi', fromId: null, kind: 'oppwatch',
    message: `OPPORTUNITY WATCH BONUS UNLOCKED! Every trade is FULL before ${cfg.cutoff}. $${(cents / 100).toFixed(0)} pool → $${(base / 100).toFixed(2)} each to the ${recipients.length} of you scheduled today. That's teamwork — keep booking strong calls!`,
  }).catch(e => console.warn('opp bonus announce:', e.message))
}

async function refreshDispatchScores() {
  const started = Date.now()
  try {
    const weights = await getDispatchWeights()
    const data = await fetchDispatchWindow()
    const ranked = computeBattingOrder(data, weights, { now: Date.now() })
    // Per-tech review stats for the UI (Batting Order column, Tech Info tab) —
    // app_settings so no schema change. Keyed by tech id; a tech on two
    // benches writes the same stats twice, harmlessly.
    try {
      const revStats = {}
      for (const r of ranked) {
        if (r.reviewsN) revStats[r.techId] = {
          n: r.reviewsN, n5: r.reviewsN5,
          avg: Math.round((r.reviewAvg || 0) * 100) / 100,
          perJobs: Math.round((r.reviewPct || 0) * 10) / 10,
        }
      }
      await supabase.from('app_settings').upsert(
        { key: 'tech_review_stats', value: JSON.stringify({
          windowDays: DISPATCH_WINDOW_DAYS, stats: revStats,
          fetched: (data.reviews || []).length,
          matched: (data.reviews || []).filter(r => r.technicianId).length,
          fetchError: _reviewsFetchError,
          at: new Date().toISOString(),
        }) }, { onConflict: 'key' })
    } catch (e) { console.warn('review stats save:', e.message) }
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
  if (!(await requireDispatch(req, res))) return
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
  if (!(await requireDispatch(req, res))) return
  try {
    const { data: rows } = await supabase.from('dispatch_jobtype_scores')
      .select('*').order('job_type').order('expected_value', { ascending: false })
    const types = [...new Set((rows || []).map(r => r.job_type))].sort()
    res.json({ types, rows: rows || [], refreshedAt: rows?.[0]?.refreshed_at || null })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/dispatch/refresh', async (req, res) => {
  if (!(await requireDispatch(req, res))) return
  try { res.json(await refreshDispatchScores()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/dispatch/weights', async (req, res) => {
  if (!(await requireDispatch(req, res))) return
  try {
    const w = req.body?.weights || {}
    const clean = {
      expectedValue: Math.max(0, Number(w.expectedValue) || 0),
      closeRate: Math.max(0, Number(w.closeRate) || 0),
      membership: Math.max(0, Number(w.membership) || 0),
      reviews: Math.max(0, Number(w.reviews) || 0),
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
// A breakdown call, as opposed to routine/maintenance work.
const DISTRESS_RE = /no.?cool|not.?cooling|no.?heat|not.?heating|no.?hot.?water|no.?power|leak|emergency|breakdown|stopped.?working|not.?working/i
const LOW_VALUE_RE = /maintenance|tune|inspection|filter|follow.?up|callback|warranty|permit/i

// Notes that say this visit collects NOTHING: warranty work, recalls, goodwill
// redos. Job #34454 is the canonical case — "Coll $: warranty" in the summary,
// booked as a normal No Cool. Still a booked call; not an opportunity.
// The OPPOSITE phrasings ("out of warranty", "warranty expired", "warranty
// disclaimer") mean the customer pays, so they must not match.
const NO_COLLECT_RE = /\bwarranty\b|\brecall\b|\bgood\s*will\b|\bno[- ]charge\b|\bfree of charge\b|\brework\b|\bre[- ]?do\b/i
const COLLECTS_FINE_RE = /\b(out of|expired|no|not under|past|void(ed)?)\s+warranty\b|\bwarranty\s+(expired|void(ed)?|is (out|up)|disclaimer)\b|\bwarr\w*\s*disclaimer\b/i
function noCollectFromNotes(job) {
  const txt = stripHtml(`${job?.summary || ''} ${job?.summaryOfWork || ''}`)
  if (!txt) return false
  if (COLLECTS_FINE_RE.test(txt)) return false
  return NO_COLLECT_RE.test(txt)
}

function scoreOpportunity(jobTypeName, zipTier, isMember, systemAge, isHvac, noCollect) {
  const reasons = []
  let score = 0
  // Nothing to collect trumps every other signal — a warranty visit on a
  // high-ticket zip is still $0. Strongly negative so these surface first as
  // bump/reschedule candidates and never as opportunities.
  if (noCollect) { score -= 4; reasons.push('warranty/no-collect per the notes — nothing to collect') }
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
  // Aging system + breakdown = a replacement conversation regardless of zip.
  // Without this floor, a low-tier zip discounted a 23-yr-old no-cool to
  // 'solid' — the exact call the board should never soft-pedal.
  if (!noCollect && systemAge != null && systemAge >= 12 && DISTRESS_RE.test(jobTypeName || '')) {
    if (score < 3) { score = 3; reasons.push('aging system in distress — top-priority call') }
  }
  return { score, reasons }
}

// The live board costs ~35 ServiceTitan calls to compute. Cache the finished
// response for 3 minutes so ten open tabs cost one compute, not ten — the UI
// only auto-refreshes every 15 minutes anyway. The manual Refresh button
// sends ?force=1 to bypass.
const _liveBoardCache = new Map()   // dayOffset -> { data, expires }
async function computeLiveBoardPayload(dayOffset = 0) {
    const isToday = dayOffset === 0
    const today = boardDay(dayOffset)   // 'today' = the day being viewed
    const appts = (await stPageAll(p => `/jpm/v2/tenant/${ST_TENANT_ID}/appointments?startsOnOrAfter=${today.startUtc.toISOString()}&pageSize=500&page=${p}`, 3000))
      .filter(a => {
        const t = Date.parse(a.start || '')
        return t >= today.startUtc.getTime() && t < today.endUtc.getTime()
      })
    const assignments = await assignmentsForAppointments(appts.map(a => a.id))

    // Include jobs from EVERY appointment, not just assigned ones — the
    // unassigned tray at the bottom of the ST board is real work too.
    const jobIds = [...new Set([
      ...assignments.map(a => a.jobId),
      ...appts.map(a => a.jobId),
    ].filter(Boolean))]
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
    // Loaded here because BOTH the calls loop and the unassigned tray stamp
    // canGoEarly — declaring it later threw a TDZ error that blanked the tab.
    let canGoEarlyJobs = {}
    try {
      const { data: geRow } = await supabase.from('app_settings').select('value').eq('key', 'can_go_early_jobs').maybeSingle()
      canGoEarlyJobs = JSON.parse(geRow?.value || '{}')
    } catch {}

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
      const opp = scoreOpportunity(jt, zipTier.get(zip), isMember, systemAge, isHvac, noCollectFromNotes(j))
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

    // ── The unassigned tray ─────────────────────────────────────────────────
    // Appointments with NO technician sit at the bottom of the ST dispatch
    // board. Dispatchers stage work there mid-shuffle ("Justin called out — I
    // unassigned his jobs, help me re-place them"), and because this board was
    // built purely from assignments, those jobs were invisible to the AI.
    const assignedApptIds = new Set(assignments.map(a => a.appointmentId))
    const unassigned = []
    for (const ap of appts) {
      if (assignedApptIds.has(ap.id)) continue
      if ((ap.status || 'Scheduled') === 'Canceled') continue
      const j = jobById.get(ap.jobId)
      if (!j || j.jobStatus === 'Canceled') continue
      const jt = jtName.get(j.jobTypeId) || ''
      const zip = zipOfLoc.get(j.locationId) || ''
      const isMember = j.customerId ? memberCust.has(j.customerId) : null
      const opp = scoreOpportunity(jt, zipTier.get(zip), isMember,
        systemAgeFromNotes(j, new Date().getFullYear()), /hvac/i.test(jt), noCollectFromNotes(j))
      unassigned.push({
        appointmentId: ap.id, jobId: j.id, jobNumber: j.jobNumber,
        jobType: jt, zip, isMember,
        windowStart: ap.arrivalWindowStart || ap.start || null,
        windowEnd: ap.arrivalWindowEnd || ap.end || null,
        opportunity: opp.score, opportunityReasons: opp.reasons,
        canGoEarly: Boolean(canGoEarlyJobs[String(j.id)]),
        countsToCapacity: !EXCLUDE_CALL.test(jt),
      })
    }
    unassigned.sort((a, b) => b.opportunity - a.opportunity)

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
          // Ledger rules only bind the REAL today: a future-day preview shows
          // whatever finishes that day and must never mark anything counted.
          if (isToday && prior && prior !== today.date) continue   // already counted a previous day
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
            if (isToday && counted[String(c.jobId)] !== today.date) { counted[String(c.jobId)] = today.date; ledgerDirty = true }
          }
        } catch (e) { /* leave it out rather than guess */ }
      }
    }))
    if (ledgerDirty && isToday) {
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

    // Per-tech day load, and whether an all-day install has consumed them.
    // A tech spending 8-6 on one install has "1 call" by count — but zero
    // room. Reassignments, swaps, the brief and the payload all read this.
    const techLoad = new Map()
    for (const c of calls) {
      if (!c.techId || EXCLUDE_CALL.test(c.jobType || '')) continue
      const t = techLoad.get(c.techId) || { calls: 0, allDayInstall: false }
      t.calls++
      const hrs = (Date.parse(c.windowEnd || '') - Date.parse(c.windowStart || '')) / 36e5
      if (INSTALL_TYPE.test(c.jobType || '') && hrs >= 7 && c.status !== 'Done' && c.status !== 'Canceled') t.allDayInstall = true
      techLoad.set(c.techId, t)
    }
    const consumedByInstall = (techId) => Boolean(techLoad.get(Number(techId))?.allDayInstall)

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
        .filter(s => !consumedByInstall(s.tech_id))    // buried on an all-day install
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
            // Neither side of a swap can be a tech consumed by an all-day install
            && !consumedByInstall(u.techId) && !consumedByInstall(m.techId)
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
            // Same arrival window first — the cleanest one-for-one trade —
            // then strongest partner, then closest.
            const sw = (x) => (x.u.windowStart === m.windowStart && x.u.windowEnd === m.windowEnd) ? 0 : 1
            return (sw(a) - sw(b)) || (b.uEV - a.uEV) || (ta - tb)
          })[0]

        if (!partner) continue
        usedForSwap.add(partner.u.jobId)

        const t = partner.t
        const travelText = !t ? 'distance unknown — check the map'
          : t.minutes != null ? `${t.minutes} min drive between the two jobs`
          : `~${t.miles} mi between the two jobs (straight line)`

        const upside = Math.max(0, Math.round(partner.uEV - mEV))
        const sameWindow = partner.u.windowStart === m.windowStart && partner.u.windowEnd === m.windowEnd
        const why = [
          sameWindow
            ? 'Same arrival window — clean one-for-one, neither customer notices'
            : 'Techs trade jobs, appointments stay put — both customers keep their promised windows',
          `#${m.jobNumber} scores ${m.opportunity} on opportunity (${m.opportunityReasons.join(' · ') || 'high-value job type'}) but is on ${m.techName}, your lowest earner on this bench`,
          `${partner.u.techName} is rated "deploy here" (${money0(partner.uEV)}/opportunity vs ${money0(mEV)}) and is currently on a routine ${partner.u.jobType}`,
          upside > 0 ? `Expected upside on #${m.jobNumber}: about ${money0(upside)}` : 'Similar earning power — swap only if convenient',
          travelText,
        ]

        swaps.push({
          businessUnit: bu,
          sameWindow,
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
      // Customer told the CSR the tech may come earlier than the window —
      // the one kind of call dispatch can shuffle without a broken promise.
      c.canGoEarly = Boolean(canGoEarlyJobs[String(c.jobId)])
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
        if (c.canGoEarly) why.unshift('Customer said the tech can come early — flexible on timing')
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
      // The receipts behind the headline number — the UI opens these on click.
      bookedDetail: [...bookedByJob.entries()].map(([jid, amt]) => {
        const call = calls.find(x => x.jobId === jid)
        return { jobId: jid, jobNumber: call?.jobNumber || null, jobType: call?.jobType || null,
                 tech: call?.techName || null, amount: Math.round(amt) }
      }).sort((a, b) => b.amount - a.amount),
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
      day: dayOffset,
      date: today.date,
      generatedAt: new Date().toISOString(),
      scoresRefreshedAt: (scores || [])[0]?.refreshed_at || null,
      driveTime: driveTimeEnabled(),
      dayRevenue,
      techsToday,
      calls, swaps, unassigned,
      counts: {
        total: calls.length,
        unassigned: unassigned.length,
        flagged: calls.filter(c => c.flags.length).length,
        unrankedTechs: calls.filter(c => c.techTier === 'unranked').length,
      },
    }
    _liveBoardCache.set(dayOffset, { data: payload, expires: Date.now() + 3 * 60_000 })
  return payload
}

app.get('/api/dispatch/live-board', async (req, res) => {
  if (!(await requireDispatch(req, res))) return
  try {
    const day = Math.min(2, Math.max(0, parseInt(req.query.day) || 0))
    const hit = _liveBoardCache.get(day)
    if (req.query.force !== '1' && hit && hit.expires > Date.now()) {
      return res.json({ ...hit.data, cached: true })
    }
    res.json(await computeLiveBoardPayload(day))
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
// Shared by the daily brief and Scenario AI: one signal-dense snapshot of
// today's board, benches, capacity, and weather.
// Job NOTES feed the analyzer: "customer wants Craig back to finish the
// quote" lives only in the job's notes, and moving that job to another tech
// kills the deal. ST has no batch notes endpoint, so fetch per job with
// small concurrency, capped and cached per board day.
const _jobNotesCache = new Map()   // day -> { expires, byJob: Map(jobId -> text) }
async function fetchBoardJobNotes(day, jobIds) {
  const hit = _jobNotesCache.get(day)
  if (hit && hit.expires > Date.now()) return hit.byJob
  const ids = [...new Set(jobIds)].filter(Boolean).slice(0, 80)
  const byJob = new Map()
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map(async (jid) => {
      try {
        const d = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs/${jid}/notes?pageSize=10`)
        const txt = (d?.data || [])
          .sort((a, b) => Date.parse(b.createdOn || 0) - Date.parse(a.createdOn || 0))
          .slice(0, 3)
          .map(n => stripHtml(n.text).replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .map(t => t.slice(0, 220))
          .join(' | ')
        if (txt) byJob.set(jid, txt.slice(0, 600))
      } catch {}
    }))
  }
  // The booking SUMMARY is the other half — job 35317's embedded install
  // lived there, not in notes. Batch-fetch and merge (summary first: it's
  // what the CSR promised the customer).
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const d = await stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs?ids=${ids.slice(i, i + 50).join(',')}&pageSize=50`)
      for (const j of (d?.data || [])) {
        const sum = stripHtml(j.summary).replace(/\s+/g, ' ').trim().slice(0, 300)
        if (!sum) continue
        const existing = byJob.get(j.id)
        byJob.set(j.id, existing ? `Booking: ${sum} | Notes: ${existing}`.slice(0, 700) : `Booking: ${sum}`)
      }
    }
  } catch (e) { console.warn('board job summaries:', e.message) }
  _jobNotesCache.set(day, { expires: Date.now() + 30 * 60_000, byJob })
  return byJob
}

async function gatherDispatchFacts({ allCalls = false, day = 0 } = {}) {
  const hit = _liveBoardCache.get(day)
  const board = (hit && hit.expires > Date.now()) ? hit.data : await computeLiveBoardPayload(day)
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
  // Times MUST be Denver wall clock: raw ISO windows leaked into the scenario
  // output as '18:00-22:00Z' military UTC, which no dispatcher speaks.
  const dnv = (iso) => {
    const t = Date.parse(iso || '')
    if (Number.isNaN(t)) return null
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' })
      .format(new Date(t)).replace(':00', '')
  }
  const dnvWin = (a, b) => { const x = dnv(a); if (!x) return null; const y = dnv(b); return y ? `${x}\u2013${y}` : x }
  const calls = board.calls || []
  let jobNotes = new Map()
  try {
    jobNotes = await fetchBoardJobNotes(day, [
      ...calls.map(c => c.jobId),
      ...(board.unassigned || []).map(u => u.jobId),
    ])
  } catch (e) { console.warn('brief job notes:', e.message) }
  const noteOf = (jid) => jobNotes.get(jid) || undefined
  const facts = {
    now: new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }),
    analyzing: day === 0 ? 'TODAY' : `${board.date} (${day === 1 ? 'TOMORROW' : `${day} days out`}) — a FUTURE day being game-planned in advance`,
    counts: board.counts,
    revenue: board.dayRevenue,
    flagged: calls.filter(c => c.flags?.length).map(c => ({
      job: c.jobNumber, type: c.jobType, tech: c.techName, tier: c.techTier,
      window: dnvWin(c.windowStart, c.windowEnd), flag: c.flags[0]?.text, why: c.flags[0]?.why,
      notes: noteOf(c.jobId),
    })),
    swaps: (board.swaps || []).map(x => ({ text: x.text, why: x.why, upside: x.upside })),
    unassignedTray: (board.unassigned || []).map(u => ({
      job: u.jobNumber, type: u.jobType,
      window: dnvWin(u.windowStart, u.windowEnd),
      opportunity: u.opportunity,
      why: (u.opportunityReasons || []).slice(0, 2).join(' · ') || undefined,
      canGoEarly: u.canGoEarly || undefined,
      notes: noteOf(u.jobId),
    })),
    rescheduleCandidates: calls.filter(c => c.rescheduleCandidate)
      .map(c => ({ job: c.jobNumber, type: c.jobType, tech: c.techName, canGoEarly: c.canGoEarly || undefined })),
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
  // Scenario AI needs the WHOLE board, not just the flagged slice — "Arber
  // called in sick" is about Arber's perfectly unflagged assignments.
  if (allCalls) {
    facts.assignments = calls.map(c => ({
      job: c.jobNumber, type: c.jobType, tech: c.techName, tier: c.techTier,
      window: dnvWin(c.windowStart, c.windowEnd),
      status: c.status, opportunity: c.opportunity ?? null,
      expectedRevenue: c.expectedRevenue ?? null,
      canGoEarly: c.canGoEarly || undefined,
      notes: noteOf(c.jobId),
    }))
  }
  // Dispatcher-entered tech notes (Tech Info tab) — capability and constraint
  // facts like "only plumber with boiler experience". The prompts treat these
  // as law when proposing assignments.
  try {
    const { data: tnRow } = await supabase.from('app_settings').select('value').eq('key', 'tech_notes').maybeSingle()
    const tn = JSON.parse(tnRow?.value || '{}')
    const nameOf = new Map((scores || []).map(r => [String(r.tech_id), r.tech_name]))
    ;(board.techsToday || []).forEach(t => { if (t.name) nameOf.set(String(t.techId), t.name) })
    const techNotes = Object.entries(tn)
      .map(([id, note]) => ({ tech: nameOf.get(String(id)) || `Tech ${id}`, note: String(note || '').trim().slice(0, 300) }))
      .filter(x => x.note)
    if (techNotes.length) facts.techNotes = techNotes
  } catch {}
  // Weather is demand context: a 98° day explains a full HVAC board and
  // argues for protecting no-cool slots. Failure to fetch never blocks the brief.
  try {
    const wx = (_wxCache && _wxCache.expires > Date.now()) ? _wxCache.data : await computeWeather()
    facts.weather = {
      cities: (wx.cities || []).map(c => ({ name: c.name, now: c.temp, high: c.high, low: c.low, sky: c.short })),
      activeAlert: wx.alert ? `${wx.alert.event}${wx.alert.until ? ` until ${wx.alert.until}` : ''}` : null,
      demandSignal: wx.signal?.text || null,
    }
  } catch (e) { console.warn('brief weather:', e.message) }
  return facts
}

// Word-boundary clamp shared by brief + scenario output cleaning.
function cleanBriefText(t, max) {
  let out = String(t || '').replace(/["{}\[\]]+/g, '').replace(/\s+/g, ' ').trim()
  if (out.length > max) {
    out = out.slice(0, max)
    const cut = out.lastIndexOf(' ')
    out = (cut > max - 30 ? out.slice(0, cut) : out).replace(/[,;:\u00b7\-\u2013\u2014]$/, '') + '\u2026'
  }
  return out
}

async function generateDispatchBrief(day = 0) {
  if (!ANTHROPIC_KEY) throw new Error('No ANTHROPIC_API_KEY configured')
  const facts = await gatherDispatchFacts({ day })

  const futureNote = day === 0 ? '' : `

You are analyzing a FUTURE day (see 'analyzing') — this is advance GAME-PLANNING, not live triage. Nothing has run yet; there are no outcomes. Focus on: booking gaps to fill before the day arrives, flagged assignments to fix ahead of time (there is time to move things properly now), high-opportunity calls to protect with the right closers, and what the unassigned tray needs. Actions should be phrased as prep ("move X before Thursday", "fill 3 plumbing slots"), with priority 'today' meaning do-the-prep-today and 'plan' for nice-to-haves.`

  const sys = futureNote + `You are the dispatch analyst for Awesome Home Services (HVAC, plumbing, electrical, garage doors — Colorado Springs). You are given a JSON snapshot of today's live dispatch board, tech performance benches, and 3-day capacity. All times in the data are Denver local clock times — always write times that way (e.g. '4–8 PM'), never military or UTC. Write the read a sharp dispatch manager would give at the huddle: concrete, numbers-first, in plain dispatcher language. Only use what is in the data; never invent jobs, names, or numbers.

Every bench tech carries a 'today' field with their REAL availability right now. Treat it as law: never build an action around routing work to (or comparing against) a tech whose 'today' says they are off, have no working time left, or are on an all-day install — those techs cannot take calls no matter how good their numbers are. Recommendations may only name techs whose 'today' shows calls on board or room.

'unassignedTray' lists jobs sitting UNASSIGNED at the bottom of the dispatch board — booked customers with no tech attached yet. When a dispatcher says they "unassigned" jobs or asks what to keep, cut, or redistribute, they mean THESE — work the tray job by job, by opportunity score, and remember every tray job still holds its promised customer window.

Arrival windows are PROMISES to customers — treat them as law too. Trading TECHS between two jobs is always window-safe (appointments stay put). Any move that changes a customer's window or day is only allowed when that job carries canGoEarly=true (the customer said the tech may come earlier) — and even then, say to call the customer first. Never propose shifting a customer's time otherwise; find the move that works within the promised windows instead.

Job 'notes' are ground truth for relationship constraints. If a job's notes show the customer expects a specific tech back, a quote or deal is mid-flight with a tech, or a follow-up belongs to whoever ran the first visit — that job is LOCKED to that tech: never propose moving it to anyone else, and when it blocks an otherwise good move, say so. 'techNotes' are dispatcher-entered facts about technicians (skills, certifications, restrictions — e.g. "only plumber with boiler experience"). Treat them as law when proposing assignments or swaps: never suggest a tech for work their note rules out, and when a job needs a specialty only one tech has, that tech is the answer.

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
  // Truncate at a WORD boundary with an ellipsis — the old hard slice cut
  // sentences mid-word ("don't overbook past", "for any l") which read as
  // broken. Caps are roomier; the ellipsis is the honest signal when hit.
  const clean = cleanBriefText
  brief.headline = clean(brief.headline, 180)
  brief.situation = clean((String(brief.situation || '').match(/[^.!?]+[.!?]/g) || [brief.situation || '']).slice(0, 3).join(' '), 460)
  brief.actions = (brief.actions || []).slice(0, 6).map(a => ({ priority: a.priority, text: clean(a.text, 220) }))
  brief.watchouts = (brief.watchouts || []).slice(0, 4).map(w => clean(w, 200))
  brief.wins = (brief.wins || []).slice(0, 3).map(w => clean(w, 180))
  const record = { brief, day, boardDate: facts.analyzing, generatedAt: new Date().toISOString() }
  await supabase.from('app_settings').upsert(
    { key: day === 0 ? 'dispatch_brief' : `dispatch_brief_d${day}`, value: JSON.stringify(record) }, { onConflict: 'key' })
  return record
}

app.get('/api/dispatch/brief', async (req, res) => {
  if (!(await requireDispatch(req, res))) return
  try {
    const day = Math.min(2, Math.max(0, parseInt(req.query.day) || 0))
    const key = day === 0 ? 'dispatch_brief' : `dispatch_brief_d${day}`
    const { data: row } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle()
    let record = null
    try { record = JSON.parse(row?.value || 'null') } catch {}
    if (record && (record.day || 0) !== day) record = null   // pre-day-aware cache rows
    const ageMs = record?.generatedAt ? Date.now() - Date.parse(record.generatedAt) : Infinity
    // Future-day briefs stale faster: bookings keep landing on those boards.
    const maxAge = day === 0 ? 6 * 3600_000 : 2 * 3600_000
    const wantFresh = req.query.refresh === '1' || ageMs > maxAge
    if (wantFresh && !_briefBusy) {
      _briefBusy = true
      try { record = await generateDispatchBrief(day) }
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
  if (!(await requireDispatch(req, res))) return
  try {
    const cat = await getJobTypeCatalog()
    res.json({ types: cat.map(t => t.name).filter(Boolean).sort() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/dispatch/geocode-suggest', async (req, res) => {
  if (!(await requireDispatch(req, res))) return
  try {
    res.json({ suggestions: await suggestAddresses(req.query.q, req.query.types) })
  } catch (err) {
    res.json({ suggestions: [] })
  }
})

// The decision BRAIN, shared: the Dispatch tab's Decision Maker and the CSR
// booking-flow guidance call this with the same inputs and get the same
// answer. Returns { error, status } instead of throwing for input problems.
async function computeDispatchDecision(input) {
  {
    const jobType = String(input?.jobType || '').trim()
    const address = String(input?.address || '').trim()
    const urgent = Boolean(input?.urgent)   // "must run today" override
    // What the dispatcher already knows from the call. A new job has no ST
    // notes yet, so this is the only way a "2-year-old no cool" reaches the
    // model. Age can be typed directly or parsed out of the notes text.
    const givenAge = input?.systemAge != null && input.systemAge !== '' ? Number(input.systemAge) : null
    const callNotes = String(input?.notes || '').trim()
    if (!jobType) return { error: 'A job type is required.', status: 400 }

    const trade = tradeOfJobType(jobType)
    if (!trade) return { error: `Couldn't tell which trade "${jobType}" belongs to. Try including the trade name.`, status: 400 }

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
    const opp = scoreOpportunity(jobType, zipTier, null, knownAge, isHvac, noCollectFromNotes({ summary: callNotes }))

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
    // A tech on an all-day install is CONSUMED, whatever their call count says
    // — Craig Rehm showed "has room · 1/4" while spending 8-6 on a water
    // heater install. One long install appointment closes the tech's day.
    const allDayInstall = new Map()   // techId -> job type name
    for (const a of assignments) {
      const j = jobById.get(a.jobId)
      if (!j || !a.technicianId) continue
      const jn = jtName.get(j.jobTypeId) || ''
      if (!EXCLUDE_CALL.test(jn)) loadByTech.set(a.technicianId, (loadByTech.get(a.technicianId) || 0) + 1)
      const ap = apptById.get(a.appointmentId)
      const hrs = ap ? (Date.parse(ap.end || '') - Date.parse(ap.start || '')) / 36e5 : 0
      if (INSTALL_TYPE.test(jn) && hrs >= 7 && ap?.status !== 'Done' && ap?.status !== 'Canceled') {
        allDayInstall.set(a.technicianId, jn)
      }
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
      const onInstall = allDayInstall.get(b.tech_id) || null
      const hasRoom = !onInstall && load < cap
      return {
        techId: b.tech_id, techName: b.tech_name, team: b.business_unit, tier: b.tier,
        expectedValue: Math.round(ev),
        closeRate: jt ? Math.round(Number(jt.close_rate || 0)) : Math.round(Number(b.close_rate || 0)),
        avgSale: Math.round(Number((jt && jt.avg_sale) ?? b.avg_sale ?? 0)),
        onThisJobType: Boolean(jt),
        load, cap, hasRoom,
        allDayInstall: onInstall,
        driveMinutes: drive == null ? null : Math.round(drive),
      }
    })

    // Rank: best expected value, but a tech with room and a short drive beats a
    // marginally-higher earner who's full and far. Simple, explainable score.
    const scoreOption = (o) => {
      let s = o.expectedValue
      if (!o.hasRoom) s -= 400                        // needs a bump
      if (o.allDayInstall) s -= 100000                // physically not available today
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
            systemAgeFromNotes(j, nowYear), /hvac/i.test(name) || trade === 'HVAC', noCollectFromNotes(j))
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
      // Denver hours, NOT server-local: Railway runs UTC, which rendered the
      // 7 AM-8 PM all-day window as "1 PM-2 AM".
      const f = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', hour12: true }).format(new Date(iso))
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
      // No bump math for a tech on an all-day install: moving their other
      // calls doesn't free them — they're physically at the install.
      o.bump = (o.hasRoom || o.allDayInstall) ? null : bumpFor(o.techId)
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

    return {
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
    }
  }
}

// 🎭 Scenario AI — the dispatcher describes a situation ("Arber called in
// sick — what do I do with his calls?") and gets a step-by-step walk-through
// of the profit-maximizing response, grounded in the live board snapshot.
app.post('/api/dispatch/scenario', async (req, res) => {
  if (!(await requireDispatch(req, res))) return
  try {
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'No ANTHROPIC_API_KEY configured' })
    const scenario = String(req.body?.scenario || '').trim().slice(0, 600)
    if (scenario.length < 5) return res.status(400).json({ error: 'Describe the scenario first.' })
    const day = Math.min(2, Math.max(0, parseInt(req.body?.day) || 0))
    const facts = await gatherDispatchFacts({ allCalls: true, day })

    const sys = `You are the dispatch coach for Awesome Home Services (HVAC, plumbing, electrical, garage doors \u2014 Colorado Springs). The dispatcher describes a scenario; you walk them step by step through the correct decision-making to maximize profitable dispatch.

You are given a JSON snapshot: every assignment on today's board (job number, type, tech, window, opportunity score, expected revenue), flagged calls, reschedule candidates, tech performance benches with REAL availability in 'today', 3-day capacity, and weather. All times in the data are Denver local clock times — always write times that way (e.g. '4–8 PM'), never military or UTC. Ground every step in this data \u2014 name real techs and job numbers; never invent any.

'unassignedTray' lists jobs sitting UNASSIGNED at the bottom of the dispatch board — booked customers with no tech attached yet. When the dispatcher says they "unassigned" jobs or asks what to keep, cut, or push, they mean THESE — place or defer each tray job explicitly, highest opportunity first, and never leave one unmentioned.

Scenarios come in two shapes. DISRUPTIONS (a tech out sick, a truck down, a call running long): deal with the affected tech's specific assignments one by one — cover, swap, or push, cheapest move last. GOAL-SEEKING (sales are down, how do we squeeze more out of the board): hunt the profit levers in the data — high-opportunity calls sitting on red-tier techs that belong on green closers, strong closers burning slots on $0 maintenance/callbacks, unrouted swaps, reschedule candidates whose slots could take better calls, and tomorrow's capacity worth protecting. Name the specific moves and the dollar upside where computable.

Rules: arrival windows are PROMISES — trading techs between jobs is window-safe (appointments stay put), but changing a customer's window or day is only allowed when that job carries canGoEarly=true (customer said the tech may come earlier), with an explicit 'call the customer to confirm' step; otherwise find moves that keep every customer inside their promised window, and when a cascade is needed, walk each hop and verify every touched customer stays in-window or gets a confirmation call. A tech whose 'today' says off / no time left / all-day install cannot take work. Job 'notes' are relationship law: notes showing the customer expects a specific tech back, or a deal mid-flight with a tech (quote to close, follow-up from a first visit), LOCK that job to that tech — never move it to someone else, and call the lock out when it constrains the plan. 'techNotes' are dispatcher-entered technician facts (skills, certifications, restrictions) — never propose a tech for work their note rules out, and route specialty work to the uniquely qualified tech. Protect high-opportunity calls (aging systems, replacements) with the strongest closers; low-opportunity and $0-collect calls are the ones to move or push to another day. If something genuinely can't be covered today, say which call moves to tomorrow and why it's the cheapest move. Submit via submit_plan: 3-8 ordered steps a dispatcher can execute top to bottom.`

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 3000, system: sys,
        tools: [{
          name: 'submit_plan',
          description: 'Submit the scenario walk-through',
          input_schema: {
            type: 'object',
            properties: {
              headline: { type: 'string', maxLength: 160, description: 'One sentence: the shape of the answer' },
              situation: { type: 'string', maxLength: 400, description: 'At most 3 plain sentences sizing up the impact. No JSON or brackets.' },
              steps: {
                type: 'array',
                items: { type: 'string', description: 'One concrete move, naming tech and job number where possible, max 30 words' },
                description: 'Ordered — the dispatcher executes top to bottom',
              },
              watchouts: { type: 'array', items: { type: 'string' } },
            },
            required: ['headline', 'situation', 'steps', 'watchouts'],
          },
        }],
        tool_choice: { type: 'tool', name: 'submit_plan' },
        messages: [{ role: 'user', content: `SCENARIO: ${scenario}\n\nBOARD DATA:\n${JSON.stringify(facts)}` }],
      }),
    })
    if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 160)}`)
    const rj = await r.json()
    const plan = (rj.content || []).find(b => b.type === 'tool_use')?.input
    if (!plan?.steps?.length) {
      console.error('scenario empty:', rj.stop_reason, JSON.stringify(rj.content || []).slice(0, 400))
      throw new Error(rj.stop_reason === 'max_tokens'
        ? 'The answer ran long and got cut off \u2014 hit the button again'
        : 'No plan came back \u2014 try rewording the scenario')
    }
    plan.headline = cleanBriefText(plan.headline, 180)
    plan.situation = cleanBriefText(plan.situation, 460)
    plan.steps = (plan.steps || []).slice(0, 8).map(t => cleanBriefText(t, 260))
    plan.watchouts = (plan.watchouts || []).slice(0, 4).map(t => cleanBriefText(t, 200))
    res.json({ plan, generatedAt: new Date().toISOString() })
  } catch (err) {
    console.error('scenario error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// 📝 Tech Info notes — dispatcher intel about specific techs, keyed by ST tech
// id in app_settings (no migration). Batting Order shows them on hover.
app.get('/api/dispatch/tech-notes', async (req, res) => {
  if (!(await requireDispatch(req, res))) return
  try {
    const [{ data: row }, { data: rrow }, techs] = await Promise.all([
      supabase.from('app_settings').select('value').eq('key', 'tech_notes').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'tech_review_stats').maybeSingle(),
      getBoardTechs().catch(() => []),
    ])
    let notes = {}, reviews = {}, reviewWindowDays = null
    try { notes = JSON.parse(row?.value || '{}') } catch {}
    try {
      const rs = JSON.parse(rrow?.value || '{}')
      reviews = rs.stats || {}
      reviewWindowDays = rs.windowDays || null
    } catch {}
    res.json({
      notes, reviews, reviewWindowDays,
      // Dispatch picks service techs — install crews, apprentices, and
      // leadership aren't dispatchable and just add scroll.
      techs: techs.filter(t => t.team !== 'Leadership' && !/install|apprentice/i.test(t.team || ''))
        .map(t => ({ id: t.id, name: t.name, team: t.team || 'Other' }))
        .sort((a, b) => (a.team || '').localeCompare(b.team || '') || (a.name || '').localeCompare(b.name || '')),
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})
app.post('/api/dispatch/tech-notes', async (req, res) => {
  if (!(await requireDispatch(req, res))) return
  try {
    const techId = String(req.body?.techId || '')
    if (!techId) return res.status(400).json({ error: 'techId required' })
    const out = { ok: true }
    if ('note' in (req.body || {})) {
      const note = String(req.body.note || '').trim().slice(0, 500)
      const { data: row } = await supabase.from('app_settings').select('value').eq('key', 'tech_notes').maybeSingle()
      let notes = {}
      try { notes = JSON.parse(row?.value || '{}') } catch {}
      if (note) notes[techId] = note
      else delete notes[techId]
      await supabase.from('app_settings').upsert({ key: 'tech_notes', value: JSON.stringify(notes) }, { onConflict: 'key' })
      out.notes = notes
    }
    res.json(out)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/dispatch/decide', async (req, res) => {
  if (!(await requireDispatch(req, res))) return
  try {
    const out = await computeDispatchDecision(req.body || {})
    if (out?.error) return res.status(out.status || 400).json({ error: out.error })
    res.json(out)
  } catch (err) {
    console.error('decide error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// CSR booking guidance — the same decision math the Dispatch tab runs,
// packaged for the booking panel: how urgent is this call, who should run
// it, and what to do when the board is already full (book it anyway —
// dispatch makes room; the bump details stay dispatcher-side).
app.post('/api/booking/guidance', async (req, res) => {
  try {
    const out = await computeDispatchDecision(req.body || {})
    if (out?.error) return res.status(out.status || 400).json({ error: out.error })
    const opp = out.opportunity ?? 0
    // Per Brandyn: the CSR gets the SIGNAL, the dispatcher keeps the judgment.
    // No tech names here — a high-opportunity call routes the CSR to dispatch,
    // who runs it through the Decision Maker and moves the board.
    res.json({
      urgency: opp >= 3 ? 'today' : opp >= 1 ? 'soon' : 'normal',
      opportunity: opp,
      reasons: out.opportunityReasons || [],
      trade: out.trade,
      boardFull: (out.options || []).length > 0 && !(out.options || []).some(o => o.hasRoom),
    })
  } catch (err) {
    console.error('booking guidance error:', err.message)
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

// 📆 Publish + Email the week's schedule. Each selected person gets THEIR OWN
// week — shift, breaks, lunch, daily and weekly hours — straight from the
// same schedules rows the WFM grid shows.
app.post('/api/schedule/publish', async (req, res) => {
  const prof = await requireAdmin(req, res)
  if (!prof) return
  try {
    const weekStart = String(req.body?.weekStart || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'weekStart (YYYY-MM-DD) required' })
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + i)
      return d.toISOString().split('T')[0]
    })
    const ids = req.body?.profileIds === 'all' ? null
      : Array.isArray(req.body?.profileIds) ? req.body.profileIds.filter(Boolean) : []
    if (ids && !ids.length) return res.status(400).json({ error: 'Pick at least one person' })

    let q = supabase.from('profiles').select('id, name, email').eq('active', true).order('name')
    if (ids) q = q.in('id', ids)
    const { data: people } = await q
    const { data: scheds } = await supabase.from('schedules').select('*').gte('date', dates[0]).lte('date', dates[6])

    // Publishing IS the state flip: drafts in this week become live (visible
    // to reps) the moment this runs — the emails describe what's now real.
    let published = 0
    try {
      let up = supabase.from('schedules').update({ published_at: new Date().toISOString() })
        .gte('date', dates[0]).lte('date', dates[6]).is('published_at', null).select('id')
      if (ids) up = up.in('profile_id', ids)
      const { data: pubRows, error: pubErr } = await up
      if (pubErr) console.warn('publish mark:', pubErr.message)
      else published = pubRows?.length || 0
    } catch (e) { console.warn('publish mark:', e.message) }
    const sendEmails = req.body?.sendEmails !== false

    const fmt12 = (t) => { if (!t) return ''; const [h, m] = String(t).split(':').map(Number); return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}` }
    const dayLabel = (ds) => new Date(ds + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    const OFF_LABEL = { pto: 'PTO', sick: 'Sick', holiday: 'Holiday', off: 'Off' }
    const hoursOf = (sd) => {
      if (!sd?.shift_start || !sd?.shift_end) return 0
      const [sh, sm] = sd.shift_start.split(':').map(Number); const [eh, em] = sd.shift_end.split(':').map(Number)
      let h = (eh + (em || 0) / 60) - (sh + (sm || 0) / 60); if (h < 0) h += 24
      return Math.max(0, h - (Number(sd.lunch_duration) || 0) / 60)
    }
    const weekTitle = `week of ${dayLabel(dates[0])}`

    let sent = 0
    const skipped = []
    for (const person of (sendEmails ? (people || []) : [])) {
      if (!person.email) { skipped.push(person.name || person.id); continue }
      let total = 0
      const rows = dates.map(ds => {
        const sd = scheds?.find(x => x.profile_id === person.id && x.date === ds)
        const off = !sd || (sd.day_type && sd.day_type !== 'work') || !sd.shift_start
        let cell
        if (off) {
          cell = `<span style="color:#94A3B8">${OFF_LABEL[sd?.day_type] || 'Off'}</span>`
        } else {
          const h = hoursOf(sd); total += h
          const extras = [
            sd.break1_start ? `Break ${fmt12(sd.break1_start)}` : null,
            sd.lunch_start ? `Lunch ${fmt12(sd.lunch_start)}` : null,
            sd.break2_start ? `Break ${fmt12(sd.break2_start)}` : null,
          ].filter(Boolean).join(' · ')
          cell = `<strong>${fmt12(sd.shift_start)} – ${fmt12(sd.shift_end)}</strong>` +
            ` <span style="color:#64748B">(${h % 1 ? h.toFixed(1) : h}h)</span>` +
            (extras ? `<br><span style="font-size:12px;color:#64748B">${extras}</span>` : '')
        }
        return `<tr><td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-weight:600;white-space:nowrap">${dayLabel(ds)}</td>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #E2E8F0">${cell}</td></tr>`
      }).join('')
      const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0F172A">` +
        `<h2 style="margin:18px 0 2px">Your schedule — ${weekTitle}</h2>` +
        `<p style="margin:0 0 14px;color:#64748B">${total % 1 ? total.toFixed(1) : total} scheduled hours this week</p>` +
        `<table style="border-collapse:collapse;width:100%;font-size:14px">${rows}</table>` +
        `<p style="margin:16px 0;color:#94A3B8;font-size:12px">Sent from Andi by ${String(req.body?.from || 'your manager')}. Questions? Ask your manager.</p></div>`
      try {
        await sendResend({ to: person.email, subject: `Your schedule — ${weekTitle}`, html })
        sent++
      } catch (e) {
        console.warn('schedule publish email:', person.email, e.message)
        skipped.push(person.name || person.email)
      }
    }
    res.json({ sent, skipped, published })
  } catch (err) {
    console.error('schedule publish:', err.message)
    res.status(500).json({ error: err.message })
  }
})

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
    // 🎯 Opportunity Watch Bonus: Mon–Fri, if EVERY trade with capacity goes
    // to Opportunity Watch before the cutoff, the daily pool splits equally
    // among scheduled reps/dispatchers — straight into commissions (which
    // fires the You Got Paid popup) plus a gold floor-wide unlock pop.
    setInterval(() => checkOppWatchBonus().catch(e => console.warn('opp bonus:', e.message)), 10 * 60_000)
    // Janitor: no phone call runs 4 hours. Any active_calls row still
    // non-terminal that old is a missed callback — close it so the live
    // counters can never drift permanently.
    setInterval(async () => {
      try {
        await supabase.from('active_calls')
          .update({ status: 'completed', ended_at: new Date().toISOString() })
          .not('status', 'in', '(completed,failed,busy,no-answer,canceled)')
          .lt('started_at', new Date(Date.now() - 4 * 3600e3).toISOString())
      } catch (e) { console.warn('active_calls janitor:', e.message) }
    }, 30 * 60_000)
    // Scheduled floor notifications: sweep every 60s, send what's due.
    setInterval(async () => {
      try {
        const list = await loadFloorScheduled()
        const due = list.filter(x => Date.parse(x.sendAt) <= Date.now())
        if (!due.length) return
        await saveFloorScheduled(list.filter(x => Date.parse(x.sendAt) > Date.now()))
        for (const m of due) {
          const { id, sendAt, createdAt, ...payload } = m
          await sendFloorAnnounce(payload).catch(e => console.warn('scheduled announce:', e.message))
        }
      } catch (e) { console.warn('floor sweep:', e.message) }
    }, 60_000)
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

// Scorecard KPIs fill themselves hourly (booked calls, booking %, memberships).
setTimeout(() => {
  syncScorecardActuals().catch(e => console.warn('scorecard sync:', e.message))
  setInterval(() => syncScorecardActuals().catch(e => console.warn('scorecard sync:', e.message)), 60 * 60_000)
}, 120_000)
console.log('Scorecard actuals sync hourly')

// Recording registry sweep: a week-deep backfill that keeps retrying until
// the call_recordings table exists (the migration may land after this boots),
// then a 26h look-back every 30 min for anything the webhooks missed.
if (accountSid && authToken) {
  let recSweepDeepDone = false
  const recSweepTick = async () => {
    try {
      const ok = await sweepRecordings(recSweepDeepDone ? 26 : 7 * 24)
      if (ok) recSweepDeepDone = true
    } catch (e) { console.warn('recording sweep:', e.message) }
  }
  setTimeout(() => {
    recSweepTick()
    setInterval(recSweepTick, 30 * 60_000)
  }, 90_000)
  console.log('Recording sweep every 30m (7d backfill once table exists)')
}
