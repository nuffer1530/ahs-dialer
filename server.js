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
  const data = (res?.data || []).map(t => ({ id: t.id, businessUnitId: t.businessUnitId }))
  techCache = { data, expires: Date.now() + 10 * 60_000 }
  return data
}

async function build3DayBoard() {
  const days = [0, 1, 2].map(boardDay)

  // Business unit map: id → { trade, role }
  const buRes = await stGet(`/settings/v2/tenant/${ST_TENANT_ID}/business-units?active=true&pageSize=200`)
  const buMap = {}
  ;(buRes?.data || []).forEach(b => { buMap[b.id] = classifyBU(b.name) })
  const serviceBU = {}, installBU = {}
  Object.entries(buMap).forEach(([id, c]) => {
    if (c.role === 'service' && c.trade) serviceBU[c.trade] = Number(id)
    if (c.role === 'install' && c.trade) installBU[c.trade] = Number(id)
  })

  // Techs by home BU (for the Service-tech head count).
  const techs = await getBoardTechs()
  const techsByBU = {}
  techs.forEach(t => { if (t.businessUnitId != null) (techsByBU[t.businessUnitId] ||= []).push(t.id) })

  // Time-off across the whole 3-day window, so we can prorate tech availability.
  const shiftRes = await stGet(`/dispatch/v2/tenant/${ST_TENANT_ID}/technician-shifts?shiftType=TimeOff&startsOnOrAfter=${days[0].startUtc.toISOString()}&endsOnOrBefore=${days[2].endUtc.toISOString()}&pageSize=500`)
  const timeOff = (shiftRes?.data || []).map(s => ({ tech: s.technicianId, start: new Date(s.start), end: new Date(s.end) }))

  // Job-type → category, to split opportunity jobs from warranty/callback.
  const { data: spiffs } = await supabase.from('job_type_spiffs').select('st_job_type_id, category')
  const catByType = {}
  ;(spiffs || []).forEach(s => { catByType[String(s.st_job_type_id)] = s.category })

  // Calls-per-tech per trade (default 3), admin-tunable in app_settings.
  const { data: cptRow } = await supabase.from('app_settings').select('value').eq('key', 'board_calls_per_tech').maybeSingle()
  let callsPerTech = {}
  try { callsPerTech = JSON.parse(cptRow?.value || '{}') } catch {}
  const cpt = (trade) => Number(callsPerTech[trade]) || 3

  // Jobs per day, grouped by BU (one ST call per day).
  const jobsByDay = await Promise.all(days.map(d =>
    stGet(`/jpm/v2/tenant/${ST_TENANT_ID}/jobs?appointmentStartsOnOrAfter=${d.startUtc.toISOString()}&appointmentStartsBefore=${d.endUtc.toISOString()}&pageSize=500`)
      .then(r => r?.data || []).catch(() => [])
  ))

  const overlapFractionOfDay = (off, day) => {
    const s = Math.max(off.start.getTime(), day.startUtc.getTime())
    const e = Math.min(off.end.getTime(), day.endUtc.getTime())
    if (e <= s) return 0
    return Math.min((e - s) / (8 * 3600_000), 1)   // 8h = a full working day
  }

  const board = BOARD_TRADES.map(trade => {
    const svc = serviceBU[trade], ins = installBU[trade]
    const svcTechIds = techsByBU[svc] || []
    const perDay = days.map((day, di) => {
      const jobs = jobsByDay[di]
      // Techs: head count minus prorated time-off for this trade's service techs.
      let techsAvail = svcTechIds.length
      for (const techId of svcTechIds) {
        const offToday = timeOff.filter(o => o.tech === techId)
          .reduce((sum, o) => sum + overlapFractionOfDay(o, day), 0)
        techsAvail -= Math.min(offToday, 1)
      }
      techsAvail = Math.round(techsAvail * 10) / 10

      const svcJobs = jobs.filter(j => j.businessUnitId === svc)
      const calls = svcJobs.length
      const opps = svcJobs.filter(j => catByType[String(j.jobTypeId)] !== 'non_commissionable').length
      const installs = jobs.filter(j => j.businessUnitId === ins).length

      const capacity = Math.round(techsAvail * cpt(trade) * 10) / 10
      const pct = capacity > 0 ? calls / capacity : (calls > 0 ? 1 : 0)
      const needed = Math.max(0, Math.round(capacity - calls))
      const status = capacity === 0 ? 'none' : pct >= 1 ? 'good' : pct >= 0.75 ? 'warn' : 'under'
      return { date: day.date, techs: techsAvail, calls, capacity, pct: Math.round(pct * 100), needed, opps, installs, status }
    })
    return { trade, days: perDay }
  })

  return { generatedAt: new Date().toISOString(), dates: days.map(d => d.date), board }
}

app.get('/api/board/3day', async (req, res) => {
  try {
    res.json(await build3DayBoard())
  } catch (err) {
    console.error('3-day board error:', err.message)
    res.status(500).json({ error: err.message })
  }
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
