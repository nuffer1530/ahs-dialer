import { useState, useEffect, useCallback } from 'react'
import { toast } from '../lib/dialogs'
import { sb } from '../lib/supabase'
import { useIsMobile } from '../lib/useIsMobile'
import PtoRequestModal from './PtoRequestModal'
import { PillNav, ToneChip, Face, eyebrow, num, panel } from './ui'

// Time off — request PTO/sick from My Page; the manager approves right here.
// Approval writes the day(s) onto the WFM schedule (schedules.day_type).

const KIND_LABEL = { pto: 'PTO', sick: 'Sick' }
const STATUS_CHIP = {
  pending:  { tone: 'amber', label: 'Pending' },
  approved: { tone: 'green', label: 'Approved' },
  denied:   { tone: 'red',   label: 'Denied' },
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

// Panel header row: title, a muted line, actions on the right.
function Head({ title, desc, isMobile, children }) {
  return (
    <div style={{ padding: isMobile ? '12px 14px' : '14px 20px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 14, fontWeight: 700 }}>{title}</span>
      {desc && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{desc}</span>}
      {children && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>{children}</div>}
    </div>
  )
}

export default function TimeOffTab({ profile }) {
  const isMobile = useIsMobile()
  const [mine, setMine] = useState([])
  const [queue, setQueue] = useState([])      // pending requests where I'm the manager
  const [names, setNames] = useState({})
  const [modal, setModal] = useState(null)    // open request modal
  const [deciding, setDeciding] = useState(null)
  const [teamApproved, setTeamApproved] = useState([])
  // Month being viewed: 0 = this month, up to 12 months out for pre-planning.
  const [monthOff, setMonthOff] = useState(0)

  const load = useCallback(async () => {
    if (!profile?.id) return
    const [{ data: my }, { data: q }, { data: profs }, { data: appr }] = await Promise.all([
      sb.from('pto_requests').select('*').eq('profile_id', profile.id).order('created_at', { ascending: false }).limit(50),
      sb.from('pto_requests').select('*').eq('manager_id', profile.id).eq('status', 'pending').order('created_at', { ascending: true }),
      sb.from('profiles').select('id, name, email'),
      sb.from('pto_requests').select('*').eq('manager_id', profile.id).eq('status', 'approved')
        .gte('date', new Date().toISOString().slice(0, 10)).order('date', { ascending: true }),
    ])
    setMine(my || [])
    setQueue(q || [])
    setNames(Object.fromEntries((profs || []).map(p => [p.id, p.name || p.email])))
    setTeamApproved(appr || [])
  }, [profile?.id])

  useEffect(() => {
    load()
    const ch = sb.channel(`pto_${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pto_requests' }, load)
      .subscribe()
    return () => sb.removeChannel(ch)
  }, [load])

  const cancel = async (r, asManager) => {
    const span = r.end_date ? `${r.date} – ${r.end_date}` : r.date
    const msg = r.status === 'approved'
      ? `Remove this approved ${KIND_LABEL[r.kind]} (${span})? The day(s) will be cleared from the schedule and ${asManager ? 'they' : 'your manager'} will be notified.`
      : `Cancel this pending request (${span})?`
    if (!confirm(msg)) return
    setDeciding(r.id)
    try { await authedPost('/api/pto/cancel', { id: r.id }); load() }
    catch (e) { toast(e.message) }
    setDeciding(null)
  }

  const decide = async (id, decision) => {
    setDeciding(id)
    try { await authedPost('/api/pto/decide', { id, decision }); load() }
    catch (e) { toast(e.message) }
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

  const openRequest = (dateStr) => setModal({ date: dateStr })

  const span = (r) => r.end_date ? `${niceDay(r.date)} – ${niceDay(r.end_date)}` : niceDay(r.date)
  const rowPad = isMobile ? '10px 14px' : '11px 20px'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>

      {/* Manager approvals — only shows when something needs you */}
      {queue.length > 0 && (
        <div style={{ ...panel, overflow: 'hidden' }}>
          <Head title="Needs your approval" isMobile={isMobile}>
            <ToneChip tone="amber">{queue.length} pending request{queue.length === 1 ? '' : 's'}</ToneChip>
          </Head>
          {queue.map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: rowPad, borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <Face name={names[r.profile_id] || 'Unknown'} size={32} />
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 650 }}>
                  {names[r.profile_id] || 'Unknown'} · {KIND_LABEL[r.kind]} · {span(r)}
                  <span style={{ ...num, fontWeight: 400, color: 'var(--text-muted)' }}> ({dayCount(r.date, r.end_date)} day{dayCount(r.date, r.end_date) === 1 ? '' : 's'})</span>
                </div>
                {r.reason && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>"{r.reason}"</div>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn sm danger" disabled={deciding === r.id}
                  onClick={() => decide(r.id, 'denied')}>Deny</button>
                <button className="btn sm primary" disabled={deciding === r.id}
                  onClick={() => decide(r.id, 'approved')}>
                  {deciding === r.id ? 'Saving…' : 'Approve'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {teamApproved.length > 0 && (
        <div style={{ ...panel, overflow: 'hidden' }}>
          <Head title="Your team's upcoming time off" desc="Remove one if plans changed — the schedule day clears and they're notified" isMobile={isMobile} />
          {teamApproved.map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: rowPad, borderTop: '1px solid var(--border)' }}>
              <Face name={names[r.profile_id] || 'Unknown'} size={28} />
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0 }}>
                {names[r.profile_id] || 'Unknown'} · {KIND_LABEL[r.kind]} · {span(r)}
              </span>
              <button className="btn sm danger" disabled={deciding === r.id} onClick={() => cancel(r, true)} style={{ flexShrink: 0 }}>Remove</button>
            </div>
          ))}
        </div>
      )}

      {/* Calendar and history side by side on wide screens */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: 16, alignItems: 'start' }}>

      {/* Month calendar — navigate up to a year out */}
      <div style={{ ...panel, overflow: 'hidden' }}>
        <Head title="Request time off" isMobile={isMobile}>
          <PillNav label={monthStart.toLocaleDateString([], { month: 'long', year: 'numeric' })}
            onPrev={() => setMonthOff(m => Math.max(0, m - 1))} prevDisabled={monthOff === 0}
            onNext={() => setMonthOff(m => Math.min(12, m + 1))} nextDisabled={monthOff === 12} />
        </Head>
        <div style={{ padding: isMobile ? '0 12px 14px' : '0 20px 18px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Click a day to start a request — you can plan up to a year ahead. Approved days land on the schedule automatically.
          </div>
          {/* A real 7-day row: mgrid keeps it seven across on a phone. */}
          <div className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: isMobile ? 4 : 6 }}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
              <div key={d} style={{ ...eyebrow, textAlign: 'center', padding: '2px 0' }}>{d}</div>
            ))}
            {cells.map((d, i) => {
              const key = ymd(d)
              const inMonth = d.getMonth() === monthStart.getMonth()
              const past = key < todayStr
              const r = myByDate[key]
              const chip = r ? STATUS_CHIP[r.status] : null
              const isToday = key === todayStr
              return (
                <button key={i} disabled={past || !inMonth}
                  onClick={() => openRequest(key)}
                  title={r ? `${KIND_LABEL[r.kind]} — ${chip.label}` : past || !inMonth ? '' : 'Request this day off'}
                  className={past || !inMonth ? undefined : 'lift-hover'}
                  style={{ padding: isMobile ? '9px 2px' : '11px 4px', borderRadius: 10, fontSize: 12.5, fontWeight: isToday ? 800 : 600, textAlign: 'center', minWidth: 0,
                    border: `1px solid ${chip ? `var(--tone-${chip.tone}-bd)` : isToday ? 'var(--accent)' : 'var(--border)'}`,
                    background: chip ? `var(--tone-${chip.tone}-bg)` : 'var(--surface)',
                    color: chip ? `var(--tone-${chip.tone}-tx)` : (past || !inMonth) ? 'var(--text-muted)' : isToday ? 'var(--accent)' : 'var(--text-primary)',
                    cursor: (past || !inMonth) ? 'default' : 'pointer',
                    opacity: !inMonth ? .25 : past ? .45 : 1 }}>
                  <div style={num}>{d.getDate()}</div>
                  {chip && <div style={{ fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', marginTop: 1 }}>{KIND_LABEL[r.kind]}</div>}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* My history */}
      <div style={{ ...panel, overflow: 'hidden' }}>
        <Head title="My requests" isMobile={isMobile} />
        {mine.length === 0 ? (
          <div style={{ padding: '22px 20px', borderTop: '1px solid var(--border)', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>Nothing requested yet.</div>
        ) : (
          <div>
            {mine.map(r => {
              const chip = STATUS_CHIP[r.status]
              return (
                <div key={r.id} className="eval-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: rowPad, borderTop: '1px solid var(--border)' }}>
                  <span style={{ width: 76, flexShrink: 0 }}><ToneChip tone={chip.tone} small>{chip.label}</ToneChip></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 650 }}>{KIND_LABEL[r.kind]} · {span(r)}</div>
                    {(r.reason || r.decision_note) && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.reason && `"${r.reason}"`}{r.reason && r.decision_note ? ' ' : ''}{r.decision_note && `— ${r.decision_note}`}
                      </div>
                    )}
                  </div>
                  {(r.status === 'pending' || (r.status === 'approved' && (r.end_date || r.date) >= new Date().toISOString().slice(0, 10))) && (
                    <button className="btn sm danger" disabled={deciding === r.id} onClick={() => cancel(r, false)}
                      style={{ marginLeft: 'auto', flexShrink: 0 }}>
                      {r.status === 'approved' ? 'Cancel PTO' : 'Cancel'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      </div>{/* /grid */}

      {modal && (
        <PtoRequestModal initialDate={modal.date} onClose={() => setModal(null)} onSubmitted={load} />
      )}
    </div>
  )
}
