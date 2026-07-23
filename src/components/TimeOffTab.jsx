import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { fmtDate } from '../lib/utils'

// Time off — request PTO/sick from My Page; the manager approves right here.
// Approval writes the day(s) onto the WFM schedule (schedules.day_type).

const KIND_LABEL = { pto: 'PTO', sick: 'Sick' }
const STATUS_CHIP = {
  pending:  { bg: '#FBF3E0', color: '#8A5A00', label: 'Pending' },
  approved: { bg: '#DCFCE7', color: '#15803D', label: 'Approved' },
  denied:   { bg: '#FEE2E2', color: '#B91C1C', label: 'Denied' },
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

async function authedPost(path, body) {
  const { data: { session } } = await sb.auth.getSession()
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify(body),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`)
  return d
}

export default function TimeOffTab({ profile }) {
  const [mine, setMine] = useState([])
  const [queue, setQueue] = useState([])      // pending requests where I'm the manager
  const [names, setNames] = useState({})      // profile_id -> display name
  const [modal, setModal] = useState(null)    // { date } when requesting
  const [form, setForm] = useState({ kind: 'pto', reason: '', endDate: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [deciding, setDeciding] = useState(null)

  const load = useCallback(async () => {
    if (!profile?.id) return
    const [{ data: my }, { data: q }, { data: profs }] = await Promise.all([
      sb.from('pto_requests').select('*').eq('profile_id', profile.id).order('created_at', { ascending: false }).limit(30),
      sb.from('pto_requests').select('*').eq('manager_id', profile.id).eq('status', 'pending').order('created_at', { ascending: true }),
      sb.from('profiles').select('id, name, email'),
    ])
    setMine(my || [])
    setQueue(q || [])
    setNames(Object.fromEntries((profs || []).map(p => [p.id, p.name || p.email])))
  }, [profile?.id])

  useEffect(() => {
    load()
    const ch = sb.channel(`pto_${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pto_requests' }, load)
      .subscribe()
    return () => sb.removeChannel(ch)
  }, [load])

  const submit = async () => {
    setBusy(true); setErr('')
    try {
      await authedPost('/api/pto/request', {
        date: modal.date, endDate: form.endDate || null, kind: form.kind, reason: form.reason.trim(),
      })
      setModal(null); setForm({ kind: 'pto', reason: '', endDate: '' })
      load()
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  const decide = async (id, decision) => {
    setDeciding(id)
    try { await authedPost('/api/pto/decide', { id, decision }); load() }
    catch (e) { alert(e.message) }
    setDeciding(null)
  }

  // Six-week click grid starting this week — click a day to request it.
  const start = new Date(); start.setHours(12, 0, 0, 0)
  start.setDate(start.getDate() - start.getDay())
  const weeks = Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + w * 7 + i); return d }))
  const today = ymd(new Date())
  const myByDate = {}
  mine.forEach(r => {
    const days = [r.date]
    if (r.end_date) { const d = new Date(`${r.date}T12:00:00`); const e = new Date(`${r.end_date}T12:00:00`); while (d <= e) { days.push(ymd(d)); d.setDate(d.getDate() + 1) } }
    days.forEach(dd => { if (!myByDate[dd] || r.status === 'approved') myByDate[dd] = r })
  })

  const span = (r) => r.end_date ? `${fmtDate(r.date)} – ${fmtDate(r.end_date)}` : fmtDate(r.date)

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 980 }}>

      {/* Manager approvals — only shows when something needs you */}
      {queue.length > 0 && (
        <div className="card" style={{ borderLeft: '3px solid var(--danger)' }}>
          <div className="card-header">
            <div className="card-title">Needs your approval</div>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{queue.length} pending request{queue.length === 1 ? '' : 's'}</span>
          </div>
          <div>
            {queue.map(r => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>
                    {names[r.profile_id] || 'Unknown'} · {KIND_LABEL[r.kind]} · {span(r)}
                  </div>
                  {r.reason && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>"{r.reason}"</div>}
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>requested {fmtDate(r.created_at)}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn sm" disabled={deciding === r.id}
                    onClick={() => decide(r.id, 'denied')}
                    style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>Deny</button>
                  <button className="btn sm primary" disabled={deciding === r.id}
                    onClick={() => decide(r.id, 'approved')}>
                    {deciding === r.id ? 'Saving…' : 'Approve'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Request grid */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Request time off</div>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Click a day · goes to your manager for approval · approved days land on the schedule</span>
        </div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
              <div key={d} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', padding: '2px 0' }}>{d}</div>
            ))}
            {weeks.flat().map((d, i) => {
              const key = ymd(d)
              const past = key < today
              const r = myByDate[key]
              const chip = r ? STATUS_CHIP[r.status] : null
              return (
                <button key={i} disabled={past}
                  onClick={() => { setErr(''); setForm({ kind: 'pto', reason: '', endDate: '' }); setModal({ date: key }) }}
                  title={r ? `${KIND_LABEL[r.kind]} — ${chip.label}` : past ? '' : 'Request this day off'}
                  style={{ padding: '10px 4px', borderRadius: 8, fontSize: 12, fontWeight: 600, textAlign: 'center',
                    border: `1px solid ${chip ? chip.color : 'var(--border)'}`,
                    background: chip ? chip.bg : 'var(--surface)',
                    color: chip ? chip.color : past ? 'var(--text-muted)' : 'var(--text-primary)',
                    cursor: past ? 'default' : 'pointer', opacity: past ? .45 : 1 }}>
                  <div>{d.getDate()}</div>
                  {d.getDate() === 1 && <div style={{ fontSize: 9, fontWeight: 700 }}>{d.toLocaleDateString([], { month: 'short' })}</div>}
                  {chip && <div style={{ fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', marginTop: 1 }}>{KIND_LABEL[r.kind]}</div>}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* My history */}
      <div className="card">
        <div className="card-header"><div className="card-title">My requests</div></div>
        {mine.length === 0 ? (
          <div style={{ padding: 18, fontSize: 12, color: 'var(--text-muted)' }}>Nothing requested yet.</div>
        ) : (
          <div>
            {mine.map(r => {
              const chip = STATUS_CHIP[r.status]
              return (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 99, padding: '2px 9px', background: chip.bg, color: chip.color, flexShrink: 0 }}>{chip.label}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{KIND_LABEL[r.kind]} · {span(r)}</span>
                  {r.reason && <span style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>"{r.reason}"</span>}
                  {r.decision_note && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>— {r.decision_note}</span>}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Request modal */}
      {modal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onMouseDown={() => setModal(null)}>
          <div onMouseDown={e => e.stopPropagation()}
            style={{ background: 'var(--surface)', borderRadius: 14, width: '100%', maxWidth: 400, boxShadow: '0 12px 40px rgba(0,0,0,.25)', padding: '20px 22px' }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 2 }}>Request time off</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>{fmtDate(modal.date)}</div>
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
              <div className="form-field">
                <label className="form-label">Through (optional — for multiple days)</label>
                <input className="form-input" type="date" min={modal.date} value={form.endDate}
                  onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} />
              </div>
              <div className="form-field">
                <label className="form-label">Reason</label>
                <textarea className="form-input" rows={3} value={form.reason} placeholder="Family trip, appointment, not feeling well…"
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} />
              </div>
              {err && <div style={{ fontSize: 12, color: 'var(--danger)', background: 'var(--danger-bg)', padding: '8px 12px', borderRadius: 8 }}>{err}</div>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button className="btn" onClick={() => setModal(null)}>Cancel</button>
                <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
