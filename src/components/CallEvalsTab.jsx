import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import EvalModal, { ScoreChip } from './EvalModal'

// My Page → Call Evals. Reps see their own scored inbound calls; admins see
// the whole team with rep + month filters. Every row opens the full breakdown.

const monthNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit' })
    .formatToParts(new Date()).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}`
}

export default function CallEvalsTab({ profile, isAdmin }) {
  const [month, setMonth] = useState(monthNow())
  const [repFilter, setRepFilter] = useState('')
  const [profiles, setProfiles] = useState([])
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(null)

  useEffect(() => {
    if (isAdmin) sb.from('profiles').select('id, name, email').eq('active', true).order('name').then(({ data }) => setProfiles(data || []))
  }, [isAdmin])

  useEffect(() => {
    const [y, m] = month.split('-').map(Number)
    const start = new Date(y, m - 1, 1).toISOString()
    const end = new Date(y, m, 1).toISOString()
    sb.from('call_evaluations').select('*')
      .gte('created_at', start).lt('created_at', end)
      .order('created_at', { ascending: false }).limit(500)
      .then(({ data }) => setRows(data || []))
  }, [month])

  if (rows === null) return <div className="spinner lg" style={{ margin: '50px auto' }} />

  const myName = profile?.name || profile?.email
  const shown = rows.filter(r => {
    if (!isAdmin) return r.profile_id === profile?.id || r.rep === myName
    if (repFilter) return r.rep === repFilter || r.profile_id === repFilter
    return true
  })
  const avg = shown.length ? Math.round(shown.reduce((s, r) => s + Number(r.pct || 0), 0) / shown.length) : null
  const avgTone = avg == null ? 'gray' : avg >= 90 ? 'green' : avg >= 75 ? 'amber' : 'red'

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 4 }}>Month</div>
          <input type="month" className="form-input" value={month} onChange={e => e.target.value && setMonth(e.target.value)} />
        </div>
        {isAdmin && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 4 }}>Rep</div>
            <select className="form-input" value={repFilter} onChange={e => setRepFilter(e.target.value)} style={{ minWidth: 160 }}>
              <option value="">Whole team</option>
              {profiles.map(p => <option key={p.id} value={p.name || p.email}>{p.name || p.email}</option>)}
            </select>
          </div>
        )}
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: 26, fontWeight: 900, color: `var(--tone-${avgTone}-tx)`, lineHeight: 1 }}>{avg == null ? '—' : `${avg}%`}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>
            avg of {shown.length} evaluated call{shown.length === 1 ? '' : 's'} · feeds the Call Quality KPI
          </div>
        </div>
      </div>

      {shown.length === 0 ? (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          No evaluated calls this month yet. Inbound calls over a minute are scored automatically a few minutes after they end.
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          {shown.map((r, i) => (
            <div key={r.id} onClick={() => setOpen(r)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer',
                borderBottom: i < shown.length - 1 ? '1px solid var(--border)' : 'none' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <ScoreChip pct={r.pct} size="md" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.contact_name || 'Unknown caller'}
                  {isAdmin && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {r.rep || '—'}</span>}
                </div>
                {r.summary && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.summary}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                {new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </div>
            </div>
          ))}
        </div>
      )}

      {open && <EvalModal evalRow={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
