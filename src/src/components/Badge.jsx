import { STATUS_COLORS } from '../lib/constants'

export default function Badge({ status, style }) {
  const sc = STATUS_COLORS[status] || STATUS_COLORS['Pending']
  return (
    <span className="badge" style={{ background: sc.bg, color: sc.color, ...style }}>
      {status || 'Pending'}
    </span>
  )
}
