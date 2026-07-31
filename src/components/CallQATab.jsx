import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'

// Settings → Call QA: the rubric every inbound call is scored against.
// Plain text on purpose — the AI re-parses criteria and point values from
// this exact text on every evaluation, so an edit here changes scoring on
// the very next call. No redeploy, no retraining.

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
  const [rubric, setRubric] = useState(null)
  const [defaultRubric, setDefaultRubric] = useState('')
  const [minSeconds, setMinSeconds] = useState(60)
  const [enabled, setEnabled] = useState(true)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')

  useEffect(() => {
    authed('/api/admin/call-eval-config').then(d => {
      setRubric(d.cfg.rubric)
      setMinSeconds(d.cfg.minSeconds)
      setEnabled(d.cfg.enabled)
      setDefaultRubric(d.defaultRubric || '')
    }).catch(e => setErr(e.message))
  }, [])

  const save = async () => {
    if (saving) return
    setSaving(true); setErr(''); setSavedMsg('')
    try {
      await authed('/api/admin/call-eval-config', { method: 'POST', body: JSON.stringify({ rubric, minSeconds, enabled }) })
      setSavedMsg('Saved — the next inbound call is scored against this text.')
      setTimeout(() => setSavedMsg(''), 5000)
    } catch (e) { setErr(e.message) }
    setSaving(false)
  }

  if (err && rubric === null) return <div style={{ padding: 20, color: 'var(--danger)', fontSize: 13 }}>{err}</div>
  if (rubric === null) return <div className="spinner lg" style={{ margin: '60px auto' }} />

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 16 }}>
          Every answered inbound call longer than the minimum gets scored against this rubric — the AI reads
          the criteria and point values straight from the text below, so edits apply to the <b>very next call</b>.
          Write each criterion with its points, e.g. <i>"Verified address (5 pts) — asked for or confirmed the service address."</i>{' '}
          Criteria that don't apply on a call (no hold, caller already a member) are excluded from that call's denominator.
          Monthly averages feed the scorecard's Call Quality KPI automatically.
        </div>

        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', marginBottom: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            Evaluations on
          </label>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 4 }}>Min call length (sec)</div>
            <input type="number" min="0" max="600" className="form-input" style={{ width: 90 }} value={minSeconds}
              onChange={e => setMinSeconds(parseInt(e.target.value) || 0)} />
          </div>
          <button className="btn sm" style={{ marginLeft: 'auto' }}
            onClick={() => { if (window.confirm('Replace the editor contents with the original rubric?')) setRubric(defaultRubric) }}>
            Reset to original rubric
          </button>
        </div>

        <textarea value={rubric} onChange={e => setRubric(e.target.value)} rows={26} spellCheck={false}
          style={{ width: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: 1.55,
            padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)',
            color: 'var(--text-primary)', resize: 'vertical', boxSizing: 'border-box' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, paddingBottom: 30 }}>
          <button className="btn primary" onClick={save} disabled={saving} style={{ padding: '9px 26px', fontWeight: 700 }}>
            {saving ? 'Saving…' : 'Save rubric'}
          </button>
          {savedMsg && <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--success)' }}>{savedMsg}</span>}
          {err && <span style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</span>}
        </div>
      </div>
    </div>
  )
}
