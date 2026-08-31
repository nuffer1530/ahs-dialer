import { useState, Component } from 'react'
import { useAuth } from '../lib/AuthContext'
import CallEvalsTab from '../components/CallEvalsTab'
import ScorecardsPanel from '../components/ScorecardsPanel'
import CommissionReport from '../components/CommissionReport'

// Team — the manager's home: coaching, evals, scorecards, commissions for
// the team(s) you lead. Built as a frame: today's only tenant is the call
// center; technician teams plug into the same tabs later. Access: admins,
// or a profile whose leads_teams includes a team (migration-tolerant).
const TEAMS = [{ id: 'call_center', label: 'Call Center' }]

// A crashed tab must say WHAT crashed, not white-screen the page.
class TabBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  render() {
    if (this.state.err) return (
      <div style={{ padding: 30, color: 'var(--danger)', fontSize: 13 }}>
        This tab hit an error: {String(this.state.err?.message || this.state.err)} — tell Brandyn/Claude.
      </div>
    )
    return this.props.children
  }
}

export default function TeamPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const myTeams = isAdmin ? TEAMS : TEAMS.filter(t => (profile?.leads_teams || []).includes(t.id))
  const [team] = useState(TEAMS[0].id)
  const [tab, setTab] = useState('coaching')

  if (!myTeams.length) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>You don't lead a team yet.</div>
  }

  const TABS = [
    ['coaching', 'Coaching & Evals'],
    ['scorecards', 'Scorecards'],
    ['commissions', 'Commissions'],
  ]

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0, padding: '0 24px', display: 'flex', gap: 4, alignItems: 'center' }}>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ padding: '12px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13,
              fontWeight: tab === id ? 700 : 500, color: tab === id ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}` }}>
            {label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, letterSpacing: .5, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          {TEAMS.find(t => t.id === team)?.label}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 24, background: 'var(--bg)' }}>
        {tab === 'coaching' && <TabBoundary><CallEvalsTab profile={profile} isAdmin={true} defaultView="snapshots" /></TabBoundary>}
        {tab === 'scorecards' && <TabBoundary><ScorecardsPanel /></TabBoundary>}
        {tab === 'commissions' && <TabBoundary><CommissionReport /></TabBoundary>}
      </div>
    </div>
  )
}
