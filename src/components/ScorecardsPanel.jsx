import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { toast } from '../lib/dialogs'
import { useIsMobile } from '../lib/useIsMobile'
import Avatar from './Avatar'
import { Ring, Segmented } from './CoachingSnapshots'

// Team → Scorecards. Opens on the whole team for the month (team panel + one
// card per CSR); a card opens that rep's review. KPI actuals are filled by
// syncScorecardActuals() every hour for the current and previous month —
// manual edits there would be overwritten, so those months are read-only and
// only older months can be hand-corrected. Weights and thresholds are global
// (app_settings scorecard_weights / scorecard_thresholds) and live in one
// "Scoring rules" editor instead of on every rep's card.

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const KPIS = [
  { id: 'attendance',   label: 'Attendance',         short: 'Attendance',   unit: 'pts', lowerIsBetter: true },
  { id: 'booking_pct',  label: 'Inbound booking %',  short: 'Booking %',    unit: '%' },
  { id: 'booked_calls', label: 'Booked calls',       short: 'Booked calls', unit: '' },
  { id: 'call_quality', label: 'Call quality (QA)',  short: 'Call QA',      unit: '%' },
  { id: 'memberships',  label: 'Memberships sold',   short: 'Memberships',  unit: '' },
]
const DEFAULT_WEIGHTS = { attendance: 25, booking_pct: 20, booked_calls: 20, call_quality: 15, memberships: 20 }
const DEFAULT_THRESHOLDS = {
  attendance:   { exceeds: 0,   meets: 1,   improvement: 2  },
  booking_pct:  { exceeds: 90,  meets: 80,  improvement: 75 },
  booked_calls: { exceeds: 140, meets: 110, improvement: 85 },
  call_quality: { exceeds: 95,  meets: 90,  improvement: 85 },
  memberships:  { exceeds: 5,   meets: 3,   improvement: 2  },
}
export const LEVELS = {
  4: { label: 'Exceeds', tone: 'green' },
  3: { label: 'Meets', tone: 'blue' },
  2: { label: 'Needs improvement', tone: 'amber' },
  1: { label: 'Poor', tone: 'red' },
}
const ZONES = ['Poor', 'Needs impr.', 'Meets', 'Exceeds']
const num = { fontVariantNumeric: 'tabular-nums' }
const eyebrow = { fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)' }

const pad = (n) => String(n).padStart(2, '0')
const monthKey = ({ year, month }) => `${year}-${pad(month + 1)}-01`
const monthEnd = ({ year, month }) => `${year}-${pad(month + 1)}-${pad(new Date(year, month + 1, 0).getDate())}`
const shiftMonth = ({ year, month }, d) => {
  let m = month + d, y = year
  while (m > 11) { m -= 12; y++ }
  while (m < 0) { m += 12; y-- }
  return { year: y, month: m }
}
const toNum = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v))

export function rateKpi(kpi, value, thr) {
  const v = toNum(value)
  if (v == null || !thr) return null
  if (kpi.lowerIsBetter) return v <= thr.exceeds ? 4 : v <= thr.meets ? 3 : v <= thr.improvement ? 2 : 1
  return v >= thr.exceeds ? 4 : v >= thr.meets ? 3 : v >= thr.improvement ? 2 : 1
}
function overallScore(actuals, weights, thresholds) {
  let tw = 0, sum = 0
  for (const k of KPIS) {
    const w = Number(weights[k.id]) || 0
    const r = rateKpi(k, actuals[k.id], thresholds[k.id] || DEFAULT_THRESHOLDS[k.id])
    if (r != null && w > 0) { tw += w; sum += r * w }
  }
  return tw ? sum / tw : null
}
export const levelOf = (score) => (score == null ? null : score >= 3.5 ? 4 : score >= 2.5 ? 3 : score >= 1.5 ? 2 : 1)
const money = (n) => (Math.abs(n) >= 10000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n).toLocaleString('en-US')}`)
export const fmtKpi = (kpi, v) => {
  const n = toNum(v)
  if (n == null) return '—'
  if (kpi.unit === '$') return `$${Math.round(n).toLocaleString('en-US')}`
  if (kpi.unit === '%') return `${Math.round(n)}%`
  if (kpi.unit === 'pts') return `${+n.toFixed(1)} pt${n === 1 ? '' : 's'}`
  return `${Math.round(n)}`
}
const fmtThr = (kpi, v) => (kpi.unit === '$' ? money(Number(v) || 0) : kpi.unit === '%' ? `${v}%` : kpi.unit === 'pts' ? `${v} pt${Number(v) === 1 ? '' : 's'}` : `${v}`)

export function LevelChip({ level, small, short }) {
  if (!level) return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>No data</span>
  const { tone } = LEVELS[level]
  const label = short && level === 2 ? 'Needs impr.' : LEVELS[level].label
  return (
    <span style={{ fontSize: small ? 10.5 : 11.5, fontWeight: 700, whiteSpace: 'nowrap', borderRadius: 99, padding: small ? '1px 7px' : '2px 9px',
      color: `var(--tone-${tone}-tx)`, background: `var(--tone-${tone}-bg)`, border: `1px solid var(--tone-${tone}-bd)` }}>
      {label}
    </span>
  )
}

export function ScoreDelta({ now, prev, vs }) {
  if (now == null || prev == null) return null
  const d = Math.round((now - prev) * 100) / 100
  const t = d > 0 ? 'green' : d < 0 ? 'red' : 'gray'
  return (
    <span title={`${prev.toFixed(2)} in ${vs}`} style={{ ...num, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', borderRadius: 99, padding: '1px 7px',
      color: `var(--tone-${t}-tx)`, background: `var(--tone-${t}-bg)`, border: `1px solid var(--tone-${t}-bd)` }}>
      {d > 0 ? `▲ +${d.toFixed(2)}` : d < 0 ? `▼ −${Math.abs(d).toFixed(2)}` : '= 0.00'} vs {vs}
    </span>
  )
}

// Four-step "signal" for compact rows: filled up to the level, in its tone.
export function LevelPips({ level }) {
  const tone = level ? LEVELS[level].tone : 'gray'
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'flex-end' }} aria-label={level ? LEVELS[level].label : 'No data'}>
      {[1, 2, 3, 4].map(i => (
        <span key={i} style={{ width: 5, height: 5 + i * 2, borderRadius: 2,
          background: level && i <= level ? `var(--tone-${tone}-tx)` : 'var(--surface-2)',
          border: level && i <= level ? 'none' : '1px solid var(--border)' }} />
      ))}
    </span>
  )
}

// Poor → Exceeds, always worst-left / best-right (attendance included). The
// marker interpolates inside the two middle zones; the open-ended outer zones
// just center it.
export function KpiTrack({ kpi, value, thr }) {
  const level = rateKpi(kpi, value, thr)
  let pos = null
  if (level) {
    const z = level - 1
    let frac = 0.5
    const v = toNum(value)
    if (z === 1 || z === 2) {
      const [lo, hi] = z === 1 ? [thr.improvement, thr.meets] : [thr.meets, thr.exceeds]
      frac = hi === lo ? 0.5 : Math.min(0.92, Math.max(0.08, kpi.lowerIsBetter ? (lo - v) / (lo - hi) : (v - lo) / (hi - lo)))
    }
    pos = ((z + frac) / 4) * 100
  }
  const bounds = [thr.improvement, thr.meets, thr.exceeds]
  const tone = level ? LEVELS[level].tone : null
  return (
    <div style={{ minWidth: 0 }}>
      <div className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 3, marginBottom: 4 }}>
        {ZONES.map((z, i) => {
          const on = level === i + 1
          return (
            <span key={z} style={{ fontSize: 10.5, fontWeight: on ? 800 : 600, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              color: on ? `var(--tone-${LEVELS[i + 1].tone}-tx)` : 'var(--text-muted)' }}>{z}</span>
          )
        })}
      </div>
      <div style={{ position: 'relative' }}>
        <div className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 3 }}>
          {ZONES.map((z, i) => {
            const lv = i + 1
            const t = LEVELS[lv].tone
            return <div key={z} style={{ height: 9, borderRadius: 99, background: level === lv ? `var(--tone-${t}-tx)` : `var(--tone-${t}-bg)`,
              border: `1px solid var(--tone-${t}-bd)`, opacity: level && level !== lv ? 0.7 : 1 }} />
          })}
        </div>
        {pos != null && (
          <div style={{ position: 'absolute', top: '50%', left: `${pos}%`, width: 15, height: 15, transform: 'translate(-50%, -50%)', borderRadius: 99,
            background: 'var(--surface)', border: `3px solid var(--tone-${tone}-tx)`, boxShadow: '0 1px 4px rgba(15,20,40,.25)' }} />
        )}
      </div>
      <div style={{ position: 'relative', height: 14, marginTop: 5 }}>
        {bounds.map((b, i) => (
          <span key={i} style={{ ...num, position: 'absolute', left: `${(i + 1) * 25}%`, transform: 'translateX(-50%)', fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {fmtThr(kpi, b)}
          </span>
        ))}
      </div>
    </div>
  )
}

function RepRing({ rep, score, size = 48, stroke = 4 }) {
  const lv = levelOf(score)
  const photo = typeof rep?.avatar === 'string' && /^(data:|https?:|\/)/.test(rep.avatar)
  return (
    <Ring pct={score == null ? 0 : (score / 4) * 100} size={size} stroke={stroke} tone={lv ? LEVELS[lv].tone : 'gray'}>
      <div style={{ width: size - stroke * 2 - 6, height: size - stroke * 2 - 6, borderRadius: 99, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: photo ? 'transparent' : 'var(--surface-2)', fontSize: size > 60 ? 20 : 13.5, fontWeight: 700, color: 'var(--text-secondary)' }}>
        <Avatar avatar={rep?.avatar} name={rep?.name || rep?.email} />
      </div>
    </Ring>
  )
}

function RepCard({ rep, actuals, score, prevScore, vs, thresholds, onOpen }) {
  const lv = levelOf(score)
  return (
    <div className="coach-card" role="button" tabIndex={0} onClick={onOpen} title="Open this scorecard"
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '16px 18px 14px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <RepRing rep={rep} score={score} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rep.name || rep.email}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
            <LevelChip level={lv} small short />
            <ScoreDelta now={score} prev={prevScore} vs={vs} />
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ ...num, fontSize: 28, fontWeight: 800, lineHeight: 1, letterSpacing: '-.02em', color: lv ? `var(--tone-${LEVELS[lv].tone}-tx)` : 'var(--text-muted)' }}>
            {score == null ? '—' : score.toFixed(2)}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>out of 4.00</div>
        </div>
      </div>
      {actuals ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          {KPIS.map(k => (
            <div key={k.id} className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto 34px', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
              <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.short}</span>
              <span style={{ ...num, fontWeight: 700 }}>{fmtKpi(k, actuals[k.id])}</span>
              <span style={{ display: 'flex', justifyContent: 'flex-end' }}><LevelPips level={rateKpi(k, actuals[k.id], thresholds[k.id])} /></span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>No scorecard data for this month yet.</div>
      )}
      <div style={{ marginTop: 'auto', fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>Open review →</div>
    </div>
  )
}

function TeamPanel({ reps, data, weights, thresholds, vs, isMobile }) {
  const scored = reps.map(r => ({ r, s: data.score(r.id), p: data.prevScore(r.id), a: data.actuals(r.id) })).filter(x => x.s != null)
  const avg = scored.length ? scored.reduce((t, x) => t + x.s, 0) / scored.length : null
  const prevList = scored.filter(x => x.p != null)
  const prevAvg = prevList.length ? prevList.reduce((t, x) => t + x.p, 0) / prevList.length : null
  const counts = [4, 3, 2, 1].map(lv => [lv, scored.filter(x => levelOf(x.s) === lv).length])
  const lv = levelOf(avg)
  const divider = isMobile ? { borderTop: '1px solid var(--border)' } : { borderLeft: '1px solid var(--border)' }
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, marginBottom: 18, display: 'grid',
      gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(270px, 300px) minmax(0, 1fr) minmax(240px, 290px)' }}>
      <div style={{ padding: '20px 22px', display: 'flex', alignItems: 'center', gap: 18 }}>
        <Ring pct={avg == null ? 0 : (avg / 4) * 100} size={92} stroke={8} tone={lv ? LEVELS[lv].tone : 'gray'}>
          <div style={{ ...num, fontSize: 22, fontWeight: 800, letterSpacing: '-.02em', color: lv ? `var(--tone-${LEVELS[lv].tone}-tx)` : 'var(--text-muted)' }}>
            {avg == null ? '—' : avg.toFixed(2)}
          </div>
        </Ring>
        <div style={{ minWidth: 0 }}>
          <div style={eyebrow}>Team score</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 8px', whiteSpace: 'nowrap' }}>
            out of 4.00 · {scored.length} CSR{scored.length === 1 ? '' : 's'}
          </div>
          <ScoreDelta now={avg} prev={prevAvg} vs={vs} />
        </div>
      </div>

      <div style={{ padding: '18px 22px', minWidth: 0, ...divider }}>
        <div style={{ ...eyebrow, marginBottom: 12 }}>Team average on each KPI</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {KPIS.map(k => {
            const vals = scored.map(x => toNum(x.a?.[k.id])).filter(v => v != null)
            const mean = vals.length ? vals.reduce((t, v) => t + v, 0) / vals.length : null
            const lvK = rateKpi(k, mean, thresholds[k.id])
            return (
              <div key={k.id} className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 70px 150px', gap: 12, alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{k.label}</span>
                  <span style={{ ...num, fontSize: 11, color: 'var(--text-muted)' }}> · {Number(weights[k.id]) || 0}% weight</span>
                </div>
                <span style={{ ...num, fontSize: 13, fontWeight: 700, textAlign: 'right' }}>{mean == null ? '—' : fmtKpi(k, k.unit === 'pts' ? mean : Math.round(mean))}</span>
                <span style={{ display: 'flex', justifyContent: 'flex-end' }}><LevelChip level={lvK} small /></span>
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, ...divider }}>
        <div style={eyebrow}>Where the team lands</div>
        {counts.map(([lvC, n]) => (
          <div key={lvC} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 150 }}><LevelChip level={lvC} small /></span>
            <div style={{ flex: 1, height: 7, borderRadius: 99, background: 'var(--surface-2)', overflow: 'hidden' }}>
              <div style={{ width: `${scored.length ? (n / scored.length) * 100 : 0}%`, height: '100%', background: `var(--tone-${LEVELS[lvC].tone}-tx)`, borderRadius: 99 }} />
            </div>
            <b style={{ ...num, fontSize: 13, width: 18, textAlign: 'right' }}>{n}</b>
          </div>
        ))}
      </div>
    </div>
  )
}

function RulesEditor({ weights, thresholds, setWeights, setThresholds, onSave, saving }) {
  const total = KPIS.reduce((t, k) => t + (Number(weights[k.id]) || 0), 0)
  const input = { width: '100%', padding: '6px 8px', fontSize: 13, fontWeight: 600, textAlign: 'center', border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', color: 'var(--text-primary)' }
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: '16px 20px', marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Scoring rules</div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Apply to every CSR, every month</span>
        <span style={{ ...num, marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: total === 100 ? 'var(--tone-green-tx)' : 'var(--tone-red-tx)' }}>
          Weights total {total}%{total === 100 ? '' : ' — should be 100%'}
        </span>
        <button className="btn sm primary" disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save rules'}</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 1.4fr) repeat(4, minmax(80px, 1fr))', gap: '8px 12px', alignItems: 'center', minWidth: 520 }}>
          {['KPI', 'Weight', 'Exceeds', 'Meets', 'Needs impr.'].map((h, i) => (
            <div key={h} style={{ ...eyebrow, textAlign: i ? 'center' : 'left' }}>{h}</div>
          ))}
          {KPIS.map(k => (
            <div key={k.id} style={{ display: 'contents' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{k.label}{k.lowerIsBetter && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}> · lower is better</span>}</div>
              <input type="number" min="0" max="100" value={weights[k.id]} style={input}
                onChange={e => setWeights(w => ({ ...w, [k.id]: e.target.value }))} aria-label={`${k.label} weight`} />
              {['exceeds', 'meets', 'improvement'].map(t => (
                <input key={t} type="number" value={thresholds[k.id]?.[t] ?? ''} style={input} aria-label={`${k.label} ${t}`}
                  onChange={e => setThresholds(th => ({ ...th, [k.id]: { ...th[k.id], [t]: parseFloat(e.target.value) || 0 } }))} />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 10 }}>
        A KPI below “Needs impr.” rates Poor. Each KPI rates 1–4; the overall score is their weighted average.
      </div>
    </div>
  )
}

function printReview({ rep, monthLabel, actuals, weights, thresholds, notes }) {
  const score = overallScore(actuals, weights, thresholds)
  const overall = score == null ? null : score.toFixed(2)
  const ratingColors = { 4: { bg: '#d4edda', text: '#2E7D52' }, 3: { bg: '#d4edda', text: '#2E7D52' }, 2: { bg: '#FBF3E0', text: '#8A5A00' }, 1: { bg: '#FBEEEA', text: '#B5341A' } }
  const ratingLabels = { 4: 'Exceeds', 3: 'Meets', 2: 'Needs Improvement', 1: 'Poor Performance' }
  const scoreColor = overall ? (score >= 3.5 ? '#2E7D52' : score >= 2.5 ? '#8A5A00' : '#B5341A') : '#1C1B19'
  const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const rows = KPIS.map(kpi => {
    const w = Number(weights[kpi.id]) || 0
    const actual = toNum(actuals[kpi.id])
    const rating = rateKpi(kpi, actual, thresholds[kpi.id])
    const rc = rating ? ratingColors[rating] : null
    const thr = thresholds[kpi.id]
    const fmt = (n) => kpi.unit === '%' ? `${n}%` : kpi.unit === 'pts' ? `${n} pts` : `${n}`
    const range = (lo, hi) => lo === hi ? fmt(lo) : `${fmt(lo)}-${fmt(hi)}`
    let c4, c3, c2, c1
    if (kpi.id === 'attendance') { c4 = fmt(thr.exceeds); c3 = fmt(thr.meets); c2 = fmt(thr.improvement); c1 = `${thr.improvement + 1}+ pts` }
    else { c4 = `${fmt(thr.exceeds)}+`; c3 = range(thr.meets, thr.exceeds - 1); c2 = range(thr.improvement, thr.meets - 1); c1 = `Below ${fmt(thr.improvement)}` }
    const cells = [[c4, 4], [c3, 3], [c2, 2], [c1, 1]].map(([v, r]) => {
      const c = ratingColors[r]
      return `<td style="background:${c.bg};color:${c.text};${rating === r ? 'font-weight:700;' : 'opacity:0.6;'}">${v}${rating === r ? ' *' : ''}</td>`
    }).join('')
    return `<tr><td><div class="kpi-name">${kpi.label}</div>${rating && rc ? `<div class="badge" style="background:${rc.bg};color:${rc.text}">${ratingLabels[rating]}</div>` : ''}</td>
      <td>${w}%</td><td><span class="actual-val" style="color:${rc ? rc.text : '#1C1B19'}">${actual == null ? '--' : fmtKpi(kpi, actual)}</span></td>${cells}</tr>`
  }).join('')
  const html = `<!DOCTYPE html><html><head><title>Scorecard - ${esc(rep?.name || '')} - ${monthLabel}</title><style>
    @page { margin: 0.5in 0.65in; size: letter landscape; }
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    body { background: white; color: #1C1B19; font-size: 13px; line-height: 1.5; display: flex; flex-direction: column; align-items: center; }
    .page { width: 100%; max-width: 960px; }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 2px solid #E2DED6; }
    .rep-name { font-size: 18px; font-weight: 700; } .rep-sub { font-size: 12px; color: #6B6760; margin-top: 2px; }
    .overall { text-align: right; } .overall-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #9E9B96; margin-bottom: 2px; }
    .overall-score { font-size: 32px; font-weight: 800; letter-spacing: -1px; color: ${scoreColor}; } .overall-sub { font-size: 11px; color: #9E9B96; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; border: 1px solid #E2DED6; }
    thead tr { background: #F0EEE9; }
    th { padding: 8px 10px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: #9E9B96; text-align: center; border-bottom: 2px solid #C8C3BA; }
    th:first-child, td:first-child { text-align: left; }
    td { padding: 10px; border-bottom: 1px solid #E2DED6; font-size: 12px; text-align: center; vertical-align: middle; }
    .kpi-name { font-weight: 600; font-size: 13px; } .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; margin-top: 3px; }
    .actual-val { font-size: 14px; font-weight: 700; }
    .notes-box { border: 1px solid #E2DED6; border-radius: 8px; padding: 14px; margin-bottom: 20px; }
    .notes-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: #9E9B96; margin-bottom: 10px; }
    .notes-content { font-size: 13px; min-height: 72px; white-space: pre-wrap; }
    .sig-row { display: flex; gap: 48px; margin-top: 32px; } .sig { flex: 1; } .sig-line { border-top: 1px solid #C8C3BA; padding-top: 6px; font-size: 11px; color: #6B6760; }
    .footer { display: flex; justify-content: space-between; font-size: 10px; color: #9E9B96; margin-top: 16px; padding-top: 10px; border-top: 1px solid #E2DED6; }
  </style></head><body><div class="page">
    <div class="header"><div><div class="rep-name">${esc(rep?.name || rep?.email || '')}</div><div class="rep-sub">Performance Review &mdash; ${monthLabel}</div></div>
      ${overall ? `<div class="overall"><div class="overall-label">Overall Score</div><div class="overall-score">${overall}</div><div class="overall-sub">out of 4.00</div></div>` : ''}</div>
    <table><thead><tr><th>KPI</th><th>Weight</th><th>Actual</th><th>Exceeds (4)</th><th>Meets (3)</th><th>Needs Improvement (2)</th><th>Poor Performance (1)</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="notes-box"><div class="notes-label">Manager Notes</div><div class="notes-content">${esc(notes)}</div></div>
    <div class="sig-row"><div class="sig"><div class="sig-line">Employee Signature &amp; Date</div></div><div class="sig"><div class="sig-line">Manager Signature &amp; Date</div></div></div>
    <div class="footer"><span>KPIs filled automatically from ServiceTitan and Andi; attendance from the points log.</span><span>Awesome Home Services &mdash; Andi</span></div>
  </div></body></html>`
  const win = window.open('', '_blank', 'width=1100,height=850')
  win.document.write(html); win.document.close(); win.focus()
  setTimeout(() => { win.print(); win.close() }, 500)
}

function ReviewView({ rep, month, data, weights, thresholds, vs, editable, onBack, onSaved, isMobile, currentUserId }) {
  const row = data.rows.get(rep.id)
  const [notes, setNotes] = useState(row?.notes || '')
  const [edits, setEdits] = useState(() => Object.fromEntries(KPIS.filter(k => k.id !== 'attendance').map(k => [k.id, row?.[k.id] ?? ''])))
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  useEffect(() => {
    setNotes(row?.notes || '')
    setEdits(Object.fromEntries(KPIS.filter(k => k.id !== 'attendance').map(k => [k.id, row?.[k.id] ?? ''])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rep.id, row?.id, row?.notes])

  // No row this month = no score (attendance alone would read as "Exceeds").
  const base = data.actuals(rep.id)
  const actuals = editable ? { attendance: data.att.get(rep.id) || 0, ...(base || {}), ...edits } : (base || { attendance: data.att.get(rep.id) || 0 })
  const score = base || editable ? overallScore(actuals, weights, thresholds) : null
  const lv = levelOf(score)
  const monthLabel = `${MONTH_NAMES[month.month]} ${month.year}`
  const synced = row?.updated_at ? new Date(row.updated_at).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null

  const save = async () => {
    setSaving(true)
    try {
      // Notes only — never write the auto-filled KPIs back from this screen
      // (a stale copy would overwrite the hourly sync), except in months the
      // sync no longer touches.
      const patch = { notes, updated_by: currentUserId || null }
      if (editable) for (const [k, v] of Object.entries(edits)) patch[k] = toNum(v)
      const { data: existing } = await sb.from('scorecard_actuals').select('id').eq('profile_id', rep.id).eq('month', monthKey(month)).maybeSingle()
      const { error } = existing
        ? await sb.from('scorecard_actuals').update(patch).eq('id', existing.id)
        : await sb.from('scorecard_actuals').insert({ profile_id: rep.id, month: monthKey(month), weights, ...patch })
      if (error) throw error
      setSavedAt(Date.now()); onSaved()
    } catch (e) { toast('Couldn’t save: ' + e.message) }
    setSaving(false)
  }

  return (
    <div>
      <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 12 }}>← All CSRs</button>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: isMobile ? 16 : '20px 22px', marginBottom: 16,
        display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        <RepRing rep={rep} score={score} size={72} stroke={6} />
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.01em' }}>{rep.name || rep.email}</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>Performance review · {monthLabel}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <LevelChip level={lv} />
            <ScoreDelta now={score} prev={data.prevScore(rep.id)} vs={vs} />
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={eyebrow}>Overall score</div>
          <div style={{ ...num, fontSize: 38, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-.03em', color: lv ? `var(--tone-${LEVELS[lv].tone}-tx)` : 'var(--text-muted)' }}>
            {score == null ? '—' : score.toFixed(2)}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>out of 4.00</div>
        </div>
        <div style={{ display: 'flex', gap: 6, width: isMobile ? '100%' : undefined }}>
          <button className="btn" onClick={() => printReview({ rep, monthLabel, actuals, weights, thresholds, notes })}>Print review</button>
        </div>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, marginBottom: 16, overflow: 'hidden' }}>
        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>KPIs</div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {editable ? 'This month is past the automatic fill — numbers can be corrected by hand.'
              : `Filled automatically every hour from ServiceTitan and Andi${synced ? ` · last update ${synced}` : ''}`}
          </span>
        </div>
        {KPIS.map((k, i) => {
          const v = actuals[k.id]
          const lvK = rateKpi(k, v, thresholds[k.id])
          const canEdit = editable && k.id !== 'attendance'
          return (
            <div key={k.id} className="mgrid" style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(180px, 1.1fr) minmax(150px, .8fr) minmax(260px, 2fr)',
              gap: isMobile ? 10 : 20, alignItems: 'center', padding: '14px 20px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{k.label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                  {Number(weights[k.id]) || 0}% of the score{k.id === 'attendance' ? ' · from the points log' : ''}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {canEdit ? (
                  <input type="number" value={edits[k.id]} onChange={e => setEdits(x => ({ ...x, [k.id]: e.target.value }))} aria-label={k.label}
                    style={{ width: 90, padding: '6px 8px', fontSize: 15, fontWeight: 700, textAlign: 'center', border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', color: 'var(--text-primary)' }} />
                ) : (
                  <span style={{ ...num, fontSize: 22, fontWeight: 800, letterSpacing: '-.01em' }}>{fmtKpi(k, v)}</span>
                )}
                <LevelChip level={lvK} small />
              </div>
              <KpiTrack kpi={k} value={v} thr={thresholds[k.id]} />
            </div>
          )
        })}
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Manager notes</div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Printed on the review</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--tone-green-tx)' }}>{savedAt && !saving ? 'Saved' : ''}</span>
          <button className="btn sm primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : editable ? 'Save review' : 'Save notes'}</button>
        </div>
        <textarea className="form-input" value={notes} onChange={e => setNotes(e.target.value)} rows={5}
          placeholder="Wins, what to work on, and the plan for next month…" style={{ background: 'var(--surface-2)' }} />
      </div>
    </div>
  )
}

export default function ScorecardsPanel() {
  const { profile } = useAuth()
  const isMobile = useIsMobile()
  const today = new Date()
  const [profiles, setProfiles] = useState([])
  const [month, setMonth] = useState({ year: today.getFullYear(), month: today.getMonth() })
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS)
  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS)
  const [raw, setRaw] = useState(null)
  const [selected, setSelected] = useState(null)
  const [showRules, setShowRules] = useState(false)
  const [savingRules, setSavingRules] = useState(false)
  const [reload, setReload] = useState(0)
  const [sort, setSort] = useState('score')

  useEffect(() => {
    sb.from('profiles').select('id, name, email, avatar, role').eq('active', true).order('name')
      .then(({ data }) => setProfiles(data || []))
    Promise.all([
      sb.from('app_settings').select('value').eq('key', 'scorecard_weights').maybeSingle(),
      sb.from('app_settings').select('value').eq('key', 'scorecard_thresholds').maybeSingle(),
    ]).then(([{ data: w }, { data: t }]) => {
      try { if (w?.value) setWeights({ ...DEFAULT_WEIGHTS, ...JSON.parse(w.value) }) } catch {}
      try { if (t?.value) setThresholds({ ...DEFAULT_THRESHOLDS, ...JSON.parse(t.value) }) } catch {}
    })
  }, [])

  // This month + last month (for the deltas), scorecard rows and attendance.
  // Same-month reloads (after a save) keep the page on screen; only a month
  // change shows the skeleton.
  useEffect(() => {
    let dead = false
    const prev = shiftMonth(month, -1)
    ;(async () => {
      const [{ data: rows }, { data: pts }] = await Promise.all([
        sb.from('scorecard_actuals').select('*').in('month', [monthKey(month), monthKey(prev)]),
        sb.from('attendance_points').select('profile_id, points, date').gte('date', monthKey(prev)).lte('date', monthEnd(month)),
      ])
      if (!dead) setRaw({ key: monthKey(month), rows: rows || [], pts: pts || [] })
    })()
    return () => { dead = true }
  }, [month, reload])

  const data = useMemo(() => {
    if (!raw || raw.key !== monthKey(month)) return null
    const prev = shiftMonth(month, -1)
    const byMonth = (m) => new Map(raw.rows.filter(r => String(r.month).slice(0, 10) === m).map(r => [r.profile_id, r]))
    const attIn = (from, to) => {
      const out = new Map()
      for (const p of raw.pts) if (p.date >= from && p.date <= to) out.set(p.profile_id, (out.get(p.profile_id) || 0) + (Number(p.points) || 0))
      return out
    }
    const rows = byMonth(monthKey(month)), prevRows = byMonth(monthKey(prev))
    const att = attIn(monthKey(month), monthEnd(month)), prevAtt = attIn(monthKey(prev), monthEnd(prev))
    const pack = (row, pts) => row ? { attendance: pts || 0, booking_pct: row.booking_pct, booked_calls: row.booked_calls, call_quality: row.call_quality, memberships: row.memberships } : null
    return {
      rows, att,
      actuals: (id) => pack(rows.get(id), att.get(id)),
      score: (id) => { const a = pack(rows.get(id), att.get(id)); return a ? overallScore(a, weights, thresholds) : null },
      prevScore: (id) => { const a = pack(prevRows.get(id), prevAtt.get(id)); return a ? overallScore(a, weights, thresholds) : null },
    }
  }, [raw, month, weights, thresholds])

  const saveRules = async () => {
    setSavingRules(true)
    const at = new Date().toISOString()
    const [a, b] = await Promise.all([
      sb.from('app_settings').upsert({ key: 'scorecard_weights', value: JSON.stringify(weights), updated_at: at }, { onConflict: 'key' }),
      sb.from('app_settings').upsert({ key: 'scorecard_thresholds', value: JSON.stringify(thresholds), updated_at: at }, { onConflict: 'key' }),
    ])
    setSavingRules(false)
    if (a.error || b.error) toast('Couldn’t save the rules: ' + (a.error || b.error).message)
    else { toast('Scoring rules saved'); setShowRules(false) }
  }

  // The hourly sync owns the current and previous month; older months are frozen.
  const nowKey = monthKey({ year: today.getFullYear(), month: today.getMonth() })
  const editable = monthKey(month) < monthKey(shiftMonth({ year: today.getFullYear(), month: today.getMonth() }, -1))
  const vs = MONTH_NAMES[shiftMonth(month, -1).month].slice(0, 3)
  const reps = profiles.filter(p => p.role === 'rep')
  const others = profiles.filter(p => p.role !== 'rep' && p.role !== 'ops_manager')   // ops managers are field-side
  const rep = profiles.find(p => p.id === selected)

  const cards = data ? [...reps].sort((a, b) => {
    const sa = data.score(a.id), sb2 = data.score(b.id)
    if (sa == null || sb2 == null) return (sa == null) - (sb2 == null)
    return sort === 'improve' ? (sb2 - (data.prevScore(b.id) ?? sb2)) - (sa - (data.prevScore(a.id) ?? sa))
      : sort === 'name' ? String(a.name).localeCompare(String(b.name)) : sb2 - sa
  }) : []

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 99, padding: 3 }}>
          <button className="btn ghost sm" aria-label="Previous month" onClick={() => setMonth(m => shiftMonth(m, -1))} style={{ borderRadius: 99, padding: '4px 11px' }}>‹</button>
          <span style={{ fontSize: 13, fontWeight: 700, minWidth: 128, textAlign: 'center' }}>{MONTH_NAMES[month.month]} {month.year}</span>
          <button className="btn ghost sm" aria-label="Next month" disabled={monthKey(month) >= nowKey} onClick={() => setMonth(m => shiftMonth(m, 1))} style={{ borderRadius: 99, padding: '4px 11px' }}>›</button>
        </div>
        <select className="form-input" value={selected || ''} onChange={e => setSelected(e.target.value || null)}
          style={{ width: isMobile ? '100%' : 220, borderRadius: 99, padding: '7px 14px' }} aria-label="Open a scorecard">
          <option value="">All CSRs</option>
          <optgroup label="CSRs">{reps.map(p => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}</optgroup>
          {others.length > 0 && <optgroup label="Everyone else">{others.map(p => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}</optgroup>}
        </select>
        <button className={`btn${showRules ? ' primary' : ''}`} onClick={() => setShowRules(v => !v)} style={{ borderRadius: 99, marginLeft: isMobile ? 0 : 'auto' }}>
          Scoring rules
        </button>
      </div>

      {showRules && <RulesEditor weights={weights} thresholds={thresholds} setWeights={setWeights} setThresholds={setThresholds} onSave={saveRules} saving={savingRules} />}

      {!data ? (
        <>
          <div className="skel" style={{ height: 150, borderRadius: 16, marginBottom: 18 }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
            {[0, 1, 2].map(i => <div key={i} className="skel" style={{ height: 250, borderRadius: 14 }} />)}
          </div>
        </>
      ) : rep ? (
        <ReviewView key={`${rep.id}-${monthKey(month)}`} rep={rep} month={month} data={data} weights={weights} thresholds={thresholds} vs={vs}
          editable={editable} isMobile={isMobile} currentUserId={profile?.id}
          onBack={() => setSelected(null)} onSaved={() => setReload(x => x + 1)} />
      ) : (
        <>
          <TeamPanel reps={reps} data={data} weights={weights} thresholds={thresholds} vs={vs} isMobile={isMobile} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              {reps.length} CSR{reps.length === 1 ? '' : 's'}
              <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · click a card to open the review</span>
            </div>
            <div style={{ marginLeft: isMobile ? 0 : 'auto', width: isMobile ? '100%' : undefined }}>
              <Segmented value={sort} onChange={setSort} options={[['score', 'Top score'], ['improve', 'Most improved'], ['name', 'A–Z']]} fill={isMobile} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16, gridAutoRows: isMobile ? undefined : '1fr' }}>
            {cards.map(p => (
              <RepCard key={p.id} rep={p} actuals={data.actuals(p.id)} score={data.score(p.id)} prevScore={data.prevScore(p.id)}
                vs={vs} thresholds={thresholds} onOpen={() => setSelected(p.id)} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
