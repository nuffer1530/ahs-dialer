import { useState, useEffect, useCallback, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { useIsMobile } from '../lib/useIsMobile'
import { Segmented } from './CoachingSnapshots'

// Commission payouts — team money. Lives on the Team page; Settings keeps only
// configuration. A summary panel (total vs the prior period, split by type,
// split by rep — click a rep to filter) over the payouts grouped by day.
// Rows are paged: a plain select stops at 1,000 and quietly cut the 90-day
// and all-time totals short.
const RANGES = {
  payroll: { label: 'Payroll wk', vs: 'prior pay period' },   // last completed Mon–Sun (ADP periods end Sunday)
  week:    { label: 'This week', vs: 'same days last week' },
  month:   { label: 'This month', vs: 'same point last month' },
  last30:  { label: '30 days', vs: 'prior 30 days', days: 30 },
  last90:  { label: '90 days', vs: 'prior 90 days', days: 90 },
  all:     { label: 'All time' },
  custom:  { label: 'Custom', vs: 'prior period' },
}
const TYPES = {
  booking:    { label: 'Jobs', one: 'Job', tone: 'blue' },
  membership: { label: 'Memberships', one: 'Membership', tone: 'purple' },
  adjustment: { label: 'Bonuses & adjustments', one: 'Bonus', tone: 'green' },
  reversal:   { label: 'Reversals', one: 'Reversal', tone: 'red' },
}
const ST_JOB_URL = (jobId) => `https://go.servicetitan.com/#/Job/Index/${jobId}`
const num = { fontVariantNumeric: 'tabular-nums' }
const eyebrow = { fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)' }
const money = (n) => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Denver' })
const dayLabel = (iso) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Denver', weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
const shortDay = (ts) => (ts ? new Date(ts).toLocaleDateString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric' }) : null)

function rangeBounds(key, custom) {
  const now = new Date()
  if (key === 'payroll') {
    const end = new Date(now); end.setHours(23, 59, 59, 999)
    const back = end.getDay() === 0 && now.getHours() >= 23 ? 0 : (end.getDay() === 0 ? 7 : end.getDay())
    end.setDate(end.getDate() - back)
    const start = new Date(end); start.setDate(end.getDate() - 6); start.setHours(0, 0, 0, 0)
    return { start, end }
  }
  if (key === 'custom') {
    const start = custom?.from ? new Date(custom.from + 'T00:00:00') : new Date(0)
    const end = custom?.to ? new Date(custom.to + 'T23:59:59.999') : null
    return { start, end }
  }
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

// The comparison window: the same span one period earlier (same weekdays for
// weeks, same day-of-month for months).
function prevBounds(key, custom) {
  if (key === 'all') return null
  const { start, end } = rangeBounds(key, custom)
  const stop = end || new Date()
  const back = (d, days) => { const x = new Date(d); x.setDate(x.getDate() - days); return x }
  if (key === 'payroll' || key === 'week') return { start: back(start, 7), end: back(stop, 7) }
  if (key === 'month') {
    const s = new Date(start); s.setMonth(s.getMonth() - 1)
    const e = new Date(stop); e.setDate(Math.min(e.getDate(), new Date(e.getFullYear(), e.getMonth(), 0).getDate())); e.setMonth(e.getMonth() - 1)
    return { start: s, end: e }
  }
  if (key === 'custom' && !custom?.from) return null
  const len = stop - start
  return { start: new Date(start - len), end: new Date(start) }
}

async function loadPaged(select, start, end) {
  const out = []
  for (let from = 0; ; from += 1000) {
    let q = sb.from('commissions').select(select).gte('earned_at', start.toISOString())
      .order('earned_at', { ascending: false }).range(from, from + 999)
    if (end) q = q.lte('earned_at', end.toISOString())
    const { data, error } = await q
    if (error) throw error
    out.push(...(data || []))
    if (!data || data.length < 1000) return out
  }
}

const TypeIcon = ({ type }) => {
  const p = {
    booking: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3.6 17.4a1.9 1.9 0 0 0 2.7 2.7l5.7-5.7a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.5-.6-.6-2.5 3-2.2z',
    membership: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
    adjustment: 'M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7C10.5 4 7 4 7 6s3 1 5 1zm0 0c1.5-3 5-3 5-1s-3 1-5 1z',
    reversal: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  }[type] || ''
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={p} /></svg>
  )
}

function Delta({ now, prev, vs }) {
  if (prev == null) return null
  const d = Math.round((now - prev) * 100) / 100
  const t = d > 0 ? 'green' : d < 0 ? 'red' : 'gray'
  return (
    <span title={`${money(prev)} in the ${vs}`} style={{ ...num, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', borderRadius: 99, padding: '1px 7px',
      color: `var(--tone-${t}-tx)`, background: `var(--tone-${t}-bg)`, border: `1px solid var(--tone-${t}-bd)` }}>
      {d > 0 ? '▲ +' : d < 0 ? '▼ −' : '= '}{money(Math.abs(d))} vs {vs}
    </span>
  )
}

export default function CommissionReport() {
  const isMobile = useIsMobile()
  const [range, setRange] = useState('week')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [rows, setRows] = useState(null)
  const [prevTotal, setPrevTotal] = useState(null)
  const [jobTypes, setJobTypes] = useState({})
  const [membTypes, setMembTypes] = useState({})
  const [err, setErr] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [repFilter, setRepFilter] = useState('all')

  const load = useCallback(async () => {
    if (range === 'custom' && !custom.from) return   // wait for a date
    setErr('')
    const { start, end } = rangeBounds(range, custom)
    const prev = prevBounds(range, custom)
    try {
      const [comms, prevRows, { data: jt }, { data: mt }] = await Promise.all([
        loadPaged('*, profiles!profile_id(name, email, active)', start, end),
        prev ? loadPaged('amount', prev.start, prev.end) : Promise.resolve(null),
        sb.from('job_type_spiffs').select('st_job_type_id, name'),
        sb.from('membership_type_spiffs').select('st_membership_type_id, name'),
      ])
      const jtMap = {}, mtMap = {}
      ;(jt || []).forEach(x => { jtMap[String(x.st_job_type_id)] = x.name })
      ;(mt || []).forEach(x => { mtMap[String(x.st_membership_type_id)] = x.name })
      setJobTypes(jtMap); setMembTypes(mtMap)
      setRows(comms)
      setPrevTotal(prevRows ? prevRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0) : null)
    } catch (e) { setErr(e.message); setRows([]) }
  }, [range, custom])

  useEffect(() => { setRows(null); load() }, [load])

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
  const all = rows || []
  const shown = repFilter === 'all' ? all : all.filter(r => repName(r) === repFilter)
  const total = shown.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
  const allTotal = all.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)

  const byRep = useMemo(() => {
    const m = new Map()
    for (const r of all) {
      const k = repName(r)
      const cur = m.get(k) || { name: k, amount: 0, n: 0, former: r.profiles?.active === false }
      cur.amount += parseFloat(r.amount) || 0; cur.n++
      m.set(k, cur)
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])
  const byType = Object.keys(TYPES).map(t => {
    const list = shown.filter(r => (r.event_type || 'booking') === t)
    return { t, n: list.length, amount: list.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0) }
  }).filter(x => x.n)
  const positive = byType.filter(x => x.amount > 0).reduce((s, x) => s + x.amount, 0)

  const groups = useMemo(() => {
    const out = []
    for (const r of shown) {
      const k = dayKey(r.earned_at)
      if (!out.length || out[out.length - 1].key !== k) out.push({ key: k, label: dayLabel(r.earned_at), rows: [] })
      out[out.length - 1].rows.push(r)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, repFilter])

  const typeLabel = (r) => {
    if (r.event_type === 'membership') return membTypes[String(r.st_membership_type_id)] || 'Membership'
    if (r.event_type === 'adjustment') return r.notes || 'Manual adjustment'
    if (r.event_type === 'reversal') return r.notes || 'Reversed — job canceled'
    return jobTypes[String(r.st_job_type_id)] || 'Job'
  }
  const kindOf = (r) => TYPES[r.event_type] ? r.event_type : 'booking'
  const vs = RANGES[range].vs
  const topAmt = byRep[0]?.amount || 1
  const divider = isMobile ? { borderTop: '1px solid var(--border)' } : { borderLeft: '1px solid var(--border)' }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <Segmented value={range} onChange={setRange} options={Object.entries(RANGES).map(([k, v]) => [k, v.label])} />
        </div>
        {range === 'custom' && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="date" className="form-input" style={{ width: 'auto', borderRadius: 99, padding: '6px 12px' }}
              value={custom.from} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} aria-label="From" />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>to</span>
            <input type="date" className="form-input" style={{ width: 'auto', borderRadius: 99, padding: '6px 12px' }}
              value={custom.to} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} aria-label="To" />
          </span>
        )}
        <select className="form-input" value={repFilter} onChange={e => setRepFilter(e.target.value)} aria-label="Rep"
          style={{ width: isMobile ? '100%' : 200, borderRadius: 99, padding: '7px 14px' }}>
          <option value="all">All reps</option>
          {byRep.map(r => <option key={r.name} value={r.name}>{r.name}{r.former ? ' (former)' : ''}</option>)}
        </select>
        <div style={{ marginLeft: isMobile ? 0 : 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {syncMsg && <span style={{ fontSize: 12, color: syncMsg.startsWith('Error') ? 'var(--danger)' : 'var(--tone-green-tx)' }}>{syncMsg}</span>}
          <button className="btn" onClick={runSync} disabled={syncing} style={{ borderRadius: 99 }}
            title="Reps are paid when ServiceTitan marks the job completed. Syncs on its own every 15 minutes.">
            {syncing ? 'Syncing…' : 'Sync from ServiceTitan'}
          </button>
        </div>
      </div>

      {range === 'custom' && !custom.from ? (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14 }}>
          Pick a start date (and optionally an end date) for the custom range.
        </div>
      ) : rows === null ? (
        <>
          <div className="skel" style={{ height: 170, borderRadius: 16, marginBottom: 16 }} />
          <div className="skel" style={{ height: 320, borderRadius: 14 }} />
        </>
      ) : err ? (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--danger)', fontSize: 13 }}>Couldn’t load payouts: {err}</div>
      ) : (
        <>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, marginBottom: 16, display: 'grid',
            gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(260px, 300px) minmax(0, 1fr) minmax(0, 1fr)' }}>
            <div style={{ padding: '20px 22px' }}>
              <div style={eyebrow}>{repFilter === 'all' ? 'Total paid' : `Paid to ${repFilter}`}</div>
              <div style={{ ...num, fontSize: 34, fontWeight: 800, letterSpacing: '-.03em', lineHeight: 1.1, margin: '6px 0 4px', color: 'var(--tone-green-tx)' }}>
                {money(total)}
              </div>
              <div style={{ ...num, fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                {shown.length} payout{shown.length === 1 ? '' : 's'}{repFilter === 'all' ? ` · ${byRep.length} rep${byRep.length === 1 ? '' : 's'}` : ''}
              </div>
              {repFilter === 'all' && <Delta now={total} prev={prevTotal} vs={vs} />}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                Paid when ServiceTitan marks the job completed · syncs every 15 minutes
              </div>
            </div>

            <div style={{ padding: '18px 22px', minWidth: 0, ...divider }}>
              <div style={{ ...eyebrow, marginBottom: 12 }}>By type</div>
              {byType.length ? (
                <>
                  <div style={{ display: 'flex', height: 10, borderRadius: 99, overflow: 'hidden', gap: 2, background: 'var(--surface-2)', marginBottom: 12 }}>
                    {byType.filter(x => x.amount > 0).map(x => <div key={x.t} style={{ flex: x.amount / positive, background: `var(--tone-${TYPES[x.t].tone}-tx)` }} />)}
                  </div>
                  {byType.map(x => (
                    <div key={x.t} className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 56px 90px', gap: 10, alignItems: 'center', fontSize: 12.5, marginBottom: 7 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 99, flexShrink: 0, background: `var(--tone-${TYPES[x.t].tone}-tx)` }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{TYPES[x.t].label}</span>
                      </span>
                      <span style={{ ...num, color: 'var(--text-muted)', textAlign: 'right' }}>{x.n}</span>
                      <span style={{ ...num, fontWeight: 700, textAlign: 'right', color: x.amount < 0 ? 'var(--tone-red-tx)' : 'var(--text-primary)' }}>{money(x.amount)}</span>
                    </div>
                  ))}
                </>
              ) : <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Nothing paid in this range.</div>}
            </div>

            <div style={{ padding: '18px 22px', minWidth: 0, ...divider }}>
              <div style={{ ...eyebrow, marginBottom: 10, display: 'flex', justifyContent: 'space-between' }}>
                <span>By rep</span>
                {repFilter !== 'all' && <button className="btn ghost sm" onClick={() => setRepFilter('all')} style={{ padding: '0 6px', fontSize: 11 }}>Show all</button>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 190, overflowY: 'auto' }}>
                {byRep.map(r => {
                  const on = repFilter === r.name
                  return (
                    <button key={r.name} onClick={() => setRepFilter(on ? 'all' : r.name)} title={on ? 'Show everyone' : `Show only ${r.name}`}
                      className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 80px 76px', gap: 10, alignItems: 'center', fontSize: 12.5,
                        border: 'none', borderRadius: 8, padding: '4px 6px', cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'inherit',
                        background: on ? 'var(--accent-bg)' : 'transparent' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: on ? 700 : 500 }}>
                        {r.name}{r.former && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · former</span>}
                      </span>
                      <div style={{ height: 6, borderRadius: 99, background: 'var(--surface-2)', overflow: 'hidden' }}>
                        <div style={{ width: `${Math.max(2, (r.amount / topAmt) * 100)}%`, height: '100%', borderRadius: 99, background: 'var(--accent)' }} />
                      </div>
                      <span style={{ ...num, textAlign: 'right', fontWeight: 700 }}>{money(r.amount)}</span>
                    </button>
                  )
                })}
                {!byRep.length && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No reps paid in this range.</div>}
              </div>
            </div>
          </div>

          {groups.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14 }}>
              No payouts in this range. Commissions appear once ServiceTitan marks a booked job completed.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {groups.map(g => {
                const sum = g.rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
                return (
                  <div key={g.key} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: isMobile ? '10px 12px' : '11px 18px', background: 'var(--surface-2)' }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{g.label}</span>
                      <span style={{ ...num, fontSize: 12, color: 'var(--text-muted)' }}>{g.rows.length} payout{g.rows.length === 1 ? '' : 's'}</span>
                      <span style={{ ...num, marginLeft: 'auto', fontSize: 13, fontWeight: 800, color: 'var(--tone-green-tx)' }}>{money(sum)}</span>
                    </div>
                    {g.rows.map(r => {
                      const k = kindOf(r)
                      const tone = TYPES[k].tone
                      const amt = parseFloat(r.amount) || 0
                      // Dates only mean something for jobs (booked → completed) and memberships (sold).
                      const booked = k === 'booking' || k === 'membership' ? shortDay(r.booked_at) : null
                      const done = k === 'booking' ? shortDay(r.completed_at) : null
                      return (
                        <div key={r.id} className="eval-row" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: isMobile ? '10px 12px' : '11px 18px', borderTop: '1px solid var(--border)' }}>
                          <div title={TYPES[k].one} style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: `var(--tone-${tone}-tx)`, background: `var(--tone-${tone}-bg)`, border: `1px solid var(--tone-${tone}-bd)` }}>
                            <TypeIcon type={k} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                              <span style={{ fontSize: 13.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{repName(r)}</span>
                              {r.contact_name && <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.contact_name}</span>}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isMobile ? 'normal' : 'nowrap' }}>
                              {typeLabel(r)}
                              {booked && <> · {r.event_type === 'membership' ? 'sold' : 'booked'} {booked}</>}
                              {done && <> · completed {done}</>}
                            </div>
                          </div>
                          {r.st_job_id && !isMobile && (
                            <a href={ST_JOB_URL(r.st_job_id)} target="_blank" rel="noopener noreferrer"
                              style={{ fontSize: 11.5, color: 'var(--accent)', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>
                              Job {r.job_number || r.st_job_id} ↗
                            </a>
                          )}
                          <div style={{ ...num, width: 76, textAlign: 'right', fontSize: 14, fontWeight: 800, flexShrink: 0, color: amt < 0 ? 'var(--tone-red-tx)' : 'var(--tone-green-tx)' }}>
                            {amt < 0 ? '−' : ''}{money(Math.abs(amt))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}
          {repFilter !== 'all' && (
            <div style={{ ...num, fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
              Showing {repFilter} only · team total for this range {money(allTotal)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
