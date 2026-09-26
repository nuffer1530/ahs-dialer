import { useState, Component } from 'react'
import { useAuth } from '../lib/AuthContext'
import { useIsMobile } from '../lib/useIsMobile'
import CallEvalsTab from '../components/CallEvalsTab'
import ScorecardsPanel from '../components/ScorecardsPanel'
import TechScorecardsPanel from '../components/TechScorecardsPanel'
import CommissionReport from '../components/CommissionReport'
import { PageTabs, Segmented } from '../components/ui'

// Team — the manager's home: coaching, evals, scorecards, commissions for
// the team(s) you lead. Call Center: admins, or a profile whose leads_teams
// includes it. Technicians: admins and operations managers (the server's
// requireFieldLead gate) — ops managers see only this team, never the call
// center. Field Pro coaching & evals join the technician tabs once Siro's
// scorecard API is connected.
const TEAMS = [
  { id: 'call_center', label: 'Call Center', tabs: [['coaching', 'Coaching & Evals'], ['scorecards', 'Scorecards'], ['commissions', 'Commissions']] },
  { id: 'technicians', label: 'Technicians', tabs: [['scorecards', 'Scorecards']] },
]

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
  const isMobile = useIsMobile()
  const isAdmin = profile?.role === 'admin'
  const isOps = profile?.role === 'ops_manager'
  const myTeams = isAdmin ? TEAMS
    : isOps ? TEAMS.filter(t => t.id === 'technicians')
    : TEAMS.filter(t => t.id !== 'technicians' && (profile?.leads_teams || []).includes(t.id))
  const [teamPick, setTeamPick] = useState(null)
  const [tabPick, setTabPick] = useState(null)

  if (!myTeams.length) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>You don't lead a team yet.</div>
  }

  const current = myTeams.find(t => t.id === teamPick) || myTeams[0]
  const team = current.id
  const TABS = current.tabs
  const tab = TABS.some(([id]) => id === tabPick) ? tabPick : TABS[0][0]
  const setTab = setTabPick

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0, padding: isMobile ? '0 12px' : '0 24px', display: 'flex', gap: 12, alignItems: 'center' }}>
        <PageTabs tabs={TABS} value={tab} onChange={setTab} />
        {myTeams.length > 1 ? (
          <div style={{ marginLeft: 'auto', flexShrink: 0 }}>
            <Segmented value={team} onChange={setTeamPick} options={myTeams.map(t => [t.id, t.label])} />
          </div>
        ) : (
          <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {current.label}
          </span>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? 12 : 24, background: 'var(--bg)' }}>
        {team === 'call_center' && tab === 'coaching' && <TabBoundary><CallEvalsTab profile={profile} isAdmin={true} defaultView="snapshots" /></TabBoundary>}
        {team === 'call_center' && tab === 'scorecards' && <TabBoundary><ScorecardsPanel /></TabBoundary>}
        {team === 'call_center' && tab === 'commissions' && <TabBoundary><CommissionReport /></TabBoundary>}
        {team === 'technicians' && tab === 'scorecards' && <TabBoundary key="tech"><TechScorecardsPanel /></TabBoundary>}
      </div>
    </div>
  )
}
