// Multi-sheet Excel export. Fed by the same analytics functions the dashboard
// renders from, so the workbook can't disagree with the screen.
import { fmtSecs, SERVICE_LEVEL_SECONDS, SERVICE_LEVEL_TARGET } from './analytics'

// Round a percentage for the sheet, keeping null as a real blank rather than 0
// — "no calls" and "0%" mean very different things in a service-level column.
const p1 = (v) => (v == null ? '' : Number(v.toFixed(1)))
const n = (v) => (v == null ? '' : v)

export async function exportAnalyticsWorkbook({
  label, rangeText, inbound, outbound, hourly, daily, dow, agents, campaigns, tasks, logs,
}) {
  // Loaded on demand — the library is ~800KB and most sessions never export.
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()

  const add = (name, rows) => {
    if (!rows.length) rows = [{ '': 'No data in this period' }]
    // Sheet names: Excel forbids []:*?/\ and caps at 31 chars.
    const safe = name.replace(/[[\]:*?/\\]/g, '').slice(0, 31)
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), safe)
  }

  add('Summary', [
    { Metric: 'Period', Value: label },
    { Metric: 'Range', Value: rangeText },
    { Metric: '', Value: '' },
    { Metric: '— INBOUND —', Value: '' },
    { Metric: 'Calls offered', Value: inbound.offered },
    { Metric: 'Handled', Value: inbound.handled },
    { Metric: 'Abandoned', Value: inbound.abandoned },
    { Metric: `Service level (${SERVICE_LEVEL_SECONDS}s)`, Value: p1(inbound.serviceLevel), Target: `${SERVICE_LEVEL_TARGET}%` },
    { Metric: 'Abandon rate %', Value: p1(inbound.abandonRate) },
    { Metric: 'Average speed of answer', Value: fmtSecs(inbound.asa) },
    { Metric: 'Average handle time', Value: fmtSecs(inbound.aht) },
    { Metric: 'Longest wait', Value: fmtSecs(inbound.longestWait) },
    { Metric: '', Value: '' },
    { Metric: '— OUTBOUND —', Value: '' },
    { Metric: 'Calls made', Value: outbound.calls },
    { Metric: 'Booked', Value: outbound.booked },
    { Metric: 'Conversion %', Value: p1(outbound.conversion) },
  ])

  const intervalRow = (r) => ({
    Interval: r.label,
    Offered: r.offered,
    Handled: r.handled,
    Abandoned: r.abandoned,
    'Service level %': p1(r.serviceLevel),
    'Abandon rate %': p1(r.abandonRate),
    'ASA (s)': r.asa == null ? '' : Math.round(r.asa),
    'Outbound calls': r.outboundCalls,
    Booked: r.booked,
  })

  add('By hour', hourly.map(intervalRow))
  add('By day', daily.map(intervalRow))
  add('By day of week', dow.map(intervalRow))

  add('Agents', agents.map(a => ({
    Agent: a.name,
    'Inbound handled': a.inboundHandled,
    'Inbound AHT (s)': a.inboundAht == null ? '' : Math.round(a.inboundAht),
    'Service level %': p1(a.serviceLevel),
    'Outbound calls': a.outboundCalls,
    Booked: a.booked,
    'Conversion %': p1(a.conversion),
    'Logged in': fmtSecs(a.loggedInSeconds),
    Available: fmtSecs(a.availableSeconds),
    'Wrap up': fmtSecs(a.wrapSeconds),
    'Break/Lunch': fmtSecs(a.breakSeconds),
    'Occupancy %': p1(a.occupancy),
  })))

  add('Campaigns', campaigns.map(c => ({
    Campaign: c.name,
    Contacts: c.contacts,
    Remaining: c.remaining,
    'Calls made': c.calls,
    Booked: c.booked,
    'Conversion %': p1(c.conversion),
  })))

  // Raw rows so anyone can pivot or audit a number back to its source.
  add('Inbound calls', tasks.map(t => ({
    'Queued at': t.queued_at ? new Date(t.queued_at).toLocaleString() : '',
    Caller: t.contact_name || 'Unknown',
    // Leading apostrophe stops Excel turning +1719… into scientific notation.
    Number: t.from_number ? `'${t.from_number}` : '',
    Outcome: t.state,
    'Wait (s)': n(t.wait_seconds),
    'Talk (s)': n(t.talk_seconds),
    Agent: t.agent_name || '',
    'Answered at': t.answered_at ? new Date(t.answered_at).toLocaleString() : '',
  })))

  add('Outbound calls', logs.map(l => ({
    'Logged at': l.created_at ? new Date(l.created_at).toLocaleString() : '',
    Rep: l.rep || '',
    Outcome: l.outcome || '',
    Notes: l.notes || '',
  })))

  const stamp = new Date().toISOString().slice(0, 10)
  XLSX.writeFile(wb, `Andi_Analytics_${label.replace(/\s+/g, '_')}_${stamp}.xlsx`)
}
