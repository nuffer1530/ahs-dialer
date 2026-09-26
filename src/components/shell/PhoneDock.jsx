import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'

// The phone dock (redesign stage 1): your status and the phone, on every
// page, bottom-right beside Ask Andi. It replaces the sidebar status picker
// and the "You're Available — outbound is waiting" nudge. The call itself
// still happens on the Dialer — the dock takes you back to it.
const fmt = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export default function PhoneDock({
  showStatus, status, statusColor, statusSeconds, statusOptions = [], onSetStatus,
  onDialer, onOpenDialer, inCall, callSeconds, outboundWaiting, openLeads = 0, isOpsManager,
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  // What the orange button does right now.
  const action = inCall ? (onDialer ? null : { label: 'Back to your call', tone: 'live' })
    : !onDialer && outboundWaiting ? { label: 'Outbound is waiting', tone: 'signal' }
    : !onDialer && openLeads > 0 ? { label: `${openLeads} paid lead${openLeads === 1 ? '' : 's'} waiting`, tone: 'signal' }
    : !onDialer ? { label: isOpsManager ? 'Manual dial' : 'Open dialer', tone: 'quiet' }
    : null

  if (!showStatus && !action) return null

  return (
    <div ref={ref} role="region" aria-label="Phone" className="dock">
      {showStatus && (
        <button type="button" className="dock-status" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label={`Status: ${status}. Change status`}>
          <span style={{ width: 9, height: 9, borderRadius: 99, background: statusColor, boxShadow: /^#[0-9a-f]{6}$/i.test(statusColor || '') ? `0 0 0 3px ${statusColor}33` : 'none', flexShrink: 0 }} />
          <span style={{ fontWeight: 600 }}>{inCall ? 'On call' : status}</span>
          <span className="mono" style={{ color: 'var(--rail-muted)' }}>{fmt(inCall ? callSeconds : statusSeconds)}</span>
          <Icon name="chevronDown" size={14} style={{ color: 'var(--rail-muted)' }} />
        </button>
      )}
      {action && (
        <a href="/" className={`dock-action dock-${action.tone}`}
          onClick={(e) => { e.preventDefault(); setOpen(false); onOpenDialer() }}>
          <Icon name="phone" size={15} strokeWidth={2.2} />
          <span>{action.label}</span>
        </a>
      )}
      {open && (
        <div className="pop" role="menu" style={{ position: 'absolute', right: 0, bottom: 'calc(100% + 10px)', width: 220, padding: '6px 0', zIndex: 10 }}>
          <div className="pop-label">Set status</div>
          {statusOptions.map(s => (
            <button key={s.value} type="button" role="menuitemradio" aria-checked={s.value === status} className="pop-item" data-active={s.value === status}
              onClick={() => { onSetStatus(s.value); setOpen(false) }}>
              <span style={{ width: 9, height: 9, borderRadius: 99, background: s.color, flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{s.value}</span>
              {s.value === status && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
