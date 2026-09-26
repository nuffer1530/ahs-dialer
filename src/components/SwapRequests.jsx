import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { useIsMobile } from '../lib/useIsMobile'
import { ToneChip, panel } from './ui'

// Pending shift swaps involving me (accept/decline as the co-worker, cancel as
// the requester) plus the management approval queue. Lives above the Team
// Schedule; realtime on shift_swaps keeps it fresh.

const nice = (s) => s ? new Date(`${s}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : ''
const STATUS_TXT = {
  pending_peer: 'waiting on co-worker', pending_manager: 'waiting on management',
  approved: 'approved', denied: 'denied', declined: 'declined', canceled: 'canceled',
}
const STATUS_TONE = { pending_peer: 'amber', pending_manager: 'amber', approved: 'green', denied: 'red', declined: 'red', canceled: 'gray' }
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)

// Two opposing arrows — also marks swappable shifts on the Team Schedule.
export function SwapIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16" />
    </svg>
  )
}

async function authed(path, opts = {}) {
  const { data: { session } } = await sb.auth.getSession()
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}`, ...(opts.headers || {}) },
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`)
  return d
}

export default function SwapRequests({ profile, profiles }) {
  const isMobile = useIsMobile()
  const [data, setData] = useState({ mine: [], queue: [] })
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    authed('/api/swaps/mine').then(setData).catch(() => {})
  }, [])
  useEffect(() => {
    load()
    const ch = sb.channel(`swaps-${profile?.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shift_swaps' }, load)
      .subscribe()
    return () => sb.removeChannel(ch)
  }, [load, profile?.id])

  const nameOf = (id) => profiles.find(p => p.id === id)?.name || profiles.find(p => p.id === id)?.email || 'Someone'
  const what = (r) => r.target_date
    ? `${nameOf(r.requester_id)}'s ${nice(r.requester_date)} ↔ ${nameOf(r.target_id)}'s ${nice(r.target_date)}`
    : `${nameOf(r.requester_id)} gives ${nice(r.requester_date)} to ${nameOf(r.target_id)}`

  const act = async (path, body, key) => {
    setBusy(key); setErr('')
    try { await authed(path, { method: 'POST', body: JSON.stringify(body) }); load() }
    catch (e) { setErr(e.message) }
    setBusy(null)
  }

  const askMe = data.mine.filter(r => r.status === 'pending_peer' && r.target_id === profile?.id)
  const myPending = data.mine.filter(r => ['pending_peer', 'pending_manager'].includes(r.status) && r.requester_id === profile?.id)
  const recent = data.mine.filter(r => !['pending_peer', 'pending_manager'].includes(r.status)).slice(0, 4)
  if (!askMe.length && !myPending.length && !data.queue.length && !recent.length) return null

  // One hairline-divided row per swap: status chip, what, actions on the right.
  const row = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: isMobile ? '10px 12px' : '11px 18px', borderTop: '1px solid var(--border)' }
  const text = { flex: '1 1 240px', minWidth: 0, fontSize: 12.5, lineHeight: 1.45 }

  return (
    <div style={{ ...panel, overflow: 'hidden' }}>
      <div style={{ padding: isMobile ? '12px 12px' : '13px 18px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', color: 'var(--accent)' }}><SwapIcon size={15} /></span>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Shift swaps</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Trades waiting on you, yours in progress, and recent ones</span>
      </div>
      {err && <div style={{ ...row, fontSize: 12.5, fontWeight: 600, color: 'var(--tone-red-tx)', background: 'var(--tone-red-bg)' }}>{err}</div>}
      {askMe.map(r => (
        <div key={r.id} style={row}>
          <ToneChip tone="blue" small>Waiting on you</ToneChip>
          <span style={text}>
            <b>{nameOf(r.requester_id)}</b> wants to {r.target_date ? <>trade: you take <b>{nice(r.requester_date)}</b>, they take your <b>{nice(r.target_date)}</b></> : <>give you their <b>{nice(r.requester_date)}</b> shift</>}
            {r.note && <span style={{ color: 'var(--text-muted)' }}> — "{r.note}"</span>}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm danger" disabled={busy === r.id} onClick={() => act('/api/swaps/peer', { id: r.id, accept: false }, r.id)}>Decline</button>
            <button className="btn sm primary" disabled={busy === r.id} onClick={() => act('/api/swaps/peer', { id: r.id, accept: true }, r.id)}>
              {busy === r.id ? 'Saving…' : 'Accept'}
            </button>
          </div>
        </div>
      ))}
      {data.queue.map(r => (
        <div key={r.id} style={row}>
          <ToneChip tone="amber" small>Needs approval</ToneChip>
          <span style={text}>
            {what(r)} <span style={{ color: 'var(--text-muted)' }}>(both agreed)</span>
            {r.note && <span style={{ color: 'var(--text-muted)' }}> — "{r.note}"</span>}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm danger" disabled={busy === r.id} onClick={() => act('/api/swaps/decide', { id: r.id, decision: 'denied' }, r.id)}>Deny</button>
            <button className="btn sm primary" disabled={busy === r.id} onClick={() => act('/api/swaps/decide', { id: r.id, decision: 'approved' }, r.id)}>
              {busy === r.id ? 'Swapping…' : 'Approve'}
            </button>
          </div>
        </div>
      ))}
      {myPending.map(r => (
        <div key={r.id} style={row}>
          <ToneChip tone="amber" small>{cap(STATUS_TXT[r.status])}</ToneChip>
          <span style={text}>{what(r)}</span>
          <button className="btn sm" disabled={busy === r.id} onClick={() => act('/api/swaps/cancel', { id: r.id }, r.id)}>Cancel</button>
        </div>
      ))}
      {recent.map(r => (
        <div key={r.id} style={{ ...row, padding: isMobile ? '9px 12px' : '9px 18px' }}>
          <ToneChip tone={STATUS_TONE[r.status] || 'gray'} small>{cap(STATUS_TXT[r.status])}</ToneChip>
          <span style={{ ...text, fontSize: 12, color: 'var(--text-muted)' }}>
            {what(r)}{r.decided_by ? ` · by ${r.decided_by}` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}
