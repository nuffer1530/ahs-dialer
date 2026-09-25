import { useMemo, useState } from 'react'
import { Segmented, Ring } from './ui'

// Moved to the shared kit (ui.jsx); re-exported so existing imports keep working.
export { Segmented, Ring }

// Team → Coaching. A team panel (QA, where points are lost, section balance)
// over one card per CSR. The numbers — QA, weekly trend, section scores,
// biggest gaps, month-over-month change — come fresh from
// /api/admin/csr-coaching on every load; the coach notes and drill are the
// cached AI write-up. Deactivated reps never reach this component.

export const scoreTone = (p) => p == null ? 'gray' : p >= 90 ? 'green' : p >= 75 ? 'amber' : 'red'
export const monthShort = (ym) => (ym ? new Date(`${ym}-15T12:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) : '')
const initials = (n) => String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()
export const sectionShort = (name) => (/soft/i.test(name) ? 'Soft skills' : /accura|procedure/i.test(name) ? 'Procedure' : name)
// Rubric names carry their points ("Offered in-house plan (5 pts)") — noise on
// a card, and it was clipping the useful part of the name.
export const critName = (s) => String(s || '').replace(/\s*\(\s*\d+(\.\d+)?\s*pts?\s*\)\s*$/i, '')
const num = { fontVariantNumeric: 'tabular-nums' }
const eyebrow = { fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)' }

// Weekly QA across the month — line, soft area, emphasized latest week.
function Spark({ points, width = 84, height = 26 }) {
  const all = points || []
  const pts = all.map((v, i) => [i, v]).filter(([, v]) => v != null)
  if (pts.length < 2) return null
  const vals = pts.map(([, v]) => v)
  const lo = Math.min(...vals) - 4
  const hi = Math.max(...vals) + 4
  const x = (i) => 3 + (i / Math.max(1, all.length - 1)) * (width - 6)
  const y = (v) => 3 + (1 - (v - lo) / (hi - lo)) * (height - 6)
  const line = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const [li, lv] = pts[pts.length - 1]
  const t = scoreTone(lv)
  return (
    <svg width={width} height={height} style={{ display: 'block' }} role="img" aria-label={`QA by week: ${vals.join(', ')}`}>
      <path d={`${line} L${x(li).toFixed(1)},${height} L${x(pts[0][0]).toFixed(1)},${height} Z`} fill={`var(--tone-${t}-bg)`} />
      <path d={line} fill="none" stroke={`var(--tone-${t}-tx)`} strokeOpacity=".55" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(li)} cy={y(lv)} r="2.8" fill={`var(--tone-${t}-tx)`} />
    </svg>
  )
}

function Delta({ now, prev, vs }) {
  if (now == null || prev == null) return null
  const d = now - prev
  const t = d > 0 ? 'green' : d < 0 ? 'red' : 'gray'
  return (
    <span title={`${prev}% in ${vs}`} style={{ ...num, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', borderRadius: 99, padding: '1px 7px',
      color: `var(--tone-${t}-tx)`, background: `var(--tone-${t}-bg)`, border: `1px solid var(--tone-${t}-bd)` }}>
      {d > 0 ? `▲ +${d}` : d < 0 ? `▼ −${-d}` : '= 0'} vs {vs}
    </span>
  )
}

function Chip({ children }) {
  return (
    <span style={{ fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap', borderRadius: 99, padding: '1px 7px',
      color: 'var(--tone-gray-tx)', background: 'var(--tone-gray-bg)', border: '1px solid var(--tone-gray-bd)' }}>
      {children}
    </span>
  )
}

function Bar({ pct, t, height = 6 }) {
  return (
    <div style={{ height, borderRadius: 99, background: 'var(--surface-2)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(2, Math.min(100, pct))}%`, height: '100%', borderRadius: 99, background: `var(--tone-${t}-tx)` }} />
    </div>
  )
}

function Meter({ label, pct }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 5 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <b style={{ ...num, color: 'var(--text-primary)' }}>{pct}%</b>
      </div>
      <Bar pct={pct} t={scoreTone(pct)} />
    </div>
  )
}

const missTone = (rate) => (rate >= 50 ? 'red' : rate >= 25 ? 'amber' : 'gray')

function GapRow({ g }) {
  const missRate = Math.round((g.missedOn / Math.max(1, g.of)) * 100)
  return (
    <div className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 76px 58px', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
      <span title={g.criterion} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>{critName(g.criterion)}</span>
      <Bar pct={missRate} t={missTone(missRate)} />
      <span style={{ ...num, textAlign: 'right', color: 'var(--text-secondary)' }}>{g.missedOn}/{g.of}</span>
    </div>
  )
}

const CheckIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
)
const ArrowIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
)
const TargetIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.8" fill="currentColor" /></svg>
)

function Note({ kind, children }) {
  const t = kind === 'good' ? 'green' : 'amber'
  return (
    <li style={{ display: 'flex', gap: 9, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-primary)' }}>
      <span style={{ flexShrink: 0, width: 18, height: 18, marginTop: 1, borderRadius: 99, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: `var(--tone-${t}-bg)`, color: `var(--tone-${t}-tx)`, border: `1px solid var(--tone-${t}-bd)` }}>
        {kind === 'good' ? <CheckIcon /> : <ArrowIcon />}
      </span>
      <span>{children}</span>
    </li>
  )
}

function CsrCard({ c, vs, onOpen }) {
  const t = scoreTone(c.qa)
  const open = () => onOpen(c)
  const notes = [...(c.working || []).map(w => ['good', w]), ...(c.coach || []).map(w => ['coach', w])]
  return (
    <div className="coach-card" role="button" tabIndex={0} onClick={open} title="Open this CSR's evaluations, lowest scores first"
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '16px 18px 14px',
        display: 'flex', flexDirection: 'column', gap: 15, cursor: 'pointer', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Ring pct={c.qa} size={48} stroke={4}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '.02em' }}>{initials(c.name)}</span>
        </Ring>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
            <span style={num}>{c.evals} call{c.evals === 1 ? '' : 's'}</span>
            <Delta now={c.qa} prev={c.prevQa} vs={vs} />
            {c.evals < 10 && <Chip>Small sample</Chip>}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <div style={{ ...num, fontSize: 28, fontWeight: 800, lineHeight: 1, letterSpacing: '-.02em', color: `var(--tone-${t}-tx)` }}>
            {c.qa}<span style={{ fontSize: 15, fontWeight: 700 }}>%</span>
          </div>
          <Spark points={c.trend} />
        </div>
      </div>

      {c.sections?.length > 0 && (
        <div className="mgrid" style={{ display: 'grid', gridTemplateColumns: `repeat(${c.sections.length}, minmax(0, 1fr))`, gap: 16 }}>
          {c.sections.map(s => <Meter key={s.name} label={sectionShort(s.name)} pct={s.rate} />)}
        </div>
      )}

      {c.gaps?.length > 0 && (
        <div>
          <div style={{ ...eyebrow, display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span>Biggest gaps</span><span>Missed</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {c.gaps.map(g => <GapRow key={g.criterion} g={g} />)}
          </div>
        </div>
      )}

      {notes.length > 0 && (
        <div>
          <div style={{ ...eyebrow, marginBottom: 8 }}>Coach notes</div>
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 7 }}>
            {notes.map(([k, text], i) => <Note key={i} kind={k}>{text}</Note>)}
          </ul>
        </div>
      )}

      {/* Cards share a row height; the drill and the link sit on the bottom
          edge so they line up across the grid. */}
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 15 }}>
        {c.drill && (
          <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ ...eyebrow, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, color: 'var(--accent)' }}>
              <TargetIcon /> Drill for the next 1:1
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-primary)' }}>{c.drill}</div>
          </div>
        )}
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
          Open {c.evals} evaluation{c.evals === 1 ? '' : 's'} →
        </div>
      </div>
    </div>
  )
}

function TeamPanel({ team, generatedAt, busy, onRegenerate, onPrint, isMobile }) {
  const vs = monthShort(team.prevMonth)
  const divider = isMobile ? { borderTop: '1px solid var(--border)' } : { borderLeft: '1px solid var(--border)' }
  const written = generatedAt ? new Date(generatedAt).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, marginBottom: 18, display: 'grid',
      gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(270px, 300px) minmax(0, 1fr) minmax(240px, 290px)' }}>
      <div style={{ padding: '20px 22px', display: 'flex', alignItems: 'center', gap: 18 }}>
        <Ring pct={team.qa} size={92} stroke={8}>
          <div style={{ ...num, fontSize: 24, fontWeight: 800, letterSpacing: '-.02em', color: `var(--tone-${scoreTone(team.qa)}-tx)` }}>
            {team.qa ?? '—'}<span style={{ fontSize: 13 }}>%</span>
          </div>
        </Ring>
        <div style={{ minWidth: 0 }}>
          <div style={eyebrow}>Team QA</div>
          <div style={{ ...num, fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 8px', whiteSpace: 'nowrap' }}>
            {team.evals} calls · {team.csrs} CSR{team.csrs === 1 ? '' : 's'}
          </div>
          <Delta now={team.qa} prev={team.prevQa} vs={vs} />
        </div>
      </div>

      <div style={{ padding: '18px 22px', minWidth: 0, ...divider }}>
        <div style={{ ...eyebrow, marginBottom: 12 }}>Where the team loses the most points</div>
        {team.focus?.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            {team.focus.map(f => {
              const missRate = Math.round((f.missedOn / Math.max(1, f.of)) * 100)
              return (
                <div key={f.criterion} className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(70px, 150px) 88px', gap: 14, alignItems: 'center' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.criterion}>{critName(f.criterion)}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {f.csrs ? `A top gap for ${f.csrs} of ${team.csrs} CSRs` : sectionShort(f.section || '')}
                    </div>
                  </div>
                  <Bar pct={missRate} t={missTone(missRate)} height={7} />
                  <div style={{ ...num, fontSize: 12, textAlign: 'right', color: 'var(--text-secondary)' }}>
                    <b style={{ color: 'var(--text-primary)' }}>{missRate}%</b> missed
                  </div>
                </div>
              )
            })}
          </div>
        ) : <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No misses to show yet.</div>}
      </div>

      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, ...divider }}>
        <div style={eyebrow}>By section</div>
        {(team.sections || []).map(s => <Meter key={s.name} label={sectionShort(s.name)} pct={s.rate} />)}
        <div style={{ marginTop: 'auto', paddingTop: 4, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {busy ? 'Writing new coach notes…' : written ? `Coach notes written ${written}` : ''}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn sm" disabled={busy} onClick={onRegenerate}>Regenerate notes</button>
            <button className="btn sm" onClick={onPrint}>Print</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SkeletonGrid() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div className="skel" style={{ width: 48, height: 48, borderRadius: 99 }} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div className="skel" style={{ height: 13, width: '55%' }} /><div className="skel" style={{ height: 10, width: '35%' }} />
            </div>
          </div>
          <div className="skel" style={{ height: 8 }} /><div className="skel" style={{ height: 8, width: '80%' }} />
          <div className="skel" style={{ height: 54 }} />
        </div>
      ))}
    </div>
  )
}

const SORTS = [['qa', 'Top QA'], ['coach', 'Needs coaching'], ['calls', 'Most calls']]

export default function CoachingSnapshots({ snap, busy, error, search, isMobile, onRegenerate, onPrint, onOpen }) {
  const [sort, setSort] = useState('qa')
  const cards = useMemo(() => {
    const q = String(search || '').trim().toLowerCase()
    const list = (snap?.cards || []).filter(c => !q || String(c.name).toLowerCase().includes(q))
    return [...list].sort((a, b) =>
      sort === 'calls' ? b.evals - a.evals
      // Needs coaching: lowest QA first, but thin samples (under 5 calls) last
      // so one bad call doesn't top the list.
      : sort === 'coach' ? ((a.evals < 5) - (b.evals < 5)) || a.qa - b.qa
      : b.qa - a.qa)
  }, [snap, search, sort])

  if (!snap) {
    return error
      ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--danger)', fontSize: 13 }}>Couldn’t load coaching: {error}</div>
      : <><div className="skel" style={{ height: 132, borderRadius: 16, marginBottom: 18 }} /><SkeletonGrid /></>
  }
  if (!snap.cards?.length) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No evaluated calls this month yet.</div>
  }
  const vs = monthShort(snap.team?.prevMonth)
  return (
    <div>
      {snap.team && <TeamPanel team={snap.team} generatedAt={snap.generatedAt} busy={busy} onRegenerate={onRegenerate} onPrint={onPrint} isMobile={isMobile} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          {cards.length} CSR{cards.length === 1 ? '' : 's'}
          <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · click a card to open their evaluations</span>
        </div>
        <div style={{ marginLeft: isMobile ? 0 : 'auto', width: isMobile ? '100%' : undefined }}>
          <Segmented value={sort} onChange={setSort} options={SORTS} fill={isMobile} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16, gridAutoRows: isMobile ? undefined : '1fr' }}>
        {cards.map(c => <CsrCard key={c.profileId || c.name} c={c} vs={vs} onOpen={onOpen} />)}
      </div>
    </div>
  )
}
