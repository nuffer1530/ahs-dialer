import { useState, useEffect, useRef, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { toast } from '../lib/dialogs'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useData } from '../lib/DataContext'
import { useIsMobile } from '../lib/useIsMobile'
import Modal from '../components/Modal'
import AvatarCropper from '../components/AvatarCropper'
import KnowledgeTab from '../components/KnowledgeTab'
import CallRoutingTab from '../components/CallRoutingTab'
import CallQATab from '../components/CallQATab'
import { OPS_DEFAULTS, invalidateOpsConfig, loadOpsConfig } from '../lib/opsConfig'
import { PageTabs, SummaryPanel, Stat, ToneChip, Face, eyebrow, panel, num } from '../components/ui'

// ── Settings' local kit ──────────────────────────────────────────────────────
// A settings section: the kit's 16px panel with a header row (title, a muted
// description, actions on the right) over a hairline divider. `flush` hands
// the body to the caller for divided rows and tables.
function Section({ title, desc, actions, children, flush, style, bodyStyle }) {
  const isMobile = useIsMobile()
  return (
    <section style={{ ...panel, flexShrink:0, overflow:'hidden', ...style }}>
      <div style={{ padding: isMobile ? '12px 14px' : '14px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        <div style={{ flex:'1 1 260px', minWidth:0 }}>
          <div style={{ fontSize:14.5, fontWeight:700, lineHeight:1.3 }}>{title}</div>
          {desc && <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2, lineHeight:1.5 }}>{desc}</div>}
        </div>
        {actions && <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', marginLeft:'auto' }}>{actions}</div>}
      </div>
      {flush ? children : <div style={{ padding: isMobile ? 14 : '16px 20px', ...bodyStyle }}>{children}</div>}
    </section>
  )
}

// Every save/status line on Settings reads the same: muted while working or
// idle, green once it worked, red when it didn't.
function SaveNote({ children, error, muted }) {
  if (!children) return null
  return (
    <span role="status" style={{ fontSize:12, fontWeight:600, lineHeight:1.4,
      color: muted ? 'var(--text-muted)' : error ? 'var(--tone-red-tx)' : 'var(--tone-green-tx)' }}>
      {children}
    </span>
  )
}

// A tinted callout for results and warnings that need more room than a SaveNote.
function Notice({ tone = 'amber', children, style }) {
  return (
    <div style={{ padding:'10px 14px', borderRadius:12, fontSize:12.5, lineHeight:1.5,
      background:`var(--tone-${tone}-bg)`, border:`1px solid var(--tone-${tone}-bd)`, color:`var(--tone-${tone}-tx)`, ...style }}>
      {children}
    </div>
  )
}

const ROLE_CHIP = { admin: ['blue', 'Admin'], dispatcher: ['purple', 'Dispatcher'], rep: ['gray', 'Rep'] }

const EMOJIS = {
  '🔥 Hype': ['🔥','⚡','💥','🚀','🎯','💪','👊','🏆','👑','💎','🌟','⭐','🔑','💰','🎰','🃏'],
  '😎 Personality': ['😎','🤙','😤','🥶','🤩','😏','🧠','👀','🫡','💯','🤝','🙌','🥳','😈','🤠','🫶'],
  '🦁 Animals': ['🦁','🐺','🦅','🐉','🦊','🐻','🦈','🐯','🦋','🦎','🐝','🐆','🦬','🦌','🐘','🦏'],
  '🏔️ Colorado': ['🏔️','🌊','🌵','🎿','🏕️','⛰️','🌄','🎣','🌲','❄️','🏂','🪂','🧗','🏞️','🌅','🎑'],
  '🏠 Home Services': ['🔧','🔨','⚙️','🛠️','💡','🔌','🚿','❄️','🔥','🏠','🪛','🔋','🪜','🧱','🪟','🚪'],
  '🎮 Fun': ['🎸','🎲','🎪','🎭','🎨','🎬','🎵','🍕','🌮','☕','🎉','🏋️','🎳','🎯','🏄','🤿'],
  '⚽ Sports': ['⚽','🏈','🏒','⛷️','🎽','🏊','🚴','🤸','🏋️','🥊','🎾','⛳','🏇','🛹','🤺','🥋'],
  '🌈 Vibes': ['🌈','🌙','☀️','🌊','🍀','🦄','🌸','🦋','✨','🔮','🪄','🧿','💫','🌺','🎆','🪩'],
}

// Payouts are per category and live in app_settings.job_category_payouts —
// never hardcode an amount in a label here, it only drifts from what's paid.
const JOB_CATEGORY_PAYOUTS_KEY = 'job_category_payouts'
const JOB_CATEGORIES = [
  { value:'non_commissionable', label:'Non-commissionable' },
  { value:'maintenance',        label:'Maintenance' },
  { value:'repair',             label:'Booked repair call' },
  { value:'free_estimate',      label:'Free estimate (from-list)' },
  { value:'other',              label:'Sold estimate / follow-up' },
]

function CommissionMapping() {
  const [cfg, setCfg] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [csrMap, setCsrMap] = useState({})    // profile_id -> st_user_id
  const [jobCats, setJobCats] = useState({})  // st_job_type_id -> category
  const [catAmts, setCatAmts] = useState({})  // category -> payout dollars
  const [memAmts, setMemAmts] = useState({})  // st_membership_type_id -> amount
  const [memSale, setMemSale] = useState({})  // st_membership_type_id -> { sale_task_id, sale_task_name, duration_billing_id }
  const [services, setServices] = useState([])   // pricebook items, the sale-task candidates
  const [svcQuery, setSvcQuery] = useState('membership') // the pricebook is ~1600 items; always search it
  const [svcMeta, setSvcMeta] = useState({ total: null, truncated: false })
  const [svcLoading, setSvcLoading] = useState(false)
  const [durations, setDurations] = useState({}) // st_membership_type_id -> duration/billing options
  const [jobSearch, setJobSearch] = useState('')
  const [busy, setBusy] = useState('')        // which section is saving
  const [savedMsg, setSavedMsg] = useState('')
  // Phone: each mapping row stacks its label over a full-width select.
  const isMobile = useIsMobile()

  useEffect(() => { load() }, [])

  // Search the pricebook for sale-task candidates. Defaults to "membership",
  // which surfaces the ACMP items; an unfiltered list would return an arbitrary
  // 200 of ~1600 and hide the very items you're looking for.
  useEffect(() => {
    const q = svcQuery.trim()
    if (!q) { setServices([]); setSvcMeta({ total: null, truncated: false }); return }
    let cancelled = false
    setSvcLoading(true)
    const t = setTimeout(() => {
      fetch(`/api/st/pricebook-services?q=${encodeURIComponent(q)}`)
        .then(r => r.json())
        .then(d => {
          if (cancelled) return
          setServices(d.data || [])
          setSvcMeta({ total: d.totalCount ?? null, truncated: !!d.truncated })
        })
        .catch(e => console.warn('pricebook search failed:', e))
        .finally(() => { if (!cancelled) setSvcLoading(false) })
    }, 350)
    return () => { cancelled = true; clearTimeout(t) }
  }, [svcQuery])

  // Duration/billing options are one ST call per membership type, so fetch them
  // lazily when the admin actually opens a term dropdown.
  const loadDurations = async (typeId) => {
    if (durations[typeId]) return
    try {
      const r = await fetch(`/api/st/membership-types/${typeId}/duration-billing`)
      const d = await r.json()
      if (r.ok) setDurations(prev => ({ ...prev, [typeId]: d.data || [] }))
    } catch (e) { console.warn('duration-billing load failed:', e) }
  }

  const load = async () => {
    setLoading(true); setErr('')
    try {
      const r = await fetch('/api/commission/config')
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Failed to load config')
      setCfg(d)
      // Sale-task candidates load via the search effect below, not here — the
      // pricebook is far too big to list unfiltered.
      // CSR map: saved first, then auto-match unmapped by name
      const cm = {}
      ;(d.csrUsers || []).forEach(u => { if (u.profile_id) cm[u.profile_id] = u.st_user_id })
      ;(d.profiles || []).forEach(p => {
        if (!cm[p.id]) {
          const m = (d.stEmployees || []).find(e => e.name && p.name && e.name.toLowerCase() === p.name.toLowerCase())
          if (m) cm[p.id] = m.id
        }
      })
      setCsrMap(cm)
      const jc = {}; (d.jobTypeSpiffs || []).forEach(j => { jc[j.st_job_type_id] = j.category }); setJobCats(jc)

      // Category payouts — the amounts the sync actually pays.
      const { data: cp } = await sb.from('app_settings').select('value').eq('key', JOB_CATEGORY_PAYOUTS_KEY).maybeSingle()
      if (cp?.value) { try { setCatAmts(JSON.parse(cp.value)) } catch { setCatAmts({}) } }
      const ma = {}, ms = {}
      ;(d.membershipTypeSpiffs || []).forEach(m => {
        ma[m.st_membership_type_id] = m.amount
        ms[m.st_membership_type_id] = {
          sale_task_id: m.sale_task_id || null,
          sale_task_name: m.sale_task_name || null,
          duration_billing_id: m.duration_billing_id || null,
        }
        // Preload terms for types already set up, so the saved value renders
        // as a label instead of an empty select.
        if (m.duration_billing_id) loadDurations(m.st_membership_type_id)
      })
      setMemAmts(ma); setMemSale(ms)
    } catch (e) { setErr(e.message) }
    setLoading(false)
  }

  const flash = (m) => { setSavedMsg(m); setTimeout(() => setSavedMsg(''), 2500) }

  const saveCsrs = async () => {
    setBusy('csr')
    try {
      const rows = Object.entries(csrMap).filter(([, uid]) => uid).map(([pid, uid]) => {
        const emp = cfg.stEmployees.find(e => String(e.id) === String(uid))
        return { profile_id: pid, st_user_id: uid, st_user_name: emp?.name || null }
      })
      const r = await fetch('/api/commission/csr-users', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rows }) })
      if (!r.ok) throw new Error((await r.json()).error || 'Save failed')
      flash('CSR mapping saved')
    } catch (e) { setErr(e.message) }
    setBusy('')
  }

  const saveCatAmts = async () => {
    setBusy('cats')
    try {
      // Store only categories that have a number — a blank must stay absent so
      // the sync leaves those jobs unsettled rather than paying $0.
      const clean = {}
      JOB_CATEGORIES.forEach(c => {
        const v = catAmts[c.value]
        if (v !== '' && v != null && !Number.isNaN(Number(v))) clean[c.value] = Number(v)
      })
      const { error } = await sb.from('app_settings').upsert(
        { key: JOB_CATEGORY_PAYOUTS_KEY, value: JSON.stringify(clean) }, { onConflict: 'key' })
      if (error) throw error
      flash('Category payouts saved')
    } catch (e) { setErr(e.message) }
    setBusy('')
  }

  const saveJobs = async () => {
    setBusy('jobs')
    try {
      const rows = cfg.stJobTypes.map(j => ({ st_job_type_id: j.id, name: j.name, category: jobCats[j.id] || 'non_commissionable' }))
      const r = await fetch('/api/commission/job-types', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rows }) })
      if (!r.ok) throw new Error((await r.json()).error || 'Save failed')
      flash('Job-type categories saved')
    } catch (e) { setErr(e.message) }
    setBusy('')
  }

  const saveMems = async () => {
    setBusy('mems')
    try {
      const rows = cfg.stMembershipTypes.map(m => ({
        st_membership_type_id: m.id, name: m.name, amount: memAmts[m.id] ?? 20,
        sale_task_id: memSale[m.id]?.sale_task_id || null,
        sale_task_name: memSale[m.id]?.sale_task_name || null,
        duration_billing_id: memSale[m.id]?.duration_billing_id || null,
      }))
      // Half a mapping can't sell — refuse rather than fail at the customer.
      const partial = rows.find(r => (r.sale_task_id && !r.duration_billing_id) || (!r.sale_task_id && r.duration_billing_id))
      if (partial) throw new Error(`${partial.name}: set both a sale task and a term, or neither.`)
      const r = await fetch('/api/commission/membership-types', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rows }) })
      if (!r.ok) throw new Error((await r.json()).error || 'Save failed')
      flash('Membership payouts saved')
    } catch (e) { setErr(e.message) }
    setBusy('')
  }

  if (loading) return (
    <div style={{ maxWidth:900, display:'flex', flexDirection:'column', gap:12 }}>
      <div style={{ fontSize:12.5, color:'var(--text-muted)' }}>Loading ServiceTitan data…</div>
      <div className="skel" style={{ height:180, borderRadius:16 }} />
      <div className="skel" style={{ height:180, borderRadius:16 }} />
    </div>
  )
  if (err && !cfg) return (
    <Notice tone="red" style={{ maxWidth:900, display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
      {err} <button onClick={load} className="btn sm" style={{ borderRadius:99 }}>Retry</button>
    </Notice>
  )

  const csrProfiles = (cfg.profiles || []).filter(p => p.role !== 'admin' || true) // show all; admins can be CSRs too
  const jobHits = cfg.stJobTypes.filter(j => j.name?.toLowerCase().includes(jobSearch.toLowerCase()))
  // Rows inside a section sit on hairline dividers; inputs match .form-input.
  const row = (i) => ({ padding: isMobile ? '10px 14px' : '9px 20px', borderTop: i ? '1px solid var(--border)' : 'none' })
  const selStyle = { padding:'6px 8px', border:'1px solid var(--border-strong)', borderRadius:10, fontSize:12, fontFamily:'inherit', background:'var(--surface)', color:'var(--text-primary)' }
  const moneyIn = { ...selStyle, width:90 }
  const searchIn = { ...selStyle, width:'100%', padding:'7px 14px', borderRadius:99, background:'var(--surface-2)' }
  const saveBtn = (onClick, key) => (
    <button onClick={onClick} disabled={busy===key} className="btn sm primary"
      style={{ borderRadius:99, minHeight: isMobile ? 40 : undefined, padding: isMobile ? '8px 18px' : '5px 16px' }}>
      {busy===key ? 'Saving…' : 'Save'}
    </button>
  )
  const footer = (btn) => (
    <div style={{ padding: isMobile ? '12px 14px' : '12px 20px', borderTop:'1px solid var(--border)', display:'flex', justifyContent:'flex-end' }}>{btn}</div>
  )

  return (
    <div style={{ maxWidth:900, display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        <div style={{ fontSize:12.5, color:'var(--text-muted)' }}>Map ServiceTitan data to commission rules. The reconciler uses these to attribute and pay spiffs.</div>
        <SaveNote>{savedMsg}</SaveNote>
      </div>
      {err && <Notice tone="red">{err}</Notice>}

      {/* CSR ↔ ST user */}
      <Section flush title="CSRs → ServiceTitan users"
        desc="Match each CSR to their ST login so jobs they book directly in ServiceTitan get attributed. Auto-matched by name where possible.">
        {csrProfiles.map((p, i) => (
          <div key={p.id} style={{ ...row(i), display:'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent:'space-between', gap: isMobile ? 4 : 12, flexDirection: isMobile ? 'column' : 'row' }}>
            <span style={{ fontSize:13, fontWeight:600 }}>{p.name || p.email}</span>
            <select value={csrMap[p.id] || ''} onChange={e => setCsrMap(m => ({ ...m, [p.id]: e.target.value ? Number(e.target.value) : '' }))} style={{ ...selStyle, minWidth: isMobile ? 0 : 240, minHeight: isMobile ? 40 : undefined }}>
              <option value="">— not mapped —</option>
              {cfg.stEmployees.map(e => <option key={e.id} value={e.id}>{e.name}{e.email ? ` (${e.email})` : ''}</option>)}
            </select>
          </div>
        ))}
        {footer(saveBtn(saveCsrs, 'csr'))}
      </Section>

      {/* Category → payout. This is what the sync actually pays. */}
      <Section flush title="Category payouts"
        desc={<>
          What each category pays a rep. This is the amount the sync uses — job types themselves carry no amount,
          only a category. A category left blank pays nothing and the job stays unsettled until you set it,
          so no payout is lost by filling this in late.
        </>}>
        {JOB_CATEGORIES.map((c, i) => (
          <div key={c.value} style={{ ...row(i), display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
            <span style={{ fontSize:13, fontWeight:600 }}>
              {c.label}
              <span style={{ ...num, fontSize:11.5, fontWeight:400, color:'var(--text-muted)', marginLeft:8 }}>
                {(cfg.jobTypeSpiffs || []).filter(j => j.category === c.value).length} job types
              </span>
            </span>
            <div style={{ display:'flex', alignItems:'center', gap:4 }}>
              <span style={{ fontSize:13, color:'var(--text-muted)' }}>$</span>
              <input type="number" step="0.01" min="0" value={catAmts[c.value] ?? ''} placeholder="—"
                onChange={e => setCatAmts(a => ({ ...a, [c.value]: e.target.value === '' ? '' : Number(e.target.value) }))}
                style={{ ...moneyIn, ...num }} />
            </div>
          </div>
        ))}
        {footer(saveBtn(saveCatAmts, 'cats'))}
      </Section>

      {/* Job type → category */}
      <Section flush title="Job types → spiff category"
        desc={<>
          Tag each ST job type — the category decides the payout. Anything left non-commissionable never pays.
          Every category pays when ServiceTitan marks the job <strong>completed</strong>, including the estimate
          categories: a free estimate that completes pays out whether or not it sold anything.
        </>}>
        <div style={{ padding: isMobile ? '12px 14px' : '12px 20px', borderBottom:'1px solid var(--border)' }}>
          <input value={jobSearch} onChange={e => setJobSearch(e.target.value)} placeholder="Search job types…" style={searchIn} />
        </div>
        <div style={{ maxHeight:340, overflowY:'auto' }}>
          {jobHits.map((j, i) => (
            <div key={j.id} style={{ ...row(i), display:'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent:'space-between', gap: isMobile ? 4 : 12, flexDirection: isMobile ? 'column' : 'row' }}>
              <span style={{ fontSize:12.5 }}>{j.name}</span>
              <select value={jobCats[j.id] || 'non_commissionable'} onChange={e => setJobCats(c => ({ ...c, [j.id]: e.target.value }))}
                style={{ ...selStyle, minWidth: isMobile ? 0 : 280, minHeight: isMobile ? 40 : undefined, color: (jobCats[j.id] && jobCats[j.id]!=='non_commissionable') ? 'var(--accent)' : 'var(--text-muted)', fontWeight: (jobCats[j.id] && jobCats[j.id]!=='non_commissionable') ? 600 : 400 }}>
                {JOB_CATEGORIES.map(c => (
                  <option key={c.value} value={c.value}>
                    {c.label}{catAmts[c.value] != null && catAmts[c.value] !== '' ? ` — $${Number(catAmts[c.value]).toFixed(2)}` : ''}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {jobHits.length === 0 && <div style={{ fontSize:12.5, color:'var(--text-muted)', padding: isMobile ? '12px 14px' : '12px 20px' }}>No job types match.</div>}
        </div>
        {footer(saveBtn(saveJobs, 'jobs'))}
      </Section>

      {/* Membership type → payout + how to sell it */}
      <Section flush title="Membership types → payout & sale setup"
        desc={<>
          Set the spiff for each ST membership type (e.g. Full $20, HVAC-only $10).
          To let reps <strong>sell</strong> a membership from the dialer, also pick its sale task and term —
          ServiceTitan can't tell us which pricebook item sells which membership, so it has to be set here once.
          <strong> Selling creates a real invoice for the customer.</strong>
        </>}>
        <div style={{ padding: isMobile ? '12px 14px' : '12px 20px' }}>
          <div style={{ ...eyebrow, marginBottom:5 }}>Search pricebook for sale tasks</div>
          <input value={svcQuery} onChange={e => setSvcQuery(e.target.value)} placeholder="e.g. membership, ACMP…" style={searchIn} />
          <div style={{ fontSize:11.5, color:'var(--text-muted)', marginTop:6, lineHeight:1.5 }}>
            {svcLoading ? 'Searching…'
              : svcMeta.truncated
                ? `Showing ${services.length} of ${svcMeta.total} matches — narrow the search to see the rest.`
                : `${services.length} match${services.length === 1 ? '' : 'es'}. Your pricebook has ~1,600 services, so this list is always filtered.`}
            {' '}Beware the <strong>Renewal</strong> variants — those renew an existing member rather than sell a new one.
          </div>
        </div>

        <div>
          {cfg.stMembershipTypes.map(m => {
            const sellable = memSale[m.id]?.sale_task_id && memSale[m.id]?.duration_billing_id
            return (
              <div key={m.id} style={{ padding: isMobile ? '12px 14px' : '14px 20px', borderTop:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:10 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
                  <span style={{ fontSize:13.5, fontWeight:700, display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', minWidth:0 }}>
                    {m.name}
                    <ToneChip tone={sellable ? 'green' : 'gray'} small>{sellable ? 'Sellable' : 'Payout only'}</ToneChip>
                  </span>
                  <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                    <span style={{ fontSize:13, color:'var(--text-muted)' }}>$</span>
                    <input type="number" step="0.01" value={memAmts[m.id] ?? ''} placeholder="0.00"
                      onChange={e => setMemAmts(a => ({ ...a, [m.id]: e.target.value === '' ? '' : Number(e.target.value) }))}
                      style={{ ...moneyIn, ...num }} />
                  </div>
                </div>

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div>
                    <div style={{ ...eyebrow, marginBottom:4 }}>Sale task (pricebook item)</div>
                    <select value={memSale[m.id]?.sale_task_id || ''}
                      onChange={e => {
                        const id = e.target.value
                        const svc = services.find(s => String(s.id) === String(id))
                        setMemSale(s => ({ ...s, [m.id]: { ...s[m.id], sale_task_id: id || null, sale_task_name: svc?.name || null } }))
                      }}
                      style={{ ...selStyle, width:'100%' }}>
                      <option value="">— not sellable from Andi —</option>
                      {/* A saved task may not be in the current search results —
                          keep it listed so selecting elsewhere can't wipe it. */}
                      {memSale[m.id]?.sale_task_id && !services.some(s => String(s.id) === String(memSale[m.id].sale_task_id)) && (
                        <option value={memSale[m.id].sale_task_id}>
                          {memSale[m.id].sale_task_name || `Task ${memSale[m.id].sale_task_id}`} (saved)
                        </option>
                      )}
                      {services.map(s => (
                        <option key={s.id} value={s.id}>{s.code ? `${s.code} — ` : ''}{s.name}{s.price ? ` ($${s.price})` : ''}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div style={{ ...eyebrow, marginBottom:4 }}>Term / billing</div>
                    <select value={memSale[m.id]?.duration_billing_id || ''}
                      onChange={e => setMemSale(s => ({ ...s, [m.id]: { ...s[m.id], duration_billing_id: e.target.value || null } }))}
                      onFocus={() => loadDurations(m.id)}
                      style={{ ...selStyle, width:'100%' }}>
                      <option value="">{durations[m.id] ? '— select a term —' : 'click to load…'}</option>
                      {(durations[m.id] || []).map(d => (
                        <option key={d.id} value={d.id}>
                          {d.duration ? `${d.duration}mo` : ''} {d.billingFrequency} {d.salePrice != null ? `— $${d.salePrice}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )
          })}
          {cfg.stMembershipTypes.length === 0 && <div style={{ fontSize:12.5, color:'var(--text-muted)', padding: isMobile ? '12px 14px' : '12px 20px', borderTop:'1px solid var(--border)' }}>No membership types returned from ServiceTitan.</div>}
        </div>
        {footer(saveBtn(saveMems, 'mems'))}
      </Section>
    </div>
  )
}

// Admin commission ledger. Rows are written by syncCommissions() in server.js
// when ServiceTitan reports a job Completed or a membership sold — nothing here
// computes a payout, it only reports what the sync recorded.
const ST_JOB_URL = (jobId) => `https://go.servicetitan.com/#/Job/Index/${jobId}`

const RANGES = {
  week:    { label: 'This week',   days: null },
  month:   { label: 'This month',  days: null },
  last30:  { label: 'Last 30 days', days: 30 },
  last90:  { label: 'Last 90 days', days: 90 },
  all:     { label: 'All time',    days: null },
}

function rangeBounds(key) {
  const now = new Date()
  if (key === 'week') {
    const d = now.getDay()
    const monday = new Date(now)
    monday.setDate(now.getDate() - (d === 0 ? 6 : d - 1))
    monday.setHours(0, 0, 0, 0)
    return { start: monday, end: null }
  }
  if (key === 'month') return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: null }
  if (key === 'all') return { start: new Date(0), end: null }
  const s = new Date(now)
  s.setDate(s.getDate() - RANGES[key].days)
  return { start: s, end: null }
}

// Editor for the Call Center TV ticker — the scrolling messages/alerts on the
// wallboard. Stored in app_settings.warroom_ticker; the TV polls it.
function FloorTicker() {
  const [enabled, setEnabled] = useState(false)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    sb.from('app_settings').select('value').eq('key', 'warroom_ticker').maybeSingle().then(({ data }) => {
      try {
        const v = JSON.parse(data?.value || '{}')
        setEnabled(!!v.enabled)
        setMessages(Array.isArray(v.messages) ? v.messages : [])
      } catch { /* first run */ }
      setLoading(false)
    })
  }, [])

  const save = async (nextEnabled, nextMessages) => {
    setSaving(true)
    const clean = nextMessages.map(m => ({ text: (m.text || '').trim(), tone: m.tone || 'info' })).filter(m => m.text)
    const { error } = await sb.from('app_settings').upsert(
      { key: 'warroom_ticker', value: JSON.stringify({ enabled: nextEnabled, messages: clean }) }, { onConflict: 'key' })
    setSaving(false)
    setMsg(error ? `Error: ${error.message}` : '✓ Saved — live on the TV within ~15s')
    setTimeout(() => setMsg(''), 4000)
  }

  const addLine = () => setMessages(m => [...m, { text: '', tone: 'info' }])
  const setLine = (i, patch) => setMessages(m => m.map((x, j) => j === i ? { ...x, ...patch } : x))
  const removeLine = (i) => setMessages(m => m.filter((_, j) => j !== i))

  if (loading) return <div className="skel" style={{ height:220, borderRadius:16, maxWidth:760 }} />

  const TONES = [
    { id:'info', label:'Info', color:'var(--text-primary)' },
    { id:'success', label:'Good news', color:'var(--tone-green-tx)' },
    { id:'alert', label:'Alert', color:'var(--tone-red-tx)' },
  ]

  return (
    <Section title="Call Center TV — floor ticker" style={{ maxWidth:760 }}
      desc="Messages scroll across the top of the Call Center TV. Use Alert (red) for anything urgent to the floor."
      actions={<SaveNote error={msg.startsWith('Error')}>{msg}</SaveNote>}
      bodyStyle={{ display:'flex', flexDirection:'column', gap:16 }}>
      <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer' }}>
        <div onClick={() => { const v = !enabled; setEnabled(v); save(v, messages) }}
          style={{ width:40, height:22, borderRadius:99, background: enabled ? 'var(--accent)' : 'var(--border-strong)', position:'relative', transition:'background .15s', flexShrink:0 }}>
          <div style={{ position:'absolute', top:2, left: enabled ? 20 : 2, width:18, height:18, borderRadius:'50%', background:'#fff', transition:'left .15s' }} />
        </div>
        <span style={{ fontSize:13, fontWeight:600 }}>{enabled ? 'Ticker on' : 'Ticker off'}</span>
      </label>

      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display:'flex', gap:8, alignItems:'center' }}>
            <select value={m.tone || 'info'} onChange={e => setLine(i, { tone: e.target.value })}
              style={{ padding:'7px 8px', border:'1px solid var(--border-strong)', borderRadius:10, fontSize:12, fontFamily:'inherit', background:'var(--surface)', color:'var(--text-primary)', flexShrink:0 }}>
              {TONES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <input className="form-input" value={m.text} placeholder="Message to the floor…"
              onChange={e => setLine(i, { text: e.target.value })}
              style={{ flex:1, borderLeft:`3px solid ${TONES.find(t => t.id === (m.tone||'info'))?.color}` }} />
            <button className="btn sm danger" onClick={() => removeLine(i)}>Remove</button>
          </div>
        ))}
        {messages.length === 0 && <div style={{ fontSize:12.5, color:'var(--text-muted)' }}>No messages. Add one to show a ticker on the TV.</div>}
      </div>

      <div style={{ display:'flex', gap:8 }}>
        <button className="btn sm" onClick={addLine} style={{ borderRadius:99 }}>+ Add message</button>
        <button className="btn sm primary" onClick={() => save(enabled, messages)} disabled={saving} style={{ marginLeft:'auto', borderRadius:99, padding:'5px 16px' }}>
          {saving ? 'Saving…' : 'Save ticker'}
        </button>
      </div>
    </Section>
  )
}

export default function AdminPage() {
  const { profile, isAdmin, isOpsManager, refreshProfile } = useAuth()
  const { campaigns } = useData()
  const isMobile = useIsMobile()
  const [settingsTab, setSettingsTab] = useState(() => new URLSearchParams(window.location.search).get('tab') || 'users')
  // Survive hard refresh: the active tab lives in the URL (?tab=), like MyPage.
  useEffect(() => {
    const u = new URL(window.location)
    if (u.searchParams.get('tab') !== settingsTab) { u.searchParams.set('tab', settingsTab); window.history.replaceState({}, '', u) }
  }, [settingsTab])
  const [showMapping, setShowMapping] = useState(false)
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [editProfile, setEditProfile] = useState(null)
  const [csrCampaigns, setCsrCampaigns] = useState([])
  const [saving, setSaving] = useState(false)
  // Password change
  const [pwModal, setPwModal] = useState(null) // { profileId, name } or 'me'
  const [busyUser, setBusyUser] = useState(null) // profile id mid deactivate/reactivate
  const [showRemoved, setShowRemoved] = useState(false)
  // Thresholds tab (Settings → Thresholds)
  const [opsForm, setOpsForm] = useState(null)
  const [wxLocs, setWxLocs] = useState(null)
  const [wxQuery, setWxQuery] = useState('')
  const [wxSugs, setWxSugs] = useState([])
  const [opsMsg, setOpsMsg] = useState('')
  const [digestBusy, setDigestBusy] = useState(false)
  const [digestMsg, setDigestMsg] = useState('')
  const [digestTo, setDigestTo] = useState('')
  const [digestToSaving, setDigestToSaving] = useState(false)
  useEffect(() => {
    sb.from('app_settings').select('value').eq('key', 'daily_digest_to').maybeSingle()
      .then(({ data }) => setDigestTo(String(data?.value || '').replace(/^"|"$/g, '')))
  }, [])
  const [opsSaving, setOpsSaving] = useState(false)
  const [opsDirty, setOpsDirty] = useState(false)
  // 🎯 Opportunity Watch Bonus config — read by the server's 10-min sweep.
  const [oppInc, setOppInc] = useState(null)
  const [oppIncSaved, setOppIncSaved] = useState(false)
  useEffect(() => {
    sb.from('app_settings').select('value').eq('key', 'opp_watch_incentive').maybeSingle().then(({ data }) => {
      let v = { enabled: false, pool: 100, cutoff: '15:00' }
      try { v = { ...v, ...JSON.parse(data?.value || '{}') } } catch {}
      setOppInc(v)
    })
  }, [])
  const saveOppInc = async () => {
    await sb.from('app_settings').upsert({ key: 'opp_watch_incentive', value: JSON.stringify(oppInc) }, { onConflict: 'key' })
    setOppIncSaved(true); setTimeout(() => setOppIncSaved(false), 2500)
  }

  // Company directory — numbers every CSR can dial from Manual Dial.
  const [directory, setDirectory] = useState(null)
  const [dirSaving, setDirSaving] = useState(false)
  const [dirMsg, setDirMsg] = useState('')
  useEffect(() => {
    if (settingsTab !== 'users' || !isAdmin || directory !== null) return
    sb.from('app_settings').select('value').eq('key', 'company_directory').maybeSingle().then(({ data }) => {
      let d = []
      try { d = JSON.parse(data?.value || '[]') } catch {}
      setDirectory(Array.isArray(d) ? d : [])
    })
  }, [settingsTab, isAdmin, directory])
  const saveDirectory = async () => {
    setDirSaving(true)
    const clean = (directory || [])
      .map(d => ({ name: (d.name || '').trim(), number: (d.number || '').trim(), label: (d.label || '').trim() }))
      .filter(d => d.name && d.number)
    await sb.from('app_settings').upsert({ key: 'company_directory', value: JSON.stringify(clean) }, { onConflict: 'key' })
    setDirectory(clean)
    setDirSaving(false)
    setDirMsg('Saved — live in every dialpad'); setTimeout(() => setDirMsg(''), 3000)
  }
  // Invite by email
  const [invEmail, setInvEmail] = useState('')
  const [invRole, setInvRole] = useState('rep')
  const [invBusy, setInvBusy] = useState(false)
  const [invMsg, setInvMsg] = useState(null)   // { ok, text, link? }
  const [newPw, setNewPw] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [savingPw, setSavingPw] = useState(false)
  // Manual commission adjustment
  const [commAdjModal, setCommAdjModal] = useState(null) // { profileId, name }
  const [commAdjAmount, setCommAdjAmount] = useState('')
  const [commAdjNote, setCommAdjNote] = useState('')
  const [savingAdj, setSavingAdj] = useState(false)
  // Inline adjustment on commission tab
  const [adjProfileId, setAdjProfileId] = useState('')
  const [adjAmount, setAdjAmount] = useState('')
  const [adjNote, setAdjNote] = useState('')
  const [adjSaving, setAdjSaving] = useState(false)
  // Status customization
  const [customStatuses, setCustomStatuses] = useState([
    { id:'Inbound', label:'Inbound', color:'#16a34a', locked:true },
    { id:'Available', label:'Available', color:'#22c55e', locked:true },
    { id:'On Call', label:'On Call', color:'#3b82f6', locked:true },
    { id:'Wrap Up', label:'Wrap Up', color:'#f59e0b', locked:true },
    { id:'Break', label:'Break', color:'#a855f7', locked:false },
    { id:'Lunch', label:'Lunch', color:'#f97316', locked:false },
    { id:'Offline', label:'Offline', color:'#6b7280', locked:true },
  ])
  const [savingStatuses, setSavingStatuses] = useState(false)
  const [commissionHistory, setCommissionHistory] = useState([])

  // Scorecard state
  const _now = new Date()
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const [allRepEarnings, setAllRepEarnings] = useState([])
  const [commLoading, setCommLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [myName, setMyName] = useState(profile?.name || '')
  const [myAvatar, setMyAvatar] = useState(profile?.avatar || null)
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')
  const [showAvatarPicker, setShowAvatarPicker] = useState(false)
  const [pickerSelected, setPickerSelected] = useState(null)
  const [cropSrc, setCropSrc] = useState(null)   // image being cropped

  useEffect(() => {
    setMyName(profile?.name || '')
    setMyAvatar(profile?.avatar || null)
  }, [profile])

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return }
    Promise.all([
      sb.from('profiles').select('*').order('name'),
      sb.from('csr_campaigns').select('*'),
    ]).then(([{ data: profilesData }, { data: csrCampData }]) => {
      setProfiles(profilesData || [])
      setCsrCampaigns(csrCampData || [])
      setLoading(false)
    })
  }, [isAdmin])

  useEffect(() => {
    if (settingsTab !== 'ops' || !isAdmin || opsForm) return
    ;(async () => {
      const { data } = await sb.from('app_settings').select('key, value').in('key', ['ops_config', 'weather_locations'])
      const parse = (k) => { try { return JSON.parse(data?.find(r => r.key === k)?.value || 'null') } catch { return null } }
      setOpsForm({ ...OPS_DEFAULTS, ...(parse('ops_config') || {}) })
      const locs = parse('weather_locations')
      setWxLocs(Array.isArray(locs) && locs.length ? locs : [
        { key: 'COS', name: 'Colorado Springs', lat: 38.8339, lng: -104.8214 },
        { key: 'Pueblo', name: 'Pueblo', lat: 38.2544, lng: -104.6091 },
        { key: 'Castle Rock', name: 'Castle Rock', lat: 39.3722, lng: -104.8561 },
      ])
    })()
  }, [settingsTab, isAdmin, opsForm])

  const saveOps = async () => {
    setOpsSaving(true)
    try {
      await sb.from('app_settings').upsert({ key: 'ops_config', value: JSON.stringify(opsForm) }, { onConflict: 'key' })
      await sb.from('app_settings').upsert({ key: 'weather_locations', value: JSON.stringify(wxLocs) }, { onConflict: 'key' })
      invalidateOpsConfig(); await loadOpsConfig(true)
      setOpsMsg('Saved — live on next page load; weather strip within 15 min')
    } catch (e) { setOpsMsg('Error: ' + e.message) }
    setOpsSaving(false)
  }
  // Autosave: edits mark the form dirty; a beat after the last keystroke it
  // writes itself. No Save button to forget.
  useEffect(() => {
    if (!opsDirty || !opsForm || !wxLocs) return
    const t = setTimeout(() => { setOpsDirty(false); saveOps() }, 900)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opsDirty, opsForm, wxLocs])

  const wxSearch = async (q) => {
    setWxQuery(q)
    if (q.trim().length < 3) { setWxSugs([]); return }
    try {
      const { data: { session } } = await sb.auth.getSession()
      const r = await fetch(`/api/dispatch/geocode-suggest?q=${encodeURIComponent(q.trim())}&types=place,locality,address`,
        { headers: { Authorization: `Bearer ${session?.access_token}` } })
      const d = await r.json()
      setWxSugs(d.suggestions || [])
    } catch { setWxSugs([]) }
  }

  const sendInvite = async () => {
    const email = invEmail.trim()
    if (!email) return
    setInvBusy(true); setInvMsg(null)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const r = await fetch('/api/admin/user/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ email, role: invRole }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Invite failed')
      if (d.emailed) {
        setInvMsg({ ok: true, text: d.resent
          ? `${email} already had a pending invite — a fresh link was emailed (the old one expired).`
          : `Invite emailed to ${email} — they'll set their own name and password.` })
      } else {
        // The account and link exist even though the email bounced — hand the
        // admin the link so they can text/DM it instead of dead-ending.
        setInvMsg({ ok: true, text: `Invite created, but the email failed (${d.emailError || 'unknown'}). Send them this link yourself:`, link: d.link })
      }
      setInvEmail('')
      const { data: profilesData } = await sb.from('profiles').select('*').order('name')
      setProfiles(profilesData || [])
    } catch (e) {
      setInvMsg({ ok: false, text: e.message })
    }
    setInvBusy(false)
  }

  // Load saved statuses
  useEffect(() => {
    sb.from('app_settings').select('value').eq('key', 'custom_statuses').maybeSingle()
      .then(({ data }) => {
        if (data?.value) {
          try { setCustomStatuses(JSON.parse(data.value)) } catch (e) {}
        }
      })
  }, [])


  // Load commission data
  useEffect(() => {
    if (settingsTab !== 'commission') return
    setCommLoading(true)
    const today = new Date().toISOString().split('T')[0]
    const dow = new Date().getDay()
    const monday = new Date()
    monday.setDate(monday.getDate() - (dow === 0 ? 6 : dow - 1))
    monday.setHours(0,0,1,0)

    Promise.all([
      sb.from('commissions').select('*, profiles!profile_id(name)').gte('earned_at', monday.toISOString()).order('earned_at', { ascending: false }),
    ]).then(([{ data: history }]) => {
      setCommissionHistory(history || [])

      // Aggregate by rep for admin view
      const byRep = {}
      ;(history || []).forEach(c => {
        const name = c.profiles?.name || c.rep_name || 'Unknown'
        if (!byRep[name]) byRep[name] = { daily: 0, weekly: 0, bookings: 0, memberships: 0 }
        const earned = parseFloat(c.amount)
        byRep[name].weekly += earned
        if (new Date(c.earned_at).toISOString().split('T')[0] === today) byRep[name].daily += earned
        if (c.event_type === 'booking') byRep[name].bookings++
        if (c.event_type === 'membership') byRep[name].memberships++
      })
      setAllRepEarnings(Object.entries(byRep).sort((a,b) => b[1].weekly - a[1].weekly))
      setCommLoading(false)
    })
  }, [settingsTab])


  const changePassword = async () => {
    if (!newPw || newPw.length < 6) { setPwMsg('Password must be at least 6 characters'); return }
    setSavingPw(true); setPwMsg('')
    try {
      if (pwModal === 'me' || pwModal?.profileId === profile?.id) {
        // Change own password via Supabase auth
        const { error } = await sb.auth.updateUser({ password: newPw })
        if (error) throw error
      } else {
        // Admin changing someone else's password via admin API
        const { error } = await sb.functions.invoke('admin-change-password', {
          body: { userId: pwModal.profileId, newPassword: newPw }
        })
        if (error) throw error
      }
      setPwMsg('✓ Password changed successfully!')
      setNewPw('')
      setTimeout(() => { setPwModal(null); setPwMsg('') }, 2000)
    } catch (e) {
      setPwMsg('Error: ' + e.message)
    } finally { setSavingPw(false) }
  }

  const statusDebounceRef = useRef(null)
  const [statusSaveMsg, setStatusSaveMsg] = useState('')

  const saveStatuses = async (statuses) => {
    setSavingStatuses(true)
    try {
      const { error } = await sb.from('app_settings').upsert(
        { key: 'custom_statuses', value: JSON.stringify(statuses), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      )
      if (error) throw error
      setStatusSaveMsg('Saved')
      setTimeout(() => setStatusSaveMsg(''), 2000)
    } catch (e) {
      setStatusSaveMsg('Error: ' + e.message)
    } finally {
      setSavingStatuses(false)
    }
  }

  const updateStatuses = (updater) => {
    setCustomStatuses(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      // Debounced auto-save
      if (statusDebounceRef.current) clearTimeout(statusDebounceRef.current)
      statusDebounceRef.current = setTimeout(() => saveStatuses(next), 600)
      return next
    })
  }

  const addCommissionAdjustment = async () => {
    if (!commAdjAmount || isNaN(parseFloat(commAdjAmount))) { return }
    setSavingAdj(true)
    try {
      await sb.from('commissions').insert({
        profile_id: commAdjModal.profileId,
        event_type: 'adjustment',
        amount: parseFloat(commAdjAmount),
        rep_name: commAdjModal.name,
        contact_name: 'Manual adjustment',
        also_membership: false,
        membership_amount: 0,
        notes: commAdjNote || 'Admin manual adjustment',
        earned_at: new Date().toISOString(),
      })
      setCommAdjModal(null); setCommAdjAmount(''); setCommAdjNote('')
      setMsg('✓ Commission adjustment added!')
      setTimeout(() => setMsg(''), 3000)
    } catch (e) {
      setMsg('Error: ' + e.message)
    } finally { setSavingAdj(false) }
  }

  const addInlineAdjustment = async () => {
    if (!adjProfileId || !adjAmount || isNaN(parseFloat(adjAmount))) return
    setAdjSaving(true)
    const rep = profiles.find(p => p.id === adjProfileId)
    const amount = parseFloat(adjAmount)
    try {
      const payload = {
        profile_id: adjProfileId,
        event_type: 'adjustment',
        amount,
        rep_name: rep?.name || rep?.email || 'Unknown',
        contact_name: 'Manual adjustment',
        also_membership: false,
        membership_amount: 0,
        notes: adjNote || 'Admin manual adjustment',
        earned_at: new Date().toISOString(),
      }
      // Try with updated_by first; if column doesn't exist yet, retry without
      let data, error
      const r1 = await sb.from('commissions').insert({ ...payload, updated_by: profile.id }).select('*, profiles!profile_id(name)').single()
      if (r1.error && r1.error.message?.includes('updated_by')) {
        const r2 = await sb.from('commissions').insert(payload).select('*, profiles!profile_id(name)').single()
        data = r2.data; error = r2.error
      } else {
        data = r1.data; error = r1.error
      }
      if (error) throw error
      // Attach the current admin's name for immediate display
      if (data) {
        data._updaterName = profile?.name || profile?.email || 'Admin'
        setCommissionHistory(prev => [data, ...prev])
        // Update allRepEarnings too
        setAllRepEarnings(prev => {
          const name = rep?.name || rep?.email || 'Unknown'
          return prev.map(([n, d]) => n === name ? [n, { ...d, weekly: d.weekly + amount, daily: d.daily + amount }] : [n, d])
        })
      }
      setAdjAmount(''); setAdjNote('')
      setMsg('Adjustment added!')
      setTimeout(() => setMsg(''), 3000)
    } catch (e) {
      setMsg('Error: ' + e.message)
    } finally { setAdjSaving(false) }
  }

  // Persist the current user's profile. Overrides let auto-save pass the new
  // value without waiting for a state round-trip. Also updates the profiles
  // array so the User Management row for yourself reflects the change with no
  // page refresh.
  const saveMyProfile = async ({ avatar, name } = {}) => {
    const av = avatar !== undefined ? avatar : myAvatar
    const nm = name !== undefined ? name : myName
    setSavingProfile(true)
    await sb.from('profiles').update({ name: nm, avatar: av }).eq('id', profile.id)
    await refreshProfile()
    setProfiles(prev => prev.map(p => p.id === profile.id ? { ...p, name: nm, avatar: av } : p))
    setProfileMsg('Saved')
    setTimeout(() => setProfileMsg(''), 2000)
    setSavingProfile(false)
  }

  // Picking an avatar (emoji or cropped photo) saves immediately — no separate
  // "Save profile" click.
  const confirmAvatar = () => {
    const chosen = pickerSelected
    setShowAvatarPicker(false)
    setPickerSelected(null)
    if (chosen) { setMyAvatar(chosen); saveMyProfile({ avatar: chosen }) }
  }

  const onAvatarFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''   // allow re-selecting the same file
    if (!file) return
    if (!file.type?.startsWith('image/')) { toast('Please choose an image file.'); return }
    const reader = new FileReader()
    reader.onload = () => setCropSrc(reader.result)   // open the crop tool
    reader.onerror = () => toast('Could not read that file.')
    reader.readAsDataURL(file)
  }

  const saveProfile = async () => {
    if (!editProfile) return
    setSaving(true)
    try {
      // home_view only means something for admins and dispatchers (HomePage).
      const homeView = ['admin', 'dispatcher'].includes(editProfile.role) ? (editProfile.home_view || null) : null
      let { error } = await sb.from('profiles').update({ name: editProfile.name, role: editProfile.role, inbound_skill: !!editProfile.inbound_skill, dispatch_skill: !!editProfile.dispatch_skill, manager_id: editProfile.manager_id || null, home_view: homeView }).eq('id', editProfile.id)
      // dispatch_skill is a newer column — retry without it pre-migration.
      if (error) ({ error } = await sb.from('profiles').update({ name: editProfile.name, role: editProfile.role, inbound_skill: !!editProfile.inbound_skill, manager_id: editProfile.manager_id || null }).eq('id', editProfile.id))
      // Push the skill change onto their TaskRouter worker right away.
      fetch('/api/twilio/worker-activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: editProfile.id, skillsOnly: true }) }).catch(() => {})
      if (error) throw error
      const { data } = await sb.from('profiles').select('*').eq('id', editProfile.id).maybeSingle()
      if (data) setProfiles(prev => prev.map(p => p.id === data.id ? data : p))
      await sb.from('csr_campaigns').delete().eq('profile_id', editProfile.id)
      const toInsert = editProfile.campaigns.filter(c => c.active).map(c => ({ profile_id: editProfile.id, campaign_id: c.campaign_id, priority: c.priority, active: true }))
      if (toInsert.length > 0) await sb.from('csr_campaigns').insert(toInsert)
      const { data: csrCampData } = await sb.from('csr_campaigns').select('*')
      setCsrCampaigns(csrCampData || [])
      setMsg(`✓ ${editProfile.name || editProfile.email} updated successfully`)
      setTimeout(() => setMsg(''), 3000)
      await refreshProfile()
    } catch (e) {
      setMsg('Error: ' + e.message)
    } finally {
      setSaving(false)
      setEditProfile(null)
    }
  }

  // User removal runs server-side: revoking a login and releasing leads needs
  // the service key, and the anon key has no delete/deactivate rights on
  // profiles by design.
  const setUserActive = async (p, active) => {
    const label = p.name || p.email
    if (active) {
      if (!confirm(`Restore access for ${label}? They'll be able to log in again. Campaign assignments were cleared when they were removed and need to be set again.`)) return
    } else {
      if (!confirm(`Remove ${label}?\n\nThey'll be signed out and blocked from logging in, and will disappear from Live, Attendance and campaign assignment. Any leads they've claimed go back into the pool.\n\nTheir call history and commissions are kept, and you can restore them later.`)) return
    }

    setBusyUser(p.id)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch(`/api/admin/user/${active ? 'reactivate' : 'deactivate'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ userId: p.id }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`)

      setProfiles(prev => prev.map(x => x.id === p.id ? { ...x, active, deactivated_at: active ? null : new Date().toISOString() } : x))
      if (!active) {
        setCsrCampaigns(prev => prev.filter(c => c.profile_id !== p.id))
        setMsg(`✓ ${label} removed${out.released ? ` — ${out.released} claimed lead${out.released === 1 ? '' : 's'} released` : ''}`)
      } else {
        setMsg(`✓ ${label} restored — reassign their campaigns`)
      }
      setTimeout(() => setMsg(''), 5000)
    } catch (e) {
      setMsg(`Error: ${e.message}`)
      setTimeout(() => setMsg(''), 6000)
    } finally {
      setBusyUser(null)
    }
  }

  const openEdit = (p) => {
    const existing = csrCampaigns.filter(c => c.profile_id === p.id)
    const campaignList = campaigns.map(camp => {
      const assignment = existing.find(e => e.campaign_id === camp.id)
      return { campaign_id: camp.id, name: camp.name, active: !!assignment, priority: assignment?.priority || 99 }
    }).sort((a, b) => a.priority - b.priority)
    setEditProfile({ ...p, campaigns: campaignList })
  }

  const toggleCampaign = (campaignId) => {
    setEditProfile(prev => ({ ...prev, campaigns: prev.campaigns.map(c => c.campaign_id === campaignId ? { ...c, active: !c.active } : c) }))
  }

  const movePriority = (campaignId, direction) => {
    setEditProfile(prev => {
      const active = prev.campaigns.filter(c => c.active).sort((a, b) => a.priority - b.priority)
      const idx = active.findIndex(c => c.campaign_id === campaignId)
      if (direction === 'up' && idx === 0) return prev
      if (direction === 'down' && idx === active.length - 1) return prev
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1
      const newActive = [...active]
      ;[newActive[idx], newActive[swapIdx]] = [newActive[swapIdx], newActive[idx]]
      newActive.forEach((c, i) => c.priority = i + 1)
      return { ...prev, campaigns: [...newActive, ...prev.campaigns.filter(c => !c.active)] }
    })
  }

  const getProfileCampaigns = (profileId) => {
    return csrCampaigns.filter(c => c.profile_id === profileId && c.active).sort((a, b) => a.priority - b.priority).map(c => campaigns.find(camp => camp.id === c.campaign_id)?.name).filter(Boolean)
  }

  // Removed users are kept in the table (behind a toggle) so they can be
  // restored; every other screen filters them out at the query.
  const removedProfiles = profiles.filter(p => p.active === false)
  const visibleProfiles = showRemoved ? profiles : profiles.filter(p => p.active !== false)

  // Scorecard KPIs — single source of truth
  const TABS = isAdmin
    ? [{ id:'users', label:'Users' }, { id:'commission', label:'Commission' }, { id:'statuses', label:'Statuses' }, { id:'floortv', label:'Floor TV' }, { id:'ops', label:'Thresholds' }, { id:'knowledge', label:'Knowledge' }, { id:'routing', label:'Call Routing' }, { id:'callqa', label:'Call QA' }]
    // Operations managers aren't paid CSR commissions — profile only.
    : isOpsManager ? [{ id:'users', label:'My Profile' }]
    : [{ id:'users', label:'My Profile' }, { id:'commission', label:'My Earnings' }]

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

      {/* ── HEADER BAR ── the settings tabs; the page title lives in the top bar.
          The active tab stays in ?tab= (above). Phone: PageTabs scrolls the
          nine tabs sideways instead of wrapping them. */}
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0, padding: isMobile ? '0 12px' : '0 24px',
        display:'flex', alignItems:'center', gap:12 }}>
        <PageTabs tabs={TABS.map(t => [t.id, t.label])} value={settingsTab} onChange={setSettingsTab} />
      </div>

      {/* Campaigns moved to Phones → Campaigns (redesign stage 3); old links land there. */}
      {settingsTab === 'campaigns' && <Navigate to="/campaigns" replace />}


      {settingsTab === 'floortv' && isAdmin && (
        <div style={{ flex:1, overflowY:'auto', padding: isMobile ? 12 : 24 }}>
          <FloorTicker />
        </div>
      )}



      {/* Statuses tab — admin only */}
      {settingsTab === 'statuses' && isAdmin && (
        <div style={{ flex:1, overflowY:'auto', padding: isMobile ? 12 : 24, display:'flex', flexDirection:'column', gap:16 }}>
          <Section flush title="Status customization" desc="Changes save automatically. Locked statuses cannot be removed."
            actions={<SaveNote muted={savingStatuses} error={statusSaveMsg.startsWith('Error')}>{savingStatuses ? 'Saving…' : statusSaveMsg}</SaveNote>}>
              {customStatuses.map((status, idx) => (
                <div key={status.id} style={{ display:'flex', alignItems:'center', gap:12, padding: isMobile ? '10px 14px' : '10px 20px', borderTop: idx ? '1px solid var(--border)' : 'none' }}>
                  {/* Clickable color circle */}
                  <label style={{ position:'relative', flexShrink:0, cursor: status.locked ? 'default' : 'pointer' }} title={status.locked ? '' : 'Click to change color'}>
                    <div style={{ width:28, height:28, borderRadius:'50%', background:status.color, border:'2px solid var(--surface)', boxShadow:'0 0 0 1px var(--border-strong)', transition:'transform .1s' }}
                      onMouseEnter={e => { if (!status.locked) e.currentTarget.style.transform='scale(1.15)' }}
                      onMouseLeave={e => e.currentTarget.style.transform='scale(1)'} />
                    {!status.locked && (
                      <input type="color" value={status.color}
                        onChange={e => updateStatuses(prev => prev.map((s,i) => i===idx ? {...s, color:e.target.value} : s))}
                        style={{ position:'absolute', opacity:0, width:0, height:0, pointerEvents:'none' }} />
                    )}
                  </label>
                  {/* Label */}
                  <input className="form-input" value={status.label} disabled={status.locked}
                    onChange={e => updateStatuses(prev => prev.map((s,i) => i===idx ? {...s, label:e.target.value} : s))}
                    style={{ flex:1, padding:'6px 10px', cursor: status.locked ? 'default' : 'text' }} />
                  {status.locked
                    ? <ToneChip tone="gray" small>Locked</ToneChip>
                    : <button className="btn sm danger" onClick={() => updateStatuses(prev => prev.filter((_,i) => i !== idx))}
                        style={{ flexShrink:0 }}>Remove</button>
                  }
                </div>
              ))}

              <div style={{ padding: isMobile ? '12px 14px' : '12px 20px', borderTop:'1px solid var(--border)', display:'flex', flexDirection:'column', alignItems:'flex-start', gap:12 }}>
                {/* Add new status */}
                <button className="btn" onClick={() => updateStatuses(prev => [...prev, { id:`custom_${Date.now()}`, label:'New Status', color:'#6b7280', locked:false }])}
                  style={{ borderRadius:99 }}>
                  + Add status
                </button>

                <Notice tone="amber" style={{ alignSelf:'stretch' }}>
                  Status changes affect all reps on next page load. Removing a status does not affect historical adherence data.
                </Notice>
              </div>
          </Section>
        </div>
      )}

      {/* Commission tab */}
      {settingsTab === 'commission' && !isOpsManager && (
        <div style={{ flex:1, overflowY:'auto', padding: isMobile ? 12 : 24, display:'flex', flexDirection:'column', gap:16 }}>
          {commLoading ? (
            <>
              <div className="skel" style={{ height:110, borderRadius:16, flexShrink:0 }} />
              <div className="skel" style={{ height:260, borderRadius:16, flexShrink:0 }} />
            </>
          ) : (
            <>
              {/* The old flat booking/membership rates are gone: payouts now come
                  from the per-job-type amounts in Commission Mapping, paid when
                  ServiceTitan marks the job completed. */}
              {isAdmin && (
                <Section title="How payouts work" bodyStyle={{ fontSize:12.5, color:'var(--text-secondary)', lineHeight:1.6 }}>
                  Each job type carries its own payout — set them under <strong>Commission Mapping</strong> below.
                  A rep is paid when ServiceTitan marks the booked job <strong>completed</strong>, not when they book it,
                  so earnings appear after the job runs. Membership payouts come from the per-membership-type amounts.
                  See the <strong>Payouts</strong> tab for the full ledger.
                </Section>
              )}

              {isAdmin && oppInc && (
                <Section title="🎯 Opportunity Watch Bonus"
                  desc={<>
                    Mon–Fri: if <strong>every trade with capacity</strong> hits Opportunity Watch (board full) before the
                    cutoff, the floor gets an unlock announcement and the pool is paid that evening, once the last
                    shift ends — split equally among the reps and dispatchers who were scheduled <strong>and actually
                    worked</strong> (handled at least one ServiceTitan call that day). Someone on the schedule who didn't
                    work gets nothing. Pays at most once per day; skips company holidays.
                  </>}
                  actions={oppIncSaved && <SaveNote>✓ Saved</SaveNote>}>
                    <div style={{ display:'flex', gap:16, alignItems:'stretch', flexWrap: isMobile ? 'wrap' : undefined }}>
                      <div className="form-field" style={{ display:'flex', flexDirection:'column', width:110, flexShrink:0, marginBottom:0 }}>
                        <label className="form-label">&nbsp;</label>
                        <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, fontWeight:700, cursor:'pointer', flex:1 }}>
                          <input type="checkbox" checked={oppInc.enabled}
                            onChange={e => setOppInc(v => ({ ...v, enabled: e.target.checked }))} />
                          Enabled
                        </label>
                      </div>
                      <div className="form-field" style={{ width:140, flexShrink:0, marginBottom:0 }}>
                        <label className="form-label">Daily pool ($)</label>
                        <input className="form-input" type="number" min="1" step="1" value={oppInc.pool}
                          onChange={e => setOppInc(v => ({ ...v, pool: Number(e.target.value) }))} style={{ width:'100%' }} />
                      </div>
                      <div className="form-field" style={{ width:150, flexShrink:0, marginBottom:0 }}>
                        <label className="form-label">Cutoff (Denver)</label>
                        <input className="form-input" type="time" value={oppInc.cutoff}
                          onChange={e => setOppInc(v => ({ ...v, cutoff: e.target.value }))} style={{ width:'100%' }} />
                      </div>
                      <div className="form-field" style={{ display:'flex', flexDirection:'column', width:100, flexShrink:0, marginBottom:0 }}>
                        <label className="form-label">&nbsp;</label>
                        <button className="btn primary" onClick={saveOppInc} style={{ flex:1, justifyContent:'center', borderRadius:99 }}>Save</button>
                      </div>
                    </div>
                </Section>
              )}

              {/* Admin: All rep earnings this week */}
              {isAdmin && allRepEarnings.length > 0 && (
                <Section flush title="Team earnings — this week" desc="Per rep since Monday, from the commissions ledger">
                  <div style={{ overflowX:'auto' }}>
                    <table className="data-table">
                      <thead><tr><th>Rep</th><th style={{textAlign:'center'}}>Today</th><th style={{textAlign:'center'}}>This Week</th><th style={{textAlign:'center'}}>Bookings</th><th style={{textAlign:'center'}}>Memberships</th></tr></thead>
                      <tbody>
                        {allRepEarnings.map(([name, d]) => (
                          <tr key={name}>
                            <td>
                              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                                <Face avatar={profiles.find(p => p.name === name)?.avatar} name={name} size={28} />
                                <span style={{ fontWeight:600 }}>{name}</span>
                              </div>
                            </td>
                            <td style={{ textAlign:'center', fontWeight:700, color:'var(--tone-green-tx)' }}>{'$'}{d.daily.toFixed(2)}</td>
                            <td style={{ textAlign:'center', fontWeight:700, color:'var(--accent)' }}>{'$'}{d.weekly.toFixed(2)}</td>
                            <td style={{ textAlign:'center' }}>{d.bookings}</td>
                            <td style={{ textAlign:'center' }}>{d.memberships}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Section>
              )}

              {/* Rep: Personal earnings summary */}
              {!isAdmin && (
                <SummaryPanel isMobile={isMobile} style={{ marginBottom:0, flexShrink:0 }}>
                  {[
                    { label:'Today', value: commissionHistory.filter(c => new Date(c.earned_at).toISOString().split('T')[0] === new Date().toISOString().split('T')[0]).reduce((s,c) => s + parseFloat(c.amount), 0), tone:'green', note:'Resets at midnight' },
                    { label:'This Week', value: commissionHistory.reduce((s,c) => s + parseFloat(c.amount), 0), tone:'blue', note:'Resets Monday 12:01am' },
                  ].map(({ label, value, tone, note }) => (
                    <Stat key={label} big label={label} value={`$${value.toFixed(2)}`} tone={tone} sub={note} />
                  ))}
                </SummaryPanel>
              )}

              {/* Admin: Manual adjustment panel */}
              {isAdmin && (
                <Section title="Manual adjustment" desc="Add or deduct from a rep's commission balance">
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 140px 1fr auto', gap:12, alignItems:'flex-end' }}>
                      <div className="form-field" style={{ margin:0 }}>
                        <label className="form-label">Rep</label>
                        <select className="form-input" value={adjProfileId} onChange={e => setAdjProfileId(e.target.value)}>
                          <option value=''>Select rep...</option>
                          {profiles.map(p => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}
                        </select>
                      </div>
                      <div className="form-field" style={{ margin:0 }}>
                        <label className="form-label">Amount ($)</label>
                        <input className="form-input" type="number" step="0.50" value={adjAmount}
                          onChange={e => setAdjAmount(e.target.value)}
                          placeholder="e.g. 5.00 or -2.00"
                          style={{ ...num, color: adjAmount && parseFloat(adjAmount) < 0 ? 'var(--tone-red-tx)' : parseFloat(adjAmount) > 0 ? 'var(--tone-green-tx)' : 'var(--text-primary)' }} />
                      </div>
                      <div className="form-field" style={{ margin:0 }}>
                        <label className="form-label">Reason</label>
                        <input className="form-input" value={adjNote} onChange={e => setAdjNote(e.target.value)}
                          placeholder="e.g. Bonus for membership upsell" />
                      </div>
                      <button className="btn primary" onClick={addInlineAdjustment}
                        disabled={adjSaving || !adjProfileId || !adjAmount}
                        style={{ whiteSpace:'nowrap', height: isMobile ? 40 : 36, borderRadius:99, padding:'0 20px', justifyContent:'center' }}>
                        {adjSaving ? 'Adding…' : 'Add'}
                      </button>
                    </div>
                    <div style={{ fontSize:11.5, color:'var(--text-muted)', marginTop:10 }}>
                      Use a negative amount to deduct (e.g. -5.00). Adjustments appear immediately in the history below.
                    </div>
                </Section>
              )}

              {/* Commission history */}
              <Section flush title="Commission history — this week" desc="Bookings, memberships, adjustments and reversals since Monday">
                {commissionHistory.length === 0 ? (
                  <div style={{ padding:'40px 20px', textAlign:'center', color:'var(--text-muted)', fontSize:13 }}>No commissions earned yet this week</div>
                ) : (
                  <div style={{ overflowX:'auto' }}>
                  <table className="data-table">
                    <thead><tr>{isAdmin && <th>Rep</th>}<th>Type</th><th>Detail</th><th style={{textAlign:'right'}}>Amount</th><th>When</th>{isAdmin && <th>By</th>}</tr></thead>
                    <tbody>
                      {commissionHistory.filter(c => !isAdmin ? c.profile_id === profile?.id : true).map(c => {
                        const isAdj = c.event_type === 'adjustment'
                        const isMem = c.event_type === 'membership'
                        const isRev = c.event_type === 'reversal'   // clawbacks + corrections — never label them "Booking"
                        const amt = parseFloat(c.amount)
                        const updaterProfile = c.updated_by ? profiles.find(p => p.id === c.updated_by) : null
                        const madeBy = c._updaterName || updaterProfile?.name || updaterProfile?.email || (isAdj ? 'Admin' : null)
                        return (
                          <tr key={c.id}>
                            {isAdmin && <td style={{ fontWeight:600 }}>{c.profiles?.name || c.rep_name}</td>}
                            <td>
                              <ToneChip small tone={isRev ? 'red' : isAdj ? (amt < 0 ? 'red' : 'amber') : isMem ? 'blue' : 'green'}>
                                {isRev ? 'Reversal' : isAdj ? 'Adjustment' : isMem ? 'Membership' : 'Booking'}
                              </ToneChip>
                            </td>
                            <td style={{ color:'var(--text-secondary)' }}>
                              {isAdj ? (c.notes || 'Manual adjustment') : isRev ? (c.notes || `Reversed${c.contact_name ? ` — ${c.contact_name}` : ''}`) : c.contact_name}
                            </td>
                            <td style={{ textAlign:'right', fontWeight:700, color: amt < 0 ? 'var(--tone-red-tx)' : 'var(--tone-green-tx)' }}>
                              {amt >= 0 ? '+' : ''}{'$'}{amt.toFixed(2)}
                            </td>
                            <td style={{ color:'var(--text-muted)', fontSize:11.5, whiteSpace:'nowrap' }}>
                              {new Date(c.earned_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}
                            </td>
                            {isAdmin && (
                              <td style={{ fontSize:11.5, color: madeBy ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                                {madeBy || '--'}
                              </td>
                            )}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  </div>
                )}
              </Section>
            </>
          )}

          {/* Commission engine setup / mapping (collapsible) */}
          {isAdmin && (
            <>
              <button onClick={() => setShowMapping(v => !v)} className="lift-hover" aria-expanded={showMapping}
                style={{ ...panel, flexShrink:0, width:'100%', display:'flex', alignItems:'center', gap:12, padding: isMobile ? '12px 14px' : '14px 20px',
                  cursor:'pointer', textAlign:'left', font:'inherit', color:'var(--text-primary)' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0, transform: showMapping ? 'rotate(90deg)' : 'none', transition:'transform .15s' }}><path d="m9 18 6-6-6-6"/></svg>
                <span style={{ flex:1, minWidth:0 }}>
                  <span style={{ display:'block', fontSize:14.5, fontWeight:700 }}>Commission engine setup</span>
                  <span style={{ display:'block', fontSize:12, color:'var(--text-muted)', marginTop:2 }}>Map ServiceTitan users, job types, and membership types to spiff rules.</span>
                </span>
              </button>
              {showMapping && <CommissionMapping />}
            </>
          )}
        </div>
      )}


      {/* Users tab */}
      {settingsTab === 'knowledge' && isAdmin && <KnowledgeTab />}

      {settingsTab === 'routing' && isAdmin && <CallRoutingTab />}

      {settingsTab === 'callqa' && isAdmin && <CallQATab />}

      {settingsTab === 'ops' && isAdmin && (
        <div style={{ flex:1, overflowY:'auto', padding: isMobile ? 12 : 24, display:'flex', flexDirection:'column', gap:16 }}>
          {!opsForm || !wxLocs ? (
            <>
              <div className="skel" style={{ height:200, borderRadius:16, flexShrink:0 }} />
              <div className="skel" style={{ height:160, borderRadius:16, flexShrink:0 }} />
            </>
          ) : (
            <>
              {/* Thresholds and weather save together (autosave, below); the
                  one status line lives on the first section. */}
              <Section title="Call center thresholds" desc="Drives the TV, Analytics, wrap-up and the dialer — no deploy needed"
                actions={<SaveNote muted={opsSaving || !opsMsg} error={opsMsg.startsWith('Error')}>{opsSaving ? 'Saving…' : opsMsg || 'Changes save automatically'}</SaveNote>}
                bodyStyle={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:16 }}>
                  {[
                    ['serviceLevelSeconds', 'Service level window (sec)', 'Answered within this counts toward service level'],
                    ['serviceLevelTarget', 'Service level target (%)', 'Green at or above this'],
                    ['abandonGraceSeconds', 'Abandon grace (sec)', 'Hangups faster than this are misdials, not abandons'],
                    ['wrapUpSeconds', 'Wrap-up length (sec)', 'After an interaction, before auto-Available'],
                    ['maxAttempts', 'Max dial attempts', 'Contact goes to Max Attempts after this many'],
                    ['retryGapHours', 'Hours before re-dialing', 'A No Answer / Voicemail lead isn’t served again until this passes (20 = next day, a bit earlier)'],
                  ].map(([k, label, hint]) => (
                    <div key={k} className="form-field" style={{ marginBottom:0 }}>
                      <label className="form-label">{label}</label>
                      <input className="form-input" type="number" min="1" value={opsForm[k]}
                        onChange={e => { setOpsForm(f => ({ ...f, [k]: Number(e.target.value) })); setOpsDirty(true) }} />
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4, lineHeight:1.45 }}>{hint}</div>
                    </div>
                  ))}
              </Section>
              <Section title="Weather locations" desc="Up to 5 · shown across the top of every page and the Floor TV"
                bodyStyle={{ display:'flex', flexDirection:'column', gap:10 }}>
                  {wxLocs.map((l, i) => (
                    <div key={i} style={{ display:'flex', gap:8, alignItems:'center' }}>
                      <input className="form-input" value={l.key} title="Short label shown in the strip"
                        onChange={e => { setWxLocs(ls => ls.map((x, xi) => xi === i ? { ...x, key: e.target.value } : x)); setOpsDirty(true) }}
                        style={{ width:130 }} />
                      <span style={{ flex:1, minWidth:0, fontSize:12.5, color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{l.name}</span>
                      <button className="btn sm" onClick={() => { setWxLocs(ls => ls.filter((_, xi) => xi !== i)); setOpsDirty(true) }} disabled={wxLocs.length <= 1}>Remove</button>
                    </div>
                  ))}
                  {wxLocs.length < 5 && (
                    <div>
                      <input className="form-input" placeholder="Add a place — city, town or address" value={wxQuery}
                        onChange={e => wxSearch(e.target.value)} />
                      {wxSugs.length > 0 && (
                        <div style={{ marginTop:6, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, overflow:'hidden', boxShadow:'0 10px 24px -14px rgba(15, 20, 40, .28)' }}>
                          {wxSugs.map((sug, si) => (
                            <button key={si} onClick={() => {
                              const short = String(sug.placeName || '').split(',')[0].trim()
                              setWxLocs(ls => [...ls, { key: short, name: sug.placeName, lat: sug.lat, lng: sug.lng }])
                              setWxQuery(''); setWxSugs([]); setOpsDirty(true)
                            }} style={{ display:'block', width:'100%', textAlign:'left', padding:'9px 14px', background:'transparent', border:'none', borderTop: si ? '1px solid var(--border)' : 'none', cursor:'pointer', fontSize:12.5, color:'var(--text-primary)' }}
                              onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                              {sug.placeName}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
              </Section>
              <div style={{ ...panel, flexShrink:0, padding: isMobile ? '12px 14px' : '12px 20px', display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', fontSize:12.5, color:'var(--text-muted)' }}>
                Hours of operation and the holiday schedule now live in
                <button className="btn sm" onClick={() => setSettingsTab('routing')} style={{ borderRadius:99 }}>Call Routing</button>
                where they actually control the phones.
              </div>

              {/* Morning digest — send one on demand instead of waiting for 7 AM */}
              <Section title="Morning digest" desc="Yesterday's sales, close rates, techs, call center, and marketing — emailed at 7 AM"
                bodyStyle={{ display:'flex', flexDirection:'column', gap:14 }}>
                <div style={{ display:'flex', alignItems:'end', gap:10, flexWrap:'wrap' }}>
                  <div className="form-field" style={{ flex:1, minWidth:320, margin:0 }}>
                    <label className="form-label">Recipients (comma-separated)</label>
                    <input className="form-input" value={digestTo} placeholder="name@awesomeservice.com, other@…"
                      onChange={e => setDigestTo(e.target.value)} />
                  </div>
                  <button className="btn" style={{ borderRadius:99 }} disabled={digestToSaving} onClick={async () => {
                    setDigestToSaving(true)
                    const clean = digestTo.split(',').map(x => x.trim()).filter(Boolean).join(', ')
                    const { error } = await sb.from('app_settings').upsert({ key: 'daily_digest_to', value: clean }, { onConflict: 'key' })
                    setDigestToSaving(false)
                    if (error) toast(`Couldn't save: ${error.message}`)
                    else { setDigestTo(clean); toast(clean ? `Digest now goes to: ${clean}` : 'Digest recipients cleared — no one will receive it') }
                  }}>{digestToSaving ? 'Saving…' : 'Save recipients'}</button>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', paddingTop:14, borderTop:'1px solid var(--border)' }}>
                  <button className="btn primary" style={{ borderRadius:99 }} disabled={digestBusy} onClick={async () => {
                    setDigestBusy(true); setDigestMsg('')
                    try {
                      const { data: { session } } = await sb.auth.getSession()
                      const r = await fetch('/api/admin/daily-digest?send=1', { headers: { Authorization: `Bearer ${session?.access_token}` } })
                      const d = await r.json()
                      if (!r.ok) throw new Error(d.error || 'Send failed')
                      setDigestMsg(`Sent to ${d.sent}`)
                    } catch (e) { setDigestMsg(`Error: ${e.message}`) }
                    setDigestBusy(false)
                  }}>{digestBusy ? 'Building…' : 'Email me yesterday’s digest'}</button>
                  <SaveNote error={digestMsg.startsWith('Error')}>{digestMsg}</SaveNote>
                  <span style={{ fontSize:11.5, color:'var(--text-muted)', marginLeft:'auto' }}>Takes ~30s to build — it queries a full day of ServiceTitan.</span>
                </div>
              </Section>
            </>
          )}
        </div>
      )}

      {settingsTab === 'users' && (
        <div style={{ flex:1, overflowY:'auto', padding: isMobile ? 12 : 24, display:'flex', flexDirection:'column', gap:16 }}>

          {/* MY PROFILE */}
          <Section title="My profile" desc="Your name and avatar as the team sees them"
            actions={<>
              <SaveNote muted={savingProfile || !profileMsg}>{savingProfile ? 'Saving…' : profileMsg || 'Changes save automatically'}</SaveNote>
              <button className="btn" style={{ borderRadius:99 }} onClick={() => { setPwModal('me'); setNewPw(''); setPwMsg('') }}>
                Change my password
              </button>
            </>}
            bodyStyle={{ display:'flex', flexDirection:'column', gap:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:16 }}>
                <div style={{ position:'relative', flexShrink:0 }}>
                  <Face avatar={myAvatar} name={myName || profile?.email} size={64} />
                  <button onClick={() => { setPickerSelected(myAvatar); setShowAvatarPicker(true) }}
                    style={{ position:'absolute', bottom:0, right:0, width:22, height:22, borderRadius:'50%', background:'var(--accent)', border:'2px solid var(--surface)', color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}
                    title="Change avatar">+</button>
                </div>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontSize:14.5, fontWeight:700 }}>{myName || profile?.email}</div>
                  <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2 }}>
                    {!myAvatar ? 'No avatar set' : /^(data:|https?:|\/)/.test(myAvatar) ? 'Photo set' : `Emoji ${myAvatar}`} · <span style={{ color:'var(--accent)', cursor:'pointer', fontWeight:600 }} onClick={() => { setPickerSelected(myAvatar); setShowAvatarPicker(true) }}>Change</span>
                  </div>
                </div>
              </div>
              <div className="form-field" style={{ marginBottom:0 }}>
                <label className="form-label">Display name</label>
                <input className="form-input" value={myName} onChange={e => setMyName(e.target.value)} placeholder="Your name"
                  onBlur={() => { if ((myName || '') !== (profile?.name || '')) saveMyProfile({ name: myName }) }} />
              </div>
          </Section>

          {/* EMOJI PICKER MODAL */}
          {showAvatarPicker && (
            <Modal title="Choose Your Avatar" onClose={() => setShowAvatarPicker(false)} width={520}>
              <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
                <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:14 }}>
                  <Face avatar={pickerSelected || myAvatar} name={myName || profile?.email} size={48} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13.5, fontWeight:700 }}>{myName || profile?.email}</div>
                    <div style={{ fontSize:12, color:'var(--text-muted)' }}>{pickerSelected ? 'Looking good! Hit save to lock it in.' : 'Upload a photo or pick an emoji'}</div>
                  </div>
                  <label className="btn sm" style={{ cursor:'pointer', flexShrink:0, borderRadius:99 }}>
                    Upload photo
                    <input type="file" accept="image/*" onChange={onAvatarFile} style={{ display:'none' }} />
                  </label>
                </div>
                <div style={{ maxHeight:400, overflowY:'auto', display:'flex', flexDirection:'column', gap:14 }}>
                  {Object.entries(EMOJIS).map(([category, emojis]) => (
                    <div key={category}>
                      <div style={{ ...eyebrow, marginBottom:6 }}>{category}</div>
                      <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                        {emojis.map(emoji => (
                          <button key={emoji} onClick={() => setPickerSelected(emoji)}
                            style={{ width:40, height:40, borderRadius:'var(--radius)', fontSize:22,
                              border: pickerSelected===emoji ? '2px solid var(--accent)' : '2px solid transparent',
                              background: pickerSelected===emoji ? 'var(--accent-bg)' : 'var(--surface-2)',
                              cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
                              transform: pickerSelected===emoji ? 'scale(1.15)' : 'scale(1)', transition:'all .1s' }}>
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setShowAvatarPicker(false)}>Cancel</button>
                <button className="btn primary" onClick={confirmAvatar} disabled={!pickerSelected}>Select avatar</button>
              </div>
            </Modal>
          )}

          {cropSrc && (
            <AvatarCropper src={cropSrc}
              onCancel={() => setCropSrc(null)}
              onDone={d => { setPickerSelected(d); setCropSrc(null) }} />
          )}

          {/* ADMIN ONLY — User Management */}
          {isAdmin && (
            <>
              {msg && <Notice tone={msg.startsWith('Error') ? 'red' : 'green'}>{msg}</Notice>}
              <Section flush title="User management" desc="Invite by email below — they set their own name and password"
                actions={removedProfiles.length > 0 && (
                  <button className="btn sm" style={{ borderRadius:99 }} onClick={() => setShowRemoved(v => !v)}>
                    {showRemoved ? 'Hide removed' : `Show removed (${removedProfiles.length})`}
                  </button>
                )}>
                {/* Invite a user */}
                <div style={{ padding: isMobile ? '12px 14px' : '14px 20px', borderBottom:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:10 }}>
                  <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                    <input className="form-input" type="email" placeholder="teammate@awesomeservice.com"
                      value={invEmail} onChange={e => setInvEmail(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') sendInvite() }}
                      style={{ flex:1, minWidth:220 }} />
                    <select className="form-input" value={invRole} onChange={e => setInvRole(e.target.value)} style={{ width:130 }}>
                      <option value="rep">Rep</option>
                      <option value="dispatcher">Dispatcher</option>
                      <option value="ops_manager">Operations Manager</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button className="btn primary" onClick={sendInvite} disabled={invBusy || !invEmail.trim()} style={{ borderRadius:99 }}>
                      {invBusy ? 'Sending…' : 'Send invite'}
                    </button>
                  </div>
                  {invMsg && (
                    <Notice tone={invMsg.ok ? 'green' : 'red'}>
                      {invMsg.text}
                      {invMsg.link && (
                        <div style={{ display:'flex', gap:6, alignItems:'center', marginTop:6 }}>
                          <input className="form-input" readOnly value={invMsg.link} style={{ flex:1, fontSize:11 }}
                            onFocus={e => e.target.select()} />
                          <button className="btn sm" onClick={() => navigator.clipboard?.writeText(invMsg.link)}>Copy</button>
                        </div>
                      )}
                    </Notice>
                  )}
                </div>
                {/* One row per person: face, name + role, email under it; their
                    campaigns in priority order; actions on the right. A fixed
                    actions column keeps the rows aligned. Phone: stacks. */}
                {loading ? (
                  <div style={{ padding: isMobile ? '12px 14px' : '14px 20px', display:'flex', flexDirection:'column', gap:10 }}>
                    {[0, 1, 2].map(i => <div key={i} className="skel" style={{ height:40, borderRadius:10 }} />)}
                  </div>
                ) : visibleProfiles.map((p, i) => {
                        const activeCamps = getProfileCampaigns(p.id)
                        const removed = p.active === false
                        const [roleTone, roleLabel] = ROLE_CHIP[p.role || 'rep'] || ['gray', p.role]
                        return (
                          <div key={p.id} className="eval-row" style={{ display:'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 1.2fr) minmax(0, 1fr) 280px',
                            gap: isMobile ? 10 : 16, alignItems:'center', padding: isMobile ? '12px 14px' : '11px 20px', borderTop: i ? '1px solid var(--border)' : 'none', opacity: removed ? .55 : 1 }}>
                            <div style={{ display:'flex', alignItems:'center', gap:12, minWidth:0 }}>
                              <div style={{ flexShrink:0, filter: removed ? 'grayscale(1)' : undefined }}>
                                <Face avatar={p.avatar} name={p.name || p.email} size={34} />
                              </div>
                              <div style={{ minWidth:0 }}>
                                <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
                                  <span style={{ fontSize:13.5, fontWeight:650 }}>{p.name || '—'}</span>
                                  <ToneChip tone={roleTone} small>{roleLabel}</ToneChip>
                                  {removed && <ToneChip tone="gray" small>Removed</ToneChip>}
                                </div>
                                <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.email}</div>
                              </div>
                            </div>
                            <div style={{ display:'flex', gap:4, flexWrap:'wrap', minWidth:0 }}>
                              {activeCamps.length === 0 ? <span style={{ fontSize:12, color:'var(--text-muted)' }}>No campaigns assigned</span> : (
                                activeCamps.map((name, ci) => (
                                  <span key={name} style={{ fontSize:11, fontWeight:600, padding:'1px 8px', borderRadius:99, background:'var(--accent-bg)', color:'var(--accent-text)' }}>
                                    <span style={num}>{ci + 1}.</span> {name}
                                  </span>
                                ))
                              )}
                            </div>
                            <div>
                              <div style={{ display:'flex', gap:6, flexWrap:'wrap', justifyContent: isMobile ? 'flex-start' : 'flex-end' }}>
                                {removed ? (
                                  <button className="btn sm" disabled={busyUser === p.id} onClick={() => setUserActive(p, true)}>
                                    {busyUser === p.id ? 'Restoring…' : 'Restore'}
                                  </button>
                                ) : (
                                  <>
                                    <button className="btn sm" onClick={() => openEdit(p)}>Edit</button>
                                    <button className="btn sm" onClick={() => { setPwModal({ profileId: p.id, name: p.name || p.email }); setNewPw(''); setPwMsg('') }}>Password</button>
                                    <button className="btn sm" onClick={() => { setCommAdjModal({ profileId: p.id, name: p.name || p.email }); setCommAdjAmount(''); setCommAdjNote('') }}>Adjust</button>
                                    {p.id !== profile?.id && (
                                      <button className="btn sm danger" disabled={busyUser === p.id} onClick={() => setUserActive(p, false)}>
                                        {busyUser === p.id ? 'Removing…' : 'Remove'}
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        )
                      })}
              </Section>

            </>
          )}

          {/* Edit user modal */}
          {editProfile && (
            <Modal title={`Edit — ${editProfile.name || editProfile.email}`} onClose={() => setEditProfile(null)} width={560}>
              <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
                <div className="form-field">
                  <label className="form-label">Display name</label>
                  <input className="form-input" value={editProfile.name || ''} onChange={e => setEditProfile(p => ({ ...p, name: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label className="form-label">Role</label>
                  <select className="form-input" value={editProfile.role || 'rep'} onChange={e => setEditProfile(p => ({ ...p, role: e.target.value }))}>
                    <option value="rep">Rep — can dial, view dashboard, see all stats</option>
                    <option value="dispatcher">Dispatcher — everything a rep has, plus Dispatch for Profit</option>
                    <option value="ops_manager">Operations Manager — department TVs, technician team & scorecards, 3-day board, manual dialing (no call center)</option>
                    <option value="admin">Admin — full access including uploads and user management</option>
                  </select>
                </div>
                {['admin', 'dispatcher'].includes(editProfile.role) && (
                  <div className="form-field">
                    <label className="form-label">Home screen — what they see when they open Andi</label>
                    <select className="form-input" value={editProfile.home_view || ''} onChange={e => setEditProfile(p => ({ ...p, home_view: e.target.value || null }))}>
                      <option value="">{editProfile.role === 'admin' ? 'Business — sales pace, departments, the floor' : 'Dispatcher — decisions, coverage, their week'}</option>
                      <option value="dispatch_manager">Call center & dispatch manager — the floor, each CSR today, decisions, coverage</option>
                    </select>
                  </div>
                )}
                <div className="form-field">
                  <label className="form-label">Manager — approves their PTO / sick requests</label>
                  <select className="form-input" value={editProfile.manager_id || ''}
                    onChange={e => setEditProfile(p => ({ ...p, manager_id: e.target.value || null }))}>
                    <option value="">No manager assigned</option>
                    {profiles.filter(p => p.active !== false && p.id !== editProfile.id)
                      .map(p => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}
                  </select>
                </div>
                <div>
                  <label className="form-label" style={{ marginBottom:8, display:'block' }}>Skillset</label>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:10 }}>Grant the queues this rep may log into. They choose which of these to go available for. Inbound always outranks outbound; campaign #1 is served first.</div>

                  {/* Inbound skill — the fixed, top-priority queue */}
                  <label style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', marginBottom:10, borderRadius:12, cursor:'pointer',
                    background: editProfile.inbound_skill ? 'var(--accent-bg)' : 'var(--surface-2)',
                    border:`1px solid ${editProfile.inbound_skill ? 'var(--accent)' : 'var(--border)'}` }}>
                    <input type="checkbox" checked={!!editProfile.inbound_skill}
                      onChange={e => setEditProfile(p => ({ ...p, inbound_skill: e.target.checked }))} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, fontWeight:600, color: editProfile.inbound_skill ? 'var(--accent)' : 'var(--text-primary)' }}>Inbound queue</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)' }}>Takes live inbound calls from the queue — always served before outbound.</div>
                    </div>
                  </label>

                  {/* Dispatch line — techs calling (719) 259-2681; only these workers ring */}
                  <label style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', marginBottom:10, borderRadius:12, cursor:'pointer',
                    background: editProfile.dispatch_skill ? 'var(--tone-purple-bg)' : 'var(--surface-2)',
                    border:`1px solid ${editProfile.dispatch_skill ? 'var(--tone-purple-bd)' : 'var(--border)'}` }}>
                    <input type="checkbox" checked={!!editProfile.dispatch_skill}
                      onChange={e => setEditProfile(p => ({ ...p, dispatch_skill: e.target.checked }))} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, fontWeight:600, color: editProfile.dispatch_skill ? 'var(--tone-purple-tx)' : 'var(--text-primary)' }}>Dispatch line</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)' }}>Takes technician calls to the dedicated dispatch number — techs never ring CSRs.</div>
                    </div>
                  </label>

                  <div style={{ ...eyebrow, marginBottom:8 }}>Outbound campaigns</div>
                  {editProfile.campaigns.filter(c => c.active).sort((a, b) => a.priority - b.priority).length > 0 && (
                    <div style={{ marginBottom:8 }}>
                      <div style={{ ...eyebrow, marginBottom:6 }}>Active (priority order)</div>
                      <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                        {editProfile.campaigns.filter(c => c.active).sort((a, b) => a.priority - b.priority).map((c, idx, arr) => (
                          <div key={c.campaign_id} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background:'var(--tone-green-bg)', border:'1px solid var(--tone-green-bd)', borderRadius:10 }}>
                            <span style={{ ...num, fontSize:11, fontWeight:800, color:'var(--tone-green-tx)', minWidth:18 }}>#{idx+1}</span>
                            <span style={{ fontSize:13, fontWeight:600, flex:1 }}>{c.name}</span>
                            <div style={{ display:'flex', gap:2 }}>
                              <button onClick={() => movePriority(c.campaign_id, 'up')} disabled={idx===0} style={{ padding:'2px 6px', fontSize:11, borderRadius:6, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-primary)', cursor: idx===0 ? 'not-allowed' : 'pointer', opacity: idx===0 ? .3 : 1 }}>▲</button>
                              <button onClick={() => movePriority(c.campaign_id, 'down')} disabled={idx===arr.length-1} style={{ padding:'2px 6px', fontSize:11, borderRadius:6, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-primary)', cursor: idx===arr.length-1 ? 'not-allowed' : 'pointer', opacity: idx===arr.length-1 ? .3 : 1 }}>▼</button>
                            </div>
                            <button onClick={() => toggleCampaign(c.campaign_id)} style={{ padding:'2px 8px', fontSize:11, borderRadius:6, border:'1px solid var(--tone-red-bd)', background:'var(--tone-red-bg)', color:'var(--tone-red-tx)', cursor:'pointer', fontWeight:600 }}>Remove</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {editProfile.campaigns.filter(c => !c.active).length > 0 && (
                    <div>
                      <div style={{ ...eyebrow, marginBottom:6 }}>Available to add</div>
                      <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                        {editProfile.campaigns.filter(c => !c.active).map(c => (
                          <div key={c.campaign_id} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:10 }}>
                            <span style={{ fontSize:13, flex:1, color:'var(--text-muted)' }}>{c.name}</span>
                            <button onClick={() => toggleCampaign(c.campaign_id)} style={{ padding:'2px 8px', fontSize:11, borderRadius:6, border:'1px solid var(--accent)', background:'var(--accent-bg)', color:'var(--accent)', cursor:'pointer', fontWeight:600 }}>+ Add</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <Notice tone="amber">Changes take effect on next page load.</Notice>
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setEditProfile(null)}>Cancel</button>
                <button className="btn primary" onClick={saveProfile} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
              </div>
            </Modal>
          )}

          {/* ── COMPANY DIRECTORY ── */}
          {isAdmin && (
            <Section title="Company directory" desc="Numbers every CSR can dial from Manual Dial — techs, warehouse, vendors, the office next door"
              actions={<SaveNote>{dirMsg}</SaveNote>}
              bodyStyle={{ display:'flex', flexDirection:'column', gap:8 }}>
                {directory === null ? <div className="skel" style={{ height:40, borderRadius:10 }} /> : (
                  <>
                    {directory.length === 0 && (
                      <div style={{ fontSize:12.5, color:'var(--text-muted)' }}>Nobody here yet — add the warehouse, on-call techs, the answering service…</div>
                    )}
                    {directory.map((d, i) => (
                      <div key={i} style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                        <input className="form-input" placeholder="Name" value={d.name || ''} style={{ width: isMobile ? '100%' : 180 }}
                          onChange={e => setDirectory(ds => ds.map((x, xi) => xi === i ? { ...x, name: e.target.value } : x))} />
                        <input className="form-input" placeholder="Phone number" value={d.number || ''} style={{ width: isMobile ? '100%' : 150 }}
                          onChange={e => setDirectory(ds => ds.map((x, xi) => xi === i ? { ...x, number: e.target.value } : x))} />
                        <input className="form-input" placeholder="Label (optional — Warehouse, HVAC tech, Vendor…)" value={d.label || ''} style={{ flex:1, minWidth:170 }}
                          onChange={e => setDirectory(ds => ds.map((x, xi) => xi === i ? { ...x, label: e.target.value } : x))} />
                        <button className="btn sm" onClick={() => setDirectory(ds => ds.filter((_, xi) => xi !== i))}>Remove</button>
                      </div>
                    ))}
                    <div style={{ display:'flex', gap:8, alignItems:'center', marginTop:4 }}>
                      <button className="btn sm" style={{ borderRadius:99 }} onClick={() => setDirectory(ds => [...(ds || []), { name:'', number:'', label:'' }])}>+ Add entry</button>
                      <button className="btn sm primary" style={{ borderRadius:99, padding:'5px 16px' }} onClick={saveDirectory} disabled={dirSaving}>{dirSaving ? 'Saving…' : 'Save directory'}</button>
                    </div>
                  </>
                )}
            </Section>
          )}
        </div>
      )}

      {/* ── PASSWORD CHANGE MODAL ── */}
      {pwModal && (
        <Modal title={pwModal === 'me' ? 'Change My Password' : `Change Password — ${pwModal.name}`} onClose={() => { setPwModal(null); setNewPw(''); setPwMsg('') }} width={380}>
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {!isAdmin || pwModal === 'me' ? (
              <div style={{ fontSize:13, color:'var(--text-secondary)' }}>Enter a new password for your account.</div>
            ) : (
              <div style={{ fontSize:13, color:'var(--text-secondary)' }}>Set a new password for <strong>{pwModal.name}</strong>. They will need to use this to log in next time.</div>
            )}
            <div className="form-field">
              <label className="form-label">New Password</label>
              <input className="form-input" type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
                placeholder="Min 6 characters" onKeyDown={e => e.key === 'Enter' && changePassword()} />
            </div>
            {pwMsg && <Notice tone={pwMsg.startsWith('✓') ? 'green' : 'red'}>{pwMsg}</Notice>}
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => { setPwModal(null); setNewPw(''); setPwMsg('') }}>Cancel</button>
            <button className="btn primary" onClick={changePassword} disabled={savingPw || newPw.length < 6}>
              {savingPw ? 'Saving…' : 'Change password'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── SCORECARDS TAB ── */}

      {/* ── COMMISSION ADJUSTMENT MODAL ── */}
      {commAdjModal && (
        <Modal title={`Adjust Commission — ${commAdjModal.name}`} onClose={() => { setCommAdjModal(null); setCommAdjAmount(''); setCommAdjNote('') }} width={380}>
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            <div style={{ fontSize:13, color:'var(--text-secondary)' }}>
              Add or subtract from <strong>{commAdjModal.name}</strong>'s commission. Use negative numbers to deduct (e.g. -2.00).
            </div>
            <div className="form-field">
              <label className="form-label">Amount ($)</label>
              <input className="form-input" type="number" step="0.50" value={commAdjAmount}
                onChange={e => setCommAdjAmount(e.target.value)} placeholder="e.g. 5.00 or -2.00" />
            </div>
            <div className="form-field">
              <label className="form-label">Note (optional)</label>
              <input className="form-input" value={commAdjNote} onChange={e => setCommAdjNote(e.target.value)}
                placeholder="e.g. Bonus for membership upsell" />
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => { setCommAdjModal(null); setCommAdjAmount(''); setCommAdjNote('') }}>Cancel</button>
            <button className="btn primary" onClick={addCommissionAdjustment} disabled={savingAdj || !commAdjAmount}>
              {savingAdj ? 'Saving…' : 'Add adjustment'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
