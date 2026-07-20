import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'

// 3-Day Call Board — repair/replacement capacity per trade for today + next two
// days, live from ServiceTitan. Every number is clickable to show what's behind it.

const STATUS = {
  good:  { color:'#16A34A', bg:'#EAF5EE', label:'At / over target' },
  warn:  { color:'#C87800', bg:'#FBF3E0', label:'Filling up' },
  under: { color:'#DC2626', bg:'#FBEEEA', label:'Below capacity' },
  none:  { color:'#6B7280', bg:'var(--surface-2)', label:'No techs' },
}
const DAY_LABELS = ['Today', 'Tomorrow', 'Day 3']
const ST_JOB_URL = (jobId) => `https://go.servicetitan.com/#/Job/Index/${jobId}`

// One clickable metric column in a cell's footer strip.
function Metric({ label, value, accent, onClick }) {
  return (
    <button onClick={onClick} title="Click to see what's counted"
      style={{ flex:1, minWidth:0, padding:'10px 6px', border:'none', background:'transparent', cursor:'pointer',
        display:'flex', flexDirection:'column', alignItems:'center', gap:3, borderRadius:6 }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
      <span style={{ fontSize:18, fontWeight:800, color: accent || 'var(--text-primary)', fontVariantNumeric:'tabular-nums', lineHeight:1 }}>{value}</span>
      <span style={{ fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:.4, color:'var(--text-muted)', whiteSpace:'nowrap' }}>{label}</span>
    </button>
  )
}

function Cell({ trade, dayLabel, d, onDrill }) {
  const s = STATUS[d.status] || STATUS.none
  const oppRate = d.calls ? Math.round((d.opps / d.calls) * 100) : null
  return (
    <div style={{ border:`1px solid var(--border)`, borderRadius:14, overflow:'hidden', background:'var(--surface)', display:'flex', flexDirection:'column' }}>
      {/* Status header */}
      <div style={{ background:s.bg, padding:'7px 14px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <span style={{ fontSize:13, fontWeight:800, color:s.color, fontVariantNumeric:'tabular-nums' }}>{d.pct}%</span>
        <span style={{ fontSize:10, fontWeight:700, color:s.color, textTransform:'uppercase', letterSpacing:.5 }}>{s.label}</span>
      </div>
      {/* Hero: calls needed */}
      <div style={{ padding:'16px 16px 12px', display:'flex', alignItems:'baseline', gap:10 }}>
        <span style={{ fontSize:46, fontWeight:800, lineHeight:.9, color: d.needed > 0 ? s.color : '#16A34A', fontVariantNumeric:'tabular-nums' }}>
          {d.needed > 0 ? d.needed : '✓'}
        </span>
        <span style={{ fontSize:12, color:'var(--text-muted)', fontWeight:600 }}>{d.needed > 0 ? 'calls needed' : 'at target'}</span>
      </div>
      {/* Metric strip */}
      <div style={{ display:'flex', borderTop:'1px solid var(--border)', marginTop:'auto' }}>
        <Metric label="Techs" value={d.techs} onClick={() => onDrill(trade, dayLabel, 'Service techs', d.detail.techs, 'tech')} />
        <div style={{ width:1, background:'var(--border)' }} />
        <Metric label="Booked" value={`${d.calls}/${d.capacity}`} onClick={() => onDrill(trade, dayLabel, 'Booked calls', d.detail.calls, 'job')} />
        <div style={{ width:1, background:'var(--border)' }} />
        <Metric label={oppRate != null ? `Opps ${oppRate}%` : 'Opps'} value={d.opps}
          accent={oppRate == null ? undefined : oppRate >= 30 ? '#16A34A' : '#DC2626'}
          onClick={() => onDrill(trade, dayLabel, 'Opportunities', d.detail.opps, 'job')} />
        <div style={{ width:1, background:'var(--border)' }} />
        <Metric label="Installs" value={d.installs} onClick={() => onDrill(trade, dayLabel, 'Installs', d.detail.installs, 'job')} />
      </div>
    </div>
  )
}

export default function CallBoardPage() {
  const { isAdmin, profile } = useAuth()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState(null)

  // Send the board digest to YOURSELF only. Deliberately not a "send to the
  // team" button — the leadership blast is the scheduled job, so nobody can
  // mail the whole management list with a stray click.
  const [emailing, setEmailing] = useState(false)
  const [emailMsg, setEmailMsg] = useState('')
  const emailMe = async () => {
    const to = profile?.email
    if (!to) { setEmailMsg('No email on your profile'); return }
    setEmailing(true); setEmailMsg('')
    try {
      const { data: { session } } = await sb.auth.getSession()
      const r = await fetch('/api/board/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ to }),
      })
      const d = await r.json().catch(() => ({}))
      setEmailMsg(r.ok ? `Sent to ${to}` : (d.error || 'Send failed'))
    } catch (e) {
      setEmailMsg(e.message)
    } finally {
      setEmailing(false)
      setTimeout(() => setEmailMsg(''), 6000)
    }
  }
  const [drill, setDrill] = useState(null)
  const [config, setConfig] = useState(null)
  const [showConfig, setShowConfig] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/board/3day')
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Failed to load board')
      setData(d); setError(''); setRefreshedAt(new Date())
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 90_000)
    return () => clearInterval(t)
  }, [load])

  const openConfig = async () => {
    const res = await fetch('/api/board/config')
    setConfig(await res.json())
    setShowConfig(true)
  }
  const saveConfig = async () => {
    const { data: { session } } = await sb.auth.getSession()
    await fetch('/api/board/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ callsPerTech: config.callsPerTech }),
    })
    setShowConfig(false); load()
  }

  const drillItems = drill?.items || []

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
      {/* Slim toolbar (page title is already in the top bar) */}
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0, padding:'10px 24px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <span style={{ fontSize:12, color:'var(--text-muted)' }}>Target {data?.target ?? 80}% · live from ServiceTitan</span>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          {refreshedAt && <span style={{ fontSize:11, color:'var(--text-muted)' }}>Updated {refreshedAt.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</span>}
          {isAdmin && <button className="btn sm" onClick={openConfig}>Calls / tech</button>}
          {isAdmin && (
            <button className="btn sm" onClick={emailMe} disabled={emailing}
              title="Send this board to your own email — nobody else receives it">
              {emailing ? 'Sending…' : emailMsg || 'Email me this board'}
            </button>
          )}
          <button className="btn sm" onClick={load}>Refresh</button>
        </div>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'20px 24px', background:'var(--bg)' }}>
        {loading ? <div className="spinner lg" style={{ margin:'60px auto' }} /> :
         error ? <div style={{ color:'var(--danger)', fontSize:13, background:'var(--danger-bg)', padding:'12px 16px', borderRadius:'var(--radius)' }}>Couldn’t load the board: {error}</div> :
         !data ? null : (
          <div style={{ display:'flex', flexDirection:'column', gap:18 }}>
            {/* Day headers */}
            <div style={{ display:'grid', gridTemplateColumns:'130px repeat(3, 1fr)', gap:16, alignItems:'end' }}>
              <div />
              {data.dates.map((date, i) => (
                <div key={date} style={{ textAlign:'center' }}>
                  <div style={{ fontSize:15, fontWeight:800 }}>{DAY_LABELS[i]}</div>
                  <div style={{ fontSize:11, color:'var(--text-muted)' }}>{new Date(date + 'T12:00:00').toLocaleDateString([], { weekday:'long', month:'short', day:'numeric' })}</div>
                </div>
              ))}
            </div>
            {/* Trade rows */}
            {data.board.map(row => (
              <div key={row.trade} style={{ display:'grid', gridTemplateColumns:'130px repeat(3, 1fr)', gap:16, alignItems:'stretch' }}>
                <div style={{ display:'flex', alignItems:'center', fontSize:17, fontWeight:800 }}>{row.trade}</div>
                {row.days.map((d, i) => <Cell key={i} trade={row.trade} dayLabel={DAY_LABELS[i]} d={d} onDrill={(t, day, label, items, kind) => setDrill({ trade:t, day, label, items, kind })} />)}
              </div>
            ))}
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4, lineHeight:1.6 }}>
              Click any number to see what it counts. Techs = service technicians scheduled (install crews excluded).
              Booked excludes follow-up, callback, permitting and phone-call jobs.
              Opps also exclude installs, warranty, and maintenance — except HVAC maintenance on systems 12+ years old.
            </div>
          </div>
        )}
      </div>

      {/* Drill-down */}
      {drill && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.45)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center' }} onMouseDown={() => setDrill(null)}>
          <div onMouseDown={e => e.stopPropagation()} style={{ background:'var(--surface)', borderRadius:12, width:460, maxHeight:'80vh', overflow:'hidden', display:'flex', flexDirection:'column', boxShadow:'0 8px 32px rgba(0,0,0,.28)' }}>
            <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--border)' }}>
              <div style={{ fontSize:15, fontWeight:700 }}>{drill.trade} · {drill.label}</div>
              <div style={{ fontSize:12, color:'var(--text-muted)' }}>{drill.day} · {drillItems.length} {drill.kind === 'tech' ? 'technician(s)' : 'job(s)'}</div>
            </div>
            <div style={{ overflowY:'auto' }}>
              {drillItems.length === 0 ? (
                <div style={{ padding:20, color:'var(--text-muted)', fontSize:13, textAlign:'center' }}>Nothing counted here.</div>
              ) : drill.kind === 'tech' ? (
                drillItems.map((t, i) => (
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'11px 18px', borderBottom:'1px solid var(--border)', fontSize:13 }}>
                    <span style={{ opacity: t.off === 'off' ? .5 : 1 }}>{t.name}</span>
                    <span style={{ fontSize:11, color: t.off === 'off' ? 'var(--danger)' : t.off ? '#C87800' : 'var(--success)', fontWeight:600 }}>
                      {t.off === 'off' ? 'Off today' : t.off ? `Partial (${t.off})` : 'Working'}
                    </span>
                  </div>
                ))
              ) : (
                drillItems.map((j, i) => {
                  const row = (
                    <>
                      <span style={{ fontWeight:700, color:'var(--accent)', flexShrink:0 }}>
                        #{j.jobNumber}{j.id ? ' ↗' : ''}
                      </span>
                      <span style={{ fontWeight:500 }}>{j.type}</span>
                    </>
                  )
                  const style = { display:'flex', gap:10, padding:'11px 18px', borderBottom:'1px solid var(--border)', fontSize:13 }
                  // Older cached board payloads have no id — fall back to plain
                  // text rather than rendering a link that goes nowhere.
                  return j.id ? (
                    <a key={i} href={ST_JOB_URL(j.id)} target="_blank" rel="noopener noreferrer"
                      title="Open this job in ServiceTitan"
                      style={{ ...style, textDecoration:'none', color:'var(--text-primary)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      {row}
                    </a>
                  ) : (
                    <div key={i} style={style}>{row}</div>
                  )
                })
              )}
            </div>
            <div style={{ padding:'12px 18px', borderTop:'1px solid var(--border)', textAlign:'right' }}>
              <button className="btn sm" onClick={() => setDrill(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Calls-per-tech config (admin) */}
      {showConfig && config && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.45)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center' }} onMouseDown={() => setShowConfig(false)}>
          <div onMouseDown={e => e.stopPropagation()} style={{ background:'var(--surface)', borderRadius:12, width:360, padding:22, boxShadow:'0 8px 32px rgba(0,0,0,.28)' }}>
            <div style={{ fontSize:15, fontWeight:700, marginBottom:4 }}>Calls per tech</div>
            <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:16 }}>Repair/replacement calls one service tech can run in a day, per trade. Default {config.default}.</div>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {config.trades.map(t => (
                <div key={t} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
                  <span style={{ fontSize:13, fontWeight:600 }}>{t}</span>
                  <input type="number" min="0.5" step="0.5"
                    value={config.callsPerTech[t] ?? ''} placeholder={String(config.default)}
                    onChange={e => setConfig(c => ({ ...c, callsPerTech: { ...c.callsPerTech, [t]: e.target.value === '' ? undefined : Number(e.target.value) } }))}
                    style={{ width:90, padding:'6px 8px', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:13, background:'var(--surface-2)', color:'var(--text-primary)' }} />
                </div>
              ))}
            </div>
            <div className="modal-actions" style={{ marginTop:18 }}>
              <button className="btn" onClick={() => setShowConfig(false)}>Cancel</button>
              <button className="btn primary" onClick={saveConfig}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
