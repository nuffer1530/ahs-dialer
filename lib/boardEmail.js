// 3-Day Call Board → HTML email for the leadership team.
//
// Email HTML is not web HTML. Constraints that drive every choice below:
//  - Table-based layout only. Outlook (Word rendering engine) ignores flex/grid.
//  - Inline styles only; <style> blocks are stripped by Gmail's clipper and
//    others. No external CSS, no webfonts.
//  - No background-image, no position, no rem. Widths in px or %.
//  - Keep the total under ~102KB or Gmail clips the message and hides the tail.
//
// Layout is one section per DAY (not per trade) because leadership reads this on
// a phone: three stacked day-blocks scroll naturally, whereas a 3-column grid
// would squash to unreadable on mobile without media queries Outlook ignores.

const STATUS = {
  good:  { color: '#15803D', bg: '#EAF5EE', border: '#BBE3C9', label: 'At / over target' },
  warn:  { color: '#B45309', bg: '#FBF3E0', border: '#F0DCA8', label: 'Filling up' },
  under: { color: '#B91C1C', bg: '#FBEEEA', border: '#F0C8BE', label: 'Below capacity' },
  none:  { color: '#6B7280', bg: '#F3F4F6', border: '#E5E7EB', label: 'No techs' },
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const fmtDay = (iso, i) => {
  const d = new Date(iso + 'T12:00:00')
  const label = ['Today', 'Tomorrow', ''][i] || ''
  const date = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  return label ? `${label} · ${date}` : date
}

// Techs can be fractional now that installs consume capacity (3.4 techs), but
// "3.4" reads oddly in a summary — show one decimal only when it isn't whole.
const num = (n) => (n == null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(1))

function tradeRow(trade, d) {
  const s = STATUS[d.status] || STATUS.none
  const oppPct = d.calls ? Math.round((d.opps / d.calls) * 100) : 0
  const headline = d.oppWatch
    ? `<span style="font-size:14px;font-weight:800;color:#7C3AED;">👀 OPPORTUNITY WATCH</span>
       <span style="font-size:11px;color:#6B7280;"> — full board: keep booking strong calls, dispatch makes room</span>`
    : d.needed > 0
    ? `<span style="font-size:22px;font-weight:800;color:${s.color};">${d.needed}</span>
       <span style="font-size:12px;color:#6B7280;"> call${d.needed === 1 ? '' : 's'} needed</span>`
    : `<span style="font-size:15px;font-weight:700;color:${s.color};">On target</span>`

  return `
  <tr>
    <td style="padding:0 0 8px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
             style="border:1px solid ${s.border};border-radius:8px;background:#FFFFFF;">
        <tr>
          <td style="padding:10px 14px;background:${s.bg};border-radius:8px 8px 0 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td style="font-size:14px;font-weight:700;color:#111827;">${esc(trade)}</td>
                <td align="right" style="font-size:11px;font-weight:700;color:${s.color};text-transform:uppercase;letter-spacing:.4px;">
                  ${d.pct}% · ${s.label}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr><td style="padding:12px 14px 4px 14px;">${headline}</td></tr>
        <tr>
          <td style="padding:4px 14px 12px 14px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                ${cell('Techs', num(d.techs))}
                ${cell('Booked', `${d.calls}/${num(d.capacity)}`)}
                ${cell('Opps', d.calls ? `${d.opps} · ${oppPct}%` : '—', oppPct >= 30 || !d.calls ? '#15803D' : '#B91C1C')}
                ${cell('Installs', d.installs)}
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>`
}

function cell(label, value, color) {
  return `<td width="25%" align="center" style="padding:6px 2px;">
    <div style="font-size:15px;font-weight:700;color:${color || '#111827'};line-height:1.2;">${esc(value)}</div>
    <div style="font-size:9px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.5px;padding-top:2px;">${esc(label)}</div>
  </td>`
}

export function renderBoardEmail(data, opts = {}) {
  const { board = [], dates = [], target = 80, generatedAt } = data || {}
  const appUrl = opts.appUrl || 'https://andi.awesomeservice.com'

  // Lead with what needs action — leadership shouldn't have to add it up.
  const gaps = []
  board.forEach(row => (row.days || []).forEach((d, i) => {
    if (d.needed > 0) gaps.push({ trade: row.trade, day: i, needed: d.needed })
  }))
  const totalNeeded = gaps.reduce((a, g) => a + g.needed, 0)
  const todayGaps = gaps.filter(g => g.day === 0).reduce((a, g) => a + g.needed, 0)

  const summary = totalNeeded === 0
    ? `<span style="color:#15803D;font-weight:700;">All trades at or above target across the next three days.</span>`
    : `<strong style="color:#111827;">${totalNeeded}</strong> call${totalNeeded === 1 ? '' : 's'} needed across the next three days` +
      (todayGaps > 0 ? ` · <strong style="color:#B91C1C;">${todayGaps} today</strong>` : '')

  const daySections = dates.map((date, i) => `
    <tr>
      <td style="padding:0 0 6px 0;">
        <div style="font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.8px;padding:14px 0 8px 0;">
          ${esc(fmtDay(date, i))}
        </div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          ${board.map(row => tradeRow(row.trade, (row.days || [])[i] || {})).join('')}
        </table>
      </td>
    </tr>`).join('')

  const stamp = generatedAt
    ? new Date(generatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>3-Day Call Board</title></head>
<body style="margin:0;padding:0;background:#F5F5F3;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(totalNeeded === 0 ? 'All trades on target' : `${totalNeeded} calls needed over 3 days`)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F5F5F3;">
  <tr><td align="center" style="padding:20px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"
           style="width:100%;max-width:600px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

      <tr><td style="padding:0 0 14px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
               style="background:#123A5C;border-radius:10px;">
          <tr><td style="padding:20px 22px;">
            <div style="font-size:19px;font-weight:800;color:#FFFFFF;letter-spacing:-.3px;">3-Day Call Board</div>
            <div style="font-size:12px;color:#A8C4DC;padding-top:3px;">Repair &amp; replacement capacity · target ${target}%</div>
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:0 0 4px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
               style="background:#FFFFFF;border:1px solid #E5E7EB;border-radius:8px;">
          <tr><td style="padding:14px 16px;font-size:14px;color:#374151;line-height:1.5;">${summary}</td></tr>
        </table>
      </td></tr>

      ${daySections}

      <tr><td style="padding:16px 0 0 0;" align="center">
        <a href="${esc(appUrl)}/callboard"
           style="display:inline-block;background:#123A5C;color:#FFFFFF;text-decoration:none;font-size:13px;font-weight:600;padding:11px 22px;border-radius:7px;">
          Open the live board
        </a>
      </td></tr>

      <tr><td style="padding:16px 4px 0 4px;">
        <div style="font-size:10px;color:#9CA3AF;line-height:1.6;text-align:center;">
          Capacity counts only technicians with a working shift, and subtracts those consumed by installs.<br>
          Generated ${esc(stamp)} · live from ServiceTitan
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`
}

export function boardEmailSubject(data) {
  const board = (data && data.board) || []
  let needed = 0, todayNeeded = 0
  board.forEach(row => (row.days || []).forEach((d, i) => {
    if (d.needed > 0) { needed += d.needed; if (i === 0) todayNeeded += d.needed }
  }))
  const day = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (needed === 0) return `3-Day Call Board · ${day} · all trades on target`
  if (todayNeeded > 0) return `3-Day Call Board · ${day} · ${todayNeeded} calls needed today`
  return `3-Day Call Board · ${day} · ${needed} calls needed`
}
