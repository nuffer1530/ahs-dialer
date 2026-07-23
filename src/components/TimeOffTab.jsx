import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

// Time off — request PTO/sick from My Page; the manager approves right here.
// Approval writes the day(s) onto the WFM schedule (schedules.day_type).

const KIND_LABEL = { pto: 'PTO', sick: 'Sick' }
const STATUS_CHIP = {
  pending:  { bg: '#FBF3E0', color: '#8A5A00', label: 'Pending' },
  approved: { bg: '#DCFCE7', color: '#15803D', label: 'Approved' },
  denied:   { bg: '#FEE2E2', color: '#B91C1C', label: 'Denied' },
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const niceDay = (s) => s ? new Date(`${s}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : ''
const dayCount = (a, b) => Math.round((new Date(`${b || a}T12:00:00`) - new Date(`${a}T12:00:00`)) / 864e5) + 1

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
  const [names, setNames] = useState({})
  const [modal, setModal] = useState(null)    // open request modal
  const [form, setForm] = useState({ kind: 'pto', reason: '', start: '', end: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [deciding, setDeciding] = useState(null)
  // Month being viewed: 0 = this month, up to 12 months out for pre-planning.
  const [monthOff, setMonthOff] = useState(0)

  const load = useCallback(async () => {
    if (!profile?.id) return
    const [{ data: my }, { data: q }, { data: profs }] = await Promise.all([
      sb.from('pto_requests').select('*').eq('profile_id', profile.id).order('created_at', { ascending: false }).limit(50),
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
    if (!form.start) { setErr('Pick a first day'); return }
    if (form.end && form.end < form.start) { setErr('Last day is before the first day'); return }
    setBusy(true); setErr('')
    try {
      await authedPost('/api/pto/request', {
        date: form.start,
        endDate: form.end && form.end !== form.start ? form.end : null,
        kind: form.kind, reason: form.reason.trim(),
      })
      setModal(null)
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

  // ── Month grid (one month at a time, navigable up to a year out) ──
  const today = new Date(); today.setHours(12, 0, 0, 0)
  const monthStart = new Date(today.getFullYear(), today.getMonth() + monthOff, 1, 12)
  const gridStart = new Date(monthStart); gridStart.setDate(1 - monthStart.getDay())
  const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(gridStart); d.setDate(d.getDate() + i); return d })
  const todayStr = ymd(today)

  const myByDate = {}
  mine.forEach(r => {
    if (r.status === 'denied') return
    const d = new Date(`${r.date}T12:00:00`); const e = new Date(`${r.end_date || r.date}T12:00:00`)
    while (d <= e) { const k = ymd(d); if (!myByDate[k] || r.status === 'approved') myByDate[k] = r; d.setDate(d.getDate() + 1) }
  })

  const openRequest = (dateStr) => {
    setErr('')
    setForm({ kind: 'pto', reason: '', start: dateStr, end: dateStr })
    setModal(true)
  }

  const span = (r) => r.end_date ? `${niceDay(r.date)} – ${niceDay(r.end_date)}` : niceDay(r.date)
  const nDays = form.start ? dayCount(form.start, form.end || form.start) : 0

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
                    <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> ({dayCount(r.date, r.end_date)} day{dayCount(r.date, r.end_date) === 1 ? '' : 's'})</span>
                  </div>
                  {r.reason && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>"{r.reason}"</div>}
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

      {/* Month calendar — navigate up to a year out */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Request time off</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className="btn sm" onClick={() => setMonthOff(m => Math.max(0, m - 1))} disabled={monthOff === 0}>‹</button>
            <span style={{ fontSize: 13, fontWeight: 700, minWidth: 130, textAlign: 'center' }}>
              {monthStart.toLocaleDateString([], { month: 'long', year: 'numeric' })}
            </span>
            <button className="btn sm" onClick={() => setMonthOff(m => Math.min(12, m + 1))} disabled={monthOff === 12}>›</button>
          </div>
        </div>
        <div className="card-body">
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
            Click a day to start a request — you can plan up to a year ahead. Approved days land on the schedule automatically.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
              <div key={d} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', padding: '2px 0' }}>{d}</div>
            ))}
            {cells.map((d, i) => {
              const key = ymd(d)
              const inMonth = d.getMonth() === monthStart.getMonth()
              const past = key < todayStr
              const r = myByDate[key]
              const chip = r ? STATUS_CHIP[r.status] : null
              return (
                <button key={i} disabled={past || !inMonth}
                  onClick={() => openRequest(key)}
                  title={r ? `${KIND_LABEL[r.kind]} — ${chip.label}` : past || !inMonth ? '' : 'Request this day off'}
                  style={{ padding: '12px 4px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, textAlign: 'center',
                    border: `1px solid ${chip ? chip.color : 'var(--border)'}`,
                    background: chip ? chip.bg : 'var(--surface)',
                    color: chip ? chip.color : (past || !inMonth) ? 'var(--text-muted)' : 'var(--text-primary)',
                    cursor: (past || !inMonth) ? 'default' : 'pointer',
                    opacity: !inMonth ? .25 : past ? .45 : 1 }}>
                  <div>{d.getDate()}</div>
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

      {/* Request modal — explicit first/last day, live day count */}
      {modal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onMouseDown={() => setModal(null)}>
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
                  <input className="form-input" type="date" value={form.start} min={todayStr}
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
                <button className="btn" onClick={() => setModal(null)}>Cancel</button>
                <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Sending…' : `Send request (${nDays} day${nDays === 1 ? '' : 's'})`}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
