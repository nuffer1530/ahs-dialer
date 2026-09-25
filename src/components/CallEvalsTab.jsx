import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useIsMobile } from '../lib/useIsMobile'
import EvalModal from './EvalModal'
import CoachingSnapshots, { Segmented, monthShort, sectionShort, critName } from './CoachingSnapshots'
import EvalList, { EvalSummary } from './EvalList'

// My Page → Call Evals. Reps see their own scored inbound calls; admins see
// the whole team with rep + month filters. Every row opens the full breakdown.

const monthNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit' })
    .formatToParts(new Date()).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}`
}

export default function CallEvalsTab({ profile, isAdmin, defaultView }) {
  const [month, setMonth] = useState(monthNow())
  const [repFilter, setRepFilter] = useState('')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('newest')   // newest | lowest | highest
  const [view, setView] = useState(defaultView || 'list')   // list | snapshots
  const [snap, setSnap] = useState(null)
  const [snapBusy, setSnapBusy] = useState(false)
  const [snapErr, setSnapErr] = useState('')
  // Phone layout (≤768px): filters pair up across rows, list rows stack the
  // summary under the name, and controls clear 40px for a thumb.
  const isMobile = useIsMobile()
  const tap = isMobile ? { minHeight: 40 } : undefined

  const loadSnapshots = async (refresh) => {
    setSnapBusy(true); setSnapErr('')
    try {
      const { data: { session } } = await sb.auth.getSession()
      const r = await fetch(`/api/admin/csr-coaching?month=${month}${refresh ? '&refresh=1' : ''}`,
        { headers: { Authorization: `Bearer ${session?.access_token}` } })
      const d = await r.json()
      if (r.ok) setSnap(d)
      else setSnapErr(d.error || `HTTP ${r.status}`)
    } catch (e) { setSnapErr(e.message) }
    setSnapBusy(false)
  }
  const openCsrEvals = (c) => {
    setView('list'); setSortBy('lowest')
    if (c.profileId) { setRepFilter(`id:${c.profileId}`); setSearch('') }
    else { setRepFilter(''); setSearch(c.name) }
  }
  // Load on first view and on month change — flipping back from All evals
  // keeps what's on screen instead of flashing the skeleton again.
  useEffect(() => { if (view === 'snapshots' && snap?.month !== month) { setSnap(null); loadSnapshots(false) } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, month])

  const printSnapshots = () => {
    if (!snap?.cards?.length) return
    const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const tm = snap.team || {}
    const vs = monthShort(tm.prevMonth)
    const delta = (now, prev) => (now == null || prev == null) ? '' : `<span class="dl">${now - prev > 0 ? '▲ +' : now - prev < 0 ? '▼ −' : '= '}${Math.abs(now - prev)} vs ${vs}</span>`
    const title = new Date(`${snap.month}-15T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    const html = `<html><head><title>CSR Coaching — ${title}</title><style>
      body{font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1c1b19;margin:28px;max-width:760px;font-size:12.5px}
      h1{font-size:21px;margin:0 0 4px;letter-spacing:-.01em} .sub{color:#6b6760;font-size:12px}
      .team{display:flex;gap:28px;border:1px solid #e2ded6;border-radius:12px;padding:14px 18px;margin:16px 0 18px}
      .big{font-size:30px;font-weight:800;line-height:1} .eb{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#9e9b96;margin-bottom:5px}
      .dl{font-size:11px;font-weight:700;color:#6b6760;margin-left:6px}
      .card{border:1px solid #e2ded6;border-radius:12px;padding:14px 18px;margin-bottom:12px;page-break-inside:avoid}
      .hd{display:flex;align-items:baseline;gap:8px} .nm{font-size:15px;font-weight:800;flex:1} .qa{font-size:20px;font-weight:800}
      .row{display:flex;gap:18px;margin:8px 0 4px;color:#6b6760} ul{margin:4px 0;padding-left:16px} li{margin:2px 0}
      .gap{display:flex;justify-content:space-between;border-bottom:1px dotted #e2ded6;padding:2px 0}
      .d{margin-top:8px;padding:8px 11px;background:#f0eee9;border-radius:8px}</style></head><body>
      <h1>CSR Coaching — ${esc(title)}</h1>
      <div class="sub">${tm.evals ?? snap.evalCount} evaluated calls · ${snap.cards.length} CSRs · printed ${new Date().toLocaleDateString()}</div>
      <div class="team"><div><div class="eb">Team QA</div><div class="big">${tm.qa ?? '—'}%</div>${delta(tm.qa, tm.prevQa)}</div>
        <div style="flex:1"><div class="eb">Where the team loses the most points</div>
          ${(tm.focus || []).map(f => `<div class="gap"><span>${esc(critName(f.criterion))}</span><span>missed ${f.missedOn}/${f.of}</span></div>`).join('')}</div></div>
      ${snap.cards.map(c => `<div class="card"><div class="hd"><span class="nm">${esc(c.name)}</span><span class="qa">${c.qa}%</span></div>
        <div class="sub">${c.evals} evaluated call${c.evals === 1 ? '' : 's'}${delta(c.qa, c.prevQa)}</div>
        ${(c.sections || []).length ? `<div class="row">${c.sections.map(x => `<span>${esc(sectionShort(x.name))} <b>${x.rate}%</b></span>`).join('')}</div>` : ''}
        ${(c.gaps || []).map(g => `<div class="gap"><span>${esc(critName(g.criterion))}</span><span>missed ${g.missedOn}/${g.of}</span></div>`).join('')}
        ${(c.working || []).length || (c.coach || []).length ? `<ul>${(c.working || []).map(w => `<li>✓ ${esc(w)}</li>`).join('')}${(c.coach || []).map(w => `<li>→ ${esc(w)}</li>`).join('')}</ul>` : ''}
        ${c.drill ? `<div class="d"><b>Drill for the next 1:1:</b> ${esc(c.drill)}</div>` : ''}
      </div>`).join('')}</body></html>`
    const w = window.open('', '_blank', 'width=820,height=940')
    w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 250)
  }
  const [allProfiles, setAllProfiles] = useState([])
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(null)

  useEffect(() => {
    if (isAdmin) sb.from('profiles').select('id, name, email, active').order('name').then(({ data }) => setAllProfiles(data || []))
  }, [isAdmin])

  // Every eval in the month, paged — the old .limit(500) quietly dropped the
  // rest and the "avg of 500 calls" header was an average of a slice.
  useEffect(() => {
    let dead = false
    setRows(null)
    ;(async () => {
      const [y, m] = month.split('-').map(Number)
      const start = new Date(y, m - 1, 1).toISOString()
      const end = new Date(y, m, 1).toISOString()
      const all = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from('call_evaluations').select('*')
          .gte('call_at', start).lt('call_at', end)
          .order('call_at', { ascending: false }).range(from, from + 999)
        if (error || !data) break
        all.push(...data)
        if (data.length < 1000) break
      }
      if (!dead) setRows(all)
    })()
    return () => { dead = true }
  }, [month])

  const coachingView = isAdmin && view === 'snapshots'
  if (rows === null && !coachingView) return <div className="spinner lg" style={{ margin: '50px auto' }} />

  // Deactivated reps leave the whole tab the moment they're deactivated —
  // matched by profile, or by name for ST-sweep evals with no profile link.
  const normKey = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const profiles = allProfiles.filter(p => p.active !== false)
  const departedIds = new Set(allProfiles.filter(p => p.active === false).map(p => p.id))
  const departedNames = new Set(allProfiles.filter(p => p.active === false)
    .flatMap(p => [p.name, (p.email || '').split('@')[0]]).filter(Boolean).map(normKey))
  const myName = profile?.name || profile?.email
  const shown = (rows || []).filter(r => {
    if (!isAdmin) return r.profile_id === profile?.id || r.rep === myName
    if (departedIds.has(r.profile_id) || (!r.profile_id && departedNames.has(normKey(r.rep)))) return false
    // Filter values are "id:<profile id>" or "name:<rep string>" — evals from
    // the ServiceTitan sweep carry the ST display name ("Alicia Ketter"), not
    // the Andi username ("alicia.ketter"), so matching by name alone missed.
    if (repFilter.startsWith('id:')) return r.profile_id === repFilter.slice(3)
    if (repFilter.startsWith('name:')) return r.rep === repFilter.slice(5) && !r.profile_id
    return true
  })
  // Dropdown: every Andi profile, plus any evaluated rep name that isn't
  // linked to a profile yet (so nobody's calls become invisible).
  const q = search.trim().toLowerCase()
  const searched = !q ? shown : shown.filter(r =>
    String(r.contact_name || '').toLowerCase().includes(q) ||
    String(r.rep || '').toLowerCase().includes(q) ||
    String(r.phone || '').includes(q.replace(/\D/g, '') || q) ||
    String(r.summary || '').toLowerCase().includes(q))
  const sorted = [...searched].sort((a, b) =>
    sortBy === 'lowest' ? (Number(a.pct) - Number(b.pct)) || (new Date(b.call_at || b.created_at) - new Date(a.call_at || a.created_at))
    : sortBy === 'highest' ? (Number(b.pct) - Number(a.pct)) || (new Date(b.call_at || b.created_at) - new Date(a.call_at || a.created_at))
    : new Date(b.call_at || b.created_at) - new Date(a.call_at || a.created_at))
  const liveRows = (rows || []).filter(r => !departedIds.has(r.profile_id) && (r.profile_id || !departedNames.has(normKey(r.rep))))
  const linkedIds = new Set(liveRows.map(r => r.profile_id).filter(Boolean))
  const unlinkedNames = [...new Set(liveRows.filter(r => !r.profile_id && r.rep).map(r => r.rep))].sort()
  const evalCountFor = (pid) => liveRows.filter(r => r.profile_id === pid).length

  return (
    <div>
      {/* Filter bar — on a phone: month + view share the first row, the rest
          pair up two to a row, and the average gets a row of its own. */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={isMobile ? { flex: '1 1 30%' } : undefined}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 4 }}>Month</div>
          <input type="month" className="form-input" value={month} onChange={e => e.target.value && setMonth(e.target.value)} style={tap} />
        </div>
        {isAdmin && (
          <div style={isMobile ? { flex: '1 1 60%' } : undefined}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 4 }}>View</div>
            <Segmented value={view} onChange={setView} options={[['snapshots', 'Coaching'], ['list', 'All evals']]} fill={isMobile} />
          </div>
        )}
        {isAdmin && view === 'list' && (
          <div style={isMobile ? { flex: '1 1 45%' } : undefined}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 4 }}>Rep</div>
            <select className="form-input" value={repFilter} onChange={e => setRepFilter(e.target.value)} style={{ minWidth: isMobile ? 0 : 160, ...tap }}>
              <option value="">Whole team</option>
              {profiles.map(p => (
                <option key={p.id} value={`id:${p.id}`}>
                  {p.name || p.email}{linkedIds.has(p.id) ? ` (${evalCountFor(p.id)})` : ''}
                </option>
              ))}
              {unlinkedNames.length > 0 && (
                <optgroup label="Not linked to an Andi profile">
                  {unlinkedNames.map(n => <option key={n} value={`name:${n}`}>{n}</option>)}
                </optgroup>
              )}
            </select>
          </div>
        )}
        <div style={isMobile ? { flex: '1 1 45%' } : undefined}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 4 }}>Search</div>
          <input className="form-input" value={search} onChange={e => setSearch(e.target.value)}
            placeholder={coachingView ? 'Find a CSR…' : 'Caller, rep, phone, or summary…'} style={{ minWidth: isMobile ? 0 : 200, ...tap }} />
        </div>
        {!coachingView && (
          <div style={isMobile ? { flex: '1 1 100%' } : undefined}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 4 }}>Sort</div>
            <Segmented value={sortBy} onChange={setSortBy} fill={isMobile}
              options={[['newest', 'Newest'], ['lowest', 'Lowest score'], ['highest', 'Highest score']]} />
          </div>
        )}
      </div>

      {coachingView ? (
        <CoachingSnapshots snap={snap} busy={snapBusy} error={snapErr} search={search} isMobile={isMobile}
          onRegenerate={() => loadSnapshots(true)} onPrint={printSnapshots} onOpen={openCsrEvals} />
      ) : sorted.length === 0 ? (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14 }}>
          {rows?.length ? 'No evaluated calls match these filters.' : 'No evaluated calls this month yet. Inbound calls over a minute are scored automatically a few minutes after they end.'}
        </div>
      ) : (
        <>
          <EvalSummary rows={sorted} isMobile={isMobile} />
          <EvalList rows={sorted} grouped={sortBy === 'newest'} isAdmin={isAdmin} isMobile={isMobile} onOpen={setOpen} />
        </>
      )}

      {open && <EvalModal evalRow={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
