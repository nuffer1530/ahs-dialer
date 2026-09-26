// Call-evaluation breakdown — shared by My Page and the Recordings tab.
// Shows per-criterion points with evidence, the coaching summary, and the
// one-thing-to-fix tip. N/A criteria are visibly excluded from the math.

import { useEffect, useState } from 'react'
import { sb } from '../lib/supabase'
import { useIsMobile } from '../lib/useIsMobile'
import { Ring, ToneChip, eyebrow, num } from './ui'

const scoreTone = (pct) => pct >= 90 ? 'green' : pct >= 75 ? 'amber' : 'red'

const TargetIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.8" fill="currentColor" /></svg>
)

// Resolve a playable URL for the eval's recording. Andi-native evals carry a
// Twilio recording sid (open proxy, unguessable sid); ServiceTitan-sweep
// evals carry 'st-<callId>' and need a short-lived signed URL first.
function useRecordingUrl(recordingSid) {
  const [url, setUrl] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    setUrl(null); setErr(null)
    if (!recordingSid) return
    if (!String(recordingSid).startsWith('st-')) { setUrl(`/api/twilio/recording/${recordingSid}`); return }
    let dead = false
    ;(async () => {
      try {
        const { data: { session } } = await sb.auth.getSession()
        const r = await fetch(`/api/st/recording-url/${recordingSid}`, { headers: { Authorization: `Bearer ${session?.access_token}` } })
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || 'No recording')
        if (!dead) setUrl(d.url)
      } catch (e) { if (!dead) setErr(e.message) }
    })()
    return () => { dead = true }
  }, [recordingSid])
  return { url, err }
}

// `style` lets a caller resize the chip (the phone recordings list makes it a
// thumb-sized button); it layers over the defaults and is normally absent.
export function ScoreChip({ pct, onClick, size = 'sm', style }) {
  if (pct == null) return null
  const t = scoreTone(Number(pct))
  return (
    <button onClick={onClick} title="Open the call evaluation"
      style={{ fontSize: size === 'sm' ? 10 : 12, fontWeight: 800, padding: size === 'sm' ? '2px 8px' : '4px 12px',
        borderRadius: 99, cursor: onClick ? 'pointer' : 'default',
        background: `var(--tone-${t}-bg)`, color: `var(--tone-${t}-tx)`, border: `1px solid var(--tone-${t}-bd)`, ...style }}>
      QA {Math.round(Number(pct))}
    </button>
  )
}

export default function EvalModal({ evalRow, onClose }) {
  const { url: audioUrl, err: audioErr } = useRecordingUrl(evalRow?.recording_sid)
  // Phone: edge-to-edge sheet, the player on its own line, a 40px close.
  const isMobile = useIsMobile()
  if (!evalRow) return null
  const items = evalRow.scores?.items || []
  const fromST = String(evalRow.call_sid || '').startsWith('st-')
  const tip = evalRow.scores?.coaching_tip
  const t = scoreTone(Number(evalRow.pct))
  const when = evalRow.created_at
    ? new Date(evalRow.created_at).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: isMobile ? 8 : 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 640, maxWidth: isMobile ? '100%' : '96vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: 'var(--surface)',
          borderRadius: isMobile ? 16 : 18, border: '1px solid var(--border)', overflow: 'hidden', boxShadow: '0 24px 60px -20px rgba(15,20,40,.35)' }}>

        <div style={{ padding: isMobile ? '12px 12px' : '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: isMobile ? 12 : 14, flexShrink: 0 }}>
          <Ring pct={Number(evalRow.pct)} size={isMobile ? 52 : 58} stroke={5} tone={t}>
            <div style={{ ...num, fontSize: isMobile ? 16 : 17, fontWeight: 800, letterSpacing: '-.02em', color: `var(--tone-${t}-tx)` }}>
              {Math.round(Number(evalRow.pct))}<span style={{ fontSize: 10 }}>%</span>
            </div>
          </Ring>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={eyebrow}>Call evaluation</div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-.01em', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {evalRow.rep || 'Unknown rep'}
            </div>
            <div style={{ ...num, fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {evalRow.contact_name || (evalRow.phone ? `(${String(evalRow.phone).slice(0,3)}) ${String(evalRow.phone).slice(3,6)}-${String(evalRow.phone).slice(6)}` : 'Unknown caller')} · {when} · {evalRow.earned}/{evalRow.possible} pts
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close"
            style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', width: isMobile ? 40 : 30, height: isMobile ? 40 : 30, borderRadius: 99, cursor: 'pointer',
              fontSize: 16, lineHeight: 1, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', flexShrink: 0 }}>×</button>
        </div>

        {(audioUrl || audioErr) && (
          <div style={{ padding: isMobile ? '10px 12px' : '10px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-2)', flexShrink: 0, flexWrap: isMobile ? 'wrap' : undefined }}>
            {audioUrl ? (
              <>
                <audio controls preload="none" src={audioUrl} style={isMobile ? { width: '100%', minWidth: 0, height: 34 } : { flex: 1, height: 34 }} />
                <a href={`${audioUrl}${audioUrl.includes('?') ? '&' : '?'}download=1`} title="Download recording" className="btn sm"
                  style={{ borderRadius: 99, ...(isMobile ? { minHeight: 40, padding: '0 16px' } : {}) }}>Download</a>
              </>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Recording unavailable — {audioErr}</span>
            )}
            {fromST && <ToneChip tone="gray" small>via ServiceTitan</ToneChip>}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? 12 : '16px 20px 18px' }}>
          {evalRow.summary && (
            <div style={{ padding: '11px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, marginBottom: 10 }}>
              <div style={{ ...eyebrow, marginBottom: 5 }}>Call summary</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>{evalRow.summary}</div>
            </div>
          )}
          {tip && (
            <div style={{ padding: '11px 14px', borderRadius: 12, marginBottom: 16,
              background: 'var(--tone-blue-bg)', border: '1px solid var(--tone-blue-bd)' }}>
              <div style={{ ...eyebrow, color: 'var(--tone-blue-tx)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
                <TargetIcon /> Next call
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>{tip}</div>
            </div>
          )}

          {(() => {
            // Group items under their sections (new rows); old rows without
            // section data fall through to one flat group.
            const secDefs = evalRow.scores?.sections?.length ? evalRow.scores.sections : [{ name: null, weight: null, pct: null }]
            const grouped = secDefs.map(sd => ({
              ...sd,
              rows: items.filter(it => sd.name == null || String(it.section || '').toLowerCase() === sd.name.toLowerCase()),
            }))
            const claimed = new Set(grouped.flatMap(g => g.rows))
            const orphans = items.filter(it => !claimed.has(it))
            if (orphans.length) grouped.push({ name: 'Other', weight: null, pct: null, rows: orphans })
            return grouped.filter(g => g.rows.length).map((g, gi) => (
              <div key={gi} style={{ marginBottom: 14 }}>
                {g.name != null && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, padding: '0 2px' }}>
                    <span style={{ ...eyebrow, color: 'var(--text-secondary)' }}>{g.name}</span>
                    {g.weight != null && <span style={{ ...num, fontSize: 11, color: 'var(--text-muted)' }}>{g.weight}% of score</span>}
                    {g.pct != null && (
                      <span style={{ marginLeft: 'auto' }}>
                        <ToneChip tone={scoreTone(g.pct)} small>{Math.round(g.pct)}%</ToneChip>
                      </span>
                    )}
                  </div>
                )}
                <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                  {g.rows.map((it, i) => {
                    const full = it.applicable && it.earned >= it.max
                    const zero = it.applicable && it.earned === 0
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: isMobile ? '9px 10px' : '10px 14px',
                        borderTop: i ? '1px solid var(--border)' : 'none', opacity: it.applicable ? 1 : .55 }}>
                        <div style={{ width: 52, flexShrink: 0, display: 'flex', justifyContent: 'center', paddingTop: 1 }}>
                          <ToneChip tone={!it.applicable ? 'gray' : full ? 'green' : zero ? 'red' : 'amber'}>
                            {it.applicable ? `${it.earned}/${it.max}` : 'N/A'}
                          </ToneChip>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 650 }}>{it.criterion}</div>
                          {it.evidence && (
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>{it.evidence}</div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          })()}
          <div style={{ ...num, fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            N/A items are excluded from the score — this call was graded out of {evalRow.possible} points.
          </div>
        </div>
      </div>
    </div>
  )
}
