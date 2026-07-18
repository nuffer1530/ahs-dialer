import { useState, useEffect, useCallback } from 'react'

// 3-Day Call Board — repair/replacement capacity per trade for today + next two
// days, live from ServiceTitan via /api/board/3day. The point is spotting gaps:
// how many more calls each trade needs to book to hit capacity.

const STATUS = {
  good:  { color:'#16A34A', bg:'#EAF5EE', label:'At / over capacity' },
  warn:  { color:'#C87800', bg:'#FBF3E0', label:'Filling up' },
  under: { color:'#DC2626', bg:'#FBEEEA', label:'Below capacity' },
  none:  { color:'#6B7280', bg:'var(--surface-2)', label:'No techs' },
}
const DAY_LABELS = ['Today', 'Tomorrow', 'Day 3']

function Cell({ d }) {
  const s = STATUS[d.status] || STATUS.none
  return (
    <div style={{ border:`1px solid var(--border)`, borderRadius:'var(--radius-lg)', overflow:'hidden', background:'var(--surface)' }}>
      <div style={{ background:s.bg, padding:'8px 12px', display:'flex', alignItems:'center', justifyContent:'space-between', borderBottom:`1px solid var(--border)` }}>
        <span style={{ fontSize:11, fontWeight:700, color:s.color }}>{d.pct}%</span>
        <span style={{ fontSize:10, fontWeight:600, color:s.color, textTransform:'uppercase', letterSpacing:.4 }}>{s.label}</span>
      </div>
      <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:8 }}>
        <div>
          <div style={{ fontSize:30, fontWeight:800, lineHeight:1, color: d.needed > 0 ? s.color : 'var(--text-muted)' }}>
            {d.needed > 0 ? d.needed : '✓'}
          </div>
          <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>{d.needed > 0 ? 'calls needed' : 'at capacity'}</div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'4px 12px', fontSize:11 }}>
          <Metric label="Techs" value={d.techs} />
          <Metric label="Booked" value={`${d.calls}/${d.capacity}`} />
          <Metric label="Opps" value={d.opps} />
          <Metric label="Installs" value={d.installs} />
        </div>
      </div>
    </div>
  )
}
function Metric({ label, value }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', gap:8 }}>
      <span style={{ color:'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight:700, color:'var(--text-primary)', fontVariantNumeric:'tabular-nums' }}>{value}</span>
    </div>
  )
}

export default function CallBoardPage() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/board/3day')
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Failed to load board')
      setData(d); setError(''); setRefreshedAt(new Date())
    } catch (e) {
      setError(e.message)
    } finally { setLoading(false) }
  }, [])

  // Always up to date: refresh every 90s.
  useEffect(() => {
    load()
    const t = setInterval(load, 90_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0, padding:'14px 24px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div>
          <div style={{ fontSize:18, fontWeight:700 }}>3-Day Call Board</div>
          <div style={{ fontSize:12, color:'var(--text-muted)' }}>Repair &amp; replacement capacity by trade · live from ServiceTitan</div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          {refreshedAt && <span style={{ fontSize:11, color:'var(--text-muted)' }}>Updated {refreshedAt.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</span>}
          <button className="btn sm" onClick={load}>Refresh</button>
        </div>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:24, background:'var(--bg)' }}>
        {loading ? <div className="spinner lg" style={{ margin:'60px auto' }} /> :
         error ? <div style={{ color:'var(--danger)', fontSize:13, background:'var(--danger-bg)', padding:'12px 16px', borderRadius:'var(--radius)' }}>Couldn’t load the board: {error}</div> :
         !data ? null : (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            {/* Column headers */}
            <div style={{ display:'grid', gridTemplateColumns:'150px repeat(3, 1fr)', gap:14, alignItems:'end' }}>
              <div />
              {data.dates.map((date, i) => (
                <div key={date} style={{ textAlign:'center' }}>
                  <div style={{ fontSize:13, fontWeight:700 }}>{DAY_LABELS[i]}</div>
                  <div style={{ fontSize:11, color:'var(--text-muted)' }}>{new Date(date + 'T12:00:00').toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' })}</div>
                </div>
              ))}
            </div>
            {/* Trade rows */}
            {data.board.map(row => (
              <div key={row.trade} style={{ display:'grid', gridTemplateColumns:'150px repeat(3, 1fr)', gap:14, alignItems:'stretch' }}>
                <div style={{ display:'flex', alignItems:'center', fontSize:15, fontWeight:700 }}>{row.trade}</div>
                {row.days.map((d, i) => <Cell key={i} d={d} />)}
              </div>
            ))}
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:6 }}>
              Techs = service technicians scheduled (install crews excluded). Capacity = techs × calls-per-tech.
              Booked / Opps / Installs are jobs scheduled that day in ServiceTitan.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
