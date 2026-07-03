import { useState, useEffect } from 'react'
import { useData } from '../lib/DataContext'
import { sb } from '../lib/supabase'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import { isDone, getDupSet, fmtDate, getTimeframeBounds } from '../lib/utils'
import { OUTCOMES, PROG_COLORS } from '../lib/constants'

const TF_OPTIONS = ['today','yesterday','week','month','90days','ytd','all']
const TF_LABELS = { today:'Today', yesterday:'Yesterday', week:'This week', month:'This month', '90days':'90 days', ytd:'YTD', all:'All time' }

export default function DashboardPage() {
  const { contacts, campaigns, dncSet } = useData()
  const [tf, setTf] = useState('today')
  const [logs, setLogs] = useState([])
  const [logsLoading, setLogsLoading] = useState(true)
  const [drilldown, setDrilldown] = useState(null) // { title, contacts }

  useEffect(() => {
    const { start, end } = getTimeframeBounds(tf)
    setLogsLoading(true)
    sb.from('call_logs').select('*').gte('created_at', start.toISOString()).lte('created_at', end.toISOString())
      .then(({ data }) => { setLogs(data || []); setLogsLoading(false) })
  }, [tf])

  const total = contacts.length
  const done = contacts.filter(isDone).length
  const booked = contacts.filter(c => c.status === 'Booked').length
  const dupSet = getDupSet(contacts)
  const pct = total ? Math.round((done/total)*100) : 0

  const outcomeCounts = {}
  OUTCOMES.forEach(o => outcomeCounts[o.id] = 0)
  contacts.forEach(c => { const s = c.status||'Pending'; if (s in outcomeCounts) outcomeCounts[s]++ })

  const tfCalls = logs.length
  const tfBooked = logs.filter(l => l.outcome === 'Booked').length
  const tfConv = tfCalls ? Math.round((tfBooked/tfCalls)*100) : 0

  const repStats = {}
  logs.forEach(l => {
    const rep = l.rep || '?'
    if (!repStats[rep]) repStats[rep] = { calls:0, booked:0, vm:0, na:0, ni:0, dnc:0 }
    repStats[rep].calls++
    if (l.outcome === 'Booked') repStats[rep].booked++
    if (l.outcome === 'Voicemail') repStats[rep].vm++
    if (l.outcome === 'No Answer') repStats[rep].na++
    if (l.outcome === 'Not Interested') repStats[rep].ni++
    if (l.outcome === 'DNC') repStats[rep].dnc++
  })

  const campName = (c) => campaigns.find(x => x.id === c.campaign_id)?.name || ''

  const exportCSV = (type) => {
    let rows, filename
    if (type === 'all') { rows = contacts; filename = 'AHS_All_Contacts.csv' }
    else if (type === 'booked') { rows = contacts.filter(c => c.status === 'Booked'); filename = 'AHS_Booked.csv' }
    else { rows = contacts.filter(c => c.status === 'DNC'); filename = 'AHS_DNC.csv' }
    const esc = v => { if(v==null)return''; const s=String(v); return s.includes(',')||s.includes('"')||s.includes('\n')?`"${s.replace(/"/g,'""')}"`:`${s}` }
    const h = ['Name','Phone','Email','Address','City','State','Zip','Campaign','Status','Attempts','Source','ExternalID','CallbackAt']
    const csv = [h.join(','), ...rows.map(c => [c.name,c.phone,c.email,c.address,c.city,c.state,c.zip,campName(c),c.status,c.attempts,c.source,c.external_id,c.callback_at].map(esc).join(','))].join('\n')
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download = filename; a.click()
  }

  return (
    <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:20 }}>
      {/* Timeframe + exports */}
      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
        <span style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', marginRight:4 }}>Timeframe:</span>
        {TF_OPTIONS.map(t => (
          <button key={t} onClick={() => setTf(t)}
            style={{ padding:'4px 10px', borderRadius:99, fontSize:11, fontWeight:500, border:'1px solid', cursor:'pointer',
              borderColor: tf===t ? 'var(--accent)' : 'var(--border-strong)',
              background: tf===t ? 'var(--accent)' : 'var(--surface)',
              color: tf===t ? '#fff' : 'var(--text-secondary)' }}>
            {TF_LABELS[t]}
          </button>
        ))}
        <div style={{ marginLeft:'auto', display:'flex', gap:8, flexWrap:'wrap' }}>
          <button className="btn sm success" onClick={() => exportCSV('all')}>⬇ All contacts</button>
          <button className="btn sm" onClick={() => exportCSV('booked')}>⬇ Booked</button>
          <button className="btn sm" onClick={() => exportCSV('dnc')}>⬇ DNC list</button>
        </div>
      </div>

      {/* Pipeline stats */}
      <div>
        <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:8 }}>📋 Pipeline — all time</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))', gap:10 }}>
          {[
            { label:'Total contacts', value:total.toLocaleString(), color:'accent', onClick:()=>setDrilldown({title:'All contacts',rows:contacts}) },
            { label:'Remaining', value:(total-done).toLocaleString(), color:'warning', onClick:()=>setDrilldown({title:'Active contacts',rows:contacts.filter(c=>!isDone(c))}) },
            { label:'Total booked', value:booked.toLocaleString(), sub:`${total?Math.round((booked/total)*100):0}% conversion`, color:'success', onClick:()=>setDrilldown({title:'Booked contacts',rows:contacts.filter(c=>c.status==='Booked')}) },
            { label:'Completed', value:done.toLocaleString(), sub:`${pct}% of list`, color:'purple' },
            { label:'Duplicates', value:dupSet.size, color:'danger', onClick:()=>setDrilldown({title:'Duplicate phone numbers',rows:contacts.filter(c=>dupSet.has(c.id))}) },
          ].map(({ label, value, sub, color, onClick }) => (
            <div key={label} className={`stat-card ${onClick?'clickable':''}`} style={{ borderLeft:`3px solid var(--${color})` }} onClick={onClick}>
              <div className="stat-label">{label}</div>
              <div className="stat-value">{value}</div>
              {sub && <div className="stat-sub">{sub}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* Call activity */}
      <div>
        <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:8 }}>📞 Call activity — {TF_LABELS[tf]}</div>
        {logsLoading ? <div className="spinner" style={{margin:'20px auto'}}></div> : (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))', gap:10 }}>
            {[
              { label:'Calls made', value:tfCalls.toLocaleString(), color:'accent' },
              { label:'Booked', value:tfBooked.toLocaleString(), sub:`${tfConv}% conv.`, color:'success' },
              { label:'No ans + VM', value:logs.filter(l=>['No Answer','Voicemail'].includes(l.outcome)).length, color:'warning' },
              { label:'Not int + DNC', value:logs.filter(l=>['Not Interested','DNC'].includes(l.outcome)).length, color:'danger' },
            ].map(({ label, value, sub, color }) => (
              <div key={label} className="stat-card" style={{ borderLeft:`3px solid var(--${color})` }}>
                <div className="stat-label">{label}</div>
                <div className="stat-value">{value}</div>
                {sub && <div className="stat-sub">{sub}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Progress + Outcomes */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
        <div className="card">
          <div className="card-header"><div className="card-title">Overall progress</div><span style={{fontSize:11,color:'var(--text-muted)'}}>{pct}% done</span></div>
          <div className="card-body">
            <div className="progress-track" style={{marginBottom:10}}>
              {Object.entries(PROG_COLORS).map(([k, col]) => {
                const cnt = contacts.filter(c => (c.status||'Pending') === k).length
                if (!cnt || !total) return null
                return <div key={k} className="progress-fill" style={{ width:`${Math.max(1,(cnt/total)*100).toFixed(1)}%`, background:col }} />
              })}
            </div>
            <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
              {Object.entries(PROG_COLORS).map(([k, col]) => (
                <div key={k} style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, color:'var(--text-secondary)' }}>
                  <div style={{ width:7, height:7, borderRadius:'50%', background:col, flexShrink:0 }}></div>{k}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-header"><div className="card-title">Outcomes breakdown</div></div>
          <table className="data-table">
            <tbody>
              {OUTCOMES.map(o => {
                const cnt = outcomeCounts[o.id] || 0
                const p = total ? Math.round((cnt/total)*100) : 0
                return (
                  <tr key={o.id} className="clickable" onClick={() => setDrilldown({title:`${o.id} contacts`,rows:contacts.filter(c=>c.status===o.id)})}>
                    <td style={{padding:'8px 12px'}}><Badge status={o.id} /></td>
                    <td style={{padding:'8px 12px',textAlign:'center',fontWeight:600}}>{cnt}</td>
                    <td style={{padding:'8px 12px',textAlign:'center',color:'var(--text-muted)'}}>{p}%</td>
                    <td style={{padding:'8px 12px',color:'var(--accent)',fontSize:11}}>View →</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Rep performance */}
      {!logsLoading && (
        <div className="card">
          <div className="card-header"><div className="card-title">Rep performance — {TF_LABELS[tf]}</div></div>
          <div className="card-body" style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:12 }}>
            {Object.keys(repStats).length === 0 ? (
              <div style={{ color:'var(--text-muted)', fontSize:12 }}>No calls in this period.</div>
            ) : Object.entries(repStats).sort((a,b) => b[1].calls - a[1].calls).map(([rep, d]) => {
              const conv = d.calls ? Math.round((d.booked/d.calls)*100) : 0
              return (
                <div key={rep} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'14px 16px' }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                    <div style={{ fontSize:13, fontWeight:600 }}>{rep}</div>
                    <Badge status="Booked" style={{}}>{d.booked} booked</Badge>
                  </div>
                  <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
                    {[['Calls',d.calls,'text-primary'],['Booked',d.booked,'success'],['VM',d.vm,'purple'],['No ans',d.na,'warning'],['Not int',d.ni,'danger'],['Conv',conv+'%','text-primary']].map(([l,v,c])=>(
                      <div key={l} style={{ textAlign:'center' }}>
                        <div style={{ fontSize:16, fontWeight:600, color:`var(--${c})` }}>{v}</div>
                        <div style={{ fontSize:10, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:.4 }}>{l}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ height:4, background:'var(--surface-2)', borderRadius:99, marginTop:10, overflow:'hidden' }}>
                    <div style={{ height:'100%', width:`${conv}%`, background:'var(--success)', borderRadius:99 }}></div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Campaign breakdown */}
      <div className="card">
        <div className="card-header"><div className="card-title">Campaign breakdown</div></div>
        <table className="data-table">
          <thead><tr><th>Campaign</th><th>Status</th><th style={{textAlign:'center'}}>Total</th><th style={{textAlign:'center'}}>Remaining</th><th style={{textAlign:'center'}}>Booked</th><th style={{textAlign:'center'}}>Done%</th></tr></thead>
          <tbody>
            {campaigns.map(camp => {
              const cc = contacts.filter(c => c.campaign_id === camp.id)
              const t=cc.length, d=cc.filter(isDone).length, b=cc.filter(c=>c.status==='Booked').length
              const p=t?Math.round((d/t)*100):0
              return (
                <tr key={camp.id} className="clickable" onClick={() => setDrilldown({title:`${camp.name} — All contacts`,rows:cc})}>
                  <td style={{padding:'9px 12px',fontWeight:500}}>{camp.name}</td>
                  <td style={{padding:'9px 12px'}}><Badge status={camp.status} /></td>
                  <td style={{padding:'9px 12px',textAlign:'center'}}>{t}</td>
                  <td style={{padding:'9px 12px',textAlign:'center',color:'var(--warning)'}}>{t-d}</td>
                  <td style={{padding:'9px 12px',textAlign:'center',color:'var(--success)',fontWeight:600}}>{b}</td>
                  <td style={{padding:'9px 12px',textAlign:'center'}}>{p}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Drilldown modal */}
      {drilldown && (
        <Modal title={`${drilldown.title} (${drilldown.rows.length})`} onClose={() => setDrilldown(null)} width={900}>
          <div style={{ overflowX:'auto', maxHeight:'60vh', overflowY:'auto' }}>
            <table className="data-table" style={{ minWidth:600 }}>
              <thead><tr><th>Name</th><th>Phone</th><th>Campaign</th><th>Status</th></tr></thead>
              <tbody>
                {drilldown.rows.map(c => (
                  <tr key={c.id}>
                    <td style={{padding:'8px 12px',fontWeight:500}}>{c.name||'—'}</td>
                    <td style={{padding:'8px 12px'}}>{c.phone||'—'}</td>
                    <td style={{padding:'8px 12px'}}>{campName(c)||'—'}</td>
                    <td style={{padding:'8px 12px'}}><Badge status={c.status||'Pending'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setDrilldown(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
