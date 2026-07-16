import { useState, useEffect } from 'react'
import { useData } from '../lib/DataContext'
import { useAuth } from '../lib/AuthContext'
import { sb } from '../lib/supabase'
import Badge from '../components/Badge'
import { isDone, fmtShort } from '../lib/utils'

const DEFAULT_STATUS_OPTIONS = [
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
  if (secs < 3600) return `${Math.floor(secs/60)}m ${Math.floor(secs%60/60)}s`
  return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`
}

export default function LivePage() {
  const { contacts } = useData()
  const { isAdmin } = useAuth()
  const [logs, setLogs] = useState([])
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const [overrideTarget, setOverrideTarget] = useState(null)
  const [statusOptions, setStatusOptions] = useState(DEFAULT_STATUS_OPTIONS)

  // Load custom statuses from app_settings
  useEffect(() => {
    sb.from('app_settings').select('value').eq('key', 'custom_statuses').maybeSingle()
      .then(({ data }) => {
        if (data?.value) {
          try {
            const saved = JSON.parse(data.value)
            const mapped = saved.map(s => ({ value: s.label || s.value || s.id, color: s.color }))
            if (mapped.length > 0) setStatusOptions(mapped)
          } catch (e) {}
        }
      })
  }, [])

  const adminSetStatus = async (profileId, val) => {
    setOverrideTarget(null)
    await sb.from('profiles').update({ status: val, status_since: new Date().toISOString() }).eq('id', profileId)
    setProfiles(prev => prev.map(p => p.id === profileId ? { ...p, status: val, status_since: new Date().toISOString() } : p))
  }

  // Tick every 30s to update "time in status"
  useEffect(() => {
    const t = setInterval(() => setTick(v => v + 1), 30000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const since = new Date(Date.now() - 24*60*60*1000).toISOString()
    Promise.all([
      sb.from('call_logs').select('*').gte('created_at', since).order('created_at', { ascending: false }),
      sb.from('profiles').select('*').eq('active', true).order('name'),
    ]).then(([{ data: logsData }, { data: profilesData }]) => {
      setLogs(logsData || [])
      setProfiles(profilesData || [])
      setLoading(false)
    })

    const logChannel = sb.channel('live-logs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_logs' }, payload => {
        setLogs(prev => [payload.new, ...prev])
      }).subscribe()

    const profileChannel = sb.channel('live-profiles')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, payload => {
        setProfiles(prev => prev.map(p => p.id === payload.new.id ? { ...p, ...payload.new } : p))
      }).subscribe()

    return () => { sb.removeChannel(logChannel); sb.removeChannel(profileChannel) }
  }, [])

  const now = new Date()
  const todayStr = now.toDateString()

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', flex:1 }}>
      <div className="spinner lg"></div>
    </div>
  )

  // Sort: active statuses first, then by name
  const statusPriority = (status) => {
    const idx = statusOptions.findIndex(s => s.value === status)
    return idx === -1 ? statusOptions.length : idx
  }
  const sortedProfiles = [...profiles].sort((a, b) => {
    const ai = statusPriority(a.status || 'Offline')
    const bi = statusPriority(b.status || 'Offline')
    if (ai !== bi) return ai - bi
    return (a.name || '').localeCompare(b.name || '')
  })

  // Get color for any status, including custom ones
  const getStatusColor = (status) => {
    const found = statusOptions.find(s => s.value === status)
    return found ? found.color : '#6b7280'
  }

  return (
    <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:20 }}>

      {/* Admin status override modal */}
      {isAdmin && overrideTarget && (
        <div onClick={() => setOverrideTarget(null)}
          style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.45)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:'var(--surface)', borderRadius:'var(--radius-lg)', padding:24, minWidth:260, boxShadow:'0 8px 32px rgba(0,0,0,.25)' }}>
            <div style={{ fontSize:13, fontWeight:600, marginBottom:4 }}>Change Status</div>
            <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:16 }}>{overrideTarget.name}</div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {statusOptions.map(s => (
                <button key={s.value} onClick={() => adminSetStatus(overrideTarget.id, s.value)}
                  style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', borderRadius:'var(--radius)',
                    border: overrideTarget.status === s.value ? `2px solid ${s.color}` : '2px solid transparent',
                    background: overrideTarget.status === s.value ? s.color + '18' : 'var(--surface-2)',
                    cursor:'pointer', fontSize:13, fontWeight: overrideTarget.status === s.value ? 600 : 400,
                    color:'var(--text-primary)', textAlign:'left' }}>
                  <div style={{ width:10, height:10, borderRadius:'50%', background:s.color, flexShrink:0 }}></div>
                  {s.value}
                  {overrideTarget.status === s.value && <span style={{ marginLeft:'auto', fontSize:11, color:s.color }}>✓ Current</span>}
                </button>
              ))}
            </div>
            <button onClick={() => setOverrideTarget(null)} className="btn sm" style={{ marginTop:16, width:'100%' }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Agent Status Board */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Agent Status Board</div>
          <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
            {statusOptions.map(s => {
              const count = profiles.filter(p => (p.status || 'Offline') === s.value).length
              if (count === 0) return null
              return (
                <span key={s.value} style={{ fontSize:11, display:'flex', alignItems:'center', gap:4, color:'var(--text-muted)' }}>
                  <div style={{ width:6, height:6, borderRadius:'50%', background:s.color }}></div>
                  {count} {s.value}
                </span>
              )
            })}
            {/* Also show any statuses not in statusOptions (edge case) */}
            {profiles.filter(p => p.status && !statusOptions.find(s => s.value === p.status)).map(p => p.status)
              .filter((v, i, arr) => arr.indexOf(v) === i)
              .map(status => (
                <span key={status} style={{ fontSize:11, display:'flex', alignItems:'center', gap:4, color:'var(--text-muted)' }}>
                  <div style={{ width:6, height:6, borderRadius:'50%', background:'#6b7280' }}></div>
                  {profiles.filter(p => p.status === status).length} {status}
                </span>
              ))
            }
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
                const statusColor = getStatusColor(status)
                const repLogs = logs.filter(l => l.rep === (p.name || p.email))
                const todayLogs = repLogs.filter(l => new Date(l.created_at).toDateString() === todayStr)
                const lastLog = repLogs[0]
                const lastContact = lastLog ? contacts.find(c => c.id === lastLog.contact_id) : null

                return (
                  <tr key={p.id}>
                    <td style={{ padding:'10px 12px', fontWeight:500 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 18 : 11, fontWeight:600, flexShrink:0 }}>
                          {p.avatar || (p.name || p.email || '?')[0].toUpperCase()}
                        </div>
                        <div style={{ fontSize:13 }}>{p.name || p.email}</div>
                      </div>
                    </td>
                    <td style={{ padding:'10px 12px' }}>
                      <span
                        onClick={() => isAdmin && setOverrideTarget({ id:p.id, name:p.name || p.email, status })}
                        style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'3px 10px', borderRadius:99, fontSize:11, fontWeight:600, background:statusColor + '20', color:statusColor, cursor: isAdmin ? 'pointer' : 'default' }}
                        title={isAdmin ? 'Click to change status' : ''}>
                        <div style={{ width:6, height:6, borderRadius:'50%', background:statusColor }}></div>
                        {status}
                        {isAdmin && <span style={{ fontSize:9, opacity:.5 }}>▾</span>}
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
                          <div style={{ fontWeight:500, color:'var(--text-secondary)' }}>{lastContact?.name || '—'}</div>
                          <div>{fmtShort(lastLog.created_at)} · {lastLog.outcome}</div>
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

      {/* Recent Calls Live Feed */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Recent Calls — Live Feed</div>
          <span style={{ fontSize:11, color:'var(--text-muted)' }}>{logs.length} calls in last 24h</span>
        </div>
        {logs.length === 0 ? (
          <div className="empty-state"><div>No calls in the last 24 hours.</div></div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Rep</th>
                <th>Contact</th>
                <th>Outcome</th>
                <th>Notes</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {logs.slice(0, 50).map(l => {
                const contact = contacts.find(c => c.id === l.contact_id)
                const color = getStatusColor(l.outcome) || '#6b7280'
                return (
                  <tr key={l.id}>
                    <td style={{ padding:'8px 12px', fontWeight:500, fontSize:12 }}>{l.rep}</td>
                    <td style={{ padding:'8px 12px', fontSize:12 }}>{contact?.name || '—'}</td>
                    <td style={{ padding:'8px 12px' }}>
                      <span style={{ padding:'2px 8px', borderRadius:99, fontSize:10, fontWeight:600,
                        background: l.outcome === 'Booked' ? '#DCFCE7' : l.outcome === 'DNC' ? '#FEF2F2' : 'var(--surface-2)',
                        color: l.outcome === 'Booked' ? '#16A34A' : l.outcome === 'DNC' ? '#7F1D1D' : 'var(--text-secondary)' }}>
                        {l.outcome}
                      </span>
                    </td>
                    <td style={{ padding:'8px 12px', fontSize:11, color:'var(--text-muted)', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {l.notes || '—'}
                    </td>
                    <td style={{ padding:'8px 12px', fontSize:11, color:'var(--text-muted)' }}>
                      {fmtShort(l.created_at)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
