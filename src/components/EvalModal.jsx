// Call-evaluation breakdown — shared by My Page and the Recordings tab.
// Shows per-criterion points with evidence, the coaching summary, and the
// one-thing-to-fix tip. N/A criteria are visibly excluded from the math.

const scoreTone = (pct) => pct >= 90 ? 'green' : pct >= 75 ? 'amber' : 'red'

export function ScoreChip({ pct, onClick, size = 'sm' }) {
  if (pct == null) return null
  const t = scoreTone(Number(pct))
  return (
    <button onClick={onClick} title="Open the call evaluation"
      style={{ fontSize: size === 'sm' ? 10 : 12, fontWeight: 800, padding: size === 'sm' ? '2px 8px' : '4px 12px',
        borderRadius: 99, cursor: onClick ? 'pointer' : 'default',
        background: `var(--tone-${t}-bg)`, color: `var(--tone-${t}-tx)`, border: `1px solid var(--tone-${t}-bd)` }}>
      QA {Math.round(Number(pct))}
    </button>
  )
}

export default function EvalModal({ evalRow, onClose }) {
  if (!evalRow) return null
  const items = evalRow.scores?.items || []
  const tip = evalRow.scores?.coaching_tip
  const t = scoreTone(Number(evalRow.pct))
  const when = evalRow.created_at
    ? new Date(evalRow.created_at).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 640, maxWidth: '96vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', overflow: 'hidden' }}>

        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div style={{ width: 52, height: 52, borderRadius: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            background: `var(--tone-${t}-bg)`, border: `1.5px solid var(--tone-${t}-bd)`, color: `var(--tone-${t}-tx)`, flexShrink: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 900, lineHeight: 1 }}>{Math.round(Number(evalRow.pct))}</div>
            <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: .5 }}>SCORE</div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800 }}>Call Evaluation — {evalRow.rep || 'Unknown rep'}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
              {evalRow.contact_name || 'Unknown caller'} · {when} · {evalRow.earned}/{evalRow.possible} pts
            </div>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'var(--surface-2)', width: 28, height: 28, borderRadius: 8, cursor: 'pointer', fontSize: 15, color: 'var(--text-secondary)', flexShrink: 0 }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          {evalRow.summary && (
            <div style={{ fontSize: 12.5, lineHeight: 1.55, padding: '10px 13px', background: 'var(--surface-2)', borderRadius: 10, marginBottom: 10 }}>
              {evalRow.summary}
            </div>
          )}
          {tip && (
            <div style={{ fontSize: 12.5, lineHeight: 1.5, padding: '10px 13px', borderRadius: 10, marginBottom: 14,
              background: 'var(--tone-blue-bg)', border: '1px solid var(--tone-blue-bd)', color: 'var(--tone-blue-tx)' }}>
              <b>Next call:</b> {tip}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map((it, i) => {
              const full = it.applicable && it.earned >= it.max
              const zero = it.applicable && it.earned === 0
              return (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 11px', borderRadius: 9,
                  background: 'var(--surface)', border: '1px solid var(--border)', opacity: it.applicable ? 1 : .55 }}>
                  <div style={{ width: 44, flexShrink: 0, textAlign: 'center' }}>
                    <div style={{ fontSize: 13, fontWeight: 800,
                      color: !it.applicable ? 'var(--text-muted)' : full ? 'var(--tone-green-tx)' : zero ? 'var(--tone-red-tx)' : 'var(--tone-amber-tx)' }}>
                      {it.applicable ? `${it.earned}/${it.max}` : 'N/A'}
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700 }}>{it.criterion}</div>
                    {it.evidence && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>{it.evidence}</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 10 }}>
            N/A items are excluded from the score — this call was graded out of {evalRow.possible} points.
          </div>
        </div>
      </div>
    </div>
  )
}
