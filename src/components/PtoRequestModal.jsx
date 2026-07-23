import { useState } from 'react'
import { sb } from '../lib/supabase'

// Shared PTO/sick request modal — opened from the Time Off tab's calendar AND
// from clicking a day on My Schedule. One form, one behavior.

const KIND_LABEL = { pto: 'PTO', sick: 'Sick' }
const niceDay = (s) => s ? new Date(`${s}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : ''
const dayCount = (a, b) => Math.round((new Date(`${b || a}T12:00:00`) - new Date(`${a}T12:00:00`)) / 864e5) + 1
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function PtoRequestModal({ initialDate, onClose, onSubmitted }) {
  const [form, setForm] = useState({ kind: 'pto', reason: '', start: initialDate, end: initialDate })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const nDays = form.start ? dayCount(form.start, form.end || form.start) : 0

  const submit = async () => {
    if (!form.start) { setErr('Pick a first day'); return }
    if (form.end && form.end < form.start) { setErr('Last day is before the first day'); return }
    setBusy(true); setErr('')
    try {
      const { data: { session } } = await sb.auth.getSession()
      const r = await fetch('/api/pto/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          date: form.start,
          endDate: form.end && form.end !== form.start ? form.end : null,
          kind: form.kind, reason: form.reason.trim(),
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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()}
        style={{ background: 'var(--surface)', borderRadius: 14, width: '100%', maxWidth: 420, boxShadow: '0 12px 40px rgba(0,0,0,.25)', padding: '20px 22px' }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Request time off</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {['pto', 'sick'].map(k => (
              <button key={k} onClick={() => setForm(f => ({ ...f, kind: k }))}
                style={{ flex: 1, padding: '9px 0', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  border: `2px solid ${form.kind === k ? 'var(--accent)' : 'var(--border)'}`,
                  background: form.kind === k ? 'var(--accent-bg)' : 'var(--surface-2)',
                  color: form.kind === k ? 'var(--accent)' : 'var(--text-secondary)' }}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-field">
              <label className="form-label">First day off</label>
              <input className="form-input" type="date" value={form.start} min={todayYmd()}
                onChange={e => setForm(f => ({ ...f, start: e.target.value, end: f.end && f.end < e.target.value ? e.target.value : f.end }))} />
            </div>
            <div className="form-field">
              <label className="form-label">Last day off</label>
              <input className="form-input" type="date" value={form.end || form.start} min={form.start}
                onChange={e => setForm(f => ({ ...f, end: e.target.value }))} />
            </div>
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-bg)', borderRadius: 8, padding: '8px 12px' }}>
            {nDays === 1
              ? `1 day — ${niceDay(form.start)}`
              : `${nDays} days — ${niceDay(form.start)} through ${niceDay(form.end || form.start)}`}
          </div>
          <div className="form-field">
            <label className="form-label">Reason</label>
            <textarea className="form-input" rows={3} value={form.reason} placeholder="Family trip, appointment, not feeling well…"
              onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} />
          </div>
          {err && <div style={{ fontSize: 12, color: 'var(--danger)', background: 'var(--danger-bg)', padding: '8px 12px', borderRadius: 8 }}>{err}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Sending…' : `Send request (${nDays} day${nDays === 1 ? '' : 's'})`}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
