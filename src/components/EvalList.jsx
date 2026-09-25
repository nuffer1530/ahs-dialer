import { useMemo } from 'react'
import { Ring, scoreTone, critName } from './CoachingSnapshots'

// Team → Coaching & Evals → All evals (and My Page → Call Evals). A summary
// strip over the list; with "Newest first" the calls group by Denver day.

const num = { fontVariantNumeric: 'tabular-nums' }
const eyebrow = { fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)' }
const when = (r) => r.call_at || r.created_at
const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Denver' })
const dayLabel = (iso) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Denver', weekday: 'long', month: 'short', day: 'numeric' })
const timeLabel = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' })
const shortDay = (iso) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric' })
const fmtPhone = (p) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : '' }
const initials = (n) => String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()
const avgOf = (rows) => rows.length ? Math.round(rows.reduce((s, r) => s + Number(r.pct || 0), 0) / rows.length) : null

function ScoreTile({ pct }) {
  const t = scoreTone(Number(pct))
  return (
    <div style={{ ...num, width: 40, height: 40, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 14, fontWeight: 800, letterSpacing: '-.02em', color: `var(--tone-${t}-tx)`, background: `var(--tone-${t}-bg)`, border: `1px solid var(--tone-${t}-bd)` }}>
      {Math.round(Number(pct))}
    </div>
  )
}

export function EvalSummary({ rows, isMobile }) {
  const avg = avgOf(rows)
  const bands = [
    ['green', '90+', rows.filter(r => Number(r.pct) >= 90).length],
    ['amber', '75–89', rows.filter(r => Number(r.pct) >= 75 && Number(r.pct) < 90).length],
    ['red', 'Under 75', rows.filter(r => Number(r.pct) < 75).length],
  ]
  // Most-missed criteria across exactly the calls on screen.
  const misses = useMemo(() => {
    const m = new Map()
    for (const r of rows) for (const it of (r.scores?.items || [])) {
      if (!it.applicable) continue
      const c = m.get(it.criterion) || { criterion: it.criterion, missed: 0, n: 0 }
      c.n++
      if ((Number(it.earned) || 0) < (Number(it.max) || 0)) c.missed++
      m.set(it.criterion, c)
    }
    return [...m.values()].filter(c => c.n >= 3 && c.missed).sort((a, b) => b.missed / b.n - a.missed / a.n).slice(0, 3)
  }, [rows])
  const divider = isMobile ? { borderTop: '1px solid var(--border)' } : { borderLeft: '1px solid var(--border)' }
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, marginBottom: 16, display: 'grid',
      gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(250px, 280px) minmax(0, 1fr) minmax(0, 1fr)' }}>
      <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16 }}>
        <Ring pct={avg || 0} size={72} stroke={7}>
          <div style={{ ...num, fontSize: 19, fontWeight: 800, color: `var(--tone-${avg == null ? 'gray' : scoreTone(avg)}-tx)` }}>
            {avg == null ? '—' : avg}<span style={{ fontSize: 11 }}>%</span>
          </div>
        </Ring>
        <div>
          <div style={eyebrow}>Average QA</div>
          <div style={{ ...num, fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{rows.length} evaluated call{rows.length === 1 ? '' : 's'}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Feeds the Call Quality KPI</div>
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
              <span style={{ color: 'var(--text-muted)' }}>{rows.length ? `${Math.round(n / rows.length * 100)}%` : ''}</span>
            </span>
          ))}
        </div>
      </div>
      <div style={{ padding: '16px 20px', minWidth: 0, ...divider }}>
        <div style={{ ...eyebrow, marginBottom: 10 }}>Most missed on these calls</div>
        {misses.length ? misses.map(m => {
          const rate = Math.round(m.missed / m.n * 100)
          return (
            <div key={m.criterion} className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 60px 44px', gap: 10, alignItems: 'center', fontSize: 12.5, marginBottom: 7 }}>
              <span title={m.criterion} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{critName(m.criterion)}</span>
              <div style={{ height: 6, borderRadius: 99, background: 'var(--surface-2)', overflow: 'hidden' }}>
                <div style={{ width: `${rate}%`, height: '100%', borderRadius: 99, background: `var(--tone-${rate >= 50 ? 'red' : rate >= 25 ? 'amber' : 'gray'}-tx)` }} />
              </div>
              <span style={{ ...num, textAlign: 'right', color: 'var(--text-secondary)' }}>{rate}%</span>
            </div>
          )
        }) : <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Not enough calls yet.</div>}
      </div>
    </div>
  )
}

function EvalRow({ r, isAdmin, isMobile, onOpen, showDay }) {
  const caller = r.contact_name || fmtPhone(r.phone) || 'Unknown caller'
  return (
    <button onClick={() => onOpen(r)} className="eval-row"
      style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 14, padding: isMobile ? '10px 12px' : '11px 18px',
        border: 'none', borderTop: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'inherit', font: 'inherit' }}>
      <ScoreTile pct={r.pct} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{caller}</span>
          {isAdmin && r.rep && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
              <span style={{ width: 18, height: 18, borderRadius: 99, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 8.5, fontWeight: 800 }}>
                {initials(r.rep)}
              </span>
              {r.rep}
            </span>
          )}
        </div>
        {r.summary && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis',
            ...(isMobile ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } : { whiteSpace: 'nowrap' }) }}>
            {r.summary}
          </div>
        )}
      </div>
      <div style={{ ...num, fontSize: 11.5, color: 'var(--text-muted)', flexShrink: 0, textAlign: 'right' }}>
        {showDay && <div>{shortDay(when(r))}</div>}
        <div>{timeLabel(when(r))}</div>
      </div>
      <span aria-hidden="true" style={{ color: 'var(--text-muted)', fontSize: 16, flexShrink: 0 }}>›</span>
    </button>
  )
}

export default function EvalList({ rows, grouped, isAdmin, isMobile, onOpen }) {
  const groups = useMemo(() => {
    if (!grouped) return [{ key: 'all', rows }]
    const out = []
    for (const r of rows) {
      const k = dayKey(when(r))
      if (!out.length || out[out.length - 1].key !== k) out.push({ key: k, label: dayLabel(when(r)), rows: [] })
      out[out.length - 1].rows.push(r)
    }
    return out
  }, [rows, grouped])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {groups.map(g => {
        const avg = avgOf(g.rows)
        return (
          <div key={g.key} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }}>
            {grouped && (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: isMobile ? '10px 12px' : '11px 18px', background: 'var(--surface-2)' }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{g.label}</span>
                <span style={{ ...num, fontSize: 12, color: 'var(--text-muted)' }}>{g.rows.length} call{g.rows.length === 1 ? '' : 's'}</span>
                <span style={{ ...num, marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: `var(--tone-${scoreTone(avg)}-tx)` }}>avg {avg}%</span>
              </div>
            )}
            <div style={{ marginTop: grouped ? 0 : -1 }}>
              {g.rows.map(r => <EvalRow key={r.id} r={r} isAdmin={isAdmin} isMobile={isMobile} onOpen={onOpen} showDay={!grouped} />)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
