import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useData } from '../lib/DataContext'
import { getTimeframeBounds } from '../lib/utils'

const TF = ['today', 'week', 'month', 'all']
const TF_LABELS = { today: 'Today', week: 'This Week', month: 'This Month', all: 'All Time' }

export default function LeaderboardPage() {
  const { contacts } = useData()
  const [tf, setTf] = useState('today')
  const [logs, setLogs] = useState([])
  const [removedReps, setRemovedReps] = useState(new Set())
  const [loading, setLoading] = useState(true)

  // call_logs.rep is a display-name string, not a profile id, so removed users
  // keep appearing here unless their names are excluded explicitly. Match the
  // name AND email, since DialerPage falls back to email when name is unset.
  useEffect(() => {
    sb.from('profiles').select('name, email').eq('active', false).then(({ data }) => {
      setRemovedReps(new Set((data || []).flatMap(p => [p.name, p.email]).filter(Boolean)))
    })
  }, [])

  useEffect(() => {
    setLoading(true)
    const { start, end } = getTimeframeBounds(tf)
    sb.from('call_logs').select('*').gte('created_at', start.toISOString()).lte('created_at', end.toISOString())
      .then(({ data }) => { setLogs(data || []); setLoading(false) })
  }, [tf])

  // Build rep stats
  const repStats = {}
  logs.forEach(l => {
    if (!l.rep) return
    if (removedReps.has(l.rep)) return
    if (!repStats[l.rep]) repStats[l.rep] = { calls: 0, booked: 0, voicemail: 0, noAnswer: 0, notInterested: 0, dnc: 0 }
    repStats[l.rep].calls++
    if (l.outcome === 'Booked') repStats[l.rep].booked++
    if (l.outcome === 'Voicemail') repStats[l.rep].voicemail++
    if (l.outcome === 'No Answer') repStats[l.rep].noAnswer++
    if (l.outcome === 'Not Interested') repStats[l.rep].notInterested++
    if (l.outcome === 'DNC') repStats[l.rep].dnc++
  })

  const ranked = Object.entries(repStats).sort((a, b) => b[1].booked - a[1].booked || b[1].calls - a[1].calls)
  const medals = ['🥇', '🥈', '🥉']
  const podiumColors = ['#FFD700', '#C0C0C0', '#CD7F32']

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>🏆 Leaderboard</h1>
        <div style={{ display: 'flex', gap: 6 }}>
          {TF.map(t => (
            <button key={t} onClick={() => setTf(t)}
              style={{ padding: '6px 14px', borderRadius: 99, fontSize: 12, fontWeight: 600, border: '1px solid', cursor: 'pointer',
                borderColor: tf === t ? 'var(--accent)' : 'var(--border-strong)',
                background: tf === t ? 'var(--accent)' : 'var(--surface)',
                color: tf === t ? '#fff' : 'var(--text-secondary)' }}>
              {TF_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {loading ? <div className="spinner" style={{ margin: '40px auto' }}></div> : ranked.length === 0 ? (
        <div className="empty-state"><div className="empty-icon">🏆</div><div>No calls logged for this period.</div></div>
      ) : (
        <>
          {/* Podium for top 3 */}
          {ranked.length >= 1 && (
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 12, marginBottom: 8 }}>
              {[ranked[1], ranked[0], ranked[2]].filter(Boolean).map((entry, visualIdx) => {
                const [rep, d] = entry
                const actualRank = ranked.indexOf(entry)
                const heights = [160, 200, 130]
                const h = heights[visualIdx]
                const conv = d.calls ? Math.round((d.booked / d.calls) * 100) : 0
                return (
                  <div key={rep} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: 32 }}>{medals[actualRank]}</div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{rep.split(' ')[0]}</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--success)' }}>{d.booked}</div>
                    <div style={{ width: 100, height: h, background: podiumColors[actualRank], borderRadius: '8px 8px 0 0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, opacity: 0.9 }}>
                      <div style={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>{d.calls} calls</div>
                      <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 11 }}>{conv}% conv</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Full table */}
          <div className="card">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 50 }}>Rank</th>
                  <th>Rep</th>
                  <th style={{ textAlign: 'center' }}>Calls</th>
                  <th style={{ textAlign: 'center' }}>Booked</th>
                  <th style={{ textAlign: 'center' }}>Conv %</th>
                  <th style={{ textAlign: 'center' }}>VM</th>
                  <th style={{ textAlign: 'center' }}>No Ans</th>
                  <th style={{ textAlign: 'center' }}>Not Int</th>
                  <th style={{ width: 160 }}>Progress bar</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map(([rep, d], i) => {
                  const conv = d.calls ? Math.round((d.booked / d.calls) * 100) : 0
                  const maxCalls = ranked[0][1].calls || 1
                  return (
                    <tr key={rep}>
                      <td style={{ padding: '12px', textAlign: 'center', fontSize: 18 }}>{medals[i] || `#${i + 1}`}</td>
                      <td style={{ padding: '12px', fontWeight: 600, fontSize: 14 }}>{rep}</td>
                      <td style={{ padding: '12px', textAlign: 'center', fontWeight: 600 }}>{d.calls}</td>
                      <td style={{ padding: '12px', textAlign: 'center', fontWeight: 700, color: 'var(--success)', fontSize: 16 }}>{d.booked}</td>
                      <td style={{ padding: '12px', textAlign: 'center', color: conv >= 10 ? 'var(--success)' : conv >= 5 ? 'var(--warning)' : 'var(--danger)', fontWeight: 600 }}>{conv}%</td>
                      <td style={{ padding: '12px', textAlign: 'center', color: 'var(--purple)' }}>{d.voicemail}</td>
                      <td style={{ padding: '12px', textAlign: 'center', color: 'var(--warning)' }}>{d.noAnswer}</td>
                      <td style={{ padding: '12px', textAlign: 'center', color: 'var(--danger)' }}>{d.notInterested}</td>
                      <td style={{ padding: '12px' }}>
                        <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 99, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${(d.calls / maxCalls) * 100}%`, background: 'var(--accent)', borderRadius: 99 }} />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
