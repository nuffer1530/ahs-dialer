import { useState, useEffect } from 'react'
import { useData } from '../lib/DataContext'
import { sb } from '../lib/supabase'
import Badge from '../components/Badge'
import { isDone, fmtShort } from '../lib/utils'

export default function LivePage() {
  const { contacts, campaigns } = useData()
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const since = new Date(Date.now() - 24*60*60*1000).toISOString()
    sb.from('call_logs').select('*').gte('created_at', since).order('created_at', { ascending: false })
      .then(({ data }) => { setLogs(data || []); setLoading(false) })

    // Real-time updates for new logs
    const channel = sb.channel('live-logs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_logs' }, payload => {
        setLogs(prev => [payload.new, ...prev])
      })
      .subscribe()
    return () => sb.removeChannel(channel)
  }, [])

  const now = new Date()
  const todayStr = now.toDateString()
  const campName = (c) => campaigns.find(x => x.id === c.campaign_id)?.name || ''

  // Get unique reps from logs
  const reps = [...new Set(logs.map(l => l.rep).filter(Boolean))]

  if (loading) return <div style={{ display:'flex', alignItems:'center', justifyContent:'center', flex:1 }}><div className="spinner lg"></div></div>

  return (
    <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:20 }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <h1 style={{ fontSize:20, fontWeight:600 }}>Live Rep Activity</h1>
        <div className="live-dot"></div>
        <span style={{ fontSize:11, color:'var(--text-muted)' }}>Real-time · Last 24 hours</span>
      </div>

      {/* Rep cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))', gap:12 }}>
        {reps.length === 0 ? (
          <div style={{ color:'var(--text-muted)', fontSize:13, gridColumn:'1/-1' }}>No activity in the last 24 hours.</div>
        ) : reps.map(rep => {
          const repLogs = logs.filter(l => l.rep === rep)
          const last = repLogs[0]
          const todayLogs = repLogs.filter(l => new Date(l.created_at).toDateString() === todayStr)
          const claimed = contacts.filter(c => c.claimed_by === rep && !isDone(c)).length
          const isActive = last && (now - new Date(last.created_at)) < 30*60*1000
          const lastContact = last ? contacts.find(c => c.id === last.contact_id) : null
          return (
            <div key={rep} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'14px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
              <div>
                <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:6 }}>
                  <div style={{ width:7, height:7, borderRadius:'50%', background: isActive ? 'var(--success)' : 'var(--border-strong)', animation: isActive ? 'pulse 1.5s infinite' : 'none' }}></div>
                  {rep}
                </div>
                <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>{last ? `Last call: ${fmtShort(last.created_at)}` : 'No calls today'}</div>
                {lastContact && <div style={{ fontSize:11, color:'var(--text-muted)' }}>Last: {lastContact.name}</div>}
                {claimed > 0 && <div style={{ fontSize:11, color:'var(--accent)', marginTop:2 }}>{claimed} contact{claimed!==1?'s':''} claimed</div>}
              </div>
              <div style={{ display:'flex', gap:16, textAlign:'center', flexShrink:0 }}>
                <div>
                  <div style={{ fontSize:18, fontWeight:600 }}>{todayLogs.length}</div>
                  <div style={{ fontSize:10, color:'var(--text-muted)', textTransform:'uppercase' }}>Calls</div>
                </div>
                <div>
                  <div style={{ fontSize:18, fontWeight:600, color:'var(--success)' }}>{todayLogs.filter(l=>l.outcome==='Booked').length}</div>
                  <div style={{ fontSize:10, color:'var(--text-muted)', textTransform:'uppercase' }}>Booked</div>
                </div>
                <div>
                  <div style={{ fontSize:18, fontWeight:600, color:'var(--purple)' }}>{todayLogs.filter(l=>l.outcome==='Voicemail').length}</div>
                  <div style={{ fontSize:10, color:'var(--text-muted)', textTransform:'uppercase' }}>VM</div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Recent calls feed */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Recent calls — live feed</div>
          <span style={{ fontSize:11, color:'var(--text-muted)' }}>{logs.length} calls in last 24h</span>
        </div>
        {logs.length === 0 ? (
          <div className="card-body" style={{ color:'var(--text-muted)', fontSize:12 }}>No calls in the last 24 hours.</div>
        ) : (
          <div style={{ overflowX:'auto' }}>
            <table className="data-table">
              <thead><tr><th>Time</th><th>Rep</th><th>Contact</th><th>Phone</th><th>Outcome</th><th>Notes</th></tr></thead>
              <tbody>
                {logs.slice(0, 100).map(l => {
                  const c = contacts.find(x => x.id === l.contact_id)
                  return (
                    <tr key={l.id}>
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap', fontSize:11 }}>{fmtShort(l.created_at)}</td>
                      <td style={{ padding:'9px 12px', fontWeight:500 }}>{l.rep || '—'}</td>
                      <td style={{ padding:'9px 12px' }}>{c?.name || '—'}</td>
                      <td style={{ padding:'9px 12px', fontSize:11, color:'var(--text-muted)' }}>{c?.phone || '—'}</td>
                      <td style={{ padding:'9px 12px' }}><Badge status={l.outcome} /></td>
                      <td style={{ padding:'9px 12px', fontSize:11, color:'var(--text-muted)', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{l.notes || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
