import { createClient } from '@supabase/supabase-js'

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL || 'https://zadiisjngiuwuxggmyqu.supabase.co'
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InphZGlpc2puZ2l1d3V4Z2dteXF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMDU3MjMsImV4cCI6MjA5ODU4MTcyM30.MSkXOgj9g07ZT4hA0TBsYGxCKz0z_DDTLU4O3Nxh-Gc'

export const sb = createClient(SUPA_URL, SUPA_KEY, {
  realtime: { params: { eventsPerSecond: 10 } }
})

// "View as" preview (an admin looking at Andi as someone else — lib/preview.js):
// while it's on, every write through this client is refused, so the preview
// can open anything and change nothing. Reads are untouched.
export const PREVIEW_READ_ONLY = 'Preview is read-only — exit the preview to make changes'
let readOnly = false
export const setReadOnly = (v) => { readOnly = !!v }
const refusal = { data: null, error: { message: PREVIEW_READ_ONLY }, count: null, status: 403, statusText: 'Preview' }
// A write's result as a chainable thenable: .eq().select().single() etc. all
// return the same refusal instead of throwing.
const refused = () => {
  const chain = new Proxy(function () {}, {
    get(_, k) {
      if (k === 'then') return (ok, bad) => Promise.resolve(refusal).then(ok, bad)
      if (k === 'catch' || k === 'finally') return (fn) => Promise.resolve(refusal)[k](fn)
      return () => chain
    },
    apply() { return chain },
  })
  return chain
}
const rawFrom = sb.from.bind(sb)
sb.from = (table) => {
  const q = rawFrom(table)
  if (readOnly) for (const m of ['insert', 'update', 'upsert', 'delete']) q[m] = () => refused()
  return q
}
const rawRpc = sb.rpc.bind(sb)
sb.rpc = (...a) => (readOnly ? refused() : rawRpc(...a))
const rawUpdateUser = sb.auth.updateUser.bind(sb.auth)
sb.auth.updateUser = (...a) => (readOnly ? Promise.resolve(refusal) : rawUpdateUser(...a))
