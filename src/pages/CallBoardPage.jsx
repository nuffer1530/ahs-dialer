import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'

// 3-Day Call Board — repair/replacement capacity per trade for today + next two
// days, live from ServiceTitan via /api/board/3day. Every number is clickable to
// show exactly which techs/jobs are behind it.

const STATUS = {
  good:  { color:'#16A34A', bg:'#EAF5EE', label:'At / over target' },
  warn:  { color:'#C87800', bg:'#FBF3E0', label:'Filling up' },
  under: { color:'#DC2626', bg:'#FBEEEA', label:'Below capacity' },
  none:  { color:'#6B7280', bg:'var(--surface-2)', label:'No techs' },
}
const DAY_LABELS = ['Today', 'Tomorrow', 'Day 3']

// One clickable metric that opens the drill-down for its underlying items.
function Metric({ label, value, onClick, strong }) {
  return (
    <button onClick={onClick} title="Click to see what's counted"
      style={{ display:'flex', justifyContent:'space-between', gap:8, width:'100%', padding:'2px 4px', border:'none',
        background:'transparent', cursor:'pointer', borderRadius:4, fontSize:11, textAlign:'left' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
      <span style={{ color:'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight:700, color:'var(--text-primary)', fontVariantNumeric:'tabular-nums', textDecoration:'underline dotted var(--border)' }}>{value}</span>
    </button>
  )
}

function Cell({ trade, dayLabel, d, onDrill }) {
  const s = STATUS[d.status] || STATUS.none
  const oppRate = d.calls ? Math.round((d.opps / d.calls) * 100) : null
  return (
    <div style={{ border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden', background:'var(--surface)' }}>
      <div style={{ background:s.bg, padding:'8px 12px', display:'flex', alignItems:'center', justifyContent:'space-between', borderBottom:'1px solid var(--border)' }}>
        <span style={{ fontSize:12, fontWeight:800, color:s.color }}>{d.pct}%</span>
        <span style={{ fontSize:10, fontWeight:600, color:s.color, textTransform:'uppercase', letterSpacing:.4 }}>{s.label}</span>
      </div>
      <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:8 }}>
        <div>
          <div style={{ fontSize:30, fontWeight:800, lineHeight:1, color: d.needed > 0 ? s.color : 'var(--text-muted)' }}>
            {d.needed > 0 ? d.needed : '✓'}
          </div>
          <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>{d.needed > 0 ? 'calls needed' : 'at target'}</div>
        </div>
        <div style={{ display:'flex', flexDirection:'column' }}>
          <Metric label="Techs" value={d.techs} onClick={() => onDrill(trade, dayLabel, 'Service techs', d.detail.techs, 'tech')} />
          <Metric label="Booked" value={`${d.calls}/${d.capacity}`} onClick={() => onDrill(trade, dayLabel, 'Booked calls', d.detail.calls, 'job')} />
          <Metric label={`Opps${oppRate != null ? ` (${oppRate}%)` : ''}`} value={d.opps} onClick={() => onDrill(trade, dayLabel, 'Opportunities', d.detail.opps, 'job')} />
          <Metric label="Installs" value={d.installs} onClick={() => onDrill(trade, dayLabel, 'Installs', d.detail.installs, 'job')} />
        </div>
      </div>
    </div>
  )
}

export default function CallBoardPage() {
  const { isAdmin } = useAuth()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState(null)
  const [drill, setDrill] = useState(null)      // { trade, day, label, items, kind }
  const [config, setConfig] = useState(null)    // { trades, callsPerTech, default }
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
    const t = setInterval(load, 90_000)   // always up to date
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
    setShowConfig(false)
    load()
  }

  const drillItems = drill?.items || []

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0, padding:'14px 24px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div>
          <div style={{ fontSize:18, fontWeight:700 }}>3-Day Call Board</div>
          <div style={{ fontSize:12, color:'var(--text-muted)' }}>Repair &amp; replacement capacity by trade · target {data?.target ?? 80}% · live from ServiceTitan</div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          {refreshedAt && <span style={{ fontSize:11, color:'var(--text-muted)' }}>Updated {refreshedAt.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</span>}
          {isAdmin && <button className="btn sm" onClick={openConfig}>Calls / tech</button>}
          <button className="btn sm" onClick={load}>Refresh</button>
        </div>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:24, background:'var(--bg)' }}>
        {loading ? <div className="spinner lg" style={{ margin:'60px auto' }} /> :
         error ? <div style={{ color:'var(--danger)', fontSize:13, background:'var(--danger-bg)', padding:'12px 16px', borderRadius:'var(--radius)' }}>Couldn’t load the board: {error}</div> :
         !data ? null : (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div style={{ display:'grid', gridTemplateColumns:'150px repeat(3, 1fr)', gap:14, alignItems:'end' }}>
              <div />
              {data.dates.map((date, i) => (
                <div key={date} style={{ textAlign:'center' }}>
                  <div style={{ fontSize:13, fontWeight:700 }}>{DAY_LABELS[i]}</div>
                  <div style={{ fontSize:11, color:'var(--text-muted)' }}>{new Date(date + 'T12:00:00').toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' })}</div>
                </div>
              ))}
            </div>
            {data.board.map(row => (
              <div key={row.trade} style={{ display:'grid', gridTemplateColumns:'150px repeat(3, 1fr)', gap:14, alignItems:'stretch' }}>
                <div style={{ display:'flex', alignItems:'center', fontSize:15, fontWeight:700 }}>{row.trade}</div>
                {row.days.map((d, i) => <Cell key={i} trade={row.trade} dayLabel={DAY_LABELS[i]} d={d} onDrill={(t, day, label, items, kind) => setDrill({ trade:t, day, label, items, kind })} />)}
              </div>
            ))}
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:6 }}>
              Click any number to see exactly what it counts. Techs = service technicians scheduled (install crews excluded).
              Opps exclude installs, warranty and callbacks, and maintenance — except HVAC maintenance on systems 12+ years old.
            </div>
          </div>
        )}
      </div>

      {/* Drill-down */}
      {drill && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.45)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center' }} onMouseDown={() => setDrill(null)}>
          <div onMouseDown={e => e.stopPropagation()} style={{ background:'var(--surface)', borderRadius:12, width:520, maxHeight:'80vh', overflow:'hidden', display:'flex', flexDirection:'column', boxShadow:'0 8px 32px rgba(0,0,0,.28)' }}>
            <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--border)' }}>
              <div style={{ fontSize:15, fontWeight:700 }}>{drill.trade} · {drill.label}</div>
              <div style={{ fontSize:12, color:'var(--text-muted)' }}>{drill.day} · {drillItems.length} {drill.kind === 'tech' ? 'technician(s)' : 'job(s)'}</div>
            </div>
            <div style={{ overflowY:'auto', padding:'6px 0' }}>
              {drillItems.length === 0 ? (
                <div style={{ padding:20, color:'var(--text-muted)', fontSize:13, textAlign:'center' }}>Nothing counted here.</div>
              ) : drill.kind === 'tech' ? (
                drillItems.map((t, i) => (
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'10px 18px', borderBottom:'1px solid var(--border)', fontSize:13 }}>
                    <span style={{ opacity: t.off === 'off' ? .5 : 1 }}>{t.name}</span>
                    <span style={{ fontSize:11, color: t.off === 'off' ? 'var(--danger)' : t.off ? '#C87800' : 'var(--success)', fontWeight:600 }}>
                      {t.off === 'off' ? 'Off today' : t.off ? `Partial (${t.off})` : 'Working'}
                    </span>
                  </div>
                ))
              ) : (
                drillItems.map((j, i) => (
                  <div key={i} style={{ padding:'10px 18px', borderBottom:'1px solid var(--border)', fontSize:13 }}>
                    <div style={{ display:'flex', gap:8 }}>
                      <span style={{ fontWeight:700, color:'var(--accent)' }}>#{j.jobNumber}</span>
                      <span style={{ fontWeight:500 }}>{j.type}</span>
                    </div>
                    {j.summary && <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>{j.summary}</div>}
                  </div>
                ))
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
            <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:16 }}>How many repair/replacement calls one service tech can run in a day, per trade. Default {config.default}.</div>
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
