// Call-centre KPI maths. Kept out of the page so the on-screen numbers and the
// exported workbook are computed once, from one definition — a report that
// disagrees with the dashboard is worse than no report.
//
// IMPORTANT on history: call_tasks only exists from the day TaskRouter went
// live (Jul 2026). The old ring-all inbound flow never recorded an answer time,
// so service level, ASA and abandon rate cannot be computed for anything before
// that — they aren't zero, they're unknown. Callers must not read an empty
// early period as "we were perfect".
export const SERVICE_LEVEL_SECONDS = 30
export const SERVICE_LEVEL_TARGET = 90   // % answered within the threshold

export const pct = (n, d) => (d ? (n / d) * 100 : null)

export const fmtSecs = (s) => {
  if (s == null || Number.isNaN(s)) return '—'
  const v = Math.round(s)
  if (v < 60) return `${v}s`
  const m = Math.floor(v / 60)
  if (m < 60) return `${m}m ${v % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export const fmtPct = (v, digits = 0) => (v == null ? '—' : `${v.toFixed(digits)}%`)

// ── Inbound (call_tasks) ────────────────────────────────────────────────
// offered   = every call that entered the queue
// handled   = an agent answered
// abandoned = caller hung up after the grace window (misdials are 'missed' and
//             are deliberately excluded from both numerator and denominator)
export function inboundStats(tasks) {
  const offered = tasks.length
  const handled = tasks.filter(t => t.state === 'answered')
  const abandoned = tasks.filter(t => t.state === 'abandoned')
  const settled = handled.length + abandoned.length

  const withinSL = handled.filter(t => (t.wait_seconds ?? Infinity) <= SERVICE_LEVEL_SECONDS)
  const waits = handled.map(t => t.wait_seconds).filter(v => v != null)
  const talks = handled.map(t => t.talk_seconds).filter(v => v != null)

  return {
    offered,
    handled: handled.length,
    abandoned: abandoned.length,
    // Of everything that reached a conclusion, what share was answered in time.
    // Abandons count against it, which is the entire point of the metric.
    serviceLevel: pct(withinSL.length, settled),
    abandonRate: pct(abandoned.length, settled),
    asa: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null,
    aht: talks.length ? talks.reduce((a, b) => a + b, 0) / talks.length : null,
    longestWait: waits.length ? Math.max(...waits) : null,
    totalTalk: talks.reduce((a, b) => a + b, 0),
  }
}

// ── Outbound (call_logs) ────────────────────────────────────────────────
export function outboundStats(logs) {
  const by = {}
  logs.forEach(l => { by[l.outcome] = (by[l.outcome] || 0) + 1 })
  const booked = by['Booked'] || 0
  return {
    calls: logs.length,
    booked,
    conversion: pct(booked, logs.length),
    byOutcome: by,
    contacted: (by['Booked'] || 0) + (by['Not Interested'] || 0) + (by['DNC'] || 0),
  }
}

// ── Interval breakdowns ─────────────────────────────────────────────────
// Buckets use LOCAL time on purpose: "how were we at 9am" means 9am here, not
// UTC. The browser runs in the shop's timezone.
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function bucket(tasks, logs, keyFn, label) {
  const groups = new Map()
  const touch = (k) => {
    if (!groups.has(k)) groups.set(k, { key: k, tasks: [], logs: [] })
    return groups.get(k)
  }
  tasks.forEach(t => touch(keyFn(new Date(t.queued_at))).tasks.push(t))
  logs.forEach(l => touch(keyFn(new Date(l.created_at))).logs.push(l))

  return [...groups.values()].map(g => {
    const i = inboundStats(g.tasks)
    const o = outboundStats(g.logs)
    return {
      label: label(g.key),
      sortKey: g.key,
      offered: i.offered, handled: i.handled, abandoned: i.abandoned,
      serviceLevel: i.serviceLevel, abandonRate: i.abandonRate, asa: i.asa,
      outboundCalls: o.calls, booked: o.booked,
    }
  }).sort((a, b) => (a.sortKey > b.sortKey ? 1 : a.sortKey < b.sortKey ? -1 : 0))
}

export const byHour = (tasks, logs) =>
  bucket(tasks, logs, d => d.getHours(), h => `${String(h).padStart(2, '0')}:00`)

export const byDay = (tasks, logs) =>
  bucket(tasks, logs, d => d.toISOString().slice(0, 10),
    k => new Date(k + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))

export const byDayOfWeek = (tasks, logs) => {
  const rows = bucket(tasks, logs, d => d.getDay(), k => DOW[k])
  // Monday-first reads better for a work week than Sunday-first.
  return rows.sort((a, b) => ((a.sortKey + 6) % 7) - ((b.sortKey + 6) % 7))
}

// ── Per-agent ───────────────────────────────────────────────────────────
// Reps are keyed two ways across this app: call_logs.rep is a display-name
// string, call_tasks.agent_profile_id is an FK. Join on the profile and carry
// both, or a renamed rep silently splits into two rows.
export function agentStats(profiles, tasks, logs, statusEvents) {
  return profiles.map(p => {
    const name = p.name || p.email
    const mine = tasks.filter(t => t.agent_profile_id === p.id)
    const inb = inboundStats(mine)
    const myLogs = logs.filter(l => l.rep === name)
    const out = outboundStats(myLogs)

    const evts = statusEvents.filter(e => e.profile_id === p.id)
    const secsIn = (status) => evts.filter(e => e.status === status)
      .reduce((s, e) => s + (e.duration_seconds || 0), 0)
    const loggedIn = evts.filter(e => e.status !== 'Offline')
      .reduce((s, e) => s + (e.duration_seconds || 0), 0)
    const talking = inb.totalTalk

    return {
      profileId: p.id,
      name,
      inboundHandled: inb.handled,
      inboundAht: inb.aht,
      serviceLevel: inb.serviceLevel,
      outboundCalls: out.calls,
      booked: out.booked,
      conversion: out.conversion,
      loggedInSeconds: loggedIn,
      availableSeconds: secsIn('Available'),
      wrapSeconds: secsIn('Wrap Up'),
      breakSeconds: secsIn('Break') + secsIn('Lunch'),
      // Occupancy: share of logged-in time actually on a call. Inbound talk
      // time only — outbound duration isn't reliably recorded per rep, so this
      // understates anyone doing mostly outbound.
      occupancy: loggedIn ? pct(talking, loggedIn) : null,
    }
  })
}

// ── Per-campaign ────────────────────────────────────────────────────────
export function campaignStats(campaigns, logs, contacts) {
  return campaigns.map(c => {
    const mine = logs.filter(l => l.campaign_id === c.id)
    const o = outboundStats(mine)
    const pool = contacts.filter(x => x.campaign_id === c.id)
    return {
      id: c.id,
      name: c.name,
      calls: o.calls,
      booked: o.booked,
      conversion: o.conversion,
      contacts: pool.length,
      remaining: pool.filter(x => x.status === 'Pending' || x.status === 'No Answer' || x.status === 'Voicemail').length,
    }
  })
}
