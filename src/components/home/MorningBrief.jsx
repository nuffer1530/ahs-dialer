import { eyebrow, panel } from '../ui'
import { Icon } from '../shell/icons'

// The morning brief (lib/homeBrief.js): yesterday + today for this Home's
// scope, written once each morning and saved. `morning` is the server's
// { date, briefs: { [key]: brief }, pending: [key] }.

const weekday = (ymd) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) : '')

function List({ title, items }) {
  if (!items?.length) return null
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...eyebrow, marginBottom: 6 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 17, display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
        {items.map((t, i) => <li key={i}>{t}</li>)}
      </ul>
    </div>
  )
}

export function briefFor(morning, key) {
  if (!morning || !key) return { brief: null, pending: false }
  return { brief: morning.briefs?.[key] || null, pending: (morning.pending || []).includes(key) }
}

// The coach pick, as a dark card — the same treatment as the business Home's
// coaching focus.
export function CoachPick({ coach, to, onGo }) {
  if (!coach?.who) return null
  return (
    <div style={{ background: 'var(--rail-bg)', color: '#fff', border: '1px solid var(--rail-line)', borderRadius: 14, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: '#F2994A' }}>Coach first</div>
      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.35 }}>{coach.who}{coach.focus ? ` — ${coach.focus}` : ''}</div>
      {coach.why && <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--rail-text)' }}>{coach.why}</div>}
      {coach.drill && <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--rail-muted)' }}>Drill: {coach.drill}</div>}
      {to && <a href={to} onClick={(e) => { e.preventDefault(); onGo(to) }} style={{ alignSelf: 'flex-start', fontSize: 12.5, fontWeight: 700, color: '#F2994A', textDecoration: 'none' }}>Open coaching →</a>}
    </div>
  )
}

// Yesterday / Today lists (+ the coach pick) — inside a hero or on its own.
export function BriefBody({ brief, coachTo, onGo, isMobile }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : brief.coach?.who ? 'minmax(0, 1fr) minmax(0, 1fr) minmax(220px, 0.9fr)' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      <List title="Yesterday" items={brief.yesterday} />
      <List title="Today" items={brief.today} />
      {brief.coach?.who && <CoachPick coach={brief.coach} to={coachTo} onGo={onGo} />}
    </div>
  )
}

// A standalone panel (the manager Home puts it under the day's numbers).
export default function MorningBrief({ morning, scopeKey, coachTo, onGo, isMobile }) {
  const { brief, pending } = briefFor(morning, scopeKey)
  if (!brief && !pending) return null
  return (
    <section style={{ ...panel, borderRadius: 18, padding: isMobile ? '16px 18px' : '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ ...eyebrow, display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon name="sun" size={13} style={{ color: 'var(--signal)' }} />
        Morning brief{morning?.date ? ` · ${weekday(morning.date)}’s results` : ''}
      </div>
      {brief ? (
        <>
          <h3 className="disp" style={{ margin: 0, fontSize: isMobile ? 20 : 22, lineHeight: 1.2, fontWeight: 700, letterSpacing: '-.02em', textWrap: 'balance' }}>{brief.headline}</h3>
          <BriefBody brief={brief} coachTo={coachTo} onGo={onGo} isMobile={isMobile} />
        </>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Writing this morning’s brief from yesterday’s numbers — it’ll be here in a minute or two.</div>
      )}
    </section>
  )
}
