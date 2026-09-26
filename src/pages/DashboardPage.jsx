import { useState, useEffect, useMemo } from 'react'
import { toast } from '../lib/dialogs'
import { useData } from '../lib/DataContext'
import { sb } from '../lib/supabase'
import { getDupSet, getTimeframeBounds } from '../lib/utils'
import {
  inboundStats, outboundStats, byHour, byDay, byDayOfWeek, agentStats, campaignStats,
  acwStats, ahtOf, fmtSecs, fmtPct, SERVICE_LEVEL_SECONDS, SERVICE_LEVEL_TARGET,
} from '../lib/analytics'
import { exportAnalyticsWorkbook } from '../lib/exportXlsx'
import { useIsMobile } from '../lib/useIsMobile'
import { PageTabs, Segmented, SummaryPanel, Stat, Ring, ToneChip, Bar, Face, eyebrow, num, panel } from '../components/ui'

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

// The page's good / warn / bad verdicts as the kit's tones — theme tokens, so
// they read in dark mode too.
const TONE = { good:'green', warn:'amber', bad:'red', accent:'blue' }
// Call outcomes in the same hue families as PROG_COLORS, drawn from the theme.
const OUTCOME_TONE = {
  'Booked':'green', 'Not Interested':'red', 'DNC':'red', 'Bad Data':'gray',
  'No Answer':'amber', 'Voicemail':'purple', 'Max Attempts':'blue',
}
const emptyCell = { padding:'28px 16px', textAlign:'center', color:'var(--text-muted)', fontSize:13 }
// The eleven-column agent table runs slightly tighter than .data-table's 14px sides.
const tight = { paddingLeft:10, paddingRight:10 }
const tightR = { ...tight, textAlign:'right' }

// The kit's SummaryPanel look (16px panel, hairline zones, Stat numbers) but
// wrapping into rows — nine headline numbers don't fit one strip. The hero
// spans the rows on the left; on a phone it sits on top and the stats pair
// up two to a row (mgrid stops the phone layer stacking all of them).
function KpiGrid({ hero, stats, cols = 4, isMobile }) {
  const n = isMobile ? 2 : cols
  const rows = Math.ceil(stats.length / n)
  const pad = isMobile ? '14px 16px' : '18px 20px'
  return (
    <div className="mgrid" style={{ ...panel, flexShrink:0, display:'grid',
      gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : `${hero ? 'minmax(230px, 1.45fr) ' : ''}repeat(${n}, minmax(0, 1fr))` }}>
      {hero && (
        <div style={{ padding: isMobile ? pad : '18px 22px', minWidth:0, display:'flex', alignItems:'center',
          ...(isMobile ? { gridColumn:'1 / -1' } : { gridRow:`1 / span ${rows}` }) }}>
          {hero}
        </div>
      )}
      {stats.map((s, i) => (
        <div key={s.key || i} style={{ padding:pad, minWidth:0,
          borderLeft: !isMobile && (i % n || hero) ? '1px solid var(--border)' : undefined,
          borderTop: Math.floor(i / n) || (isMobile && hero) ? '1px solid var(--border)' : undefined }}>
          {s}
        </div>
      ))}
    </div>
  )
}

// Phone: SummaryPanel stacks its zones, so stats pair up two to a zone.
function pairUp(stats) {
  const zones = []
  for (let i = 0; i < stats.length; i += 2) zones.push(
    <div key={i} className="mgrid" style={{ display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:12 }}>
      {stats.slice(i, i + 2)}
    </div>
  )
  return zones
}

// A kit panel with a section header: title, a muted one-liner, a hairline.
function Section({ title, desc, isMobile, children }) {
  return (
    <div style={{ ...panel, overflow:'hidden', flexShrink:0 }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:'2px 10px', flexWrap:'wrap', padding: isMobile ? '12px 14px' : '14px 20px', borderBottom:'1px solid var(--border)' }}>
        <span style={{ fontSize:14.5, fontWeight:700 }}>{title}</span>
        {desc && <span style={{ fontSize:12, color:'var(--text-muted)' }}>{desc}</span>}
      </div>
      {children}
    </div>
  )
}

function IntervalTable({ rows, title, firstCol, desc, isMobile }) {
  return (
    <Section title={title} desc={desc} isMobile={isMobile}>
      {rows.length === 0 ? (
        <div style={{ ...emptyCell, padding:'32px 20px' }}>No activity in this period.</div>
      ) : (
        <div style={{ overflowX:'auto' }}>
          <table className="data-table" style={{ whiteSpace:'nowrap' }}>
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
                  <td style={{ fontWeight:600 }}>{r.label}</td>
                  <td style={{ textAlign:'right' }}>{r.offered}</td>
                  <td style={{ textAlign:'right' }}>{r.handled}</td>
                  <td style={{ textAlign:'right', color: r.abandoned ? 'var(--tone-red-tx)' : 'inherit' }}>{r.abandoned}</td>
                  <td style={{ textAlign:'right' }}>
                    {r.serviceLevel == null
                      ? <span style={{ color:'var(--text-muted)' }}>{fmtPct(r.serviceLevel)}</span>
                      : <ToneChip small tone={r.serviceLevel >= SERVICE_LEVEL_TARGET ? 'green' : r.serviceLevel >= 60 ? 'amber' : 'red'}>{fmtPct(r.serviceLevel)}</ToneChip>}
                  </td>
                  <td style={{ textAlign:'right' }}>{fmtSecs(r.asa)}</td>
                  <td style={{ textAlign:'right' }}>{r.outboundCalls}</td>
                  <td style={{ textAlign:'right', fontWeight:600 }}>{r.booked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
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
  const isMobile = useIsMobile()
  // Phone: 40px thumb targets, two to a row. undefined leaves the desktop markup untouched.
  const tap = isMobile ? { minHeight:40, flex:'1 1 calc(50% - 3px)', justifyContent:'center' } : undefined

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
  const teamAcw = useMemo(() => acwStats(events), [events])   // after-call work
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
        inbound,
        handle: { att: inbound.att, acw: teamAcw.avg, aht: ahtOf(inbound.att, teamAcw.avg) },
        outbound, hourly, daily, dow, agents, campaigns: camps, tasks, logs,
      })
    } catch (e) {
      console.error('Export failed:', e)
      toast('Export failed: ' + e.message)
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

  // Headline numbers: service level is the hero; then counts and rates on the
  // top row, times on the bottom (talk + wrap = handle reads left to right).
  // On a phone they pair up: offered/abandon, outbound/conversion, ASA/talk, wrap/handle.
  const slRing = TONE[slTone] || 'gray'
  const slHero = (
    <div style={{ display:'flex', alignItems:'center', gap:16, minWidth:0 }}>
      <Ring pct={inbound.serviceLevel || 0} size={76} stroke={7} tone={slRing}>
        <div style={{ ...num, fontSize:19, fontWeight:800, color:`var(--tone-${slRing}-tx)` }}>
          {inbound.serviceLevel == null ? '—' : <>{inbound.serviceLevel.toFixed(0)}<span style={{ fontSize:11 }}>%</span></>}
        </div>
      </Ring>
      <div style={{ minWidth:0 }}>
        <div style={eyebrow}>Service level ({SERVICE_LEVEL_SECONDS}s)</div>
        <div style={{ fontSize:12.5, color:'var(--text-secondary)', marginTop:4 }}>target {SERVICE_LEVEL_TARGET}%</div>
      </div>
    </div>
  )
  const headline = [
    <Stat key="offered" label="Calls offered" value={inbound.offered} sub={`${inbound.handled} handled`} />,
    <Stat key="abandon" label="Abandon rate" value={fmtPct(inbound.abandonRate)} tone={TONE[abTone]} sub={`${inbound.abandoned} abandoned`} />,
    <Stat key="outbound" label="Outbound calls" value={outbound.calls} tone="blue" sub={`${outbound.booked} booked`} />,
    <Stat key="conversion" label="Conversion" value={fmtPct(outbound.conversion)} sub="of outbound calls" />,
    <Stat key="asa" label="Avg speed of answer" value={fmtSecs(inbound.asa)} sub={`longest ${fmtSecs(inbound.longestWait)}`} />,
    <Stat key="att" label="Avg talk time" value={fmtSecs(inbound.att)} sub="on the call" />,
    <Stat key="acw" label="After-call work" value={fmtSecs(teamAcw.avg)} sub="wrap-up per call" />,
    <Stat key="aht" label="Avg handle time" value={fmtSecs(ahtOf(inbound.att, teamAcw.avg))} sub="talk + wrap" />,
  ]

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>

      {/* -- HEADER BAR: page tabs, exports on the right (matches WFM / Team) -- */}
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0, padding: isMobile ? '0 12px' : '0 24px',
        display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        <PageTabs tabs={TABS.map(t => [t.id, t.label])} value={tab} onChange={setTab} />
        {/* Phone: the four exports take their own full-width line and wrap two-up. */}
        <div style={{ marginLeft: isMobile ? 0 : 'auto', display:'flex', gap:6, padding: isMobile ? '0 0 10px' : '8px 0',
          flexWrap: isMobile ? 'wrap' : undefined, flexBasis: isMobile ? '100%' : undefined }}>
          <button className="btn primary" onClick={doExport} disabled={exporting || loading} style={{ borderRadius:99, ...tap }}>
            {exporting ? 'Building…' : '⬇ Export to Excel'}
          </button>
          <button className="btn" onClick={() => exportContacts('all')} style={{ borderRadius:99, ...tap }}>⬇ Contacts</button>
          <button className="btn" onClick={() => exportContacts('booked')} style={{ borderRadius:99, ...tap }}>⬇ Booked</button>
          <button className="btn" onClick={() => exportContacts('dnc')} style={{ borderRadius:99, ...tap }}>⬇ DNC</button>
        </div>
      </div>

      {/* -- CONTENT -- */}
      <div style={{ flex:1, overflow:'auto', padding: isMobile ? 12 : 24, background:'var(--bg)', display:'flex', flexDirection:'column', gap: isMobile ? 12 : 16 }}>
        {/* Timeframe toolbar — stays put while a new range loads. */}
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', flexShrink:0 }}>
          {isMobile ? (
            // Phone: eight choices wrap to three lines, so the timeframe folds into one select.
            <>
              <span style={eyebrow}>Timeframe</span>
              <select className="form-input" value={custom.on ? 'custom' : tf}
                onChange={e => {
                  const v = e.target.value
                  if (v === 'custom') setCustom(c => ({ ...c, on:true }))
                  else { setTf(v); setCustom(c => ({ ...c, on:false })) }
                }}
                style={{ flex:1, width:'auto', minHeight:40, borderRadius:99, padding:'6px 14px' }}>
                {TF_OPTIONS.map(o => <option key={o} value={o}>{TF_LABELS[o]}</option>)}
                <option value="custom">Custom dates</option>
              </select>
            </>
          ) : (
            <div style={{ overflowX:'auto', maxWidth:'100%' }}>
              <Segmented value={custom.on ? 'custom' : tf}
                onChange={k => {
                  if (k === 'custom') setCustom(c => ({ ...c, on:!c.on }))
                  else { setTf(k); setCustom(c => ({ ...c, on:false })) }
                }}
                options={[...TF_OPTIONS.map(o => [o, TF_LABELS[o]]), ['custom', 'Custom']]} />
            </div>
          )}
          {custom.on && (
            <span style={{ display:'inline-flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
              <input type="date" className="form-input" aria-label="From" value={custom.start} onChange={e => setCustom(c => ({ ...c, start:e.target.value }))}
                style={{ width:'auto', borderRadius:99, padding:'6px 12px', minHeight: isMobile ? 40 : undefined }} />
              <span style={{ fontSize:12, color:'var(--text-muted)' }}>→</span>
              <input type="date" className="form-input" aria-label="To" value={custom.end} onChange={e => setCustom(c => ({ ...c, end:e.target.value }))}
                style={{ width:'auto', borderRadius:99, padding:'6px 12px', minHeight: isMobile ? 40 : undefined }} />
            </span>
          )}
        </div>

      {loading ? (
        <>
          <div className="skel" style={{ height: isMobile ? 520 : 200, borderRadius:16, flexShrink:0 }} />
          <div className="skel" style={{ height:320, borderRadius:16, flexShrink:0 }} />
        </>
      ) : (
        <>
          {/* Headline KPIs — visible on every tab. */}
          <KpiGrid hero={slHero} stats={headline} cols={4} isMobile={isMobile} />

          {inboundHistoryGap && (
            <div style={{ fontSize:12, lineHeight:1.5, color:'var(--tone-amber-tx)', background:'var(--tone-amber-bg)', border:'1px solid var(--tone-amber-bd)', borderRadius:12, padding:'10px 14px', flexShrink:0 }}>
              Inbound queue metrics (service level, abandon rate, speed of answer) only exist from 17 Jul 2026, when inbound
              moved into a real queue. Before that no answer time was recorded, so this period is under-counted —
              a low number here means missing history, not poor service.
            </div>
          )}

          {tab === 'inbound' && (
            <>
              <IntervalTable rows={hourly} title="By hour of day" firstCol="Hour" desc={range.label} isMobile={isMobile} />
              <IntervalTable rows={daily} title="By date" firstCol="Date" desc={range.label} isMobile={isMobile} />
              <IntervalTable rows={dow} title="By day of week" firstCol="Day" desc={range.label} isMobile={isMobile} />
            </>
          )}

          {tab === 'outbound' && (
            <>
              <Section title="Outcomes" desc={`${outbound.calls} calls · ${range.label}`} isMobile={isMobile}>
                <div style={{ overflowX:'auto' }}>
                  {/* Three columns fit a phone, so skip the forced 640px sideways scroll. */}
                  <table className="data-table" style={isMobile ? { minWidth:0 } : undefined}>
                    <thead><tr><th style={{ width:'100%' }}>Outcome</th><th style={{textAlign:'right'}}>Count</th><th style={{textAlign:'right'}}>Share</th></tr></thead>
                    <tbody>
                      {Object.entries(outbound.byOutcome).sort((a, b) => b[1] - a[1]).map(([o, n]) => {
                        const share = (n / outbound.calls) * 100
                        const tone = OUTCOME_TONE[o] || 'gray'
                        return (
                          <tr key={o}>
                            <td><ToneChip small tone={tone}>{o}</ToneChip></td>
                            <td style={{ textAlign:'right', fontWeight:600 }}>{n}</td>
                            <td style={{ textAlign:'right', color:'var(--text-muted)' }}>
                              <div style={{ display:'inline-flex', alignItems:'center', gap:10 }}>
                                <div style={{ width: isMobile ? 40 : 120 }}><Bar pct={share} tone={tone} /></div>
                                <span style={{ ...num, minWidth:34, textAlign:'right' }}>{fmtPct(share)}</span>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                      {!outbound.calls && <tr><td colSpan={3} style={emptyCell}>No outbound calls in this period.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </Section>
              {(() => {
                const pipeline = [
                  <Stat key="total" label="Total contacts" value={contacts.length.toLocaleString()} sub="all time" />,
                  <Stat key="remaining" label="Remaining" value={contacts.filter(c => !['Booked','Not Interested','DNC','Bad Data','Max Attempts'].includes(c.status)).length.toLocaleString()} />,
                  <Stat key="booked" label="Booked" value={contacts.filter(c => c.status === 'Booked').length.toLocaleString()} tone="green" sub="all time" />,
                  <Stat key="dnc" label="On DNC" value={dncSet.size.toLocaleString()} tone="red" />,
                  <Stat key="dups" label="Duplicates" value={dupSet.size.toLocaleString()} tone="amber" />,
                ]
                return (
                  <SummaryPanel isMobile={isMobile} style={{ marginBottom:0, flexShrink:0 }}>
                    {isMobile ? pairUp(pipeline) : pipeline}
                  </SummaryPanel>
                )
              })()}
              <IntervalTable rows={daily} title="By date" firstCol="Date" desc={range.label} isMobile={isMobile} />
            </>
          )}

          {tab === 'agents' && (
            <Section title="Agent performance" desc={range.label} isMobile={isMobile}>
              <div style={{ overflowX:'auto' }}>
                {/* Eleven columns: times never wrap, and 10px sides (header and
                    cells alike, so numbers stay under their labels) fit a 1280 screen. */}
                <table className="data-table" style={{ whiteSpace:'nowrap' }}>
                  <thead><tr>
                    <th style={tight}>Agent</th>
                    <th style={tightR}>Inbound</th>
                    <th style={tightR} title="Average talk time">Talk</th>
                    <th style={tightR} title="After-call work (wrap-up)">ACW</th>
                    <th style={tightR} title="Handle time = talk + ACW">AHT</th>
                    <th style={tightR}>SL</th>
                    <th style={tightR}>Outbound</th><th style={tightR}>Booked</th><th style={tightR}>Conv.</th>
                    <th style={tightR}>Logged in</th><th style={tightR}>Occupancy</th>
                  </tr></thead>
                  <tbody>
                    {agents.map(a => (
                      <tr key={a.profileId}>
                        <td style={tight}>
                          <div style={{ display:'flex', alignItems:'center', gap:9 }}>
                            <Face name={a.name} size={24} />
                            <span style={{ fontWeight:600 }}>{a.name}</span>
                          </div>
                        </td>
                        <td style={tightR}>{a.inboundHandled}</td>
                        <td style={tightR}>{fmtSecs(a.talkTime)}</td>
                        <td style={{ ...tightR, color:'var(--text-muted)' }}>{fmtSecs(a.acw)}</td>
                        <td style={{ ...tightR, fontWeight:600 }}>{fmtSecs(a.aht)}</td>
                        <td style={tightR}>{fmtPct(a.serviceLevel)}</td>
                        <td style={tightR}>{a.outboundCalls}</td>
                        <td style={{ ...tightR, fontWeight:600, color:'var(--tone-green-tx)' }}>{a.booked}</td>
                        <td style={tightR}>{fmtPct(a.conversion)}</td>
                        <td style={{ ...tightR, color:'var(--text-muted)' }}>{fmtSecs(a.loggedInSeconds)}</td>
                        <td style={tightR}>{fmtPct(a.occupancy)}</td>
                      </tr>
                    ))}
                    {!agents.length && <tr><td colSpan={11} style={emptyCell}>No agents.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: isMobile ? '10px 14px' : '10px 20px', fontSize:11.5, lineHeight:1.5, color:'var(--text-muted)', borderTop:'1px solid var(--border)' }}>
                Occupancy is inbound talk time against logged-in time. Outbound talk time isn't recorded per rep, so anyone
                working mostly outbound reads low.
              </div>
            </Section>
          )}

          {tab === 'campaigns' && (
            <Section title="Campaign performance" desc={`Calls and bookings within ${range.label}; contacts are all-time`} isMobile={isMobile}>
              <div style={{ overflowX:'auto' }}>
                <table className="data-table">
                  <thead><tr>
                    <th>Campaign</th><th style={{textAlign:'right'}}>Contacts</th><th style={{textAlign:'right'}}>Remaining</th>
                    <th style={{textAlign:'right'}}>Calls</th><th style={{textAlign:'right'}}>Booked</th><th style={{textAlign:'right'}}>Conv.</th>
                  </tr></thead>
                  <tbody>
                    {camps.map(c => (
                      <tr key={c.id}>
                        <td style={{ fontWeight:600 }}>{c.name}</td>
                        <td style={{ textAlign:'right' }}>{c.contacts.toLocaleString()}</td>
                        <td style={{ textAlign:'right', color:'var(--tone-amber-tx)' }}>{c.remaining.toLocaleString()}</td>
                        <td style={{ textAlign:'right' }}>{c.calls}</td>
                        <td style={{ textAlign:'right', fontWeight:600, color:'var(--tone-green-tx)' }}>{c.booked}</td>
                        <td style={{ textAlign:'right' }}>{fmtPct(c.conversion)}</td>
                      </tr>
                    ))}
                    {!camps.length && <tr><td colSpan={6} style={emptyCell}>No campaigns.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </>
      )}
      </div>
    </div>
  )
}
