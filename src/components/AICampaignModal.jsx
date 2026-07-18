import { useState } from 'react'
import { sb } from '../lib/supabase'
import Modal from './Modal'

// AI Campaign builder. Three steps in one modal:
//   1) describe   — type who you want to reach
//   2) preview    — server runs the ServiceTitan recipe, shows counts + a sample
//   3) commit     — name it and populate a new campaign
// Nothing hits the contacts table until the user confirms at step 3.

const EXAMPLES = [
  'Members whose membership expires in the next 3 months',
  'HVAC members due for maintenance in the next 60 days',
  'Everyone who had a repair completed in the last 6 months',
  'Customers tagged as a replacement opportunity',
]

const RECIPE_LABELS = {
  membership_expiring: 'Expiring / cancelled memberships',
  maintenance_due: 'Maintenance coming due',
  job_history: 'Past job follow-up',
  tag_type: 'Tagged customers',
}

async function authFetch(path, body) {
  const { data: { session } } = await sb.auth.getSession()
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export default function AICampaignModal({ onClose, onCreated }) {
  const [request, setRequest] = useState('')
  const [plan, setPlan] = useState(null)
  const [preview, setPreview] = useState(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')       // 'plan' | 'preview' | 'commit'
  const [err, setErr] = useState('')

  const reset = () => { setPlan(null); setPreview(null); setErr('') }

  const doPlan = async () => {
    if (!request.trim()) return
    setBusy('plan'); reset()
    try {
      const { plan } = await authFetch('/api/st/audience/plan', { request })
      setPlan(plan)
      setName(plan?.campaign_name || '')
    } catch (e) { setErr(e.message) } finally { setBusy('') }
  }

  const doPreview = async () => {
    setBusy('preview'); setErr('')
    try {
      const data = await authFetch('/api/st/audience/build', { plan, commit: false })
      setPreview(data)
    } catch (e) { setErr(e.message) } finally { setBusy('') }
  }

  const doCommit = async () => {
    setBusy('commit'); setErr('')
    try {
      const data = await authFetch('/api/st/audience/build', { plan, commit: true, campaign_name: name })
      onCreated?.(data)
    } catch (e) { setErr(e.message) } finally { setBusy('') }
  }

  const unsupported = plan && plan.recipe === 'unsupported'

  return (
    <Modal title="✨ Build a campaign with AI" onClose={onClose} width={620}>
      {/* Step 1 — describe */}
      <div className="form-field">
        <label className="form-label">Who do you want to reach?</label>
        <textarea className="form-input" value={request} autoFocus
          onChange={e => setRequest(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doPlan() }}
          placeholder="e.g. Members whose HVAC maintenance is due in the next 3 months"
          style={{ minHeight: 70 }} />
        <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '12px 0 8px' }}>Try one of these</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {EXAMPLES.map(x => (
            <button key={x} type="button" onClick={() => { setRequest(x); reset() }}
              style={{ fontSize: 12, padding: '7px 13px', borderRadius: 99, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', transition: 'all .1s', lineHeight: 1.3 }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}>
              {x}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button className="btn primary" onClick={doPlan} disabled={busy === 'plan' || !request.trim()}>
          {busy === 'plan' ? 'Reading…' : 'Interpret request'}
        </button>
      </div>

      {err && (
        <div style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger)', borderRadius: 'var(--radius)', padding: '10px 12px', fontSize: 12, color: 'var(--danger)', marginBottom: 12 }}>
          {err}
        </div>
      )}

      {/* Step 2 — readback + preview */}
      {plan && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 4 }}>
          {unsupported ? (
            <div style={{ background: 'var(--warning-bg, #fdf6e3)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)', padding: '10px 12px', fontSize: 13 }}>
              <strong>I can't build that one from ServiceTitan.</strong>
              <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>{plan.note || 'No matching data source for this request.'}</div>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                I can do: expiring/cancelled memberships, maintenance due, past-job follow-up, and tagged customers.
              </div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .5, color: 'var(--text-muted)', marginBottom: 6 }}>
                Here's what I'll pull · {RECIPE_LABELS[plan.recipe] || plan.recipe}
              </div>
              <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius)', padding: '12px 14px', fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
                {plan.readback}
              </div>

              {!preview && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="btn primary" onClick={doPreview} disabled={busy === 'preview'}>
                    {busy === 'preview' ? 'Searching ServiceTitan…' : 'Preview audience'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Preview results */}
      {preview && (
        <div style={{ marginTop: 6 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 12 }}>
            {[
              ['Dialable', preview.stats.dialable, 'success'],
              ['Matched', preview.stats.matched, null],
              ['DNC skipped', preview.stats.dncSkipped, null],
              ['Already in Andi', preview.stats.dupSkipped, null],
            ].map(([l, v, c]) => (
              <div key={l} style={{ textAlign: 'center', padding: '8px 4px', background: 'var(--surface-2)', borderRadius: 'var(--radius)' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: c ? `var(--${c})` : 'var(--text-primary)' }}>{v}</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: .5, marginTop: 2 }}>{l}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
            {preview.stats.noPhone > 0 && `${preview.stats.noPhone} had no phone number. `}
            {preview.stats.truncated && `Capped at the first ${preview.stats.resolved} of ${preview.stats.matched} matches — narrow the request for the rest. `}
          </div>

          {preview.stats.dialable > 0 ? (
            <>
              <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 14 }}>
                <table className="data-table" style={{ fontSize: 11 }}>
                  <thead><tr><th>Name</th><th>Phone</th><th>Why</th></tr></thead>
                  <tbody>
                    {preview.sample.map((r, i) => (
                      <tr key={i}>
                        <td style={{ padding: '5px 10px' }}>{r.name || '—'}</td>
                        <td style={{ padding: '5px 10px' }}>{r.phone}</td>
                        <td style={{ padding: '5px 10px', color: 'var(--text-muted)' }}>{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="form-field">
                <label className="form-label">Campaign name</label>
                <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="Name this campaign" />
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={onClose}>Cancel</button>
                <button className="btn primary" onClick={doCommit} disabled={busy === 'commit' || !name.trim()}>
                  {busy === 'commit' ? 'Creating…' : `Create campaign & add ${preview.stats.dialable} contacts`}
                </button>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
              No dialable contacts matched. Try widening the time window or a different request.
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
