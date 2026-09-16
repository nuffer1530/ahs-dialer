import { useState, useEffect, useCallback, useMemo, useRef, useReducer, memo } from 'react'
import { sb } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthContext'
import { usePhone } from '../../lib/PhoneContext'
import { useIsMobile } from '../../lib/useIsMobile'

// Dispatch Command Center — the board as a queue you clear.
// One request per day (GET /api/dispatch/center) feeds every section; the
// page keeps a copy per day and revalidates quietly, so switching days never
// blanks the screen. Every card is a proposal with a human-picked alternative
// and one primary verb that writes to ServiceTitan through /api/dispatch/act
// (Brandyn, Sep 12: no automation — admins/dispatchers click, it happens).
// Capacity is called out, never queued. The lanes on the right are the same
// day the queue is talking about; the drawer is where any call gets
// reassigned, moved, held, noted, texted, or called.

const TIER = {
  green:    { color:'var(--tone-green-tx)', bg:'var(--tone-green-bg)', border:'var(--tone-green-bd)', label:'Heavy Hitter' },
  yellow:   { color:'var(--tone-amber-tx)', bg:'var(--tone-amber-bg)', border:'var(--tone-amber-bd)', label:'In the Lineup' },
  red:      { color:'var(--tone-red-tx)',   bg:'var(--tone-red-bg)',   border:'var(--tone-red-bd)',   label:'On the Bench' },
  unranked: { color:'var(--tone-gray-tx)',  bg:'var(--tone-gray-bg)',  border:'var(--tone-gray-bd)',  label:'Rookie — no stats yet' },
}
const ST_JOB_URL = (jobId) => `https://go.servicetitan.com/#/Job/Index/${jobId}`
const money = (v) => (v == null ? '—' : `$${Math.round(Number(v)).toLocaleString()}`)
const moneyK = (v) => (v == null ? '—' : Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1).replace(/\.0$/, '')}k` : money(v))
const hr = (iso) => {
  if (!iso) return null
  const d = new Date(iso); const h = d.getHours(), m = d.getMinutes()
  const ampm = h >= 12 ? 'PM' : 'AM'; const h12 = h % 12 === 0 ? 12 : h % 12
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ampm}` : `${h12} ${ampm}`
}
const windowLabel = (c) => { const a = hr(c.windowStart), b = hr(c.windowEnd); return !a ? 'Unscheduled' : b ? `${a}–${b}` : a }
const clock = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
const localDate = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const weekday = (ymd, opts) => (ymd ? new Date(ymd + 'T12:00:00').toLocaleDateString('en-US', opts || { weekday: 'short', month: 'short', day: 'numeric' }) : '')
const EYEBROW = { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, color: 'var(--text-secondary)' }
const MUTED = { fontSize: 12, color: 'var(--text-muted)' }
const POLL_MS = 60_000
const STALE_MS = 5 * 60_000
const FOLD = 8
const ORDER = ['HVAC', 'Plumbing', 'Electrical', 'Garage Door', 'Other']
const ST_WRITES = new Set(['assign', 'unassign', 'reassign', 'retype', 'priority', 'tags', 'hold', 'unhold', 'reschedule', 'note'])
const DISMISS_REASONS = ['wrong tech', 'already handled', 'not worth it', 'customer asked']
const WINDOWS = [[8, 12], [10, 14], [12, 16], [14, 18], [16, 20], [18, 22]]
const winName = (s, e) => `${s > 12 ? s - 12 : s}${s >= 12 ? 'PM' : 'AM'}–${e > 12 ? e - 12 : e}${e >= 12 ? 'PM' : 'AM'}`
const idle = (fn) => (typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 800))

async function authed(path, opts = {}) {
  const { data: { session } } = await sb.auth.getSession()
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}`, ...(opts.headers || {}) } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}
// /act answers 502 on a failed ServiceTitan write but the body still carries
// the audit row and the error — read it either way instead of throwing.
async function authedAct(body) {
  const { data: { session } } = await sb.auth.getSession()
  const res = await fetch('/api/dispatch/act', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok && !data.status) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

// "Push to next window": first window starting ≥ 2h after this one, same day.
function nextWindowBody(c) {
  if (!c?.windowStart || !c.appointmentId) return null
  const cur = new Date(c.windowStart)
  const w = WINDOWS.find(([s]) => s >= cur.getHours() + 2)
  if (!w) return null
  const mk = (h) => { const x = new Date(cur); x.setHours(h, 0, 0, 0); return x.toISOString() }
  return { kind: 'reschedule', appointmentId: c.appointmentId, jobId: c.jobId, jobNumber: c.jobNumber, start: mk(w[0]), end: mk(w[1]),
    arrivalWindowStart: mk(w[0]), arrivalWindowEnd: mk(w[1]), windowLabel: winName(w[0], w[1]), fromWindowLabel: windowLabel(c) }
}
// A partial card never pre-picks a tech to remove unless the server knows
// which one the failed move left behind — removing the wrong one is a real
// customer with nobody coming.
const defaultPick = (c) => (c.kind === 'partial'
  ? ((c.partialTechs || []).find(x => x.recommended)?.techId ?? null)
  : ((c.alternatives || []).find(a => a.recommended)?.techId ?? c.alternatives?.[0]?.techId ?? null))
const metaOf = (c, alt) => ({ upside: c.upside || 0, oppRate: alt?.oppRate ?? null,
  alternativesShown: (c.alternatives || []).map(a => ({ techId: a.techId, techName: a.techName, expectedValue: a.expectedValue })),
  picked: alt ? { techId: alt.techId, techName: alt.techName } : null })
// The card's primary act body for a given pick (null → nothing to run).
function primaryBody(c, pickId) {
  const id = pickId ?? defaultPick(c)
  if (c.kind === 'swap' || id === 'keep') return null
  if (c.kind === 'partial') {
    const t = (c.partialTechs || []).find(x => x.techId === id)
    return t ? { body: { ...c.action, technicianId: t.techId, technicianName: t.techName }, meta: metaOf(c, t) } : null
  }
  const alt = (c.alternatives || []).find(a => a.techId === id) || null
  // The window push is only the answer when NOBODY is free. A pick that no
  // longer matches an alternative (the board moved) yields nothing — never a
  // reschedule the dispatcher didn't choose.
  if (!alt) { if ((c.alternatives || []).length) return null; const nb = nextWindowBody(c); return nb ? { body: nb, meta: metaOf(c, null), fallback: true } : null }
  if (c.kind === 'place') return { body: { ...c.action, technicianId: alt.techId, technicianName: alt.techName }, meta: metaOf(c, alt) }
  const move = { ...c.action, toTechnicianId: alt.techId, toTechnicianName: alt.techName }
  // A trade: they take this call, the current tech takes theirs. Two ordered
  // reassigns; the second only runs if the first landed.
  if (alt.swapWith && c.current?.techId) {
    const p = alt.swapWith
    const back = { kind: 'reassign', appointmentId: p.appointmentId, jobId: p.jobId, jobNumber: p.jobNumber,
      fromTechnicianId: alt.techId, fromTechnicianName: alt.techName, toTechnicianId: c.current.techId, toTechnicianName: c.current.techName,
      // Lets the server turn a failed return leg into a "finish the trade" card.
      swapOf: { appointmentId: c.appointmentId, forJobNumber: c.jobNumber, fromTechnicianId: alt.techId, toTechnicianId: c.current.techId } }
    const stepMeta = [
      { keepCard: true },
      { keepCard: false, upside: 0,
        // The partner must still be on the recommended tech when the return leg runs.
        requireOnBoard: { appointmentId: p.appointmentId, techId: alt.techId },
        failNote: `#${c.jobNumber} is now on ${alt.techName}, but #${p.jobNumber} did NOT move to ${c.current.techName} — ${alt.techName} has both this window. A "finish the trade" card will follow.` },
    ]
    return { body: move, steps: [move, back], stepMeta, meta: metaOf(c, alt), swap: p }
  }
  return { body: move, meta: metaOf(c, alt) }
}
const callOfCard = (c) => ({ jobId: c.jobId, jobNumber: c.jobNumber, appointmentId: c.appointmentId, jobType: c.jobType, zip: c.zip,
  windowStart: c.windowStart, windowEnd: c.windowEnd, status: c.status, techId: c.current?.techId || null, techName: c.current?.techName || null })

// Mirror of the server's cache patch: the lanes and tray move the moment
// ServiceTitan says yes; the 2-second re-read confirms it.
function applyPatch(board, p) {
  const b = { ...board, calls: [...(board.calls || [])], unassigned: [...(board.unassigned || [])], onHold: [...(board.onHold || [])],
    swaps: [...(board.swaps || [])], techsToday: (board.techsToday || []).map(t => ({ ...t })), counts: { ...(board.counts || {}) } }
  const id = Number(p.appointmentId)
  const tech = (tid) => b.techsToday.find(t => Number(t.techId) === Number(tid))
  const addLoad = (tid, n) => { const t = tech(tid); if (t) { t.calls = Math.max(0, (t.calls || 0) + n); t.truckRolls = Math.max(0, (t.truckRolls || 0) + n) } }
  const isAppt = (x) => Number(x.appointmentId) === id
  switch (p.kind) {
    case 'assign': {
      const i = b.unassigned.findIndex(isAppt); const t = tech(p.technicianId)
      if (i >= 0) {
        const [u] = b.unassigned.splice(i, 1)
        b.calls.push({ ...u, techId: Number(p.technicianId), techName: p.technicianName || t?.name || '', techTier: t?.tier || 'unranked', techExpectedValue: t?.expectedValue ?? null,
          businessUnit: t?.team || null, status: 'Scheduled', actionable: true, flags: [] })
        b.counts.unassigned = Math.max(0, (b.counts.unassigned || 0) - 1)
      }
      addLoad(p.technicianId, 1); break
    }
    case 'unassign': {
      const i = b.calls.findIndex(c => isAppt(c) && (!p.technicianId || Number(c.techId) === Number(p.technicianId)))
      if (i < 0) break
      const [c] = b.calls.splice(i, 1)
      addLoad(c.techId, -1)
      // Two rows share one appointment after a half-finished move; dropping one
      // leaves the call seated with the other tech, not in the tray.
      if (!b.calls.some(isAppt)) { b.unassigned.push({ ...c, techId: null, techName: null, status: 'Scheduled' }); b.counts.unassigned = (b.counts.unassigned || 0) + 1 }
      break
    }
    case 'reassign': {
      const t = tech(p.toTechnicianId)
      b.calls = b.calls.map(c => (isAppt(c) && (!p.fromTechnicianId || Number(c.techId) === Number(p.fromTechnicianId)))
        ? { ...c, techId: Number(p.toTechnicianId), techName: p.toTechnicianName || t?.name || c.techName, techTier: t?.tier || 'unranked', techExpectedValue: t?.expectedValue ?? null, businessUnit: t?.team || c.businessUnit, flags: [] } : c)
      if (p.fromTechnicianId) addLoad(p.fromTechnicianId, -1)
      addLoad(p.toTechnicianId, 1)
      b.swaps = b.swaps.filter(s => !(Number(s.from?.jobId) === Number(p.jobId) || Number(s.to?.jobId) === Number(p.jobId) || Number(s.from?.appointmentId) === id || Number(s.to?.appointmentId) === id))
      break
    }
    case 'hold': case 'unhold': {
      const hold = p.kind === 'hold'
      const ci = b.calls.findIndex(isAppt)
      if (ci >= 0) b.calls[ci] = { ...b.calls[ci], status: hold ? 'Hold' : 'Scheduled', actionable: !hold }
      else if (hold) {
        const ui = b.unassigned.findIndex(isAppt)
        if (ui >= 0) { const [u] = b.unassigned.splice(ui, 1); b.onHold.push({ jobId: u.jobId, jobNumber: u.jobNumber, jobType: u.jobType, appointmentId: id, windowStart: u.windowStart, windowEnd: u.windowEnd }); b.counts.unassigned = Math.max(0, (b.counts.unassigned || 0) - 1) }
      } else {
        const hi = b.onHold.findIndex(isAppt)
        if (hi >= 0) { const [h] = b.onHold.splice(hi, 1); b.unassigned.push({ ...h, status: 'Scheduled', opportunity: 0, opportunityReasons: [] }); b.counts.unassigned = (b.counts.unassigned || 0) + 1 }
      }
      b.counts.onHold = b.onHold.length
      break
    }
    case 'reschedule': {
      const upd = (c) => ({ ...c, start: p.windowStart || c.start, windowStart: p.windowStart || c.windowStart, windowEnd: p.windowEnd || c.windowEnd })
      b.calls = b.calls.map(c => isAppt(c) ? upd(c) : c); b.unassigned = b.unassigned.map(c => isAppt(c) ? upd(c) : c)
      break
    }
    case 'retype': {
      if (!p.jobType) break
      const f = (c) => (Number(c.jobId) === Number(p.jobId) ? { ...c, jobType: p.jobType } : c)
      b.calls = b.calls.map(f); b.unassigned = b.unassigned.map(f)
      break
    }
    default: break
  }
  b.counts.total = b.calls.length
  return b
}
// The server omits `patch` for kinds that don't touch the board; when it does
// for one that does, build it from what we sent so the lanes still move.
function patchFor(r, body) {
  const p = r.patch ? { ...r.patch } : null
  if (!p) {
    if (!body.appointmentId && body.kind !== 'retype') return null
    if (!['assign', 'unassign', 'reassign', 'hold', 'unhold', 'reschedule', 'retype'].includes(body.kind)) return null
    return { kind: body.kind, appointmentId: body.appointmentId, jobId: body.jobId, technicianId: body.technicianId, technicianName: body.technicianName,
      fromTechnicianId: body.fromTechnicianId, toTechnicianId: body.toTechnicianId, toTechnicianName: body.toTechnicianName,
      windowStart: body.arrivalWindowStart || body.start, windowEnd: body.arrivalWindowEnd || body.end, jobType: body.jobTypeName }
  }
  if (p.kind === 'reschedule' && !p.windowStart) { p.windowStart = body.arrivalWindowStart || body.start; p.windowEnd = body.arrivalWindowEnd || body.end }
  if (p.kind === 'assign' && !p.technicianName) p.technicianName = body.technicianName
  if (p.kind === 'reassign' && !p.toTechnicianName) p.toTechnicianName = body.toTechnicianName
  if (p.kind === 'retype' && !p.jobType) p.jobType = body.jobTypeName
  return p
}
const editCache = (map, d, fn) => { const e = map.get(d); if (!e) return false; map.set(d, { ...e, payload: fn(e.payload) }); return true }

function TierDot({ tier, title }) {
  const t = TIER[tier] || TIER.unranked
  return <span title={title || t.label} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: t.color, flexShrink: 0 }} />
}
function Kind({ kind }) {
  const m = { partial: ['Finish move', 'red'], place: ['Place', 'amber'], reassign: ['Reassign', 'red'], swap: ['Swap', 'amber'], techout: ['Tech out', 'red'], late: ['Running late', 'red'] }[kind] || [kind, 'gray']
  return <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: .6, padding: '2px 7px', borderRadius: 99,
    color: `var(--tone-${m[1]}-tx)`, background: `var(--tone-${m[1]}-bg)`, border: `1px solid var(--tone-${m[1]}-bd)` }}>{m[0]}</span>
}
// On a phone every button is a thumb target (40px tall or more); the desktop keeps its sizes.
function Btn({ children, primary, danger, small, ...p }) {
  const isMobile = useIsMobile()
  return <button {...p} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: small ? '4px 10px' : '7px 14px', borderRadius: 'var(--radius)',
    fontSize: small ? 11 : 12, fontWeight: primary ? 600 : 500, border: `1px solid ${primary ? 'var(--accent)' : danger ? 'var(--danger)' : 'var(--border-strong)'}`,
    background: primary ? 'var(--accent)' : 'var(--surface)', color: primary ? '#fff' : danger ? 'var(--danger)' : 'var(--text-primary)', cursor: p.disabled ? 'default' : 'pointer',
    opacity: p.disabled ? .45 : 1, whiteSpace: 'nowrap', ...(isMobile ? { minHeight: 40 } : {}), ...(p.style || {}) }}>{children}</button>
}
function Spin({ size = 11, light }) { return <span className="spinner" style={{ width: size, height: size, borderWidth: 1.5, display: 'inline-block', ...(light ? { borderColor: 'rgba(255,255,255,.35)', borderTopColor: '#fff' } : {}) }} /> }
const MenuItem = ({ children, ...p }) => {
  const isMobile = useIsMobile()
  return (
    <button {...p} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '7px 8px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--text-primary)', borderRadius: 6, textAlign: 'left', ...(isMobile ? { minHeight: 40 } : {}), ...(p.style || {}) }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>{children}</button>
  )
}
// Floating panel that closes on Escape or a click outside it (and outside
// whatever opened it, so the opener's own click doesn't reopen it). Never wider
// than a phone screen; callers still pick the side it hangs from.
function Popover({ onClose, anchor, style, children }) {
  const ref = useRef(null)
  const isMobile = useIsMobile()
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose() }
    const m = (e) => {
      const a = anchor && (anchor.current !== undefined ? anchor.current : anchor)
      if (ref.current && !ref.current.contains(e.target) && !(a && a.contains && a.contains(e.target))) onClose()
    }
    document.addEventListener('keydown', k); document.addEventListener('mousedown', m)
    return () => { document.removeEventListener('keydown', k); document.removeEventListener('mousedown', m) }
  }, [onClose, anchor])
  return <div ref={ref} style={{ position: 'absolute', zIndex: 50, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: '0 6px 20px rgba(0,0,0,.14)', padding: 8, ...(isMobile ? { maxWidth: 'calc(100vw - 24px)' } : {}), ...style }}>{children}</div>
}

// ── Toasts (local; the page has no shared toast bus) ─────────────────────────
function useToasts() {
  const [list, setList] = useState([])
  const isMobile = useIsMobile()
  const push = useCallback((text, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2)
    setList(l => [...l, { id, text, tone }]); setTimeout(() => setList(l => l.filter(t => t.id !== id)), 4200)
  }, [])
  const el = (
    <div style={{ position: 'fixed', bottom: 18, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', gap: 8, zIndex: 900, pointerEvents: 'none' }}>
      {list.map(t => (
        <div key={t.id} style={{ background: 'var(--text-primary)', color: 'var(--surface)', padding: '10px 14px', borderRadius: 10, fontSize: 12, boxShadow: '0 10px 30px rgba(0,0,0,.25)', display: 'flex', gap: 8, alignItems: 'center', maxWidth: isMobile ? 'calc(100vw - 24px)' : 560 }}>
          <span style={{ fontWeight: 800, color: t.tone === 'ok' ? '#6FDDA0' : t.tone === 'warn' ? '#EFC252' : '#F49382' }}>{t.tone === 'ok' ? '✓' : t.tone === 'warn' ? '!' : '×'}</span>{t.text}
        </div>
      ))}
    </div>
  )
  return { push, el }
}

export default function CommandCenter() {
  const { profile } = useAuth()
  const phone = usePhone()
  const isMobile = useIsMobile()
  const [day, setDay] = useState(0)
  const dayRef = useRef(0)
  const dayCacheRef = useRef(new Map())       // day → { payload, fetchedAt }
  const inflightRef = useRef(new Map())       // day → promise, so a poll and a toggle don't double-fetch
  const seqRef = useRef(0)                    // fetch sequence; a response older than the last local patch is dropped
  const dropBeforeRef = useRef(0)
  const staleRetriesRef = useRef(0)
  const [, bump] = useReducer(x => x + 1, 0)  // re-render whenever the cache changes
  const [err, setErr] = useState('')          // nothing to show at all
  const [refreshErr, setRefreshErr] = useState('')
  const [forcing, setForcing] = useState(false)
  const [pendingKeys, setPendingKeys] = useState(() => new Set())
  const [stErrors, setStErrors] = useState({})
  const [picks, setPicks] = useState({})      // card key → tech id | 'keep'
  const [showAll, setShowAll] = useState(false)
  const [drawer, setDrawer] = useState(null)  // { call, day, prefill }
  const [reportOpen, setReportOpen] = useState(false)
  const [reportPick, setReportPick] = useState(null)
  const [leftOpen, setLeftOpen] = useState(false)
  const [covPop, setCovPop] = useState(null)  // { trade, di, left, el }
  const [building, setBuilding] = useState(null)   // `${trade}|${date}` while a call list builds
  const [flashKey, setFlashKey] = useState(null)
  const [now, setNow] = useState(Date.now())
  const nextPollRef = useRef(Date.now() + POLL_MS)
  const actChainRef = useRef(Promise.resolve())
  const reloadTimerRef = useRef(null)
  const prefetchedRef = useRef(false)
  const detailMemoRef = useRef(new Map())
  const reportWrapRef = useRef(null)
  const leftTileRef = useRef(null)
  const covWrapRef = useRef(null)
  const { push: toast, el: toasts } = useToasts()
  const closeReport = useCallback(() => { setReportOpen(false); setReportPick(null) }, [])
  const closeLeft = useCallback(() => setLeftOpen(false), [])
  const closeCov = useCallback(() => setCovPop(null), [])

  const load = useCallback(async (d, { force = false } = {}) => {
    // Reuse an in-flight read for this day only if it started after the last
    // local patch — a read that predates a write is going to be dropped.
    const cur = inflightRef.current.get(d)
    if (!force && cur && cur.seq > dropBeforeRef.current) return cur.p
    const seq = ++seqRef.current
    const p = (async () => {
      try {
        const payload = await authed(`/api/dispatch/center?day=${d}${force ? '&force=1' : ''}`)
        if (seq <= dropBeforeRef.current) return payload   // computed before a local patch — the follow-up read wins
        dayCacheRef.current.set(d, { payload, fetchedAt: Date.now() })
        setErr(''); setRefreshErr('')
        // A stale copy means the server is recomputing — read again shortly,
        // backing off, and not forever if the recompute keeps failing.
        if (payload.stale && d === dayRef.current && staleRetriesRef.current < 6) {
          staleRetriesRef.current++
          clearTimeout(reloadTimerRef.current); reloadTimerRef.current = setTimeout(() => load(d), 4000 * staleRetriesRef.current)
        } else if (!payload.stale) staleRetriesRef.current = 0
        return payload
      } catch (e) {
        if (dayCacheRef.current.size) setRefreshErr(e.message); else setErr(e.message)
        return null
      } finally {
        if (inflightRef.current.get(d)?.p === p) inflightRef.current.delete(d)
        bump()
      }
    })()
    inflightRef.current.set(d, { p, seq }); bump()
    return p
  }, [bump])
  const scheduleReload = useCallback((d, ms = 2000) => { clearTimeout(reloadTimerRef.current); reloadTimerRef.current = setTimeout(() => load(d), ms) }, [load])

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  // Day change: whatever copy exists is already on screen; revalidate unless it
  // landed seconds ago (the prefetch just did). Days 1–2 warm up after day 0.
  useEffect(() => {
    dayRef.current = day
    const e = dayCacheRef.current.get(day)
    const fresh = e && !e.payload?.stale && Date.now() - e.fetchedAt < 15_000
    const p = fresh ? Promise.resolve(e.payload) : load(day)
    p.then(ok => { if (ok && day === 0 && !prefetchedRef.current) { prefetchedRef.current = true; idle(() => { load(1); load(2) }) } })
  }, [day, load])
  // One interval for the life of the page; it reads the current day from the
  // ref so toggling days never resets the cadence. Hidden tabs skip the read.
  useEffect(() => {
    const tick = () => { nextPollRef.current = Date.now() + POLL_MS; if (document.visibilityState === 'visible') load(dayRef.current) }
    const t = setInterval(tick, POLL_MS)
    const onVis = () => { if (document.visibilityState === 'visible') load(dayRef.current) }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); clearTimeout(reloadTimerRef.current) }
  }, [load])

  const refresh = async () => { setForcing(true); try { await load(day, { force: true }) } finally { setForcing(false) } }

  const prependAction = useCallback((d, action) => {
    if (!action) return
    editCache(dayCacheRef.current, d, p => ({ ...p, actions: [action, ...(p.actions || []).filter(a => a.id !== action.id)] })); bump()
  }, [bump])
  const dropCards = useCallback((d, test, hide) => {
    editCache(dayCacheRef.current, d, p => {
      const cards = (p.queue?.cards || []).filter(c => !test(c))
      const gone = (p.queue?.cards || []).length - cards.length
      return { ...p, queue: { ...(p.queue || {}), cards, atStake: cards.reduce((s, c) => s + (c.upside || 0), 0), hiddenCount: (p.queue?.hiddenCount || 0) + (hide ? gone : 0) } }
    }); bump()
  }, [bump])

  // One promise chain: two clicks never race the board. Only the acted card
  // shows pending; nothing else is disabled.
  const act = useCallback((body, cardKey, meta = {}) => {
    const { keepCard, requireOnBoard, failNote, ...sendMeta } = meta
    const d = sendMeta.day ?? dayRef.current
    const key = cardKey || `${body.kind}:${body.appointmentId || body.jobId || ''}`
    // Pending from the moment of the click, not when the chain reaches it —
    // otherwise a second card looks clickable while the first is still writing.
    setPendingKeys(s => new Set(s).add(key))
    const noteErr = (msg) => (failNote ? `${failNote} (${msg})` : msg)
    const run = async () => {
      try {
        // A return leg only runs if the call it returns is still where the
        // card said it was — another dispatcher may have moved it since.
        if (requireOnBoard) {
          const b = dayCacheRef.current.get(d)?.payload?.board
          const still = (b?.calls || []).some(x => Number(x.appointmentId) === Number(requireOnBoard.appointmentId) && Number(x.techId) === Number(requireOnBoard.techId))
          if (!still) {
            const msg = `#${body.jobNumber} is no longer on ${body.fromTechnicianName || 'that tech'} — nothing sent for this leg`
            if (cardKey) setStErrors(e => ({ ...e, [cardKey]: noteErr(msg) }))
            toast(msg, 'warn'); dropBeforeRef.current = seqRef.current; scheduleReload(d, 1500)
            return { status: 'skipped', error: msg }
          }
        }
        const r = await authedAct({ ...body, cardKey: cardKey || undefined, ...sendMeta, day: d })
        if (r.status === 'ok') {
          const patch = patchFor(r, body)
          const pd = patch?.day ?? d
          editCache(dayCacheRef.current, pd, p => ({ ...p, stale: true, board: patch ? applyPatch(p.board, patch) : p.board }))
          const id = Number(body.appointmentId) || null
          // Any card built on this appointment — its own, a swap's second half,
          // or a trade partner in an alternative — is stale now; the re-read rebuilds it.
          if (!keepCard) dropCards(d, c => c.key === cardKey || (id && (Number(c.appointmentId) === id
            || (c.appointmentIds || []).some(x => Number(x) === id) || (c.alternatives || []).some(a => Number(a.swapWith?.appointmentId) === id))), false)
          else if (id) dropCards(d, c => c.key !== cardKey && (Number(c.appointmentId) === id || (c.appointmentIds || []).some(x => Number(x) === id) || (c.alternatives || []).some(a => Number(a.swapWith?.appointmentId) === id)), false)
          prependAction(d, r.action)
          dropBeforeRef.current = seqRef.current
          if (cardKey) setStErrors(e => { if (!(cardKey in e)) return e; const n = { ...e }; delete n[cardKey]; return n })
          toast(r.summary || 'Done')
          scheduleReload(d)
        } else {
          if (cardKey) setStErrors(e => ({ ...e, [cardKey]: noteErr(r.error || 'ServiceTitan did not finish that') }))
          prependAction(d, r.action)
          toast(failNote || r.summary || r.error || 'ServiceTitan did not finish that', 'warn')
          // A partial write changed ServiceTitan — re-read so the board and the
          // "finish the move" card reflect it. A failed return leg gets its
          // "finish the trade" card the same way.
          if (r.status === 'partial' || failNote) { dropBeforeRef.current = seqRef.current; scheduleReload(d, 4000) }
        }
        return r
      } catch (e) {
        if (cardKey) setStErrors(x => ({ ...x, [cardKey]: noteErr(e.message) }))
        toast(failNote || e.message, 'err')
        if (failNote) { dropBeforeRef.current = seqRef.current; scheduleReload(d, 4000) }
        return null
      }
      finally { setPendingKeys(s => { const n = new Set(s); n.delete(key); return n }) }
    }
    const p = actChainRef.current.then(run, run)
    actChainRef.current = p.catch(() => {})
    return p
  }, [toast, dropCards, prependAction, scheduleReload])

  const dismiss = useCallback(async (key, action, reason, minutes) => {
    const d = dayRef.current
    try {
      await authed('/api/dispatch/dismiss', { method: 'POST', body: JSON.stringify({ cardKey: key, action, reason, minutes, day: dayCacheRef.current.get(d)?.payload?.board?.date }) })
      dropCards(d, c => c.key === key, true)
      toast(reason === 'keep as booked' ? (action === 'snooze' ? `Kept as booked — back in ${minutes} min if it's still stuck` : 'Kept as booked') : action === 'snooze' ? `Snoozed ${minutes} min` : 'Dismissed for today')
    } catch (e) { toast(e.message, 'err') }
  }, [toast, dropCards])

  const setTechOut = useCallback((d, list, techId, out) => {
    editCache(dayCacheRef.current, d, p => ({ ...p, techOut: list || p.techOut,
      board: { ...p.board, techsToday: (p.board?.techsToday || []).map(t => (Number(t.techId) === Number(techId) ? { ...t, out } : t)) } })); bump()
  }, [bump])
  // The server recomputes the affected days after a tech-out; the first read
  // waits on that compute, so ask a beat later rather than racing it.
  const afterTechOut = (d, both) => {
    dropBeforeRef.current = seqRef.current
    scheduleReload(d, 1500)
    if (both && d < 2) setTimeout(() => load(d + 1), 2500)
  }
  const techOut = async (t, until) => {
    const date = dayCacheRef.current.get(day)?.payload?.board?.date
    try {
      const r = await authed('/api/dispatch/tech-out', { method: 'POST', body: JSON.stringify({ techId: t.techId, techName: t.name, until, day: date }) })
      setTechOut(day, r.techOut, t.techId, true)
      setReportOpen(false); setReportPick(null)
      toast(`${t.name} is out ${until === 'today' ? 'for the rest of the day' : 'through tomorrow'} — their calls are being re-placed`, 'warn')
      afterTechOut(day, until === 'tomorrow')
    } catch (e) { toast(e.message, 'err') }
  }
  const techBack = async (entry) => {
    const date = dayCacheRef.current.get(day)?.payload?.board?.date
    try {
      const r = await authed('/api/dispatch/tech-out', { method: 'DELETE', body: JSON.stringify({ techId: entry.techId, day: date }) })
      setTechOut(day, r.techOut, entry.techId, false)
      toast(`${entry.name} is back on`)
      afterTechOut(day, entry.until === 'tomorrow')
    } catch (e) { toast(e.message, 'err') }
  }

  // Open the LIVE row when we have one: a card's own copy can lack the tech
  // (swap and partial cards carry no `current`), and a drawer that thinks a
  // seated call is unassigned would ADD a tech in ServiceTitan on Save.
  const openCall = useCallback((call, extra) => {
    const b = dayCacheRef.current.get(dayRef.current)?.payload?.board
    const live = b && call?.appointmentId
      ? (b.calls || []).find(x => Number(x.appointmentId) === Number(call.appointmentId) && (!call.techId || Number(x.techId) === Number(call.techId)))
      : null
    setDrawer({ call: live ? { ...live } : call, day: dayRef.current, ...(extra || {}) })
  }, [])
  const closeDrawer = useCallback(() => setDrawer(null), [])
  const onUnhold = useCallback((h) => act({ kind: 'unhold', appointmentId: h.appointmentId, jobId: h.jobId, jobNumber: h.jobNumber }, null, { day: dayRef.current }), [act])
  const onPick = useCallback((key, id) => setPicks(p => ({ ...p, [key]: id })), [])
  const onBuilt = useCallback((trade, date, list) => {
    for (const d of dayCacheRef.current.keys()) editCache(dayCacheRef.current, d, p => ({ ...p, coverage: p.coverage ? { ...p.coverage,
      board: p.coverage.board.map(r => (r.trade === trade ? { ...r, days: r.days.map(x => (x.date === date ? { ...x, list } : x)) } : r)) } : p.coverage }))
    bump()
  }, [bump])
  const buildList = async (trade, date) => {
    const k = `${trade}|${date}`
    setBuilding(k)
    try {
      const r = await authed('/api/dispatch/campaign-from-gap', { method: 'POST', body: JSON.stringify({ trade, date }) })
      toast(r.summary || (r.created ? `Built ${r.created} contacts` : 'Nobody matched — no list built'), r.created || r.existed ? 'ok' : 'warn')
      if (r.campaignId) onBuilt(trade, date, { campaignId: r.campaignId, name: r.name })
      scheduleReload(dayRef.current)
    } catch (e) { toast(e.message, 'err') }
    finally { setBuilding(b => (b === k ? null : b)) }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const entry = dayCacheRef.current.get(day)
  const anyEntry = entry || dayCacheRef.current.values().next().value
  const payload = entry?.payload
  const board = payload?.board, queue = payload?.queue, coverage = payload?.coverage
  const rev = board?.dayRevenue
  const calls = board?.calls || []
  const techs = board?.techsToday || []
  const cards = queue?.cards || []
  const dates = anyEntry?.payload?.coverage?.dates || []
  const dayName = (d) => (d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : weekday(dates[2] || (d === day ? board?.date : null)) || 'Day after')
  const refreshing = inflightRef.current.has(day)
  const leftBehind = useMemo(() => {
    const done = calls.filter(c => c.status === 'Done')
    const quoted = done.filter(c => c.outcome?.kind === 'quoted')
    return { rows: quoted, quotedAmt: quoted.reduce((s, c) => s + (c.outcome.amount || 0), 0), none: done.filter(c => c.outcome?.kind === 'none').length }
  }, [calls])
  const visibleCards = showAll ? cards : cards.slice(0, FOLD)
  // Tech-out cards stay together under their tech's header wherever the sort
  // put the first one — the whole group, even past the fold, so "Apply all"
  // and the count mean every call the tech had.
  const renderList = useMemo(() => {
    const out = []; const seen = new Set()
    for (const c of visibleCards) {
      if (c.kind === 'techout' && c.group) {
        if (seen.has(c.group.techId)) continue
        seen.add(c.group.techId)
        out.push({ group: c.group, cards: cards.filter(x => x.kind === 'techout' && x.group?.techId === c.group.techId) })
      } else out.push({ card: c })
    }
    return out
  }, [visibleCards, cards])

  // Only real picks run in a batch; a card with nobody free is left for the
  // dispatcher (pushing a customer's window is never a side effect of a button).
  const applyAll = async (group, groupCards) => {
    let n = 0; const skipped = []
    for (const c of groupCards) {
      const pb = primaryBody(c, picks[c.key])
      if (!pb || pb.fallback) { skipped.push(c.jobNumber); continue }
      let ok = true
      for (const [i, step] of (pb.steps || [pb.body]).entries()) {
        const r = await act(step, c.key, { ...pb.meta, upside: i === 0 ? c.upside : 0, day, keepCard: pb.steps ? i < pb.steps.length - 1 : false, ...(pb.stepMeta?.[i] || {}) })
        if (!r || r.status !== 'ok') { ok = false; break }
      }
      if (!ok) { toast(`Stopped at #${c.jobNumber} — sort that one out first`, 'warn'); return }
      n++
    }
    const tail = skipped.length ? ` · ${skipped.length} need a window — do those by hand (#${skipped.join(', #')})` : ''
    toast(n ? `${n} move${n === 1 ? '' : 's'} applied for ${group.techName}${tail}` : `Nothing to apply — no picks on these cards${tail}`, n ? 'ok' : 'warn')
  }
  const jumpToNext = () => {
    if (!cards[0]) return
    document.getElementById('cc-next-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlashKey(cards[0].key); setTimeout(() => setFlashKey(null), 1600)
  }

  const drawerBoard = drawer ? (dayCacheRef.current.get(drawer.day)?.payload?.board || board) : null
  const drawerEl = drawer && drawerBoard && (
    <Drawer key={drawer.call.appointmentId || drawer.call.jobId} call={drawer.call} board={drawerBoard} holdReasons={payload?.holdReasons || anyEntry?.payload?.holdReasons || []} profile={profile} phone={phone}
      onClose={closeDrawer} onAct={(body) => act(body, null, { day: drawer.day })} toast={toast} detailMemo={detailMemoRef} prefill={drawer.prefill || null} />
  )

  if (!anyEntry) {
    return <div>{err ? <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div> : <div className="spinner lg" style={{ margin: '60px auto' }} />}{toasts}</div>
  }

  // Freshness: what's on screen, from the client's own clock.
  const age = payload ? now - Date.parse(payload.generatedAt || board?.generatedAt || 0) : 0
  const pill = !entry ? ['loading…', 'gray'] : refreshing ? ['refreshing…', 'amber'] : age > STALE_MS ? [`stale ${Math.round(age / 60000)} min`, 'red'] : payload.stale ? ['refreshing…', 'amber'] : [`live · ${clock(new Date(entry.fetchedAt).toISOString())}`, 'green']
  const countdown = Math.max(0, Math.ceil((nextPollRef.current - now) / 1000))
  const next = cards[0]
  const outList = payload?.techOut || []
  const di = dates.indexOf(board?.date) >= 0 ? dates.indexOf(board?.date) : day
  const covCells = (coverage?.board || []).map(r => ({ trade: r.trade, d: r.days?.[di] })).filter(x => x.d)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header row: day toggle · status · next · report a change · refresh.
          On a phone it stacks by flex order: toggle + freshness, then the counts, then the buttons. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 99, overflow: 'hidden' }}>
          {[0, 1, 2].map(d => (
            <button key={d} onClick={() => { dayRef.current = d; setShowAll(false); setDay(d) }} style={{ padding: '5px 13px', border: 'none', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              background: day === d ? 'var(--text-primary)' : 'transparent', color: day === d ? 'var(--surface)' : 'var(--text-muted)', ...(isMobile ? { minHeight: 40, padding: '8px 12px' } : {}) }}>{dayName(d)}</button>
          ))}
        </div>
        {board && <span style={{ ...MUTED, ...(isMobile ? { order: 2, flexBasis: '100%' } : {}) }}>{board.counts.total} calls · {rev.remaining} to run · {rev.done} done · {rev.working} on site</span>}
        <span title={payload ? `board computed ${clock(payload.generatedAt)}` : ''} style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: .5, padding: '2px 8px', borderRadius: 99, display: 'inline-flex', alignItems: 'center', gap: 5,
          color: `var(--tone-${pill[1]}-tx)`, background: `var(--tone-${pill[1]}-bg)`, border: `1px solid var(--tone-${pill[1]}-bd)` }}>{refreshing && <Spin size={9} />}{pill[0]}</span>
        {refreshErr && entry && <span style={{ ...MUTED, fontSize: 11, color: 'var(--tone-amber-tx)', ...(isMobile ? { order: 2, flexBasis: '100%' } : {}) }}>couldn’t refresh — showing {clock(new Date(entry.fetchedAt).toISOString())}</span>}
        <span style={{ flex: 1, ...(isMobile ? { display: 'none' } : {}) }} />
        <div ref={reportWrapRef} style={{ position: 'relative', ...(isMobile ? { order: 3 } : {}) }}>
          <Btn onClick={() => { setReportOpen(o => !o); setReportPick(null) }}>Report a change ▾</Btn>
          {reportOpen && board && (
            <Popover anchor={reportWrapRef} onClose={closeReport} style={{ right: 0, top: '110%', width: 320, ...(isMobile ? { right: 'auto', left: 0 } : {}) }}>
              {reportPick ? (
                <>
                  <div style={{ ...EYEBROW, padding: '4px 6px' }}>{reportPick.name} is out for</div>
                  <MenuItem onClick={() => techOut(reportPick, 'today')}><span style={{ fontWeight: 600 }}>{day === 0 ? 'The rest of today' : `All of ${dayName(day).toLowerCase()}`}</span></MenuItem>
                  <MenuItem onClick={() => techOut(reportPick, 'tomorrow')}><span style={{ fontWeight: 600 }}>{day === 0 ? 'Through tomorrow' : 'That day and the next'}</span></MenuItem>
                  <MenuItem onClick={() => setReportPick(null)} style={{ color: 'var(--text-muted)' }}>back</MenuItem>
                </>
              ) : (
                <>
                  <div style={{ ...EYEBROW, padding: '4px 6px' }}>Tech out</div>
                  <div style={{ maxHeight: 240, overflow: 'auto' }}>
                    {techs.filter(t => t.rankable && t.onShift && !t.out).sort((a, b) => (b.calls || 0) - (a.calls || 0)).map(t => (
                      <MenuItem key={t.techId} onClick={() => setReportPick(t)}>
                        <TierDot tier={t.tier} /><span style={{ fontWeight: 600 }}>{t.name}</span><span style={MUTED}>{t.calls} call{t.calls === 1 ? '' : 's'} · {t.trade}</span>
                      </MenuItem>
                    ))}
                  </div>
                  {outList.length > 0 && (
                    <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
                      <div style={{ ...EYEBROW, padding: '2px 6px' }}>Already out</div>
                      {outList.map(o => (
                        <div key={o.techId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 12 }}>
                          <span style={{ fontWeight: 600 }}>{o.name}</span><span style={MUTED}>{o.until === 'tomorrow' ? 'through tomorrow' : 'rest of the day'} · {o.by}</span>
                          <button onClick={() => techBack(o)} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, fontWeight: 600, ...(isMobile ? { minHeight: 40, padding: '0 8px' } : {}) }}>Undo</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ ...MUTED, padding: '6px 6px 2px', fontSize: 11 }}>Their calls come back as cards with picks. ServiceTitan still shows them on shift until someone adds time off there.</div>
                </>
              )}
            </Popover>
          )}
        </div>
        <Btn small disabled={forcing} onClick={refresh} style={isMobile ? { order: 3 } : undefined}>{forcing && <Spin size={10} />}Refresh</Btn>
      </div>
      {board && (
        <div onClick={next ? jumpToNext : undefined} style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'baseline', cursor: next ? 'pointer' : 'default', marginTop: -6, ...(isMobile ? { flexWrap: 'wrap' } : {}) }}>
          <span style={{ ...EYEBROW, color: next ? 'var(--danger)' : 'var(--success)' }}>Next</span>
          {next
            ? <span><span style={{ fontWeight: 700 }}>{next.title}</span> — by {hr(next.actBy)}{next.upside > 0 && <span style={{ color: 'var(--tone-green-tx)', fontWeight: 700 }}> (+{money(next.upside)})</span>}</span>
            : <span style={{ color: 'var(--text-secondary)' }}>Board is clean — next re-read in {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}</span>}
        </div>
      )}

      {!board && <div className="spinner lg" style={{ margin: '60px auto' }} />}
      {board && (
        <>
          {/* State tiles — "needs you" is the only tinted number. Four across; two-up on a phone. */}
          <div style={{ position: 'relative' }}>
            <div className={isMobile ? 'mgrid' : undefined} style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0,1fr))' : 'repeat(4, minmax(0,1fr))', gap: 12 }}>
              <Tile label="Needs a decision" value={cards.length ? `${cards.length} move${cards.length === 1 ? '' : 's'}` : 'Board is clean'} sub={cards.length ? `${money(queue.atStake)} expected if you take the picks` : 'nothing waiting on you'} color={cards.length ? 'var(--warning)' : 'var(--success)'} />
              <Tile label="Expected revenue" value={money(rev.expected)} sub={`${money((rev.soldToday || 0) + (rev.expected || 0))} projected day end · ${rev.opportunityCalls} opportunity calls`} />
              {day === 0 ? (
                <>
                  <Tile label="Sold so far" value={money(rev.soldToday)} sub={`${money(rev.invoicedToday)} invoiced · ${money(rev.booked)} installs finishing`} />
                  <Tile tileRef={leftTileRef} label="Left behind" value={money(leftBehind.quotedAmt)} sub={`${leftBehind.rows.length} quoted, not sold · ${leftBehind.none} no sale`} onClick={() => setLeftOpen(o => !o)} active={leftOpen} />
                </>
              ) : (
                <>
                  <Tile label="Opportunities booked" value={`${calls.filter(c => c.opportunity >= 3).length}`} sub={`${money(calls.reduce((s, c) => s + (c.expectedRevenue || 0), 0))} expected if they run`} />
                  <Tile label="Open slots ≈ $" value={`${covCells.reduce((s, x) => s + (x.d.needed || 0), 0)} open`}
                    sub={covCells.some(x => x.d.stake) ? `≈ ${money(covCells.reduce((s, x) => s + (x.d.stake || 0), 0))} if booked · ${covCells.filter(x => x.d.needed > 0).map(x => `${x.trade} ${x.d.needed}`).join(' · ') || 'all trades at target'}` : 'no trade rates to price them yet'} />
                </>
              )}
            </div>
            {leftOpen && day === 0 && (
              <Popover anchor={leftTileRef} onClose={closeLeft} style={{ right: 0, top: '100%', marginTop: 6, width: 'min(520px, 100%)', ...(isMobile ? { left: 0, width: 'auto' } : {}) }}>
                <div style={{ ...EYEBROW, padding: '4px 6px' }}>Quoted, not sold — worth a follow-up call</div>
                {!leftBehind.rows.length && <div style={{ ...MUTED, padding: '6px 6px 4px' }}>Nothing quoted and left on the table yet today.</div>}
                <div style={{ maxHeight: 280, overflow: 'auto' }}>
                  {leftBehind.rows.map(c => (
                    <div key={c.appointmentId + '|' + c.techId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 12, borderTop: '1px solid var(--border)', ...(isMobile ? { flexWrap: 'wrap' } : {}) }}>
                      <span style={{ fontWeight: 700 }}>#{c.jobNumber}</span><span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{c.jobType}</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><TierDot tier={c.techTier} />{c.techName}</span>
                      <span style={{ marginLeft: 'auto', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>Quoted {money(c.outcome.amount)}</span>
                      <a href="#" onClick={e => { e.preventDefault(); setLeftOpen(false); openCall(c) }} style={{ fontSize: 11 }}>open call</a>
                    </div>
                  ))}
                </div>
              </Popover>
            )}
          </div>

          <CapacityCallout coverage={coverage} />

          {/* Coverage strip — information for CSRs and marketing, never a card */}
          {coverage?.board && (
            <div ref={covWrapRef} style={{ position: 'relative' }}>
              <div className="card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', ...(isMobile ? { gap: 10 } : {}) }}>
                <span style={EYEBROW}>Coverage · booked %</span>
                {coverage.board.map(r => (
                  <div key={r.trade} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, minWidth: 82 }}>{r.trade === 'Garage Door' ? 'Garage Doors' : r.trade}</span>
                    {r.days.map((d, i) => {
                      const tone = d.status === 'none' ? 'gray' : d.status === 'good' ? 'green' : d.status === 'warn' ? 'amber' : 'red'
                      const open = covPop && covPop.trade === r.trade && covPop.di === i
                      return <button key={i} title={`${d.date}: ${d.calls} booked / ${d.capacity} slots · ${d.needed} open${d.stake ? ` ≈ ${money(d.stake)}` : ''}`}
                        onClick={e => {
                          if (open) return setCovPop(null)
                          const w = covWrapRef.current?.getBoundingClientRect(), b = e.currentTarget.getBoundingClientRect()
                          setCovPop({ trade: r.trade, di: i, el: e.currentTarget, left: w ? Math.max(0, Math.min(b.left - w.left, w.width - 360)) : 0 })
                        }}
                        style={{ position: 'relative', minWidth: 40, textAlign: 'center', padding: '2px 6px', borderRadius: 6, fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 12, cursor: 'pointer',
                          color: `var(--tone-${tone}-tx)`, background: `var(--tone-${tone}-bg)`, border: `1px solid var(--tone-${tone}-bd)`, outline: open ? '2px solid var(--border-strong)' : 'none', outlineOffset: 1, ...(isMobile ? { minHeight: 40, padding: '6px 10px' } : {}) }}>
                        {d.status === 'none' ? '—' : `${d.pct}%`}
                        {building === `${r.trade}|${d.date}` ? <span style={{ position: 'absolute', top: -5, right: -5 }}><Spin size={9} /></span>
                          : d.list ? <span style={{ position: 'absolute', top: -6, right: -4, fontSize: 9, color: 'var(--tone-green-tx)', fontWeight: 800 }}>✓</span> : null}
                      </button>
                    })}
                  </div>
                ))}
                <span style={{ ...MUTED, fontSize: 11 }}>{['today', 'tomorrow', weekday(coverage.dates?.[2], { weekday: 'short' }).toLowerCase() || 'day after'].join(' · ')} · ✓ = call list built</span>
              </div>
              {covPop && (() => {
                const row = coverage.board.find(r => r.trade === covPop.trade); const cell = row?.days?.[covPop.di]
                if (!cell) return null
                const key = `${covPop.trade}|${cell.date}`
                return (
                  <Popover anchor={covPop.el} onClose={closeCov} style={{ left: covPop.left, top: '100%', marginTop: 6, width: 360, ...(isMobile ? { left: 0, right: 0, width: 'auto' } : {}) }}>
                    <div style={{ ...EYEBROW, padding: '4px 6px' }}>{covPop.trade} · {dayName(covPop.di)} · {cell.calls}/{cell.capacity} ({cell.pct}%)</div>
                    <div style={{ padding: '2px 6px', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 180, overflow: 'auto' }}>
                      {(cell.detail?.techs || []).length ? cell.detail.techs.map((t, i) => <span key={i}>{t.name}{t.off ? <span style={MUTED}> · {t.off}</span> : ''}</span>) : <span style={MUTED}>No techs scheduled</span>}
                    </div>
                    <div style={{ ...MUTED, padding: '6px 6px 2px', fontSize: 11 }}>{cell.calls} call{cell.calls === 1 ? '' : 's'} · {cell.opps} opp{cell.opps === 1 ? '' : 's'} · {cell.installs} install{cell.installs === 1 ? '' : 's'}{cell.needed > 0 ? ` · ${cell.needed} open${cell.stake ? ` ≈ ${money(cell.stake)}` : ''}` : ''}</div>
                    {cell.oppWatch && <div style={{ padding: '2px 6px', fontSize: 11, color: 'var(--tone-amber-tx)', fontWeight: 600 }}>full — keep booking high-value{covPop.di === 0 && day === 0 && rev.rescheduleCandidates != null ? ` · ${rev.rescheduleCandidates} reschedule candidates` : ''}</div>}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 6px 2px', flexWrap: 'wrap' }}>
                      {cell.list ? <span style={{ fontSize: 12, color: 'var(--tone-green-tx)', fontWeight: 600 }}>list exists ✓</span>
                        : <Btn small primary disabled={building === key} onClick={() => buildList(covPop.trade, cell.date)}>{building === key ? <><Spin size={10} light /> Building — about 20 seconds</> : 'Build call list'}</Btn>}
                      <a href="/callboard" target="_blank" rel="noreferrer" style={{ fontSize: 12, marginLeft: 'auto' }}>Open Call Board ↗</a>
                    </div>
                  </Popover>
                )
              })()}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 7fr) minmax(0, 5fr)', gap: 14, alignItems: 'start' }}>
            {/* Queue */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>Needs a decision</span>
                <span style={MUTED}>{queue.hiddenCount ? `${queue.hiddenCount} snoozed or dismissed · ` : ''}sorted by when you have to act</span>
                {day === 0 && <MovesStrip actions={payload.actions || []} dismissals={payload.dismissals || []} />}
              </div>
              {!cards.length && (
                <div style={{ border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius-lg)', padding: '26px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  <div style={{ color: 'var(--text-primary)', fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Board is clean — nothing needs you.</div>
                  New bookings, late windows and call-outs land here within a minute.
                </div>
              )}
              {renderList.map(item => item.group ? (
                <div key={`g:${item.group.techId}`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 'var(--radius)', background: 'var(--tone-red-bg)', border: '1px solid var(--tone-red-bd)', fontSize: 12, ...(isMobile ? { flexWrap: 'wrap' } : {}) }}>
                    <span style={{ fontWeight: 800, color: 'var(--tone-red-tx)' }}>{item.group.techName} out {item.group.until === 'tomorrow' ? 'through tomorrow' : 'for the rest of today'}</span>
                    <span style={MUTED}>{item.cards.length} call{item.cards.length === 1 ? '' : 's'}</span>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      <Btn small primary disabled={item.cards.some(c => pendingKeys.has(c.key))} onClick={() => applyAll(item.group, item.cards)}>Apply all picks</Btn>
                      <Btn small onClick={() => techBack({ techId: item.group.techId, name: item.group.techName, until: item.group.until })}>Back on</Btn>
                    </span>
                  </div>
                  {item.cards.map(c => <Card key={c.key} c={c} day={day} isNext={c.key === cards[0]?.key} flash={flashKey === c.key} pending={pendingKeys.has(c.key)} stError={stErrors[c.key]} pick={picks[c.key]} onPick={onPick} onAct={act} onDismiss={dismiss} onOpen={openCall} />)}
                </div>
              ) : (
                <Card key={item.card.key} c={item.card} day={day} isNext={item.card.key === cards[0]?.key} flash={flashKey === item.card.key} pending={pendingKeys.has(item.card.key)} stError={stErrors[item.card.key]} pick={picks[item.card.key]} onPick={onPick} onAct={act} onDismiss={dismiss} onOpen={openCall} />
              ))}
              {cards.length > FOLD && !showAll && <Btn onClick={() => setShowAll(true)} style={{ alignSelf: 'center' }}>{cards.length - FOLD} more ▾</Btn>}
            </div>

            {/* Board lanes */}
            <Board board={board} onOpen={openCall} onUnhold={onUnhold} pendingKeys={pendingKeys} />
          </div>
        </>
      )}

      {drawerEl}
      {toasts}
    </div>
  )
}

const Tile = ({ label, value, sub, color, onClick, active, tileRef }) => (
  <div ref={tileRef} className="card" onClick={onClick} style={{ padding: '12px 14px', cursor: onClick ? 'pointer' : 'default', outline: active ? '2px solid var(--border-strong)' : 'none', outlineOffset: -1 }}>
    <div style={{ ...EYEBROW, display: 'flex', gap: 6 }}>{label}{onClick && <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--text-muted)' }}>▾</span>}</div>
    <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -.5, lineHeight: 1.15, marginTop: 4, color: color || 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    <div style={{ ...MUTED, fontSize: 11, marginTop: 2 }}>{sub}</div>
  </div>
)

// One muted line: where tomorrow's board is short and what it's worth.
function CapacityCallout({ coverage }) {
  if (!coverage?.board?.length) return null
  const lines = []
  for (const [di, date] of (coverage.dates || []).entries()) {
    const cells = coverage.board.map(r => ({ trade: r.trade, d: r.days?.[di] })).filter(x => x.d && (x.d.status === 'warn' || x.d.status === 'under') && x.d.needed > 0)
    if (!cells.length) continue
    lines.push({ label: di === 0 ? 'Today' : di === 1 ? 'Tomorrow' : weekday(date, { weekday: 'long' }), cells, built: cells.filter(x => x.d.list).map(x => x.trade) })
  }
  if (!lines.length) return null
  const shown = lines.slice(0, 2); const more = lines.slice(2).reduce((s, l) => s + l.cells.length, 0)
  return (
    <div style={{ ...MUTED, lineHeight: 1.6, marginTop: -6 }}>
      {shown.map((l, i) => (
        <div key={l.label}>
          <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{l.label}:</span> {l.cells.map(x => `${x.trade} ${x.d.pct}% (${x.d.needed} open${x.d.stake ? ` ≈ ${moneyK(x.d.stake)}` : ''})`).join(' · ')}
          {l.built.length ? ` — ${l.built.join(', ')} list built ✓` : ''}{i === shown.length - 1 && more ? ` · +${more} more` : ''}
        </div>
      ))}
    </div>
  )
}

// Today's moves — the audit trail folded into the queue header.
function MovesStrip({ actions, dismissals }) {
  const [open, setOpen] = useState(false)
  const isMobile = useIsMobile()
  const ok = actions.filter(a => a.st_status === 'ok')
  const applied = ok.filter(a => ST_WRITES.has(a.kind)).length
  const partial = actions.filter(a => a.st_status === 'partial').length
  const failed = actions.filter(a => a.st_status === 'failed').length
  const upside = ok.reduce((s, a) => s + (Number(a.after?.upside) || 0), 0)
  const dismissed = dismissals.filter(d => d.action === 'dismiss')
  const reasons = Object.entries(dismissed.reduce((m, d) => { const k = d.reason || 'no reason'; m[k] = (m[k] || 0) + 1; return m }, {})).sort((a, b) => b[1] - a[1])
  const rows = [...actions.filter(a => a.st_status !== 'ok'), ...ok]
  const empty = !actions.length && !dismissals.length
  return (
    <>
      <button onClick={() => setOpen(o => !o)} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, color: 'var(--text-secondary)', padding: 0, fontVariantNumeric: 'tabular-nums', ...(isMobile ? { minHeight: 40, textAlign: 'left' } : {}) }}>
        Today: {empty ? 'nothing yet' : <>{applied} applied <span style={{ color: 'var(--tone-green-tx)', fontWeight: 700 }}>✓</span>{partial ? <> · {partial} partial <span style={{ color: 'var(--tone-amber-tx)', fontWeight: 700 }}>⚠</span></> : ''}{failed ? <> · {failed} failed <span style={{ color: 'var(--tone-red-tx)', fontWeight: 700 }}>×</span></> : ''} · <span style={{ color: 'var(--tone-green-tx)', fontWeight: 700 }}>+{money(upside)}</span> expected · {dismissed.length} dismissed</>} · {open ? 'hide ▴' : 'show ▾'}
      </button>
      {open && (
        <div className="card" style={{ padding: 0, width: '100%', flexBasis: '100%' }}>
          <div style={{ maxHeight: 220, overflow: 'auto' }}>
            {!rows.length && <div style={{ ...MUTED, padding: '8px 14px' }}>No moves yet today.</div>}
            {rows.map(a => (
              <div key={a.id} className="mgrid" style={{ display: 'grid', gridTemplateColumns: '58px 1fr auto', gap: 10, padding: '7px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, alignItems: 'baseline' }}>
                <span style={{ ...MUTED, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{clock(a.created_at)}</span>
                <span>{a.summary} <span style={{ fontWeight: 700, color: a.st_status === 'ok' ? 'var(--tone-green-tx)' : a.st_status === 'partial' ? 'var(--tone-amber-tx)' : 'var(--tone-red-tx)' }}>{a.st_status === 'ok' ? '✓' : a.st_status}</span>
                  {Number(a.after?.upside) > 0 && a.st_status === 'ok' && <span style={{ color: 'var(--tone-green-tx)', fontWeight: 700 }}> +{money(a.after.upside)}</span>}
                  {a.st_error && a.st_status !== 'ok' && <div style={{ ...MUTED, fontSize: 11, color: 'var(--tone-red-tx)' }}>ST said: {a.st_error.slice(0, 160)}</div>}</span>
                <span style={{ ...MUTED, fontSize: 11 }}>{a.actor_name}</span>
              </div>
            ))}
          </div>
          {reasons.length > 0 && <div style={{ ...MUTED, padding: '7px 14px', fontSize: 11, borderTop: '1px solid var(--border)' }}>dismissed: {reasons.map(([r, n]) => `${r} ×${n}`).join(' · ')}</div>}
        </div>
      )}
    </>
  )
}

// ── Card ────────────────────────────────────────────────────────────────────
const Card = memo(function Card({ c, day, isNext, flash, pending, stError, pick, onPick, onAct, onDismiss, onOpen }) {
  // Selection is the tech id (not a row index) so a re-read can't silently
  // re-point the primary button at a different tech.
  const [dismissing, setDismissing] = useState(false)
  const isMobile = useIsMobile()
  const alts = c.alternatives || []
  const isPartial = c.kind === 'partial'
  const selId = pick ?? defaultPick(c)
  const keep = selId === 'keep'
  const alt = keep ? null : alts.find(a => a.techId === selId) || null
  const pt = isPartial ? (c.partialTechs || []).find(x => x.techId === selId) || null : null
  const rail = c.severity === 'high' ? 'var(--danger)' : c.severity === 'mid' ? 'var(--warning)' : 'var(--accent)'
  const noAlts = !isPartial && c.kind !== 'swap' && !alts.length
  const push = noAlts ? nextWindowBody(c) : null
  const canKeep = (c.kind === 'reassign' || c.kind === 'late') && c.current
  const trade = !keep && alt?.swapWith && c.current?.techId ? alt.swapWith : null
  // A busy tech with nothing to trade would simply be double-booked — that
  // move is never one click away.
  const doubles = !keep && !!alt?.busy && !trade
  const primary = pending ? 'Writing to ServiceTitan…' : isPartial ? 'Finish in ServiceTitan' : c.kind === 'swap' || trade ? 'Swap in ServiceTitan'
    : keep ? `Keep it with ${c.current?.techName}` : noAlts ? (push ? `Push to ${push.windowLabel}` : 'No later window today') : c.kind === 'place' ? 'Assign in ServiceTitan' : 'Move in ServiceTitan'
  // After ServiceTitan refused or half-finished a write, the primary stays off
  // until the board re-reads — a second click is how a call ends up on three techs.
  const disabled = pending || !!stError || doubles || (c.kind === 'swap' ? !c.steps?.length : isPartial ? !pt : keep ? false : noAlts ? !push : !alt)
  const snoozeMin = c.kind === 'late' ? 15 : 60
  const run = async () => {
    if (pending) return
    // "Keep it" on a running-late card is a 30-minute snooze, not a dismissal:
    // if the tech is still stuck later, the card has to come back.
    if (keep) return c.kind === 'late' ? onDismiss(c.key, 'snooze', 'keep as booked', 30) : onDismiss(c.key, 'dismiss', 'keep as booked')
    if (c.kind === 'swap') {
      const steps = c.steps || []
      for (let i = 0; i < steps.length; i++) {
        // The card stays until the last step lands, so a step-2 failure has a
        // card to show its "ST said" row on.
        const r = await onAct({ ...steps[i] }, c.key, { ...metaOf(c, null), upside: i === 0 ? c.upside : 0, day, keepCard: i < steps.length - 1 })
        if (!r || r.status !== 'ok') break
      }
      return
    }
    const pb = primaryBody(c, selId)
    if (!pb) return
    if (pb.steps) {
      for (let i = 0; i < pb.steps.length; i++) {
        const r = await onAct(pb.steps[i], c.key, { ...pb.meta, upside: i === 0 ? c.upside : 0, day, keepCard: i < pb.steps.length - 1, ...(pb.stepMeta?.[i] || {}) })
        if (!r || r.status !== 'ok') break
      }
      return
    }
    return onAct(pb.body, c.key, { ...pb.meta, day })
  }
  const radio = (on) => <span style={{ width: 13, height: 13, borderRadius: '50%', flexShrink: 0, border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`, background: on ? 'radial-gradient(circle, var(--accent) 45%, transparent 50%)' : 'transparent' }} />
  // The severity rail is a grid column; "mgrid" keeps it one on a phone, where
  // the phone layer would otherwise stack it into an invisible zero-height row.
  return (
    <div id={isNext ? 'cc-next-card' : undefined} className="card mgrid" style={{ display: 'grid', gridTemplateColumns: '4px 1fr', overflow: 'hidden', outline: isNext ? '2px solid var(--accent)' : 'none', outlineOffset: -1,
      boxShadow: flash ? '0 0 0 6px var(--accent-bg)' : 'none', transition: 'box-shadow .3s', ...(isMobile ? { padding: 0 } : {}) }}>
      <div style={{ background: rail }} />
      <div style={{ padding: '11px 14px', display: 'grid', gap: 8, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)' }}>
          <Kind kind={c.kind} />
          {c.actBy && <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>act by {hr(c.actBy)}</span>}
          {c.kind === 'place' && c.isNew && <span style={{ fontWeight: 800, color: 'var(--tone-blue-tx)', background: 'var(--tone-blue-bg)', border: '1px solid var(--tone-blue-bd)', borderRadius: 99, padding: '1px 7px', fontSize: 10 }}>new · booked {clock(c.createdOn)}</span>}
          {c.jobType && <span>{c.jobType} · {windowLabel(c)}{c.zip ? ` · ${c.zip}` : ''}</span>}
          {c.current && <span>· {c.current.techName} <TierDot tier={c.current.tier} /> {c.current.status === 'Working' ? 'on site' : c.current.status === 'Dispatched' ? 'rolling' : c.current.status?.toLowerCase()}</span>}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            {isPartial && c.jobId && <a href={ST_JOB_URL(c.jobId)} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>Open in ServiceTitan ↗</a>}
            {c.jobId && <a href="#" onClick={e => { e.preventDefault(); onOpen(callOfCard(c), c.kind === 'late' ? { prefill: { tech: c.current?.techName || 'your technician' } } : undefined) }} style={{ fontSize: 11 }}>open call</a>}
          </span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.3 }}>
          {c.title}{c.upside > 0 && <span style={{ color: 'var(--tone-green-tx)', fontWeight: 800 }}> — +{money(c.upside)} expected</span>}
        </div>
        {c.why && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{c.why}</div>}

        {isPartial && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <div style={{ padding: '4px 10px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .5, color: 'var(--text-muted)', background: 'var(--surface-2)' }}>Remove from</div>
            {(c.partialTechs || []).map((t, i) => (
              <div key={t.techId} onClick={() => onPick(c.key, t.techId)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 12, cursor: 'pointer', borderTop: i ? '1px solid var(--border)' : 'none', background: t.techId === selId ? 'var(--accent-bg)' : 'transparent', ...(isMobile ? { minHeight: 40 } : {}) }}>
                {radio(t.techId === selId)}<TierDot tier={t.tier} /><span style={{ fontWeight: 600 }}>{t.techName}</span>{t.recommended && <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--tone-green-tx)' }}>PICK</span>}
              </div>
            ))}
          </div>
        )}

        {alts.length > 0 && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            {/* Six columns on a desk. On a phone a row is radio · tech · $/opp, with
                load, drive and close rate folded into a second line under the name. */}
            <div className="mgrid" style={{ display: 'grid', gridTemplateColumns: isMobile ? '18px 1fr auto' : '18px 1fr 110px 90px 70px 90px', gap: 8, padding: '4px 10px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .5, color: 'var(--text-muted)', background: 'var(--surface-2)' }}>
              <span /><span>Technician</span>{!isMobile && <><span>Load today</span><span>Drive</span><span title="estimate close rate — not the TV $90 rule">Close</span></>}<span style={{ textAlign: 'right' }}>$/opp</span>
            </div>
            {alts.map((a, i) => {
              const on = !keep && a.techId === selId
              const loadColor = a.swapWith ? 'var(--tone-green-tx)' : a.busy ? 'var(--tone-amber-tx)' : 'var(--text-secondary)'
              const loadText = a.swapWith ? `swap · takes #${a.swapWith.jobNumber}` : a.busy ? 'has a call this window' : a.load != null ? `${a.load} of ${a.target} calls` : ''
              const driveText = a.travel?.minutes != null ? `${a.travel.minutes} min` : a.travel?.miles != null ? `~${a.travel.miles} mi` : ''
              const closeText = a.closeRate != null ? `${a.closeRate}%` : ''
              const name = <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}><TierDot tier={a.tier} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.techName}</span>{a.recommended && <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--tone-green-tx)' }}>PICK</span>}</span>
              const dollars = <span style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: a.deltaRaw > 0 ? 'var(--tone-green-tx)' : 'var(--text-muted)' }}>{a.deltaRaw > 0 ? `+${money(a.deltaRaw)}` : money(a.expectedValue)}<span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>/opp</span></span>
              if (isMobile) return (
                <div key={a.techId} className="mgrid" onClick={() => onPick(c.key, a.techId)} style={{ display: 'grid', gridTemplateColumns: '18px 1fr auto', gap: 8, alignItems: 'center', padding: '8px 10px', minHeight: 44, fontSize: 12, cursor: 'pointer',
                  borderTop: i ? '1px solid var(--border)' : 'none', background: on ? 'var(--accent-bg)' : 'transparent', opacity: a.busy ? .6 : 1 }}>
                  {radio(on)}
                  <span style={{ minWidth: 0 }}>
                    {name}
                    {(loadText || driveText || closeText) ? <span style={{ display: 'block', fontSize: 11, color: loadColor, fontVariantNumeric: 'tabular-nums' }}>{[loadText, driveText && `${driveText} drive`, closeText && `${closeText} close`].filter(Boolean).join(' · ')}</span> : null}
                  </span>
                  {dollars}
                </div>
              )
              return (
                <div key={a.techId} onClick={() => onPick(c.key, a.techId)} style={{ display: 'grid', gridTemplateColumns: '18px 1fr 110px 90px 70px 90px', gap: 8, alignItems: 'center', padding: '6px 10px', fontSize: 12, cursor: 'pointer',
                  borderTop: i ? '1px solid var(--border)' : 'none', background: on ? 'var(--accent-bg)' : 'transparent', opacity: a.busy ? .6 : 1 }}>
                  {radio(on)}
                  {name}
                  <span style={{ color: loadColor }}>{loadText}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{driveText}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{closeText}</span>
                  {dollars}
                </div>
              )
            })}
            {canKeep && (
              <div onClick={() => onPick(c.key, 'keep')} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 12, cursor: 'pointer', borderTop: '1px solid var(--border)', background: keep ? 'var(--accent-bg)' : 'transparent', color: 'var(--text-secondary)', ...(isMobile ? { minHeight: 40 } : {}) }}>
                {radio(keep)}Keep it with {c.current.techName}
              </div>
            )}
            {trade && <div style={{ fontSize: 11, padding: '4px 10px 6px', borderTop: '1px solid var(--border)', color: 'var(--tone-green-tx)' }}>Trade: {c.current.techName} takes #{trade.jobNumber} ({trade.jobType} · {windowLabel(trade)}){trade.sameWindow ? ' — same window, both customers keep their times.' : ' — appointments stay put, both customers keep their times.'}</div>}
            {!trade && alt?.busy && <div style={{ ...MUTED, fontSize: 11, padding: '4px 10px 6px', borderTop: '1px solid var(--border)' }}>{alt.techName} already has a call in this window and nothing {c.current?.techName || 'the current tech'} can take in return — this would double them up.</div>}
            {!trade && !alt?.busy && alt?.bump && <div style={{ ...MUTED, fontSize: 11, padding: '4px 10px 6px', borderTop: '1px solid var(--border)' }}>{alt.techName} is at capacity — this bumps #{alt.bump.jobNumber} ({alt.bump.jobType}); move that one from the drawer after.</div>}
            {c.rejected?.length > 0 && <div style={{ ...MUTED, fontSize: 11, padding: '4px 10px 6px', borderTop: '1px solid var(--border)' }}>Not offered: {c.rejected.slice(0, 4).map(r => `${r.techName} (${r.reason})`).join(' · ')}{c.rejected.length > 4 ? ` · +${c.rejected.length - 4}` : ''}</div>}
          </div>
        )}
        {noAlts && (
          <div style={{ fontSize: 12, color: 'var(--tone-amber-tx)' }}>Nobody free in this window.{push ? '' : ' No later window today — move it from the drawer.'}
            {c.rejected?.length > 0 && <span style={{ ...MUTED, fontSize: 11 }}> Not offered: {c.rejected.slice(0, 4).map(r => `${r.techName} (${r.reason})`).join(' · ')}{c.rejected.length > 4 ? ` · +${c.rejected.length - 4}` : ''}</span>}
          </div>
        )}
        {c.kind === 'swap' && c.steps && <div style={{ ...MUTED, fontSize: 11 }}>Two moves, in order: {c.steps.map(s => `#${s.jobNumber} → ${s.toTechnicianName}`).join(', then ')}{c.travel?.minutes != null ? ` · ${c.travel.minutes} min between the two sites` : ''} · stops if the first one doesn’t take</div>}
        {stError && <div style={{ fontSize: 12, color: 'var(--tone-red-tx)', background: 'var(--tone-red-bg)', border: '1px solid var(--tone-red-bd)', borderRadius: 'var(--radius)', padding: '5px 10px' }}><b>ST said:</b> {stError}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Btn primary disabled={disabled} onClick={run} style={isMobile ? { width: '100%', justifyContent: 'center', whiteSpace: 'normal' } : undefined}>{pending && <Spin size={10} light />}{primary}</Btn>
          {!dismissing ? (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <Btn small onClick={() => onDismiss(c.key, 'snooze', null, snoozeMin)} style={{ border: 'none', background: 'transparent', color: 'var(--text-secondary)' }}>Snooze {snoozeMin === 60 ? '1h' : `${snoozeMin}m`}</Btn>
              <Btn small onClick={() => setDismissing(true)} style={{ border: 'none', background: 'transparent', color: 'var(--text-secondary)' }}>Not this one</Btn>
            </span>
          ) : (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>why?
              {DISMISS_REASONS.map(r => <Btn key={r} small onClick={() => onDismiss(c.key, 'dismiss', r)}>{r}</Btn>)}
              <Btn small onClick={() => setDismissing(false)} style={{ border: 'none', background: 'transparent' }}>cancel</Btn>
            </span>
          )}
        </div>
      </div>
    </div>
  )
})

// ── Board lanes ─────────────────────────────────────────────────────────────
// 7 AM–8 PM Denver-local track — the dispatch day's real span.
function buildLanes(board) {
  const calls = board.calls || [], techs = board.techsToday || []
  const dayStart = new Date(board.dayStart)
  const t0 = new Date(dayStart); t0.setHours(7, 0, 0, 0); const t1 = new Date(dayStart); t1.setHours(20, 0, 0, 0)
  const span = t1 - t0
  const pos = (iso) => Math.max(0, Math.min(1, (new Date(iso) - t0) / span))
  const nowPos = board.day === 0 ? pos(board.now) : null
  const lane = (t) => {
    const mine = calls.filter(c => c.techId === t.techId).sort((a, b) => new Date(a.windowStart) - new Date(b.windowStart))
    const rowsEnd = []; const rowOf = new Map()
    for (const c of mine) { let r = rowsEnd.findIndex(e => e <= new Date(c.windowStart).getTime()); if (r < 0) { r = rowsEnd.length; rowsEnd.push(0) } rowsEnd[r] = new Date(c.windowEnd).getTime(); rowOf.set(c.appointmentId + '|' + c.techId, r) }
    const label = t.out ? 'OUT' : t.onShift ? (t.allDayInstall ? 'all-day install' : 'open') : !t.hasWorkingShift ? 'off today' : mine.length ? 'done' : 'shift over'
    return { t, mine, rowOf, rows: Math.max(1, rowsEnd.length), shifts: (t.shifts || []).filter(s => s.type !== 'TimeOff'), opp: mine.filter(c => c.opportunity >= 3).length, label }
  }
  const visible = (t) => t.onShift || t.out || calls.some(c => c.techId === t.techId)
  const byEV = (a, b) => (b.expectedValue || 0) - (a.expectedValue || 0)
  const groups = ORDER.map(tr => ({ tr, label: tr === 'Garage Door' ? 'Garage Doors' : tr, techs: techs.filter(t => t.rankable !== false && (t.trade || 'Other') === tr && visible(t)).sort(byEV).map(lane) }))
  groups.push({ tr: 'Installers', label: 'Installers', techs: techs.filter(t => t.rankable === false && visible(t)).sort(byEV).map(lane) })
  return { pos, nowPos, groups: groups.filter(g => g.techs.length).map(g => ({ ...g, calls: g.techs.reduce((s, l) => s + l.mine.length, 0) })) }
}
const Board = memo(function Board({ board, onOpen, onUnhold, pendingKeys }) {
  const { pos, nowPos, groups } = useMemo(() => buildLanes(board), [board])
  const kindOf = (c) => c.status === 'Hold' ? 'hold' : /install|replacement/i.test(c.jobType) ? 'ins' : c.opportunity >= 3 ? 'hi' : /repair|service|warranty|callback|concern/i.test(c.jobType) ? 'rep' : 'rt'
  const tone = { hi: 'green', rep: 'amber', ins: 'blue', rt: 'gray' }
  const onHold = board.onHold || [], tray = board.unassigned || []
  const isMobile = useIsMobile()
  const COLS = isMobile ? '96px 1fr' : '150px 1fr'   // the name column gives the lane its room on a phone
  return (
    <div className="card" style={{ padding: 0, position: 'sticky', top: 0 }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, ...(isMobile ? { flexWrap: 'wrap' } : {}) }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>The board</span><span style={MUTED}>click any call · $ = opportunity, ring = seat tier</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, fontSize: 10, color: 'var(--text-muted)' }}>
          {[['green', 'opportunity'], ['amber', 'repair'], ['blue', 'install'], ['gray', 'routine']].map(([t, l]) => <span key={t}><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, marginRight: 4, verticalAlign: -1, background: `var(--tone-${t}-bg)`, border: `1px solid var(--tone-${t}-bd)` }} />{l}</span>)}
        </span>
      </div>
      <div className="mgrid" style={{ display: 'grid', gridTemplateColumns: COLS, padding: '5px 14px 3px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
        <span /><div style={{ position: 'relative', height: 13 }}>
          {(isMobile ? [8, 12, 16, 20] : [8, 10, 12, 14, 16, 18, 20]).map(h => <span key={h} style={{ position: 'absolute', left: `${((h - 7) / 13) * 100}%`, transform: 'translateX(-50%)', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)' }}>{h === 12 ? '12PM' : h > 12 ? `${h - 12}PM` : `${h}AM`}</span>)}
        </div>
      </div>
      <div style={{ overflow: 'auto', maxHeight: isMobile ? '70vh' : 'calc(100vh - 330px)' }}>
        {groups.map(g => (
          <div key={g.tr}>
            <div style={{ ...EYEBROW, padding: '8px 14px 2px', display: 'flex', gap: 8 }}>{g.label}<span style={{ ...MUTED, fontSize: 11, textTransform: 'none', letterSpacing: 0 }}>{g.calls} calls</span></div>
            {g.techs.map(({ t, mine, rowOf, rows, shifts, opp, label }) => (
              <div key={t.techId} className="mgrid" style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', padding: '3px 14px', minHeight: 32, opacity: t.onShift || t.out ? 1 : .55 }}>
                <div title={`${TIER[t.tier]?.label || ''} · ${t.status}`} style={{ minWidth: 0, paddingRight: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    <TierDot tier={t.tier} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                    {t.out && <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: .5, padding: '0 5px', borderRadius: 4, color: 'var(--tone-red-tx)', border: '1px solid var(--tone-red-bd)', background: 'repeating-linear-gradient(45deg, var(--tone-red-bg) 0 3px, var(--surface) 3px 6px)' }}>OUT</span>}
                    {!t.out && label === 'done' && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)' }}>done</span>}
                  </div>
                  {t.rankable !== false && t.expectedValue != null && <div style={{ fontSize: 10, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{money(t.expectedValue)}/opp · {opp} opp</div>}
                </div>
                <div style={{ position: 'relative', height: rows * 26, borderRadius: 4, background: 'repeating-linear-gradient(to right, transparent 0 calc(100%/13 - 1px), var(--border) calc(100%/13 - 1px) calc(100%/13))' }}>
                  {shifts.map((s, i) => <div key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: `${pos(s.start) * 100}%`, width: `${(pos(s.end) - pos(s.start)) * 100}%`, background: 'var(--accent-bg)', opacity: .35, borderRadius: 4 }} />)}
                  {nowPos != null && nowPos > 0 && nowPos < 1 && <div style={{ position: 'absolute', top: -1, bottom: -1, left: `${nowPos * 100}%`, width: 2, background: 'var(--danger)', opacity: .7, zIndex: 1 }} />}
                  {!mine.length && (t.out
                    ? <span style={{ position: 'absolute', left: 8, top: 4, fontSize: 9, fontWeight: 800, letterSpacing: .5, padding: '0 5px', borderRadius: 4, color: 'var(--tone-red-tx)', border: '1px solid var(--tone-red-bd)', background: 'repeating-linear-gradient(45deg, var(--tone-red-bg) 0 3px, var(--surface) 3px 6px)' }}>OUT</span>
                    : <span style={{ position: 'absolute', left: 8, top: 5, fontSize: 10, color: 'var(--text-muted)' }}>{label}</span>)}
                  {mine.map(c => {
                    const k = kindOf(c); const tn = tone[k] || 'gray'
                    const glyph = c.status === 'Done' ? '✓' : c.status === 'Working' ? '●' : c.status === 'Dispatched' ? '→' : ''
                    const ring = c.opportunity >= 3 && c.status !== 'Done' ? { boxShadow: `0 0 0 2px ${c.techTier === 'green' ? 'var(--success)' : 'var(--danger)'}` } : {}
                    return (
                      <div key={c.appointmentId + '|' + c.techId} onClick={() => onOpen(c)} title={`#${c.jobNumber} · ${c.jobType} · ${windowLabel(c)} · ${c.status}${c.opportunityReasons?.length ? '\n' + c.opportunityReasons.join(' · ') : ''}`}
                        style={{ position: 'absolute', top: 2 + (rowOf.get(c.appointmentId + '|' + c.techId) || 0) * 26, height: 22, left: `${pos(c.windowStart) * 100}%`, width: `calc(${(pos(c.windowEnd) - pos(c.windowStart)) * 100}% - 3px)`, borderRadius: 5, cursor: 'pointer',
                          fontSize: 10, fontWeight: 700, padding: '0 6px', display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', whiteSpace: 'nowrap',
                          ...(k === 'hold' ? { background: 'repeating-linear-gradient(45deg, var(--surface-2) 0 4px, var(--surface) 4px 8px)', border: '1px dashed var(--border-strong)', color: 'var(--text-muted)' }
                            : { background: `var(--tone-${tn}-bg)`, border: `1px solid var(--tone-${tn}-bd)`, color: `var(--tone-${tn}-tx)` }),
                          ...ring, opacity: c.status === 'Done' ? .6 : 1 }}>
                        {glyph && <span style={{ fontSize: 9 }}>{glyph}</span>}{c.opportunity >= 3 && <span style={{ fontSize: 9, fontWeight: 900 }}>$</span>}<span>#{c.jobNumber}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ padding: '8px 14px 10px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11 }}>
        <span style={{ ...EYEBROW, color: 'var(--tone-amber-tx)' }}>Unassigned tray</span>
        {tray.length ? tray.map(u => <span key={u.appointmentId} onClick={() => onOpen({ ...u, techId: null, techName: null, status: u.status || 'Scheduled' })} style={{ cursor: 'pointer', border: '1px solid var(--tone-amber-bd)', background: 'var(--tone-amber-bg)', color: 'var(--tone-amber-tx)', borderRadius: 99, padding: '2px 8px', fontWeight: 700, ...(isMobile ? { display: 'inline-flex', alignItems: 'center', minHeight: 40, padding: '4px 12px' } : {}) }}>#{u.jobNumber} · {(u.jobType || '').replace(/^\w[\w ]*? - /, '')} · {windowLabel(u)}</span>) : <span style={MUTED}>empty</span>}
        {onHold.length > 0 && <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text-muted)' }}>On hold: {onHold.map(h => {
          const busy = pendingKeys.has(`unhold:${h.appointmentId}`)
          return <span key={h.jobId}>#{h.jobNumber} <button disabled={busy} onClick={() => onUnhold(h)} style={{ border: 'none', background: 'transparent', color: 'var(--accent)', cursor: busy ? 'default' : 'pointer', fontSize: 11, fontWeight: 600, padding: 0, opacity: busy ? .5 : 1, ...(isMobile ? { minHeight: 40, padding: '0 6px' } : {}) }}>{busy ? 'releasing…' : 'release'}</button></span>
        })}</span>}
      </div>
    </div>
  )
})

// ── Drawer ──────────────────────────────────────────────────────────────────
const Skel = ({ w = '100%' }) => <div style={{ height: 12, width: w, borderRadius: 4, background: 'var(--surface-2)', marginTop: 6 }} />
function Drawer({ call: d, board, holdReasons, profile, phone, onClose, onAct, toast, detailMemo, prefill }) {
  // Job detail is remembered per job for a minute (same as the server): the
  // remembered copy paints instantly, and anything older re-reads behind it.
  const memoHit = detailMemo.current.get(d.jobId)
  const [detail, setDetail] = useState(() => memoHit?.data || null)
  const [err, setErr] = useState('')
  const techs = board.techsToday || []
  const [techId, setTechId] = useState(d.techId ? String(d.techId) : '')
  const ownDate = localDate(d.windowStart) || board.date
  const [dateStr, setDateStr] = useState(ownDate)
  const [win, setWin] = useState(() => { const h = d.windowStart ? new Date(d.windowStart).getHours() : 8; const w = WINDOWS.find(([s]) => s === h); return w ? `${w[0]}-${w[1]}` : '' })
  const [note, setNote] = useState('')
  const [holdReason, setHoldReason] = useState(''); const [holdMemo, setHoldMemo] = useState('')
  const [jobTypeId, setJobTypeId] = useState(() => String(memoHit?.data?.job?.jobTypeId || ''))
  const [priority, setPriority] = useState(() => memoHit?.data?.job?.priority || '')
  const [smsBody, setSmsBody] = useState('')
  const [busy, setBusy] = useState(false)
  const isMobile = useIsMobile()
  const fetchDetail = useCallback(async (force = false) => {
    const had = detailMemo.current.get(d.jobId)
    if (had && !force) { setDetail(had.data); setJobTypeId(String(had.data.job.jobTypeId || '')); setPriority(had.data.job.priority || '') }
    if (had && !force && Date.now() - had.at < 60_000) return had.data
    try {
      const x = await authed(`/api/dispatch/job/${d.jobId}${force ? '?force=1' : ''}`)
      if (detailMemo.current.size > 200) detailMemo.current.clear()
      detailMemo.current.set(d.jobId, { at: Date.now(), data: x })
      setDetail(x); setJobTypeId(String(x.job.jobTypeId || '')); setPriority(x.job.priority || ''); setErr('')
      return x
    } catch (e) { if (!had) setErr(e.message); return had?.data || null }
  }, [d.jobId, detailMemo])
  useEffect(() => { fetchDetail() }, [fetchDetail])
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose() }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [onClose])
  // Running-late text: drafted for the dispatcher to edit — never sent on its own.
  useEffect(() => {
    if (!prefill || !detail?.customer || smsBody) return
    const first = String(detail.customer.name || '').split(/[,\s]+/).filter(Boolean)[0] || 'there'
    setSmsBody(`Hi ${first}, this is Awesome Home Services — ${prefill.tech} is running behind on the job before yours. We’ll text as soon as they’re on the way.`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, detail])

  // Trade comes from the ORIGINAL tech (or the tray row for unassigned jobs),
  // never from the dropdown selection — otherwise picking "Unassigned"
  // collapsed the list and tray jobs offered every trade.
  const trade = useMemo(() => {
    if (d.trade) return d.trade
    const orig = techs.find(t => t.techId === d.techId)
    if (orig?.trade) return orig.trade
    return (board.unassigned || []).find(u => u.jobId === d.jobId)?.trade || null
  }, [techs, board.unassigned, d.techId, d.jobId, d.trade])
  const ranked = useMemo(() => {
    const list = techs.filter(t => t.onShift && t.rankable && !t.out && (!trade || t.trade === trade)).sort((a, b) => (b.expectedValue || 0) - (a.expectedValue || 0))
    if (d.techId && !list.some(t => t.techId === d.techId)) { const o = techs.find(t => t.techId === d.techId); list.unshift({ techId: d.techId, name: d.techName || o?.name || `Tech ${d.techId}`, tier: o?.tier || 'unranked', expectedValue: o?.expectedValue ?? null }) }
    return list
  }, [techs, trade, d.techId, d.techName])
  const jn = d.jobNumber || detail?.job?.jobNumber || ''
  const run = async (fn) => { setBusy(true); try { await fn() } finally { setBusy(false) } }

  const saveAssign = () => run(async () => {
    if (!d.appointmentId) { toast('This job has no appointment to assign', 'err'); return }
    const to = techs.find(t => String(t.techId) === techId)
    if (!techId && d.techId) { const r = await onAct({ kind: 'unassign', appointmentId: d.appointmentId, jobId: d.jobId, jobNumber: jn, technicianId: d.techId, technicianName: d.techName }); if (r && r.status !== 'failed') onClose(); return }
    if (!to || to.techId === d.techId) { toast('Nothing changed'); return }
    const r = d.techId
      ? await onAct({ kind: 'reassign', appointmentId: d.appointmentId, jobId: d.jobId, jobNumber: jn, fromTechnicianId: d.techId, fromTechnicianName: d.techName, toTechnicianId: to.techId, toTechnicianName: to.name })
      : await onAct({ kind: 'assign', appointmentId: d.appointmentId, jobId: d.jobId, jobNumber: jn, technicianId: to.techId, technicianName: to.name })
    if (r && r.status !== 'failed') onClose()   // the drawer's snapshot is stale after a write
  })
  const saveWindow = () => run(async () => {
    if (!d.appointmentId || !win) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { toast('Pick a date', 'warn'); return }
    const [s, e] = win.split('-').map(Number)
    const curH = d.windowStart ? new Date(d.windowStart).getHours() : null
    if (dateStr === ownDate && curH === s) { toast('Nothing changed'); return }
    const mk = (h) => { const x = new Date(`${dateStr}T00:00:00`); x.setHours(h, 0, 0, 0); return x.toISOString() }
    const label = `${dateStr === ownDate ? '' : dateStr + ' '}${winName(s, e)}`
    const r = await onAct({ kind: 'reschedule', appointmentId: d.appointmentId, jobId: d.jobId, jobNumber: jn, start: mk(s), end: mk(e), arrivalWindowStart: mk(s), arrivalWindowEnd: mk(e), windowLabel: label, fromWindowLabel: windowLabel(d) })
    if (r && r.status !== 'failed') onClose()
  })
  const saveHold = () => run(async () => {
    if (!d.appointmentId) return
    let r
    if (d.status === 'Hold') r = await onAct({ kind: 'unhold', appointmentId: d.appointmentId, jobId: d.jobId, jobNumber: jn })
    else {
      if (!holdReason) { toast('Pick a hold reason', 'warn'); return }
      const hr2 = holdReasons.find(x => String(x.id) === holdReason)
      r = await onAct({ kind: 'hold', appointmentId: d.appointmentId, jobId: d.jobId, jobNumber: jn, reasonId: hr2.id, reasonName: hr2.name, memo: holdMemo })
    }
    if (r && r.status !== 'failed') onClose()
  })
  const saveNote = () => { if (busy || !note.trim()) return; run(async () => { const r = await onAct({ kind: 'note', jobId: d.jobId, jobNumber: jn, text: note.trim() }); if (r) setNote('') }) }
  // One act per changed field, in order, then re-read the job.
  const saveType = () => run(async () => {
    if (!detail) return
    const typeChanged = jobTypeId && Number(jobTypeId) !== detail.job.jobTypeId
    const prioChanged = priority && priority !== detail.job.priority
    if (!typeChanged && !prioChanged) { toast('Nothing changed'); return }
    if (typeChanged) { const r = await onAct({ kind: 'retype', jobId: d.jobId, jobNumber: jn, jobTypeId: Number(jobTypeId), jobTypeName: (detail.jobTypes || []).find(t => t.id === Number(jobTypeId))?.name }); if (!r || r.status !== 'ok') return }
    if (prioChanged) { const r = await onAct({ kind: 'priority', jobId: d.jobId, jobNumber: jn, priority }); if (!r || r.status !== 'ok') return }
    await fetchDetail(true)
  })
  const sendSms = () => run(async () => {
    const to = detail?.customer?.phone; if (!to || !smsBody.trim()) return
    try {
      await authed('/api/twilio/sms', { method: 'POST', body: JSON.stringify({ to, body: smsBody.trim(), repName: profile?.name || profile?.email || 'dispatch', contactId: null }) })
      await onAct({ kind: 'log', jobId: d.jobId, jobNumber: jn, summary: `Texted ${detail.customer.name || 'the customer'} on #${jn}: “${smsBody.trim().slice(0, 80)}”` })
      setSmsBody('')
    } catch (e) { toast(e.message, 'err') }
  })
  const call = () => {
    const to = detail?.customer?.phone; if (!to) return
    const ready = !!phone?.makeCall && phone.twilioReady === true
    if (!ready) { toast('The Andi phone isn’t ready on this screen — call from the dialer', 'warn'); return }
    phone.makeCall(to, { contactName: detail.customer.name })
    onAct({ kind: 'log', jobId: d.jobId, jobNumber: jn, summary: `Placed a call to ${detail.customer.name || 'the customer'} on #${jn} from Andi` })
  }

  const sel = { width: '100%', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius)', padding: '7px 10px', fontSize: 13, background: 'var(--surface)', color: 'var(--text-primary)', fontFamily: 'inherit' }
  const sec = { ...EYEBROW, marginBottom: 6 }
  // Phone: each field row stacks and its button runs the full width.
  const row = { display: 'flex', gap: 8, ...(isMobile ? { flexDirection: 'column' } : {}) }
  const full = isMobile ? { width: '100%', justifyContent: 'center' } : undefined
  const jobType = detail?.job?.jobType || d.jobType || ''
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 500 }} />
      <aside style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(460px, 100vw)', background: 'var(--surface)', borderLeft: '1px solid var(--border)', boxShadow: '0 10px 30px rgba(0,0,0,.25)', zIndex: 501, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={EYEBROW}>{d.status === 'Hold' ? 'On hold' : d.status || 'Scheduled'} · {windowLabel(d)}{(detail?.location?.zip || d.zip) ? ` · ${detail?.location?.zip || d.zip}` : ''}</div>
            <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.25, marginTop: 2 }}>{jn ? `#${jn}` : '…'} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{jobType}</span></div>
          </div>
          <Btn small onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'transparent' }}>Close</Btn>
        </div>
        <div style={{ padding: '14px 18px', overflow: 'auto', display: 'grid', gap: 14, flex: 1 }}>
          {err && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
          <div>
            <div style={sec}>Customer</div>
            {detail ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{detail.customer?.name || '—'}{detail.customer?.doNotService && <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--tone-red-tx)', fontWeight: 800 }}>DO NOT SERVICE</span>}</div>
                <div style={{ ...MUTED, marginTop: 2 }}>{[detail.location?.street, detail.location?.city].filter(Boolean).join(', ')}{detail.customer?.phone ? ` · ${detail.customer.phone}` : ''}</div>
              </>
            ) : <><Skel w="55%" /><Skel w="80%" /></>}
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <Btn small disabled={!detail?.customer?.phone} onClick={call}>Call</Btn>
              <a className="btn sm" href={ST_JOB_URL(d.jobId)} target="_blank" rel="noreferrer" style={{ fontSize: 11, padding: '4px 10px', ...(isMobile ? { minHeight: 40 } : {}) }}>Open in ServiceTitan ↗</a>
            </div>
          </div>
          <div>
            <div style={sec}>Assigned tech</div>
            <div style={row}>
              <select style={sel} value={techId} onChange={e => setTechId(e.target.value)}>
                <option value="">— Unassigned —</option>
                {ranked.map(t => <option key={t.techId} value={String(t.techId)}>{t.name}{t.techId === d.techId ? ' (current)' : ''} — {TIER[t.tier]?.label || t.tier}{t.expectedValue != null ? ` · ${money(t.expectedValue)}/opp` : ''}{t.allDayInstall ? ' · all-day install' : ''}</option>)}
              </select>
              <Btn primary disabled={busy || !d.appointmentId} onClick={saveAssign} style={full}>Save</Btn>
            </div>
            {!d.appointmentId && <div style={{ ...MUTED, fontSize: 11, marginTop: 4 }}>No appointment on this job to assign.</div>}
          </div>
          <div>
            <div style={sec}>Arrival window</div>
            <div style={row}>
              <input type="date" style={{ ...sel, width: isMobile ? '100%' : 150 }} value={dateStr} onChange={e => setDateStr(e.target.value)} />
              <select style={sel} value={win} onChange={e => setWin(e.target.value)}>
                <option value="">— pick —</option>
                {WINDOWS.map(([s, e]) => <option key={s} value={`${s}-${e}`}>{s > 12 ? s - 12 : s} {s >= 12 ? 'PM' : 'AM'} – {e > 12 ? e - 12 : e} {e >= 12 ? 'PM' : 'AM'}</option>)}
              </select>
              <Btn primary disabled={busy || !win || !d.appointmentId} onClick={saveWindow} style={full}>Move</Btn>
            </div>
          </div>
          <div>
            <div style={sec}>Job type · priority</div>
            <div style={row}>
              <select style={sel} value={jobTypeId} disabled={!detail} onChange={e => setJobTypeId(e.target.value)}>
                {detail ? (detail.jobTypes || []).map(t => <option key={t.id} value={String(t.id)}>{t.name}</option>) : <option value="">{jobType || 'loading…'}</option>}
              </select>
              <select style={{ ...sel, width: isMobile ? '100%' : 120 }} value={priority} disabled={!detail} onChange={e => setPriority(e.target.value)}>{['', 'Low', 'Normal', 'High', 'Urgent'].map(p => <option key={p} value={p}>{p || '—'}</option>)}</select>
              <Btn primary disabled={busy || !detail} onClick={saveType} style={full}>Fix</Btn>
            </div>
          </div>
          <div>
            <div style={sec}>{d.status === 'Hold' ? 'Release hold' : 'Put on hold'}</div>
            {d.status !== 'Hold' && (
              <div style={{ display: 'grid', gap: 6 }}>
                <select style={sel} value={holdReason} onChange={e => setHoldReason(e.target.value)}><option value="">— reason (required by ServiceTitan) —</option>{holdReasons.map(r => <option key={r.id} value={String(r.id)}>{r.name}</option>)}</select>
                <input style={sel} placeholder="memo (optional)" value={holdMemo} onChange={e => setHoldMemo(e.target.value)} />
              </div>
            )}
            <div style={{ marginTop: 6 }}><Btn disabled={busy || !d.appointmentId || (d.status !== 'Hold' && !holdReason)} onClick={saveHold} style={full}>{d.status === 'Hold' ? 'Take off hold' : 'Hold this appointment'}</Btn></div>
          </div>
          <div>
            <div style={sec}>Notes on the job</div>
            {detail ? (
              <>
                {detail.job.summary && <div style={{ borderLeft: '2px solid var(--border-strong)', padding: '2px 10px', fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{detail.job.summary}<span style={{ display: 'block', fontStyle: 'normal', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>booking summary</span></div>}
                {(detail.notes || []).slice(0, 5).map((n, i) => <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{n.isPinned ? '📌 ' : ''}{n.text}<span style={{ ...MUTED, fontSize: 10 }}> · {n.createdOn ? new Date(n.createdOn).toLocaleDateString() : ''}</span></div>)}
              </>
            ) : <><Skel /><Skel w="70%" /></>}
            <div style={{ ...row, marginTop: 6 }}>
              <input style={sel} placeholder="Pin a note to the job" value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveNote() }} />
              <Btn disabled={busy || !note.trim()} onClick={saveNote} style={full}>Pin</Btn>
            </div>
          </div>
          {(!detail || detail.estimates?.length > 0) && (
            <div>
              <div style={sec}>Estimates</div>
              {detail ? detail.estimates.map(e => <div key={e.id} style={{ fontSize: 12, display: 'flex', gap: 8 }}><span style={{ fontWeight: 700, color: e.status === 'Sold' ? 'var(--tone-green-tx)' : 'var(--text-muted)', minWidth: 46 }}>{e.status}</span><span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(e.subtotal)}</span></div>)
                : <Skel w="60%" />}
            </div>
          )}
          <div>
            <div style={sec}>Text the customer</div>
            <div style={row}>
              <input style={sel} placeholder={!detail ? 'loading the customer…' : detail.customer?.phone ? `Text ${detail.customer.name || 'the customer'}…` : 'No phone on file'} disabled={!detail?.customer?.phone} value={smsBody} onChange={e => setSmsBody(e.target.value)} />
              <Btn disabled={busy || !detail?.customer?.phone || !smsBody.trim()} onClick={sendSms} style={full}>Send</Btn>
            </div>
            <div style={{ ...MUTED, fontSize: 11, marginTop: 4 }}>You write it; nothing is sent automatically. Logged in Today’s moves.</div>
          </div>
        </div>
      </aside>
    </>
  )
}
