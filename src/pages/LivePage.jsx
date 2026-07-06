import { useState, useEffect } from 'react'
import { useData } from '../lib/DataContext'
import { sb } from '../lib/supabase'
import Badge from '../components/Badge'
import { isDone, fmtShort } from '../lib/utils'

const STATUS_OPTIONS = [
  { value: 'Available', color: '#22c55e' },
  { value: 'On Call',   color: '#3b82f6' },
  { value: 'Wrap Up',   color: '#f59e0b' },
  { value: 'Break',     color: '#a855f7' },
  { value: 'Lunch',     color: '#f97316' },
  { value: 'Offline',   color: '#6b7280' },
]

function timeSince(isoString) {
  if (!isoString) return '—'
  const secs = Math.floor((Date.now() - new Date(isoString)) / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs/60)}m`
  return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`
}

export default function LivePage() {
  const { contacts, campaigns } = useData()
  const [logs, setLogs] = useState([])
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  // Tick every 30s to update "time in status"
  useEffect(() => {
    const t = setInterval(() => setTick(v => v + 1), 30000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const since = new Date(Date.now() - 24*60*60*1000).toISOString()

    Promise.all([
      sb.from('call_logs').select('*').gte('created_at', since).order('created_at', { ascending: false }),
      sb.from('profiles').select('*').order('name'),
    ]).then(([{ data: logsData }, { data: profilesData }]) => {
      setLogs(logsData || [])
      setProfiles(profilesData || [])
      setLoading(false)
    })

    // Real-time: new call logs
    const logChannel = sb.channel('live-logs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_logs' }, payload => {
        setLogs(prev => [payload.new, ...prev])
      })
      .subscribe()

    // Real-time: profile status changes
    const profileChannel = sb.channel('live-profiles')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, payload => {
        setProfiles(prev => prev.map(p => p.id === payload.new.id ? { ...p, ...payload.new } : p))
      })
      .subscribe()

    return () => {
      sb.removeChannel(logChannel)
      sb.removeChannel(profileChannel)
    }
  }, [])

  const now = new Date()
  const todayStr = now.toDateString()

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', flex:1 }}>
      <div className="spinner lg"></div>
    </div>
  )

  // Sort: Available first, then On Call, Wrap Up, Break, Lunch, Offline
  const statusOrder = ['Available', 'On Call', 'Wrap Up', 'Break', 'Lunch', 'Offline']
  const sortedProfiles = [...profiles].sort((a, b) => {
    const ai = statusOrder.indexOf(a.status || 'Offline')
    const bi = statusOrder.indexOf(b.status || 'Offline')
    if (ai !== bi) return ai - bi
    return (a.name || '').localeCompare(b.name || '')
  })

  return (
    <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:20 }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <h1 style={{ fontSize:20, fontWeight:600 }}>Live Rep Activity</h1>
        <div className="live-dot"></div>
        <span style={{ fontSize:11, color:'var(--text-muted)' }}>Real-time · Updates instantly</span>
      </div>

      {/* Agent Status Board */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Agent Status Board</div>
          <div style={{ display:'flex', gap:12 }}>
            {STATUS_OPTIONS.map(s => {
              const count = profiles.filter(p => (p.status || 'Offline') === s.value).length
              if (count === 0) return null
              return (
                <span key={s.value} style={{ fontSize:11, display:'flex', alignItems:'center', gap:4, color:'var(--text-muted)' }}>
                  <div style={{ width:6, height:6, borderRadius:'50%', background:s.color }}></div>
                  {count} {s.value}
                </span>
              )
            })}
          </div>
        </div>
        <div style={{ overflowX:'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Time in Status</th>
                <th>Campaign</th>
                <th>Today Calls</th>
                <th>Today Booked</th>
                <th>Last Call</th>
              </tr>
            </thead>
            <tbody>
              {sortedProfiles.map(p => {
                const status = p.status || 'Offline'
                const statusObj = STATUS_OPTIONS.find(s => s.value === status) || STATUS_OPTIONS[5]
                const repLogs = logs.filter(l => l.rep === (p.name || p.email))
                const todayLogs = repLogs.filter(l => new Date(l.created_at).toDateString() === todayStr)
                const lastLog = repLogs[0]
                const lastContact = lastLog ? contacts.find(c => c.id === lastLog.contact_id) : null

                return (
                  <tr key={p.id}>
                    <td style={{ padding:'10px 12px', fontWeight:500 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent-text)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:600, flexShrink:0 }}>
                          {(p.name || p.email || '?')[0].toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontSize:13 }}>{p.name || p.email}</div>
                          {p.role === 'admin' && <div style={{ fontSize:10, color:'var(--accent)', fontWeight:600 }}>ADMIN</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding:'10px 12px' }}>
                      <span style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'3px 10px', borderRadius:99, fontSize:11, fontWeight:600, background: statusObj.color + '20', color: statusObj.color }}>
                        <div style={{ width:6, height:6, borderRadius:'50%', background:statusObj.color }}></div>
                        {status}
                      </span>
                    </td>
                    <td style={{ padding:'10px 12px', fontSize:12, color:'var(--text-muted)' }}>
                      {p.status_since ? timeSince(p.status_since) : '—'}
                    </td>
                    <td style={{ padding:'10px 12px', fontSize:12, color:'var(--text-secondary)' }}>
                      {p.current_campaign || <span style={{ color:'var(--text-muted)' }}>—</span>}
                    </td>
                    <td style={{ padding:'10px 12px', fontWeight:600, textAlign:'center' }}>
                      {todayLogs.length}
                    </td>
                    <td style={{ padding:'10px 12px', fontWeight:600, textAlign:'center', color:'var(--success)' }}>
                      {todayLogs.filter(l => l.outcome === 'Booked').length}
                    </td>
                    <td style={{ padding:'10px 12px', fontSize:11, color:'var(--text-muted)' }}>
                      {lastLog ? (
                        <div>
                          <div>{fmtShort(lastLog.created_at)}</div>
                          {lastContact && <div style={{ color:'var(--text-secondary)' }}>{lastContact.name}</div>}
                        </div>
                      ) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Calls Feed — compact */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Recent Calls — Live Feed</div>
          <span style={{ fontSize:11, color:'var(--text-muted)' }}>{logs.length} calls in last 24h</span>
        </div>
        {logs.length === 0 ? (
          <div className="card-body" style={{ color:'var(--text-muted)', fontSize:12 }}>No calls in the last 24 hours.</div>
        ) : (
          <div style={{ overflowX:'auto' }}>
            <table className="data-table">
              <thead>
                <tr><th>Time</th><th>Rep</th><th>Contact</th><th>Phone</th><th>Outcome</th><th>Notes</th></tr>
              </thead>
              <tbody>
                {logs.slice(0, 50).map(l => {
                  const c = contacts.find(x => x.id === l.contact_id)
                  return (
                    <tr key={l.id}>
                      <td style={{ padding:'7px 12px', whiteSpace:'nowrap', fontSize:11 }}>{fmtShort(l.created_at)}</td>
                      <td style={{ padding:'7px 12px', fontWeight:500, fontSize:12 }}>{l.rep || '—'}</td>
                      <td style={{ padding:'7px 12px', fontSize:12 }}>{c?.name || '—'}</td>
                      <td style={{ padding:'7px 12px', fontSize:11, color:'var(--text-muted)' }}>{c?.phone || '—'}</td>
                      <td style={{ padding:'7px 12px' }}><Badge status={l.outcome} /></td>
                      <td style={{ padding:'7px 12px', fontSize:11, color:'var(--text-muted)', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{l.notes || '—'}</td>
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
