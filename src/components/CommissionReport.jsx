import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

// Commission payouts view — team money. Lives on the Team page; Settings
// keeps only configuration. (Extracted from AdminPage Aug 2026.)
const RANGES = {
  week:    { label: 'This week',   days: null },
  month:   { label: 'This month',  days: null },
  last30:  { label: 'Last 30 days', days: 30 },
  last90:  { label: 'Last 90 days', days: 90 },
  all:     { label: 'All time',    days: null },
}

const ST_JOB_URL = (jobId) => `https://go.servicetitan.com/#/Job/Index/${jobId}`

function rangeBounds(key) {
  const now = new Date()
  if (key === 'week') {
    const d = now.getDay()
    const monday = new Date(now)
    monday.setDate(now.getDate() - (d === 0 ? 6 : d - 1))
    monday.setHours(0, 0, 0, 0)
    return { start: monday, end: null }
  }
  if (key === 'month') return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: null }
  if (key === 'all') return { start: new Date(0), end: null }
  const s = new Date(now)
  s.setDate(s.getDate() - RANGES[key].days)
  return { start: s, end: null }
}

export default function CommissionReport() {
  const [range, setRange] = useState('week')
  const [rows, setRows] = useState([])
  const [jobTypes, setJobTypes] = useState({})
  const [membTypes, setMembTypes] = useState({})
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [repFilter, setRepFilter] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    const { start } = rangeBounds(range)
    const [{ data: comms }, { data: jt }, { data: mt }] = await Promise.all([
      sb.from('commissions').select('*, profiles!profile_id(name, email)')
        .gte('earned_at', start.toISOString()).order('earned_at', { ascending: false }).limit(2000),
      sb.from('job_type_spiffs').select('st_job_type_id, name'),
      sb.from('membership_type_spiffs').select('st_membership_type_id, name'),
    ])
    const jtMap = {}, mtMap = {}
    ;(jt || []).forEach(x => { jtMap[String(x.st_job_type_id)] = x.name })
    ;(mt || []).forEach(x => { mtMap[String(x.st_membership_type_id)] = x.name })
    setJobTypes(jtMap); setMembTypes(mtMap)
    setRows(comms || [])
    setLoading(false)
  }, [range])

  useEffect(() => { load() }, [load])

  const runSync = async () => {
    setSyncing(true); setSyncMsg('')
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch('/api/admin/commission/sync', {
        method: 'POST', headers: { Authorization: `Bearer ${session?.access_token}` },
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || `Sync failed (${res.status})`)
      setSyncMsg(`✓ ${out.jobs?.paid ?? 0} job(s) paid, ${out.jobs?.canceled ?? 0} cancelled, ${out.memberships?.paid ?? 0} membership(s) paid`)
      await load()
    } catch (e) {
      setSyncMsg(`Error: ${e.message}`)
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMsg(''), 8000)
    }
  }

  const repName = (r) => r.profiles?.name || r.rep_name || 'Unknown'
  const reps = [...new Set(rows.map(repName))].sort()
  const shown = repFilter === 'all' ? rows : rows.filter(r => repName(r) === repFilter)

  const total = shown.reduce((s, r) => s + parseFloat(r.amount || 0), 0)
  const byRep = {}
  shown.forEach(r => { byRep[repName(r)] = (byRep[repName(r)] || 0) + parseFloat(r.amount || 0) })

  const fmtDay = (ts) => ts ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

  const typeLabel = (r) => {
    if (r.event_type === 'membership') return membTypes[String(r.st_membership_type_id)] || 'Membership'
    if (r.event_type === 'adjustment') return r.notes || 'Manual adjustment'
    if (r.event_type === 'reversal') return r.notes || 'Reversed — job canceled'
    return jobTypes[String(r.st_job_type_id)] || 'Job'
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
      <div className="card">
        <div className="card-header">
          <div className="card-title">Commission Payouts</div>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            {syncMsg && <span style={{ fontSize:12, color: syncMsg.startsWith('Error') ? 'var(--danger)' : 'var(--success)' }}>{syncMsg}</span>}
            <button className="btn sm" onClick={runSync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync from ServiceTitan'}
            </button>
          </div>
        </div>
        <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <div style={{ fontSize:11, color:'var(--text-muted)' }}>
            Reps are paid when ServiceTitan marks the job completed, at the amount tagged against the job type.
            Syncs automatically every 15 minutes.
          </div>

          <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
            {Object.entries(RANGES).map(([k, v]) => (
              <button key={k} className={`btn sm${range === k ? ' primary' : ''}`} onClick={() => setRange(k)}>{v.label}</button>
            ))}
            <select className="form-input" style={{ width:'auto', marginLeft:8, fontSize:12, padding:'4px 8px' }}
              value={repFilter} onChange={e => setRepFilter(e.target.value)}>
              <option value="all">All reps</option>
              {reps.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <div style={{ marginLeft:'auto', fontSize:13, fontWeight:700 }}>
              Total: <span style={{ color:'var(--accent)' }}>${total.toFixed(2)}</span>
              <span style={{ fontWeight:400, color:'var(--text-muted)', marginLeft:6 }}>({shown.length} payout{shown.length === 1 ? '' : 's'})</span>
            </div>
          </div>

          {Object.keys(byRep).length > 1 && (
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              {Object.entries(byRep).sort((a, b) => b[1] - a[1]).map(([name, amt]) => (
                <span key={name} style={{ fontSize:11, padding:'3px 9px', borderRadius:99, background:'var(--surface-2)', fontWeight:600 }}>
                  {name} <span style={{ color:'var(--accent)' }}>${amt.toFixed(2)}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {loading ? <div className="card-body"><div className="spinner" /></div> : shown.length === 0 ? (
          <div className="card-body" style={{ color:'var(--text-muted)', fontSize:13 }}>
            No payouts in this range. Commissions appear once ServiceTitan marks a booked job completed.
          </div>
        ) : (
          <div style={{ overflowX:'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Rep</th><th>Type</th><th>Customer</th><th>Job / Membership</th>
                  <th>Booked / Sold</th><th>Completed</th><th style={{ textAlign:'right' }}>Payout</th><th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map(r => (
                  <tr key={r.id}>
                    <td style={{ padding:'10px 12px', fontWeight:600 }}>{repName(r)}</td>
                    <td style={{ padding:'10px 12px' }}>
                      <span style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.4, padding:'2px 7px', borderRadius:99,
                        background: r.event_type === 'membership' ? 'var(--accent-bg)' : 'var(--surface-2)',
                        color: r.event_type === 'membership' ? 'var(--accent)' : 'var(--text-secondary)' }}>
                        {r.event_type === 'booking' ? 'Job' : r.event_type}
                      </span>
                    </td>
                    <td style={{ padding:'10px 12px' }}>{r.contact_name || '—'}</td>
                    <td style={{ padding:'10px 12px', fontSize:12, color:'var(--text-secondary)' }}>{typeLabel(r)}</td>
                    <td style={{ padding:'10px 12px', fontSize:12 }}>{fmtDay(r.booked_at)}</td>
                    <td style={{ padding:'10px 12px', fontSize:12 }}>
                      {r.event_type === 'membership'
                        ? <span style={{ color:'var(--text-muted)' }}>—</span>
                        : fmtDay(r.completed_at)}
                    </td>
                    <td style={{ padding:'10px 12px', textAlign:'right', fontWeight:700, color:'#16A34A' }}>${parseFloat(r.amount || 0).toFixed(2)}</td>
                    <td style={{ padding:'10px 12px' }}>
                      {r.st_job_id && (
                        <a href={ST_JOB_URL(r.st_job_id)} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize:11, color:'var(--accent)', fontWeight:600, whiteSpace:'nowrap' }}>
                          Job {r.job_number || r.st_job_id} ↗
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

