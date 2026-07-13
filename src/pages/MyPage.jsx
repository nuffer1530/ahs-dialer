import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'

const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

function toYMD(d) { return d.toISOString().split('T')[0] }
function getTodayMonday() {
  const d = new Date()
  const dow = d.getDay()
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return toYMD(d)
}
function getWeekDates(base) {
  const d = new Date(base + 'T00:00:00')
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(d); x.setDate(d.getDate() + i); return toYMD(x)
  })
}
function fmt12(t) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hr = h % 12 || 12
  return m === 0 ? `${hr} ${ampm}` : `${hr}:${String(m).padStart(2,'0')} ${ampm}`
}
function fmtDate(ymd) {
  const [y, mo, d] = ymd.split('-').map(Number)
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${names[mo-1]} ${d}`
}

const DAY_TYPE_STYLES = {
  pto:     { label: 'PTO',     bg: '#EAF5EE', color: '#2E7D52', border: '#2E7D52' },
  sick:    { label: 'Sick',    bg: '#FBEEEA', color: '#B5341A', border: '#B5341A' },
  holiday: { label: 'Holiday', bg: '#F0ECFB', color: '#5B3FA0', border: '#5B3FA0' },
  work:    { label: null,      bg: null,       color: null,      border: null      },
}

// Scorecard KPIs -- Brandyn can adjust thresholds here
const SCORECARD_KPIS = [
  {
    id: 'attendance',
    label: 'Attendance',
    weight: 0.25,
    unit: 'points',
    thresholds: { exceeds: 0, meets: 1, improvement: 2 },
    lowerIsBetter: true,
  },
  {
    id: 'booking_pct',
    label: 'Inbound Booking %',
    weight: 0.20,
    unit: '%',
    thresholds: { exceeds: 90, meets: 80, improvement: 75 },
    lowerIsBetter: false,
  },
  {
    id: 'booked_calls',
    label: 'Booked Calls',
    weight: 0.20,
    unit: '',
    thresholds: { exceeds: 140, meets: 110, improvement: 85 },
    lowerIsBetter: false,
  },
  {
    id: 'call_quality',
    label: 'Call Quality Evaluation(s)',
    weight: 0.15,
    unit: '%',
    thresholds: { exceeds: 95, meets: 90, improvement: 85 },
    lowerIsBetter: false,
  },
  {
    id: 'memberships',
    label: 'Memberships Sold',
    weight: 0.20,
    unit: '',
    thresholds: { exceeds: 5, meets: 3, improvement: 2 },
    lowerIsBetter: false,
  },
]

function getRating(kpi, value) {
  if (value == null) return null
  const { thresholds, lowerIsBetter } = kpi
  if (lowerIsBetter) {
    if (value <= thresholds.exceeds)    return 4
    if (value <= thresholds.meets)      return 3
    if (value <= thresholds.improvement) return 2
    return 1
  } else {
    if (value >= thresholds.exceeds)    return 4
    if (value >= thresholds.meets)      return 3
    if (value >= thresholds.improvement) return 2
    return 1
  }
}

const RATING_LABELS = { 4: 'Exceeds', 3: 'Meets', 2: 'Needs Improvement', 1: 'Poor Performance' }
const RATING_COLORS = {
  4: { bg: '#d4edda', text: '#2E7D52', border: '#2E7D52' },
  3: { bg: '#d4edda', text: '#2E7D52', border: '#2E7D52' },
  2: { bg: '#FBF3E0', text: '#8A5A00', border: '#8A5A00' },
  1: { bg: '#FBEEEA', text: '#B5341A', border: '#B5341A' },
}

export default function MyPage() {
  const { profile } = useAuth()
  const [tab, setTab] = useState('my-schedule')
  const [weekBase, setWeekBase] = useState(getTodayMonday)
  const [schedules, setSchedules] = useState([])
  const [profiles, setProfiles] = useState([])
  const [statusEvents, setStatusEvents] = useState([])
  const [attendancePoints, setAttendancePoints] = useState([])
  const [loading, setLoading] = useState(true)
  const [hoveredTab, setHoveredTab] = useState(null)
  const now = new Date()
  const [scorecardMonth, setScorecardMonth] = useState({ year: now.getFullYear(), month: now.getMonth() })
  const [scWeights, setScWeights] = useState({ attendance: 25, booking_pct: 20, booked_calls: 20, call_quality: 15, memberships: 20 })
  const [scActuals, setScActuals] = useState({ booking_pct: null, booked_calls: null, call_quality: null, memberships: null })

  const today = toYMD(new Date())
  const weekDates = getWeekDates(weekBase)
  const weekLabel = `${fmtDate(weekDates[0])} - ${fmtDate(weekDates[6])}`

  useEffect(() => {
    if (!profile?.id) return
    const load = async () => {
      setLoading(true)
      const from = new Date(); from.setDate(from.getDate() - 60)
      const to = new Date(); to.setDate(to.getDate() + 30)
      const fromStr = toYMD(from), toStr = toYMD(to)

      const [{ data: profs }, { data: scheds }, { data: events }, { data: pts }, { data: wts }] = await Promise.all([
        sb.from('profiles').select('id, name, email, avatar, role').order('name'),
        sb.from('schedules').select('*').gte('date', fromStr).lte('date', toStr),
        sb.from('status_events').select('*').eq('profile_id', profile.id).gte('started_at', fromStr + 'T00:00:00').order('started_at', { ascending: false }),
        sb.from('attendance_points').select('*').eq('profile_id', profile.id).gte('date', fromStr),
        sb.from('app_settings').select('value').eq('key', 'scorecard_weights').maybeSingle(),
      ])
      setProfiles(profs || [])
      setSchedules(scheds || [])
      setStatusEvents(events || [])
      setAttendancePoints(pts || [])
      if (wts?.value) { try { setScWeights(JSON.parse(wts.value)) } catch (e) {} }
      setLoading(false)
    }
    load()
  }, [profile?.id])

  // Reload scorecard actuals when month changes
  useEffect(() => {
    if (!profile?.id) return
    const monthStart = `${scorecardMonth.year}-${String(scorecardMonth.month+1).padStart(2,'0')}-01`
    sb.from('scorecard_actuals').select('*').eq('profile_id', profile.id).eq('month', monthStart).maybeSingle()
      .then(({ data }) => {
        setScActuals({
          booking_pct: data?.booking_pct ?? null,
          booked_calls: data?.booked_calls ?? null,
          call_quality: data?.call_quality ?? null,
          memberships: data?.memberships ?? null,
        })
        if (data?.weights) { try { setScWeights(data.weights) } catch (e) {} }
      })
  }, [profile?.id, scorecardMonth])

  const getSched = (profileId, date) => schedules.find(s => s.profile_id === profileId && s.date === date)

  // Scorecard month data -- filtered by selected scorecardMonth
  const scMonthStart = toYMD(new Date(scorecardMonth.year, scorecardMonth.month, 1))
  const scMonthEnd = toYMD(new Date(scorecardMonth.year, scorecardMonth.month + 1, 0))
  const scPoints = attendancePoints.filter(p => p.date >= scMonthStart && p.date <= scMonthEnd)
  const scTotalPoints = scPoints.reduce((s, p) => s + parseFloat(p.points || 0), 0)

  // Stats tab always uses current month
  const monthStart = toYMD(new Date(now.getFullYear(), now.getMonth(), 1))
  const myPoints = attendancePoints.filter(p => p.date >= monthStart)
  const totalPoints = myPoints.reduce((s, p) => s + parseFloat(p.points || 0), 0)

  const myEvents = statusEvents.filter(e => e.started_at?.slice(0,10) >= monthStart)
  const callEvents = myEvents.filter(e => e.status === 'On Call')
  const totalCallMins = callEvents.reduce((s, e) => s + (e.duration_seconds || 0) / 60, 0)
  const avgCallMins = callEvents.length ? (totalCallMins / callEvents.length).toFixed(1) : '--'

  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const scorecardLabel = `${MONTH_NAMES[scorecardMonth.month]} ${scorecardMonth.year}`
  const navMonth = (dir) => {
    setScorecardMonth(prev => {
      let m = prev.month + dir, y = prev.year
      if (m > 11) { m = 0; y++ }
      if (m < 0)  { m = 11; y-- }
      return { year: y, month: m }
    })
  }
  const isCurrentMonth = scorecardMonth.year === now.getFullYear() && scorecardMonth.month === now.getMonth()

  const TABS = [
    { id: 'my-schedule',   label: 'My Schedule' },
    { id: 'team-schedule', label: 'Team Schedule' },
    { id: 'stats',         label: 'My Stats' },
    { id: 'scorecard',     label: 'Scorecard' },
  ]

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

      {/* -- HEADER BAR -- */}
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
        {/* Title row */}
        <div style={{ padding:'16px 24px 0', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:16 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ width:32, height:32, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: profile?.avatar ? 16 : 12, fontWeight:700, flexShrink:0 }}>
              {profile?.avatar || (profile?.name || profile?.email || '?')[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize:18, fontWeight:600, color:'var(--text-primary)' }}>{profile?.name || profile?.email}</div>
              <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2 }}>My Page</div>
            </div>
          </div>
          {(tab === 'my-schedule' || tab === 'team-schedule') && (
            <div style={{ display:'flex', alignItems:'center', gap:10, marginTop:2 }}>
              <button onClick={() => { const d = new Date(weekBase + 'T00:00:00'); d.setDate(d.getDate()-7); setWeekBase(toYMD(d)) }}
                style={{ width:32, height:32, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-secondary)', display:'flex', alignItems:'center', justifyContent:'center' }}
                onMouseEnter={e => e.currentTarget.style.background='var(--surface)'}
                onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>{'<'}</button>
              <span style={{ fontSize:13, fontWeight:500, color:'var(--text-primary)', minWidth:200, textAlign:'center' }}>{weekLabel}</span>
              <button onClick={() => { const d = new Date(weekBase + 'T00:00:00'); d.setDate(d.getDate()+7); setWeekBase(toYMD(d)) }}
                style={{ width:32, height:32, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-secondary)', display:'flex', alignItems:'center', justifyContent:'center' }}
                onMouseEnter={e => e.currentTarget.style.background='var(--surface)'}
                onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>{'>'}</button>
              <button onClick={() => setWeekBase(getTodayMonday())}
                style={{ padding:'5px 10px', fontSize:12, fontWeight:500, border:'1px solid var(--accent)', borderRadius:'var(--radius)', background:'none', color:'var(--accent)', cursor:'pointer' }}>
                Today
              </button>
            </div>
          )}
          {tab === 'scorecard' && (
            <div style={{ display:'flex', alignItems:'center', gap:10, marginTop:2 }}>
              <button onClick={() => navMonth(-1)}
                style={{ width:32, height:32, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-secondary)', display:'flex', alignItems:'center', justifyContent:'center' }}
                onMouseEnter={e => e.currentTarget.style.background='var(--surface)'}
                onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>{'<'}</button>
              <span style={{ fontSize:13, fontWeight:500, color:'var(--text-primary)', minWidth:180, textAlign:'center' }}>{scorecardLabel}</span>
              <button onClick={() => navMonth(1)}
                style={{ width:32, height:32, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-secondary)', display:'flex', alignItems:'center', justifyContent:'center' }}
                onMouseEnter={e => e.currentTarget.style.background='var(--surface)'}
                onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>{'>'}</button>
              {!isCurrentMonth && (
                <button onClick={() => setScorecardMonth({ year: now.getFullYear(), month: now.getMonth() })}
                  style={{ padding:'5px 10px', fontSize:12, fontWeight:500, border:'1px solid var(--accent)', borderRadius:'var(--radius)', background:'none', color:'var(--accent)', cursor:'pointer' }}>
                  This Month
                </button>
              )}
            </div>
          )}
        </div>

        {/* Tab bar */}
        <div style={{ display:'flex', alignItems:'center', padding:'0 24px', marginTop:10 }}>
          <div style={{ display:'flex', gap:0 }}>
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
      </div>

      {/* Content */}
      <div style={{ flex:1, overflow:'auto', padding:24, background:'var(--bg)' }}>
        {loading ? (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:200 }}>
            <div className="spinner" />
          </div>
        ) : (
          <>
            {/* MY SCHEDULE */}
            {tab === 'my-schedule' && (
              <div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:8 }}>
                  {weekDates.map(date => {
                    const sched = getSched(profile?.id, date)
                    const isToday = date === today
                    const dt = sched?.day_type
                    const style = DAY_TYPE_STYLES[dt] || DAY_TYPE_STYLES.work
                    return (
                      <div key={date} style={{
                        background: isToday ? 'var(--accent-bg)' : 'var(--surface)',
                        border: `1px solid ${isToday ? 'var(--accent)' : 'var(--border)'}`,
                        borderRadius: 'var(--radius-lg)', padding:14, minHeight:120,
                      }}>
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                          <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color: isToday ? 'var(--accent)' : 'var(--text-muted)' }}>
                            {DAYS[weekDates.indexOf(date)]}
                          </div>
                          <div style={{ fontSize:12, fontWeight: isToday ? 700 : 400, color: isToday ? 'var(--accent)' : 'var(--text-secondary)' }}>
                            {fmtDate(date).split(' ')[1]}
                          </div>
                        </div>

                        {!sched && (
                          <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:8 }}>Off</div>
                        )}

                        {sched && dt && dt !== 'work' && (
                          <div style={{ marginTop:8, padding:'4px 8px', borderRadius:6, background: style.bg, color: style.color, fontSize:11, fontWeight:600, display:'inline-block' }}>
                            {style.label}
                          </div>
                        )}

                        {sched && dt === 'work' && (
                          <div style={{ marginTop:6 }}>
                            <div style={{ fontSize:12, fontWeight:600, color:'var(--text-primary)' }}>
                              {fmt12(sched.shift_start)} - {fmt12(sched.shift_end)}
                            </div>
                            <div style={{ marginTop:8, display:'flex', flexDirection:'column', gap:4 }}>
                              {sched.break1_start && (
                                <div style={{ fontSize:10, color:'var(--text-muted)' }}>
                                  Break {fmt12(sched.break1_start)}
                                </div>
                              )}
                              {sched.lunch_start && (
                                <div style={{ fontSize:10, color:'var(--text-muted)' }}>
                                  Lunch {fmt12(sched.lunch_start)}
                                </div>
                              )}
                              {sched.break2_start && (
                                <div style={{ fontSize:10, color:'var(--text-muted)' }}>
                                  Break {fmt12(sched.break2_start)}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* TEAM SCHEDULE */}
            {tab === 'team-schedule' && (
              <div>
                <div style={{ overflowX:'auto' }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                    <thead>
                      <tr style={{ background:'var(--surface-2)' }}>
                        <th style={{ padding:'10px 14px', textAlign:'left', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', borderBottom:'1px solid var(--border)', width:140 }}>Agent</th>
                        {weekDates.map((date, i) => (
                          <th key={date} style={{ padding:'10px 8px', textAlign:'center', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color: date === today ? 'var(--accent)' : 'var(--text-muted)', borderBottom:'1px solid var(--border)', background: date === today ? 'var(--accent-bg)' : undefined }}>
                            {DAYS[i]}<br />
                            <span style={{ fontWeight:400, fontSize:10 }}>{fmtDate(date)}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {profiles.map((p, idx) => (
                        <tr key={p.id} style={{ background: idx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)', borderBottom:'1px solid var(--border)' }}>
                          <td style={{ padding:'10px 14px', fontWeight: p.id === profile?.id ? 700 : 400, color: p.id === profile?.id ? 'var(--accent)' : 'var(--text-primary)' }}>
                            {p.name || p.email}
                            {p.id === profile?.id && <span style={{ fontSize:9, marginLeft:4, color:'var(--accent)' }}>(you)</span>}
                          </td>
                          {weekDates.map(date => {
                            const sched = getSched(p.id, date)
                            const dt = sched?.day_type
                            const style = DAY_TYPE_STYLES[dt] || DAY_TYPE_STYLES.work
                            const isToday = date === today
                            return (
                              <td key={date} style={{ padding:'8px', textAlign:'center', background: isToday ? 'var(--accent-bg)' : undefined, verticalAlign:'middle' }}>
                                {!sched && <span style={{ fontSize:10, color:'var(--border-strong)' }}>--</span>}
                                {sched && dt !== 'work' && (
                                  <span style={{ fontSize:10, fontWeight:600, color: style.color, background: style.bg, padding:'2px 6px', borderRadius:4 }}>{style.label}</span>
                                )}
                                {sched && dt === 'work' && (
                                  <div style={{ fontSize:10, color:'var(--text-primary)', lineHeight:1.5 }}>
                                    <div style={{ fontWeight:600 }}>{fmt12(sched.shift_start)}</div>
                                    <div style={{ color:'var(--text-muted)' }}>{fmt12(sched.shift_end)}</div>
                                  </div>
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* MY STATS */}
            {tab === 'stats' && (
              <div>
                <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:20 }}>Month to date . {new Date().toLocaleDateString('en-US', { month:'long', year:'numeric' })}</div>

                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(180px,1fr))', gap:12, marginBottom:32 }}>
                  <StatCard label="Attendance Points" value={totalPoints.toFixed(1)} sub="Lower is better" valueColor={totalPoints === 0 ? 'var(--success)' : totalPoints <= 1 ? 'var(--warning)' : 'var(--danger)'} />
                  <StatCard label="Calls Handled" value={callEvents.length} sub="This month" />
                  <StatCard label="Avg Call Duration" value={avgCallMins === '--' ? '--' : `${avgCallMins}m`} sub="Per call" />
                  <StatCard label="Status Events" value={myEvents.length} sub="All statuses" />
                </div>

                <div style={{ fontSize:12, fontWeight:700, color:'var(--text-secondary)', textTransform:'uppercase', letterSpacing:.6, marginBottom:12 }}>Attendance Points Log</div>
                {myPoints.length === 0 ? (
                  <div style={{ color:'var(--text-muted)', fontSize:13, padding:'24px 0' }}>No points this month.</div>
                ) : (
                  <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden' }}>
                    <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                      <thead>
                        <tr style={{ background:'var(--surface-2)' }}>
                          {['Date','Reason','Points','Notes'].map(h => (
                            <th key={h} style={{ padding:'8px 14px', textAlign:'left', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', borderBottom:'1px solid var(--border)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {myPoints.sort((a,b) => b.date.localeCompare(a.date)).map(pt => (
                          <tr key={pt.id} style={{ borderBottom:'1px solid var(--border)' }}>
                            <td style={{ padding:'9px 14px', color:'var(--text-secondary)' }}>{fmtDate(pt.date)}</td>
                            <td style={{ padding:'9px 14px', textTransform:'capitalize' }}>{pt.reason?.replace(/_/g,' ')}</td>
                            <td style={{ padding:'9px 14px', fontWeight:700, color:'var(--danger)' }}>+{pt.points}</td>
                            <td style={{ padding:'9px 14px', color:'var(--text-muted)' }}>{pt.notes || '--'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* SCORECARD */}
            {tab === 'scorecard' && (
              <div>
                <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:20 }}>
                  {scorecardLabel} . scores entered by your manager
                </div>

                <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden' }}>
                  {/* Header row */}
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 80px 110px 1fr 1fr 1fr 1fr', background:'var(--surface-2)', borderBottom:'2px solid var(--border)' }}>
                    {['KPI','Weight','Actual','Exceeds (4)','Meets (3)','Needs Improvement (2)','Poor Performance (1)'].map((h,i) => (
                      <div key={h} style={{ padding:'10px 14px', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', textAlign: i === 0 ? 'left' : 'center' }}>{h}</div>
                    ))}
                  </div>

                  {SCORECARD_KPIS.map((kpi, idx) => {
                    const w = parseFloat(scWeights[kpi.id]) || kpi.weight * 100
                    const actual = kpi.id === 'attendance'
                      ? scTotalPoints
                      : (scActuals[kpi.id] != null ? parseFloat(scActuals[kpi.id]) : null)                    const rating = getRating(kpi, actual)
                    const ratingStyle = rating ? RATING_COLORS[rating] : null
                    const { thresholds, lowerIsBetter, unit } = kpi

                    const fmt = (n) => unit === '%' ? `${n}%` : `${n}${unit}`
                    const col4 = lowerIsBetter ? fmt(thresholds.exceeds) : `${fmt(thresholds.exceeds)}+`
                    const col3 = lowerIsBetter ? `${fmt(thresholds.meets+1)}-${fmt(thresholds.exceeds+1)}` : `${fmt(thresholds.meets)}-${fmt(thresholds.exceeds-1)}`
                    const col2 = lowerIsBetter ? `${fmt(thresholds.improvement+1)}-${fmt(thresholds.meets+1)}` : `${fmt(thresholds.improvement)}-${fmt(thresholds.meets-1)}`
                    const col1 = lowerIsBetter ? `${fmt(thresholds.improvement+1)}+` : `${fmt(thresholds.improvement-1)} or less`

                    return (
                      <div key={kpi.id} style={{ display:'grid', gridTemplateColumns:'1fr 80px 110px 1fr 1fr 1fr 1fr', borderBottom: idx < SCORECARD_KPIS.length-1 ? '1px solid var(--border)' : 'none', background: idx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)' }}>
                        <div style={{ padding:'14px', display:'flex', flexDirection:'column', gap:4 }}>
                          <div style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)' }}>{kpi.label}</div>
                          {rating && ratingStyle && (
                            <div style={{ fontSize:10, fontWeight:700, padding:'2px 6px', borderRadius:4, background: ratingStyle.bg, color: ratingStyle.text, display:'inline-block', width:'fit-content' }}>
                              {RATING_LABELS[rating]}
                            </div>
                          )}
                          {actual == null && kpi.id !== 'attendance' && (
                            <div style={{ fontSize:10, color:'var(--text-muted)' }}>Pending</div>
                          )}
                        </div>
                        <div style={{ padding:'14px 8px', textAlign:'center', fontSize:12, color:'var(--text-secondary)', fontWeight:500, display:'flex', alignItems:'center', justifyContent:'center' }}>
                          {w}%
                        </div>
                        <div style={{ padding:'14px 8px', textAlign:'center', display:'flex', alignItems:'center', justifyContent:'center' }}>
                          {actual != null ? (
                            <span style={{ fontSize:14, fontWeight:700, color: ratingStyle ? ratingStyle.text : 'var(--text-primary)' }}>
                              {actual}{unit === 'points' ? ' pts' : unit}
                            </span>
                          ) : (
                            <span style={{ fontSize:12, color:'var(--text-muted)' }}>--</span>
                          )}
                        </div>
                        {[col4, col3, col2, col1].map((val, ci) => {
                          const colRating = 4 - ci
                          const cs = RATING_COLORS[colRating]
                          const isMyRating = rating === colRating
                          return (
                            <div key={ci} style={{ padding:'14px 8px', textAlign:'center', fontSize:12, fontWeight: isMyRating ? 700 : 400, background: isMyRating ? cs.bg : cs.bg + '44', color: cs.text, borderLeft:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                              {val}{isMyRating && ' *'}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>

                <div style={{ marginTop:16, fontSize:11, color:'var(--text-muted)', display:'flex', gap:16, flexWrap:'wrap' }}>
                  <span>Total weight: {SCORECARD_KPIS.reduce((s,k) => s + (parseFloat(scWeights[k.id]) || 0), 0)}%</span>
                  <span>Attendance auto-populated from your points log</span>
                  <span>Other scores entered by your manager each month</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function WeekNav({ weekBase, setWeekBase, weekLabel }) {
  const nav = (dir) => {
    const d = new Date(weekBase + 'T00:00:00')
    d.setDate(d.getDate() + dir * 7)
    setWeekBase(toYMD(d))
  }
  return (
    <div style={{ display:'flex', alignItems:'center', gap:12 }}>
      <button onClick={() => nav(-1)} style={{ width:28, height:28, borderRadius:'50%', border:'1px solid var(--border)', background:'var(--surface)', cursor:'pointer', fontSize:14, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-muted)' }}>{'<'}</button>
      <span style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)' }}>{weekLabel}</span>
      <button onClick={() => nav(1)} style={{ width:28, height:28, borderRadius:'50%', border:'1px solid var(--border)', background:'var(--surface)', cursor:'pointer', fontSize:14, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-muted)' }}>{'>'}</button>
      <button onClick={() => setWeekBase(getTodayMonday())} style={{ fontSize:11, padding:'3px 8px', borderRadius:6, border:'1px solid var(--accent)', background:'none', color:'var(--accent)', cursor:'pointer', fontWeight:600 }}>Today</button>
    </div>
  )
}

function StatCard({ label, value, sub, valueColor }) {
  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'16px 18px' }}>
      <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:8 }}>{label}</div>
      <div style={{ fontSize:28, fontWeight:800, letterSpacing:'-1px', color: valueColor || 'var(--text-primary)' }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>{sub}</div>}
    </div>
  )
}
