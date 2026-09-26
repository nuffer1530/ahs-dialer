import { useEffect, useMemo, useRef, useState } from 'react'
import { sb } from '../lib/supabase'
import { useIsMobile } from '../lib/useIsMobile'
import CoachingSnapshots, { fieldTone } from './CoachingSnapshots'
import { Segmented, PillNav, Ring, ToneChip, eyebrow, num, panel } from './ui'

// Team → Technicians → Coaching & Evals. Field Pro (Siro) records each tech's
// conversation in the customer's home and scores it on the trade's scorecard;
// these are the CSR coaching cards, fed by that. Coaching = one card per tech
// (score, sections, lowest steps, AI coach notes); All recordings = every
// scored call, opening to Siro's summary, the call's own scorecard and any
// Re-Engage follow-up. Data: /api/team/tech-coaching, /tech-recordings,
// /tech-recording/:id (server mirrors Siro every 10 min).

const TRADES = ['HVAC', 'Plumbing', 'Electrical', 'Garage Doors']
const FIRST_MONTH = '2026-09'   // Field Pro went live Sep 25, 2026
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const monthName = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]} ${y}` }
const nowYm = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date()).slice(0, 7)
const addYm = (ym, n) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7) }
const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Denver' })
const dayLabel = (iso) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Denver', weekday: 'long', month: 'short', day: 'numeric' })
const timeLabel = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' })
const mins = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m` : `${Math.max(1, Math.round((sec || 0) / 60))}m`)
const money = (v) => { const n = Number(String(v || '').replace(/[^0-9.]/g, '')); return n > 0 ? `$${Math.round(n).toLocaleString('en-US')}` : null }

async function api(path) {
  const { data: { session } } = await sb.auth.getSession()
  const r = await fetch(path, { headers: { Authorization: `Bearer ${session?.access_token}` } })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

function ScoreTile({ v }) {
  const t = fieldTone(v)
  return (
    <div style={{ ...num, width: 40, height: 40, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 14, fontWeight: 800, letterSpacing: '-.02em', color: `var(--tone-${t}-tx)`, background: `var(--tone-${t}-bg)`, border: `1px solid var(--tone-${t}-bd)` }}>
      {v == null ? '—' : Math.round(v)}
    </div>
  )
}

function Summary({ rows, isMobile }) {
  const scored = rows.filter(r => r.evaluation_score != null)
  const avg = scored.length ? Math.round(scored.reduce((a, r) => a + Number(r.evaluation_score), 0) / scored.length) : null
  const bands = [
    ['green', '80+', scored.filter(r => r.evaluation_score >= 80).length],
    ['amber', '50–79', scored.filter(r => r.evaluation_score >= 50 && r.evaluation_score < 80).length],
    ['red', 'Under 50', scored.filter(r => r.evaluation_score < 50).length],
  ]
  const won = rows.filter(r => r.result === 'WON').length
  const fus = rows.reduce((a, r) => a + (r.followups || 0), 0)
  const divider = isMobile ? { borderTop: '1px solid var(--border)' } : { borderLeft: '1px solid var(--border)' }
  return (
    <div style={{ ...panel, marginBottom: 16, display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(250px, 280px) minmax(0, 1fr) minmax(0, 1fr)' }}>
      <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16 }}>
        <Ring pct={avg || 0} size={72} stroke={7} tone={fieldTone(avg)}>
          <div style={{ ...num, fontSize: 19, fontWeight: 800, color: `var(--tone-${fieldTone(avg)}-tx)` }}>{avg ?? '—'}</div>
        </Ring>
        <div>
          <div style={eyebrow}>Average Field Pro score</div>
          <div style={{ ...num, fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{scored.length} scored of {rows.length} recording{rows.length === 1 ? '' : 's'}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Out of 100 on the trade’s scorecard</div>
        </div>
      </div>
      <div style={{ padding: '16px 20px', minWidth: 0, ...divider }}>
        <div style={{ ...eyebrow, marginBottom: 12 }}>Score spread</div>
        <div style={{ display: 'flex', height: 10, borderRadius: 99, overflow: 'hidden', background: 'var(--surface-2)', gap: 2 }}>
          {bands.map(([t, , n]) => n > 0 && <div key={t} style={{ flex: n, background: `var(--tone-${t}-tx)` }} />)}
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
          {bands.map(([t, label, n]) => (
            <span key={t} style={{ ...num, fontSize: 12, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: `var(--tone-${t}-tx)` }} />
              {label} <b style={{ color: 'var(--text-primary)' }}>{n}</b>
            </span>
          ))}
        </div>
      </div>
      <div style={{ padding: '16px 20px', minWidth: 0, display: 'flex', gap: 28, ...divider }}>
        <div>
          <div style={eyebrow}>Won on the call</div>
          <div style={{ ...num, fontSize: 26, fontWeight: 800, marginTop: 6, color: 'var(--tone-green-tx)' }}>{won}</div>
        </div>
        <div>
          <div style={eyebrow}>Re-Engage leads</div>
          <div style={{ ...num, fontSize: 26, fontWeight: 800, marginTop: 6, color: fus ? 'var(--tone-amber-tx)' : 'var(--text-primary)' }}>{fus}</div>
        </div>
      </div>
    </div>
  )
}

function RecordingList({ rows, grouped, isMobile, onOpen }) {
  const groups = useMemo(() => {
    if (!grouped) return [{ key: 'all', rows }]
    const out = []
    for (const r of rows) {
      const k = dayKey(r.recorded_at)
      if (!out.length || out[out.length - 1].key !== k) out.push({ key: k, label: dayLabel(r.recorded_at), rows: [] })
      out[out.length - 1].rows.push(r)
    }
    return out
  }, [rows, grouped])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {groups.map(g => {
        const sc = g.rows.filter(r => r.evaluation_score != null)
        const avg = sc.length ? Math.round(sc.reduce((a, r) => a + Number(r.evaluation_score), 0) / sc.length) : null
        return (
          <div key={g.key} style={{ ...panel, borderRadius: 14, overflow: 'hidden' }}>
            {grouped && (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: isMobile ? '10px 12px' : '11px 18px', background: 'var(--surface-2)' }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{g.label}</span>
                <span style={{ ...num, fontSize: 12, color: 'var(--text-muted)' }}>{g.rows.length} recording{g.rows.length === 1 ? '' : 's'}</span>
                {avg != null && <span style={{ ...num, marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: `var(--tone-${fieldTone(avg)}-tx)` }}>avg {avg}</span>}
              </div>
            )}
            <div style={{ marginTop: grouped ? 0 : -1 }}>
              {g.rows.map(r => (
                <button key={r.id} onClick={() => onOpen(r)} className="eval-row"
                  style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 14, padding: isMobile ? '10px 12px' : '11px 18px',
                    border: 'none', borderTop: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'inherit', font: 'inherit' }}>
                  <ScoreTile v={r.evaluation_score} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: isMobile ? 'wrap' : undefined }}>
                      <span style={{ fontSize: 13.5, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.customer_name || (r.job_number ? `Job #${r.job_number}` : 'Recording')}
                      </span>
                      <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{r.tech_name || 'Unknown'}</span>
                      {r.result === 'WON' && <ToneChip tone="green" small>Won</ToneChip>}
                      {r.followups > 0 && <ToneChip tone="amber" small>Re-Engage</ToneChip>}
                    </div>
                    {r.line && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis',
                        ...(isMobile ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } : { whiteSpace: 'nowrap' }) }}>{r.line}</div>
                    )}
                  </div>
                  <div style={{ ...num, fontSize: 11.5, color: 'var(--text-muted)', flexShrink: 0, textAlign: 'right' }}>
                    {!grouped && <div>{new Date(r.recorded_at).toLocaleDateString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric' })}</div>}
                    <div>{timeLabel(r.recorded_at)}</div>
                    <div>{mins(r.duration_sec)}</div>
                  </div>
                  <span aria-hidden="true" style={{ color: 'var(--text-muted)', fontSize: 16, flexShrink: 0 }}>›</span>
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StepBar({ name, v }) {
  const t = fieldTone(v)
  return (
    <div className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 90px 48px', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
      <span title={name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      <div style={{ height: 6, borderRadius: 99, background: 'var(--surface-2)', overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(2, Math.min(100, v || 0))}%`, height: '100%', borderRadius: 99, background: `var(--tone-${t}-tx)` }} />
      </div>
      <span style={{ ...num, textAlign: 'right', color: 'var(--text-secondary)' }}>{v == null ? '—' : Math.round(v)}</span>
    </div>
  )
}

const TYPE = { REHASH: 'Rehash — unsold quote', CROSS_SELL: 'Cross-sell' }

function RecordingModal({ row, onClose }) {
  const isMobile = useIsMobile()
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let dead = false
    api(`/api/team/tech-recording/${encodeURIComponent(row.id)}`).then(x => { if (!dead) setD(x) }).catch(e => { if (!dead) setErr(e.message) })
    return () => { dead = true }
  }, [row.id])
  const score = d?.scorecard?.points ?? row.evaluation_score
  const t = fieldTone(score)
  const when = new Date(row.recorded_at).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const order = ['Key Outcomes & Next Steps', 'Outcome & Next Steps', 'Strength', 'Growth Area', 'Customer Need & Motivation', 'Customer Pain Points', 'Customer Objections', 'Key Objections & Resistance', 'Current Provider & Satisfaction', 'Customer Sentiment']
  const rank = (n) => { const i = order.indexOf(n); return i < 0 ? 99 : i }
  const summary = [...(d?.summary || [])].sort((a, b) => rank(a.name) - rank(b.name))
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: isMobile ? 8 : 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 720, maxWidth: isMobile ? '100%' : '96vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: 'var(--surface)',
          borderRadius: isMobile ? 16 : 18, border: '1px solid var(--border)', overflow: 'hidden', boxShadow: '0 24px 60px -20px rgba(15,20,40,.35)' }}>
        <div style={{ padding: isMobile ? '12px' : '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
          <Ring pct={score || 0} size={58} stroke={5} tone={t}>
            <div style={{ ...num, fontSize: 17, fontWeight: 800, color: `var(--tone-${t}-tx)` }}>{score == null ? '—' : Math.round(score)}</div>
          </Ring>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={eyebrow}>Field Pro recording</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.customer_name || (row.job_number ? `Job #${row.job_number}` : 'Recording')}
            </div>
            <div style={{ ...num, fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {[row.tech_name, row.trade, row.job_number ? `Job #${row.job_number}` : null, when, mins(row.duration_sec)].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close"
            style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', width: isMobile ? 40 : 30, height: isMobile ? 40 : 30, borderRadius: 99, cursor: 'pointer',
              fontSize: 16, lineHeight: 1, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', flexShrink: 0 }}>×</button>
        </div>
        <div style={{ padding: isMobile ? '10px 12px' : '10px 20px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, flexWrap: 'wrap', background: 'var(--surface-2)', flexShrink: 0 }}>
          {d?.web_url && <a className="btn sm" href={d.web_url} target="_blank" rel="noreferrer" style={{ borderRadius: 99 }}>Listen in Field Pro ↗</a>}
          {d?.st_job_id && <a className="btn sm" href={`https://go.servicetitan.com/#/Job/Index/${d.st_job_id}`} target="_blank" rel="noreferrer" style={{ borderRadius: 99 }}>Open job in ServiceTitan ↗</a>}
          {row.result === 'WON' && <ToneChip tone="green">Won on the call</ToneChip>}
        </div>
        <div style={{ overflowY: 'auto', padding: isMobile ? 12 : 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {err && <div style={{ color: 'var(--danger)', fontSize: 13 }}>Couldn’t load this recording: {err}</div>}
          {!d && !err && <><div className="skel" style={{ height: 90, borderRadius: 12 }} /><div className="skel" style={{ height: 160, borderRadius: 12 }} /></>}

          {(d?.followups || []).map(f => (
            <div key={f.id} style={{ border: '1px solid var(--tone-amber-bd)', background: 'var(--tone-amber-bg)', borderRadius: 12, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <span style={{ ...eyebrow, color: 'var(--tone-amber-tx)' }}>Re-Engage</span>
                <ToneChip tone={f.score >= 4 ? 'red' : 'amber'} small>Priority {f.score}/5</ToneChip>
                <ToneChip tone="blue" small>{TYPE[f.followup_type] || 'Follow-up'}</ToneChip>
                {money(f.context?.overall_cost) && <ToneChip tone="green" small>Quoted {money(f.context.overall_cost)}</ToneChip>}
                {f.context?.follow_up_time && <ToneChip tone="gray" small>When: {f.context.follow_up_time}</ToneChip>}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{f.status === 'COMPLETE' ? 'Done' : f.emailed_at ? 'Emailed' : 'Not emailed yet'}</span>
              </div>
              {f.context?.follow_up_summary && <div style={{ fontSize: 13, lineHeight: 1.5, fontWeight: 600 }}>{f.context.follow_up_summary}</div>}
              {f.context?.objection_summary && <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)', marginTop: 4 }}>{f.context.objection_summary}</div>}
            </div>
          ))}

          {d?.scorecard?.sections?.length > 0 && (
            <div>
              <div style={{ ...eyebrow, marginBottom: 10 }}>This call’s scorecard · {d.scorecard.scorecard}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {d.scorecard.sections.map(s => (
                  <div key={s.name} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                      <b style={{ fontSize: 13.5 }}>{s.name}</b>
                      {s.weight != null && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{s.weight}% of the score</span>}
                      <span style={{ ...num, marginLeft: 'auto', fontWeight: 800, color: `var(--tone-${fieldTone(s.points)}-tx)` }}>{s.points == null ? '—' : Math.round(s.points)}</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {(s.metrics || []).map(m => <StepBar key={m.name} name={m.name} v={m.points} />)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {d && !d.scorecard && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Siro hasn’t published a step-by-step scorecard for this call{score == null ? ' or a score' : ''} yet.</div>
          )}

          {summary.length > 0 && (
            <div>
              <div style={{ ...eyebrow, marginBottom: 10 }}>Siro’s summary</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {summary.map(s => (
                  <div key={s.name}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 3, color: /strength/i.test(s.name) ? 'var(--tone-green-tx)' : /growth/i.test(s.name) ? 'var(--tone-amber-tx)' : 'var(--text-primary)' }}>{s.name}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{s.content}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function TechCoachingPanel() {
  const isMobile = useIsMobile()
  const [month, setMonth] = useState(nowYm())
  const [trade, setTrade] = useState('all')
  const [view, setView] = useState('coaching')
  const [search, setSearch] = useState('')
  const [snap, setSnap] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [rows, setRows] = useState(null)
  const [rowsErr, setRowsErr] = useState('')
  const [tech, setTech] = useState('')
  const [sort, setSort] = useState('newest')
  const [open, setOpen] = useState(null)

  // Ops managers land on their own trade(s).
  useEffect(() => {
    api('/api/team/field-context').then(c => { if (c?.trades?.length === 1) setTrade(c.trades[0]) }).catch(() => {})
  }, [])

  // Paging months quickly can land responses out of order — keep only the
  // one for the month on screen.
  const monthRef = useRef(month)
  monthRef.current = month
  const loadSnap = async (refresh) => {
    const want = month
    setBusy(true); setErr('')
    try { const d = await api(`/api/team/tech-coaching?month=${want}${refresh ? '&refresh=1' : ''}`); if (monthRef.current === want) setSnap(d) }
    catch (e) { if (monthRef.current === want) setErr(e.message) }
    setBusy(false)
  }
  useEffect(() => { if (view === 'coaching' && snap?.month !== month) { setSnap(null); loadSnap(false) } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, month])
  useEffect(() => {
    if (view !== 'recordings') return
    let dead = false
    setRows(null); setRowsErr('')
    api(`/api/team/tech-recordings?month=${month}`).then(d => { if (!dead) setRows(d.rows || []) }).catch(e => { if (!dead) setRowsErr(e.message) })
    return () => { dead = true }
  }, [view, month])

  const months = []
  for (let ym = nowYm(); ym >= FIRST_MONTH; ym = addYm(ym, -1)) months.push(ym)
  const mi = months.indexOf(month)

  const shownSnap = useMemo(() => {
    if (!snap) return null
    const cards = (snap.cards || []).filter(c => trade === 'all' || c.trade === trade)
    return { ...snap, cards, team: snap.teams?.[trade] || snap.teams?.all }
  }, [snap, trade])

  const q = search.trim().toLowerCase()
  const list = useMemo(() => {
    const r = (rows || []).filter(x => (trade === 'all' || x.trade === trade) && (!tech || x.st_tech_id === tech)
      && (!q || [x.customer_name, x.tech_name, x.job_number, x.line].some(v => String(v || '').toLowerCase().includes(q))))
    const when = (x) => Date.parse(x.recorded_at)
    return [...r].sort((a, b) => sort === 'lowest' ? ((a.evaluation_score ?? 999) - (b.evaluation_score ?? 999)) || when(b) - when(a)
      : sort === 'highest' ? ((b.evaluation_score ?? -1) - (a.evaluation_score ?? -1)) || when(b) - when(a)
      : when(b) - when(a))
  }, [rows, trade, tech, q, sort])
  const techOptions = useMemo(() => {
    const m = new Map()
    for (const r of (rows || [])) if (r.st_tech_id && (trade === 'all' || r.trade === trade)) m.set(r.st_tech_id, r.tech_name || 'Unknown')
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [rows, trade])

  const openTech = (c) => { setView('recordings'); setTech(c.id); setSort('lowest'); setSearch('') }
  const synced = snap?.syncedAt ? new Date(snap.syncedAt).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
  const field = (label, child, flex) => (
    <div style={isMobile ? { flex } : undefined}>
      <div style={{ ...eyebrow, marginBottom: 4 }}>{label}</div>
      {child}
    </div>
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {field('Month', <PillNav label={monthName(month)} onPrev={() => setMonth(months[mi + 1])} onNext={() => setMonth(months[mi - 1])}
          prevDisabled={mi < 0 || mi >= months.length - 1} nextDisabled={mi <= 0} />, '1 1 100%')}
        {field('View', <Segmented value={view} onChange={setView} options={[['coaching', 'Coaching'], ['recordings', 'All recordings']]} fill={isMobile} />, '1 1 100%')}
        {field('Trade', <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <Segmented value={trade} onChange={(v) => { setTrade(v); setTech('') }} options={[['all', 'All trades'], ...TRADES.map(t => [t, t])]} />
        </div>, '1 1 100%')}
        {view === 'recordings' && field('Technician', (
          <select className="form-input" value={tech} onChange={e => setTech(e.target.value)} style={{ minWidth: isMobile ? 0 : 170, width: isMobile ? '100%' : undefined }}>
            <option value="">Everyone</option>
            {techOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        ), '1 1 45%')}
        {field('Search', <input className="form-input" value={search} onChange={e => setSearch(e.target.value)}
          placeholder={view === 'coaching' ? 'Find a tech…' : 'Customer, tech, job #…'} style={{ minWidth: isMobile ? 0 : 190, width: isMobile ? '100%' : undefined }} />, '1 1 45%')}
        {view === 'recordings' && field('Sort', <Segmented value={sort} onChange={setSort} fill={isMobile}
          options={[['newest', 'Newest'], ['lowest', 'Lowest score'], ['highest', 'Highest score']]} />, '1 1 100%')}
      </div>

      {view === 'coaching' && snap && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          From Field Pro{synced ? ` · synced ${synced}` : ''}{snap.scorecards ? '' : ' · step-by-step scorecards are still syncing, so cards show each tech’s average call score for now'}
        </div>
      )}

      {view === 'coaching' ? (
        <CoachingSnapshots kind="tech" snap={shownSnap} busy={busy} error={err} search={search} isMobile={isMobile}
          onRegenerate={() => loadSnap(true)} onOpen={openTech} />
      ) : rowsErr ? (
        <div style={{ ...panel, padding: 30, textAlign: 'center', color: 'var(--danger)', fontSize: 13 }}>Couldn’t load recordings: {rowsErr}</div>
      ) : rows === null ? (
        <><div className="skel" style={{ height: 110, borderRadius: 16, marginBottom: 16 }} /><div className="skel" style={{ height: 320, borderRadius: 14 }} /></>
      ) : !list.length ? (
        <div style={{ ...panel, padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          {rows.length ? 'No recordings match these filters.' : `No Field Pro recordings in ${monthName(month)} yet.`}
        </div>
      ) : (
        <>
          {tech && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{techOptions.find(([id]) => id === tech)?.[1] || 'Technician'}</span>
              <button className="btn ghost sm" onClick={() => setTech('')}>Show everyone</button>
            </div>
          )}
          <Summary rows={list} isMobile={isMobile} />
          <RecordingList rows={list} grouped={sort === 'newest'} isMobile={isMobile} onOpen={setOpen} />
        </>
      )}

      {open && <RecordingModal row={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
