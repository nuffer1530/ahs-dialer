import { useState, useEffect, useMemo } from 'react'
import { useData } from '../lib/DataContext'
import { sb } from '../lib/supabase'
import { getDupSet, getTimeframeBounds } from '../lib/utils'
import { PROG_COLORS } from '../lib/constants'
import {
  inboundStats, outboundStats, byHour, byDay, byDayOfWeek, agentStats, campaignStats,
  fmtSecs, fmtPct, SERVICE_LEVEL_SECONDS, SERVICE_LEVEL_TARGET,
} from '../lib/analytics'
import { exportAnalyticsWorkbook } from '../lib/exportXlsx'

const TF_OPTIONS = ['today', 'yesterday', 'week', 'month', '90days', 'ytd', 'all']
const TF_LABELS = { today:'Today', yesterday:'Yesterday', week:'This week', month:'This month', '90days':'90 days', ytd:'YTD', all:'All time' }
const TABS = [
  { id:'inbound',   label:'Inbound' },
  { id:'outbound',  label:'Outbound' },
  { id:'agents',    label:'Agents' },
  { id:'campaigns', label:'Campaigns' },
]

// call_tasks only exists from the day inbound moved into a real queue. Before
// that nothing recorded an answer time, so service level / ASA / abandon rate
// for earlier periods are UNKNOWN, not zero. The page says so rather than
// showing a confident dash.
const INBOUND_DATA_FROM = new Date('2026-07-17T00:00:00')

function Kpi({ label, value, sub, tone = 'default' }) {
  const tones = { default:'var(--text-primary)', good:'#16A34A', warn:'#C87800', bad:'#DC2626', accent:'var(--accent)' }
  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'12px 14px', minWidth:0 }}>
      <div style={{ fontSize:10, fontWeight:700, letterSpacing:.5, textTransform:'uppercase', color:'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize:24, fontWeight:700, lineHeight:1.2, color:tones[tone], fontVariantNumeric:'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:'var(--text-muted)' }}>{sub}</div>}
    </div>
  )
}

function IntervalTable({ rows, title, firstCol }) {
  return (
    <div className="card">
      <div className="card-header"><div className="card-title">{title}</div></div>
      {rows.length === 0 ? (
        <div className="card-body" style={{ fontSize:13, color:'var(--text-muted)' }}>No activity in this period.</div>
      ) : (
        <div style={{ overflowX:'auto' }}>
          <table className="data-table">
            <thead><tr>
              <th>{firstCol}</th>
              <th style={{textAlign:'right'}}>Offered</th><th style={{textAlign:'right'}}>Handled</th>
              <th style={{textAlign:'right'}}>Aband.</th><th style={{textAlign:'right'}}>SL</th>
              <th style={{textAlign:'right'}}>ASA</th><th style={{textAlign:'right'}}>Outbound</th>
              <th style={{textAlign:'right'}}>Booked</th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.label}>
                  <td style={{ padding:'8px 12px', fontWeight:600 }}>{r.label}</td>
                  <td style={{ padding:'8px 12px', textAlign:'right' }}>{r.offered}</td>
                  <td style={{ padding:'8px 12px', textAlign:'right' }}>{r.handled}</td>
                  <td style={{ padding:'8px 12px', textAlign:'right', color: r.abandoned ? '#DC2626' : 'inherit' }}>{r.abandoned}</td>
                  <td style={{ padding:'8px 12px', textAlign:'right', fontWeight:600,
                    color: r.serviceLevel == null ? 'var(--text-muted)'
                      : r.serviceLevel >= SERVICE_LEVEL_TARGET ? '#16A34A'
                      : r.serviceLevel >= 60 ? '#C87800' : '#DC2626' }}>
                    {fmtPct(r.serviceLevel)}
                  </td>
                  <td style={{ padding:'8px 12px', textAlign:'right' }}>{fmtSecs(r.asa)}</td>
                  <td style={{ padding:'8px 12px', textAlign:'right' }}>{r.outboundCalls}</td>
                  <td style={{ padding:'8px 12px', textAlign:'right', fontWeight:600 }}>{r.booked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function DashboardPage() {
  const { contacts, campaigns, dncSet } = useData()
  const [tf, setTf] = useState('today')
  const [custom, setCustom] = useState({ on:false, start:'', end:'' })
  const [tab, setTab] = useState('inbound')
  const [logs, setLogs] = useState([])
  const [tasks, setTasks] = useState([])
  const [events, setEvents] = useState([])
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [hoveredTab, setHoveredTab] = useState(null)

  // One definition of the window, so every query, KPI and export sheet agree.
  const range = useMemo(() => {
    if (custom.on && custom.start && custom.end) {
      return {
        start: new Date(custom.start + 'T00:00:00'),
        end: new Date(custom.end + 'T23:59:59'),
        label: `${custom.start} to ${custom.end}`,
      }
    }
    const b = getTimeframeBounds(tf)
    return { start: b.start, end: b.end || new Date(), label: b.label || TF_LABELS[tf] }
  }, [tf, custom])

  const rangeKey = `${range.start.getTime()}-${range.end.getTime()}`

  useEffect(() => {
    setLoading(true)
    const s = range.start.toISOString(), e = range.end.toISOString()
    Promise.all([
      sb.from('call_logs').select('*').gte('created_at', s).lte('created_at', e),
      sb.from('call_tasks').select('*').gte('queued_at', s).lte('queued_at', e),
      sb.from('status_events').select('*').gte('started_at', s).lte('started_at', e),
      sb.from('profiles').select('id, name, email').eq('active', true).order('name'),
    ]).then(([l, t, ev, p]) => {
      setLogs(l.data || []); setTasks(t.data || []); setEvents(ev.data || []); setProfiles(p.data || [])
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey])

  const inbound = useMemo(() => inboundStats(tasks), [tasks])
  const outbound = useMemo(() => outboundStats(logs), [logs])
  const hourly = useMemo(() => byHour(tasks, logs), [tasks, logs])
  const daily = useMemo(() => byDay(tasks, logs), [tasks, logs])
  const dow = useMemo(() => byDayOfWeek(tasks, logs), [tasks, logs])
  const agents = useMemo(() => agentStats(profiles, tasks, logs, events), [profiles, tasks, logs, events])
  const camps = useMemo(() => campaignStats(campaigns, logs, contacts), [campaigns, logs, contacts])

  const dupSet = getDupSet(contacts)
  const inboundHistoryGap = range.start < INBOUND_DATA_FROM

  const slTone = inbound.serviceLevel == null ? 'default'
    : inbound.serviceLevel >= SERVICE_LEVEL_TARGET ? 'good'
    : inbound.serviceLevel >= 60 ? 'warn' : 'bad'
  const abTone = inbound.abandonRate == null ? 'default'
    : inbound.abandonRate <= 5 ? 'good' : inbound.abandonRate <= 10 ? 'warn' : 'bad'

  const doExport = async () => {
    setExporting(true)
    try {
      await exportAnalyticsWorkbook({
        label: range.label,
        rangeText: `${range.start.toLocaleString()} — ${range.end.toLocaleString()}`,
        inbound, outbound, hourly, daily, dow, agents, campaigns: camps, tasks, logs,
      })
    } catch (e) {
      console.error('Export failed:', e)
      alert('Export failed: ' + e.message)
    } finally { setExporting(false) }
  }

  const campName = (c) => campaigns.find(x => x.id === c.campaign_id)?.name || ''
  const exportContacts = (type) => {
    let rows, filename
    if (type === 'all') { rows = contacts; filename = 'AHS_All_Contacts.csv' }
    else if (type === 'booked') { rows = contacts.filter(c => c.status === 'Booked'); filename = 'AHS_Booked.csv' }
    else { rows = contacts.filter(c => c.status === 'DNC'); filename = 'AHS_DNC.csv' }
    const esc = v => { if (v == null) return ''; const s = String(v); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : `${s}` }
    const h = ['Name','Phone','Email','Address','City','State','Zip','Campaign','Status','Attempts','Source','ExternalID','CallbackAt']
    const csv = [h.join(','), ...rows.map(c => [c.name, c.phone, c.email, c.address, c.city, c.state, c.zip, campName(c), c.status, c.attempts, c.source, c.external_id, c.callback_at].map(esc).join(','))].join('\n')
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' })); a.download = filename; a.click()
  }

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>

      {/* -- HEADER BAR (matches WFM / My Page) -- */}
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
        {/* Timeframe + exports row */}
        <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap', padding:'14px 24px 0' }}>
          <span style={{ fontSize:10, fontWeight:700, letterSpacing:.5, color:'var(--text-muted)', marginRight:2 }}>TIMEFRAME</span>
          {TF_OPTIONS.map(o => (
            <button key={o} className={`btn sm${!custom.on && tf === o ? ' primary' : ''}`}
              onClick={() => { setTf(o); setCustom(c => ({ ...c, on:false })) }}>{TF_LABELS[o]}</button>
          ))}
          <button className={`btn sm${custom.on ? ' primary' : ''}`} onClick={() => setCustom(c => ({ ...c, on:!c.on }))}>Custom</button>
          {custom.on && (
            <>
              <input type="date" value={custom.start} onChange={e => setCustom(c => ({ ...c, start:e.target.value }))}
                style={{ padding:'4px 8px', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, background:'var(--surface-2)', color:'var(--text-primary)' }} />
              <span style={{ fontSize:12, color:'var(--text-muted)' }}>→</span>
              <input type="date" value={custom.end} onChange={e => setCustom(c => ({ ...c, end:e.target.value }))}
                style={{ padding:'4px 8px', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, background:'var(--surface-2)', color:'var(--text-primary)' }} />
            </>
          )}
          <div style={{ marginLeft:'auto', display:'flex', gap:6 }}>
            <button className="btn sm success" onClick={doExport} disabled={exporting || loading}>
              {exporting ? 'Building…' : '⬇ Export to Excel'}
            </button>
            <button className="btn sm" onClick={() => exportContacts('all')}>⬇ Contacts</button>
            <button className="btn sm" onClick={() => exportContacts('booked')}>⬇ Booked</button>
            <button className="btn sm" onClick={() => exportContacts('dnc')}>⬇ DNC</button>
          </div>
        </div>

        {/* Tab bar — underline style, matching WFM / My Page */}
        <div style={{ display:'flex', alignItems:'center', padding:'0 24px', marginTop:10 }}>
          {TABS.map(t => {
            const isActive = tab === t.id
            const isHov = hoveredTab === t.id && !isActive
            return (
              <button key={t.id}
                onClick={() => setTab(t.id)}
                onMouseEnter={() => setHoveredTab(t.id)}
                onMouseLeave={() => setHoveredTab(null)}
                style={{
                  padding:'10px 16px', fontSize:13, fontWeight: isActive ? 600 : 400,
                  border:'none', cursor:'pointer',
                  borderRadius:'var(--radius) var(--radius) 0 0',
                  background: isHov ? 'var(--surface-2)' : 'transparent',
                  color: isActive ? 'var(--accent)' : isHov ? 'var(--text-primary)' : 'var(--text-muted)',
                  borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  transition:'color .1s, background .1s',
                }}>
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* -- CONTENT -- */}
      <div style={{ flex:1, overflow:'auto', padding:24, background:'var(--bg)', display:'flex', flexDirection:'column', gap:16 }}>
      {loading ? <div className="spinner lg" style={{ margin:'60px auto' }} /> : (
        <>
          {/* Headline KPIs — visible on every tab */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:10 }}>
            <Kpi label="Calls offered" value={inbound.offered} sub={`${inbound.handled} handled`} />
            <Kpi label={`Service level (${SERVICE_LEVEL_SECONDS}s)`} value={fmtPct(inbound.serviceLevel)} tone={slTone} sub={`target ${SERVICE_LEVEL_TARGET}%`} />
            <Kpi label="Abandon rate" value={fmtPct(inbound.abandonRate)} tone={abTone} sub={`${inbound.abandoned} abandoned`} />
            <Kpi label="Avg speed of answer" value={fmtSecs(inbound.asa)} sub={`longest ${fmtSecs(inbound.longestWait)}`} />
            <Kpi label="Avg handle time" value={fmtSecs(inbound.aht)} sub="inbound talk" />
            <Kpi label="Outbound calls" value={outbound.calls} sub={`${outbound.booked} booked`} tone="accent" />
            <Kpi label="Conversion" value={fmtPct(outbound.conversion)} sub="of outbound calls" />
          </div>

          {inboundHistoryGap && (
            <div style={{ fontSize:11, color:'#8A5A00', background:'#FBF3E0', border:'1px solid #E8D9AE', borderRadius:'var(--radius)', padding:'8px 12px' }}>
              Inbound queue metrics (service level, abandon rate, speed of answer) only exist from 17 Jul 2026, when inbound
              moved into a real queue. Before that no answer time was recorded, so this period is under-counted —
              a low number here means missing history, not poor service.
            </div>
          )}

          {tab === 'inbound' && (
            <>
              <IntervalTable rows={hourly} title="By hour of day" firstCol="Hour" />
              <IntervalTable rows={daily} title="By date" firstCol="Date" />
              <IntervalTable rows={dow} title="By day of week" firstCol="Day" />
            </>
          )}

          {tab === 'outbound' && (
            <>
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Outcomes</div>
                  <span style={{ fontSize:11, color:'var(--text-muted)' }}>{outbound.calls} calls · {range.label}</span>
                </div>
                <table className="data-table">
                  <thead><tr><th>Outcome</th><th style={{textAlign:'right'}}>Count</th><th style={{textAlign:'right'}}>Share</th></tr></thead>
                  <tbody>
                    {Object.entries(outbound.byOutcome).sort((a, b) => b[1] - a[1]).map(([o, n]) => (
                      <tr key={o}>
                        <td style={{ padding:'8px 12px' }}>
                          <span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background:PROG_COLORS[o] || '#999', marginRight:8 }} />
                          {o}
                        </td>
                        <td style={{ padding:'8px 12px', textAlign:'right', fontWeight:600 }}>{n}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right', color:'var(--text-muted)' }}>{fmtPct((n / outbound.calls) * 100)}</td>
                      </tr>
                    ))}
                    {!outbound.calls && <tr><td colSpan={3} style={{ padding:16, color:'var(--text-muted)', fontSize:13 }}>No outbound calls in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:10 }}>
                <Kpi label="Total contacts" value={contacts.length.toLocaleString()} sub="all time" />
                <Kpi label="Remaining" value={contacts.filter(c => !['Booked','Not Interested','DNC','Bad Data','Max Attempts'].includes(c.status)).length.toLocaleString()} />
                <Kpi label="Booked" value={contacts.filter(c => c.status === 'Booked').length.toLocaleString()} tone="good" sub="all time" />
                <Kpi label="On DNC" value={dncSet.size.toLocaleString()} tone="bad" />
                <Kpi label="Duplicates" value={dupSet.size.toLocaleString()} tone="warn" />
              </div>
              <IntervalTable rows={daily} title="By date" firstCol="Date" />
            </>
          )}

          {tab === 'agents' && (
            <div className="card">
              <div className="card-header">
                <div className="card-title">Agent performance</div>
                <span style={{ fontSize:11, color:'var(--text-muted)' }}>{range.label}</span>
              </div>
              <div style={{ overflowX:'auto' }}>
                <table className="data-table">
                  <thead><tr>
                    <th>Agent</th>
                    <th style={{textAlign:'right'}}>Inbound</th><th style={{textAlign:'right'}}>AHT</th><th style={{textAlign:'right'}}>SL</th>
                    <th style={{textAlign:'right'}}>Outbound</th><th style={{textAlign:'right'}}>Booked</th><th style={{textAlign:'right'}}>Conv.</th>
                    <th style={{textAlign:'right'}}>Logged in</th><th style={{textAlign:'right'}}>Wrap</th><th style={{textAlign:'right'}}>Occupancy</th>
                  </tr></thead>
                  <tbody>
                    {agents.map(a => (
                      <tr key={a.profileId}>
                        <td style={{ padding:'8px 12px', fontWeight:600 }}>{a.name}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right' }}>{a.inboundHandled}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right' }}>{fmtSecs(a.inboundAht)}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right' }}>{fmtPct(a.serviceLevel)}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right' }}>{a.outboundCalls}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right', fontWeight:600, color:'#16A34A' }}>{a.booked}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right' }}>{fmtPct(a.conversion)}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right', color:'var(--text-muted)' }}>{fmtSecs(a.loggedInSeconds)}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right', color:'var(--text-muted)' }}>{fmtSecs(a.wrapSeconds)}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right' }}>{fmtPct(a.occupancy)}</td>
                      </tr>
                    ))}
                    {!agents.length && <tr><td colSpan={10} style={{ padding:16, color:'var(--text-muted)', fontSize:13 }}>No agents.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div style={{ padding:'8px 14px', fontSize:10, color:'var(--text-muted)', borderTop:'1px solid var(--border)' }}>
                Occupancy is inbound talk time against logged-in time. Outbound talk time isn't recorded per rep, so anyone
                working mostly outbound reads low.
              </div>
            </div>
          )}

          {tab === 'campaigns' && (
            <div className="card">
              <div className="card-header">
                <div className="card-title">Campaign performance</div>
                <span style={{ fontSize:11, color:'var(--text-muted)' }}>Calls and bookings within {range.label}; contacts are all-time</span>
              </div>
              <div style={{ overflowX:'auto' }}>
                <table className="data-table">
                  <thead><tr>
                    <th>Campaign</th><th style={{textAlign:'right'}}>Contacts</th><th style={{textAlign:'right'}}>Remaining</th>
                    <th style={{textAlign:'right'}}>Calls</th><th style={{textAlign:'right'}}>Booked</th><th style={{textAlign:'right'}}>Conv.</th>
                  </tr></thead>
                  <tbody>
                    {camps.map(c => (
                      <tr key={c.id}>
                        <td style={{ padding:'8px 12px', fontWeight:600 }}>{c.name}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right' }}>{c.contacts.toLocaleString()}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right', color:'#C87800' }}>{c.remaining.toLocaleString()}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right' }}>{c.calls}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right', fontWeight:600, color:'#16A34A' }}>{c.booked}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right' }}>{fmtPct(c.conversion)}</td>
                      </tr>
                    ))}
                    {!camps.length && <tr><td colSpan={6} style={{ padding:16, color:'var(--text-muted)', fontSize:13 }}>No campaigns.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      </div>
    </div>
  )
}
