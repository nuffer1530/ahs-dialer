import { useEffect, useRef, useState } from 'react'
import { Icon, PulseMark } from './icons'
import { pathMatches } from './nav'
import Avatar from '../Avatar'

// The app's left rail (redesign stage 1): hubs, the TV-boards launcher,
// Settings and your avatar menu. Pure presentation — DialerLayout owns the
// state and passes it in. `drawer` renders it as the phone's slide-over.

// Fixed-position popover anchored to a button, so it escapes the rail's
// overflow:hidden (the old status popup got clipped when collapsed).
function usePopover() {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const popRef = useRef(null)
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      const left = Math.min(r.right + 10, window.innerWidth - 272)
      setPos({ left: Math.max(8, left), bottom: Math.max(8, window.innerHeight - r.bottom) })
    }
    setOpen(v => !v)
  }
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  return { open, setOpen, pos, toggle, btnRef, popRef }
}

function RailLink({ to, label, icon, active, collapsed, badge, dot, onNavigate, trailing }) {
  return (
    <a href={to} className="rail-link" aria-current={active ? 'page' : undefined} title={collapsed ? label : undefined}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); onNavigate(to) }}>
      <span style={{ position: 'relative', display: 'flex' }}>
        <Icon name={icon} />
        {collapsed && (badge > 0 || dot) && <span className="rail-dot" />}
      </span>
      {!collapsed && <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>}
      {!collapsed && badge > 0 && <span className="rail-badge">{badge}</span>}
      {!collapsed && !badge && active && <span className="rail-active-dot" />}
      {!collapsed && trailing}
    </a>
  )
}

export default function Sidebar({
  hubs, pathname, collapsed, onToggleCollapse, drawer, badges = {},
  profile, roleText, statusColor, tvBoards, meLinks, ptoApprovals, alerts = [],
  onNavigate, onOpenPalette, darkMode, onToggleTheme, onSignOut, onViewAs,
  // Phones have no dock, so the drawer's menu carries the status picker.
  statusOptions, currentStatus, onSetStatus,
}) {
  const tv = usePopover()
  const me = usePopover()
  const narrow = collapsed && !drawer
  const go = (to) => { tv.setOpen(false); me.setOpen(false); onNavigate(to) }
  const onTv = pathname === '/warroom' || pathname.startsWith('/tv/')

  return (
    <nav aria-label="Main" className={`rail${narrow ? ' collapsed' : ''}`}
      style={{ width: drawer ? 280 : narrow ? 72 : 236, height: '100%', display: 'flex', flexDirection: 'column', gap: 16, padding: narrow ? '18px 0 14px' : '18px 12px 14px', boxSizing: 'border-box', overflow: 'hidden' }}>

      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: narrow ? 0 : '0 6px', justifyContent: narrow ? 'center' : 'flex-start' }}>
        <span className="rail-logo"><PulseMark size={22} /></span>
        {!narrow && (
          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1, minWidth: 0, flex: 1 }}>
            <span className="disp" style={{ fontSize: 21, fontWeight: 700, color: '#fff', letterSpacing: '-.02em' }}>andi</span>
            <span style={{ fontSize: 11, color: 'var(--rail-muted)', whiteSpace: 'nowrap' }}>Awesome Home Services</span>
          </span>
        )}
        {!drawer && !narrow && (
          <button type="button" className="rail-icon-btn" onClick={onToggleCollapse} aria-label="Collapse sidebar" title="Collapse sidebar">
            <Icon name="chevronsLeft" size={16} />
          </button>
        )}
      </div>

      {/* Search */}
      {narrow ? (
        <button type="button" className="rail-icon-btn" style={{ margin: '0 auto', width: 44, height: 40 }} onClick={onOpenPalette} aria-label="Search or jump to (⌘K)" title="Search or jump to (⌘K)">
          <Icon name="search" size={17} />
        </button>
      ) : (
        <button type="button" className="rail-search" onClick={onOpenPalette}>
          <Icon name="search" size={15} />
          <span style={{ flex: 1, textAlign: 'left' }}>Search or jump to…</span>
          <span className="mono rail-kbd">⌘K</span>
        </button>
      )}

      {/* Hubs */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto', minHeight: 0, flex: 1 }}>
        {hubs.map(h => {
          const active = h.tabs.some(t => pathMatches(t.to, pathname, t.end))
          return (
            <RailLink key={h.id} to={h.tabs[0].to} label={h.label} icon={h.icon} active={active} collapsed={narrow}
              badge={badges[h.id] || 0} onNavigate={go} />
          )
        })}

        {alerts.length > 0 && (
          <a href="/attendance" className="rail-alert" title={alerts.map(a => `${a.name}: ${a.elapsed}m on ${a.status}`).join('\n')}
            onClick={(e) => { e.preventDefault(); go('/attendance') }}>
            <Icon name="alert" size={15} />
            {!narrow && <span>{alerts.length} break overrun{alerts.length > 1 ? 's' : ''}</span>}
          </a>
        )}

        <div style={{ height: 1, background: 'var(--rail-line)', margin: narrow ? '10px 14px' : '10px 6px' }} />

        {tvBoards.length > 0 && (
          <button type="button" ref={tv.btnRef} className="rail-link" aria-current={onTv ? 'page' : undefined} aria-expanded={tv.open}
            onClick={tv.toggle} title={narrow ? 'TV boards' : undefined}>
            <Icon name="tv" />
            {!narrow && <span style={{ flex: 1, textAlign: 'left' }}>TV boards</span>}
            {!narrow && <Icon name="arrowUpRight" size={14} style={{ color: 'var(--rail-muted)' }} />}
          </button>
        )}
        <RailLink to="/settings" label="Settings" icon="settings" active={pathMatches('/settings', pathname)} collapsed={narrow} onNavigate={go} />
      </div>

      {/* You */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {narrow && (
          <button type="button" className="rail-icon-btn" style={{ margin: '0 auto' }} onClick={onToggleCollapse} aria-label="Expand sidebar" title="Expand sidebar">
            <Icon name="chevronsRight" size={16} />
          </button>
        )}
        <button type="button" ref={me.btnRef} className="rail-me" onClick={me.toggle} aria-expanded={me.open}
          style={narrow ? { justifyContent: 'center', padding: 6 } : undefined} title={narrow ? (profile?.name || profile?.email) : undefined}>
          <span style={{ position: 'relative', width: 34, height: 34, borderRadius: 99, background: 'var(--rail-line)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0, overflow: 'visible' }}>
            <span style={{ width: 34, height: 34, borderRadius: 99, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Avatar avatar={profile?.avatar} name={profile?.name || profile?.email} />
            </span>
            {statusColor && <span style={{ position: 'absolute', right: -1, bottom: -1, width: 11, height: 11, borderRadius: 99, background: statusColor, border: '2px solid var(--rail-bg)' }} />}
            {narrow && ptoApprovals > 0 && <span className="rail-dot" style={{ top: -2, right: -2 }} />}
          </span>
          {!narrow && (
            <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0, flex: 1, textAlign: 'left' }}>
              <span style={{ fontSize: 13, color: '#fff', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile?.name || profile?.email}</span>
              <span style={{ fontSize: 11.5, color: 'var(--rail-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{roleText}</span>
            </span>
          )}
          {!narrow && ptoApprovals > 0 && <span className="rail-badge" title={`${ptoApprovals} time-off request${ptoApprovals === 1 ? '' : 's'} waiting on you`}>{ptoApprovals}</span>}
        </button>
      </div>

      {/* TV boards launcher */}
      {tv.open && tv.pos && (
        <div ref={tv.popRef} className="pop" role="menu" style={{ position: 'fixed', left: tv.pos.left, bottom: tv.pos.bottom, width: 250, zIndex: 9999, padding: '6px 0' }}>
          <div className="pop-label">Open a TV board</div>
          {tvBoards.map(b => (
            <a key={b.to} href={b.to} role="menuitem" className="pop-item" onClick={(e) => { e.preventDefault(); go(b.to) }}>
              <Icon name="tv" size={15} style={{ color: 'var(--text-muted)' }} />
              <span style={{ flex: 1 }}>{b.label}</span>
            </a>
          ))}
        </div>
      )}

      {/* You menu */}
      {me.open && me.pos && (
        <div ref={me.popRef} className="pop" role="menu" style={{ position: 'fixed', left: me.pos.left, bottom: me.pos.bottom, width: 250, zIndex: 9999, overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile?.name || profile?.email}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{roleText}</div>
          </div>
          {statusOptions?.length > 0 && (
            <div style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="pop-label">Set status</div>
              {statusOptions.map(s => (
                <button key={s.value} type="button" role="menuitemradio" aria-checked={s.value === currentStatus} className="pop-item" data-active={s.value === currentStatus}
                  onClick={() => { onSetStatus(s.value); me.setOpen(false) }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: s.color, flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{s.value}</span>
                  {s.value === currentStatus && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          )}
          <div style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            {meLinks.map(l => (
              <a key={l.to} href={l.to} role="menuitem" className="pop-item" onClick={(e) => { e.preventDefault(); go(l.to) }}>
                <span style={{ flex: 1 }}>{l.label}</span>
                {l.badgeKey === 'pto' && ptoApprovals > 0 && <span className="rail-badge">{ptoApprovals}</span>}
              </a>
            ))}
          </div>
          {/* Admins: see Andi as another person or role (read-only preview). */}
          {onViewAs && (
            <button type="button" role="menuitem" className="pop-item" onClick={() => { onViewAs(); me.setOpen(false) }}>
              <Icon name="user" size={15} style={{ color: 'var(--text-muted)' }} />
              <span style={{ flex: 1 }}>View as…</span>
            </button>
          )}
          <button type="button" role="menuitem" className="pop-item" onClick={() => { onToggleTheme(); me.setOpen(false) }}>
            <Icon name={darkMode ? 'sun' : 'moon'} size={15} style={{ color: 'var(--text-muted)' }} />
            <span style={{ flex: 1 }}>{darkMode ? 'Light mode' : 'Dark mode'}</span>
          </button>
          <button type="button" role="menuitem" className="pop-item pop-danger" onClick={onSignOut}>
            <Icon name="logout" size={15} />
            <span style={{ flex: 1 }}>Sign out</span>
          </button>
        </div>
      )}
    </nav>
  )
}
