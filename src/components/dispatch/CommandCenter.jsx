import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { sb } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthContext'
import { usePhone } from '../../lib/PhoneContext'

// Dispatch Command Center — the board as a queue you clear.
// Every card is a proposal with a human-picked alternative and one primary
// verb that writes to ServiceTitan through /api/dispatch/act (Brandyn, Sep
// 12: no automation — admins/dispatchers click, it happens). The lanes on the
// right are the same day the queue is talking about; the drawer is where any
// call gets reassigned, moved, held, noted, texted, or called.

const TIER = {
  green:    { color:'var(--tone-green-tx)', bg:'var(--tone-green-bg)', border:'var(--tone-green-bd)', label:'Heavy Hitter' },
  yellow:   { color:'var(--tone-amber-tx)', bg:'var(--tone-amber-bg)', border:'var(--tone-amber-bd)', label:'In the Lineup' },
  red:      { color:'var(--tone-red-tx)',   bg:'var(--tone-red-bg)',   border:'var(--tone-red-bd)',   label:'On the Bench' },
  unranked: { color:'var(--tone-gray-tx)',  bg:'var(--tone-gray-bg)',  border:'var(--tone-gray-bd)',  label:'Rookie — no stats yet' },
}
const ST_JOB_URL = (jobId) => `https://go.servicetitan.com/#/Job/Index/${jobId}`
const money = (v) => (v == null ? '—' : `$${Math.round(Number(v)).toLocaleString()}`)
const hr = (iso) => {
  if (!iso) return null
  const d = new Date(iso); const h = d.getHours(), m = d.getMinutes()
  const ampm = h >= 12 ? 'PM' : 'AM'; const h12 = h % 12 === 0 ? 12 : h % 12
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ampm}` : `${h12} ${ampm}`
}
const windowLabel = (c) => { const a = hr(c.windowStart), b = hr(c.windowEnd); return !a ? 'Unscheduled' : b ? `${a}–${b}` : a }
const clock = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
const EYEBROW = { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, color: 'var(--text-secondary)' }
const MUTED = { fontSize: 12, color: 'var(--text-muted)' }

async function authed(path, opts = {}) {
  const { data: { session } } = await sb.auth.getSession()
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}`, ...(opts.headers || {}) } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

function TierDot({ tier, title }) {
  const t = TIER[tier] || TIER.unranked
  return <span title={title || t.label} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: t.color, flexShrink: 0 }} />
}
function Kind({ kind }) {
  const m = { reassign: ['Reassign', 'red'], place: ['Place', 'amber'], swap: ['Swap', 'amber'], gap: ['Book the gap', 'blue'], techout: ['Tech out', 'red'] }[kind] || [kind, 'gray']
  return <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: .6, padding: '2px 7px', borderRadius: 99,
    color: `var(--tone-${m[1]}-tx)`, background: `var(--tone-${m[1]}-bg)`, border: `1px solid var(--tone-${m[1]}-bd)` }}>{m[0]}</span>
}
function Btn({ children, primary, danger, small, ...p }) {
  return <button {...p} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: small ? '4px 10px' : '7px 14px', borderRadius: 'var(--radius)',
    fontSize: small ? 11 : 12, fontWeight: primary ? 600 : 500, border: `1px solid ${primary ? 'var(--accent)' : danger ? 'var(--danger)' : 'var(--border-strong)'}`,
    background: primary ? 'var(--accent)' : 'var(--surface)', color: primary ? '#fff' : danger ? 'var(--danger)' : 'var(--text-primary)', cursor: p.disabled ? 'default' : 'pointer',
    opacity: p.disabled ? .45 : 1, whiteSpace: 'nowrap', ...(p.style || {}) }}>{children}</button>
}

// ── Toasts (local; the page has no shared toast bus) ─────────────────────────
function useToasts() {
  const [list, setList] = useState([])
  const push = useCallback((text, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2)
    setList(l => [...l, { id, text, tone }]); setTimeout(() => setList(l => l.filter(t => t.id !== id)), 4200)
  }, [])
  const el = (
    <div style={{ position: 'fixed', bottom: 18, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', gap: 8, zIndex: 900, pointerEvents: 'none' }}>
      {list.map(t => (
        <div key={t.id} style={{ background: 'var(--text-primary)', color: 'var(--surface)', padding: '10px 14px', borderRadius: 10, fontSize: 12, boxShadow: '0 10px 30px rgba(0,0,0,.25)', display: 'flex', gap: 8, alignItems: 'center', maxWidth: 560 }}>
          <span style={{ fontWeight: 800, color: t.tone === 'ok' ? '#6FDDA0' : t.tone === 'warn' ? '#EFC252' : '#F49382' }}>{t.tone === 'ok' ? '✓' : t.tone === 'warn' ? '!' : '×'}</span>{t.text}
        </div>
      ))}
    </div>
  )
  return { push, el }
}

export default function CommandCenter() {
  const { profile } = useAuth()
  const phone = usePhone()
  const [day, setDay] = useState(0)
  const [board, setBoard] = useState(null)
  const [queue, setQueue] = useState(null)
  const [actions, setActions] = useState([])
  const [err, setErr] = useState('')
  const [busyKey, setBusyKey] = useState(null)
  const [drawer, setDrawer] = useState(null)      // { jobId, appointmentId, techId, techName, windowStart, windowEnd, status }
  const [holdReasons, setHoldReasons] = useState([])
  const [local, setLocal] = useState([])          // client-built cards (tech out)
  const [reportOpen, setReportOpen] = useState(false)
  const { push: toast, el: toasts } = useToasts()

  const load = useCallback(async (force = false) => {
    try {
      // Board first (it fills the 3-min cache), then the queue reads that
      // cache — running them together recomputed the whole board twice.
      const b = await authed(`/api/dispatch/live-board?day=${day}${force ? '&force=1' : ''}`)
      const [qq, a] = await Promise.all([
        authed(`/api/dispatch/queue?day=${day}`),
        day === 0 ? authed('/api/dispatch/actions') : Promise.resolve([]),
      ])
      setBoard(b); setQueue(qq); setActions(a); setErr('')
    } catch (e) { setErr(e.message) }
  }, [day])
  useEffect(() => { setBoard(null); setQueue(null); load() }, [load])
  useEffect(() => { const t = setInterval(() => load(), 3 * 60_000); return () => clearInterval(t) }, [load])
  useEffect(() => { authed('/api/dispatch/hold-reasons').then(setHoldReasons).catch(() => {}) }, [])

  const refreshActions = useCallback(async () => { try { setActions(await authed('/api/dispatch/actions')) } catch {} }, [])

  // One call, one audit row. Cards resolve when the board re-reads truth.
  const act = useCallback(async (body, cardKey) => {
    setBusyKey(cardKey || body.kind)
    try {
      const r = await authed('/api/dispatch/act', { method: 'POST', body: JSON.stringify({ ...body, cardKey }) })
      toast(r.summary || 'Done', r.status === 'partial' ? 'warn' : 'ok')
      if (r.status === 'partial') toast(r.error || 'Second step failed — check ServiceTitan', 'warn')
      if (cardKey) setLocal(l => l.filter(c => c.key !== cardKey))
      await load(false); await refreshActions()
      return r
    } catch (e) { toast(e.message, 'err'); await refreshActions(); return null }
    finally { setBusyKey(null) }
  }, [load, refreshActions, toast])

  const dismiss = useCallback(async (key, action, reason, minutes) => {
    try {
      await authed('/api/dispatch/dismiss', { method: 'POST', body: JSON.stringify({ cardKey: key, action, reason, minutes, day: board?.date }) })
      setQueue(q => q ? { ...q, cards: q.cards.filter(c => c.key !== key) } : q)
      setLocal(l => l.filter(c => c.key !== key))
      toast(action === 'snooze' ? `Snoozed ${minutes} min` : 'Dismissed for today')
    } catch (e) { toast(e.message, 'err') }
  }, [toast, board?.date])

  const calls = board?.calls || []
  const techs = board?.techsToday || []
  const cards = useMemo(() => [...local, ...(queue?.cards || [])], [local, queue])
  const stake = cards.reduce((s, c) => s + (c.upside || 0), 0)
  const rev = board?.dayRevenue
  const leftBehind = useMemo(() => {
    const done = calls.filter(c => c.status === 'Done')
    const quoted = done.filter(c => c.outcome?.kind === 'quoted')
    return { quotedAmt: quoted.reduce((s, c) => s + (c.outcome.amount || 0), 0), quoted: quoted.length, none: done.filter(c => c.outcome?.kind === 'none').length }
  }, [calls])

  // "Tech out" → one reassign card per call the tech still has, alternatives
  // from the same trade who are on shift and free in that window.
  const techOut = (techId) => {
    const t = techs.find(x => x.techId === techId); if (!t) return
    const mine = calls.filter(c => c.techId === techId && c.status !== 'Done')
    const free = (ws, we) => techs.filter(x => x.techId !== techId && x.rankable && x.onShift && !x.allDayInstall && x.trade === t.trade
      && !calls.some(c => c.techId === x.techId && c.status !== 'Done' && new Date(c.windowStart) < new Date(we) && new Date(ws) < new Date(c.windowEnd)))
    const made = mine.map(c => {
      const alts = free(c.windowStart, c.windowEnd).map(x => ({ techId: x.techId, techName: x.name, tier: x.tier, expectedValue: x.expectedValue || 0, closeRate: x.closeRate, avgSale: x.avgSale, delta: (x.expectedValue || 0) - (c.techExpectedValue || 0), load: x.truckRolls, target: x.target, stretch: x.stretch, busy: false, status: x.status }))
        .sort((a, b) => b.expectedValue - a.expectedValue)
      alts.forEach((a, i) => { a.recommended = i === 0 })
      return { key: `techout:${c.appointmentId}:${c.techId}`, kind: 'techout', severity: 'high', actBy: c.windowStart, upside: 0,
        jobId: c.jobId, jobNumber: c.jobNumber, appointmentId: c.appointmentId, jobType: c.jobType, zip: c.zip, windowStart: c.windowStart, windowEnd: c.windowEnd, status: c.status, opportunity: c.opportunity,
        title: `${t.name} is out — re-place #${c.jobNumber}`, why: (c.opportunityReasons || []).slice(0, 2).join(' · ') || c.jobType,
        current: { techId: c.techId, techName: c.techName, tier: c.techTier, status: c.status }, alternatives: alts, rejected: [],
        action: { kind: 'reassign', appointmentId: c.appointmentId, jobId: c.jobId, jobNumber: c.jobNumber, fromTechnicianId: c.techId, fromTechnicianName: c.techName } }
    })
    setLocal(l => [...made, ...l.filter(x => !made.some(m => m.key === x.key))])
    setReportOpen(false)
    toast(made.length ? `${made.length} call${made.length === 1 ? '' : 's'} to re-place — nothing moves until you pick` : `${t.name} has nothing left on the board`, 'warn')
  }

  if (err && !board) return <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>
  if (!board || !queue) return <div className="spinner lg" style={{ margin: '60px auto' }} />

  const dayLabel = day === 0 ? 'Today' : day === 1 ? 'Tomorrow' : new Date(board.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header row: day toggle · status · report a change · refresh */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 99, overflow: 'hidden' }}>
          {[0, 1, 2].map(d => (
            <button key={d} onClick={() => setDay(d)} style={{ padding: '5px 13px', border: 'none', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              background: day === d ? 'var(--text-primary)' : 'transparent', color: day === d ? 'var(--surface)' : 'var(--text-muted)' }}>
              {d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : new Date(Date.now() + 2 * 864e5).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </button>
          ))}
        </div>
        <span style={MUTED}>{board.counts.total} calls · {rev.remaining} still to run · {rev.done} done{rev.working ? ` · ${rev.working} on site` : ''} · refreshed {clock(board.generatedAt)}</span>
        <span style={{ flex: 1 }} />
        <div style={{ position: 'relative' }}>
          <Btn onClick={() => setReportOpen(o => !o)}>Report a change ▾</Btn>
          {reportOpen && (
            <div style={{ position: 'absolute', right: 0, top: '110%', zIndex: 50, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: '0 6px 20px rgba(0,0,0,.14)', padding: 8, width: 300 }}>
              <div style={{ ...EYEBROW, padding: '4px 6px' }}>Tech out for the rest of {dayLabel.toLowerCase()}</div>
              <div style={{ maxHeight: 260, overflow: 'auto' }}>
                {techs.filter(t => t.rankable && calls.some(c => c.techId === t.techId && c.status !== 'Done')).map(t => (
                  <button key={t.techId} onClick={() => techOut(t.techId)} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '7px 8px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--text-primary)', borderRadius: 6, textAlign: 'left' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <TierDot tier={t.tier} /><span style={{ fontWeight: 600 }}>{t.name}</span><span style={MUTED}>{t.calls} call{t.calls === 1 ? '' : 's'} · {t.trade}</span>
                  </button>
                ))}
              </div>
              <div style={{ ...MUTED, padding: '6px 6px 2px', fontSize: 11 }}>Builds one card per call. Nothing moves until you choose.</div>
            </div>
          )}
        </div>
        <Btn small onClick={() => load(true)}>Refresh</Btn>
      </div>

      {/* State tiles — "needs you" is the only tinted number */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 12 }}>
        <Tile label="Needs a decision" value={cards.length ? `${cards.length} card${cards.length === 1 ? '' : 's'}` : 'Board is clean'} sub={cards.length ? `${money(stake)} of upside if you take the picks` : 'nothing waiting on you'} color={cards.length ? 'var(--warning)' : 'var(--success)'} />
        <Tile label="Expected revenue" value={money(rev.expected)} sub={`weighted forecast · ${rev.opportunityCalls} opportunity calls`} />
        <Tile label="Sold so far" value={money(rev.soldToday)} sub={`${money(rev.invoicedToday)} invoiced · ${money(rev.booked)} installs finishing`} />
        <Tile label="Left behind" value={money(leftBehind.quotedAmt)} sub={`${leftBehind.quoted} quoted, not sold · ${leftBehind.none} done with no sale`} />
      </div>

      {/* Coverage row — full trade names, gap days are cards below */}
      <Coverage cards={cards} />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 7fr) minmax(0, 5fr)', gap: 14, alignItems: 'start' }}>
        {/* Queue */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Needs a decision</span>
            <span style={MUTED}>{queue.hiddenCount ? `${queue.hiddenCount} snoozed or dismissed` : 'sorted by when you have to act'}</span>
          </div>
          {!cards.length && (
            <div style={{ border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius-lg)', padding: '26px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              <div style={{ color: 'var(--text-primary)', fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Board is clean — nothing needs you.</div>
              New bookings, call-outs, and gaps land here as the board re-reads every 3 minutes.
            </div>
          )}
          {cards.map(c => <Card key={c.key} c={c} busy={busyKey === c.key} onAct={act} onDismiss={dismiss} onOpen={() => setDrawer({ jobId: c.jobId, appointmentId: c.appointmentId, techId: c.current?.techId || null, techName: c.current?.techName || null, windowStart: c.windowStart, windowEnd: c.windowEnd, status: c.status })} onCampaign={async () => {
            setBusyKey(c.key)
            try { const r = await authed('/api/dispatch/campaign-from-gap', { method: 'POST', body: JSON.stringify({ trade: c.trade, date: c.date }) }); toast(r.summary || `Built ${r.created} contacts`, r.created || r.existed ? 'ok' : 'warn'); if (r.created || r.existed) await dismiss(c.key, 'dismiss', 'call list built'); await refreshActions() }
            catch (e) { toast(e.message, 'err') } finally { setBusyKey(null) }
          }} />)}

          {/* Audit log */}
          {day === 0 && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={EYEBROW}>Today’s actions</span><span style={MUTED}>{actions.length ? `${actions.length} today · ✓ applied in ServiceTitan, texts and calls logged` : 'nothing yet'}</span>
              </div>
              <div style={{ maxHeight: 200, overflow: 'auto' }}>
                {actions.map(a => (
                  <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '58px 1fr auto', gap: 10, padding: '7px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, alignItems: 'baseline' }}>
                    <span style={{ ...MUTED, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{clock(a.created_at)}</span>
                    <span>{a.summary} <span style={{ fontWeight: 700, color: a.st_status === 'ok' ? 'var(--tone-green-tx)' : a.st_status === 'partial' ? 'var(--tone-amber-tx)' : 'var(--tone-red-tx)' }}>{a.st_status === 'ok' ? '✓' : a.st_status === 'partial' ? 'partial' : 'failed'}</span>{a.st_error && a.st_status !== 'ok' && <span style={{ ...MUTED, fontSize: 11 }}> — {a.st_error.slice(0, 120)}</span>}</span>
                    <span style={{ ...MUTED, fontSize: 11 }}>{a.actor_name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Board lanes */}
        <Board board={board} busy={!!busyKey} onOpen={(c) => setDrawer({ jobId: c.jobId, appointmentId: c.appointmentId, techId: c.techId || null, techName: c.techName || null, windowStart: c.windowStart, windowEnd: c.windowEnd, status: c.status })} onUnhold={(h) => act({ kind: 'unhold', appointmentId: h.appointmentId, jobId: h.jobId, jobNumber: h.jobNumber })} />
      </div>

      {drawer && <Drawer d={drawer} board={board} holdReasons={holdReasons} profile={profile} phone={phone} onClose={() => setDrawer(null)} onAct={act} toast={toast} refreshActions={refreshActions} />}
      {toasts}
    </div>
  )
}

function Tile({ label, value, sub, color }) {
  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div style={EYEBROW}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -.5, lineHeight: 1.15, marginTop: 4, color: color || 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ ...MUTED, fontSize: 11, marginTop: 2 }}>{sub}</div>
    </div>
  )
}

function Coverage({ cards }) {
  const [b3, setB3] = useState(null)
  useEffect(() => { authed('/api/board/3day').then(setB3).catch(() => {}) }, [])
  if (!b3?.board) return null
  const gapKeys = new Set(cards.filter(c => c.kind === 'gap').map(c => `${c.trade}|${c.date}`))
  return (
    <div className="card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
      <span style={EYEBROW}>Coverage · booked %</span>
      {b3.board.map(r => (
        <div key={r.trade} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span style={{ fontWeight: 600, minWidth: 82 }}>{r.trade === 'Garage Door' ? 'Garage Doors' : r.trade}</span>
          {r.days.map((d, i) => {
            const tone = d.status === 'none' ? 'gray' : d.status === 'good' ? 'green' : d.status === 'warn' ? 'amber' : 'red'
            return <span key={i} title={`${d.date}: ${d.calls} booked / ${d.capacity} slots${d.needed ? ` · ${d.needed} needed` : ''}`}
              style={{ minWidth: 40, textAlign: 'center', padding: '2px 6px', borderRadius: 6, fontVariantNumeric: 'tabular-nums', fontWeight: 700,
                color: `var(--tone-${tone}-tx)`, background: `var(--tone-${tone}-bg)`, border: `1px solid var(--tone-${tone}-bd)`, outline: gapKeys.has(`${r.trade}|${d.date}`) ? '2px solid var(--accent)' : 'none', outlineOffset: 1 }}>
              {d.status === 'none' ? '—' : `${d.pct}%`}</span>
          })}
        </div>
      ))}
      <span style={{ ...MUTED, fontSize: 11 }}>{['today', 'tomorrow', new Date(Date.now() + 2 * 864e5).toLocaleDateString('en-US', { weekday: 'short' })].join(' · ')} · outlined = card in the queue</span>
    </div>
  )
}

// ── Card ────────────────────────────────────────────────────────────────────
function Card({ c, busy, onAct, onDismiss, onOpen, onCampaign }) {
  // Selection is the tech id (not a row index) so a 3-minute reload can't
  // silently re-point the primary button at a different tech.
  const [selId, setSelId] = useState(() => (c.alternatives || []).find(a => a.recommended)?.techId ?? (c.alternatives || [])[0]?.techId ?? null)
  const [dismissing, setDismissing] = useState(false)
  const sel = selId === 'keep' ? -1 : (c.alternatives || []).findIndex(a => a.techId === selId)
  const setSel = (i) => setSelId(i === -1 ? 'keep' : (c.alternatives || [])[i]?.techId ?? null)
  const alt = sel >= 0 ? (c.alternatives || [])[sel] : null
  const rail = c.severity === 'high' ? 'var(--danger)' : c.severity === 'mid' ? 'var(--warning)' : 'var(--accent)'
  const actBy = c.actBy ? `act by ${hr(c.actBy)}` : null
  const primary = c.kind === 'gap' ? 'Build the call list' : c.kind === 'swap' ? 'Swap in ServiceTitan' : c.kind === 'place' ? 'Assign in ServiceTitan' : 'Move in ServiceTitan'
  const run = async () => {
    if (c.kind === 'gap') return onCampaign()
    if (c.kind === 'swap') { for (const s of c.steps) { const r = await onAct({ ...s }, c.key); if (!r || r.status === 'failed') break } return }
    if (!alt) return
    if (c.kind === 'place') return onAct({ ...c.action, technicianId: alt.techId, technicianName: alt.techName }, c.key)
    if (alt.techId === c.current?.techId) return onDismiss(c.key, 'dismiss', 'keep as booked')
    return onAct({ ...c.action, toTechnicianId: alt.techId, toTechnicianName: alt.techName }, c.key)
  }
  return (
    <div className="card" style={{ display: 'grid', gridTemplateColumns: '4px 1fr', overflow: 'hidden' }}>
      <div style={{ background: rail }} />
      <div style={{ padding: '11px 14px', display: 'grid', gap: 8, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)' }}>
          <Kind kind={c.kind} />
          {actBy && <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>{actBy}</span>}
          {c.jobType && <span>{c.jobType} · {windowLabel(c)}{c.zip ? ` · ${c.zip}` : ''}</span>}
          {c.current && <span>· {c.current.techName} <TierDot tier={c.current.tier} /> {c.current.status === 'Working' ? 'on site' : c.current.status === 'Dispatched' ? 'rolling' : c.current.status?.toLowerCase()}</span>}
          {c.jobId && <a href="#" onClick={e => { e.preventDefault(); onOpen() }} style={{ marginLeft: 'auto', fontSize: 11 }}>open call</a>}
        </div>
        <div style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.3 }}>
          {c.title}{c.upside > 0 && <span style={{ color: 'var(--tone-green-tx)', fontWeight: 800 }}> — +{money(c.upside)} expected</span>}
        </div>
        {c.why && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{c.why}</div>}

        {c.alternatives?.length > 0 && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '18px 1fr 110px 90px 70px 90px', gap: 8, padding: '4px 10px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .5, color: 'var(--text-muted)', background: 'var(--surface-2)' }}>
              <span /><span>Technician</span><span>Load today</span><span>Drive</span><span>Close</span><span style={{ textAlign: 'right' }}>$/opp</span>
            </div>
            {c.alternatives.map((a, i) => (
              <div key={a.techId} onClick={() => setSel(i)} style={{ display: 'grid', gridTemplateColumns: '18px 1fr 110px 90px 70px 90px', gap: 8, alignItems: 'center', padding: '6px 10px', fontSize: 12, cursor: 'pointer',
                borderTop: i ? '1px solid var(--border)' : 'none', background: i === sel ? 'var(--accent-bg)' : 'transparent', opacity: a.busy ? .6 : 1 }}>
                <span style={{ width: 13, height: 13, borderRadius: '50%', border: `1.5px solid ${i === sel ? 'var(--accent)' : 'var(--border-strong)'}`, background: i === sel ? 'radial-gradient(circle, var(--accent) 45%, transparent 50%)' : 'transparent' }} />
                <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}><TierDot tier={a.tier} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.techName}</span>{a.recommended && <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--tone-green-tx)' }}>PICK</span>}</span>
                <span style={{ color: a.busy ? 'var(--tone-amber-tx)' : 'var(--text-secondary)' }}>{a.busy ? 'has a call this window' : a.load != null ? `${a.load} of ${a.target} calls` : ''}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{a.travel?.minutes != null ? `${a.travel.minutes} min` : a.travel?.miles != null ? `~${a.travel.miles} mi` : ''}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{a.closeRate != null ? `${a.closeRate}%` : ''}</span>
                <span style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: a.delta > 0 ? 'var(--tone-green-tx)' : 'var(--text-muted)' }}>{a.delta > 0 ? `+${money(a.delta)}` : money(a.expectedValue)}<span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>/opp</span></span>
              </div>
            ))}
            {c.current && c.kind !== 'place' && (
              <div onClick={() => setSel(-1)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 12, cursor: 'pointer', borderTop: '1px solid var(--border)', background: sel === -1 ? 'var(--accent-bg)' : 'transparent', color: 'var(--text-secondary)' }}>
                <span style={{ width: 13, height: 13, borderRadius: '50%', border: `1.5px solid ${sel === -1 ? 'var(--accent)' : 'var(--border-strong)'}`, background: sel === -1 ? 'radial-gradient(circle, var(--accent) 45%, transparent 50%)' : 'transparent' }} />
                Keep it with {c.current.techName}
              </div>
            )}
            {alt?.bump && <div style={{ ...MUTED, fontSize: 11, padding: '4px 10px 6px', borderTop: '1px solid var(--border)' }}>{alt.techName} is at capacity — this bumps #{alt.bump.jobNumber} ({alt.bump.jobType}); move that one from the drawer after.</div>}
            {c.rejected?.length > 0 && <div style={{ ...MUTED, fontSize: 11, padding: '4px 10px 6px', borderTop: '1px solid var(--border)' }}>Not offered: {c.rejected.slice(0, 4).map(r => `${r.techName} (${r.reason})`).join(' · ')}{c.rejected.length > 4 ? ` · +${c.rejected.length - 4}` : ''}</div>}
          </div>
        )}
        {c.kind === 'swap' && c.steps && <div style={{ ...MUTED, fontSize: 11 }}>Two moves, in order: {c.steps.map(s => `#${s.jobNumber} → ${s.toTechnicianName}`).join(', then ')}{c.travel?.minutes != null ? ` · ${c.travel.minutes} min between the two sites` : ''}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {sel === -1 && c.kind !== 'gap' ? <Btn primary disabled={busy} onClick={() => onDismiss(c.key, 'dismiss', 'keep as booked')}>Keep as booked</Btn>
            : <Btn primary disabled={busy || (c.kind !== 'gap' && c.kind !== 'swap' && !alt)} onClick={run}>{busy ? 'Writing to ServiceTitan…' : primary}</Btn>}
          {!dismissing ? (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <Btn small onClick={() => onDismiss(c.key, 'snooze', null, 60)} style={{ border: 'none', background: 'transparent', color: 'var(--text-secondary)' }}>Snooze 1h</Btn>
              <Btn small onClick={() => setDismissing(true)} style={{ border: 'none', background: 'transparent', color: 'var(--text-secondary)' }}>Not this one</Btn>
            </span>
          ) : (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)' }}>why?
              {['wrong tech', 'already handled', 'not worth it', 'customer asked'].map(r => <Btn key={r} small onClick={() => onDismiss(c.key, 'dismiss', r)}>{r}</Btn>)}
              <Btn small onClick={() => setDismissing(false)} style={{ border: 'none', background: 'transparent' }}>cancel</Btn>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Board lanes ─────────────────────────────────────────────────────────────
const ORDER = ['HVAC', 'Plumbing', 'Electrical', 'Garage Door', 'Other']
function Board({ board, onOpen, onUnhold, busy }) {
  const calls = board.calls || [], techs = board.techsToday || []
  const dayStart = new Date(board.dayStart), dayEnd = new Date(board.dayEnd)
  // 7 AM–8 PM Denver-local track — the dispatch day's real span.
  const t0 = new Date(dayStart); t0.setHours(7, 0, 0, 0); const t1 = new Date(dayStart); t1.setHours(20, 0, 0, 0)
  const span = t1 - t0
  const pos = (iso) => Math.max(0, Math.min(1, (new Date(iso) - t0) / span))
  const nowPos = board.day === 0 ? pos(board.now) : null
  const kindOf = (c) => c.status === 'Hold' ? 'hold' : /install|replacement/i.test(c.jobType) ? 'ins' : c.opportunity >= 3 ? 'hi' : /repair|service|warranty|callback|concern/i.test(c.jobType) ? 'rep' : 'rt'
  const tone = { hi: 'green', rep: 'amber', ins: 'blue', rt: 'gray' }
  const groups = ORDER.map(tr => ({ tr, techs: techs.filter(t => (t.trade || 'Other') === tr && (t.onShift || calls.some(c => c.techId === t.techId))).sort((a, b) => (b.expectedValue || 0) - (a.expectedValue || 0)) })).filter(g => g.techs.length)
  const onHold = board.onHold || [], tray = board.unassigned || []
  return (
    <div className="card" style={{ padding: 0, position: 'sticky', top: 0 }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>The board</span><span style={MUTED}>click any call</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, fontSize: 10, color: 'var(--text-muted)' }}>
          {[['green', 'opportunity'], ['amber', 'repair'], ['blue', 'install'], ['gray', 'routine']].map(([t, l]) => <span key={t}><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, marginRight: 4, verticalAlign: -1, background: `var(--tone-${t}-bg)`, border: `1px solid var(--tone-${t}-bd)` }} />{l}</span>)}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '124px 1fr', padding: '5px 14px 3px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
        <span /><div style={{ position: 'relative', height: 13 }}>
          {[8, 10, 12, 14, 16, 18, 20].map(h => <span key={h} style={{ position: 'absolute', left: `${((h - 7) / 13) * 100}%`, transform: 'translateX(-50%)', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)' }}>{h === 12 ? '12PM' : h > 12 ? `${h - 12}PM` : `${h}AM`}</span>)}
        </div>
      </div>
      <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 330px)' }}>
        {groups.map(g => (
          <div key={g.tr}>
            <div style={{ ...EYEBROW, padding: '8px 14px 2px', display: 'flex', gap: 8 }}>{g.tr === 'Garage Door' ? 'Garage Doors' : g.tr}<span style={{ ...MUTED, fontSize: 11, textTransform: 'none', letterSpacing: 0 }}>{calls.filter(c => g.techs.some(t => t.techId === c.techId)).length} calls</span></div>
            {g.techs.map(t => {
              const mine = calls.filter(c => c.techId === t.techId).sort((a, b) => new Date(a.windowStart) - new Date(b.windowStart))
              const rowsEnd = []; const rowOf = new Map()
              for (const c of mine) { let r = rowsEnd.findIndex(e => e <= new Date(c.windowStart).getTime()); if (r < 0) { r = rowsEnd.length; rowsEnd.push(0) } rowsEnd[r] = new Date(c.windowEnd).getTime(); rowOf.set(c.appointmentId + '|' + c.techId, r) }
              const rows = Math.max(1, rowsEnd.length)
              const shifts = (t.shifts || []).filter(s => s.type !== 'TimeOff')
              return (
                <div key={t.techId} style={{ display: 'grid', gridTemplateColumns: '124px 1fr', alignItems: 'center', padding: '3px 14px', minHeight: 32, opacity: t.onShift ? 1 : .55 }}>
                  <div title={`${TIER[t.tier]?.label || ''} · ${t.status}`} style={{ fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}><TierDot tier={t.tier} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span></div>
                  <div style={{ position: 'relative', height: rows * 26, borderRadius: 4, background: 'repeating-linear-gradient(to right, transparent 0 calc(100%/13 - 1px), var(--border) calc(100%/13 - 1px) calc(100%/13))' }}>
                    {shifts.map((s, i) => <div key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: `${pos(s.start) * 100}%`, width: `${(pos(s.end) - pos(s.start)) * 100}%`, background: 'var(--accent-bg)', opacity: .35, borderRadius: 4 }} />)}
                    {nowPos != null && nowPos > 0 && nowPos < 1 && <div style={{ position: 'absolute', top: -1, bottom: -1, left: `${nowPos * 100}%`, width: 2, background: 'var(--danger)', opacity: .7, zIndex: 1 }} />}
                    {!mine.length && <span style={{ position: 'absolute', left: 8, top: 5, fontSize: 10, color: 'var(--text-muted)' }}>{t.onShift ? (t.allDayInstall ? 'all-day install' : 'open') : 'off today'}</span>}
                    {mine.map(c => {
                      const k = kindOf(c); const tn = tone[k] || 'gray'
                      const glyph = c.status === 'Done' ? '✓' : c.status === 'Working' ? '●' : c.status === 'Dispatched' ? '→' : ''
                      return (
                        <div key={c.appointmentId + '|' + c.techId} onClick={() => onOpen(c)} title={`#${c.jobNumber} · ${c.jobType} · ${windowLabel(c)} · ${c.status}${c.opportunityReasons?.length ? '\n' + c.opportunityReasons.join(' · ') : ''}`}
                          style={{ position: 'absolute', top: 2 + (rowOf.get(c.appointmentId + '|' + c.techId) || 0) * 26, height: 22, left: `${pos(c.windowStart) * 100}%`, width: `calc(${(pos(c.windowEnd) - pos(c.windowStart)) * 100}% - 3px)`, borderRadius: 5, cursor: 'pointer',
                            fontSize: 10, fontWeight: 700, padding: '0 6px', display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', whiteSpace: 'nowrap',
                            ...(k === 'hold' ? { background: 'repeating-linear-gradient(45deg, var(--surface-2) 0 4px, var(--surface) 4px 8px)', border: '1px dashed var(--border-strong)', color: 'var(--text-muted)' }
                              : { background: `var(--tone-${tn}-bg)`, border: `1px solid var(--tone-${tn}-bd)`, color: `var(--tone-${tn}-tx)` }),
                            ...(c.flags?.length ? { boxShadow: '0 0 0 2px var(--danger)' } : {}), opacity: c.status === 'Done' ? .6 : 1 }}>
                          {glyph && <span style={{ fontSize: 9 }}>{glyph}</span>}<span>#{c.jobNumber}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div style={{ padding: '8px 14px 10px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11 }}>
        <span style={{ ...EYEBROW, color: 'var(--tone-amber-tx)' }}>Unassigned tray</span>
        {tray.length ? tray.map(u => <span key={u.appointmentId} onClick={() => onOpen({ jobId: u.jobId, appointmentId: u.appointmentId, techId: null, techName: null, windowStart: u.windowStart, windowEnd: u.windowEnd, status: 'Scheduled' })} style={{ cursor: 'pointer', border: '1px solid var(--tone-amber-bd)', background: 'var(--tone-amber-bg)', color: 'var(--tone-amber-tx)', borderRadius: 99, padding: '2px 8px', fontWeight: 700 }}>#{u.jobNumber} · {u.jobType.replace(/^\w[\w ]*? - /, '')} · {windowLabel(u)}</span>) : <span style={MUTED}>empty</span>}
        {onHold.length > 0 && <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text-muted)' }}>On hold: {onHold.map(h => <span key={h.jobId}>#{h.jobNumber} <button disabled={busy} onClick={() => onUnhold(h)} style={{ border: 'none', background: 'transparent', color: 'var(--accent)', cursor: busy ? 'default' : 'pointer', fontSize: 11, fontWeight: 600, padding: 0, opacity: busy ? .5 : 1 }}>release</button></span>)}</span>}
      </div>
    </div>
  )
}

// ── Drawer ──────────────────────────────────────────────────────────────────
const WINDOWS = [[8, 12], [10, 14], [12, 16], [14, 18], [16, 20]]
function Drawer({ d, board, holdReasons, profile, phone, onClose, onAct, toast, refreshActions }) {
  const [detail, setDetail] = useState(null)
  const [err, setErr] = useState('')
  const techs = board.techsToday || []
  const [techId, setTechId] = useState(d.techId ? String(d.techId) : '')
  const [dateStr, setDateStr] = useState(board.date)
  const [win, setWin] = useState(() => { const h = d.windowStart ? new Date(d.windowStart).getHours() : 8; const w = WINDOWS.find(([s]) => s === h); return w ? `${w[0]}-${w[1]}` : '' })
  const [note, setNote] = useState('')
  const [holdReason, setHoldReason] = useState(''); const [holdMemo, setHoldMemo] = useState('')
  const [jobTypeId, setJobTypeId] = useState(''); const [priority, setPriority] = useState('')
  const [smsBody, setSmsBody] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setDetail(null); authed(`/api/dispatch/job/${d.jobId}`).then(x => { setDetail(x); setJobTypeId(String(x.job.jobTypeId || '')); setPriority(x.job.priority || '') }).catch(e => setErr(e.message)) }, [d.jobId])
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose() }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [onClose])

  // Trade comes from the ORIGINAL tech (or the tray row for unassigned jobs),
  // never from the dropdown selection — otherwise picking "Unassigned"
  // collapsed the list and tray jobs offered every trade.
  const trade = useMemo(() => {
    const orig = techs.find(t => t.techId === d.techId)
    if (orig?.trade) return orig.trade
    const tray = (board.unassigned || []).find(u => u.jobId === d.jobId)
    return tray?.trade || null
  }, [techs, board.unassigned, d.techId, d.jobId])
  const ranked = useMemo(() => {
    const sameTrade = techs.filter(t => t.onShift && t.rankable && (!trade || t.trade === trade)).sort((a, b) => (b.expectedValue || 0) - (a.expectedValue || 0))
    const list = [...sameTrade]
    if (d.techId && !list.some(t => t.techId === d.techId)) list.unshift({ techId: d.techId, name: d.techName || `Tech ${d.techId}`, tier: techs.find(t => t.techId === d.techId)?.tier || 'unranked', expectedValue: techs.find(t => t.techId === d.techId)?.expectedValue ?? null })
    return list
  }, [techs, trade, d.techId, d.techName])
  const jn = detail?.job?.jobNumber || ''
  const run = async (fn) => { setBusy(true); try { await fn() } finally { setBusy(false) } }

  const saveAssign = () => run(async () => {
    if (!d.appointmentId) { toast('This job has no appointment to assign', 'err'); return }
    const to = techs.find(t => String(t.techId) === techId)
    if (!techId && d.techId) { const r = await onAct({ kind: 'unassign', appointmentId: d.appointmentId, jobId: d.jobId, jobNumber: jn, technicianId: d.techId, technicianName: d.techName }); if (r && r.status !== 'failed') onClose(); return }
    if (!to || to.techId === d.techId) { toast('Nothing changed'); return }
    const r = d.techId
      ? await onAct({ kind: 'reassign', appointmentId: d.appointmentId, jobId: d.jobId, jobNumber: jn, fromTechnicianId: d.techId, fromTechnicianName: d.techName, toTechnicianId: to.techId, toTechnicianName: to.name })
      : await onAct({ kind: 'assign', appointmentId: d.appointmentId, jobId: d.jobId, jobNumber: jn, technicianId: to.techId, technicianName: to.name })
    if (r && r.status !== 'failed') onClose()   // the drawer's snapshot is stale after a write
  })
  const saveWindow = () => run(async () => {
    if (!d.appointmentId || !win) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { toast('Pick a date', 'warn'); return }
    const [s, e] = win.split('-').map(Number)
    const curH = d.windowStart ? new Date(d.windowStart).getHours() : null
    if (dateStr === board.date && curH === s) { toast('Nothing changed'); return }
    const mk = (h) => { const x = new Date(`${dateStr}T00:00:00`); x.setHours(h, 0, 0, 0); return x.toISOString() }
    const label = `${dateStr === board.date ? '' : dateStr + ' '}${s > 12 ? s - 12 : s}${s >= 12 ? 'PM' : 'AM'}–${e > 12 ? e - 12 : e}${e >= 12 ? 'PM' : 'AM'}`
    const r = await onAct({ kind: 'reschedule', appointmentId: d.appointmentId, jobId: d.jobId, jobNumber: jn, start: mk(s), end: mk(e), arrivalWindowStart: mk(s), arrivalWindowEnd: mk(e), windowLabel: label, fromWindowLabel: windowLabel(d) })
    if (r && r.status !== 'failed') onClose()
  })
  const saveHold = () => run(async () => {
    if (!d.appointmentId) return
    let r
    if (d.status === 'Hold') r = await onAct({ kind: 'unhold', appointmentId: d.appointmentId, jobId: d.jobId, jobNumber: jn })
    else {
      if (!holdReason) { toast('Pick a hold reason', 'warn'); return }
      const hr2 = holdReasons.find(x => String(x.id) === holdReason)
      r = await onAct({ kind: 'hold', appointmentId: d.appointmentId, jobId: d.jobId, jobNumber: jn, reasonId: hr2.id, reasonName: hr2.name, memo: holdMemo })
    }
    if (r && r.status !== 'failed') onClose()
  })
  const saveNote = () => { if (busy || !note.trim()) return; run(async () => { const r = await onAct({ kind: 'note', jobId: d.jobId, jobNumber: jn, text: note.trim() }); if (r) setNote('') }) }
  const saveType = () => run(async () => {
    const changes = {}
    if (jobTypeId && Number(jobTypeId) !== detail.job.jobTypeId) { changes.jobTypeId = Number(jobTypeId); changes.jobTypeName = detail.jobTypes.find(t => t.id === Number(jobTypeId))?.name }
    if (priority && priority !== detail.job.priority) changes.priority = priority
    if (!Object.keys(changes).length) { toast('Nothing changed'); return }
    if (changes.jobTypeId) await onAct({ kind: 'retype', jobId: d.jobId, jobNumber: jn, ...changes })
    if (changes.priority && !changes.jobTypeId) await onAct({ kind: 'priority', jobId: d.jobId, jobNumber: jn, priority: changes.priority })
    else if (changes.priority) await onAct({ kind: 'priority', jobId: d.jobId, jobNumber: jn, priority: changes.priority })
  })
  const sendSms = () => run(async () => {
    const to = detail?.customer?.phone; if (!to || !smsBody.trim()) return
    try {
      const res = await fetch('/api/twilio/sms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, body: smsBody.trim(), repName: profile?.name || profile?.email || 'dispatch', contactId: null }) })
      const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Text failed')
      await onAct({ kind: 'log', jobId: d.jobId, jobNumber: jn, summary: `Texted ${detail.customer.name || 'the customer'} on #${jn}: “${smsBody.trim().slice(0, 80)}”` })
      setSmsBody('')
    } catch (e) { toast(e.message, 'err') }
  })
  const call = () => {
    const to = detail?.customer?.phone; if (!to) return
    if (!phone?.makeCall || phone.twilioReady === false) { toast('The Andi phone isn’t ready on this screen — call from the dialer', 'warn'); return }
    phone.makeCall(to, { contactName: detail.customer.name })
    onAct({ kind: 'log', jobId: d.jobId, jobNumber: jn, summary: `Placed a call to ${detail.customer.name || 'the customer'} on #${jn} from Andi` })
  }

  const sel = { width: '100%', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius)', padding: '7px 10px', fontSize: 13, background: 'var(--surface)', color: 'var(--text-primary)', fontFamily: 'inherit' }
  const sec = { ...EYEBROW, marginBottom: 6 }
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 500 }} />
      <aside style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(460px, 100vw)', background: 'var(--surface)', borderLeft: '1px solid var(--border)', boxShadow: '0 10px 30px rgba(0,0,0,.25)', zIndex: 501, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={EYEBROW}>{d.status === 'Hold' ? 'On hold' : d.status || 'Scheduled'} · {windowLabel(d)}{detail?.location?.zip ? ` · ${detail.location.zip}` : ''}</div>
            <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.25, marginTop: 2 }}>{jn ? `#${jn}` : '…'} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{detail?.job?.jobType || ''}</span></div>
          </div>
          <Btn small onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'transparent' }}>Close</Btn>
        </div>
        <div style={{ padding: '14px 18px', overflow: 'auto', display: 'grid', gap: 14, flex: 1 }}>
          {err && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
          {!detail && !err && <div className="spinner" style={{ margin: '20px auto' }} />}
          {detail && (
            <>
              <div>
                <div style={sec}>Customer</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{detail.customer?.name || '—'}{detail.customer?.doNotService && <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--tone-red-tx)', fontWeight: 800 }}>DO NOT SERVICE</span>}</div>
                <div style={{ ...MUTED, marginTop: 2 }}>{[detail.location?.street, detail.location?.city].filter(Boolean).join(', ')}{detail.customer?.phone ? ` · ${detail.customer.phone}` : ''}</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <Btn small disabled={!detail.customer?.phone} onClick={call}>Call</Btn>
                  <a className="btn sm" href={ST_JOB_URL(d.jobId)} target="_blank" rel="noreferrer" style={{ fontSize: 11, padding: '4px 10px' }}>Open in ServiceTitan ↗</a>
                </div>
              </div>
              <div>
                <div style={sec}>Assigned tech</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select style={sel} value={techId} onChange={e => setTechId(e.target.value)}>
                    <option value="">— Unassigned —</option>
                    {ranked.map(t => <option key={t.techId} value={String(t.techId)}>{t.name}{t.techId === d.techId ? ' (current)' : ''} — {TIER[t.tier]?.label || t.tier}{t.expectedValue != null ? ` · ${money(t.expectedValue)}/opp` : ''}{t.allDayInstall ? ' · all-day install' : ''}</option>)}
                  </select>
                  <Btn primary disabled={busy || !d.appointmentId} onClick={saveAssign}>Save</Btn>
                </div>
                {!d.appointmentId && <div style={{ ...MUTED, fontSize: 11, marginTop: 4 }}>No appointment on this job to assign.</div>}
              </div>
              <div>
                <div style={sec}>Arrival window</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="date" style={{ ...sel, width: 150 }} value={dateStr} onChange={e => setDateStr(e.target.value)} />
                  <select style={sel} value={win} onChange={e => setWin(e.target.value)}>
                    <option value="">— pick —</option>
                    {WINDOWS.map(([s, e]) => <option key={s} value={`${s}-${e}`}>{s > 12 ? s - 12 : s} {s >= 12 ? 'PM' : 'AM'} – {e > 12 ? e - 12 : e} {e >= 12 ? 'PM' : 'AM'}</option>)}
                  </select>
                  <Btn primary disabled={busy || !win || !d.appointmentId} onClick={saveWindow}>Move</Btn>
                </div>
              </div>
              <div>
                <div style={sec}>Job type · priority</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select style={sel} value={jobTypeId} onChange={e => setJobTypeId(e.target.value)}>{(detail.jobTypes || []).map(t => <option key={t.id} value={String(t.id)}>{t.name}</option>)}</select>
                  <select style={{ ...sel, width: 120 }} value={priority} onChange={e => setPriority(e.target.value)}>{['', 'Low', 'Normal', 'High', 'Urgent'].map(p => <option key={p} value={p}>{p || '—'}</option>)}</select>
                  <Btn primary disabled={busy} onClick={saveType}>Fix</Btn>
                </div>
              </div>
              <div>
                <div style={sec}>{d.status === 'Hold' ? 'Release hold' : 'Put on hold'}</div>
                {d.status !== 'Hold' && (
                  <div style={{ display: 'grid', gap: 6 }}>
                    <select style={sel} value={holdReason} onChange={e => setHoldReason(e.target.value)}><option value="">— reason (required by ServiceTitan) —</option>{holdReasons.map(r => <option key={r.id} value={String(r.id)}>{r.name}</option>)}</select>
                    <input style={sel} placeholder="memo (optional)" value={holdMemo} onChange={e => setHoldMemo(e.target.value)} />
                  </div>
                )}
                <div style={{ marginTop: 6 }}><Btn disabled={busy || !d.appointmentId || (d.status !== 'Hold' && !holdReason)} onClick={saveHold}>{d.status === 'Hold' ? 'Take off hold' : 'Hold this appointment'}</Btn></div>
              </div>
              <div>
                <div style={sec}>Notes on the job</div>
                {detail.job.summary && <div style={{ borderLeft: '2px solid var(--border-strong)', padding: '2px 10px', fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{detail.job.summary}<span style={{ display: 'block', fontStyle: 'normal', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>booking summary</span></div>}
                {detail.notes.slice(0, 5).map((n, i) => <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{n.isPinned ? '📌 ' : ''}{n.text}<span style={{ ...MUTED, fontSize: 10 }}> · {n.createdOn ? new Date(n.createdOn).toLocaleDateString() : ''}</span></div>)}
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <input style={sel} placeholder="Pin a note to the job" value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveNote() }} />
                  <Btn disabled={busy || !note.trim()} onClick={saveNote}>Pin</Btn>
                </div>
              </div>
              {detail.estimates.length > 0 && (
                <div>
                  <div style={sec}>Estimates</div>
                  {detail.estimates.map(e => <div key={e.id} style={{ fontSize: 12, display: 'flex', gap: 8 }}><span style={{ fontWeight: 700, color: e.status === 'Sold' ? 'var(--tone-green-tx)' : 'var(--text-muted)', minWidth: 46 }}>{e.status}</span><span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(e.subtotal)}</span></div>)}
                </div>
              )}
              <div>
                <div style={sec}>Text the customer</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input style={sel} placeholder={detail.customer?.phone ? `Text ${detail.customer.name || 'the customer'}…` : 'No phone on file'} disabled={!detail.customer?.phone} value={smsBody} onChange={e => setSmsBody(e.target.value)} />
                  <Btn disabled={busy || !detail.customer?.phone || !smsBody.trim()} onClick={sendSms}>Send</Btn>
                </div>
                <div style={{ ...MUTED, fontSize: 11, marginTop: 4 }}>You write it; nothing is sent automatically. Logged in Today’s actions.</div>
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  )
}
