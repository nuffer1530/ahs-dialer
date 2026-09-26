// ── Weekly Leadership Agenda — Brandyn's meeting page ───────────────────────
//
// Auto-generated numbers (scorecard, KPIs, leaderboards, marketing, true
// labor) + editable meeting sections (topics, projects, parking lot, wins,
// watch-outs, commitments). Each week is archived server-side; fill-ins
// auto-save. Print uses a visibility trick so only the agenda prints, not the
// app chrome. Server gates access to the leadership viewers list — this page
// simply won't load data for anyone else.

import { useState, useEffect, useRef, useCallback, Component } from 'react'
import { sb } from '../lib/supabase'
import { confirmDlg } from '../lib/dialogs'
import { useIsMobile } from '../lib/useIsMobile'
import { PageTabs, ToneChip, eyebrow, num, panel } from '../components/ui'

const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString()}`
const pct = (n) => (n == null ? '—' : `${Math.round(Number(n) * 100)}%`)

// The standing meeting-opener prompt from the original agenda sheet — shown
// every week unless Brandyn types something else.
const DEFAULT_POSITIVE = 'Everyone shares either personal or professional positive news from last week or the upcoming week'

// Screen look = the app-wide kit (16px panels, eyebrow labels, tone tokens,
// tabular numbers). The printed agenda keeps its own tuned compact look: every
// printed element restyled here carries an lp-* class that the print sheet
// pins back to the pre-restyle print values (see "Restyle pins" in the page).
const S = {
  // The app shell is overflow:hidden — every page owns its scroll.
  scroll: { flex: 1, overflowY: 'auto' },
  page: { maxWidth: 1280, margin: '0 auto', padding: '24px 24px 60px' },
  // Print-only agenda title (the print sheet sizes it) — the screen title is `title`.
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', margin: 0 },
  title: { fontSize: 22, fontWeight: 800, letterSpacing: '-.02em', lineHeight: 1.2, color: 'var(--text-primary)', margin: 0 },
  sub: { fontSize: 13, color: 'var(--text-secondary)' },
  section: { ...panel, padding: '16px 20px', marginTop: 16 },
  sectionTitle: { ...eyebrow, marginBottom: 12 },
  th: { ...eyebrow, textAlign: 'right', padding: '8px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' },
  td: { ...num, textAlign: 'right', padding: '8px 8px', borderBottom: '1px solid var(--border)', fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap' },
  // Paired with className="form-input" (border, radius, focus ring); this keeps the rows dense.
  input: { padding: '6px 10px' },
  good: { color: 'var(--tone-green-tx)', fontWeight: 700 },
  warn: { color: 'var(--tone-amber-tx)', fontWeight: 700 },
  bad: { color: 'var(--tone-red-tx)', fontWeight: 700 },
  // Stat strip: zones split by hairlines — the 1px gaps let the border color
  // show through, so it works as one row on desktop and two-up on a phone.
  strip: { display: 'flex', flexWrap: 'wrap', gap: 1, background: 'var(--border)' },
}
const TONE = { good: 'green', warn: 'amber', bad: 'red' }

// Section heading — the eyebrow label. lp-title is its print hook.
const Title = ({ children, style }) => <div className="lp-title" style={{ ...S.sectionTitle, ...style }}>{children}</div>

// Phone reading order for the report's top-level blocks: numbers first, the
// AI read, then the rosters, with the fill-in sections last. Applied as flex
// `order` under isMobile only — DOM and print order never change.
const MOBILE_ORDER = { cover: 0, cards: 1, ai: 2, scorecard: 3, techs: 4, csrs: 5, labor: 6, pacing: 7, kpis: 8, opps: 9, trend: 10, openers: 11, topics: 12, rocks: 13, parking: 14, lists: 15, notes: 16, footer: 17 }

// Green = goal hit · yellow = within 90% · red = clearly missed.
const goalTone = (val, goal) => {
  if (val == null || !goal) return {}
  return val >= goal ? S.good : val >= goal * 0.9 ? S.warn : S.bad
}
const goalToneName = (val, goal) => {
  if (val == null || !goal) return undefined
  return val >= goal ? 'good' : val >= goal * 0.9 ? 'warn' : 'bad'
}

// One zone of a stat strip (S.strip). `style` and `big` are phone-only knobs
// (two-up widths, a larger headline number) — desktop callers pass neither.
// minWidth 150 is also a print hook: print turns zones back into boxed cards.
function Card({ label, value, sub, tone, style, big }) {
  const isMobile = useIsMobile()
  return (
    <div className="lp-card" style={{ flex: 1, minWidth: 150, padding: isMobile ? '14px 14px' : '16px 20px', background: 'var(--surface)', ...style }}>
      <div className="lp-card-label" style={eyebrow}>{label}</div>
      <div className="lp-card-value" style={{ ...num, fontSize: big ? 32 : isMobile ? 22 : 26, fontWeight: 800, letterSpacing: '-.02em', lineHeight: 1.15, marginTop: 6,
        color: TONE[tone] ? `var(--tone-${TONE[tone]}-tx)` : 'var(--text-primary)' }}>{value}</div>
      {sub && <div className="lp-card-sub" style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function Table({ headers, rows }) {
  // The wrapper scrolls sideways on any screen. On a phone the first column
  // (dept / name) also pins to the left edge (.lp-pin, styled in the page)
  // so a number is never separated from the row it belongs to.
  const isMobile = useIsMobile()
  const pin = isMobile ? 'lp-pin' : undefined
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{headers.map((h, i) => <th key={i} className={i === 0 ? pin : undefined} style={{ ...S.th, textAlign: i ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, ri) => (
          <tr key={ri} className="eval-row">{r.map((c, ci) => <td key={ci} className={ci === 0 ? pin : undefined} style={{ ...S.td, textAlign: ci ? 'right' : 'left', ...(ci === 0 ? { fontWeight: 600 } : {}) }}>{c}</td>)}</tr>
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
  const isMobile = useIsMobile()
  // Phone cell — same select / input the table draws, just not in a table.
  const field = (r, ri, c) => c.options ? (
    <select className="form-input" style={S.input} value={r[c.key] || ''} onChange={e => set(ri, c.key, e.target.value)}>
      <option value=""></option>
      {c.options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  ) : (
    <input className="form-input" style={S.input} value={r[c.key] || ''} placeholder={ri === display.length - 1 ? c.placeholder || '' : ''}
      onChange={e => set(ri, c.key, e.target.value)} />
  )
  return (
    <>
      {isMobile ? (
        // Phone: a five-column table of inputs squeezes to nothing, so each
        // row becomes a labeled stack. Same data, same blank "add" row last
        // (dashed, so it reads as the empty one).
        <div className="no-print" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {display.map((r, ri) => (
            <div key={ri} style={{ border: `1px ${ri === display.length - 1 ? 'dashed' : 'solid'} var(--border)`, borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cols.map(c => (
                <label key={c.key} style={{ ...eyebrow, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {c.label}
                  {field(r, ri, c)}
                </label>
              ))}
            </div>
          ))}
        </div>
      ) : (
      <div style={{ overflowX: 'auto' }} className="no-print">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{cols.map(c => <th key={c.key} style={{ ...S.th, textAlign: 'left', width: c.width }}>{c.label}</th>)}</tr></thead>
          <tbody>{display.map((r, ri) => (
            <tr key={ri}>{cols.map(c => (
              <td key={c.key} style={{ padding: '4px 4px', borderBottom: '1px solid var(--border)' }}>
                {c.options ? (
                  <select className="form-input" style={S.input} value={r[c.key] || ''} onChange={e => set(ri, c.key, e.target.value)}>
                    <option value=""></option>
                    {c.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input className="form-input" style={S.input} value={r[c.key] || ''} placeholder={ri === display.length - 1 ? c.placeholder || '' : ''}
                    onChange={e => set(ri, c.key, e.target.value)} />
                )}
              </td>
            ))}</tr>
          ))}</tbody>
        </table>
      </div>
      )}
      {/* Inputs clip when printed — print a plain static table instead. */}
      {items.length > 0 && (
        <table className="print-only" style={{ display: 'none', width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{cols.map(c => <th key={c.key} style={{ ...S.th, textAlign: 'left', width: c.width }}>{c.label}</th>)}</tr></thead>
          <tbody>{items.map((r, ri) => (
            <tr key={ri}>{cols.map(c => (
              <td key={c.key} style={{ padding: '4px 6px', borderBottom: '1px solid var(--border)', fontSize: 12, verticalAlign: 'top' }}>{r[c.key] || ''}</td>
            ))}</tr>
          ))}</tbody>
        </table>
      )}
    </>
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
    <>
      <div className="no-print">
        {display.map((x, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ color: 'var(--text-muted)', width: 14 }}>{mark}</span>
            <input className="form-input" style={S.input} value={x} placeholder={i === display.length - 1 ? 'Add…' : ''} onChange={e => set(i, e.target.value)} />
          </div>
        ))}
      </div>
      <div className="print-only" style={{ display: 'none' }}>
        {(items || []).map((x, i) => (
          <div key={i} style={{ fontSize: 12.5, lineHeight: 1.7 }}>{mark} {x}</div>
        ))}
      </div>
    </>
  )
}

// A render error in React 18 unmounts the ENTIRE app — one bad field in a
// generated report must never white-screen all of Andi. This shows the real
// error instead, scoped to this page.
class LeadershipErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error('Leadership render crash:', error, info?.componentStack) }
  render() {
    if (this.state.error) {
      return (
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          <div style={{ ...panel, maxWidth: 700, margin: '40px auto', borderColor: 'var(--tone-red-bd)', padding: '20px 24px' }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--tone-red-tx)', marginBottom: 8 }}>The Leadership page hit an error rendering this report</div>
            <div style={{ fontSize: 13, color: 'var(--text-primary)', fontFamily: 'monospace', whiteSpace: 'pre-wrap', background: 'var(--surface-2)', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
              {String(this.state.error?.message || this.state.error)}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 12 }}>Screenshot this box for Claude — it names the exact field that broke.</div>
            <button className="btn" style={{ borderRadius: 99 }}
              onClick={() => { this.setState({ error: null }) }}>Try again</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function LeadershipPage() {
  return <LeadershipErrorBoundary><LeadershipPageInner /></LeadershipErrorBoundary>
}

function LeadershipPageInner() {
  const [ltab, setLtab] = useState('agenda')
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

  // Phone layout knobs — each one is a no-op (undefined / the desktop value)
  // when isMobile is false, so the desktop render is byte-for-byte the same.
  const isMobile = useIsMobile()
  const mo = (k) => (isMobile ? { order: MOBILE_ORDER[k] } : undefined)
  const sec = isMobile ? { ...S.section, padding: '14px 14px' } : S.section
  const page = isMobile ? { ...S.page, padding: '12px 12px 48px' } : S.page
  const mBtn = isMobile ? { padding: '11px 14px', minHeight: 40 } : undefined   // 40px tap targets
  const half = isMobile ? { flex: '1 1 calc(50% - 5px)' } : undefined          // KPI cards two-up
  const full = isMobile ? { flex: '1 1 100%' } : undefined
  // A stat strip inside a section runs edge to edge (hairline above and below);
  // the headline strip is its own panel. lp-cards is the print hook for both.
  const bleed = { ...S.strip, margin: isMobile ? '0 -14px' : '0 -20px', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }
  const pill = { borderRadius: 99, ...mBtn }

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
        // Default to the newest week: the in-progress one — except on Monday
        // (meeting day), when the agenda under review is last completed week.
        const dowDenver = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Denver' })
        setWeek(w => w || (dowDenver === 'Mon' ? latest : (d.current || latest)))
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

  // Upload the weekly ADP payroll invoice — the file itself declares its week
  // (End Date), so the server may land it on a different week than selected.
  const uploadPayroll = (file) => {
    if (!file) return
    setBusy('payroll')
    const fr = new FileReader()
    fr.onerror = () => { setBusy(''); alert('Could not read that file') }
    fr.onload = () => {
      const dataBase64 = String(fr.result).split(',')[1] || ''
      authHeaders()
        .then(h => fetch('/api/admin/leadership/payroll', { method: 'POST', headers: h, body: JSON.stringify({ dataBase64 }) }))
        .then(async r => { const d = await r.json(); if (!r.ok || !d.ok) throw new Error(d.error || 'upload failed'); return d })
        .then(d => {
          const un = (d.unmatched || []).length
          alert(`Parsed invoice ${d.invoiceNo}: ${d.employees} employees, week ending ${d.weekEnd}.\nField ${'$' + d.totals.field.cost.toLocaleString()} · Office ${'$' + d.totals.office.cost.toLocaleString()}${un ? `\n${un} unmapped employee(s)` : ''}\nRebuilding the report with actuals…`)
          if (d.weekEnd !== week) setWeek(d.weekEnd)
          else load(week, true)
        })
        .catch(e => alert(`Upload failed: ${e.message}`))
        .finally(() => setBusy(''))
    }
    fr.readAsDataURL(file)
  }

  const f = report?.facts
  const ai = report?.ai
  // The AI occasionally returns a string where an array belongs — never let
  // that reach .map() (it white-screened the page once).
  const aiWins = Array.isArray(ai?.wins) ? ai.wins : []
  const aiChallenges = Array.isArray(ai?.challenges) ? ai.challenges : []
  const aiHighlights = (aiWins.length || aiChallenges.length) ? [] : ([ai?.highlights, ai?.summary].map(v => (Array.isArray(v) ? v : [])).find(v => v.length) || [])
  const aiActions = Array.isArray(ai?.actionsByDept) ? ai.actionsByDept.filter(d => d && Array.isArray(d.actions)) : []
  const aiItems = Array.isArray(ai?.actionItems) ? ai.actionItems : []
  const weekLabel = f ? `${f.weekStart} → ${f.weekEnd}` : week

  return (
    <div style={isMobile && ltab === 'brain' ? { ...S.scroll, display: 'flex', flexDirection: 'column' } : S.scroll}>
    {/* The app's page header: full-width surface bar with the kit's page
        tabs, sticky so it survives the agenda's scroll. */}
    <div className="no-print" style={{ position: 'sticky', top: 0, zIndex: 30, background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: isMobile ? '0 12px' : '0 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <PageTabs value={ltab} onChange={setLtab} tabs={[['agenda', 'Weekly Agenda'], ['brain', 'AI Analyst']]} />
    </div>
    {/* Phone + AI tab: the page becomes a flex column so the chat fills the
        space under the tabs instead of sizing itself off the viewport. */}
    <div style={ltab === 'brain'
      ? { ...page, maxWidth: 1200, paddingBottom: 0, ...(isMobile ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : {}) }
      : page}>
      <style>{`
        @media print {
          /* Front and back: portrait Letter, compact spacing, sections flow
             across the page break (only table rows and cards stay whole).
             The old "keep every section whole" rule pushed half-empty pages
             (5 pages for a 2-page agenda). Portrait fits the 15-column
             scorecard once cells wrap. Verified in headless Chrome. */
          @page { size: letter portrait; margin: 7mm 8mm; }
          /* The app shell is 100vh + overflow:hidden, which clips printing to
             one page — undo all of that for print only. */
          html, body, body *:not(#leadership-print *) { overflow: visible !important; height: auto !important; max-height: none !important; }
          body .app-shell, body .app-shell.has-tabbar { height: auto !important; min-height: 0 !important; display: block !important; }
          /* Inside the agenda, inline heights stay (KPI cards, the 6-week bars) — only scroll wrappers un-clip. */
          #leadership-print [style*="overflow-x: auto"] { overflow: visible !important; }
          body { background: #fff !important; }
          body * { visibility: hidden !important; }
          #leadership-print, #leadership-print * { visibility: visible !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          #leadership-print { position: absolute; top: 0; left: 0; width: 100%; font-size: 10px; }
          /* Print in a light palette even if the app is in dark mode. */
          #leadership-print {
            --bg: #fff; --surface: #fff; --surface-2: #f5f5f4; --border: #c8c8c4; --border-strong: #999;
            --text-primary: #111; --text-secondary: #3a3a38; --text-muted: #6a6a66;
            --accent: #1A5C8A; --success: #15803D; --danger: #B91C1C; --warning: #8A5A00;
            --tone-amber-bg: #fff; --tone-amber-bd: #c8c8c4;
            /* Status colors on screen are tone tokens; they print as the old success / warning / danger. */
            --tone-green-tx: #15803D; --tone-amber-tx: #8A5A00; --tone-red-tx: #B91C1C;
          }
          /* Editors are replaced by their static .print-only twins. */
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          table.print-only { display: table !important; }
          /* Compact everything — the screen styles are inline, so these win with !important. */
          #leadership-print > div { break-inside: auto !important; margin-top: 6px !important; padding: 7px 10px !important; border-radius: 6px !important; }
          #leadership-print tr, #leadership-print [style*="min-width: 150px"], #leadership-print [style*="break-inside: avoid"] { break-inside: avoid; }
          #leadership-print [style*="min-width: 150px"] { min-width: 0 !important; padding: 5px 8px !important; border-radius: 6px !important; }
          #leadership-print [style*="flex-wrap: wrap"] { flex-wrap: nowrap !important; gap: 6px !important; }
          #leadership-print h1 { font-size: 15px !important; }
          #leadership-print [style*="font-size: 30px"], #leadership-print [style*="font-size: 22px"] { font-size: 14px !important; margin-top: 1px !important; }
          #leadership-print [style*="font-size: 15px"] { font-size: 11.5px !important; margin-bottom: 4px !important; }
          #leadership-print [style*="font-size: 13px"], #leadership-print [style*="font-size: 12.5px"] { font-size: 9.5px !important; line-height: 1.3 !important; }
          #leadership-print [style*="font-size: 12px"] { font-size: 9px !important; }
          #leadership-print [style*="font-size: 11.5px"], #leadership-print [style*="font-size: 11px"] { font-size: 8.5px !important; }
          #leadership-print [style*="font-size: 10px"] { font-size: 8px !important; }
          #leadership-print [style*="letter-spacing: 1px"] { margin-bottom: 4px !important; }
          #leadership-print [style*="margin-top: 12px"], #leadership-print [style*="margin-top: 14px"], #leadership-print [style*="margin-top: 16px"] { margin-top: 6px !important; }
          #leadership-print [style*="margin-bottom: 12px"] { margin-bottom: 4px !important; }
          #leadership-print [style*="columns: 2"] { column-gap: 14px !important; }
          #leadership-print table { width: 100% !important; table-layout: auto; }
          #leadership-print th, #leadership-print td { white-space: normal !important; font-size: 8.5px !important; padding: 2px 4px !important; line-height: 1.25 !important; }
          #leadership-print .lp-trend { height: 96px !important; }
          /* Restyle pins (Sep 2026): the screen moved to the app-wide kit (eyebrow
             labels, hairline stat strips, tabular numbers). These hold the printed
             agenda at its tuned values — keep them after the rules above. */
          #leadership-print, #leadership-print * { font-variant-numeric: normal !important; }
          #leadership-print .lp-title { font-size: 8.5px !important; font-weight: 800 !important; letter-spacing: 1px !important; margin-bottom: 4px !important; }
          #leadership-print th { font-size: 8px !important; letter-spacing: 0.6px !important; }
          #leadership-print .lp-cards { background: none !important; border: none !important; overflow: visible !important; margin-left: 0 !important; margin-right: 0 !important; }
          #leadership-print .lp-card { border: 1px solid var(--border) !important; background: none !important; }
          #leadership-print .lp-card-label { font-size: 8px !important; letter-spacing: 0.8px !important; }
          #leadership-print .lp-card-value { font-size: 14px !important; margin-top: 1px !important; line-height: 1.5 !important; letter-spacing: normal !important; }
          #leadership-print .lp-card-sub { font-size: 8.5px !important; margin-top: 2px !important; line-height: 1.5 !important; }
        }
      `}</style>
      {/* Phone only: report tables scroll sideways; pin their first column
          (dept / name) to the left edge. The inset shadow stands in for the
          bottom border, which a collapsed table doesn't carry on sticky cells. */}
      {isMobile && <style>{`
        #leadership-print .lp-pin { position: sticky; left: 0; z-index: 1; background: var(--surface); box-shadow: inset 0 -1px 0 var(--border), 1px 0 0 var(--border); }
      `}</style>}


      {ltab === 'brain' && <BrainChat authHeaders={authHeaders} />}

      <div style={ltab === 'agenda' ? undefined : { display: 'none' }}>

      {/* Phone: the title takes the whole first line so the three buttons
          land together on one row beneath it, all 40px tall. */}
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <div style={isMobile ? { flex: '1 1 100%' } : { flex: 1, minWidth: 0 }}>
          <h1 style={S.title}>Weekly Leadership Agenda</h1>
          <div style={{ ...S.sub, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <span>Week ending</span>
            <select className="form-input" value={week || ''} onChange={e => setWeek(e.target.value)}
              style={{ width: 'auto', borderRadius: 99, fontWeight: 600, padding: isMobile ? '10px 14px' : '5px 12px' }}>
              {weeks.map(w => <option key={w} value={w}>{w}{w === currentWeek ? ' — this week (in progress)' : ''}</option>)}
            </select>
            {report?.facts?.partial && <ToneChip tone="amber">data through {report.facts.asOf}</ToneChip>}
            {saving === 'saving' && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Saving…</span>}
            {saving === 'saved' && <span style={{ color: 'var(--tone-green-tx)', fontSize: 12, fontWeight: 600 }}>Saved ✓</span>}
            {saving === 'error' && <span style={{ color: 'var(--tone-red-tx)', fontSize: 12, fontWeight: 600 }}>Save failed (migration pending?)</span>}
          </div>
        </div>
        <button className="btn" style={pill} disabled={loading} onClick={() => load(week, true)}>↻ Refresh numbers</button>
        <button className="btn" style={pill} onClick={() => window.print()}>🖨 Print</button>
        <button className="btn primary" style={pill} disabled={busy === 'email'} onClick={emailIt}>{busy === 'email' ? 'Sending…' : '✉ Email it'}</button>
      </div>

      {migrationPending && (
        <div className="no-print" style={{ ...sec, borderColor: 'var(--tone-amber-bd)', background: 'var(--tone-amber-bg)', color: 'var(--tone-amber-tx)', fontSize: 13 }}>
          <b>Archive not enabled yet:</b> the <code>leadership_reports</code> table hasn't been created in Supabase, so nothing saves — every visit
          rebuilds from scratch (~1 min) and fill-ins are lost. Run the SQL block from SUPABASE_SETUP.sql (bottom) in the Supabase SQL editor.
        </div>
      )}
      {error && <div style={{ ...sec, borderColor: 'var(--tone-red-bd)', background: 'var(--tone-red-bg)', color: 'var(--tone-red-tx)', fontSize: 13 }}>{error}</div>}
      {loading && <>
        <div style={{ ...sec, color: 'var(--text-secondary)', fontSize: 13 }}>Building W/E {week} from ServiceTitan + Andi — 20–60s on a fresh pull…</div>
        <div className="skel" style={{ height: isMobile ? 220 : 104, borderRadius: 16, marginTop: 16 }} />
        <div className="skel" style={{ height: 280, borderRadius: 16, marginTop: 16 }} />
      </>}

      {f && !loading && (
        <div id="leadership-print" style={isMobile ? { display: 'flex', flexDirection: 'column' } : undefined}>
          <div style={{ display: 'none' }} className="print-only">
            <h1 style={S.h1}>Weekly Leadership Agenda — {weekLabel}</h1>
          </div>

          {/* Self-identifying: which window these numbers actually cover */}
          <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 6px', ...mo('cover') }}>
            Numbers cover <b>{f.weekStart} → {f.weekEnd}</b>{f.asOf && f.asOf !== f.weekEnd ? <> · data through <b>{f.asOf}</b></> : null}
            {f.mtd?.dayOfMonth != null ? <> · MTD/YTD as of day {f.mtd.dayOfMonth} of {f.mtd.daysInMonth}</> : null}
          </div>

          {/* Meeting openers */}
          <div style={{ ...sec, ...mo('openers') }}>
            <Title>Quote · Ice breaker · Positive news</Title>
            <div style={{ display: 'grid', gap: 8 }}>
              <div className="no-print" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input className="form-input" placeholder="Quote of the day…" value={notes.quote || ''} onChange={e => patchNotes({ quote: e.target.value })} />
                <input className="form-input" placeholder="Ice breaker…" value={notes.icebreaker || ''} onChange={e => patchNotes({ icebreaker: e.target.value })} />
                <input className="form-input" placeholder="Positive news prompt…" value={notes.positive ?? DEFAULT_POSITIVE} onChange={e => patchNotes({ positive: e.target.value })} />
              </div>
              <div className="print-only" style={{ display: 'none', fontSize: 12.5, lineHeight: 1.7 }}>
                {notes.quote && <div><b>Quote:</b> {notes.quote}</div>}
                {notes.icebreaker && <div><b>Ice breaker:</b> {notes.icebreaker}</div>}
                <div><b>Positive news:</b> {notes.positive ?? DEFAULT_POSITIVE}</div>
              </div>
            </div>
          </div>

          {/* Headline numbers — one panel split into zones (the app's summary
              panel look). On a phone: sales full-width and big, the rest
              two-up, plus a clubs card (the desktop scorecard already shows it). */}
          <div className="lp-cards" style={{ ...panel, ...S.strip, overflow: 'hidden', marginTop: 16, ...mo('cards') }}>
            <Card label="Wk Sales" value={money(f.totals.sales)} style={full} big={isMobile}
              sub={`goal ${money(f.totals.salesGoal)}${f.compare?.yoyWeek?.salesDelta != null ? ` · YoY ${f.compare.yoyWeek.salesDelta >= 0 ? '+' : ''}${pct(f.compare.yoyWeek.salesDelta)}` : ''}`}
              tone={f.totals.hitGoal ? 'good' : 'bad'} />
            <Card label="Wk Revenue" value={money(f.totals.revenue)} style={half}
              sub={`${money(f.totals.unpaid)} uncollected${f.compare?.yoyWeek?.revenueDelta != null ? ` · YoY ${f.compare.yoyWeek.revenueDelta >= 0 ? '+' : ''}${pct(f.compare.yoyWeek.revenueDelta)}` : ''}`} />
            <Card label="Close Rate" value={pct(f.totals.closeRate)} sub={`${f.totals.opps} opportunities`} style={half}
              tone={goalToneName(f.totals.closeRate, f.kpis.find(k => k.kpi === 'Close Rate')?.goal || 0.7)} />
            <Card label="Booking %" value={pct(f.totals.booking.rate)} sub={`${f.totals.booking.total} lead calls`} style={half}
              tone={goalToneName(f.totals.booking.rate, f.kpis.find(k => k.kpi === 'Booking %')?.goal || 0.8)} />
            {isMobile && <Card label="Clubs sold" sub="memberships this week" style={half}
              value={String(f.totals.clubsSold ?? f.scorecard.reduce((a, d) => a + (d.clubs || 0), 0))} />}
          </div>

          {/* Pacing vs budgets — budgets editable, carried forward week to week */}
          {(() => {
            const b = notes.budgets || {}
            const mSales = Number(b.monthSales) || f.mtd.salesTarget
            const mRev = Number(b.monthRevenue) || f.mtd.target
            const ySales = Number(b.yearSales) || f.ytd?.target
            const budgetInput = (key, val, ph) => (
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                {ph}
                <input className="form-input" style={{ ...S.input, ...num, width: 110 }} inputMode="numeric" placeholder="$"
                  value={b[key] ?? ''}
                  onChange={e => patchNotes({ budgets: { ...b, [key]: e.target.value.replace(/[^0-9]/g, '') } })} />
              </label>
            )
            return (
              <div style={{ ...sec, ...mo('pacing') }}>
                <Title>Sales & revenue pacing</Title>
                <div className="lp-cards" style={bleed}>
                  <Card label="MTD Sales" value={money(f.mtd.sales)} style={half}
                    sub={`budget ${money(mSales)} · proj ${money(f.mtd.salesProjected)}`}
                    tone={goalToneName(f.mtd.salesProjected, mSales)} />
                  <Card label="MTD Revenue" value={money(f.mtd.revenue)} style={half}
                    sub={`budget ${money(mRev)} · proj ${money(f.mtd.projected)}`}
                    tone={goalToneName(f.mtd.projected, mRev)} />
                  {f.ytd && <Card label="YTD Sales" value={money(f.ytd.sales)} style={half}
                    sub={`target ${money(ySales)} · proj ${money(f.ytd.projected)}`}
                    tone={goalToneName(f.ytd.projected, ySales)} />}
                </div>
                <div className="no-print" style={{ display: 'flex', gap: isMobile ? 10 : 20, flexWrap: 'wrap', marginTop: 14 }}>
                  {budgetInput('monthSales', b.monthSales, 'Month sales budget')}
                  {budgetInput('monthRevenue', b.monthRevenue, 'Month revenue budget')}
                  {budgetInput('yearSales', b.yearSales, 'Annual sales target')}
                </div>
              </div>
            )
          })()}

          {/* AI read — a 60-second scan: headline, top highlights, actions by dept */}
          {ai && (
            <div style={{ ...sec, borderLeft: '4px solid var(--accent)', ...mo('ai') }}>
              <div className="no-print" style={{ ...eyebrow, color: 'var(--accent)', marginBottom: 8 }}>AI read</div>
              {ai.stale && <div className="no-print" style={{ fontSize: 11.5, color: 'var(--tone-amber-tx)', marginBottom: 6 }}>AI text is from the previous refresh — the AI pass failed this time. Refresh numbers to try again.</div>}
              {ai.headline && <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 10 }}>{ai.headline}</div>}
              {aiWins.length > 0 && <>
                <Title style={{ color: 'var(--tone-green-tx)' }}>Wins</Title>
                {aiWins.map((s, i) => (
                  <div key={i} style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-primary)' }}>✓ {String(s)}</div>
                ))}
              </>}
              {aiChallenges.length > 0 && <>
                <Title style={{ marginTop: 12, color: 'var(--tone-red-tx)' }}>Challenges</Title>
                {aiChallenges.map((s, i) => (
                  <div key={i} style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-primary)' }}>• {String(s)}</div>
                ))}
              </>}
              {aiHighlights.length > 0 && <>
                <Title>Top highlights</Title>
                {aiHighlights.map((s, i) => (
                  <div key={i} style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-primary)' }}>• {String(s)}</div>
                ))}
              </>}
              {aiActions.length > 0 && <>
                <Title style={{ marginTop: 14 }}>Action items by department</Title>
                {/* Column flow (not grid): blocks pack top-to-bottom so a short
                    department never gets stranded next to a tall one. */}
                <div style={{ columns: '2 300px', columnGap: 24 }}>
                  {aiActions.map((d, i) => (
                    <div key={i} style={{ breakInside: 'avoid', marginBottom: 12 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--accent)' }}>{d.dept}</div>
                      {d.actions.map((a, j) => (
                        <div key={j} style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-primary)', paddingLeft: 10 }}>→ {String(a)}</div>
                      ))}
                    </div>
                  ))}
                </div>
              </>}
              {!aiActions.length && aiItems.length > 0 && <>
                <Title style={{ marginTop: 12 }}>Action items</Title>
                {aiItems.map((a, i) => (
                  <div key={i} style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-primary)' }}>
                    → {String(a.action || '')} {a.owner && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>({a.owner})</span>}
                  </div>
                ))}
              </>}
            </div>
          )}

          {/* Department scorecard */}
          <div style={{ ...sec, ...mo('scorecard') }}>
            <Title>Department scorecard</Title>
            <Table
              headers={['Dept', 'Wk Sales', 'Budget', 'Var', 'Wk Rev', 'Rev Tgt', 'Close / Tgt', 'Avg Sale', 'Opps', 'Missed $', '5★', 'Clubs', 'Callbacks', 'GM / Tgt', 'LW True Labor %']}
              rows={[
                ...f.scorecard.map(d => [
                  d.trade, money(d.sales), money(d.budget),
                  <span style={d.variance >= 0 ? S.good : S.bad}>{d.variance >= 0 ? '+' : ''}{money(d.variance)}</span>,
                  <span style={goalTone(d.revenue, d.revTarget)}>{money(d.revenue)}</span>,
                  money(d.revTarget),
                  d.closeRate != null
                    ? <span style={goalTone(d.closeRate, d.convTarget || 0.7)}>{pct(d.closeRate)} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>/ {pct(d.convTarget)}</span></span>
                    : '—',
                  d.avgSale != null ? money(d.avgSale) : '—',
                  String(d.opps),
                  d.missedSales ? <span style={S.bad}>{money(d.missedSales)}</span> : '—',
                  String(d.fiveStar || 0),
                  String(d.clubs || 0),
                  d.callbacks ? <span style={{ color: 'var(--tone-amber-tx)', fontWeight: 700 }}>{d.callbacks}</span> : '0',
                  d.gm != null
                    ? <span style={goalTone(d.gm, d.gmTarget || 0.55)} title={d.gmCosts ? `Revenue ${money(d.gmCosts.revenue)} · materials/equipment ${money(d.gmCosts.materials)} · POs ${money(d.gmCosts.po)} · other ${money(d.gmCosts.otherNonLabor)} · labor ${money(d.gmCosts.labor)} (${d.gmCosts.laborSource}) · ST's own GM ${d.gmSt != null ? pct(d.gmSt) : '—'}` : undefined}>{pct(d.gm)} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>/ {pct(d.gmTarget || 0.55)}</span></span>
                    : '—',
                  d.trueLaborPct != null
                    ? <span style={d.trueLaborPct <= (d.laborTarget || 0.25) ? S.good : S.bad}>{pct(d.trueLaborPct)}</span>
                    : '—',
                ]),
                [
                  <b>AWESOME</b>, <b>{money(f.totals.sales)}</b>, <b>{money(f.scorecard.reduce((a, d) => a + d.budget, 0))}</b>,
                  (() => { const v = f.totals.sales - f.scorecard.reduce((a, d) => a + d.budget, 0); return <span style={v >= 0 ? S.good : S.bad}>{v >= 0 ? '+' : ''}{money(v)}</span> })(),
                  <b><span style={goalTone(f.totals.revenue, f.scorecard.reduce((a, d) => a + d.revTarget, 0))}>{money(f.totals.revenue)}</span></b>,
                  <b>{money(f.scorecard.reduce((a, d) => a + d.revTarget, 0))}</b>,
                  <span style={goalTone(f.totals.closeRate, 0.7)}>{pct(f.totals.closeRate)}</span>, '—', <b>{String(f.totals.opps)}</b>,
                  money(f.scorecard.reduce((a, d) => a + (d.missedSales || 0), 0)),
                  <b>{String(f.kpis.find(k => k.kpi === '5 Star Reviews')?.thisWk ?? f.scorecard.reduce((a, d) => a + (d.fiveStar || 0), 0))}</b>,
                  <b>{String(f.totals.clubsSold ?? f.scorecard.reduce((a, d) => a + (d.clubs || 0), 0))}</b>,
                  <b>{String(f.scorecard.reduce((a, d) => a + (d.callbacks || 0), 0))}</b>,
                  f.totals.gm != null ? <b><span style={goalTone(f.totals.gm, f.totals.gmTarget || 0.55)}>{pct(f.totals.gm)}</span></b> : '—',
                  pct(f.labor.laborPctOfRevenue),
                ],
              ]}
            />
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
              {f.totals.gm != null
                ? <>GM = invoiced revenue − ServiceTitan job-costing material / equipment / PO costs − burdened field labor ({f.totals.gmSource === 'adp' ? 'actual ADP payroll for this week' : `${Math.round((f.labor.factors?.commissionRate || 0) * 100)}% commission × ${f.labor.factors?.poolUplift} pool × ${f.labor.factors?.fieldBurden} burden on this week's commissionable revenue`}). Hover a cell for the breakdown. ST's own job costing counts only commission labor and reads {['HVAC', 'Plumbing', 'Electrical', 'Garage Doors'].map(t => `${t} ${f.totals.gmStByTrade?.[t] != null ? pct(f.totals.gmStByTrade[t]) : '—'}`).join(' · ')}.</>
                : 'GM unavailable this run — the ServiceTitan job-costing report did not answer. Refresh numbers to try again.'}
            </div>
          </div>

          {/* KPIs + opportunities side-by-side feel */}
          <div style={{ ...sec, ...mo('kpis') }}>
            <Title>Company KPIs — week over week</Title>
            <Table headers={['KPI', 'This Wk', 'Last Wk', 'Δ', 'Goal']}
              rows={f.kpis.map(k => {
                const fmtV = (v) => v == null ? '—' : (k.fmt === 'pct' ? pct(v) : k.fmt === 'money' ? money(v) : String(v))
                const d = (k.thisWk != null && k.lastWk != null) ? k.thisWk - k.lastWk : null
                const hit = k.goal != null && k.thisWk != null && (k.lowerIsBetter ? k.thisWk <= k.goal : k.thisWk >= k.goal)
                const near = k.goal != null && k.thisWk != null && (k.lowerIsBetter ? k.thisWk <= k.goal * 1.1 : k.thisWk >= k.goal * 0.9)
                const tone = (k.goal != null && k.thisWk != null) ? (hit ? S.good : near ? S.warn : S.bad) : null
                const dGood = d != null && (k.lowerIsBetter ? d <= 0 : d >= 0)
                return [
                  k.kpi,
                  tone ? <span style={{ ...tone, fontWeight: 700 }}>{fmtV(k.thisWk)}</span> : fmtV(k.thisWk),
                  fmtV(k.lastWk),
                  d == null ? '—' : <span style={dGood ? S.good : S.bad}>{d >= 0 ? '+' : ''}{k.fmt === 'pct' ? `${Math.round(d * 100)}pt` : k.fmt === 'money' ? money(d) : Math.round(d)}</span>,
                  k.goal == null ? '—' : `${k.lowerIsBetter ? '≤' : ''}${fmtV(k.goal)} ${k.thisWk != null ? (hit ? '✓' : '✗') : ''}`,
                ]
              })}
            />
          </div>

          <div style={{ ...sec, ...mo('opps') }}>
            <Title>Opportunities per day vs the $20M plan</Title>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
              Average sales opportunities run per working day (Mon–Fri full, Saturday half), this week and last, against the plan's daily goal.
              {f.oppsDaily?.partial ? ` This week counts ${f.oppsDaily.effDays} completed days through ${f.oppsDaily.through}.` : ''}
            </div>
            <Table headers={['Dept', 'Goal / day', 'This week / day', 'Last week / day', 'Short of goal / day']}
              rows={(() => {
                const od = f.oppsDaily || { rows: [], all: null }
                const row = (r, bold) => {
                  const w = (x) => bold ? <b>{x}</b> : x
                  const tone = r.onPlan == null ? { color: 'var(--text-muted)' } : r.onPlan ? S.good : S.bad
                  return [
                    w(r.trade),
                    w(String(r.goal || '—')),
                    r.perDay != null ? <span style={{ ...tone, fontWeight: 700 }}>{r.perDay}</span> : '—',
                    r.priorPerDay != null ? String(r.priorPerDay) : '—',
                    r.gapPerDay == null ? '—' : r.gapPerDay >= 0 ? <span style={S.good}>on goal</span> : <span style={S.bad}>{Math.abs(r.gapPerDay)} short</span>,
                  ]
                }
                return [...od.rows.map(r => row(r, false)), ...(od.all ? [row(od.all, true)] : [])]
              })()}
            />
          </div>

          {/* True labor */}
          <div style={{ ...sec, ...mo('labor') }}>
            <Title>
              Last week's true labor{f.labor.weekEnd ? ` — wk ending ${f.labor.weekEnd}` : ''} {f.labor.source === 'adp'
                ? <span style={{ color: 'var(--tone-green-tx)' }}>— ACTUALS from ADP {f.labor.actual?.source === 'invoice' ? `invoice ${f.labor.actual?.invoiceNo}` : f.labor.actual?.invoiceNo}{f.labor.actual?.approx ? ' (burden estimated from measured rates)' : ''} ✓</span>
                : '(ADP-burdened model)'}
            </Title>
            <div className="lp-cards" style={bleed}>
              <Card label="LW field labor (true)" value={money(f.labor.estFieldBurdened)} style={half}
                sub={f.labor.source === 'adp' ? `${money(f.labor.actual?.totals?.field?.gross)} gross · ${f.labor.actual?.totals?.field?.n ?? '—'} employees` : `${money(f.labor.impliedCommissions)} commissions + pool + burden`} />
              <Card label="LW office labor" value={money(f.labor.officeWeeklyCost)} style={half} sub={f.labor.source === 'adp' ? `${f.labor.actual?.totals?.office?.n ?? '—'} employees` : 'burdened weekly baseline'} />
              <Card label="LW all-in labor %" value={pct(f.labor.laborPctOfRevenue)} style={half} sub="of last week's revenue" tone={f.labor.laborPctOfRevenue <= 0.36 ? 'good' : 'bad'} />
              <Card label="LW hidden pool" value={money(f.labor.hiddenPool)} style={half} sub={f.labor.source === 'adp' ? 'actual field gross − job commissions' : 'field pay not tied to a job'} />
            </div>
            {f.labor.source === 'adp' && (f.labor.actual.unmatched || []).length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--tone-amber-tx)', marginTop: 8 }}>
                No department mapping for: {f.labor.actual.unmatched.join(', ')} — upload a recent benefits invoice or tell Claude to remap.
              </div>
            )}
            <div className="no-print" style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
              <label className="btn" style={{ ...pill, cursor: 'pointer', whiteSpace: 'normal' }}>
                {busy === 'payroll' ? 'Parsing…' : '📎 Upload ADP payroll (.xls — invoice or register)'}
                <input type="file" accept=".xls,.xlsx" style={{ display: 'none' }} disabled={busy === 'payroll'}
                  onChange={e => uploadPayroll(e.target.files?.[0])} />
              </label>
              {f.labor.source !== 'adp' && <>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>or type actual field gross:</span>
                <input className="form-input" style={{ ...S.input, ...num, width: 140 }} placeholder="$" value={notes.fieldPayrollActual || ''}
                  onChange={e => patchNotes({ fieldPayrollActual: e.target.value.replace(/[^0-9.]/g, '') })} />
              </>}
            </div>
          </div>

          {/* Technician / CSR leaderboards removed from the agenda (Brandyn, Sep 20, 2026) — the facts still feed the AI agenda. */}

          {/* 6-week trend */}
          <div style={{ ...sec, ...mo('trend') }}>
            <Title>6-week sales trend</Title>
            <div className="lp-trend" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 120, padding: '0 4px', ...(isMobile ? { maxWidth: '100%' } : {}) }}>
              {f.trend.map((t, i) => {
                const max = Math.max(...f.trend.map(x => x.sales), t.goal)
                return (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <div style={{ ...num, fontSize: 10, color: 'var(--text-secondary)' }}>{money(t.sales)}</div>
                    <div style={{
                      width: '70%', height: Math.max(6, 90 * t.sales / max),
                      background: t.hit ? 'var(--tone-green-tx)' : 'var(--tone-red-tx)', borderRadius: 4, opacity: i === f.trend.length - 1 ? 1 : 0.65,
                    }} />
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t.weekEnd.slice(5)}</div>
                  </div>
                )
              })}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Weekly sales goal {money(f.trend[0]?.goal || 0)} — green = hit.</div>
          </div>

          {/* Editable meeting sections */}
          <div style={{ ...sec, ...mo('topics') }}>
            <Title>Discussion topics</Title>
            <EditRows rows={notes.topics} onChange={v => patchNotes({ topics: v })}
              cols={[
                { key: 'topic', label: 'Topic', placeholder: 'Add a topic…' },
                { key: 'owner', label: 'Owner', width: 160 },
              ]} />
          </div>

          <div style={{ ...sec, ...mo('rocks') }}>
            <Title>Rocks — one per leader, progress reported every week</Title>
            <EditRows rows={notes.projects} onChange={v => patchNotes({ projects: v })}
              cols={[
                { key: 'project', label: 'Rock', placeholder: 'Add a rock…' },
                { key: 'owner', label: 'Owner', width: 130 },
                { key: 'status', label: 'Status', width: 130, options: ['On Track', 'Off Track', 'Done'] },
                { key: 'target', label: 'Due', width: 110 },
                { key: 'notes', label: 'This week\u2019s progress' },
              ]} />
            <div className="no-print" style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-muted)', marginTop: 10 }}>
              EOS-style: each leader owns one rock and reports progress here weekly. A rock is either <b>On Track</b> or
              <b> Off Track</b> — no in-between. Rocks marked <b>Done</b> stay on this week's agenda and drop off next
              week's automatically; carry the progress column fresh each week.
            </div>
          </div>

          {/* Parking lot, wins / watch-outs / commitments, notes and the footnote were removed from the agenda (Brandyn, Sep 20, 2026). */}
        </div>
      )}
      </div>
    </div>
    </div>
  )
}

// ── AI Analyst: agentic chat over live ST + Andi data, threads per login ────

// Minimal markdown for analyst answers: ### headers, **bold**, `code`,
// - bullets, 1. lists, | tables |, --- rules. Anything else renders as text.
function Md({ text }) {
  const lines = String(text || '').split('\n')
  const out = []
  let i = 0, key = 0
  const inline = (str) => {
    const parts = []
    let rest = String(str), k = 0
    const rx = /(\*\*[^*]+\*\*|`[^`]+`)/g
    let last = 0, m
    while ((m = rx.exec(rest))) {
      if (m.index > last) parts.push(rest.slice(last, m.index))
      const tok = m[0]
      if (tok.startsWith('**')) parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>)
      else parts.push(<code key={k++} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px', fontSize: '0.92em' }}>{tok.slice(1, -1)}</code>)
      last = m.index + tok.length
    }
    if (last < rest.length) parts.push(rest.slice(last))
    return parts
  }
  while (i < lines.length) {
    const ln = lines[i]
    if (/^\s*\|.*\|\s*$/.test(ln)) {
      const tbl = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { tbl.push(lines[i]); i++ }
      const rows = tbl.map(r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
        .filter(r => !r.every(c => /^:?-{2,}:?$/.test(c)))
      if (rows.length) out.push(
        <div key={key++} style={{ overflowX: 'auto', margin: '10px 0' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: 320 }}>
            <thead><tr>{rows[0].map((c, ci) => <th key={ci} style={{ ...eyebrow, textAlign: ci ? 'right' : 'left', padding: '6px 12px', borderBottom: '1px solid var(--border-strong)' }}>{inline(c)}</th>)}</tr></thead>
            <tbody>{rows.slice(1).map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} style={{ ...num, textAlign: ci ? 'right' : 'left', padding: '7px 12px', borderBottom: '1px solid var(--border)', fontWeight: ci ? 400 : 600 }}>{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>)
      continue
    }
    if (/^\s*([-*•]|\d+\.)\s+/.test(ln)) {
      const items = []
      while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*•]|\d+\.)\s+/, '')); i++ }
      out.push(<ul key={key++} style={{ margin: '8px 0', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 4 }}>{items.map((it, ii) => <li key={ii}>{inline(it)}</li>)}</ul>)
      continue
    }
    if (/^#{1,4}\s+/.test(ln)) { out.push(<div key={key++} style={{ fontWeight: 800, fontSize: 14, margin: '14px 0 4px' }}>{inline(ln.replace(/^#+\s+/, ''))}</div>); i++; continue }
    if (/^\s*(-{3,}|_{3,})\s*$/.test(ln)) { out.push(<hr key={key++} style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '12px 0' }} />); i++; continue }
    if (ln.trim() === '') { i++; continue }
    const para = []
    while (i < lines.length && lines[i].trim() !== '' && !/^\s*\|.*\|\s*$/.test(lines[i]) && !/^\s*([-*•]|\d+\.)\s+/.test(lines[i]) && !/^#{1,4}\s+/.test(lines[i])) { para.push(lines[i]); i++ }
    out.push(<p key={key++} style={{ margin: '8px 0', lineHeight: 1.65 }}>{inline(para.join(' '))}</p>)
  }
  return <div>{out}</div>
}

const BRAIN_SUGGESTIONS = [
  'Who were our top 3 techs by sold dollars last week?',
  'Sales trend over the last 4 weeks by department',
  'How is each CSR trending on QA this month?',
  'Which marketing channels booked best this month?',
]

function BrainChat({ authHeaders }) {
  const [threads, setThreads] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [msgs, setMsgs] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const bodyRef = useRef(null)
  const inputRef = useRef(null)
  const isMobile = useIsMobile()

  const loadThreads = useCallback(async () => {
    try {
      const r = await fetch('/api/leadership/chats', { headers: await authHeaders() })
      const d = await r.json()
      setThreads(d.chats || [])
    } catch {}
  }, [authHeaders])
  useEffect(() => { loadThreads() }, [loadThreads])

  const openThread = async (id) => {
    setActiveId(id); setErr('')
    if (!id) { setMsgs([]); inputRef.current?.focus(); return }
    try {
      const r = await fetch(`/api/leadership/chats/${id}`, { headers: await authHeaders() })
      const d = await r.json()
      setMsgs(Array.isArray(d.chat?.messages) ? d.chat.messages : [])
    } catch { setMsgs([]) }
  }

  const removeThread = async (id) => {
    if (!(await confirmDlg('Delete this conversation?'))) return
    try { await fetch(`/api/leadership/chats/${id}`, { method: 'DELETE', headers: await authHeaders() }) } catch {}
    if (id === activeId) { setActiveId(null); setMsgs([]) }
    loadThreads()
  }

  const ask = async (preset) => {
    const q = (preset ?? input).trim()
    if (!q || busy) return
    setBusy(true); setErr(''); setInput('')
    setMsgs(prev => [...prev, { role: 'user', content: q }])
    try {
      const r = await fetch('/api/leadership/chat', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ chatId: activeId, message: q }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'The analyst hit an error')
      setMsgs(prev => [...prev, { role: 'assistant', content: d.reply, toolLog: d.toolLog }])
      if (d.chatId && d.chatId !== activeId) setActiveId(d.chatId)
      loadThreads()
    } catch (e) {
      setErr(e.message)
      setMsgs(prev => prev.slice(0, -1))
      setInput(q)
    }
    setBusy(false)
  }

  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight }, [msgs, busy])

  // Phone: stack — thread chips across the top, conversation below, filling
  // whatever the page gives (the page is a flex column on a phone).
  return (
    <div style={isMobile
      ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, margin: '0 -4px' }
      : { display: 'flex', gap: 0, height: 'calc(100vh - 130px)', minHeight: 480, margin: '0 -8px' }}>

      {/* Thread rail */}
      <div style={isMobile
        ? { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 4px 8px', borderBottom: '1px solid var(--border)', overflowX: 'auto', flexShrink: 0 }
        : { width: 250, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 12px 4px 4px', borderRight: '1px solid var(--border)', overflowY: 'auto' }}>
        <button onClick={() => openThread(null)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', marginBottom: isMobile ? 0 : 8, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            ...(isMobile ? { flexShrink: 0, whiteSpace: 'nowrap', minHeight: 40 } : {}) }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
          onMouseLeave={e => e.currentTarget.style.background = 'var(--surface)'}>
          <span style={{ fontSize: 15, lineHeight: 1 }}>+</span> New chat
        </button>
        {!isMobile && <div style={{ ...eyebrow, padding: '4px 12px' }}>Recents</div>}
        {threads.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 12px' }}>Nothing yet.</div>}
        {threads.map(t => (
          <div key={t.id} onClick={() => openThread(t.id)} className="brain-thread"
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 10, cursor: 'pointer',
              background: t.id === activeId ? 'var(--surface-2)' : 'transparent',
              ...(isMobile ? { flex: '0 0 auto', maxWidth: 180, minHeight: 40, boxSizing: 'border-box', border: '1px solid var(--border)' } : {}) }}
            onMouseEnter={e => { if (t.id !== activeId) e.currentTarget.style.background = 'var(--surface)' }}
            onMouseLeave={e => { if (t.id !== activeId) e.currentTarget.style.background = 'transparent' }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.title || 'Untitled'}
            </div>
            <button onClick={e => { e.stopPropagation(); removeThread(t.id) }} title="Delete"
              style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1 }}>×</button>
          </div>
        ))}
      </div>

      {/* Conversation */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div ref={bodyRef} style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '12px 6px 8px' : '20px 24px 8px' }}>
          <div style={{ maxWidth: 780, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

            {msgs.length === 0 && !busy && (
              <div style={{ marginTop: isMobile ? '4vh' : '14vh', textAlign: 'center' }}>
                <span style={{ display: 'inline-flex', width: 54, height: 54, marginBottom: 14 }}>
                  <svg viewBox="0 0 64 64" style={{ width: '100%', height: '100%' }}>
                    <rect x="2" y="2" width="60" height="60" rx="14" fill="#111318" />
                    <polyline points="9,32 19,32 25,17 33,47 40,26 45,32 55,32" fill="none" stroke="#ff751f" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: -.3, marginBottom: 6 }}>What do you want to know?</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 22 }}>
                  I answer by querying ServiceTitan and Andi live — techs, CSRs, revenue, labor, marketing, money.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', maxWidth: 560, margin: '0 auto' }}>
                  {BRAIN_SUGGESTIONS.map(sug => (
                    <button key={sug} onClick={() => ask(sug)}
                      style={{ padding: '8px 14px', borderRadius: 99, fontSize: 12.5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-secondary)', cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)' }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)' }}>
                      {sug}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {msgs.map((m, i) => m.role === 'user' ? (
              <div key={i} style={{ alignSelf: 'flex-end', maxWidth: isMobile ? '88%' : '75%', padding: '10px 16px', borderRadius: 16, background: 'var(--surface-2)', border: '1px solid var(--border)', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {m.content}
              </div>
            ) : (
              <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span style={{ flexShrink: 0, width: 26, height: 26, marginTop: 2 }}>
                  <svg viewBox="0 0 64 64" style={{ width: '100%', height: '100%' }}>
                    <rect x="2" y="2" width="60" height="60" rx="14" fill="#111318" />
                    <polyline points="9,32 19,32 25,17 33,47 40,26 45,32 55,32" fill="none" stroke="#ff751f" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div style={{ flex: 1, minWidth: 0, fontSize: 14, color: 'var(--text-primary)' }}>
                  <Md text={m.content} />
                  {m.toolLog?.length > 0 && (
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
                        {m.toolLog.length} data pull{m.toolLog.length === 1 ? '' : 's'}
                      </summary>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 12, lineHeight: 1.8, marginTop: 4 }}>
                        {m.toolLog.map((t, ti) => <div key={ti} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.ok ? '✓' : '✗'} {t.tool === 'st_get' ? 'ServiceTitan' : 'Andi'} · {t.q}</div>)}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            ))}

            {busy && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span className="pulse-mark-fast" style={{ flexShrink: 0, width: 26, height: 26 }}>
                  <svg viewBox="0 0 64 64" style={{ width: '100%', height: '100%' }}>
                    <rect x="2" y="2" width="60" height="60" rx="14" fill="#111318" />
                    <polyline points="9,32 19,32 25,17 33,47 40,26 45,32 55,32" fill="none" stroke="#ff751f" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Querying the data — big questions can take up to a minute…</div>
              </div>
            )}
          </div>
        </div>

        {err && <div style={{ maxWidth: 780, margin: '0 auto', width: '100%', padding: '4px 24px', fontSize: 12.5, color: 'var(--tone-red-tx)' }}>{err}</div>}

        {/* Composer */}
        <div style={{ padding: isMobile ? '8px 4px 10px' : '10px 24px 18px' }}>
          <div style={{ maxWidth: 780, margin: '0 auto', position: 'relative' }}>
            <textarea ref={inputRef} rows={1} value={input} disabled={busy}
              placeholder="Ask about techs, CSRs, revenue, labor, marketing…"
              onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px' }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() } }}
              style={{ width: '100%', resize: 'none', padding: '14px 52px 14px 18px', borderRadius: 16, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit', lineHeight: 1.5, outline: 'none', boxShadow: '0 2px 12px rgba(0,0,0,.05)' }}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'} />
            <button onClick={() => ask()} disabled={busy || !input.trim()} title="Send"
              style={{ position: 'absolute', right: 10, bottom: 13, width: 34, height: 34, borderRadius: 10, border: 'none', cursor: busy || !input.trim() ? 'default' : 'pointer',
                background: busy || !input.trim() ? 'var(--surface-2)' : '#ff751f', color: busy || !input.trim() ? 'var(--text-muted)' : '#fff',
                fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              ↑
            </button>
          </div>
          <div style={{ maxWidth: 780, margin: '6px auto 0', fontSize: 10.5, color: 'var(--text-muted)', textAlign: 'center' }}>
            Answers come from live ServiceTitan + Andi queries — open “data pulls” under any answer to see the sources.
          </div>
        </div>
      </div>
    </div>
  )
}
