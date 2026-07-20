import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

// Dispatch for Profit — who to send, and whether today's board agrees.
//
// Two tabs:
//  - Batting Order: cached tech ranking per business unit (the scoring job runs
//    on a schedule; this only reads it).
//  - Live Board: today's assignments scored against those ranks. Flags only —
//    Andi never writes assignments back to ServiceTitan.

const TIER = {
  green:    { color:'#15803D', bg:'#EAF5EE', border:'#BBE3C9', label:'Deploy here' },
  yellow:   { color:'#B45309', bg:'#FBF3E0', border:'#F0DCA8', label:'Standard' },
  red:      { color:'#B91C1C', bg:'#FBEEEA', border:'#F0C8BE', label:'Not on high-value' },
  unranked: { color:'#6B7280', bg:'#F3F4F6', border:'#E5E7EB', label:'Not enough data' },
}

const ST_JOB_URL = (jobId) => `https://go.servicetitan.com/#/Job/Index/${jobId}`

// One <table> per arrival window means each would otherwise auto-size its own
// columns and the groups wouldn't line up down the page. Fixed layout + one
// shared width list keeps every group in register.
// Batting Order renders one table per team, so it needs the same fixed-layout
// treatment as the Live Board or the groups won't line up down the page.
const BO_COLS = [
  { key:'rank',  label:'#',              width:'4%'  },
  { key:'tech',  label:'Technician',     width:'19%' },
  { key:'tier',  label:'Tier',           width:'14%' },
  { key:'ev',    label:'$ / opportunity', width:'12%', align:'right',
    title:'Expected revenue per opportunity = close rate × average sale' },
  { key:'close', label:'Close rate',     width:'10%', align:'right' },
  { key:'sale',  label:'Avg sale',       width:'10%', align:'right' },
  { key:'sold',  label:'Total sold',     width:'11%', align:'right' },
  { key:'opps',  label:'Opps',           width:'7%',  align:'right',
    title:'Opportunities run in the window' },
  { key:'memb',  label:'Membership',     width:'7%',  align:'right' },
  { key:'jobs',  label:'Jobs',           width:'6%',  align:'right',
    title:'Total jobs run — the sample size behind the ranking' },
]

const LB_COLS = [
  { key:'job',   label:'Job',        width:'20%' },
  { key:'tech',  label:'Technician', width:'17%' },
  { key:'tier',  label:'Tier',       width:'13%' },
  { key:'opp',   label:'Opp.',       width:'7%',  align:'right' },
  { key:'flag',  label:'Flag',       width:'36%' },
]
const money = (v) => (v == null ? '—' : `$${Math.round(Number(v)).toLocaleString()}`)

// "8 AM – 12 PM". Windows are what the customer was promised and how dispatch
// reads the board, so calls are grouped by them rather than by exact start.
const hr = (iso) => {
  if (!iso) return null
  const d = new Date(iso)
  const h = d.getHours(), m = d.getMinutes()
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m ? `${h12}:${String(m).padStart(2,'0')} ${ampm}` : `${h12} ${ampm}`
}
const windowLabel = (c) => {
  const a = hr(c.windowStart), b = hr(c.windowEnd)
  if (!a) return 'Unscheduled'
  return b ? `${a} – ${b}` : a
}
const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`)
const ago = (iso) => {
  if (!iso) return 'never'
  const m = Math.floor((Date.now() - new Date(iso)) / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

async function authed(path, opts = {}) {
  const { data: { session } } = await sb.auth.getSession()
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}`, ...(opts.headers || {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

function TierPill({ tier }) {
  const t = TIER[tier] || TIER.unranked
  return (
    <span style={{ fontSize:10, fontWeight:700, color:t.color, background:t.bg, border:`1px solid ${t.border}`,
      padding:'2px 8px', borderRadius:99, whiteSpace:'nowrap' }}>{t.label}</span>
  )
}

function BattingOrder() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [weights, setWeights] = useState(null)
  const [savingW, setSavingW] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await authed('/api/dispatch/batting-order')
      setData(d); setWeights(d.weights); setErr('')
    } catch (e) { setErr(e.message) }
  }, [])
  useEffect(() => { load() }, [load])

  const refresh = async () => {
    setBusy(true); setErr('')
    try { await authed('/api/dispatch/refresh', { method:'POST' }); await load() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const saveWeights = async () => {
    setSavingW(true)
    try { await authed('/api/dispatch/weights', { method:'POST', body: JSON.stringify({ weights }) }); await load() }
    catch (e) { setErr(e.message) } finally { setSavingW(false) }
  }

  if (err) return <div style={{ padding:20, color:'var(--danger)', fontSize:13 }}>{err}</div>
  if (!data) return <div className="spinner lg" style={{ margin:'60px auto' }} />

  const units = [...new Set((data.groups || []).map(g => g.business_unit))].sort()
  const wTotal = weights ? (weights.expectedValue + weights.closeRate + weights.membership) : 0

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10, marginBottom:14 }}>
        <div style={{ fontSize:12, color:'var(--text-muted)' }}>
          Ranked by expected revenue per opportunity (close rate × average sale) within each dispatch team ·
          {data.windowDays}-day window, recent work weighted heavier · scored {ago(data.refreshedAt)}
        </div>
        <button className="btn sm" onClick={refresh} disabled={busy}>
          {busy ? 'Scoring… (takes a minute)' : 'Rescore now'}
        </button>
      </div>

      {/* Weights */}
      {weights && (
        <div className="card" style={{ padding:'12px 14px', marginBottom:16, display:'flex', alignItems:'center', gap:14, flexWrap:'wrap' }}>
          <span style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)' }}>Weighting</span>
          {[['expectedValue','Expected value'],['closeRate','Close rate'],['membership','Membership']].map(([k,label]) => (
            <label key={k} style={{ display:'flex', alignItems:'center', gap:6, fontSize:12 }}>
              {label}
              <input type="number" min="0" max="100" value={weights[k]}
                onChange={e => setWeights(w => ({ ...w, [k]: Number(e.target.value) }))}
                style={{ width:58, padding:'4px 6px', border:'1px solid var(--border)', borderRadius:6,
                  background:'var(--surface-2)', color:'var(--text-primary)', fontSize:12 }} />
            </label>
          ))}
          <span style={{ fontSize:11, color: wTotal === 100 ? 'var(--text-muted)' : 'var(--warning)' }}>
            total {wTotal}{wTotal !== 100 ? ' (relative weights — needn\'t sum to 100)' : ''}
          </span>
          <button className="btn sm" onClick={saveWeights} disabled={savingW}>
            {savingW ? 'Saving…' : 'Save & rescore next run'}
          </button>
        </div>
      )}

      {units.length === 0 && (
        <div className="empty-state" style={{ padding:'40px 20px', textAlign:'center', color:'var(--text-muted)', fontSize:13 }}>
          No scores yet. Hit <strong>Rescore now</strong> — the first run pulls 45 days from ServiceTitan and takes a minute.
        </div>
      )}

      {units.map(bu => {
        const rows = (data.groups || []).filter(g => g.business_unit === bu)
        const ranked = rows.filter(r => r.tier !== 'unranked').sort((a,b) => (a.rank||99) - (b.rank||99))
        const thin = rows.filter(r => r.tier === 'unranked').sort((a,b) => b.jobs - a.jobs)
        return (
          <div key={bu} style={{ marginBottom:22 }}>
            <div style={{ display:'flex', alignItems:'baseline', gap:9, marginBottom:8, flexWrap:'wrap' }}>
              <span style={{ fontSize:13, fontWeight:700, color:'var(--text-primary)' }}>{bu}</span>
              {(() => {
                // A tight bench is the most important thing to say out loud:
                // ranking #1 vs #2 on a 7% gap is noise, and treating it as a
                // verdict makes dispatch avoid a perfectly good tech.
                const evs = ranked.map(r => Number(r.expected_value) || 0).filter(v => v > 0).sort((a,b) => a-b)
                if (evs.length < 2) return null
                const spread = (evs[evs.length-1] - evs[0]) / evs[evs.length-1]
                const tight = spread < 0.25
                return (
                  <span title={tight
                    ? 'These techs are within noise of each other — rank order here is not a meaningful difference'
                    : 'There is real separation between top and bottom on this bench'}
                    style={{ fontSize:10, fontWeight:600, padding:'2px 8px', borderRadius:99,
                      color: tight ? 'var(--text-muted)' : '#B45309',
                      background: tight ? 'var(--surface-2)' : '#FBF3E0',
                      border: `1px solid ${tight ? 'var(--border)' : '#F0DCA8'}` }}>
                    {tight
                      ? `${Math.round(spread*100)}% spread — effectively interchangeable`
                      : `${Math.round(spread*100)}% spread`}
                  </span>
                )
              })()}
            </div>
            <div className="card" style={{ padding:0, overflow:'hidden' }}>
              <table className="data-table" style={{ fontSize:12, tableLayout:'fixed', width:'100%' }}>
                <colgroup>{BO_COLS.map(c => <col key={c.key} style={{ width:c.width }} />)}</colgroup>
                <thead><tr>
                  {BO_COLS.map(c => (
                    <th key={c.key} style={{ textAlign: c.align || 'left' }} title={c.title}>{c.label}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {ranked.map(r => (
                    <tr key={r.tech_id} style={{ background: r.tier === 'green' ? 'rgba(21,128,61,.04)' : 'transparent' }}>
                      <td style={{ padding:'7px 12px', color:'var(--text-muted)' }}>{r.rank}</td>
                      <td style={{ padding:'7px 12px', fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={r.tech_name}>{r.tech_name}</td>
                      <td style={{ padding:'7px 12px' }}><TierPill tier={r.tier} /></td>
                      <td style={{ padding:'7px 12px', textAlign:'right', fontWeight:700 }}>{money(r.expected_value)}</td>
                      <td style={{ padding:'7px 12px', textAlign:'right' }}>{pct(r.close_rate)}</td>
                      <td style={{ padding:'7px 12px', textAlign:'right' }}>{money(r.avg_sale)}</td>
                      <td style={{ padding:'7px 12px', textAlign:'right', color:'var(--text-muted)' }}>{money(r.total_sold)}</td>
                      <td style={{ padding:'7px 12px', textAlign:'right', color:'var(--text-muted)' }}>{r.opportunities ?? '—'}</td>
                      <td style={{ padding:'7px 12px', textAlign:'right' }}>{pct(r.membership_pct)}</td>
                      <td style={{ padding:'7px 12px', textAlign:'right', color:'var(--text-muted)' }}>{r.jobs}</td>
                    </tr>
                  ))}
                  {thin.map(r => (
                    <tr key={r.tech_id} style={{ opacity:.6 }}>
                      <td style={{ padding:'7px 12px' }}>—</td>
                      <td style={{ padding:'7px 12px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={r.tech_name}>{r.tech_name}</td>
                      <td style={{ padding:'7px 12px' }}><TierPill tier="unranked" /></td>
                      <td colSpan={6} style={{ padding:'7px 12px', color:'var(--text-muted)', fontSize:11 }}>
                        Needs 10+ jobs to rank — not a rating
                      </td>
                      <td style={{ padding:'7px 12px', textAlign:'right', color:'var(--text-muted)' }}>{r.jobs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LiveBoard() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('all')   // all | flagged | reschedule

  const load = useCallback(async () => {
    try { setData(await authed('/api/dispatch/live-board')); setErr('') }
    catch (e) { setErr(e.message) } finally { setLoading(false) }
  }, [])
  useEffect(() => {
    load()
    const t = setInterval(load, 15 * 60_000)   // 15-minute refresh, per spec
    return () => clearInterval(t)
  }, [load])

  if (err) return <div style={{ padding:20, color:'var(--danger)', fontSize:13 }}>{err}</div>
  if (loading && !data) return <div className="spinner lg" style={{ margin:'60px auto' }} />

  const allCalls = data?.calls || []
  const flagged = allCalls.filter(c => c.flags?.length)
  // Lowest-producing first — this list is "what to move when demand walks in".
  const reschedule = allCalls.filter(c => c.rescheduleCandidate)
    .sort((a, b) => (a.expectedRevenue || 0) - (b.expectedRevenue || 0))
  const calls = view === 'flagged' ? flagged : view === 'reschedule' ? reschedule : allCalls
  const rev = data?.dayRevenue

  // Within a window, group by team. Teams with flags sort first so a
  // dispatcher sees the problems without scanning every bench.
  const byTeam = (list) => {
    const m = new Map()
    for (const c of list) {
      const k = c.businessUnit || 'Unassigned'
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(c)
    }
    return [...m.entries()].sort((a, b) => {
      const fa = a[1].some(c => c.flags?.length) ? 0 : 1
      const fb = b[1].some(c => c.flags?.length) ? 0 : 1
      return fa - fb || a[0].localeCompare(b[0])
    })
  }

  // Group by arrival window, ordered by when the window opens. Unscheduled
  // sorts last rather than pretending to be midnight.
  const groups = (() => {
    const m = new Map()
    for (const c of calls) {
      const k = windowLabel(c)
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(c)
    }
    // Sort by the actual window-open timestamp, numerically. Unscheduled last.
    const at = (g) => {
      const t = Date.parse(g[1][0]?.windowStart || '')
      return Number.isNaN(t) ? Infinity : t
    }
    return [...m.entries()].sort((a, b) => at(a) - at(b))
  })()

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10, marginBottom:14 }}>
        <div style={{ fontSize:12, color:'var(--text-muted)' }}>
          {data?.counts?.total ?? 0} calls on today's board · {data?.counts?.flagged ?? 0} flagged ·
          auto-refreshes every 15 min
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          {/* Jumping to what needs attention is the whole job — 95 calls with
              11 flagged is a lot of scrolling otherwise. */}
          <div style={{ display:'flex', border:'1px solid var(--border)', borderRadius:99, overflow:'hidden' }}>
            {[['all', `All ${allCalls.length}`], ['flagged', `⚠️ Flagged ${flagged.length}`],
              ['reschedule', `↻ Movable ${reschedule.length}`]].map(([val, label]) => (
              <button key={val} onClick={() => setView(val)}
                title={val === 'reschedule' ? 'Lowest-producing calls — candidates to move if demand comes in' : undefined}
                style={{ padding:'5px 12px', border:'none', cursor:'pointer', fontSize:11, fontWeight:600, whiteSpace:'nowrap',
                  background: view === val ? 'var(--accent)' : 'transparent',
                  color: view === val ? '#fff' : 'var(--text-muted)' }}>
                {label}
              </button>
            ))}
          </div>
          <button className="btn sm" onClick={load}>Refresh</button>
        </div>
      </div>

      {rev && (
        <div className="card" style={{ padding:'13px 16px', marginBottom:14, display:'flex', gap:24, flexWrap:'wrap', alignItems:'center' }}>
          {/* Sales and Revenue are different money at different times: a sale
              closed today becomes revenue weeks later when it's installed, and
              today's revenue came from sales made weeks ago. They are shown
              side by side and never summed. */}
          <div>
            <div style={{ fontSize:20, fontWeight:800, color:'var(--accent)', lineHeight:1.1 }}>{money(rev.expected)}</div>
            <div style={{ fontSize:10, fontWeight:700, color:'var(--text-primary)', textTransform:'uppercase', letterSpacing:.5, marginTop:2 }}>
              Expected sales
            </div>
            <div style={{ fontSize:10, color:'var(--text-muted)' }}>
              {rev.opportunityCalls} opportunity call{rev.opportunityCalls === 1 ? '' : 's'} on the board
            </div>
          </div>

          <div style={{ width:1, alignSelf:'stretch', background:'var(--border)' }} />

          <div>
            <div style={{ fontSize:20, fontWeight:800, color:'#15803D', lineHeight:1.1 }}>{money(rev.booked)}</div>
            <div style={{ fontSize:10, fontWeight:700, color:'var(--text-primary)', textTransform:'uppercase', letterSpacing:.5, marginTop:2 }}>
              Expected revenue
            </div>
            <div style={{ fontSize:10, color:'var(--text-muted)' }}>
              {rev.bookedJobs} install{rev.bookedJobs === 1 ? '' : 's'} finishing today
            </div>
          </div>

          <div style={{ flex:1, minWidth:210, fontSize:10, color:'var(--text-muted)', lineHeight:1.6 }}>
            <strong>Sales</strong> is new work that could close today — replacements found on
            opportunity calls, weighted by each tech's close rate and average sale. It becomes
            revenue later, when it's installed.<br />
            <strong>Revenue</strong> is the invoiced value of installs whose last day is today.
            A multi-day install counts once, on the day it finishes.<br />
            Both are forward-looking for the whole day, not earned-so-far.
          </div>
        </div>
      )}

      {view === 'reschedule' && (
        <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:10 }}>
          Lowest-producing calls first — the ones to move if demand comes in.
          Installs are excluded (already sold) and phone/follow-ups are excluded (no truck time, and they have to happen).
        </div>
      )}

      {view === 'flagged' && flagged.length === 0 && (
        <div className="card" style={{ padding:'22px 16px', textAlign:'center', color:'#15803D', fontSize:13 }}>
          ✓ Nothing flagged right now — every high-opportunity call is on a capable tech.
        </div>
      )}

      {(data?.swaps || []).length > 0 && view === 'all' && (
        <div style={{ marginBottom:16 }}>
          {data.swaps.map((sw, i) => (
            <div key={i} className="card" style={{ padding:'12px 15px', marginBottom:9, borderLeft:'3px solid var(--accent)' }}>
              <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:10, flexWrap:'wrap' }}>
                <div style={{ fontSize:12.5, fontWeight:700, color:'var(--text-primary)' }}>🔁 {sw.text}</div>
                {sw.upside > 0 && (
                  <span style={{ fontSize:11, fontWeight:700, color:'#15803D', background:'#EAF5EE',
                    border:'1px solid #BBE3C9', padding:'2px 8px', borderRadius:99, whiteSpace:'nowrap' }}>
                    +{money(sw.upside)} expected
                  </span>
                )}
              </div>
              {/* The reasoning matters more than the recommendation — a
                  dispatcher who can't see WHY won't trust it, and shouldn't. */}
              <ul style={{ margin:'7px 0 0 0', padding:'0 0 0 16px', fontSize:11, color:'var(--text-secondary)', lineHeight:1.65 }}>
                {(sw.why || []).map((w, k) => <li key={k}>{w}</li>)}
              </ul>
              <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:6 }}>
                {sw.businessUnit} · suggestion only — make the change in ServiceTitan
              </div>
            </div>
          ))}
        </div>
      )}

      {flagged.length === 0 && calls.length > 0 && (
        <div className="card" style={{ padding:'14px 16px', marginBottom:16, fontSize:13, color:'#15803D' }}>
          ✓ No mismatches — every high-opportunity call today is on a capable tech.
        </div>
      )}

      {groups.map(([label, list]) => (
      <div key={label} style={{ marginBottom:22 }}>
        <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:8,
          borderBottom:'2px solid var(--border)', paddingBottom:5 }}>
          <span style={{ fontSize:14, fontWeight:800, color:'var(--text-primary)' }}>{label}</span>
          <span style={{ fontSize:11, color:'var(--text-muted)' }}>
            {list.length} call{list.length === 1 ? '' : 's'}
            {list.some(c => c.flags?.length) ? ` · ${list.filter(c => c.flags?.length).length} flagged` : ''}
          </span>
        </div>
        {byTeam(list).map(([team, tlist]) => (
        <div key={team} style={{ marginBottom:10 }}>
          <div style={{ display:'flex', alignItems:'baseline', gap:7, margin:'0 0 4px 2px' }}>
            <span style={{ fontSize:11, fontWeight:700, color:'var(--text-secondary)' }}>{team}</span>
            <span style={{ fontSize:10, color:'var(--text-muted)' }}>
              {tlist.length}
              {tlist.some(c => c.flags?.length) ? ` · ${tlist.filter(c => c.flags?.length).length} flagged` : ''}
            </span>
          </div>
      <div className="card" style={{ padding:0, overflow:'hidden' }}>
        <table className="data-table" style={{ fontSize:12, tableLayout:'fixed', width:'100%' }}>
          <colgroup>{LB_COLS.map(c => <col key={c.key} style={{ width:c.width }} />)}</colgroup>
          <thead><tr>
            {LB_COLS.map(c => (
              <th key={c.key} style={{ textAlign: c.align || 'left' }}>{c.label}</th>
            ))}
          </tr></thead>
          <tbody>
            {tlist.map((c, i) => (
              <tr key={`${c.appointmentId}-${i}`} style={{ background: c.flags?.length ? 'rgba(185,28,28,.04)' : 'transparent' }}>
                <td style={{ padding:'7px 12px' }}>
                  <a href={ST_JOB_URL(c.jobId)} target="_blank" rel="noopener noreferrer"
                     title="Open this job in ServiceTitan"
                     style={{ fontWeight:600, color:'var(--accent)', textDecoration:'none' }}>
                    #{c.jobNumber} ↗
                  </a>
                  <div style={{ fontSize:10, color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={c.jobType}>{c.jobType}</div>
                  {/* Shown on every row, not just flagged ones: otherwise the
                      notes signal is invisible on the calls it didn't flag and
                      it looks like the notes aren't being read at all. */}
                  {c.sticky && (
                    <span title="Follow-up / financing call — stays with this tech, and doesn't use a capacity slot"
                      style={{ display:'inline-block', marginTop:3, marginRight:4, fontSize:9, fontWeight:700,
                        color:'var(--text-muted)', background:'var(--surface-2)', border:'1px solid var(--border)',
                        padding:'1px 5px', borderRadius:99 }}>
                      stays with tech
                    </span>
                  )}
                  {c.systemAge != null && (
                    <span title="Age of the system, read from the job notes"
                      style={{ display:'inline-block', marginTop:3, fontSize:9, fontWeight:700,
                        color:'#B45309', background:'#FBF3E0', border:'1px solid #F0DCA8',
                        padding:'1px 5px', borderRadius:99 }}>
                      ~{c.systemAge} yr system
                    </span>
                  )}
                </td>
                <td style={{ padding:'7px 12px' }}>{c.techName}</td>
                <td style={{ padding:'7px 12px' }}><TierPill tier={c.techTier} /></td>
                <td title={c.bookedRevenue
                    ? `Sold work — ${money(c.bookedRevenue)} invoiced`
                    : ((c.opportunityReasons || []).join(' · ') || 'no opportunity signals')}
                  style={{ padding:'7px 12px', textAlign:'right', fontWeight:700, cursor:'help',
                  color: c.opportunity >= 3 ? '#B91C1C' : 'var(--text-muted)' }}>
                  {c.opportunity}
                  {(c.bookedRevenue > 0 || c.expectedRevenue > 0) && (
                    <div style={{ fontSize:9, fontWeight:600, color: c.bookedRevenue ? '#15803D' : 'var(--text-muted)' }}>
                      {money(c.bookedRevenue || c.expectedRevenue)}
                    </div>
                  )}
                </td>
                <td style={{ padding:'7px 12px' }}>
                  {(c.flags || []).map((f, k) => (
                    <div key={k} style={{ fontSize:11, color: f.level === 'warn' ? '#B91C1C' : 'var(--text-muted)' }}>
                      {f.level === 'warn' ? '⚠️ ' : 'ℹ️ '}{f.text}
                      {f.why?.length > 0 && (
                        <div style={{ fontSize:10, color:'var(--text-muted)' }}>{f.why.join(' · ')}</div>
                      )}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
        </div>
        ))}
      </div>
      ))}

      {calls.length === 0 && (
        <div className="card" style={{ padding:'26px 12px', textAlign:'center', color:'var(--text-muted)', fontSize:13 }}>
          Nothing assigned on today's board yet.
        </div>
      )}
    </div>
  )
}


function ByJobType() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [pick, setPick] = useState('')
  const [q, setQ] = useState('')

  useEffect(() => {
    (async () => {
      try { setData(await authed('/api/dispatch/job-types')) } catch (e) { setErr(e.message) }
    })()
  }, [])

  if (err) return <div style={{ padding:20, color:'var(--danger)', fontSize:13 }}>{err}</div>
  if (!data) return <div className="spinner lg" style={{ margin:'60px auto' }} />

  const types = (data.types || []).filter(t => t.toLowerCase().includes(q.toLowerCase()))
  const rows = (data.rows || []).filter(r => r.job_type === pick)
    .sort((a, b) => (b.expected_value || 0) - (a.expected_value || 0))

  return (
    <div>
      <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:12 }}>
        Who to send for a specific job type. Opportunity counts are shown because samples here are
        small — a tech may only see a given job type a handful of times in the window.
      </div>

      <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:14 }}>
        <input className="form-input" placeholder="Filter job types…" value={q}
          onChange={e => setQ(e.target.value)} style={{ maxWidth:240, fontSize:12, padding:'6px 10px' }} />
        <select className="form-input" value={pick} onChange={e => setPick(e.target.value)}
          style={{ maxWidth:360, fontSize:12, padding:'6px 10px' }}>
          <option value="">Select a job type… ({types.length})</option>
          {types.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {!pick && (
        <div className="empty-state" style={{ padding:'36px 20px', textAlign:'center', color:'var(--text-muted)', fontSize:13 }}>
          Pick a job type to see who closes it best.
        </div>
      )}

      {pick && rows.length === 0 && (
        <div className="empty-state" style={{ padding:'36px 20px', textAlign:'center', color:'var(--text-muted)', fontSize:13 }}>
          Nobody has run this job type enough times to rank.
        </div>
      )}

      {pick && rows.length > 0 && (
        <div className="card" style={{ padding:0, overflow:'hidden' }}>
          <table className="data-table" style={{ fontSize:12 }}>
            <thead><tr>
              <th style={{width:34}}>#</th><th>Technician</th><th>Team</th>
              <th style={{textAlign:'right'}}>$ / opportunity</th>
              <th style={{textAlign:'right'}}>Close rate</th>
              <th style={{textAlign:'right'}}>Avg sale</th>
              <th style={{textAlign:'right'}}>Total sold</th>
              <th style={{textAlign:'right'}}>Opps</th>
              <th style={{textAlign:'right'}}>Won</th>
            </tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.tech_id} style={{ background: i === 0 ? 'rgba(21,128,61,.05)' : 'transparent', opacity: r.thin ? .72 : 1 }}>
                  <td style={{ padding:'7px 12px', color:'var(--text-muted)' }}>{i + 1}</td>
                  <td style={{ padding:'7px 12px', fontWeight:600 }}>
                    {r.tech_name}
                    {i === 0 && <span style={{ marginLeft:6, fontSize:9, fontWeight:700, color:'#15803D', background:'#EAF5EE', border:'1px solid #BBE3C9', padding:'1px 6px', borderRadius:99 }}>TOP</span>}
                  </td>
                  <td style={{ padding:'7px 12px', fontSize:11, color:'var(--text-muted)' }}>{r.team}</td>
                  <td style={{ padding:'7px 12px', textAlign:'right', fontWeight:700 }}>{money(r.expected_value)}</td>
                  <td style={{ padding:'7px 12px', textAlign:'right' }}>{pct(r.close_rate)}</td>
                  <td style={{ padding:'7px 12px', textAlign:'right' }}>{money(r.avg_sale)}</td>
                  <td style={{ padding:'7px 12px', textAlign:'right', color:'var(--text-muted)' }}>{money(r.total_sold)}</td>
                  <td style={{ padding:'7px 12px', textAlign:'right', fontWeight:600 }}>
                    {r.opportunities}
                    {r.thin && <span title="Thin sample — read with caution" style={{ marginLeft:4, color:'var(--warning)' }}>*</span>}
                  </td>
                  <td style={{ padding:'7px 12px', textAlign:'right', color:'var(--text-muted)' }}>{r.won}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.some(r => r.thin) && (
            <div style={{ padding:'8px 12px', fontSize:10, color:'var(--text-muted)', borderTop:'1px solid var(--border)' }}>
              * fewer than 8 opportunities — treat as a hint, not a verdict
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function DispatchPage() {
  const [tab, setTab] = useState('order')
  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0, padding:'0 24px', display:'flex', gap:4 }}>
        {[['order','Batting Order'],['jobtype','By Job Type'],['live','Live Board Analyzer']].map(([id,label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ padding:'12px 14px', border:'none', background:'transparent', cursor:'pointer', fontSize:13,
              fontWeight: tab===id ? 700 : 500, color: tab===id ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: `2px solid ${tab===id ? 'var(--accent)' : 'transparent'}` }}>
            {label}
          </button>
        ))}
      </div>
      <div style={{ flex:1, overflow:'auto', padding:'20px 24px', background:'var(--bg)' }}>
        {tab === 'order' ? <BattingOrder /> : tab === 'jobtype' ? <ByJobType /> : <LiveBoard />}
      </div>
    </div>
  )
}
