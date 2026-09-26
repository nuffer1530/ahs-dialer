import { Icon, PulseMark } from './icons'
import { pathMatches } from './nav'

// The page header (redesign stage 1): the hub's name and its tabs — the
// pages that used to be separate sidebar items (Live · Analytics ·
// Recordings under Calls, 3-Day Board · Dispatch under Dispatch…).
export default function TopBar({ title, tabs = [], pathname, onNavigate, isMobile, onOpenPalette, onOpenMenu, right }) {
  const tabRow = tabs.length > 1 && (
    <div role="tablist" aria-label={`${title} pages`} className="hub-tabs" style={isMobile ? { padding: '0 12px 10px', overflowX: 'auto' } : undefined}>
      {tabs.map(t => {
        const on = pathMatches(t.to, pathname, t.end)
        return (
          <a key={t.to} href={t.to} role="tab" aria-selected={on} aria-current={on ? 'page' : undefined} className="hub-tab"
            onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); onNavigate(t.to) }}>
            {t.label}
          </a>
        )
      })}
    </div>
  )

  if (isMobile) {
    return (
      <header className="topbar" style={{ flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' }}>
          <button type="button" className="topbar-icon" onClick={onOpenMenu} aria-label="Open menu">
            <PulseMark size={20} />
          </button>
          <h1 className="disp" style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 19, fontWeight: 700, letterSpacing: '-.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h1>
          <button type="button" className="topbar-icon" onClick={onOpenPalette} aria-label="Search or jump to">
            <Icon name="search" size={18} />
          </button>
        </div>
        {tabRow}
      </header>
    )
  }

  return (
    <header className="topbar" style={{ height: 60, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 18, padding: '0 24px' }}>
      <h1 className="disp" style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-.015em', whiteSpace: 'nowrap' }}>{title}</h1>
      {tabRow}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'flex-end', overflow: 'hidden' }}>{right}</div>
    </header>
  )
}
