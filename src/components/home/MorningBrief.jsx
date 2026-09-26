import { eyebrow, panel } from '../ui'
import { Icon } from '../shell/icons'

// The morning brief (lib/homeBrief.js): yesterday + today for this Home's
// scope, written once each morning and saved. `morning` is the server's
// { date, briefs: { [key]: brief }, pending: [key] }.

const weekday = (ymd) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) : '')

// One labeled line: "Yesterday  HVAC $81k sold · Plumbing close 84%".
function Line({ label, items, tone }) {
  if (!items?.length) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '74px minmax(0, 1fr)', gap: 10, alignItems: 'baseline', fontSize: 13.5, lineHeight: 1.45 }}>
      <span style={{ ...eyebrow, color: tone || eyebrow.color }}>{label}</span>
      <span style={{ color: 'var(--text-secondary)' }}>
        {items.map((t, i) => <span key={i}>{i > 0 && <span style={{ color: 'var(--text-muted)', margin: '0 7px' }}>·</span>}{t}</span>)}
      </span>
    </div>
  )
}

export function briefFor(morning, key) {
  if (!morning || !key) return { brief: null, pending: false }
  return { brief: morning.briefs?.[key] || null, pending: (morning.pending || []).includes(key) }
}

// Yesterday / Today / Coach — three short lines under the headline.
export function BriefBody({ brief, coachTo, onGo }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Line label="Yesterday" items={brief.yesterday} />
      <Line label="Today" items={brief.today} tone="var(--accent)" />
      {brief.coach?.who && (
        <div style={{ display: 'grid', gridTemplateColumns: '74px minmax(0, 1fr)', gap: 10, alignItems: 'baseline', fontSize: 13.5, lineHeight: 1.45 }}>
          <span style={{ ...eyebrow }}>Coach</span>
          <span>
            <b style={{ fontWeight: 600 }}>{brief.coach.who}</b>{brief.coach.focus ? <span style={{ color: 'var(--text-secondary)' }}> — {brief.coach.focus}</span> : null}
            {coachTo && <a href={coachTo} onClick={(e) => { e.preventDefault(); onGo(coachTo) }} style={{ marginLeft: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}>Coaching →</a>}
          </span>
        </div>
      )}
    </div>
  )
}

// A standalone panel — or, with `bare`, just its content for another panel
// (the manager Home puts it in the right half of its header).
export default function MorningBrief({ morning, scopeKey, coachTo, onGo, isMobile, bare }) {
  const { brief, pending } = briefFor(morning, scopeKey)
  if (!brief && !pending) return null
  const Wrap = bare ? 'div' : 'section'
  return (
    <Wrap style={bare ? { display: 'flex', flexDirection: 'column', gap: 9 } : { ...panel, borderRadius: 18, padding: isMobile ? '14px 16px' : '16px 20px', display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ ...eyebrow, display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon name="sun" size={13} style={{ color: 'var(--signal)' }} />
        Morning brief{morning?.date ? ` · ${weekday(morning.date)}’s results` : ''}
      </div>
      {brief ? (
        <>
          <h3 className="disp" style={{ margin: 0, fontSize: isMobile ? 19 : 21, lineHeight: 1.2, fontWeight: 700, letterSpacing: '-.02em', textWrap: 'balance' }}>{brief.headline}</h3>
          <BriefBody brief={brief} coachTo={coachTo} onGo={onGo} />
        </>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Writing this morning’s brief from yesterday’s numbers — it’ll be here in a minute or two.</div>
      )}
    </Wrap>
  )
}
