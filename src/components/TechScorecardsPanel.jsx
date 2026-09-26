import { useEffect, useMemo, useState } from 'react'
import { sb } from '../lib/supabase'
import { toast } from '../lib/dialogs'
import { useIsMobile } from '../lib/useIsMobile'
import { Segmented, Ring, PillNav, Face, ToneChip, eyebrow, num, panel } from './ui'
import { LEVELS, levelOf, rateKpi, fmtKpi, LevelChip, ScoreDelta, LevelPips, KpiTrack } from './ScorecardsPanel'

// Team → Technicians → Scorecards. Service technicians, scored like the CSR
// scorecards: each KPI rates 1–4 against thresholds, the overall score is the
// weighted average. The numbers are the department TVs' monthly per-tech
// figures (/api/team/tech-scorecards). Weights default to the TV ranking
// (sold 40 · close 30 · clubs 20 · 5★ 10). Dollar and count targets are per
// trade — an HVAC tech's month isn't a garage tech's — and the current month
// is judged on pace (targets × share of the month gone).

const TRADES = ['HVAC', 'Plumbing', 'Electrical', 'Garage Doors']
const KPIS = [
  { id: 'sold', label: 'Sold', short: 'Sold', unit: '$', paced: true, perTrade: true },
  { id: 'closeRate', label: 'Close rate', short: 'Close rate', unit: '%' },
  { id: 'memberships', label: 'Memberships sold', short: 'Clubs', unit: '', paced: true, perTrade: true },
  { id: 'fiveStar', label: '5★ reviews', short: '5★ reviews', unit: '', paced: true, perTrade: true },
]
const DEFAULT_WEIGHTS = { sold: 40, closeRate: 30, memberships: 20, fiveStar: 10 }
const DEFAULT_CLOSE = { exceeds: 80, meets: 70, improvement: 60 }
const RULES_KEY = 'tech_scorecard_rules'
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const monthName = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]} ${y}` }
const short = (ym) => MONTHS[Number(ym.split('-')[1]) - 1].slice(0, 3)

// Starting targets when none are saved yet: the trade's own spread, projected
// to a full month — 75th percentile = Exceeds, median = Meets, 25th = Needs impr.
function seedThresholds(techs, elapsed) {
  const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); const i = (a.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo) }
  const byTrade = {}
  for (const t of TRADES) {
    const rows = techs.filter(x => x.trade === t)
    byTrade[t] = {}
    for (const k of KPIS.filter(k => k.perTrade)) {
      const vals = rows.map(x => (x[k.id] || 0) / (elapsed || 1))
      const round = k.id === 'sold' ? (v) => Math.max(1000, Math.round(v / 1000) * 1000) : (v) => Math.max(1, Math.round(v))
      const e = round(pct(vals, 0.75)), m = Math.min(e, round(pct(vals, 0.5))), i = Math.min(m, round(pct(vals, 0.25)))
      byTrade[t][k.id] = { exceeds: e, meets: m, improvement: i }
    }
  }
  return { weights: { ...DEFAULT_WEIGHTS }, closeRate: { ...DEFAULT_CLOSE }, byTrade }
}

// Thresholds for one tech's KPI, paced for a month in progress.
function thrFor(rules, kpi, trade, elapsed) {
  const base = kpi.perTrade ? rules.byTrade?.[trade]?.[kpi.id] : rules.closeRate
  if (!base) return null
  if (!kpi.paced || elapsed >= 1) return base
  const f = (v) => (kpi.unit === '$' ? Math.round((v * elapsed) / 100) * 100 : Math.round(v * elapsed * 10) / 10)
  return { exceeds: f(base.exceeds), meets: f(base.meets), improvement: f(base.improvement) }
}

function scoreTech(rules, tech, elapsed) {
  let tw = 0, sum = 0
  for (const k of KPIS) {
    const w = Number(rules.weights?.[k.id]) || 0
    const r = rateKpi(k, tech[k.id], thrFor(rules, k, tech.trade, elapsed))
    if (r != null && w > 0) { tw += w; sum += r * w }
  }
  return tw ? sum / tw : null
}

function TechRing({ name, score, size = 48, stroke = 4 }) {
  const lv = levelOf(score)
  return (
    <Ring pct={score == null ? 0 : (score / 4) * 100} size={size} stroke={stroke} tone={lv ? LEVELS[lv].tone : 'gray'}>
      <Face name={name} size={size - stroke * 2 - 6} />
    </Ring>
  )
}

function TechCard({ t, score, prevScore, vs, rules, elapsed, onOpen }) {
  const lv = levelOf(score)
  return (
    <div className="coach-card" role="button" tabIndex={0} onClick={onOpen} title="Open this scorecard"
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      style={{ ...panel, borderRadius: 14, padding: '16px 18px 14px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <TechRing name={t.name} score={score} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
            <ToneChip tone="gray" small>{t.trade}</ToneChip>
            <LevelChip level={lv} small short />
            <ScoreDelta now={score} prev={prevScore} vs={vs} />
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ ...num, fontSize: 28, fontWeight: 800, lineHeight: 1, letterSpacing: '-.02em', color: lv ? `var(--tone-${LEVELS[lv].tone}-tx)` : 'var(--text-muted)' }}>
            {score == null ? '—' : score.toFixed(2)}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>out of 4.00</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        {KPIS.map(k => (
          <div key={k.id} className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto 34px', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
            <span style={{ color: 'var(--text-secondary)' }}>{k.short}{k.id === 'closeRate' && t.opps ? <span style={{ color: 'var(--text-muted)' }}> · {t.closed}/{t.opps}</span> : null}</span>
            <span style={{ ...num, fontWeight: 700 }}>{fmtKpi(k, t[k.id])}</span>
            <span style={{ display: 'flex', justifyContent: 'flex-end' }}><LevelPips level={rateKpi(k, t[k.id], thrFor(rules, k, t.trade, elapsed))} /></span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 'auto', fontSize: 12, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
        <span style={num}>{t.jobs} jobs ran · avg ticket {fmtKpi({ unit: '$' }, t.avgTicket)}</span>
        <span style={{ fontWeight: 600, color: 'var(--accent)' }}>Open →</span>
      </div>
    </div>
  )
}

function RulesEditor({ rules, setRules, onSave, saving }) {
  const input = { width: '100%', padding: '6px 8px', fontSize: 13, fontWeight: 600, textAlign: 'center', border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', color: 'var(--text-primary)' }
  const total = KPIS.reduce((t, k) => t + (Number(rules.weights?.[k.id]) || 0), 0)
  const setThr = (trade, id, key, v) => setRules(r => {
    if (!trade) return { ...r, closeRate: { ...r.closeRate, [key]: parseFloat(v) || 0 } }
    return { ...r, byTrade: { ...r.byTrade, [trade]: { ...r.byTrade[trade], [id]: { ...r.byTrade[trade][id], [key]: parseFloat(v) || 0 } } } }
  })
  // A plain function, not a component — a component defined in here would
  // remount its inputs on every keystroke and drop focus.
  const row = (key, label, sub, v, trade, id) => (
    <div key={key} style={{ display: 'contents' }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{label}{sub && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}> · {sub}</span>}</div>
      {['exceeds', 'meets', 'improvement'].map(k => (
        <input key={k} type="number" value={v?.[k] ?? ''} style={input} aria-label={`${label} ${sub || ''} ${k}`} onChange={e => setThr(trade, id, k, e.target.value)} />
      ))}
    </div>
  )
  return (
    <div style={{ ...panel, padding: '16px 20px', marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Technician scoring rules</div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Full-month targets — the current month is judged on pace</span>
        <span style={{ ...num, marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: total === 100 ? 'var(--tone-green-tx)' : 'var(--tone-red-tx)' }}>Weights total {total}%</span>
        <button className="btn sm primary" disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save rules'}</button>
      </div>
      <div className="mgrid" style={{ display: 'grid', gridTemplateColumns: `repeat(${KPIS.length}, minmax(90px, 1fr))`, gap: 10, marginBottom: 14 }}>
        {KPIS.map(k => (
          <div key={k.id}>
            <div style={{ ...eyebrow, marginBottom: 4 }}>{k.label} weight</div>
            <input type="number" min="0" max="100" value={rules.weights?.[k.id] ?? 0} style={input}
              onChange={e => setRules(r => ({ ...r, weights: { ...r.weights, [k.id]: e.target.value } }))} />
          </div>
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div className="mgrid" style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.4fr) repeat(3, minmax(80px, 1fr))', gap: '8px 12px', alignItems: 'center', minWidth: 520 }}>
          {['Target', 'Exceeds', 'Meets', 'Needs impr.'].map((h, i) => <div key={h} style={{ ...eyebrow, textAlign: i ? 'center' : 'left' }}>{h}</div>)}
          {row('close', 'Close rate (%)', 'all trades', rules.closeRate)}
          {TRADES.map(t => KPIS.filter(k => k.perTrade).map(k => row(t + k.id, `${k.label}${k.unit === '$' ? ' ($)' : ''}`, t, rules.byTrade?.[t]?.[k.id], t, k.id)))}
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 10 }}>Below “Needs impr.” rates Poor. Starting targets came from each trade’s own spread this month — adjust to your real goals.</div>
    </div>
  )
}

export default function TechScorecardsPanel() {
  const isMobile = useIsMobile()
  const [month, setMonth] = useState(null)
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [rules, setRules] = useState(null)
  const [savedRules, setSavedRules] = useState(null)
  const [rulesLoaded, setRulesLoaded] = useState(false)
  const [trade, setTrade] = useState('all')
  const [selected, setSelected] = useState(null)
  const [showRules, setShowRules] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    sb.from('app_settings').select('value').eq('key', RULES_KEY).maybeSingle()
      .then(({ data: r }) => { try { if (r?.value) setSavedRules(JSON.parse(r.value)) } catch {} setRulesLoaded(true) })
  }, [])

  useEffect(() => {
    let dead = false
    setErr('')
    ;(async () => {
      try {
        const { data: { session } } = await sb.auth.getSession()
        const r = await fetch(`/api/team/tech-scorecards${month ? `?month=${month}` : ''}`, { headers: { Authorization: `Bearer ${session?.access_token}` } })
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
        if (!dead) { setData(d); if (!month) setMonth(d.month) }
      } catch (e) { if (!dead) setErr(e.message) }
    })()
    return () => { dead = true }
  }, [month])

  // Saved rules win; otherwise start from this month's spread.
  useEffect(() => {
    if (rules || !data || !rulesLoaded) return
    const seeded = seedThresholds(data.techs || [], data.elapsed || 1)
    setRules(savedRules ? { ...seeded, ...savedRules, byTrade: { ...seeded.byTrade, ...(savedRules.byTrade || {}) } } : seeded)
  }, [data, savedRules, rules, rulesLoaded])

  const saveRules = async () => {
    setSaving(true)
    const { error } = await sb.from('app_settings').upsert({ key: RULES_KEY, value: JSON.stringify(rules), updated_at: new Date().toISOString() }, { onConflict: 'key' })
    setSaving(false)
    if (error) toast('Couldn’t save the rules: ' + error.message)
    else { setSavedRules(rules); toast('Technician scoring rules saved'); setShowRules(false) }
  }

  const elapsed = data?.elapsed || 1
  const techs = useMemo(() => (data?.techs || []).filter(t => trade === 'all' || t.trade === trade), [data, trade])
  const prevById = useMemo(() => new Map((data?.prevTechs || []).map(t => [t.id, t])), [data])
  const scored = useMemo(() => !rules ? [] : techs.map(t => ({
    t, s: scoreTech(rules, t, elapsed),
    p: prevById.has(t.id) ? scoreTech(rules, { ...prevById.get(t.id), trade: t.trade }, 1) : null,
  })).sort((a, b) => (b.s ?? -1) - (a.s ?? -1)), [techs, rules, elapsed, prevById])
  const vs = data?.prevMonth ? short(data.prevMonth) : ''
  const months = data?.months || []
  const mi = months.indexOf(month)
  const sel = scored.find(x => x.t.id === selected)

  if (err) return <div style={{ ...panel, padding: 30, textAlign: 'center', color: 'var(--danger)', fontSize: 13 }}>Couldn’t load technician scorecards: {err}</div>
  if (!data || !rules) return (
    <>
      <div className="skel" style={{ height: 150, borderRadius: 16, marginBottom: 18 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>{[0, 1, 2].map(i => <div key={i} className="skel" style={{ height: 240, borderRadius: 14 }} />)}</div>
    </>
  )

  const withScore = scored.filter(x => x.s != null)
  const teamAvg = withScore.length ? withScore.reduce((a, x) => a + x.s, 0) / withScore.length : null
  const prevList = withScore.filter(x => x.p != null)
  const teamPrev = prevList.length ? prevList.reduce((a, x) => a + x.p, 0) / prevList.length : null
  const lv = levelOf(teamAvg)
  const totals = {
    sold: techs.reduce((a, t) => a + t.sold, 0),
    opps: techs.reduce((a, t) => a + t.opps, 0), closed: techs.reduce((a, t) => a + t.closed, 0),
    memberships: techs.reduce((a, t) => a + t.memberships, 0), fiveStar: techs.reduce((a, t) => a + t.fiveStar, 0),
  }
  const divider = isMobile ? { borderTop: '1px solid var(--border)' } : { borderLeft: '1px solid var(--border)' }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <PillNav label={month ? monthName(month) : ''} onPrev={() => setMonth(months[mi + 1])} onNext={() => setMonth(months[mi - 1])}
          prevDisabled={mi < 0 || mi >= months.length - 1} nextDisabled={mi <= 0} />
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <Segmented value={trade} onChange={(v) => { setTrade(v); setSelected(null) }} options={[['all', 'All trades'], ...TRADES.map(t => [t, t])]} />
        </div>
        <select className="form-input" value={selected || ''} onChange={e => setSelected(e.target.value || null)} aria-label="Open a technician"
          style={{ width: isMobile ? '100%' : 210, borderRadius: 99, padding: '7px 14px' }}>
          <option value="">All technicians</option>
          {scored.map(x => <option key={x.t.id} value={x.t.id}>{x.t.name} · {x.t.trade}</option>)}
        </select>
        <button className={`btn${showRules ? ' primary' : ''}`} onClick={() => setShowRules(v => !v)} style={{ borderRadius: 99, marginLeft: isMobile ? 0 : 'auto' }}>Scoring rules</button>
      </div>

      {showRules && <RulesEditor rules={rules} setRules={setRules} onSave={saveRules} saving={saving} />}

      {data.isCurrent && elapsed < 1 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Month in progress — sold, clubs and reviews are judged on pace ({Math.round(elapsed * 100)}% of the month gone). Close rate is judged as is.
        </div>
      )}

      {sel ? (
        <div>
          <button className="btn ghost sm" onClick={() => setSelected(null)} style={{ marginBottom: 12 }}>← All technicians</button>
          <div style={{ ...panel, padding: isMobile ? 16 : '20px 22px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            <TechRing name={sel.t.name} score={sel.s} size={72} stroke={6} />
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.01em' }}>{sel.t.name}</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{sel.t.trade} service technician · {monthName(month)}</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <LevelChip level={levelOf(sel.s)} />
                <ScoreDelta now={sel.s} prev={sel.p} vs={vs} />
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={eyebrow}>Overall score</div>
              <div style={{ ...num, fontSize: 38, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-.03em', color: levelOf(sel.s) ? `var(--tone-${LEVELS[levelOf(sel.s)].tone}-tx)` : 'var(--text-muted)' }}>{sel.s == null ? '—' : sel.s.toFixed(2)}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>out of 4.00</div>
            </div>
          </div>
          <div style={{ ...panel, overflow: 'hidden' }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
              <b style={{ fontSize: 14, color: 'var(--text-primary)', marginRight: 10 }}>KPIs</b>
              From ServiceTitan — the same numbers as the department TV{data.asOf ? ` · updated ${new Date(data.asOf).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
            </div>
            {KPIS.map((k, i) => {
              const thr = thrFor(rules, k, sel.t.trade, elapsed)
              const v = sel.t[k.id]
              return (
                <div key={k.id} className="mgrid" style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(180px, 1.1fr) minmax(150px, .8fr) minmax(260px, 2fr)', gap: isMobile ? 10 : 20, alignItems: 'center', padding: '14px 20px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{k.label}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                      {Number(rules.weights?.[k.id]) || 0}% of the score{k.id === 'closeRate' ? ` · ${sel.t.closed} of ${sel.t.opps} opportunities` : k.paced && elapsed < 1 ? ' · targets on pace' : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ ...num, fontSize: 22, fontWeight: 800 }}>{fmtKpi(k, v)}</span>
                    <LevelChip level={rateKpi(k, v, thr)} small />
                  </div>
                  {thr ? <KpiTrack kpi={k} value={v} thr={thr} /> : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Set a target in Scoring rules</span>}
                </div>
              )
            })}
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
              {sel.t.jobs} jobs ran · {sel.t.soldCount} sales · avg ticket {fmtKpi({ unit: '$' }, sel.t.avgTicket)}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div style={{ ...panel, marginBottom: 18, display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(270px, 300px) minmax(0, 1fr) minmax(240px, 290px)' }}>
            <div style={{ padding: '20px 22px', display: 'flex', alignItems: 'center', gap: 18 }}>
              <Ring pct={teamAvg == null ? 0 : (teamAvg / 4) * 100} size={92} stroke={8} tone={lv ? LEVELS[lv].tone : 'gray'}>
                <div style={{ ...num, fontSize: 22, fontWeight: 800, color: lv ? `var(--tone-${LEVELS[lv].tone}-tx)` : 'var(--text-muted)' }}>{teamAvg == null ? '—' : teamAvg.toFixed(2)}</div>
              </Ring>
              <div>
                <div style={eyebrow}>{trade === 'all' ? 'Field team score' : `${trade} score`}</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 8px', whiteSpace: 'nowrap' }}>out of 4.00 · {withScore.length} technicians</div>
                <ScoreDelta now={teamAvg} prev={teamPrev} vs={vs} />
              </div>
            </div>
            <div style={{ padding: '18px 22px', minWidth: 0, ...divider }}>
              <div style={{ ...eyebrow, marginBottom: 12 }}>{data.isCurrent ? 'Month to date' : 'Month totals'}</div>
              {[
                ['Sold', fmtKpi({ unit: '$' }, totals.sold)],
                ['Close rate', totals.opps ? `${Math.round((totals.closed / totals.opps) * 100)}% · ${totals.closed}/${totals.opps}` : '—'],
                ['Memberships sold', totals.memberships],
                ['5★ reviews', totals.fiveStar],
              ].map(([l, v]) => (
                <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
                  <span style={{ fontWeight: 600 }}>{l}</span><span style={{ ...num, fontWeight: 700 }}>{v}</span>
                </div>
              ))}
            </div>
            <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, ...divider }}>
              <div style={eyebrow}>Where the team lands</div>
              {[4, 3, 2, 1].map(l => {
                const n = withScore.filter(x => levelOf(x.s) === l).length
                return (
                  <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ width: 150 }}><LevelChip level={l} small /></span>
                    <div style={{ flex: 1, height: 7, borderRadius: 99, background: 'var(--surface-2)', overflow: 'hidden' }}>
                      <div style={{ width: `${withScore.length ? (n / withScore.length) * 100 : 0}%`, height: '100%', background: `var(--tone-${LEVELS[l].tone}-tx)`, borderRadius: 99 }} />
                    </div>
                    <b style={{ ...num, fontSize: 13, width: 18, textAlign: 'right' }}>{n}</b>
                  </div>
                )
              })}
            </div>
          </div>
          {scored.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16, gridAutoRows: isMobile ? undefined : '1fr' }}>
              {scored.map(x => <TechCard key={x.t.id} t={x.t} score={x.s} prevScore={x.p} vs={vs} rules={rules} elapsed={elapsed} onOpen={() => setSelected(x.t.id)} />)}
            </div>
          ) : (
            <div style={{ ...panel, padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No technician numbers for this month yet.</div>
          )}
        </>
      )}
    </div>
  )
}
