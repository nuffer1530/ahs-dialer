import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useData } from '../lib/DataContext'
import { isDone, fmtShort } from '../lib/utils'

export default function WarRoomPage() {
  const { contacts, campaigns } = useData()
  const [logs, setLogs] = useState([])
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    // Load today's logs
    const today = new Date(); today.setHours(0,0,0,0)
    sb.from('call_logs').select('*').gte('created_at', today.toISOString()).order('created_at', { ascending: false })
      .then(({ data }) => setLogs(data || []))

    // Real-time updates
    const channel = sb.channel('warroom')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_logs' }, payload => {
        setLogs(prev => [payload.new, ...prev])
      })
      .subscribe()

    // Clock
    const clockTimer = setInterval(() => setTime(new Date()), 1000)

    return () => { sb.removeChannel(channel); clearInterval(clockTimer) }
  }, [])

  const now = new Date()
  const todayStr = now.toDateString()

  // Stats
  const totalContacts = contacts.length
  const totalDone = contacts.filter(isDone).length
  const totalBooked = contacts.filter(c => c.status === 'Booked').length
  const totalActive = contacts.filter(c => !isDone(c) && c.status !== 'Max Attempts').length
  const todayLogs = logs.filter(l => new Date(l.created_at).toDateString() === todayStr)
  const todayCalls = todayLogs.length
  const todayBooked = todayLogs.filter(l => l.outcome === 'Booked').length
  const todayConv = todayCalls ? Math.round((todayBooked / todayCalls) * 100) : 0

  // Rep leaderboard - today
  const repStats = {}
  todayLogs.forEach(l => {
    if (!l.rep) return
    if (!repStats[l.rep]) repStats[l.rep] = { calls: 0, booked: 0, lastCall: null }
    repStats[l.rep].calls++
    if (l.outcome === 'Booked') repStats[l.rep].booked++
    if (!repStats[l.rep].lastCall || new Date(l.created_at) > new Date(repStats[l.rep].lastCall)) {
      repStats[l.rep].lastCall = l.created_at
    }
  })
  const leaderboard = Object.entries(repStats).sort((a, b) => b[1].booked - a[1].booked || b[1].calls - a[1].calls)

  // Campaign progress
  const campStats = campaigns.map(camp => {
    const cc = contacts.filter(c => c.campaign_id === camp.id)
    const done = cc.filter(isDone).length
    const booked = cc.filter(c => c.status === 'Booked').length
    const pct = cc.length ? Math.round((done / cc.length) * 100) : 0
    return { ...camp, total: cc.length, done, booked, pct }
  }).filter(c => c.total > 0).sort((a, b) => b.booked - a.booked)

  // Recent activity feed
  const recentActivity = logs.slice(0, 12)

  const OUTCOME_COLORS = {
    'Booked': '#2E7D52', 'No Answer': '#8A5A00', 'Voicemail': '#5B3FA0',
    'Not Interested': '#B5341A', 'DNC': '#5F1C0A', 'Bad Data': '#9E9B96',
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#0D1117', color: '#E6EDF3',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      padding: 24, display: 'flex', flexDirection: 'column', gap: 20,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ background: '#1A5C8A', color: '#fff', fontSize: 16, fontWeight: 800, padding: '4px 12px', borderRadius: 6, letterSpacing: .5 }}>AHS</span>
          <span style={{ fontSize: 22, fontWeight: 700 }}>Dialer War Room</span>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#2E7D52', animation: 'pulse 1.5s infinite' }}></div>
          <span style={{ fontSize: 12, color: '#8B949E' }}>LIVE</span>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: -1, color: '#58A6FF' }}>
            {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
          <div style={{ fontSize: 12, color: '#8B949E' }}>{time.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        </div>
      </div>

      {/* Top stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12 }}>
        {[
          { label: "Today's Calls", value: todayCalls, color: '#58A6FF', big: true },
          { label: "Booked Today", value: todayBooked, color: '#2E7D52', big: true },
          { label: "Conv. Rate", value: todayConv + '%', color: todayConv >= 10 ? '#2E7D52' : todayConv >= 5 ? '#C87800' : '#B5341A', big: true },
          { label: "Total Booked", value: totalBooked, color: '#2E7D52' },
          { label: "Remaining", value: totalActive.toLocaleString(), color: '#C87800' },
          { label: "Completed", value: totalDone.toLocaleString(), color: '#8B949E' },
        ].map(({ label, value, color, big }) => (
          <div key={label} style={{ background: '#161B22', border: '1px solid #30363D', borderRadius: 12, padding: '16px 20px', borderTop: `3px solid ${color}` }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .8, color: '#8B949E', marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: big ? 36 : 28, fontWeight: 800, color, letterSpacing: -1 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Main grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 16, flex: 1 }}>

        {/* Leaderboard */}
        <div style={{ background: '#161B22', border: '1px solid #30363D', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #30363D', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>🏆</span>
            <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: .3 }}>TODAY'S LEADERBOARD</span>
          </div>
          <div style={{ padding: '8px 0' }}>
            {leaderboard.length === 0 ? (
              <div style={{ padding: '24px 20px', color: '#8B949E', fontSize: 13, textAlign: 'center' }}>No calls logged yet today</div>
            ) : leaderboard.map(([rep, d], i) => {
              const conv = d.calls ? Math.round((d.booked / d.calls) * 100) : 0
              const isActive = d.lastCall && (now - new Date(d.lastCall)) < 30 * 60 * 1000
              const medals = ['🥇', '🥈', '🥉']
              return (
                <div key={rep} style={{ padding: '12px 20px', borderBottom: '1px solid #21262D', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontSize: 20, width: 28, flexShrink: 0 }}>{medals[i] || `#${i+1}`}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{rep}</div>
                      {isActive && <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#2E7D52', animation: 'pulse 1.5s infinite' }}></div>}
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                      <span style={{ fontSize: 11, color: '#8B949E' }}>{d.calls} calls</span>
                      <span style={{ fontSize: 11, color: conv >= 10 ? '#2E7D52' : '#8B949E' }}>{conv}% conv</span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 24, fontWeight: 800, color: '#2E7D52' }}>{d.booked}</div>
                    <div style={{ fontSize: 10, color: '#8B949E', textTransform: 'uppercase' }}>Booked</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Campaign progress */}
        <div style={{ background: '#161B22', border: '1px solid #30363D', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #30363D', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>📋</span>
            <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: .3 }}>CAMPAIGN PROGRESS</span>
          </div>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {campStats.map(camp => (
              <div key={camp.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{camp.name}</span>
                  <span style={{ fontSize: 12, color: '#8B949E' }}>{camp.pct}%</span>
                </div>
                <div style={{ height: 8, background: '#21262D', borderRadius: 99, overflow: 'hidden', marginBottom: 4 }}>
                  <div style={{ height: '100%', width: `${camp.pct}%`, background: 'linear-gradient(90deg, #1A5C8A, #2E7D52)', borderRadius: 99, transition: 'width 1s ease' }} />
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#8B949E' }}>
                  <span>{camp.total.toLocaleString()} total</span>
                  <span style={{ color: '#C87800' }}>{(camp.total - camp.done).toLocaleString()} left</span>
                  <span style={{ color: '#2E7D52' }}>{camp.booked} booked</span>
                </div>
              </div>
            ))}
            {campStats.length === 0 && <div style={{ color: '#8B949E', fontSize: 13, textAlign: 'center', padding: 20 }}>No campaigns yet</div>}
          </div>
        </div>

        {/* Live activity feed */}
        <div style={{ background: '#161B22', border: '1px solid #30363D', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #30363D', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>⚡</span>
            <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: .3 }}>LIVE ACTIVITY</span>
            <div style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: '50%', background: '#2E7D52', animation: 'pulse 1.5s infinite' }}></div>
          </div>
          <div style={{ overflow: 'hidden' }}>
            {recentActivity.length === 0 ? (
              <div style={{ padding: '24px 20px', color: '#8B949E', fontSize: 13, textAlign: 'center' }}>Waiting for activity…</div>
            ) : recentActivity.map((l, i) => {
              const color = OUTCOME_COLORS[l.outcome] || '#8B949E'
              const c = contacts.find(x => x.id === l.contact_id)
              return (
                <div key={l.id} style={{ padding: '10px 20px', borderBottom: '1px solid #21262D', display: 'flex', alignItems: 'center', gap: 10, opacity: i > 8 ? 0.5 : 1 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }}></div>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: l.outcome === 'Booked' ? '#2E7D52' : '#E6EDF3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {l.outcome === 'Booked' ? '🎉 ' : ''}{c?.name || '—'}
                    </div>
                    <div style={{ fontSize: 11, color: '#8B949E' }}>{l.rep} · {fmtShort(l.created_at)}</div>
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color, flexShrink: 0 }}>{l.outcome}</div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1;}50%{opacity:.3;} }
      `}</style>
    </div>
  )
}
