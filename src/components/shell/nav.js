// Andi's navigation model (redesign stage 1, Sep 2026): the old 13 sidebar
// items regrouped into hubs. Every page and every role gate is the same as
// before — a hub just groups routes, and its tabs show in the top bar.
// ctx = { isAdmin, isOpsManager, canDispatch, isLeader, leadsTeams, isHandheld }

export const HUBS = [
  {
    id: 'phones', label: 'Phones', icon: 'phone',
    tabs: [
      // A phone is for looking, not dialing — the dialer is desktop-only.
      { to: '/', label: 'Dialer', end: true, gate: c => !c.isHandheld },
    ],
  },
  {
    id: 'dispatch', label: 'Dispatch', icon: 'dispatch',
    tabs: [
      { to: '/callboard', label: '3-Day Board' },
      { to: '/dispatch', label: 'Dispatch for Profit', gate: c => c.canDispatch },
    ],
  },
  {
    id: 'calls', label: 'Calls', icon: 'calls',
    tabs: [
      { to: '/live', label: 'Live', gate: c => !c.isOpsManager },
      { to: '/analytics', label: 'Analytics', gate: c => !c.isOpsManager },
      { to: '/recordings', label: 'Recordings', gate: c => !c.isOpsManager },
    ],
  },
  {
    id: 'team', label: 'Team', icon: 'team',
    tabs: [
      { to: '/team', label: 'Coaching & scorecards', gate: c => c.isAdmin || c.isOpsManager || c.leadsTeams },
      { to: '/attendance', label: 'WFM', gate: c => c.isAdmin },
    ],
  },
  {
    id: 'leadership', label: 'Leadership', icon: 'leadership',
    tabs: [{ to: '/leadership', label: 'Weekly agenda', gate: c => c.isLeader }],
  },
]

const ok = (item, ctx) => !item.gate || item.gate(ctx)

// Hubs this person can open, each with only the tabs they can open.
export function visibleHubs(ctx) {
  return HUBS.map(h => ({ ...h, tabs: h.tabs.filter(t => ok(t, ctx)) })).filter(h => h.tabs.length)
}

export const pathMatches = (to, pathname, end) => (end || to === '/' ? pathname === to : pathname === to || pathname.startsWith(to + '/'))

export function hubForPath(hubs, pathname) {
  return hubs.find(h => h.tabs.some(t => pathMatches(t.to, pathname, t.end))) || null
}

// Wall boards, opened from one launcher instead of three sidebar items.
export function tvBoards(ctx) {
  const deptTv = ctx.isAdmin || ctx.isOpsManager || ctx.canDispatch || ctx.leadsTeams
  return [
    { to: '/warroom', label: 'Call Center', gate: !ctx.isOpsManager },
    { to: '/tv/company', label: 'Company', gate: deptTv },
    { to: '/tv/hvac', label: 'HVAC', gate: deptTv },
    { to: '/tv/plumbing', label: 'Plumbing', gate: deptTv },
    { to: '/tv/electrical', label: 'Electrical', gate: deptTv },
    { to: '/tv/garage', label: 'Garage Doors', gate: deptTv },
    { to: '/tv/ceo', label: 'CEO', gate: ctx.isLeader },
  ].filter(b => b.gate)
}

// Your own pages — My Page's tabs — plus Settings, behind your avatar.
export function meLinks(ctx) {
  return [
    ...(ctx.isOpsManager ? [] : [
      { to: '/mypage?tab=my-schedule', label: 'My schedule' },
      { to: '/mypage?tab=stats', label: 'My stats' },
      { to: '/mypage?tab=commissions', label: 'My pay' },
      { to: '/mypage?tab=scorecard', label: 'My scorecard' },
      { to: '/mypage?tab=call-evals', label: 'My call evals' },
      { to: '/mypage?tab=time-off', label: 'Time off', badgeKey: 'pto' },
      { to: '/mypage?tab=team-schedule', label: 'Team schedule' },
    ]),
    { to: '/settings', label: 'Settings' },
  ]
}

// Title for pages that sit outside the hubs.
export const OTHER_TITLES = { '/mypage': 'My Page', '/settings': 'Settings' }

export function roleLabel(ctx, profile) {
  if (ctx.isOpsManager) return 'Operations manager'
  if (ctx.isAdmin) return ctx.isLeader ? 'Owner' : 'Admin'
  if (ctx.canDispatch) return 'Dispatcher'
  return (profile?.leads_teams || []).length ? 'Team lead' : 'Customer service'
}
