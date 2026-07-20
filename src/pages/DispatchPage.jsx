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

const money = (v) => (v == null ? '—' : `$${Math.round(Number(v)).toLocaleString()}`)
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
  const wTotal = weights ? (weights.conversion + weights.avgTicket + weights.membership) : 0

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10, marginBottom:14 }}>
        <div style={{ fontSize:12, color:'var(--text-muted)' }}>
          Ranked within each business unit · {data.windowDays}-day window, recent work weighted heavier ·
          scored {ago(data.refreshedAt)}
        </div>
        <button className="btn sm" onClick={refresh} disabled={busy}>
          {busy ? 'Scoring… (takes a minute)' : 'Rescore now'}
        </button>
      </div>

      {/* Weights */}
      {weights && (
        <div className="card" style={{ padding:'12px 14px', marginBottom:16, display:'flex', alignItems:'center', gap:14, flexWrap:'wrap' }}>
          <span style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)' }}>Weighting</span>
          {[['conversion','Conversion'],['avgTicket','Avg ticket'],['membership','Membership']].map(([k,label]) => (
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
            <div style={{ fontSize:13, fontWeight:700, color:'var(--text-primary)', marginBottom:8 }}>{bu}</div>
            <div className="card" style={{ padding:0, overflow:'hidden' }}>
              <table className="data-table" style={{ fontSize:12 }}>
                <thead><tr>
                  <th style={{width:34}}>#</th><th>Technician</th><th>Tier</th>
                  <th style={{textAlign:'right'}}>Conversion</th>
                  <th style={{textAlign:'right'}}>Avg ticket</th>
                  <th style={{textAlign:'right'}}>Membership</th>
                  <th style={{textAlign:'right'}}>Jobs</th>
                </tr></thead>
                <tbody>
                  {ranked.map(r => (
                    <tr key={r.tech_id} style={{ background: r.tier === 'green' ? 'rgba(21,128,61,.04)' : 'transparent' }}>
                      <td style={{ padding:'7px 12px', color:'var(--text-muted)' }}>{r.rank}</td>
                      <td style={{ padding:'7px 12px', fontWeight:600 }}>{r.tech_name}</td>
                      <td style={{ padding:'7px 12px' }}><TierPill tier={r.tier} /></td>
                      <td style={{ padding:'7px 12px', textAlign:'right', fontWeight:600 }}>{pct(r.conversion)}</td>
                      <td style={{ padding:'7px 12px', textAlign:'right' }}>{money(r.avg_ticket)}</td>
                      <td style={{ padding:'7px 12px', textAlign:'right' }}>{pct(r.membership_pct)}</td>
                      <td style={{ padding:'7px 12px', textAlign:'right', color:'var(--text-muted)' }}>{r.jobs}</td>
                    </tr>
                  ))}
                  {thin.map(r => (
                    <tr key={r.tech_id} style={{ opacity:.6 }}>
                      <td style={{ padding:'7px 12px' }}>—</td>
                      <td style={{ padding:'7px 12px' }}>{r.tech_name}</td>
                      <td style={{ padding:'7px 12px' }}><TierPill tier="unranked" /></td>
                      <td colSpan={3} style={{ padding:'7px 12px', color:'var(--text-muted)', fontSize:11 }}>
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

  const calls = data?.calls || []
  const flagged = calls.filter(c => c.flags?.length)

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10, marginBottom:14 }}>
        <div style={{ fontSize:12, color:'var(--text-muted)' }}>
          {data?.counts?.total ?? 0} calls on today's board · {data?.counts?.flagged ?? 0} flagged ·
          auto-refreshes every 15 min
        </div>
        <button className="btn sm" onClick={load}>Refresh</button>
      </div>

      {(data?.swaps || []).length > 0 && (
        <div style={{ marginBottom:16 }}>
          {data.swaps.map((s, i) => (
            <div key={i} className="card" style={{ padding:'11px 14px', marginBottom:8, borderLeft:'3px solid var(--accent)' }}>
              <div style={{ fontSize:12, fontWeight:600, color:'var(--text-primary)' }}>🔁 {s.text}</div>
              <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:3 }}>{s.businessUnit} · suggestion only — make the change in ServiceTitan</div>
            </div>
          ))}
        </div>
      )}

      {flagged.length === 0 && calls.length > 0 && (
        <div className="card" style={{ padding:'14px 16px', marginBottom:16, fontSize:13, color:'#15803D' }}>
          ✓ No mismatches — every high-opportunity call today is on a capable tech.
        </div>
      )}

      <div className="card" style={{ padding:0, overflow:'hidden' }}>
        <table className="data-table" style={{ fontSize:12 }}>
          <thead><tr>
            <th>Time</th><th>Job</th><th>Business unit</th><th>Technician</th><th>Tier</th>
            <th style={{textAlign:'right'}}>Opp.</th><th>Flag</th>
          </tr></thead>
          <tbody>
            {calls.map((c, i) => (
              <tr key={`${c.appointmentId}-${i}`} style={{ background: c.flags?.length ? 'rgba(185,28,28,.04)' : 'transparent' }}>
                <td style={{ padding:'7px 12px', whiteSpace:'nowrap', color:'var(--text-muted)' }}>
                  {c.start ? new Date(c.start).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) : '—'}
                </td>
                <td style={{ padding:'7px 12px' }}>
                  <div style={{ fontWeight:600 }}>#{c.jobNumber}</div>
                  <div style={{ fontSize:10, color:'var(--text-muted)' }}>{c.jobType}</div>
                </td>
                <td style={{ padding:'7px 12px', fontSize:11, color:'var(--text-muted)' }}>{c.businessUnit}</td>
                <td style={{ padding:'7px 12px' }}>{c.techName}</td>
                <td style={{ padding:'7px 12px' }}><TierPill tier={c.techTier} /></td>
                <td style={{ padding:'7px 12px', textAlign:'right', fontWeight:700,
                  color: c.opportunity >= 3 ? '#B91C1C' : 'var(--text-muted)' }}>{c.opportunity}</td>
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
            {calls.length === 0 && (
              <tr><td colSpan={7} style={{ padding:'26px 12px', textAlign:'center', color:'var(--text-muted)' }}>
                Nothing assigned on today's board yet.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function DispatchPage() {
  const [tab, setTab] = useState('order')
  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0, padding:'0 24px', display:'flex', gap:4 }}>
        {[['order','Batting Order'],['live','Live Board Analyzer']].map(([id,label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ padding:'12px 14px', border:'none', background:'transparent', cursor:'pointer', fontSize:13,
              fontWeight: tab===id ? 700 : 500, color: tab===id ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: `2px solid ${tab===id ? 'var(--accent)' : 'transparent'}` }}>
            {label}
          </button>
        ))}
      </div>
      <div style={{ flex:1, overflow:'auto', padding:'20px 24px', background:'var(--bg)' }}>
        {tab === 'order' ? <BattingOrder /> : <LiveBoard />}
      </div>
    </div>
  )
}
