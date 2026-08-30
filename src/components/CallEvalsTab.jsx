import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import EvalModal, { ScoreChip } from './EvalModal'

// My Page → Call Evals. Reps see their own scored inbound calls; admins see
// the whole team with rep + month filters. Every row opens the full breakdown.

const monthNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit' })
    .formatToParts(new Date()).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}`
}

export default function CallEvalsTab({ profile, isAdmin }) {
  const [month, setMonth] = useState(monthNow())
  const [repFilter, setRepFilter] = useState('')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('newest')   // newest | lowest | highest
  const [view, setView] = useState('list')         // list | snapshots
  const [snap, setSnap] = useState(null)
  const [snapBusy, setSnapBusy] = useState(false)

  const loadSnapshots = async (refresh) => {
    setSnapBusy(true)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const r = await fetch(`/api/admin/csr-coaching?month=${month}${refresh ? '&refresh=1' : ''}`,
        { headers: { Authorization: `Bearer ${session?.access_token}` } })
      const d = await r.json()
      if (r.ok) setSnap(d)
    } catch {}
    setSnapBusy(false)
  }
  useEffect(() => { if (view === 'snapshots') { setSnap(null); loadSnapshots(false) } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, month])

  const printSnapshots = () => {
    if (!snap?.cards?.length) return
    const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const html = `<html><head><title>CSR Coaching — ${snap.month}</title><style>
      body{font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#111;margin:32px;max-width:720px}
      h1{font-size:20px;margin:0 0 2px} .sub{color:#666;font-size:12px;margin-bottom:20px}
      .card{border:1px solid #ccc;border-radius:10px;padding:14px 18px;margin-bottom:14px;page-break-inside:avoid}
      .nm{font-size:15px;font-weight:800} .qa{float:right;font-size:15px;font-weight:800}
      .w{color:#15803d;font-size:12.5px;margin:3px 0} .c{color:#b45309;font-size:12.5px;margin:3px 0}
      .d{font-size:12.5px;margin-top:6px;padding:7px 10px;background:#f5f5f4;border-radius:8px}
      .mm{font-size:11px;color:#666;margin-top:6px}</style></head><body>
      <h1>CSR Coaching Snapshots — ${snap.month}</h1>
      <div class="sub">${snap.evalCount} evaluated calls · generated ${new Date(snap.generatedAt).toLocaleString()}</div>
      ${snap.cards.map(c => `<div class="card"><span class="qa">${c.qa}%</span><div class="nm">${esc(c.name)}</div>
        <div class="sub" style="margin-bottom:8px">${c.evals} evaluated call${c.evals === 1 ? '' : 's'}</div>
        ${(c.working || []).map(w => `<div class="w">✓ ${esc(w)}</div>`).join('')}
        ${(c.coach || []).map(w => `<div class="c">→ ${esc(w)}</div>`).join('')}
        ${c.drill ? `<div class="d"><b>Drill:</b> ${esc(c.drill)}</div>` : ''}
        ${(c.weakest || []).length ? `<div class="mm">Most missed: ${c.weakest.map(x => `${esc(x.criterion)} (${x.missedOn}/${x.of})`).join(' · ')}</div>` : ''}
      </div>`).join('')}</body></html>`
    const w = window.open('', '_blank', 'width=800,height=900')
    w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 250)
  }
  const [profiles, setProfiles] = useState([])
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(null)

  useEffect(() => {
    if (isAdmin) sb.from('profiles').select('id, name, email').eq('active', true).order('name').then(({ data }) => setProfiles(data || []))
  }, [isAdmin])

  useEffect(() => {
    const [y, m] = month.split('-').map(Number)
    const start = new Date(y, m - 1, 1).toISOString()
    const end = new Date(y, m, 1).toISOString()
    sb.from('call_evaluations').select('*')
      .gte('created_at', start).lt('created_at', end)
      .order('created_at', { ascending: false }).limit(500)
      .then(({ data }) => setRows(data || []))
  }, [month])

  if (rows === null) return <div className="spinner lg" style={{ margin: '50px auto' }} />

  const myName = profile?.name || profile?.email
  const shown = rows.filter(r => {
    if (!isAdmin) return r.profile_id === profile?.id || r.rep === myName
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
    sortBy === 'lowest' ? (Number(a.pct) - Number(b.pct)) || (new Date(b.created_at) - new Date(a.created_at))
    : sortBy === 'highest' ? (Number(b.pct) - Number(a.pct)) || (new Date(b.created_at) - new Date(a.created_at))
    : new Date(b.created_at) - new Date(a.created_at))
  const linkedIds = new Set(rows.map(r => r.profile_id).filter(Boolean))
  const unlinkedNames = [...new Set(rows.filter(r => !r.profile_id && r.rep).map(r => r.rep))].sort()
  const evalCountFor = (pid) => rows.filter(r => r.profile_id === pid).length
  const avg = searched.length ? Math.round(searched.reduce((s, r) => s + Number(r.pct || 0), 0) / searched.length) : null
  const avgTone = avg == null ? 'gray' : avg >= 90 ? 'green' : avg >= 75 ? 'amber' : 'red'

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 4 }}>Month</div>
          <input type="month" className="form-input" value={month} onChange={e => e.target.value && setMonth(e.target.value)} />
        </div>
        {isAdmin && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 4 }}>View</div>
            <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              {[['list', 'All evals'], ['snapshots', 'Coaching snapshots']].map(([k, l]) => (
                <button key={k} onClick={() => setView(k)}
                  style={{ padding: '8px 13px', fontSize: 12.5, fontWeight: 600, border: 'none', cursor: 'pointer',
                    background: view === k ? 'var(--accent)' : 'var(--surface)', color: view === k ? '#fff' : 'var(--text-secondary)' }}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}
        {isAdmin && view === 'list' && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 4 }}>Rep</div>
            <select className="form-input" value={repFilter} onChange={e => setRepFilter(e.target.value)} style={{ minWidth: 160 }}>
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
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 4 }}>Search</div>
          <input className="form-input" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Caller, rep, phone, or summary…" style={{ minWidth: 200 }} />
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 4 }}>Sort</div>
          <select className="form-input" value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ minWidth: 150 }}>
            <option value="newest">Newest first</option>
            <option value="lowest">Lowest score first</option>
            <option value="highest">Highest score first</option>
          </select>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: 26, fontWeight: 900, color: `var(--tone-${avgTone}-tx)`, lineHeight: 1 }}>{avg == null ? '—' : `${avg}%`}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>
            avg of {searched.length} evaluated call{searched.length === 1 ? '' : 's'} · feeds the Call Quality KPI
          </div>
        </div>
      </div>

      {isAdmin && view === 'snapshots' ? (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {snapBusy ? 'Building snapshots from this month\u2019s evaluations…' : snap ? `${snap.evalCount} evals distilled · generated ${new Date(snap.generatedAt).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button className="btn sm" disabled={snapBusy} onClick={() => loadSnapshots(true)}>Regenerate</button>
              <button className="btn sm primary" disabled={!snap?.cards?.length} onClick={printSnapshots}>Print</button>
            </div>
          </div>
          {snapBusy && !snap && <div className="spinner lg" style={{ margin: '40px auto' }} />}
          {snap && snap.cards.length === 0 && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No evaluations this month yet.</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
            {(snap?.cards || []).map(c => {
              const t = c.qa >= 90 ? 'green' : c.qa >= 75 ? 'amber' : 'red'
              const drill = () => {
                setView('list'); setSortBy('lowest')
                if (c.profileId) { setRepFilter(`id:${c.profileId}`); setSearch('') }
                else { setRepFilter(''); setSearch(c.name.replace(' (departed)', '')) }
              }
              return (
                <div key={c.name} onClick={drill} title="Open this CSR's evaluations, lowest scores first"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 800, flex: 1 }}>{c.name}</div>
                    <span style={{ fontSize: 16, fontWeight: 900, color: `var(--tone-${t}-tx)` }}>{c.qa}%</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>{c.evals} evaluated call{c.evals === 1 ? '' : 's'} · click to open their evals</div>
                  {(c.working || []).map((w, i) => <div key={i} style={{ fontSize: 12.5, color: 'var(--tone-green-tx)', lineHeight: 1.5, marginBottom: 3 }}>✓ {w}</div>)}
                  {(c.coach || []).map((w, i) => <div key={i} style={{ fontSize: 12.5, color: 'var(--tone-amber-tx)', lineHeight: 1.5, marginBottom: 3 }}>→ {w}</div>)}
                  {c.drill && (
                    <div style={{ fontSize: 12.5, marginTop: 8, padding: '8px 11px', background: 'var(--surface-2)', borderRadius: 8, lineHeight: 1.5 }}>
                      <b>Drill:</b> {c.drill}
                    </div>
                  )}
                  {(c.weakest || []).length > 0 && (
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.6 }}>
                      Most missed: {c.weakest.slice(0, 3).map(x => `${x.criterion} (${x.missedOn}/${x.of})`).join(' · ')}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ) : sorted.length === 0 ? (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          No evaluated calls this month yet. Inbound calls over a minute are scored automatically a few minutes after they end.
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          {sorted.map((r, i) => (
            <div key={r.id} onClick={() => setOpen(r)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer',
                borderBottom: i < sorted.length - 1 ? '1px solid var(--border)' : 'none' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <ScoreChip pct={r.pct} size="md" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.contact_name || (r.phone ? `(${String(r.phone).slice(0,3)}) ${String(r.phone).slice(3,6)}-${String(r.phone).slice(6)}` : 'Unknown caller')}
                  {isAdmin && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {r.rep || '—'}</span>}
                </div>
                {r.summary && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.summary}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                {new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </div>
            </div>
          ))}
        </div>
      )}

      {open && <EvalModal evalRow={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
