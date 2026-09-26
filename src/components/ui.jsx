import { Children } from 'react'

// Andi's shared UI kit — the look introduced on Team → Coaching (Sep 2026):
// 16px rounded panels, small uppercase "eyebrow" labels, tone chips, score
// rings, pill toggles, and summary panels split into zones. New and restyled
// pages build from these instead of re-deriving the styles inline, so the
// whole app stays one visual language. Colors come only from the theme
// tokens in index.css (tone-* for status), so light and dark both work.

export const num = { fontVariantNumeric: 'tabular-nums' }
// Headline numbers (redesign, Sep 2026): Geist Mono, tabular.
export const mono = { fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', letterSpacing: '-.01em' }
export const eyebrow = { fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)' }
export const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16 }

// Pill-style segmented control for in-page choices (sort, view, range).
export function Segmented({ value, onChange, options, fill }) {
  return (
    <div role="tablist" style={{ display: 'flex', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 99, padding: 3, gap: 2 }}>
      {options.map(([k, label]) => {
        const on = value === k
        return (
          <button key={k} role="tab" aria-selected={on} onClick={() => onChange(k)}
            style={{ flex: fill ? 1 : undefined, border: 'none', cursor: 'pointer', borderRadius: 99, padding: '6px 14px', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
              background: on ? 'var(--surface)' : 'transparent', color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
              boxShadow: on ? '0 1px 3px rgba(15,20,40,.14)' : 'none', transition: 'background .12s, color .12s' }}>
            {label}
          </button>
        )
      })}
    </div>
  )
}

// Page-level tabs (the row under a page's header). tabs: [[id, label, badge?]].
export function PageTabs({ tabs, value, onChange }) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: 4, overflowX: 'auto', padding: '8px 0' }}>
      {tabs.map(([id, label, badge]) => {
        const on = value === id
        return (
          <button key={id} role="tab" aria-selected={on} onClick={() => onChange(id)} className="page-tab"
            style={{ border: 'none', borderRadius: 99, padding: '7px 14px', fontSize: 13, fontWeight: on ? 700 : 500, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', gap: 7,
              background: on ? 'var(--accent-bg)' : 'transparent', color: on ? 'var(--accent-text)' : 'var(--text-secondary)' }}>
            {label}
            {badge != null && badge !== 0 && (
              <span style={{ ...num, fontSize: 10.5, fontWeight: 800, borderRadius: 99, padding: '0 7px', lineHeight: '17px',
                background: on ? 'var(--accent)' : 'var(--surface-2)', color: on ? '#fff' : 'var(--text-secondary)' }}>{badge}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ‹ label › — month / week navigation.
export function PillNav({ label, onPrev, onNext, prevDisabled, nextDisabled, minWidth = 128 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 99, padding: 3 }}>
      <button className="btn ghost sm" aria-label="Previous" disabled={prevDisabled} onClick={onPrev} style={{ borderRadius: 99, padding: '4px 11px' }}>‹</button>
      <span style={{ ...num, fontSize: 13, fontWeight: 700, minWidth, textAlign: 'center', whiteSpace: 'nowrap', padding: '0 4px' }}>{label}</span>
      <button className="btn ghost sm" aria-label="Next" disabled={nextDisabled} onClick={onNext} style={{ borderRadius: 99, padding: '4px 11px' }}>›</button>
    </div>
  )
}

// Progress ring. `tone` picks the status color; children sit in the middle.
export function Ring({ pct, size, stroke, children, tone }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, Number(pct) || 0))
  const t = tone || (v >= 90 ? 'green' : v >= 75 ? 'amber' : 'red')
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', display: 'block' }} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`var(--tone-${t}-tx)`} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={`${(c * v) / 100} ${c}`} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{children}</div>
    </div>
  )
}

export function ToneChip({ tone = 'gray', children, small, title }) {
  return (
    <span title={title} style={{ ...num, fontSize: small ? 10.5 : 11.5, fontWeight: 700, whiteSpace: 'nowrap', borderRadius: 99, padding: small ? '1px 7px' : '2px 9px',
      color: `var(--tone-${tone}-tx)`, background: `var(--tone-${tone}-bg)`, border: `1px solid var(--tone-${tone}-bd)` }}>
      {children}
    </span>
  )
}

export function Bar({ pct, tone = 'blue', height = 6 }) {
  return (
    <div style={{ height, borderRadius: 99, background: 'var(--surface-2)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(pct > 0 ? 2 : 0, Math.min(100, pct || 0))}%`, height: '100%', borderRadius: 99, background: `var(--tone-${tone}-tx)` }} />
    </div>
  )
}

// A panel split into zones with hairline dividers (stacks on a phone).
export function SummaryPanel({ children, columns, isMobile, style }) {
  const zones = Children.toArray(children).filter(Boolean)
  return (
    <div style={{ ...panel, marginBottom: 16, display: 'grid', ...style,
      gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : (columns || `repeat(${zones.length}, minmax(0, 1fr))`) }}>
      {zones.map((z, i) => (
        <div key={i} style={{ padding: '18px 22px', minWidth: 0,
          ...(i ? (isMobile ? { borderTop: '1px solid var(--border)' } : { borderLeft: '1px solid var(--border)' }) : {}) }}>
          {z}
        </div>
      ))}
    </div>
  )
}

// A labeled number for summary zones.
export function Stat({ label, value, sub, tone, big }) {
  return (
    <div>
      <div style={eyebrow}>{label}</div>
      <div style={{ ...mono, fontSize: big ? 32 : 26, fontWeight: 600, letterSpacing: '-.03em', lineHeight: 1.1, marginTop: 6,
        color: tone ? `var(--tone-${tone}-tx)` : 'var(--text-primary)' }}>{value}</div>
      {sub && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

export function EmptyState({ children }) {
  return (
    <div style={{ ...panel, padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>{children}</div>
  )
}

// Initials/emoji/photo in a circle — photo fills, text sits on surface-2.
export function Face({ avatar, name, size = 32 }) {
  const photo = typeof avatar === 'string' && /^(data:|https?:|\/)/.test(avatar)
  const txt = avatar && !photo ? avatar : String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()
  return (
    <div style={{ width: size, height: size, borderRadius: 99, flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: photo ? 'transparent' : 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
      fontSize: avatar && !photo ? size * 0.55 : size * 0.36, fontWeight: 700 }}>
      {photo ? <img src={avatar} alt="" draggable="false" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : txt}
    </div>
  )
}
