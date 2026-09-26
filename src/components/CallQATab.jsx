import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { confirmDlg } from '../lib/dialogs'
import { useIsMobile } from '../lib/useIsMobile'
import { ToneChip, eyebrow, panel, num } from './ui'

// Settings → Call QA: structured rubric editor. Sections carry a % weight,
// questions carry possible points + guidance text — the AI scores exactly
// what's written here, so a saved edit changes scoring on the very next call.

async function authed(path, opts = {}) {
  const { data: { session } } = await sb.auth.getSession()
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}`, ...(opts.headers || {}) },
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`)
  return d
}

export default function CallQATab() {
  const [sections, setSections] = useState(null)
  const [defaults, setDefaults] = useState([])
  const [minSeconds, setMinSeconds] = useState(60)
  const [enabled, setEnabled] = useState(true)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const isMobile = useIsMobile()

  useEffect(() => {
    authed('/api/admin/call-eval-config').then(d => {
      setSections(d.cfg.sections)
      setMinSeconds(d.cfg.minSeconds)
      setEnabled(d.cfg.enabled)
      setDefaults(d.defaultSections || [])
    }).catch(e => setErr(e.message))
  }, [])

  const save = async () => {
    if (saving) return
    setSaving(true); setErr(''); setSavedMsg('')
    try {
      const d = await authed('/api/admin/call-eval-config', { method: 'POST', body: JSON.stringify({ sections, minSeconds, enabled }) })
      setSections(d.cfg.sections)
      setSavedMsg('Saved — the next inbound call is scored against this rubric.')
      setTimeout(() => setSavedMsg(''), 5000)
    } catch (e) { setErr(e.message) }
    setSaving(false)
  }

  // Immutable helpers
  const setSec = (si, patch) => setSections(ss => ss.map((s, i) => i === si ? { ...s, ...patch } : s))
  const setItem = (si, qi, patch) => setSections(ss => ss.map((s, i) => i === si
    ? { ...s, items: s.items.map((it, j) => j === qi ? { ...it, ...patch } : it) } : s))
  const addItem = (si) => setSections(ss => ss.map((s, i) => i === si
    ? { ...s, items: [...s.items, { question: '', points: 5, guidance: '' }] } : s))
  const removeItem = (si, qi) => setSections(ss => ss.map((s, i) => i === si
    ? { ...s, items: s.items.filter((_, j) => j !== qi) } : s))
  const removeSection = async (si) => {
    if (!(await confirmDlg(`Delete the "${sections[si].name || 'unnamed'}" section and all its questions?`, { title: 'Delete section', confirmLabel: 'Delete', danger: true }))) return
    setSections(ss => ss.filter((_, i) => i !== si))
  }

  const pad = isMobile ? 12 : 24
  if (err && sections === null) return (
    <div style={{ padding: pad }}>
      <div style={{ padding: '10px 14px', borderRadius: 12, fontSize: 12.5, background: 'var(--tone-red-bg)', border: '1px solid var(--tone-red-bd)', color: 'var(--tone-red-tx)' }}>{err}</div>
    </div>
  )
  if (sections === null) return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ padding: pad, maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="skel" style={{ height: 150, borderRadius: 16 }} />
        <div className="skel" style={{ height: 280, borderRadius: 16 }} />
      </div>
    </div>
  )

  const weightSum = sections.reduce((a, s) => a + (Number(s.weight) || 0), 0)
  const input = { border: '1px solid var(--border-strong)', borderRadius: 10, padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit', background: 'var(--surface)', color: 'var(--text-primary)', boxSizing: 'border-box' }
  const lbl = { ...eyebrow, marginBottom: 4 }
  // Section header / row / footer padding — the kit's 14px 20px, tighter on a phone.
  const headPad = isMobile ? '12px 14px' : '14px 20px'
  const rowPad = isMobile ? '12px 14px' : '12px 20px'

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ padding: pad, maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: isMobile ? 16 : 90 }}>
        <div style={panel}>
          <div style={{ padding: headPad, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, lineHeight: 1.3 }}>Call QA rubric</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 2 }}>
                Every answered inbound call longer than the minimum is scored against this rubric — the AI reads exactly
                what's written here, so a saved edit changes scoring on the <b>very next call</b>. Each section scores on its own
                questions, then sections combine by their percentage weight. Questions that don't apply on a call (no hold,
                caller already a member) drop out of that call's math. Monthly averages feed the scorecard's Call Quality KPI.
              </div>
            </div>
            <ToneChip tone={weightSum === 100 ? 'green' : 'amber'}>Weights total {weightSum}%</ToneChip>
          </div>

          <div style={{ padding: isMobile ? 14 : '16px 20px', display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', paddingBottom: 8 }}>
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              Evaluations on
            </label>
            <div>
              <div style={lbl}>Min call length (sec)</div>
              <input type="number" min="0" max="600" style={{ ...input, ...num, width: 90 }} value={minSeconds}
                onChange={e => setMinSeconds(parseInt(e.target.value) || 0)} />
            </div>
            {weightSum !== 100 && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 'auto', maxWidth: 360, paddingBottom: 8 }}>Doesn't need to be exactly 100 — scores renormalize — but 100 keeps it readable.</div>
            )}
          </div>
        </div>

        {sections.map((s, si) => (
          <div key={si} style={panel}>
            <div style={{ padding: headPad, borderBottom: '1px solid var(--border)', display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={lbl}>Section</div>
                <input style={{ ...input, width: '100%', fontWeight: 700, fontSize: 13.5 }} value={s.name} placeholder="Section name"
                  onChange={e => setSec(si, { name: e.target.value })} />
              </div>
              <div>
                <div style={lbl}>Weight %</div>
                <input type="number" min="0" max="100" style={{ ...input, ...num, width: 80 }} value={s.weight}
                  onChange={e => setSec(si, { weight: Math.max(0, parseInt(e.target.value) || 0) })} />
              </div>
              <div style={{ ...num, fontSize: 12, color: 'var(--text-muted)', paddingBottom: 8 }}>
                {s.items.reduce((a, i) => a + (Number(i.points) || 0), 0)} pts across {s.items.length} question{s.items.length === 1 ? '' : 's'}
              </div>
              <button className="btn sm" style={{ marginLeft: 'auto', borderRadius: 99 }} onClick={() => removeSection(si)}>Delete section</button>
            </div>

            <div>
              {s.items.map((it, qi) => (
                <div key={qi} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: rowPad, borderTop: qi ? '1px solid var(--border)' : 'none' }}>
                  <div style={{ width: 62, flexShrink: 0 }}>
                    <div style={lbl}>Points</div>
                    <input type="number" min="1" max="100" style={{ ...input, ...num, width: '100%' }} value={it.points}
                      onChange={e => setItem(si, qi, { points: Math.max(1, parseInt(e.target.value) || 1) })} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={lbl}>Question</div>
                    <input style={{ ...input, width: '100%', fontWeight: 600 }} value={it.question}
                      placeholder="What should the CSR have done?"
                      onChange={e => setItem(si, qi, { question: e.target.value })} />
                    <div style={{ ...lbl, marginTop: 8 }}>What the AI listens for</div>
                    <textarea rows={2} style={{ ...input, width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 }}
                      value={it.guidance}
                      placeholder='Example phrases, what earns full points, when it&#39;s N/A…'
                      onChange={e => setItem(si, qi, { guidance: e.target.value })} />
                  </div>
                  <button onClick={() => removeItem(si, qi)} title="Remove question"
                    style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, padding: '18px 2px 0', flexShrink: 0 }}>×</button>
                </div>
              ))}
            </div>
            <div style={{ padding: rowPad, borderTop: s.items.length ? '1px solid var(--border)' : 'none' }}>
              <button className="btn sm" style={{ borderRadius: 99 }} onClick={() => addItem(si)}>+ Add question</button>
            </div>
          </div>
        ))}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn sm" style={{ borderRadius: 99 }} onClick={() => setSections(ss => [...ss, { name: '', weight: 0, items: [{ question: '', points: 5, guidance: '' }] }])}>
            + Add section
          </button>
          <button className="btn sm" style={{ borderRadius: 99 }} onClick={async () => {
            if (await confirmDlg('Replace the whole rubric with the original from the evaluation sheet?', { title: 'Reset rubric', confirmLabel: 'Reset' })) setSections(JSON.parse(JSON.stringify(defaults)))
          }}>
            Reset to original rubric
          </button>
        </div>
      </div>

      {/* Sticky save bar */}
      <div style={{ position: 'sticky', bottom: 0, background: 'var(--surface)', borderTop: '1px solid var(--border)', padding: isMobile ? '10px 12px' : '12px 24px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={save} disabled={saving} style={{ padding: '9px 26px', fontWeight: 700, borderRadius: 99 }}>
          {saving ? 'Saving…' : 'Save rubric'}
        </button>
        {savedMsg && <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tone-green-tx)' }}>{savedMsg}</span>}
        {err && <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tone-red-tx)' }}>{err}</span>}
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 'auto' }}>Applies to the next inbound call after saving.</span>
      </div>
    </div>
  )
}
