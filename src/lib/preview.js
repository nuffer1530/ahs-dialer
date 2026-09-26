// "View as" (Sep 2026): an admin sees Andi exactly as another person or role
// would — menus, routes, Home, pages — without switching logins.
//
// While previewing:
//  - AuthContext hands the app the previewed profile (the phone keeps the
//    admin's real one — PhoneContext reads realProfile — so their line and
//    status are never swapped).
//  - Same-origin /api GETs carry X-View-As; the server answers them as that
//    person, and only for a real admin (applyViewAs in server.js).
//  - Every write is refused: non-GET /api calls here (except the admin's own
//    /api/twilio/* call traffic; agent-status syncs are refused too) and every
//    Supabase write (lib/supabase.js).
import { setReadOnly, PREVIEW_READ_ONLY } from './supabase'

const KEY = 'andi-view-as'
let header = null
const rawFetch = window.fetch.bind(window)

window.fetch = (input, init = {}) => {
  if (!header) return rawFetch(input, init)
  const url = typeof input === 'string' ? input : input?.url || ''
  const path = url.startsWith(location.origin) ? url.slice(location.origin.length) : url
  if (!path.startsWith('/api/')) return rawFetch(input, init)
  const method = String(init.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    // The admin's own phone keeps working — except agent-status syncs, which
    // stay off for the whole preview so nobody's TaskRouter status can move.
    if (path.startsWith('/api/twilio/') && !path.startsWith('/api/twilio/worker-activity')) return rawFetch(input, init)
    return Promise.resolve(new Response(JSON.stringify({ error: PREVIEW_READ_ONLY }), { status: 403, headers: { 'Content-Type': 'application/json' } }))
  }
  const headers = new Headers(init.headers || (typeof input !== 'string' ? input?.headers : undefined))
  headers.set('X-View-As', header)
  return rawFetch(input, { ...init, headers })
}

// Turn the guards on/off. `who` is a profile row (or a sample role) or null.
export function applyPreview(who) {
  header = who ? (who._sample ? `role:${who.role}` : `id:${who.id}`) : null
  setReadOnly(!!who)
}

export function loadPreview() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || 'null') } catch { return null }
}
export function savePreview(who) {
  try { who ? sessionStorage.setItem(KEY, JSON.stringify(who)) : sessionStorage.removeItem(KEY) } catch {}
}

// Roles you can preview without a real account (none has one yet).
export const SAMPLE_ROLES = [{ role: 'dispatcher', name: 'Sample dispatcher' }]
