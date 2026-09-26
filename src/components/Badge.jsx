import { STATUS_COLORS } from '../lib/constants'

// Contact-status badge. Statuses map onto the theme's tone palette so the
// chip reads in dark mode too (STATUS_COLORS are light-only pastels); any
// status without a tone keeps its STATUS_COLORS fallback.
const TONES = {
  'Pending': 'blue', 'Rescheduled': 'blue', 'Question / Info': 'blue',
  'Canceled Appt': 'amber', 'Not Booked - Price': 'amber', 'No Answer': 'amber',
  'Voicemail': 'purple', 'Max Attempts': 'purple',
  'Booked': 'green',
  'Not Interested': 'red', 'DNC': 'red',
  'Wrong Number': 'gray', 'Bad Data': 'gray',
}

export default function Badge({ status, style }) {
  const label = status || 'Pending'
  const tone = TONES[label]
  const sc = STATUS_COLORS[label] || STATUS_COLORS['Pending']
  return (
    <span className="badge" style={tone
      ? { background: `var(--tone-${tone}-bg)`, color: `var(--tone-${tone}-tx)`, border: `1px solid var(--tone-${tone}-bd)`, ...style }
      : { background: sc.bg, color: sc.color, ...style }}>
      {label}
    </span>
  )
}
