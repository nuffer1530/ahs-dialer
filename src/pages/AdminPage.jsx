import { useState, useEffect, useRef, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useData } from '../lib/DataContext'
import Modal from '../components/Modal'
import CampaignsPage from './CampaignsPage'
import Avatar from '../components/Avatar'
import AvatarCropper from '../components/AvatarCropper'

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

  if (loading) return <div style={{ padding:40, textAlign:'center', color:'var(--text-muted)' }}>Loading ServiceTitan data…</div>
  if (err && !cfg) return <div style={{ padding:20, color:'#DC2626' }}>{err} <button onClick={load} className="btn sm" style={{ marginLeft:8 }}>Retry</button></div>

  const csrProfiles = (cfg.profiles || []).filter(p => p.role !== 'admin' || true) // show all; admins can be CSRs too
  const jobHits = cfg.stJobTypes.filter(j => j.name?.toLowerCase().includes(jobSearch.toLowerCase()))
  const secStyle = { background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:18, marginBottom:18 }
  const hStyle = { fontSize:14, fontWeight:700, marginBottom:2 }
  const subStyle = { fontSize:12, color:'var(--text-muted)', marginBottom:14 }
  const selStyle = { padding:'6px 8px', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, background:'var(--surface)', color:'var(--text-primary)' }
  const saveBtn = (onClick, key) => (
    <button onClick={onClick} disabled={busy===key} className="btn sm"
      style={{ background:'var(--accent)', borderColor:'var(--accent)', color:'#fff', fontWeight:600 }}>
      {busy===key ? 'Saving…' : 'Save'}
    </button>
  )

  return (
    <div style={{ maxWidth:900 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
        <div style={{ fontSize:12, color:'var(--text-muted)' }}>Map ServiceTitan data to commission rules. The reconciler uses these to attribute and pay spiffs.</div>
        {savedMsg && <span style={{ fontSize:12, color:'#16A34A', fontWeight:600 }}>{savedMsg}</span>}
      </div>
      {err && <div style={{ fontSize:12, color:'#DC2626', marginBottom:10 }}>{err}</div>}

      {/* CSR ↔ ST user */}
      <div style={secStyle}>
        <div style={hStyle}>CSRs → ServiceTitan users</div>
        <div style={subStyle}>Match each CSR to their ST login so jobs they book directly in ServiceTitan get attributed. Auto-matched by name where possible.</div>
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {csrProfiles.map(p => (
            <div key={p.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
              <span style={{ fontSize:13, fontWeight:500 }}>{p.name || p.email}</span>
              <select value={csrMap[p.id] || ''} onChange={e => setCsrMap(m => ({ ...m, [p.id]: e.target.value ? Number(e.target.value) : '' }))} style={{ ...selStyle, minWidth:240 }}>
                <option value="">— not mapped —</option>
                {cfg.stEmployees.map(e => <option key={e.id} value={e.id}>{e.name}{e.email ? ` (${e.email})` : ''}</option>)}
              </select>
            </div>
          ))}
        </div>
        <div style={{ marginTop:14, textAlign:'right' }}>{saveBtn(saveCsrs, 'csr')}</div>
      </div>

      {/* Category → payout. This is what the sync actually pays. */}
      <div style={secStyle}>
        <div style={hStyle}>Category payouts</div>
        <div style={subStyle}>
          What each category pays a rep. This is the amount the sync uses — job types themselves carry no amount,
          only a category. A category left blank pays nothing and the job stays unsettled until you set it,
          so no payout is lost by filling this in late.
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {JOB_CATEGORIES.map(c => (
            <div key={c.value} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
              <span style={{ fontSize:13 }}>
                {c.label}
                <span style={{ fontSize:11, color:'var(--text-muted)', marginLeft:8 }}>
                  {(cfg.jobTypeSpiffs || []).filter(j => j.category === c.value).length} job types
                </span>
              </span>
              <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                <span style={{ fontSize:13, color:'var(--text-muted)' }}>$</span>
                <input type="number" step="0.01" min="0" value={catAmts[c.value] ?? ''} placeholder="—"
                  onChange={e => setCatAmts(a => ({ ...a, [c.value]: e.target.value === '' ? '' : Number(e.target.value) }))}
                  style={{ width:90, padding:'6px 8px', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, background:'var(--surface)', color:'var(--text-primary)' }} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop:14, textAlign:'right' }}>{saveBtn(saveCatAmts, 'cats')}</div>
      </div>

      {/* Job type → category */}
      <div style={secStyle}>
        <div style={hStyle}>Job types → spiff category</div>
        <div style={subStyle}>
          Tag each ST job type — the category decides the payout. Anything left non-commissionable never pays.
          Every category pays when ServiceTitan marks the job <strong>completed</strong>, including the estimate
          categories: a free estimate that completes pays out whether or not it sold anything.
        </div>
        <input value={jobSearch} onChange={e => setJobSearch(e.target.value)} placeholder="Search job types…"
          style={{ width:'100%', padding:'7px 10px', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, marginBottom:10, background:'var(--surface-2)', color:'var(--text-primary)' }} />
        <div style={{ maxHeight:340, overflowY:'auto', display:'flex', flexDirection:'column', gap:6, paddingRight:4 }}>
          {jobHits.map(j => (
            <div key={j.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
              <span style={{ fontSize:12.5 }}>{j.name}</span>
              <select value={jobCats[j.id] || 'non_commissionable'} onChange={e => setJobCats(c => ({ ...c, [j.id]: e.target.value }))}
                style={{ ...selStyle, minWidth:280, color: (jobCats[j.id] && jobCats[j.id]!=='non_commissionable') ? 'var(--accent)' : 'var(--text-muted)', fontWeight: (jobCats[j.id] && jobCats[j.id]!=='non_commissionable') ? 600 : 400 }}>
                {JOB_CATEGORIES.map(c => (
                  <option key={c.value} value={c.value}>
                    {c.label}{catAmts[c.value] != null && catAmts[c.value] !== '' ? ` — $${Number(catAmts[c.value]).toFixed(2)}` : ''}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {jobHits.length === 0 && <div style={{ fontSize:12, color:'var(--text-muted)', padding:8 }}>No job types match.</div>}
        </div>
        <div style={{ marginTop:14, textAlign:'right' }}>{saveBtn(saveJobs, 'jobs')}</div>
      </div>

      {/* Membership type → payout + how to sell it */}
      <div style={secStyle}>
        <div style={hStyle}>Membership types → payout &amp; sale setup</div>
        <div style={subStyle}>
          Set the spiff for each ST membership type (e.g. Full $20, HVAC-only $10).
          To let reps <strong>sell</strong> a membership from the dialer, also pick its sale task and term —
          ServiceTitan can't tell us which pricebook item sells which membership, so it has to be set here once.
          <strong> Selling creates a real invoice for the customer.</strong>
        </div>

        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:10, color:'var(--text-muted)', marginBottom:3, fontWeight:600 }}>SEARCH PRICEBOOK FOR SALE TASKS</div>
          <input value={svcQuery} onChange={e => setSvcQuery(e.target.value)} placeholder="e.g. membership, ACMP…"
            style={{ width:'100%', padding:'7px 10px', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, background:'var(--surface-2)', color:'var(--text-primary)' }} />
          <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:4 }}>
            {svcLoading ? 'Searching…'
              : svcMeta.truncated
                ? `Showing ${services.length} of ${svcMeta.total} matches — narrow the search to see the rest.`
                : `${services.length} match${services.length === 1 ? '' : 'es'}. Your pricebook has ~1,600 services, so this list is always filtered.`}
            {' '}Beware the <strong>Renewal</strong> variants — those renew an existing member rather than sell a new one.
          </div>
        </div>

        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          {cfg.stMembershipTypes.map(m => {
            const sellable = memSale[m.id]?.sale_task_id && memSale[m.id]?.duration_billing_id
            return (
              <div key={m.id} style={{ border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:12, display:'flex', flexDirection:'column', gap:10 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
                  <span style={{ fontSize:13, fontWeight:600 }}>
                    {m.name}
                    <span style={{ marginLeft:8, fontSize:9, fontWeight:700, textTransform:'uppercase', letterSpacing:.4, padding:'2px 6px', borderRadius:99,
                      background: sellable ? 'var(--success-bg)' : 'var(--surface-2)', color: sellable ? 'var(--success)' : 'var(--text-muted)' }}>
                      {sellable ? 'Sellable' : 'Payout only'}
                    </span>
                  </span>
                  <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                    <span style={{ fontSize:13, color:'var(--text-muted)' }}>$</span>
                    <input type="number" step="0.01" value={memAmts[m.id] ?? ''} placeholder="0.00"
                      onChange={e => setMemAmts(a => ({ ...a, [m.id]: e.target.value === '' ? '' : Number(e.target.value) }))}
                      style={{ width:90, padding:'6px 8px', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, background:'var(--surface)', color:'var(--text-primary)' }} />
                  </div>
                </div>

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div>
                    <div style={{ fontSize:10, color:'var(--text-muted)', marginBottom:3, fontWeight:600 }}>SALE TASK (pricebook item)</div>
                    <select value={memSale[m.id]?.sale_task_id || ''}
                      onChange={e => {
                        const id = e.target.value
                        const svc = services.find(s => String(s.id) === String(id))
                        setMemSale(s => ({ ...s, [m.id]: { ...s[m.id], sale_task_id: id || null, sale_task_name: svc?.name || null } }))
                      }}
                      style={{ width:'100%', padding:'6px 8px', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, background:'var(--surface)', color:'var(--text-primary)' }}>
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
                    <div style={{ fontSize:10, color:'var(--text-muted)', marginBottom:3, fontWeight:600 }}>TERM / BILLING</div>
                    <select value={memSale[m.id]?.duration_billing_id || ''}
                      onChange={e => setMemSale(s => ({ ...s, [m.id]: { ...s[m.id], duration_billing_id: e.target.value || null } }))}
                      onFocus={() => loadDurations(m.id)}
                      style={{ width:'100%', padding:'6px 8px', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, background:'var(--surface)', color:'var(--text-primary)' }}>
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
          {cfg.stMembershipTypes.length === 0 && <div style={{ fontSize:12, color:'var(--text-muted)' }}>No membership types returned from ServiceTitan.</div>}
        </div>
        <div style={{ marginTop:14, textAlign:'right' }}>{saveBtn(saveMems, 'mems')}</div>
      </div>
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

  if (loading) return <div className="spinner" style={{ margin:'40px auto' }} />

  const TONES = [
    { id:'info', label:'Info', color:'var(--text-primary)' },
    { id:'success', label:'Good news', color:'#16A34A' },
    { id:'alert', label:'Alert', color:'#DC2626' },
  ]

  return (
    <div className="card" style={{ maxWidth:760 }}>
      <div className="card-header">
        <div className="card-title">Call Center TV — Floor Ticker</div>
        {msg && <span style={{ fontSize:12, color: msg.startsWith('Error') ? 'var(--danger)' : 'var(--success)' }}>{msg}</span>}
      </div>
      <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:16 }}>
        <div style={{ fontSize:12, color:'var(--text-muted)' }}>
          Messages scroll across the top of the Call Center TV. Use Alert (red) for anything urgent to the floor.
        </div>

        <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer' }}>
          <div onClick={() => { const v = !enabled; setEnabled(v); save(v, messages) }}
            style={{ width:40, height:22, borderRadius:99, background: enabled ? 'var(--accent)' : 'var(--border)', position:'relative', transition:'background .15s', flexShrink:0 }}>
            <div style={{ position:'absolute', top:2, left: enabled ? 20 : 2, width:18, height:18, borderRadius:'50%', background:'#fff', transition:'left .15s' }} />
          </div>
          <span style={{ fontSize:13, fontWeight:600 }}>{enabled ? 'Ticker on' : 'Ticker off'}</span>
        </label>

        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {messages.map((m, i) => (
            <div key={i} style={{ display:'flex', gap:8, alignItems:'center' }}>
              <select value={m.tone || 'info'} onChange={e => setLine(i, { tone: e.target.value })}
                style={{ padding:'7px 8px', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, background:'var(--surface)', color:'var(--text-primary)', flexShrink:0 }}>
                {TONES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <input className="form-input" value={m.text} placeholder="Message to the floor…"
                onChange={e => setLine(i, { text: e.target.value })}
                style={{ flex:1, borderLeft:`3px solid ${TONES.find(t => t.id === (m.tone||'info'))?.color}` }} />
              <button className="btn sm danger" onClick={() => removeLine(i)}>Remove</button>
            </div>
          ))}
          {messages.length === 0 && <div style={{ fontSize:12, color:'var(--text-muted)' }}>No messages. Add one to show a ticker on the TV.</div>}
        </div>

        <div style={{ display:'flex', gap:8 }}>
          <button className="btn sm" onClick={addLine}>+ Add message</button>
          <button className="btn sm primary" onClick={() => save(enabled, messages)} disabled={saving} style={{ marginLeft:'auto' }}>
            {saving ? 'Saving…' : 'Save ticker'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CommissionReport() {
  const [range, setRange] = useState('week')
  const [rows, setRows] = useState([])
  const [jobTypes, setJobTypes] = useState({})
  const [membTypes, setMembTypes] = useState({})
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [repFilter, setRepFilter] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    const { start } = rangeBounds(range)
    const [{ data: comms }, { data: jt }, { data: mt }] = await Promise.all([
      sb.from('commissions').select('*, profiles!profile_id(name, email)')
        .gte('earned_at', start.toISOString()).order('earned_at', { ascending: false }).limit(2000),
      sb.from('job_type_spiffs').select('st_job_type_id, name'),
      sb.from('membership_type_spiffs').select('st_membership_type_id, name'),
    ])
    const jtMap = {}, mtMap = {}
    ;(jt || []).forEach(x => { jtMap[String(x.st_job_type_id)] = x.name })
    ;(mt || []).forEach(x => { mtMap[String(x.st_membership_type_id)] = x.name })
    setJobTypes(jtMap); setMembTypes(mtMap)
    setRows(comms || [])
    setLoading(false)
  }, [range])

  useEffect(() => { load() }, [load])

  const runSync = async () => {
    setSyncing(true); setSyncMsg('')
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch('/api/admin/commission/sync', {
        method: 'POST', headers: { Authorization: `Bearer ${session?.access_token}` },
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || `Sync failed (${res.status})`)
      setSyncMsg(`✓ ${out.jobs?.paid ?? 0} job(s) paid, ${out.jobs?.canceled ?? 0} cancelled, ${out.memberships?.paid ?? 0} membership(s) paid`)
      await load()
    } catch (e) {
      setSyncMsg(`Error: ${e.message}`)
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMsg(''), 8000)
    }
  }

  const repName = (r) => r.profiles?.name || r.rep_name || 'Unknown'
  const reps = [...new Set(rows.map(repName))].sort()
  const shown = repFilter === 'all' ? rows : rows.filter(r => repName(r) === repFilter)

  const total = shown.reduce((s, r) => s + parseFloat(r.amount || 0), 0)
  const byRep = {}
  shown.forEach(r => { byRep[repName(r)] = (byRep[repName(r)] || 0) + parseFloat(r.amount || 0) })

  const fmtDay = (ts) => ts ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

  const typeLabel = (r) => {
    if (r.event_type === 'membership') return membTypes[String(r.st_membership_type_id)] || 'Membership'
    if (r.event_type === 'adjustment') return r.notes || 'Manual adjustment'
    return jobTypes[String(r.st_job_type_id)] || 'Job'
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
      <div className="card">
        <div className="card-header">
          <div className="card-title">Commission Payouts</div>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            {syncMsg && <span style={{ fontSize:12, color: syncMsg.startsWith('Error') ? 'var(--danger)' : 'var(--success)' }}>{syncMsg}</span>}
            <button className="btn sm" onClick={runSync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync from ServiceTitan'}
            </button>
          </div>
        </div>
        <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <div style={{ fontSize:11, color:'var(--text-muted)' }}>
            Reps are paid when ServiceTitan marks the job completed, at the amount tagged against the job type.
            Syncs automatically every 15 minutes.
          </div>

          <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
            {Object.entries(RANGES).map(([k, v]) => (
              <button key={k} className={`btn sm${range === k ? ' primary' : ''}`} onClick={() => setRange(k)}>{v.label}</button>
            ))}
            <select className="form-input" style={{ width:'auto', marginLeft:8, fontSize:12, padding:'4px 8px' }}
              value={repFilter} onChange={e => setRepFilter(e.target.value)}>
              <option value="all">All reps</option>
              {reps.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <div style={{ marginLeft:'auto', fontSize:13, fontWeight:700 }}>
              Total: <span style={{ color:'var(--accent)' }}>${total.toFixed(2)}</span>
              <span style={{ fontWeight:400, color:'var(--text-muted)', marginLeft:6 }}>({shown.length} payout{shown.length === 1 ? '' : 's'})</span>
            </div>
          </div>

          {Object.keys(byRep).length > 1 && (
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              {Object.entries(byRep).sort((a, b) => b[1] - a[1]).map(([name, amt]) => (
                <span key={name} style={{ fontSize:11, padding:'3px 9px', borderRadius:99, background:'var(--surface-2)', fontWeight:600 }}>
                  {name} <span style={{ color:'var(--accent)' }}>${amt.toFixed(2)}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {loading ? <div className="card-body"><div className="spinner" /></div> : shown.length === 0 ? (
          <div className="card-body" style={{ color:'var(--text-muted)', fontSize:13 }}>
            No payouts in this range. Commissions appear once ServiceTitan marks a booked job completed.
          </div>
        ) : (
          <div style={{ overflowX:'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Rep</th><th>Type</th><th>Customer</th><th>Job / Membership</th>
                  <th>Booked / Sold</th><th>Completed</th><th style={{ textAlign:'right' }}>Payout</th><th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map(r => (
                  <tr key={r.id}>
                    <td style={{ padding:'10px 12px', fontWeight:600 }}>{repName(r)}</td>
                    <td style={{ padding:'10px 12px' }}>
                      <span style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.4, padding:'2px 7px', borderRadius:99,
                        background: r.event_type === 'membership' ? 'var(--accent-bg)' : 'var(--surface-2)',
                        color: r.event_type === 'membership' ? 'var(--accent)' : 'var(--text-secondary)' }}>
                        {r.event_type === 'booking' ? 'Job' : r.event_type}
                      </span>
                    </td>
                    <td style={{ padding:'10px 12px' }}>{r.contact_name || '—'}</td>
                    <td style={{ padding:'10px 12px', fontSize:12, color:'var(--text-secondary)' }}>{typeLabel(r)}</td>
                    <td style={{ padding:'10px 12px', fontSize:12 }}>{fmtDay(r.booked_at)}</td>
                    <td style={{ padding:'10px 12px', fontSize:12 }}>
                      {r.event_type === 'membership'
                        ? <span style={{ color:'var(--text-muted)' }}>—</span>
                        : fmtDay(r.completed_at)}
                    </td>
                    <td style={{ padding:'10px 12px', textAlign:'right', fontWeight:700, color:'#16A34A' }}>${parseFloat(r.amount || 0).toFixed(2)}</td>
                    <td style={{ padding:'10px 12px' }}>
                      {r.st_job_id && (
                        <a href={ST_JOB_URL(r.st_job_id)} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize:11, color:'var(--accent)', fontWeight:600, whiteSpace:'nowrap' }}>
                          Job {r.job_number || r.st_job_id} ↗
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default function AdminPage() {
  const { profile, isAdmin, refreshProfile } = useAuth()
  const { campaigns } = useData()
  const [settingsTab, setSettingsTab] = useState('users')
  const [showMapping, setShowMapping] = useState(false)
  const [hoveredTab, setHoveredTab] = useState(null)
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [editProfile, setEditProfile] = useState(null)
  const [csrCampaigns, setCsrCampaigns] = useState([])
  const [saving, setSaving] = useState(false)
  // Password change
  const [pwModal, setPwModal] = useState(null) // { profileId, name } or 'me'
  const [busyUser, setBusyUser] = useState(null) // profile id mid deactivate/reactivate
  const [showRemoved, setShowRemoved] = useState(false)
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
  const [scSelectedProfile, setScSelectedProfile] = useState(null)
  const [scMonth, setScMonth] = useState({ year: _now.getFullYear(), month: _now.getMonth() })
  const [scActuals, setScActuals] = useState({ booking_pct: '', booked_calls: '', call_quality: '', memberships: '' })
  const [scWeights, setScWeights] = useState({ attendance: 25, booking_pct: 20, booked_calls: 20, call_quality: 15, memberships: 20 })
  const [scThresholds, setScThresholds] = useState({
    attendance:   { exceeds: 0,   meets: 1,   improvement: 2  },
    booking_pct:  { exceeds: 90,  meets: 80,  improvement: 75 },
    booked_calls: { exceeds: 140, meets: 110, improvement: 85 },
    call_quality: { exceeds: 95,  meets: 90,  improvement: 85 },
    memberships:  { exceeds: 5,   meets: 3,   improvement: 2  },
  })
  const [scNotes, setScNotes] = useState('')
  const [scAttendancePoints, setScAttendancePoints] = useState(null)
  const [scLoading, setScLoading] = useState(false)
  const [scSaving, setScSaving] = useState(false)
  const [scSaved, setScSaved] = useState(false)
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
        setInvMsg({ ok: true, text: `Invite emailed to ${email} — they'll set their own name and password.` })
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

  // Load saved scorecard weights + thresholds
  useEffect(() => {
    Promise.all([
      sb.from('app_settings').select('value').eq('key', 'scorecard_weights').maybeSingle(),
      sb.from('app_settings').select('value').eq('key', 'scorecard_thresholds').maybeSingle(),
    ]).then(([{ data: wts }, { data: thr }]) => {
      if (wts?.value) { try { setScWeights(JSON.parse(wts.value)) } catch (e) {} }
      if (thr?.value) { try { setScThresholds(JSON.parse(thr.value)) } catch (e) {} }
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
    if (!file.type?.startsWith('image/')) { alert('Please choose an image file.'); return }
    const reader = new FileReader()
    reader.onload = () => setCropSrc(reader.result)   // open the crop tool
    reader.onerror = () => alert('Could not read that file.')
    reader.readAsDataURL(file)
  }

  const saveProfile = async () => {
    if (!editProfile) return
    setSaving(true)
    try {
      const { error } = await sb.from('profiles').update({ name: editProfile.name, role: editProfile.role, inbound_skill: !!editProfile.inbound_skill }).eq('id', editProfile.id)
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
  const SC_KPIS = [
    { id:'attendance',    label:'Attendance',                weight:25, unit:'pts', lowerIsBetter:true,  thresholds:{ exceeds:0, meets:1, improvement:2 } },
    { id:'booking_pct',   label:'Inbound Booking %',         weight:20, unit:'%',   lowerIsBetter:false, thresholds:{ exceeds:90, meets:80, improvement:75 } },
    { id:'booked_calls',  label:'Booked Calls',              weight:20, unit:'',    lowerIsBetter:false, thresholds:{ exceeds:140, meets:110, improvement:85 } },
    { id:'call_quality',  label:'Call Quality Evaluation(s)', weight:15, unit:'%',  lowerIsBetter:false, thresholds:{ exceeds:95, meets:90, improvement:85 } },
    { id:'memberships',   label:'Memberships Sold',          weight:20, unit:'',    lowerIsBetter:false, thresholds:{ exceeds:5, meets:3, improvement:2 } },
  ]

  const scGetRating = (kpi, value) => {
    if (value === '' || value == null) return null
    const v = parseFloat(value)
    const { lowerIsBetter } = kpi
    const thresholds = scThresholds[kpi.id] || kpi.thresholds
    if (lowerIsBetter) {
      if (v <= thresholds.exceeds)     return 4
      if (v <= thresholds.meets)       return 3
      if (v <= thresholds.improvement) return 2
      return 1
    } else {
      if (v >= thresholds.exceeds)     return 4
      if (v >= thresholds.meets)       return 3
      if (v >= thresholds.improvement) return 2
      return 1
    }
  }
  const SC_RATING_LABELS = { 4:'Exceeds', 3:'Meets', 2:'Needs Improvement', 1:'Poor Performance' }
  const SC_RATING_COLORS = {
    4: { bg:'#d4edda', text:'#2E7D52' },
    3: { bg:'#d4edda', text:'#2E7D52' },
    2: { bg:'#FBF3E0', text:'#8A5A00' },
    1: { bg:'#FBEEEA', text:'#B5341A' },
  }

  // Load scorecard data when profile/month changes
  useEffect(() => {
    if (settingsTab !== 'scorecards' || !scSelectedProfile) return
    const monthStart = `${scMonth.year}-${String(scMonth.month+1).padStart(2,'0')}-01`
    const monthEnd = new Date(scMonth.year, scMonth.month+1, 0).toISOString().split('T')[0]
    setScLoading(true)
    Promise.all([
      sb.from('attendance_points').select('points').eq('profile_id', scSelectedProfile).gte('date', monthStart).lte('date', monthEnd),
      sb.from('scorecard_actuals').select('*').eq('profile_id', scSelectedProfile).eq('month', monthStart).maybeSingle(),
    ]).then(([{ data: pts }, { data: saved }]) => {
      const total = (pts || []).reduce((s, p) => s + parseFloat(p.points || 0), 0)
      setScAttendancePoints(total)
      setScActuals({
        booking_pct: saved?.booking_pct ?? '',
        booked_calls: saved?.booked_calls ?? '',
        call_quality: saved?.call_quality ?? '',
        memberships: saved?.memberships ?? '',
      })
      setScNotes(saved?.notes ?? '')
      setScLoading(false)
    })
  }, [settingsTab, scSelectedProfile, scMonth])

  const saveScorecard = async () => {
    if (!scSelectedProfile) return
    setScSaving(true)
    const monthStart = `${scMonth.year}-${String(scMonth.month+1).padStart(2,'0')}-01`
    const [{ error: saveError }] = await Promise.all([
      sb.from('scorecard_actuals').upsert({
        profile_id: scSelectedProfile,
        month: monthStart,
        booking_pct: scActuals.booking_pct !== '' ? parseFloat(scActuals.booking_pct) : null,
        booked_calls: scActuals.booked_calls !== '' ? parseInt(scActuals.booked_calls) : null,
        call_quality: scActuals.call_quality !== '' ? parseFloat(scActuals.call_quality) : null,
        memberships: scActuals.memberships !== '' ? parseInt(scActuals.memberships) : null,
        notes: scNotes,
        weights: scWeights,
        updated_by: profile.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'profile_id,month' }),
      sb.from('app_settings').upsert(
        { key: 'scorecard_weights', value: JSON.stringify(scWeights), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      ),
      sb.from('app_settings').upsert(
        { key: 'scorecard_thresholds', value: JSON.stringify(scThresholds), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      ),
    ])
    if (saveError) {
      console.error('Scorecard save error:', saveError.message)
      setMsg('Error saving: ' + saveError.message)
      setScSaving(false)
      return
    }
    // Re-fetch to confirm what was actually saved
    const { data: confirmed } = await sb.from('scorecard_actuals').select('*').eq('profile_id', scSelectedProfile).eq('month', monthStart).maybeSingle()
    if (confirmed) {
      setScNotes(confirmed.notes ?? '')
      setScActuals({
        booking_pct: confirmed.booking_pct ?? '',
        booked_calls: confirmed.booked_calls ?? '',
        call_quality: confirmed.call_quality ?? '',
        memberships: confirmed.memberships ?? '',
      })
    }
    setScSaving(false)
    setScSaved(true)
    setTimeout(() => setScSaved(false), 2000)
  }

  const scNavMonth = (dir) => {
    setScMonth(prev => {
      let m = prev.month + dir, y = prev.year
      if (m > 11) { m = 0; y++ }
      if (m < 0)  { m = 11; y-- }
      return { year: y, month: m }
    })
  }

  const scWeightedScore = () => {
    const actuals = {
      attendance: scAttendancePoints,
      booking_pct: scActuals.booking_pct !== '' ? parseFloat(scActuals.booking_pct) : null,
      booked_calls: scActuals.booked_calls !== '' ? parseFloat(scActuals.booked_calls) : null,
      call_quality: scActuals.call_quality !== '' ? parseFloat(scActuals.call_quality) : null,
      memberships: scActuals.memberships !== '' ? parseFloat(scActuals.memberships) : null,
    }
    let totalWeight = 0, weightedScore = 0
    SC_KPIS.forEach(kpi => {
      const w = parseFloat(scWeights[kpi.id]) || 0
      const rating = scGetRating(kpi, actuals[kpi.id])
      if (rating != null) {
        totalWeight += w
        weightedScore += rating * w
      }
    })
    if (totalWeight === 0) return null
    return (weightedScore / totalWeight).toFixed(2)
  }

  const TABS = isAdmin
    ? [{ id:'users', label:'Users' }, { id:'campaigns', label:'Campaigns' }, { id:'commission', label:'Commission' }, { id:'payouts', label:'Payouts' }, { id:'statuses', label:'Statuses' }, { id:'scorecards', label:'Scorecards' }, { id:'floortv', label:'Floor TV' }]
    : [{ id:'users', label:'My Profile' }, { id:'commission', label:'My Earnings' }]

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

      {/* Tab bar header */}
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
        <div style={{ padding:'16px 24px 0' }}>
          <div style={{ fontSize:18, fontWeight:600, color:'var(--text-primary)' }}>Settings</div>
          <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2 }}>Manage users, campaigns, commission, and statuses</div>
        </div>
        <div style={{ display:'flex', padding:'0 24px', marginTop:10 }}>
          {TABS.map(t => {
            const isActive = settingsTab === t.id
            const isHov = hoveredTab === t.id && !isActive
            return (
              <button key={t.id} onClick={() => setSettingsTab(t.id)}
                onMouseEnter={() => setHoveredTab(t.id)}
                onMouseLeave={() => setHoveredTab(null)}
                style={{
                  padding:'10px 16px', fontSize:13, fontWeight: isActive ? 600 : 400,
                  border:'none', cursor:'pointer',
                  borderRadius:'var(--radius) var(--radius) 0 0',
                  background: isHov ? 'var(--surface-2)' : 'transparent',
                  color: isActive ? 'var(--accent)' : isHov ? 'var(--text-primary)' : 'var(--text-muted)',
                  borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  transition:'color .1s, background .1s',
                }}>
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Campaigns tab — full CampaignsPage */}
      {settingsTab === 'campaigns' && <CampaignsPage />}

      {settingsTab === 'payouts' && isAdmin && (
        <div style={{ flex:1, overflowY:'auto', padding:24 }}>
          <CommissionReport />
        </div>
      )}

      {settingsTab === 'floortv' && isAdmin && (
        <div style={{ flex:1, overflowY:'auto', padding:24 }}>
          <FloorTicker />
        </div>
      )}



      {/* Statuses tab — admin only */}
      {settingsTab === 'statuses' && isAdmin && (
        <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:20 }}>
          <div className="card">
            <div className="card-header">
              <div className="card-title">Status Customization</div>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                {statusSaveMsg && <span style={{ fontSize:11, color: statusSaveMsg.startsWith('Error') ? 'var(--danger)' : 'var(--success)', fontWeight:600 }}>{statusSaveMsg}</span>}
                {savingStatuses && <span style={{ fontSize:11, color:'var(--text-muted)' }}>Saving...</span>}
                <span style={{ fontSize:11, color:'var(--text-muted)' }}>Changes save automatically. Locked statuses cannot be removed.</span>
              </div>
            </div>
            <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {customStatuses.map((status, idx) => (
                <div key={status.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', background:'var(--surface-2)', borderRadius:'var(--radius)', border:'1px solid var(--border)' }}>
                  {/* Clickable color circle */}
                  <label style={{ position:'relative', flexShrink:0, cursor: status.locked ? 'default' : 'pointer' }} title={status.locked ? '' : 'Click to change color'}>
                    <div style={{ width:28, height:28, borderRadius:'50%', background:status.color, border:'2px solid rgba(0,0,0,.12)', transition:'transform .1s', boxShadow:'0 1px 4px rgba(0,0,0,.15)' }}
                      onMouseEnter={e => { if (!status.locked) e.currentTarget.style.transform='scale(1.15)' }}
                      onMouseLeave={e => e.currentTarget.style.transform='scale(1)'} />
                    {!status.locked && (
                      <input type="color" value={status.color}
                        onChange={e => updateStatuses(prev => prev.map((s,i) => i===idx ? {...s, color:e.target.value} : s))}
                        style={{ position:'absolute', opacity:0, width:0, height:0, pointerEvents:'none' }} />
                    )}
                  </label>
                  {/* Label */}
                  <input value={status.label} disabled={status.locked}
                    onChange={e => updateStatuses(prev => prev.map((s,i) => i===idx ? {...s, label:e.target.value} : s))}
                    style={{ flex:1, border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'6px 10px', fontSize:13, background: status.locked ? 'var(--surface)' : 'var(--surface)', color:'var(--text-primary)', fontFamily:'inherit', cursor: status.locked ? 'default' : 'text' }} />
                  {status.locked
                    ? <span style={{ fontSize:10, color:'var(--text-muted)', padding:'2px 8px', background:'var(--surface)', borderRadius:99, border:'1px solid var(--border)', flexShrink:0 }}>Locked</span>
                    : <button onClick={() => updateStatuses(prev => prev.filter((_,i) => i !== idx))}
                        style={{ padding:'4px 10px', background:'var(--danger-bg)', border:'1px solid var(--danger)', borderRadius:'var(--radius)', color:'var(--danger)', fontSize:11, cursor:'pointer', fontWeight:500, flexShrink:0 }}>Remove</button>
                  }
                </div>
              ))}

              {/* Add new status */}
              <button onClick={() => updateStatuses(prev => [...prev, { id:`custom_${Date.now()}`, label:'New Status', color:'#6b7280', locked:false }])}
                style={{ padding:'8px 16px', border:'1px dashed var(--border)', borderRadius:'var(--radius)', background:'transparent', color:'var(--text-muted)', fontSize:12, cursor:'pointer', display:'flex', alignItems:'center', gap:6, marginTop:2 }}>
                + Add status
              </button>

              <div style={{ padding:'10px 14px', background:'var(--warning-bg)', border:'1px solid #C87800', borderRadius:'var(--radius)', fontSize:12, color:'var(--warning)' }}>
                Status changes affect all reps on next page load. Removing a status does not affect historical adherence data.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Commission tab */}
      {settingsTab === 'commission' && (
        <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:20 }}>
          {commLoading ? <div className="spinner" style={{ margin:'40px auto' }} /> : (
            <>
              {/* The old flat booking/membership rates are gone: payouts now come
                  from the per-job-type amounts in Commission Mapping, paid when
                  ServiceTitan marks the job completed. */}
              {isAdmin && (
                <div className="card">
                  <div className="card-header"><div className="card-title">How payouts work</div></div>
                  <div className="card-body" style={{ fontSize:12, color:'var(--text-secondary)', lineHeight:1.6 }}>
                    Each job type carries its own payout — set them under <strong>Commission Mapping</strong> below.
                    A rep is paid when ServiceTitan marks the booked job <strong>completed</strong>, not when they book it,
                    so earnings appear after the job runs. Membership payouts come from the per-membership-type amounts.
                    See the <strong>Payouts</strong> tab for the full ledger.
                  </div>
                </div>
              )}

              {/* Admin: All rep earnings this week */}
              {isAdmin && allRepEarnings.length > 0 && (
                <div className="card">
                  <div className="card-header"><div className="card-title">Team Earnings - This Week</div></div>
                  <table className="data-table">
                    <thead><tr><th>Rep</th><th style={{textAlign:'center'}}>Today</th><th style={{textAlign:'center'}}>This Week</th><th style={{textAlign:'center'}}>Bookings</th><th style={{textAlign:'center'}}>Memberships</th></tr></thead>
                    <tbody>
                      {allRepEarnings.map(([name, d]) => (
                        <tr key={name}>
                          <td style={{padding:'10px 12px', fontWeight:600}}>{name}</td>
                          <td style={{padding:'10px 12px', textAlign:'center', fontWeight:700, color:'#16A34A'}}>{'$'}{d.daily.toFixed(2)}</td>
                          <td style={{padding:'10px 12px', textAlign:'center', fontWeight:700, color:'var(--accent)'}}>{'$'}{d.weekly.toFixed(2)}</td>
                          <td style={{padding:'10px 12px', textAlign:'center'}}>{d.bookings}</td>
                          <td style={{padding:'10px 12px', textAlign:'center'}}>{d.memberships}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Rep: Personal earnings summary */}
              {!isAdmin && (
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
                  {[
                    { label:'Today', value: commissionHistory.filter(c => new Date(c.earned_at).toISOString().split('T')[0] === new Date().toISOString().split('T')[0]).reduce((s,c) => s + parseFloat(c.amount), 0), accent:'#16A34A', note:'Resets at midnight' },
                    { label:'This Week', value: commissionHistory.reduce((s,c) => s + parseFloat(c.amount), 0), accent:'var(--accent)', note:'Resets Monday 12:01am' },
                  ].map(({ label, value, accent, note }) => (
                    <div key={label} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:16, padding:'24px', textAlign:'center' }}>
                      <div style={{ fontSize:12, fontWeight:600, textTransform:'uppercase', letterSpacing:.8, color:'var(--text-muted)', marginBottom:8 }}>{label}</div>
                      <div style={{ fontSize:42, fontWeight:900, color:accent, letterSpacing:-1 }}>{'$'}{value.toFixed(2)}</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:6 }}>{note}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Admin: Manual adjustment panel */}
              {isAdmin && (
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">Manual Adjustment</div>
                    <span style={{ fontSize:11, color:'var(--text-muted)' }}>Add or deduct from a rep's commission balance</span>
                  </div>
                  <div className="card-body">
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
                          style={{ color: adjAmount && parseFloat(adjAmount) < 0 ? 'var(--danger)' : parseFloat(adjAmount) > 0 ? 'var(--success)' : 'var(--text-primary)' }} />
                      </div>
                      <div className="form-field" style={{ margin:0 }}>
                        <label className="form-label">Reason</label>
                        <input className="form-input" value={adjNote} onChange={e => setAdjNote(e.target.value)}
                          placeholder="e.g. Bonus for membership upsell" />
                      </div>
                      <button className="btn primary" onClick={addInlineAdjustment}
                        disabled={adjSaving || !adjProfileId || !adjAmount}
                        style={{ whiteSpace:'nowrap', height:36 }}>
                        {adjSaving ? 'Adding...' : 'Add'}
                      </button>
                    </div>
                    <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:8 }}>
                      Use a negative amount to deduct (e.g. -5.00). Adjustments appear immediately in the history below.
                    </div>
                  </div>
                </div>
              )}

              {/* Commission history */}
              <div className="card">
                <div className="card-header"><div className="card-title">Commission History — This Week</div></div>
                {commissionHistory.length === 0 ? (
                  <div className="empty-state"><div className="empty-icon">--</div><div>No commissions earned yet this week</div></div>
                ) : (
                  <table className="data-table">
                    <thead><tr>{isAdmin && <th>Rep</th>}<th>Type</th><th>Detail</th><th style={{textAlign:'right'}}>Amount</th><th>When</th>{isAdmin && <th>By</th>}</tr></thead>
                    <tbody>
                      {commissionHistory.filter(c => !isAdmin ? c.profile_id === profile?.id : true).map(c => {
                        const isAdj = c.event_type === 'adjustment'
                        const isMem = c.event_type === 'membership'
                        const amt = parseFloat(c.amount)
                        const updaterProfile = c.updated_by ? profiles.find(p => p.id === c.updated_by) : null
                        const madeBy = c._updaterName || updaterProfile?.name || updaterProfile?.email || (isAdj ? 'Admin' : null)
                        return (
                          <tr key={c.id}>
                            {isAdmin && <td style={{padding:'10px 12px', fontWeight:500}}>{c.profiles?.name || c.rep_name}</td>}
                            <td style={{padding:'10px 12px'}}>
                              <span style={{ padding:'2px 8px', borderRadius:99, fontSize:11, fontWeight:600,
                                background: isAdj ? (amt < 0 ? 'var(--danger-bg)' : 'var(--warning-bg)') : isMem ? '#EFF6FF' : '#DCFCE7',
                                color: isAdj ? (amt < 0 ? 'var(--danger)' : 'var(--warning)') : isMem ? '#3b82f6' : '#16A34A' }}>
                                {isAdj ? 'Adjustment' : isMem ? 'Membership' : 'Booking'}
                              </span>
                            </td>
                            <td style={{padding:'10px 12px', color:'var(--text-secondary)', fontSize:12}}>
                              {isAdj ? (c.notes || 'Manual adjustment') : c.contact_name}
                            </td>
                            <td style={{padding:'10px 12px', textAlign:'right', fontWeight:700, color: amt < 0 ? 'var(--danger)' : '#16A34A'}}>
                              {amt >= 0 ? '+' : ''}{'$'}{amt.toFixed(2)}
                            </td>
                            <td style={{padding:'10px 12px', color:'var(--text-muted)', fontSize:11}}>
                              {new Date(c.earned_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}
                            </td>
                            {isAdmin && (
                              <td style={{padding:'10px 12px', fontSize:11, color: madeBy ? 'var(--text-secondary)' : 'var(--text-muted)'}}>
                                {madeBy || '--'}
                              </td>
                            )}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}

          {/* Commission engine setup / mapping (collapsible) */}
          {isAdmin && (
            <div style={{ borderTop:'1px solid var(--border)', marginTop:20, paddingTop:16 }}>
              <button onClick={() => setShowMapping(v => !v)} style={{ display:'flex', alignItems:'center', gap:8, background:'none', border:'none', cursor:'pointer', padding:0, fontSize:14, fontWeight:700, color:'var(--text-primary)' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showMapping ? 'rotate(90deg)' : 'none', transition:'transform .15s' }}><path d="m9 18 6-6-6-6"/></svg>
                Commission engine setup
              </button>
              <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2, marginLeft:20 }}>Map ServiceTitan users, job types, and membership types to spiff rules.</div>
              {showMapping && <div style={{ marginTop:16 }}><CommissionMapping /></div>}
            </div>
          )}
        </div>
      )}


      {/* Users tab */}
      {settingsTab === 'users' && (
        <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:20 }}>

          {/* MY PROFILE */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">My Profile</div>
              {profileMsg && <span style={{ fontSize:12, color:'var(--success)' }}>{profileMsg}</span>}
            </div>
            <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:16 }}>
                <div style={{ position:'relative', flexShrink:0 }}>
                  <div style={{ width:64, height:64, borderRadius:'50%', overflow:'hidden', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:38, fontWeight:700, border:'2px solid var(--border)' }}>
                    <Avatar avatar={myAvatar} name={myName || profile?.email} />
                  </div>
                  <button onClick={() => { setPickerSelected(myAvatar); setShowAvatarPicker(true) }}
                    style={{ position:'absolute', bottom:0, right:0, width:22, height:22, borderRadius:'50%', background:'var(--accent)', border:'2px solid var(--surface)', color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}
                    title="Change avatar">+</button>
                </div>
                <div>
                  <div style={{ fontSize:13, fontWeight:600 }}>{myName || profile?.email}</div>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>
                    {!myAvatar ? 'No avatar set' : /^(data:|https?:|\/)/.test(myAvatar) ? 'Photo set' : `Emoji ${myAvatar}`} · <span style={{ color:'var(--accent)', cursor:'pointer' }} onClick={() => { setPickerSelected(myAvatar); setShowAvatarPicker(true) }}>Change</span>
                  </div>
                </div>
              </div>
              <div className="form-field">
                <label className="form-label">Display name</label>
                <input className="form-input" value={myName} onChange={e => setMyName(e.target.value)} placeholder="Your name"
                  onBlur={() => { if ((myName || '') !== (profile?.name || '')) saveMyProfile({ name: myName }) }} />
              </div>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
                <span style={{ fontSize:12, color:'var(--text-muted)' }}>{savingProfile ? 'Saving…' : profileMsg || 'Changes save automatically'}</span>
                <div style={{ flex:1 }} />
                <button className="btn" onClick={() => { setPwModal('me'); setNewPw(''); setPwMsg('') }}>
                  Change my password
                </button>
              </div>
            </div>
          </div>

          {/* EMOJI PICKER MODAL */}
          {showAvatarPicker && (
            <Modal title="Choose Your Avatar" onClose={() => setShowAvatarPicker(false)} width={520}>
              <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
                <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', background:'var(--surface-2)', borderRadius:'var(--radius)' }}>
                  <div style={{ width:48, height:48, borderRadius:'50%', overflow:'hidden', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:28, fontWeight:700, flexShrink:0 }}>
                    <Avatar avatar={pickerSelected || myAvatar} name={myName || profile?.email} />
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:600 }}>{myName || profile?.email}</div>
                    <div style={{ fontSize:11, color:'var(--text-muted)' }}>{pickerSelected ? 'Looking good! Hit save to lock it in.' : 'Upload a photo or pick an emoji'}</div>
                  </div>
                  <label className="btn sm" style={{ cursor:'pointer', flexShrink:0 }}>
                    Upload photo
                    <input type="file" accept="image/*" onChange={onAvatarFile} style={{ display:'none' }} />
                  </label>
                </div>
                <div style={{ maxHeight:400, overflowY:'auto', display:'flex', flexDirection:'column', gap:14 }}>
                  {Object.entries(EMOJIS).map(([category, emojis]) => (
                    <div key={category}>
                      <div style={{ fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', marginBottom:6 }}>{category}</div>
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
              {msg && <div style={{ background: msg.startsWith('Error') ? 'var(--danger-bg)' : 'var(--success-bg)', color: msg.startsWith('Error') ? 'var(--danger)' : 'var(--success)', padding:'10px 14px', borderRadius:'var(--radius)', fontSize:13 }}>{msg}</div>}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">User Management</div>
                  <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                    <span style={{ fontSize:11, color:'var(--text-muted)' }}>Invite by email below — they set their own name and password</span>
                    {removedProfiles.length > 0 && (
                      <button className="btn sm" onClick={() => setShowRemoved(v => !v)}>
                        {showRemoved ? 'Hide' : `Show removed (${removedProfiles.length})`}
                      </button>
                    )}
                  </div>
                </div>
                {/* Invite a user */}
                <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:8 }}>
                  <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                    <input className="form-input" type="email" placeholder="teammate@awesomeservice.com"
                      value={invEmail} onChange={e => setInvEmail(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') sendInvite() }}
                      style={{ flex:1, minWidth:220 }} />
                    <select className="form-input" value={invRole} onChange={e => setInvRole(e.target.value)} style={{ width:110 }}>
                      <option value="rep">Rep</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button className="btn primary" onClick={sendInvite} disabled={invBusy || !invEmail.trim()}>
                      {invBusy ? 'Sending…' : 'Send invite'}
                    </button>
                  </div>
                  {invMsg && (
                    <div style={{ fontSize:12, color: invMsg.ok ? 'var(--success)' : 'var(--danger)' }}>
                      {invMsg.text}
                      {invMsg.link && (
                        <div style={{ display:'flex', gap:6, alignItems:'center', marginTop:4 }}>
                          <input className="form-input" readOnly value={invMsg.link} style={{ flex:1, fontSize:11 }}
                            onFocus={e => e.target.select()} />
                          <button className="btn sm" onClick={() => navigator.clipboard?.writeText(invMsg.link)}>Copy</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {loading ? <div className="card-body"><div className="spinner"></div></div> : (
                  <table className="data-table">
                    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active Campaigns</th><th>Actions</th></tr></thead>
                    <tbody>
                      {visibleProfiles.map(p => {
                        const activeCamps = getProfileCampaigns(p.id)
                        const removed = p.active === false
                        return (
                          <tr key={p.id} style={removed ? { opacity:.55 } : undefined}>
                            <td style={{ padding:'10px 12px', fontWeight:500 }}>
                              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                                <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--accent-bg)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: p.avatar ? 18 : 11, fontWeight:600, flexShrink:0, filter: removed ? 'grayscale(1)' : undefined }}>
                                  <Avatar avatar={p.avatar} name={p.name || p.email} />
                                </div>
                                {p.name || '—'}
                                {removed && <span style={{ fontSize:9, fontWeight:700, textTransform:'uppercase', letterSpacing:.5, padding:'2px 6px', borderRadius:99, background:'var(--surface-2)', color:'var(--text-muted)' }}>Removed</span>}
                              </div>
                            </td>
                            <td style={{ padding:'10px 12px', color:'var(--text-secondary)', fontSize:12 }}>{p.email}</td>
                            <td style={{ padding:'10px 12px' }}>
                              <span style={{ display:'inline-block', padding:'2px 8px', borderRadius:99, fontSize:10, fontWeight:600, background: p.role==='admin' ? 'var(--accent-bg)' : 'var(--surface-2)', color: p.role==='admin' ? 'var(--accent)' : 'var(--text-secondary)' }}>
                                {p.role || 'rep'}
                              </span>
                            </td>
                            <td style={{ padding:'10px 12px' }}>
                              {activeCamps.length === 0 ? <span style={{ fontSize:11, color:'var(--text-muted)' }}>No campaigns assigned</span> : (
                                <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                                  {activeCamps.map((name, i) => (
                                    <span key={name} style={{ fontSize:10, padding:'2px 7px', borderRadius:99, background:'var(--accent-bg)', color:'var(--accent)', fontWeight:600 }}>{i+1}. {name}</span>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td style={{ padding:'10px 12px' }}>
                              <div style={{ display:'flex', gap:6 }}>
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
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>

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
                    <option value="admin">Admin — full access including uploads and user management</option>
                  </select>
                </div>
                <div>
                  <label className="form-label" style={{ marginBottom:8, display:'block' }}>Skillset</label>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:10 }}>Grant the queues this rep may log into. They choose which of these to go available for. Inbound always outranks outbound; campaign #1 is served first.</div>

                  {/* Inbound skill — the fixed, top-priority queue */}
                  <label style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', marginBottom:10, borderRadius:'var(--radius)', cursor:'pointer',
                    background: editProfile.inbound_skill ? 'var(--accent-bg)' : 'var(--surface-2)',
                    border:`1px solid ${editProfile.inbound_skill ? 'var(--accent)' : 'var(--border)'}` }}>
                    <input type="checkbox" checked={!!editProfile.inbound_skill}
                      onChange={e => setEditProfile(p => ({ ...p, inbound_skill: e.target.checked }))} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, fontWeight:600, color: editProfile.inbound_skill ? 'var(--accent)' : 'var(--text-primary)' }}>Inbound queue</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)' }}>Takes live inbound calls from the queue — always served before outbound.</div>
                    </div>
                  </label>

                  <div style={{ fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', marginBottom:8 }}>Outbound campaigns</div>
                  {editProfile.campaigns.filter(c => c.active).sort((a, b) => a.priority - b.priority).length > 0 && (
                    <div style={{ marginBottom:8 }}>
                      <div style={{ fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', marginBottom:6 }}>Active (priority order)</div>
                      <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                        {editProfile.campaigns.filter(c => c.active).sort((a, b) => a.priority - b.priority).map((c, idx, arr) => (
                          <div key={c.campaign_id} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background:'var(--success-bg)', border:'1px solid var(--success)', borderRadius:'var(--radius)' }}>
                            <span style={{ fontSize:11, fontWeight:700, color:'var(--success)', minWidth:18 }}>#{idx+1}</span>
                            <span style={{ fontSize:13, fontWeight:500, flex:1 }}>{c.name}</span>
                            <div style={{ display:'flex', gap:2 }}>
                              <button onClick={() => movePriority(c.campaign_id, 'up')} disabled={idx===0} style={{ padding:'2px 6px', fontSize:11, borderRadius:4, border:'1px solid var(--border)', background:'var(--surface)', cursor: idx===0 ? 'not-allowed' : 'pointer', opacity: idx===0 ? .3 : 1 }}>▲</button>
                              <button onClick={() => movePriority(c.campaign_id, 'down')} disabled={idx===arr.length-1} style={{ padding:'2px 6px', fontSize:11, borderRadius:4, border:'1px solid var(--border)', background:'var(--surface)', cursor: idx===arr.length-1 ? 'not-allowed' : 'pointer', opacity: idx===arr.length-1 ? .3 : 1 }}>▼</button>
                            </div>
                            <button onClick={() => toggleCampaign(c.campaign_id)} style={{ padding:'2px 8px', fontSize:11, borderRadius:4, border:'1px solid var(--danger)', background:'var(--danger-bg)', color:'var(--danger)', cursor:'pointer', fontWeight:500 }}>Remove</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {editProfile.campaigns.filter(c => !c.active).length > 0 && (
                    <div>
                      <div style={{ fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-muted)', marginBottom:6 }}>Available to add</div>
                      <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                        {editProfile.campaigns.filter(c => !c.active).map(c => (
                          <div key={c.campaign_id} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:'var(--radius)' }}>
                            <span style={{ fontSize:13, flex:1, color:'var(--text-muted)' }}>{c.name}</span>
                            <button onClick={() => toggleCampaign(c.campaign_id)} style={{ padding:'2px 8px', fontSize:11, borderRadius:4, border:'1px solid var(--accent)', background:'var(--accent-bg)', color:'var(--accent)', cursor:'pointer', fontWeight:500 }}>+ Add</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div style={{ background:'var(--warning-bg)', border:'1px solid #C87800', borderRadius:'var(--radius)', padding:'10px 14px', fontSize:12, color:'var(--warning)' }}>
                  Changes take effect on next page load.
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setEditProfile(null)}>Cancel</button>
                <button className="btn primary" onClick={saveProfile} disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</button>
              </div>
            </Modal>
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
            {pwMsg && <div style={{ fontSize:12, color: pwMsg.startsWith('✓') ? 'var(--success)' : 'var(--danger)', padding:'8px 12px', background: pwMsg.startsWith('✓') ? 'var(--success-bg)' : 'var(--danger-bg)', borderRadius:'var(--radius)' }}>{pwMsg}</div>}
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => { setPwModal(null); setNewPw(''); setPwMsg('') }}>Cancel</button>
            <button className="btn primary" onClick={changePassword} disabled={savingPw || newPw.length < 6}>
              {savingPw ? 'Saving...' : 'Change password'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── SCORECARDS TAB ── */}
      {settingsTab === 'scorecards' && isAdmin && (
        <div style={{ flex:1, overflowY:'auto', padding:24 }}>

          {/* Filters row */}
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:24, flexWrap:'wrap' }}>
            {/* CSR selector */}
            <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
              <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)' }}>CSR</div>
              <select value={scSelectedProfile || ''} onChange={e => setScSelectedProfile(e.target.value || null)}
                style={{ padding:'7px 12px', fontSize:13, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface)', color:'var(--text-primary)', cursor:'pointer', minWidth:180 }}>
                <option value=''>Select a rep...</option>
                {profiles.map(p => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}
              </select>
            </div>

            {/* Month nav */}
            <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
              <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)' }}>Month</div>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <button onClick={() => scNavMonth(-1)} style={{ width:32, height:32, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-secondary)', display:'flex', alignItems:'center', justifyContent:'center' }}
                  onMouseEnter={e => e.currentTarget.style.background='var(--surface)'}
                  onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>{String.fromCharCode(8249)}</button>
                <span style={{ fontSize:13, fontWeight:500, color:'var(--text-primary)', minWidth:130, textAlign:'center' }}>{MONTH_NAMES[scMonth.month]} {scMonth.year}</span>
                <button onClick={() => scNavMonth(1)} style={{ width:32, height:32, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', cursor:'pointer', fontSize:16, color:'var(--text-secondary)', display:'flex', alignItems:'center', justifyContent:'center' }}
                  onMouseEnter={e => e.currentTarget.style.background='var(--surface)'}
                  onMouseLeave={e => e.currentTarget.style.background='var(--surface-2)'}>{String.fromCharCode(8250)}</button>
              </div>
            </div>

            {/* Actions */}
            {scSelectedProfile && (
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'transparent', userSelect:'none' }}>Actions</div>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <button onClick={saveScorecard} disabled={scSaving}
                    style={{ padding:'7px 16px', fontSize:13, fontWeight:600, background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', cursor:'pointer', opacity: scSaving ? .6 : 1, height:32 }}>
                    {scSaving ? 'Saving...' : scSaved ? 'Saved!' : 'Save'}
                  </button>
                <button onClick={() => {
                  const selectedRep = profiles.find(p => p.id === scSelectedProfile)
                  const overallScore = scWeightedScore()
                  const actuals = {
                    attendance: scAttendancePoints,
                    booking_pct: scActuals.booking_pct !== '' ? parseFloat(scActuals.booking_pct) : null,
                    booked_calls: scActuals.booked_calls !== '' ? parseFloat(scActuals.booked_calls) : null,
                    call_quality: scActuals.call_quality !== '' ? parseFloat(scActuals.call_quality) : null,
                    memberships: scActuals.memberships !== '' ? parseFloat(scActuals.memberships) : null,
                  }
                  const ratingColors = {
                    4: { bg:'#d4edda', text:'#2E7D52' },
                    3: { bg:'#d4edda', text:'#2E7D52' },
                    2: { bg:'#FBF3E0', text:'#8A5A00' },
                    1: { bg:'#FBEEEA', text:'#B5341A' },
                  }
                  const ratingLabels = { 4:'Exceeds', 3:'Meets', 2:'Needs Improvement', 1:'Poor Performance' }
                  const scoreColor = overallScore ? (parseFloat(overallScore) >= 3.5 ? '#2E7D52' : parseFloat(overallScore) >= 2.5 ? '#8A5A00' : '#B5341A') : '#1C1B19'
                  const notesEl = document.querySelector('#scorecard-print textarea')
                  const notes = scNotes || notesEl?.value || ''

                  const rows = SC_KPIS.map(kpi => {
                    const w = parseFloat(scWeights[kpi.id]) || 0
                    const actual = actuals[kpi.id]
                    const rating = scGetRating(kpi, actual)
                    const rc = rating ? ratingColors[rating] : null
                    const { lowerIsBetter, unit } = kpi
                    const thr = scThresholds[kpi.id] || kpi.thresholds
                    const fmt = (n) => unit === '%' ? `${n}%` : unit === 'pts' ? `${n} pts` : `${n}${unit || ''}`
                    const range = (lo, hi) => lo === hi ? fmt(lo) : `${fmt(lo)}-${fmt(hi)}`
                    let col4, col3, col2, col1
                    if (kpi.id === 'attendance') {
                      col4 = fmt(thr.exceeds); col3 = fmt(thr.meets); col2 = fmt(thr.improvement); col1 = `${thr.improvement + 1}+ pts`
                    } else if (lowerIsBetter) {
                      col4 = `${fmt(thr.exceeds)} or less`; col3 = range(thr.exceeds+1, thr.meets); col2 = range(thr.meets+1, thr.improvement); col1 = `${fmt(thr.improvement+1)}+`
                    } else {
                      col4 = `${fmt(thr.exceeds)}+`; col3 = range(thr.meets, thr.exceeds-1); col2 = range(thr.improvement, thr.meets-1); col1 = `Below ${fmt(thr.improvement)}`
                    }
                    const cols = [{ v:col4, r:4 }, { v:col3, r:3 }, { v:col2, r:2 }, { v:col1, r:1 }]
                    const actualDisplay = actual != null ? `${actual}${unit === 'pts' ? ' pts' : unit || ''}` : '--'
                    const badgeHtml = rating && rc ? `<div class="badge" style="background:${rc.bg};color:${rc.text}">${ratingLabels[rating]}</div>` : ''
                    const threshCells = cols.map(({ v, r }) => {
                      const c = ratingColors[r]
                      const highlight = rating === r ? `font-weight:700;` : `opacity:0.6;`
                      return `<td style="background:${c.bg};color:${c.text};${highlight}">${v}${rating === r ? ' *' : ''}</td>`
                    }).join('')
                    return `<tr>
                      <td><div class="kpi-name">${kpi.label}</div>${badgeHtml}</td>
                      <td>${w}%</td>
                      <td><span class="actual-val" style="color:${rc ? rc.text : '#1C1B19'}">${actualDisplay}</span>${kpi.id==='attendance' ? '<br><span style="font-size:10px;color:#9E9B96">auto</span>' : ''}</td>
                      ${threshCells}
                    </tr>`
                  }).join('')

                  const html = `<!DOCTYPE html><html><head>
                    <title>Scorecard - ${selectedRep?.name || ''} - ${MONTH_NAMES[scMonth.month]} ${scMonth.year}</title>
                    <style>
                      @page { margin: 0.5in 0.65in; size: letter landscape; }
                      * { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
                      body { background: white; color: #1C1B19; font-size: 13px; line-height: 1.5; display: flex; flex-direction: column; align-items: center; min-height: 100vh; padding: 0; }
                      .page { width: 100%; max-width: 960px; }
                      .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 2px solid #E2DED6; }
                      .rep-info { display: flex; align-items: center; gap: 12px; }
                      .avatar { width: 42px; height: 42px; border-radius: 50%; background: #EAF3FB; color: #1A5C8A; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 700; }
                      .rep-name { font-size: 18px; font-weight: 700; }
                      .rep-sub { font-size: 12px; color: #6B6760; margin-top: 2px; }
                      .overall { text-align: right; }
                      .overall-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #9E9B96; margin-bottom: 2px; }
                      .overall-score { font-size: 32px; font-weight: 800; letter-spacing: -1px; color: ${scoreColor}; }
                      .overall-sub { font-size: 11px; color: #9E9B96; }
                      table { width: 100%; border-collapse: collapse; margin-bottom: 20px; border: 1px solid #E2DED6; overflow: hidden; }
                      thead tr { background: #F0EEE9; }
                      th { padding: 8px 10px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: #9E9B96; text-align: center; border-bottom: 2px solid #C8C3BA; }
                      th:first-child { text-align: left; }
                      td { padding: 10px; border-bottom: 1px solid #E2DED6; font-size: 12px; text-align: center; vertical-align: middle; }
                      td:first-child { text-align: left; }
                      tr:last-child td { border-bottom: none; }
                      tr:nth-child(even) td { background: #F7F6F3; }
                      .kpi-name { font-weight: 600; font-size: 13px; }
                      .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; margin-top: 3px; }
                      .actual-val { font-size: 14px; font-weight: 700; }
                      .notes-box { border: 1px solid #E2DED6; border-radius: 8px; padding: 14px; margin-bottom: 20px; }
                      .notes-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: #9E9B96; margin-bottom: 10px; }
                      .notes-content { font-size: 13px; color: #1C1B19; min-height: 72px; white-space: pre-wrap; }
                      .sig-row { display: flex; gap: 48px; margin-top: 32px; }
                      .sig { flex: 1; }
                      .sig-line { border-top: 1px solid #C8C3BA; padding-top: 6px; font-size: 11px; color: #6B6760; }
                      .footer { display: flex; justify-content: space-between; font-size: 10px; color: #9E9B96; margin-top: 16px; padding-top: 10px; border-top: 1px solid #E2DED6; }
                    </style>
                  </head><body><div class="page">
                    <div class="header">
                      <div class="rep-info">
                        <div class="avatar">${(() => { const a = selectedRep?.avatar; if (a && /^(data:|https?:|\/)/.test(a)) return '<img src="' + a + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">'; return a || (selectedRep?.name || '?')[0].toUpperCase() })()}</div>
                        <div>
                          <div class="rep-name">${selectedRep?.name || selectedRep?.email || ''}</div>
                          <div class="rep-sub">Performance Review &mdash; ${MONTH_NAMES[scMonth.month]} ${scMonth.year}</div>
                        </div>
                      </div>
                      ${overallScore ? `<div class="overall">
                        <div class="overall-label">Overall Score</div>
                        <div class="overall-score">${overallScore}</div>
                        <div class="overall-sub">out of 4.00</div>
                      </div>` : ''}
                    </div>
                    <table>
                      <thead><tr>
                        <th>KPI</th><th>Weight</th><th>Actual</th>
                        <th>Exceeds (4)</th><th>Meets (3)</th><th>Needs Improvement (2)</th><th>Poor Performance (1)</th>
                      </tr></thead>
                      <tbody>${rows}</tbody>
                    </table>
                    <div class="notes-box">
                      <div class="notes-label">Manager Notes</div>
                      <div class="notes-content">${notes || ''}</div>
                    </div>
                    <div class="sig-row">
                      <div class="sig"><div class="sig-line">Employee Signature &amp; Date</div></div>
                      <div class="sig"><div class="sig-line">Manager Signature &amp; Date</div></div>
                    </div>
                    <div class="footer">
                      <span>Attendance auto-populated from points log. Other scores entered by manager.</span>
                      <span>Awesome Home Services &mdash; Andi</span>
                    </div>
                  </div></body></html>`

                  const win = window.open('', '_blank', 'width=1100,height=850')
                  win.document.write(html)
                  win.document.close()
                  win.focus()
                  setTimeout(() => { win.print(); win.close() }, 500)
                }}
                  style={{ padding:'7px 14px', fontSize:13, fontWeight:500, background:'var(--surface)', color:'var(--text-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor:'pointer', height:32 }}>
                  Print
                </button>
                </div>
              </div>
            )}
          </div>

          {!scSelectedProfile && (
            <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:200, color:'var(--text-muted)', fontSize:13 }}>
              Select a rep to view their scorecard
            </div>
          )}

          {scSelectedProfile && scLoading && (
            <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:200 }}>
              <div className="spinner" />
            </div>
          )}

          {scSelectedProfile && !scLoading && (() => {
            const selectedRep = profiles.find(p => p.id === scSelectedProfile)
            const overallScore = scWeightedScore()
            const actuals = {
              attendance: scAttendancePoints,
              booking_pct: scActuals.booking_pct !== '' ? parseFloat(scActuals.booking_pct) : null,
              booked_calls: scActuals.booked_calls !== '' ? parseFloat(scActuals.booked_calls) : null,
              call_quality: scActuals.call_quality !== '' ? parseFloat(scActuals.call_quality) : null,
              memberships: scActuals.memberships !== '' ? parseFloat(scActuals.memberships) : null,
            }

            return (
              <div id="scorecard-print">
                {/* Print header — hidden on screen */}
                <style>{`
                  @media print {
                    @page { margin: 0.6in; size: letter portrait; }
                    body > * { display: none !important; }
                    #scorecard-print { display: block !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 100% !important; background: white !important; z-index: 99999 !important; padding: 0 !important; }
                    #scorecard-print * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
                    .no-print { display: none !important; }
                    input, textarea { border: 1px solid #ccc !important; background: white !important; }
                  }
                `}</style>

                {/* Scorecard header */}
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                    <div style={{ width:40, height:40, borderRadius:'50%', background:'var(--accent-bg)', color:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', fontSize: selectedRep?.avatar ? 22 : 15, fontWeight:700 }}>
                      <Avatar avatar={selectedRep?.avatar} name={selectedRep?.name || selectedRep?.email} />
                    </div>
                    <div>
                      <div style={{ fontSize:16, fontWeight:700, color:'var(--text-primary)' }}>{selectedRep?.name || selectedRep?.email}</div>
                      <div style={{ fontSize:12, color:'var(--text-muted)' }}>Performance Review - {MONTH_NAMES[scMonth.month]} {scMonth.year}</div>
                    </div>
                  </div>
                  {overallScore && (
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:2 }}>Overall Score</div>
                      <div style={{ fontSize:28, fontWeight:800, color: parseFloat(overallScore) >= 3.5 ? 'var(--success)' : parseFloat(overallScore) >= 2.5 ? '#8A5A00' : 'var(--danger)', letterSpacing:'-1px' }}>{overallScore}</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)' }}>out of 4.00</div>
                    </div>
                  )}
                </div>

                {/* Scorecard table */}
                <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden', marginBottom:20 }}>
                  {/* Header */}
                  <div style={{ display:'grid', gridTemplateColumns:'1.5fr 90px 100px 1fr 1fr 1fr 1fr', background:'var(--surface-2)', borderBottom:'2px solid var(--border)' }}>
                    {['KPI','Weight','Actual','Exceeds (4)','Meets (3)','Needs Improvement (2)','Poor Performance (1)'].map((h,i) => (
                      <div key={h} style={{ padding:'10px 12px', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', textAlign: i <= 2 ? 'left' : 'center' }}>
                        {h}
                        {i === 1 && (() => {
                          const total = SC_KPIS.reduce((s, k) => s + (parseFloat(scWeights[k.id]) || 0), 0)
                          const ok = total === 100
                          return <span style={{ marginLeft:4, fontSize:9, fontWeight:700, color: ok ? 'var(--success)' : 'var(--danger)' }}>= {total}%</span>
                        })()}
                      </div>
                    ))}
                  </div>

                  {SC_KPIS.map((kpi, idx) => {
                    const actual = actuals[kpi.id]
                    const thr = scThresholds[kpi.id] || kpi.thresholds
                    const rating = scGetRating(kpi, actual)
                    const ratingStyle = rating ? SC_RATING_COLORS[rating] : null
                    const { lowerIsBetter, unit } = kpi
                    const isEditable = kpi.id !== 'attendance'
                    const thrColors = { exceeds: SC_RATING_COLORS[4], meets: SC_RATING_COLORS[3], improvement: SC_RATING_COLORS[2], poor: SC_RATING_COLORS[1] }

                    return (
                      <div key={kpi.id} style={{ display:'grid', gridTemplateColumns:'1.5fr 90px 100px 1fr 1fr 1fr 1fr', borderBottom: idx < SC_KPIS.length-1 ? '1px solid var(--border)' : 'none', background: idx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)' }}>
                        {/* KPI name + rating badge */}
                        <div style={{ padding:'12px', display:'flex', flexDirection:'column', gap:4, justifyContent:'center' }}>
                          <div style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)' }}>{kpi.label}</div>
                          {rating && ratingStyle && (
                            <div style={{ fontSize:10, fontWeight:700, padding:'2px 6px', borderRadius:4, background: ratingStyle.bg, color: ratingStyle.text, display:'inline-block', width:'fit-content' }}>
                              {SC_RATING_LABELS[rating]}
                            </div>
                          )}
                        </div>
                        {/* Weight — editable */}
                        <div style={{ padding:'8px', display:'flex', alignItems:'center' }}>
                          <div style={{ position:'relative', width:'100%' }}>
                            <input type="number" min="0" max="100"
                              value={scWeights[kpi.id]}
                              onChange={e => setScWeights(prev => ({ ...prev, [kpi.id]: e.target.value }))}
                              style={{ width:'100%', padding:'5px 22px 5px 8px', fontSize:13, fontWeight:600, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface)', color:'var(--text-primary)', textAlign:'center' }}
                            />
                            <span style={{ position:'absolute', right:6, top:'50%', transform:'translateY(-50%)', fontSize:11, color:'var(--text-muted)', pointerEvents:'none' }}>%</span>
                          </div>
                        </div>
                        {/* Actual — editable or auto */}
                        <div style={{ padding:'8px', display:'flex', alignItems:'center' }}>
                          {isEditable ? (
                            <input type="number"
                              value={scActuals[kpi.id]}
                              onChange={e => setScActuals(prev => ({ ...prev, [kpi.id]: e.target.value }))}
                              placeholder="Enter"
                              style={{ width:'100%', padding:'5px 8px', fontSize:13, fontWeight:600, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface)', color:'var(--text-primary)', textAlign:'center' }}
                            />
                          ) : (
                            <div style={{ fontSize:13, fontWeight:700, color: ratingStyle ? ratingStyle.text : 'var(--text-muted)', paddingLeft:4 }}>
                              {actual != null ? `${actual.toFixed(1)}${unit}` : '--'}
                              <div style={{ fontSize:9, color:'var(--text-muted)', fontWeight:400 }}>auto</div>
                            </div>
                          )}
                        </div>
                        {/* Threshold columns — editable */}
                        {[
                          { key:'exceeds', r:4, label:'Exceeds' },
                          { key:'meets', r:3, label:'Meets' },
                          { key:'improvement', r:2, label:'Needs Impr.' },
                        ].map(({ key, r, label }) => {
                          const cs = SC_RATING_COLORS[r]
                          const isMyRating = rating === r
                          const val = thr[key]
                          return (
                            <div key={key} style={{ padding:'8px', background: isMyRating ? cs.bg : cs.bg + '33', borderLeft:'1px solid var(--border)', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:4 }}>
                              <div style={{ fontSize:9, fontWeight:700, textTransform:'uppercase', letterSpacing:.4, color: cs.text, opacity:.7 }}>{label}</div>
                              <input type="number"
                                value={val}
                                onChange={e => setScThresholds(prev => ({ ...prev, [kpi.id]: { ...prev[kpi.id], [key]: parseFloat(e.target.value) || 0 } }))}
                                style={{ width:'100%', padding:'4px 6px', fontSize:13, fontWeight: isMyRating ? 700 : 500, border:'1px solid ' + cs.text + '44', borderRadius:'var(--radius)', background: isMyRating ? '#fff' : 'transparent', color: cs.text, textAlign:'center', maxWidth:80 }}
                              />
                              {unit && <span style={{ fontSize:9, color: cs.text, opacity:.6 }}>{unit}</span>}
                            </div>
                          )
                        })}
                        {/* Poor Performance — auto-derived, show as read-only */}
                        {(() => {
                          const cs = SC_RATING_COLORS[1]
                          const isMyRating = rating === 1
                          const poorVal = lowerIsBetter
                            ? `>${thr.improvement}${unit || ''}`
                            : `<${thr.improvement}${unit || ''}`
                          return (
                            <div style={{ padding:'8px', background: isMyRating ? cs.bg : cs.bg + '33', borderLeft:'1px solid var(--border)', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:4 }}>
                              <div style={{ fontSize:9, fontWeight:700, textTransform:'uppercase', letterSpacing:.4, color: cs.text, opacity:.7 }}>Poor</div>
                              <div style={{ fontSize:12, fontWeight: isMyRating ? 700 : 500, color: cs.text }}>{poorVal}</div>
                              <div style={{ fontSize:9, color: cs.text, opacity:.6 }}>auto</div>
                            </div>
                          )
                        })()}
                      </div>
                    )
                  })}
                </div>

                {/* Notes section */}
                <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:16 }}>
                  <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:8 }}>Manager Notes</div>
                  <textarea
                    value={scNotes}
                    onChange={e => setScNotes(e.target.value)}
                    placeholder="Add notes for this review period..."
                    rows={4}
                    style={{ width:'100%', padding:'10px 12px', fontSize:13, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', color:'var(--text-primary)', resize:'vertical', fontFamily:'inherit' }}
                  />
                </div>

                {/* Footer */}
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:12, fontSize:11, color:'var(--text-muted)' }}>
                  <span>Attendance auto-populated from points log. Booking %, Booked Calls, and Memberships entered manually.</span>
                  <span>Awesome Home Services - Andi</span>
                </div>
              </div>
            )
          })()}
        </div>
      )}

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
              {savingAdj ? 'Saving...' : 'Add adjustment'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
