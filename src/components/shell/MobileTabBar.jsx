import { Icon } from './icons'
import { pathMatches } from './nav'

// Phone tab bar (redesign stage 1): up to four hubs for this role plus More
// (the full menu). items: [{ to, label, icon, match: [paths] }].
export default function MobileTabBar({ items, pathname, onNavigate, onMore }) {
  return (
    <nav aria-label="Main" className="tabbar">
      {items.map(it => {
        const on = (it.match || [it.to]).some(p => pathMatches(p, pathname))
        return (
          <a key={it.to} href={it.to} aria-current={on ? 'page' : undefined} className="tabbar-item"
            onClick={(e) => { e.preventDefault(); onNavigate(it.to) }}>
            <Icon name={it.icon} size={21} strokeWidth={on ? 2.1 : 1.8} />
            <span>{it.label}</span>
          </a>
        )
      })}
      <button type="button" className="tabbar-item" onClick={onMore}>
        <Icon name="menu" size={21} />
        <span>More</span>
      </button>
    </nav>
  )
}
