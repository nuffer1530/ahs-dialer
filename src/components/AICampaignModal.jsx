import { useState } from 'react'
import { sb } from '../lib/supabase'
import { useData } from '../lib/DataContext'
import Modal from './Modal'
import { Stat, ToneChip, eyebrow, num } from './ui'

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

const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : v)
const stepHeading = { display: 'block', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }
const stepRule = { borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 16 }
const cellTh = { position: 'sticky', top: 0, zIndex: 1, padding: '8px 12px' }
const cellTd = { padding: '6px 12px' }

const CheckIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
)

// Step heading: a numbered dot (a check once that step is behind you) and an
// eyebrow label.
function StepLabel({ n, label, done }) {
  const t = done ? 'green' : 'blue'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <span aria-hidden="true" style={{ ...num, width: 20, height: 20, borderRadius: 99, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10.5, fontWeight: 800, color: `var(--tone-${t}-tx)`, background: `var(--tone-${t}-bg)`, border: `1px solid var(--tone-${t}-bd)` }}>
        {done ? <CheckIcon /> : n}
      </span>
      <span style={eyebrow}>Step {n} · {label}</span>
    </div>
  )
}

export default function AICampaignModal({ onClose, onCreated }) {
  const { campaigns } = useData()
  const [request, setRequest] = useState('')
  // '' = a new campaign; otherwise fill an existing one (e.g. a "Memberships"
  // campaign that was set up by hand and never had contacts).
  const [targetId, setTargetId] = useState('')
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
      const data = await authFetch('/api/st/audience/build', { plan, commit: true, campaign_name: name, target_campaign_id: targetId || undefined })
      onCreated?.(data)
    } catch (e) { setErr(e.message) } finally { setBusy('') }
  }

  const unsupported = plan && plan.recipe === 'unsupported'

  return (
    <Modal title="Build a campaign with AI" onClose={onClose} width={620}>
      {/* Step 1 — describe */}
      <StepLabel n={1} label="Describe" done={!!plan} />
      <div className="form-field">
        <label htmlFor="ai-campaign-request" style={stepHeading}>Who do you want to reach?</label>
        <textarea id="ai-campaign-request" className="form-input" value={request} autoFocus
          onChange={e => setRequest(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doPlan() }}
          placeholder="e.g. Members whose HVAC maintenance is due in the next 3 months"
          style={{ minHeight: 70 }} />
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '12px 0 8px' }}>Try one of these</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {EXAMPLES.map(x => (
            <button key={x} type="button" onClick={() => { setRequest(x); reset() }}
              style={{ fontSize: 12, padding: '6px 12px', borderRadius: 99, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-secondary)', cursor: 'pointer', transition: 'border-color .12s, color .12s', lineHeight: 1.3, textAlign: 'left' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)' }}>
              {x}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn primary" onClick={doPlan} disabled={busy === 'plan' || !request.trim()}>
          {busy === 'plan' ? 'Reading…' : 'Interpret request'}
        </button>
      </div>

      {err && (
        <div style={{ background: 'var(--tone-red-bg)', border: '1px solid var(--tone-red-bd)', borderRadius: 12, padding: '10px 12px', fontSize: 12.5, color: 'var(--tone-red-tx)', marginTop: 12 }}>
          {err}
        </div>
      )}

      {/* Step 2 — readback + preview */}
      {plan && (
        <div style={stepRule}>
          <StepLabel n={2} label="Review" done={!!preview} />
          {unsupported ? (
            <div style={{ background: 'var(--tone-amber-bg)', border: '1px solid var(--tone-amber-bd)', borderRadius: 12, padding: '12px 14px', fontSize: 13, color: 'var(--text-primary)' }}>
              <strong style={{ color: 'var(--tone-amber-tx)' }}>I can't build that one from ServiceTitan.</strong>
              <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>{plan.note || 'No matching data source for this request.'}</div>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                I can do: expiring/cancelled memberships, maintenance due, past-job follow-up, and tagged customers.
              </div>
            </div>
          ) : (
            <>
              <div style={{ ...stepHeading, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                Here's what I'll pull
                <ToneChip tone="blue" small>{RECIPE_LABELS[plan.recipe] || plan.recipe}</ToneChip>
              </div>
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', fontSize: 13, lineHeight: 1.55, color: 'var(--text-primary)' }}>
                {plan.readback}
              </div>

              {!preview && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                  <button className="btn primary" onClick={doPreview} disabled={busy === 'preview'}>
                    {busy === 'preview' ? 'Searching ServiceTitan — can take a minute…' : 'Preview audience'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Step 3 — preview results, then create */}
      {preview && (
        <div style={stepRule}>
          <StepLabel n={3} label="Create" />
          {/* Tiles bottom-align their stat so the numbers line up even if a label wraps. */}
          <div className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 10 }}>
            {[
              ['Dialable', preview.stats.dialable, 'green'],
              ['Matched', preview.stats.matched, null],
              ['DNC skipped', preview.stats.dncSkipped, 'gray'],
              ['Already in Andi', preview.stats.dupSkipped, 'gray'],
            ].map(([l, v, t]) => (
              <div key={l} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', minWidth: 0, display: 'flex', alignItems: 'flex-end' }}>
                <Stat label={l} value={fmt(v)} tone={t || undefined} />
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            {preview.stats.noPhone > 0 && `${preview.stats.noPhone} had no phone number. `}
            {preview.stats.truncated && `Capped at the first ${preview.stats.resolved} of ${preview.stats.matched} matches — narrow the request for the rest. `}
          </div>

          {preview.stats.dialable > 0 ? (
            <>
              <div style={{ ...eyebrow, marginBottom: 6 }}>Sample · {fmt(preview.sample.length)} of {fmt(preview.stats.dialable)}</div>
              <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 12, marginBottom: 14 }}>
                <table className="data-table" style={{ fontSize: 11.5 }}>
                  <thead><tr><th style={cellTh}>Name</th><th style={cellTh}>Phone</th><th style={cellTh}>Why</th></tr></thead>
                  <tbody>
                    {preview.sample.map((r, i) => (
                      <tr key={i}>
                        <td style={{ ...cellTd, fontWeight: 600 }}>{r.name || '—'}</td>
                        <td style={{ ...cellTd, whiteSpace: 'nowrap' }}>{r.phone}</td>
                        <td style={{ ...cellTd, color: 'var(--text-muted)' }}>{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="form-field">
                <label className="form-label">Add these contacts to</label>
                <select className="form-input" value={targetId} onChange={e => setTargetId(e.target.value)}>
                  <option value="">A new campaign</option>
                  {campaigns.filter(c => c.name !== 'Leads').map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              {!targetId && (
                <div className="form-field">
                  <label className="form-label">Campaign name</label>
                  <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="Name this campaign" />
                </div>
              )}
              <div className="modal-actions">
                <button className="btn" onClick={onClose}>Cancel</button>
                <button className="btn primary" onClick={doCommit} disabled={busy === 'commit' || (!targetId && !name.trim())}>
                  {busy === 'commit' ? 'Saving…'
                    : targetId ? `Add ${preview.stats.dialable} contacts to ${campaigns.find(c => c.id === targetId)?.name || 'campaign'}`
                    : `Create campaign & add ${preview.stats.dialable} contacts`}
                </button>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '14px 16px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, textAlign: 'center' }}>
              No dialable contacts matched. Try widening the time window or a different request.
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
