import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

// Pending shift swaps involving me (accept/decline as the co-worker, cancel as
// the requester) plus the management approval queue. Lives above the Team
// Schedule; realtime on shift_swaps keeps it fresh.

const nice = (s) => s ? new Date(`${s}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : ''
const STATUS_TXT = {
  pending_peer: 'waiting on co-worker', pending_manager: 'waiting on management',
  approved: 'approved', denied: 'denied', declined: 'declined', canceled: 'canceled',
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

  return (
    <div className="card" style={{ marginBottom: 14, padding: '12px 16px' }}>
      <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: .5, color: 'var(--text-muted)', marginBottom: 8 }}>
        🔁 Shift swaps
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {askMe.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 10px', background: 'var(--accent-bg)', borderRadius: 8 }}>
            <span style={{ fontSize: 12.5, flex: 1, minWidth: 220 }}>
              <b>{nameOf(r.requester_id)}</b> wants to {r.target_date ? <>trade: you take <b>{nice(r.requester_date)}</b>, they take your <b>{nice(r.target_date)}</b></> : <>give you their <b>{nice(r.requester_date)}</b> shift</>}
              {r.note && <span style={{ color: 'var(--text-muted)' }}> — "{r.note}"</span>}
            </span>
            <button className="btn sm" disabled={busy === r.id} onClick={() => act('/api/swaps/peer', { id: r.id, accept: false }, r.id)}
              style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>Decline</button>
            <button className="btn sm primary" disabled={busy === r.id} onClick={() => act('/api/swaps/peer', { id: r.id, accept: true }, r.id)}>
              {busy === r.id ? 'Saving…' : 'Accept'}
            </button>
          </div>
        ))}
        {data.queue.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 10px', background: 'var(--tone-amber-bg)', borderRadius: 8 }}>
            <span style={{ fontSize: 12.5, flex: 1, minWidth: 220 }}>
              <b>Needs approval:</b> {what(r)} <span style={{ color: 'var(--text-muted)' }}>(both agreed)</span>
              {r.note && <span style={{ color: 'var(--text-muted)' }}> — "{r.note}"</span>}
            </span>
            <button className="btn sm" disabled={busy === r.id} onClick={() => act('/api/swaps/decide', { id: r.id, decision: 'denied' }, r.id)}
              style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>Deny</button>
            <button className="btn sm primary" disabled={busy === r.id} onClick={() => act('/api/swaps/decide', { id: r.id, decision: 'approved' }, r.id)}>
              {busy === r.id ? 'Swapping…' : 'Approve'}
            </button>
          </div>
        ))}
        {myPending.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
            <span style={{ flex: 1 }}>{what(r)} <span style={{ color: 'var(--tone-amber-tx)', fontWeight: 700 }}>· {STATUS_TXT[r.status]}</span></span>
            <button className="btn sm" disabled={busy === r.id} onClick={() => act('/api/swaps/cancel', { id: r.id }, r.id)}>Cancel</button>
          </div>
        ))}
        {recent.map(r => (
          <div key={r.id} style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {what(r)} · {STATUS_TXT[r.status]}{r.decided_by ? ` by ${r.decided_by}` : ''}
          </div>
        ))}
      </div>
    </div>
  )
}
