// ── Weekly Leadership Agenda — Brandyn's meeting page ───────────────────────
//
// Auto-generated numbers (scorecard, KPIs, leaderboards, marketing, true
// labor) + editable meeting sections (topics, projects, parking lot, wins,
// watch-outs, commitments). Each week is archived server-side; fill-ins
// auto-save. Print uses a visibility trick so only the agenda prints, not the
// app chrome. Server gates access to the leadership viewers list — this page
// simply won't load data for anyone else.

import { useState, useEffect, useRef, useCallback } from 'react'
import { sb } from '../lib/supabase'

const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString()}`
const pct = (n) => (n == null ? '—' : `${Math.round(Number(n) * 100)}%`)

// The standing meeting-opener prompt from the original agenda sheet — shown
// every week unless Brandyn types something else.
const DEFAULT_POSITIVE = 'Everyone shares either personal or professional positive news from last week or the upcoming week'

const S = {
  // The app shell is overflow:hidden — every page owns its scroll.
  scroll: { flex: 1, overflowY: 'auto' },
  page: { maxWidth: 1000, margin: '0 auto', padding: '20px 24px 60px' },
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', margin: 0 },
  sub: { fontSize: 13, color: 'var(--text-secondary)' },
  section: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px 18px', marginTop: 16 },
  sectionTitle: { fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 },
  th: { textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid var(--border)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-muted)', whiteSpace: 'nowrap' },
  td: { textAlign: 'right', padding: '7px 8px', borderBottom: '1px solid var(--border)', fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap' },
  input: { width: '100%', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' },
  btn: { padding: '7px 14px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  btnPrimary: { padding: '7px 14px', border: '1px solid var(--accent)', borderRadius: 7, background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  good: { color: 'var(--success)', fontWeight: 700 },
  bad: { color: 'var(--danger)', fontWeight: 700 },
  card: { flex: 1, border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', minWidth: 150 },
  cardLabel: { fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--text-muted)' },
  cardValue: { fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', marginTop: 3 },
  cardSub: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 },
}

function Card({ label, value, sub, tone }) {
  return (
    <div style={S.card}>
      <div style={S.cardLabel}>{label}</div>
      <div style={{ ...S.cardValue, ...(tone === 'good' ? { color: 'var(--success)' } : tone === 'bad' ? { color: 'var(--danger)' } : {}) }}>{value}</div>
      {sub && <div style={S.cardSub}>{sub}</div>}
    </div>
  )
}

function Table({ headers, rows }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{headers.map((h, i) => <th key={i} style={{ ...S.th, textAlign: i ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, ri) => (
          <tr key={ri}>{r.map((c, ci) => <td key={ci} style={{ ...S.td, textAlign: ci ? 'right' : 'left', ...(ci === 0 ? { fontWeight: 600 } : {}) }}>{c}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  )
}

// Editable list of objects with fixed columns; used for topics / projects /
// parking lot. Always shows one blank row at the end for adding.
function EditRows({ rows, cols, onChange }) {
  const items = [...(rows || [])]
  const blank = Object.fromEntries(cols.map(c => [c.key, '']))
  const display = [...items, { ...blank }]
  const set = (i, key, val) => {
    const next = display.map((r, ri) => ri === i ? { ...r, [key]: val } : r)
    onChange(next.filter(r => cols.some(c => String(r[c.key] || '').trim())))
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{cols.map(c => <th key={c.key} style={{ ...S.th, textAlign: 'left', width: c.width }}>{c.label}</th>)}</tr></thead>
        <tbody>{display.map((r, ri) => (
          <tr key={ri}>{cols.map(c => (
            <td key={c.key} style={{ padding: '3px 4px', borderBottom: '1px solid var(--border)' }}>
              <input style={S.input} value={r[c.key] || ''} placeholder={ri === display.length - 1 ? c.placeholder || '' : ''}
                onChange={e => set(ri, c.key, e.target.value)} />
            </td>
          ))}</tr>
        ))}</tbody>
      </table>
    </div>
  )
}

// Editable bullet list (wins / watch-outs / commitments).
function EditList({ items, onChange, mark }) {
  const display = [...(items || []), '']
  const set = (i, val) => {
    const next = display.map((x, xi) => xi === i ? val : x)
    onChange(next.filter(x => String(x).trim()))
  }
  return (
    <div>
      {display.map((x, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ color: 'var(--text-muted)', width: 14 }}>{mark}</span>
          <input style={S.input} value={x} placeholder={i === display.length - 1 ? 'Add…' : ''} onChange={e => set(i, e.target.value)} />
        </div>
      ))}
    </div>
  )
}

export default function LeadershipPage() {
  const [weeks, setWeeks] = useState([])
  const [week, setWeek] = useState(null)
  const [currentWeek, setCurrentWeek] = useState(null)
  const [migrationPending, setMigrationPending] = useState(false)
  const retriedRef = useRef({})
  const [report, setReport] = useState(null)
  const [notes, setNotes] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState('')       // '', 'saving', 'saved'
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const saveTimer = useRef(null)
  const notesRef = useRef(notes)
  notesRef.current = notes

  const authHeaders = useCallback(async () => {
    const { data: { session } } = await sb.auth.getSession()
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` }
  }, [])

  useEffect(() => {
    authHeaders()
      .then(h => fetch('/api/admin/leadership/weeks', { headers: h }))
      .then(r => r.json())
      .then(d => {
        const latest = d.latestCompleted
        // The in-progress week is selectable too — its data reads "through today".
        const list = [...new Set([d.current, latest, ...(d.weeks || [])])].filter(Boolean).sort().reverse()
        setWeeks(list)
        setCurrentWeek(d.current || null)
        setMigrationPending(!!d.migrationPending)
        setWeek(w => w || latest)
      })
      .catch(() => setError('Could not load weeks'))
  }, [authHeaders])

  const load = useCallback((wk, refresh) => {
    if (!wk) return
    setLoading(true); setError('')
    authHeaders()
      .then(h => fetch(`/api/admin/leadership/report?week=${wk}${refresh ? '&refresh=1' : ''}`, { headers: h }))
      .then(async r => { if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`); return r.json() })
      .then(d => {
        // A saved snapshot of an in-progress week goes stale by the next day —
        // regenerate instead of showing Tuesday's numbers on Friday.
        const todayDenver = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())
        if (!refresh && d.saved && d.facts?.partial && d.facts.asOf < todayDenver) { load(wk, true); return }
        retriedRef.current[wk] = 0
        setReport(d); setNotes(d.notes || {})
      })
      .catch(e => {
        // NEVER leave another week's numbers on screen under this week's label —
        // clear, then retry once (the server kept generating; retry is instant).
        setReport(null)
        if ((retriedRef.current[wk] || 0) < 1) {
          retriedRef.current[wk] = 1
          setError('First try timed out — the server is still building it, retrying…')
          setTimeout(() => load(wk), 10000)
        } else {
          setError(`${e.message} — hit Refresh numbers to try again`)
        }
      })
      .finally(() => setLoading(false))
  }, [authHeaders])

  useEffect(() => { load(week) }, [week, load])

  // Debounced auto-save of fill-ins.
  const patchNotes = (patch) => {
    const next = { ...notesRef.current, ...patch }
    setNotes(next)
    setSaving('saving')
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      authHeaders()
        .then(h => fetch('/api/admin/leadership/notes', {
          method: 'POST', headers: h,
          body: JSON.stringify({ week, notes: notesRef.current }),
        }))
        .then(r => r.json())
        .then(d => setSaving(d.ok ? 'saved' : 'error'))
        .catch(() => setSaving('error'))
    }, 1200)
  }

  const emailIt = () => {
    setBusy('email')
    authHeaders()
      .then(h => fetch('/api/admin/leadership/email', { method: 'POST', headers: h, body: JSON.stringify({ week }) }))
      .then(async r => { const d = await r.json(); if (!r.ok || !d.ok) throw new Error(d.error || 'send failed'); alert(`Sent to ${d.sent}`) })
      .catch(e => alert(`Email failed: ${e.message}`))
      .finally(() => setBusy(''))
  }

  const f = report?.facts
  const ai = report?.ai
  const weekLabel = f ? `${f.weekStart} → ${f.weekEnd}` : week

  return (
    <div style={S.scroll}>
    <div style={S.page}>
      <style>{`
        @media print {
          /* The app shell is 100vh + overflow:hidden, which clips printing to
             one page — undo all of that for print only. */
          html, body, body * { overflow: visible !important; height: auto !important; max-height: none !important; }
          body * { visibility: hidden !important; }
          #leadership-print, #leadership-print * { visibility: visible !important; }
          #leadership-print { position: absolute; top: 0; left: 0; width: 100%; }
          #leadership-print input, #leadership-print textarea { border: none !important; background: transparent !important; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <div style={{ flex: 1 }}>
          <h1 style={S.h1}>Weekly Leadership Agenda</h1>
          <div style={S.sub}>Week ending&nbsp;
            <select value={week || ''} onChange={e => setWeek(e.target.value)}
              style={{ ...S.input, width: 'auto', display: 'inline-block', padding: '3px 6px' }}>
              {weeks.map(w => <option key={w} value={w}>{w}{w === currentWeek ? ' — this week (in progress)' : ''}</option>)}
            </select>
            {report?.facts?.partial && (
              <span style={{ marginLeft: 10, fontSize: 11.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                background: 'var(--tone-amber-bg)', border: '1px solid var(--tone-amber-bd)', color: 'var(--tone-amber-tx)' }}>
                data through {report.facts.asOf}
              </span>
            )}
            {saving === 'saving' && <span style={{ marginLeft: 10, color: 'var(--text-muted)', fontSize: 12 }}>Saving…</span>}
            {saving === 'saved' && <span style={{ marginLeft: 10, color: 'var(--success)', fontSize: 12 }}>Saved ✓</span>}
            {saving === 'error' && <span style={{ marginLeft: 10, color: 'var(--danger)', fontSize: 12 }}>Save failed (migration pending?)</span>}
          </div>
        </div>
        <button style={S.btn} disabled={loading} onClick={() => load(week, true)}>↻ Refresh numbers</button>
        <button style={S.btn} onClick={() => window.print()}>🖨 Print</button>
        <button style={S.btnPrimary} disabled={busy === 'email'} onClick={emailIt}>{busy === 'email' ? 'Sending…' : '✉ Email it'}</button>
      </div>

      {migrationPending && (
        <div className="no-print" style={{ ...S.section, borderColor: 'var(--tone-amber-bd)', background: 'var(--tone-amber-bg)', color: 'var(--tone-amber-tx)', fontSize: 13 }}>
          <b>Archive not enabled yet:</b> the <code>leadership_reports</code> table hasn't been created in Supabase, so nothing saves — every visit
          rebuilds from scratch (~1 min) and fill-ins are lost. Run the SQL block from SUPABASE_SETUP.sql (bottom) in the Supabase SQL editor.
        </div>
      )}
      {error && <div style={{ ...S.section, borderColor: 'var(--danger)', color: 'var(--danger)' }}>{error}</div>}
      {loading && <div style={{ ...S.section, color: 'var(--text-secondary)' }}>Building W/E {week} from ServiceTitan + Andi — 20–60s on a fresh pull…</div>}

      {f && !loading && (
        <div id="leadership-print">
          <div style={{ display: 'none' }} className="print-only">
            <h1 style={S.h1}>Weekly Leadership Agenda — {weekLabel}</h1>
          </div>

          {/* Self-identifying: which window these numbers actually cover */}
          <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 6px' }}>
            Numbers cover <b>{f.weekStart} → {f.weekEnd}</b>{f.asOf && f.asOf !== f.weekEnd ? <> · data through <b>{f.asOf}</b></> : null}
            {f.mtd?.dayOfMonth != null ? <> · MTD/YTD as of day {f.mtd.dayOfMonth} of {f.mtd.daysInMonth}</> : null}
          </div>

          {/* Meeting openers */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Quote · Ice breaker · Positive news</div>
            <div style={{ display: 'grid', gap: 8 }}>
              <input style={S.input} placeholder="Quote of the day…" value={notes.quote || ''} onChange={e => patchNotes({ quote: e.target.value })} />
              <input style={S.input} placeholder="Ice breaker…" value={notes.icebreaker || ''} onChange={e => patchNotes({ icebreaker: e.target.value })} />
              <input style={S.input} placeholder="Positive news prompt…" value={notes.positive ?? DEFAULT_POSITIVE} onChange={e => patchNotes({ positive: e.target.value })} />
            </div>
          </div>

          {/* Headline cards */}
          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <Card label="Wk Sales" value={money(f.totals.sales)}
              sub={`goal ${money(f.totals.salesGoal)}${f.compare?.yoyWeek?.salesDelta != null ? ` · YoY ${f.compare.yoyWeek.salesDelta >= 0 ? '+' : ''}${pct(f.compare.yoyWeek.salesDelta)}` : ''}`}
              tone={f.totals.hitGoal ? 'good' : 'bad'} />
            <Card label="Wk Revenue" value={money(f.totals.revenue)}
              sub={`${money(f.totals.unpaid)} uncollected${f.compare?.yoyWeek?.revenueDelta != null ? ` · YoY ${f.compare.yoyWeek.revenueDelta >= 0 ? '+' : ''}${pct(f.compare.yoyWeek.revenueDelta)}` : ''}`} />
            <Card label="Close Rate" value={pct(f.totals.closeRate)} sub={`${f.totals.opps} opportunities`} />
            <Card label="Booking %" value={pct(f.totals.booking.rate)} sub={`${f.totals.booking.total} lead calls`} />
          </div>

          {/* Pacing vs budgets — budgets editable, carried forward week to week */}
          {(() => {
            const b = notes.budgets || {}
            const mSales = Number(b.monthSales) || f.mtd.salesTarget
            const mRev = Number(b.monthRevenue) || f.mtd.target
            const ySales = Number(b.yearSales) || f.ytd?.target
            const mFrac = f.mtd.dayOfMonth / f.mtd.daysInMonth
            const yFrac = f.ytd ? f.ytd.dayOfYear / f.ytd.daysInYear : 0
            const mSalesPace = Math.round(mSales * mFrac), mRevPace = Math.round(mRev * mFrac)
            const ySalesPace = Math.round((ySales || 0) * yFrac)
            const budgetInput = (key, val, ph) => (
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                {ph}
                <input style={{ ...S.input, width: 110 }} inputMode="numeric" placeholder="$"
                  value={b[key] ?? ''}
                  onChange={e => patchNotes({ budgets: { ...b, [key]: e.target.value.replace(/[^0-9]/g, '') } })} />
              </label>
            )
            return (
              <div style={S.section}>
                <div style={S.sectionTitle}>Sales & revenue pacing</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <Card label="MTD Sales" value={money(f.mtd.sales)}
                    sub={`budget ${money(mSales)} · pace ${money(mSalesPace)} · proj ${money(f.mtd.salesProjected)}`}
                    tone={f.mtd.sales >= mSalesPace ? 'good' : 'bad'} />
                  <Card label="MTD Revenue" value={money(f.mtd.revenue)}
                    sub={`budget ${money(mRev)} · pace ${money(mRevPace)} · proj ${money(f.mtd.projected)}${f.compare?.priorMonthMtd?.revenueDelta != null ? ` · MoM ${f.compare.priorMonthMtd.revenueDelta >= 0 ? '+' : ''}${pct(f.compare.priorMonthMtd.revenueDelta)}` : ''}`}
                    tone={f.mtd.revenue >= mRevPace ? 'good' : 'bad'} />
                  {f.ytd && <Card label="YTD Sales" value={money(f.ytd.sales)}
                    sub={`target ${money(ySales)} · pace ${money(ySalesPace)} · proj ${money(f.ytd.projected)}`}
                    tone={f.ytd.sales >= ySalesPace ? 'good' : 'bad'} />}
                </div>
                <div className="no-print" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
                  {budgetInput('monthSales', b.monthSales, 'Month sales budget')}
                  {budgetInput('monthRevenue', b.monthRevenue, 'Month revenue budget')}
                  {budgetInput('yearSales', b.yearSales, 'Annual sales target')}
                </div>
              </div>
            )
          })()}

          {/* AI read — a 60-second scan: headline, top highlights, actions by dept */}
          {ai && (
            <div style={{ ...S.section, borderLeft: '4px solid var(--accent)' }}>
              {ai.headline && <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 10 }}>{ai.headline}</div>}
              {(ai.highlights || ai.summary || []).length > 0 && <>
                <div style={S.sectionTitle}>Top highlights</div>
                {(ai.highlights || ai.summary).map((s, i) => (
                  <div key={i} style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-primary)' }}>• {s}</div>
                ))}
              </>}
              {(ai.actionsByDept || []).length > 0 && <>
                <div style={{ ...S.sectionTitle, marginTop: 14 }}>Action items by department</div>
                {/* Column flow (not grid): blocks pack top-to-bottom so a short
                    department never gets stranded next to a tall one. */}
                <div style={{ columns: '2 300px', columnGap: 24 }}>
                  {ai.actionsByDept.map((d, i) => (
                    <div key={i} style={{ breakInside: 'avoid', marginBottom: 12 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--accent)' }}>{d.dept}</div>
                      {(d.actions || []).map((a, j) => (
                        <div key={j} style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-primary)', paddingLeft: 10 }}>→ {a}</div>
                      ))}
                    </div>
                  ))}
                </div>
              </>}
              {!(ai.actionsByDept || []).length && (ai.actionItems || []).length > 0 && <>
                <div style={{ ...S.sectionTitle, marginTop: 12 }}>Action items</div>
                {ai.actionItems.map((a, i) => (
                  <div key={i} style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-primary)' }}>
                    → {a.action} {a.owner && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>({a.owner})</span>}
                  </div>
                ))}
              </>}
            </div>
          )}

          {/* Department scorecard */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Department scorecard</div>
            <Table
              headers={['Dept', 'Wk Sales', 'Budget', 'Var', 'Wk Rev', 'Rev Tgt', 'Close / Tgt', 'Avg Sale', 'Opps', 'Missed $', 'Callbacks', 'True Labor %']}
              rows={[
                ...f.scorecard.map(d => [
                  d.trade, money(d.sales), money(d.budget),
                  <span style={d.variance >= 0 ? S.good : S.bad}>{d.variance >= 0 ? '+' : ''}{money(d.variance)}</span>,
                  money(d.revenue), money(d.revTarget),
                  d.closeRate != null ? `${pct(d.closeRate)} / ${pct(d.convTarget)}` : '—',
                  d.avgSale != null ? money(d.avgSale) : '—',
                  String(d.opps),
                  d.missedSales ? <span style={S.bad}>{money(d.missedSales)}</span> : '—',
                  d.callbacks ? <span style={{ color: 'var(--warning)', fontWeight: 700 }}>{d.callbacks}</span> : '0',
                  d.trueLaborPct != null
                    ? <span style={d.trueLaborPct <= (d.laborTarget || 0.25) ? S.good : S.bad}>{pct(d.trueLaborPct)}</span>
                    : '—',
                ]),
                [
                  <b>AWESOME</b>, <b>{money(f.totals.sales)}</b>, <b>{money(f.scorecard.reduce((a, d) => a + d.budget, 0))}</b>,
                  (() => { const v = f.totals.sales - f.scorecard.reduce((a, d) => a + d.budget, 0); return <span style={v >= 0 ? S.good : S.bad}>{v >= 0 ? '+' : ''}{money(v)}</span> })(),
                  <b>{money(f.totals.revenue)}</b>, <b>{money(f.scorecard.reduce((a, d) => a + d.revTarget, 0))}</b>,
                  pct(f.totals.closeRate), '—', <b>{String(f.totals.opps)}</b>,
                  money(f.scorecard.reduce((a, d) => a + (d.missedSales || 0), 0)),
                  <b>{String(f.scorecard.reduce((a, d) => a + (d.callbacks || 0), 0))}</b>,
                  pct(f.labor.laborPctOfRevenue),
                ],
              ]}
            />
          </div>

          {/* KPIs + opportunities side-by-side feel */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Company KPIs — week over week</div>
            <Table headers={['KPI', 'This Wk', 'Last Wk', 'Δ', 'Goal']}
              rows={f.kpis.map(k => {
                const fmtV = (v) => v == null ? '—' : (k.fmt === 'pct' ? pct(v) : String(v))
                const d = (k.thisWk != null && k.lastWk != null) ? k.thisWk - k.lastWk : null
                return [
                  k.kpi, fmtV(k.thisWk), fmtV(k.lastWk),
                  d == null ? '—' : <span style={d >= 0 ? S.good : S.bad}>{d >= 0 ? '+' : ''}{k.fmt === 'pct' ? `${Math.round(d * 100)}pt` : Math.round(d)}</span>,
                  k.goal == null ? '—' : `${fmtV(k.goal)} ${k.thisWk != null ? (k.thisWk >= k.goal ? '✓' : '✗') : ''}`,
                ]
              })}
            />
          </div>

          <div style={S.section}>
            <div style={S.sectionTitle}>Opportunities — ran vs needed to hit budget</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
              "Needed" = budget ÷ (actual close rate × actual avg sale). Short of needed = lead-flow problem; had them and missed = conversion problem.
            </div>
            <Table headers={['Dept', 'Ran', 'Needed', 'Diff', 'Verdict']}
              rows={f.scorecard.map(d => [
                d.trade, String(d.opps), d.oppsNeeded != null ? String(d.oppsNeeded) : '—',
                d.oppsNeeded != null ? <span style={d.opps >= d.oppsNeeded ? S.good : S.bad}>{d.opps >= d.oppsNeeded ? '+' : ''}{d.opps - d.oppsNeeded}</span> : '—',
                d.oppsNeeded == null ? '—' : d.opps >= d.oppsNeeded
                  ? (d.sales >= d.budget ? <span style={S.good}>hit it</span> : <span style={S.bad}>had the opps — conversion</span>)
                  : <span style={S.bad}>lead-flow gap</span>,
              ])}
            />
          </div>

          {/* True labor */}
          <div style={S.section}>
            <div style={S.sectionTitle}>True labor (ADP-burdened)</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Card label="Field labor (true)" value={money(f.labor.estFieldBurdened)} sub={`${money(f.labor.impliedCommissions)} commissions + pool + burden`} />
              <Card label="Office labor" value={money(f.labor.officeWeeklyCost)} sub="burdened weekly baseline" />
              <Card label="All-in labor %" value={pct(f.labor.laborPctOfRevenue)} sub="of week revenue" tone={f.labor.laborPctOfRevenue <= 0.36 ? 'good' : 'bad'} />
              <Card label="Hidden pool" value={money(f.labor.hiddenPool)} sub="field pay not tied to a job" />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Actual ADP field gross this week (optional override):</span>
              <input style={{ ...S.input, width: 140 }} placeholder="$" value={notes.fieldPayrollActual || ''}
                onChange={e => patchNotes({ fieldPayrollActual: e.target.value.replace(/[^0-9.]/g, '') })} />
              {notes.fieldPayrollActual && f.labor.estFieldGross > 0 && (
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  model said {money(f.labor.estFieldGross)} → {Math.abs(Number(notes.fieldPayrollActual) - f.labor.estFieldGross) / f.labor.estFieldGross <= 0.1 ? 'within 10% ✓' : 'model drift — worth a look'}
                </span>
              )}
            </div>
          </div>

          {/* Leaderboards — top 3 + lowest per department, not the whole roster */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Technicians — top 3 + lowest per department · composite: revenue 40 · close 30 · $/opp 30</div>
            {['HVAC', 'Plumbing', 'Electrical', 'Garage Doors'].map(trade => {
              const scored = f.technicians.filter(t => t.score != null && t.trade === trade)
              if (!scored.length) return null
              const top = scored.slice(0, 3)
              const lowest = scored.length > 3 ? scored[scored.length - 1] : null
              const row = (t, isLow) => [
                isLow ? <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{t.name}</span> : t.name,
                String(t.score), money(t.soldAmount),
                t.closeRate != null ? pct(t.closeRate) : '—',
                t.dollarsPerOpp != null ? money(t.dollarsPerOpp) : '—',
                String(t.jobsRan),
                t.callbacks ? <span style={{ color: 'var(--warning)', fontWeight: 700 }}>{t.callbacks}</span> : '0',
              ]
              return (
                <div key={trade} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--accent)', marginBottom: 4 }}>{trade}</div>
                  <Table headers={['Tech', 'Score', 'Sold', 'Close', '$/Opp', 'Jobs', 'Callbacks']}
                    rows={[...top.map(t => row(t, false)), ...(lowest ? [row(lowest, true)] : [])]} />
                </div>
              )
            })}
            {f.technicians.some(t => t.score != null && !t.trade) && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                Unassigned to a department: {f.technicians.filter(t => t.score != null && !t.trade).map(t => t.name).join(', ')}
              </div>
            )}
            {f.callbacks.total > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
                {f.callbacks.total} callback/warranty jobs this week: {Object.entries(f.callbacks.byType).map(([n, c]) => `${n} (${c})`).join(' · ')}
              </div>
            )}
          </div>

          <div style={S.section}>
            <div style={S.sectionTitle}>CSRs — top 3 + lowest · from ServiceTitan · composite: booked 40 · book rate 30 · QA 30</div>
            {(() => {
              const scored = f.csrs.filter(c => c.score != null)
              const top = scored.slice(0, 3)
              const lowest = scored.length > 3 ? scored[scored.length - 1] : null
              const row = (c, isLow) => [
                isLow ? <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{c.name}</span> : c.name,
                String(c.score), String(c.booked), String(c.answered),
                c.bookRate != null ? pct(c.bookRate) : '—', c.qa != null ? `${c.qa}%` : '—',
              ]
              return <Table headers={['CSR', 'Score', 'Booked', 'Lead calls', 'Book rate', 'QA (Andi)']}
                rows={[...top.map(c => row(c, false)), ...(lowest ? [row(lowest, true)] : [])]} />
            })()}
          </div>

          {/* Marketing */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Marketing channels (lead calls)</div>
            <Table headers={['Channel', 'Calls', 'Booked', 'Rate', 'vs last wk']}
              rows={f.marketing.map(m => [
                m.name, String(m.calls), String(m.booked), pct(m.rate),
                m.deltaCalls === 0 ? '—' : <span style={m.deltaCalls > 0 ? S.good : S.bad}>{m.deltaCalls > 0 ? '+' : ''}{m.deltaCalls}</span>,
              ])}
            />
          </div>

          {/* 6-week trend */}
          <div style={S.section}>
            <div style={S.sectionTitle}>6-week sales trend</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 120, padding: '0 4px' }}>
              {f.trend.map((t, i) => {
                const max = Math.max(...f.trend.map(x => x.sales), t.goal)
                return (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{money(t.sales)}</div>
                    <div style={{
                      width: '70%', height: Math.max(6, 90 * t.sales / max),
                      background: t.hit ? 'var(--success)' : 'var(--danger)', borderRadius: 4, opacity: i === f.trend.length - 1 ? 1 : 0.65,
                    }} />
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t.weekEnd.slice(5)}</div>
                  </div>
                )
              })}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Weekly sales goal {money(f.trend[0]?.goal || 0)} — green = hit.</div>
          </div>

          {/* Editable meeting sections */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Discussion topics</div>
            <EditRows rows={notes.topics} onChange={v => patchNotes({ topics: v })}
              cols={[
                { key: 'topic', label: 'Topic', placeholder: 'Add a topic…' },
                { key: 'owner', label: 'Owner', width: 160 },
              ]} />
          </div>

          <div style={S.section}>
            <div style={S.sectionTitle}>Ongoing projects (carry forward week to week)</div>
            <EditRows rows={notes.projects} onChange={v => patchNotes({ projects: v })}
              cols={[
                { key: 'project', label: 'Project', placeholder: 'Add a project…' },
                { key: 'owner', label: 'Owner', width: 130 },
                { key: 'status', label: 'Status', width: 110 },
                { key: 'target', label: 'Target', width: 110 },
                { key: 'notes', label: 'Notes' },
              ]} />
          </div>

          <div style={S.section}>
            <div style={S.sectionTitle}>Parking lot</div>
            <EditRows rows={notes.parkingLot} onChange={v => patchNotes({ parkingLot: v })}
              cols={[
                { key: 'item', label: 'Item', placeholder: 'Capture it, keep the meeting moving…' },
                { key: 'raisedBy', label: 'Raised by', width: 120 },
                { key: 'owner', label: 'Owner', width: 120 },
                { key: 'next', label: 'Next step', width: 200 },
              ]} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginTop: 16 }}>
            <div style={{ ...S.section, marginTop: 0 }}>
              <div style={S.sectionTitle}>Wins this week</div>
              <EditList items={notes.wins} mark="✓" onChange={v => patchNotes({ wins: v })} />
            </div>
            <div style={{ ...S.section, marginTop: 0 }}>
              <div style={S.sectionTitle}>Watch-outs / risks</div>
              <EditList items={notes.watchouts} mark="⚠" onChange={v => patchNotes({ watchouts: v })} />
            </div>
            <div style={{ ...S.section, marginTop: 0 }}>
              <div style={S.sectionTitle}>Commitments for next week</div>
              <EditList items={notes.commitments} mark="☐" onChange={v => patchNotes({ commitments: v })} />
            </div>
          </div>

          <div style={S.section}>
            <div style={S.sectionTitle}>Notes & key takeaways</div>
            <textarea style={{ ...S.input, minHeight: 90, resize: 'vertical' }} value={notes.notesText || ''}
              placeholder="Meeting notes…" onChange={e => patchNotes({ notesText: e.target.value })} />
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 18, lineHeight: 1.6 }}>
            Sales = estimates marked Sold · Revenue = invoiced subtotals · Opportunities = jobs with an estimate presented ·
            Booking % excludes Excused / NotLead / Abandoned · True labor uses the ADP TotalSource burden model (field ×{f.labor.factors.fieldBurden}, pool ×{f.labor.factors.poolUplift}) ·
            Generated {new Date(f.generatedAt).toLocaleString()}
          </div>
        </div>
      )}
    </div>
    </div>
  )
}
