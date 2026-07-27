import { useState } from 'react'
import { sb } from '../lib/supabase'

// Request a shift trade or give-away. Opened by clicking your own shift on
// the Team Schedule. Peer accepts first, then management — this only files
// the request.

const nice = (s) => s ? new Date(`${s}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : ''
const fmt12s = (t) => {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'p' : 'a'}`
}

export default function ShiftSwapModal({ profile, profiles, schedules, initialDate, onClose, onSubmitted }) {
  const today = new Date().toISOString().slice(0, 10)
  const isWork = (s) => s && (!s.day_type || s.day_type === 'work') && s.shift_start
  const myShifts = schedules
    .filter(s => s.profile_id === profile?.id && s.date > today && isWork(s))
    .sort((a, b) => a.date.localeCompare(b.date))

  const [form, setForm] = useState({ requesterDate: initialDate || myShifts[0]?.date || '', targetId: '', kind: 'trade', targetDate: '', note: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const others = profiles.filter(p => p.id !== profile?.id)
  const targetShifts = form.targetId
    ? schedules.filter(s => s.profile_id === form.targetId && s.date > today && isWork(s)
        && s.date !== form.requesterDate)
      .sort((a, b) => a.date.localeCompare(b.date))
    : []
  const shiftLabel = (s) => `${nice(s.date)} · ${fmt12s(s.shift_start)}–${fmt12s(s.shift_end)}`

  const submit = async () => {
    if (busy) return
    setErr('')
    if (!form.requesterDate) { setErr('Pick which of your shifts to swap.'); return }
    if (!form.targetId) { setErr('Pick a co-worker.'); return }
    if (form.kind === 'trade' && !form.targetDate) { setErr('Pick which of their shifts you want in return.'); return }
    setBusy(true)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const r = await fetch('/api/swaps/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          requesterDate: form.requesterDate,
          targetId: form.targetId,
          targetDate: form.kind === 'trade' ? form.targetDate : null,
          note: form.note.trim(),
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'Request failed')
      onSubmitted?.()
      onClose()
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()}
        style={{ background: 'var(--surface)', borderRadius: 14, width: '100%', maxWidth: 440, boxShadow: '0 12px 40px rgba(0,0,0,.25)', padding: '20px 22px' }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>🔁 Swap a shift</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 14 }}>
          Your co-worker accepts first, then management signs off — you'll get an email at each step.
          Swaps close 24 hours before the shift.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="form-field">
            <label className="form-label">Your shift to swap</label>
            <select className="form-input" value={form.requesterDate}
              onChange={e => setForm(f => ({ ...f, requesterDate: e.target.value }))}>
              {!myShifts.length && <option value="">No upcoming shifts on the schedule</option>}
              {myShifts.map(s => <option key={s.date} value={s.date}>{shiftLabel(s)}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label className="form-label">Co-worker</label>
            <select className="form-input" value={form.targetId}
              onChange={e => setForm(f => ({ ...f, targetId: e.target.value, targetDate: '' }))}>
              <option value="">Pick someone…</option>
              {others.map(p => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[['trade', 'Trade shifts'], ['give', 'Give it away']].map(([k, label]) => (
              <button key={k} onClick={() => setForm(f => ({ ...f, kind: k }))}
                style={{ flex: 1, padding: '9px 0', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  border: `2px solid ${form.kind === k ? 'var(--accent)' : 'var(--border)'}`,
                  background: form.kind === k ? 'var(--accent-bg)' : 'var(--surface-2)',
                  color: form.kind === k ? 'var(--accent)' : 'var(--text-secondary)' }}>
                {label}
              </button>
            ))}
          </div>
          {form.kind === 'trade' && (
            <div className="form-field">
              <label className="form-label">Their shift you'll take</label>
              <select className="form-input" value={form.targetDate}
                onChange={e => setForm(f => ({ ...f, targetDate: e.target.value }))} disabled={!form.targetId}>
                <option value="">{form.targetId ? (targetShifts.length ? 'Pick their shift…' : 'They have no upcoming shifts') : 'Pick a co-worker first'}</option>
                {targetShifts.map(s => <option key={s.date} value={s.date}>{shiftLabel(s)}</option>)}
              </select>
            </div>
          )}
          <div className="form-field">
            <label className="form-label">Note (optional)</label>
            <input className="form-input" value={form.note} placeholder="Doctor appointment Thursday morning…"
              onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
          </div>
          {err && <div style={{ fontSize: 12, color: 'var(--danger)', background: 'var(--danger-bg)', padding: '8px 12px', borderRadius: 8 }}>{err}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={submit} disabled={busy || !myShifts.length}>
              {busy ? 'Sending…' : 'Send swap request'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
