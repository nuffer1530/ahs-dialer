import { useState, useRef, useEffect, useMemo } from 'react'
import { toast } from '../lib/dialogs'
import { useData } from '../lib/DataContext'
import { useAuth } from '../lib/AuthContext'
import { useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useIsMobile } from '../lib/useIsMobile'
import Modal from '../components/Modal'
import AICampaignModal from '../components/AICampaignModal'
import RichTextEditor, { RichText } from '../components/RichTextEditor'
import { SummaryPanel, Stat, Ring, ToneChip, EmptyState, eyebrow, num, panel } from '../components/ui'
import { isDone, normPhone, findCol, parseLine, cleanPhone } from '../lib/utils'

// Contact status → theme tone (the STATUS_COLORS families, taken from the tone
// tokens so the chips read in dark mode). Custom statuses fall back to gray.
const STATUS_TONE = {
  'Pending': 'blue', 'Rescheduled': 'blue', 'Question / Info': 'blue',
  'No Answer': 'amber', 'Canceled Appt': 'amber', 'Not Booked - Price': 'amber',
  'Voicemail': 'purple', 'Max Attempts': 'purple',
  'Booked': 'green',
  'Not Interested': 'red', 'DNC': 'red',
  'Bad Data': 'gray', 'Wrong Number': 'gray',
}
const statusTone = (s) => STATUS_TONE[s] || 'gray'
// Chip order on a card: the dialer's own status order, anything custom after.
const STATUS_ORDER = ['Pending', 'No Answer', 'Voicemail', 'Booked', 'Not Interested', 'DNC', 'Bad Data', 'Max Attempts']
const statusRank = (s) => { const i = STATUS_ORDER.indexOf(s); return i < 0 ? STATUS_ORDER.length : i }
const CAMP_TONE = { Active: 'green', Paused: 'amber', Complete: 'gray' }
// Progress reads blue while a list is being worked, green once it's finished,
// gray while there's nothing in it yet.
const ringTone = (total, pct) => (!total ? 'gray' : pct >= 100 ? 'green' : 'blue')
const fmt = (n) => (Number(n) || 0).toLocaleString('en-US')
const NO_STATS = { cc: [], total: 0, done: 0, booked: 0, pct: 0, statuses: [] }
// The contacts list inside a card stays compact; its header sticks while it scrolls.
const cellTh = { position: 'sticky', top: 0, zIndex: 1, padding: '8px 12px' }
const cellTd = { padding: '7px 12px' }
const richBox = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', fontSize: 13, lineHeight: 1.7, color: 'var(--text-primary)' }
const dangerBox = { background: 'var(--tone-red-bg)', border: '1px solid var(--tone-red-bd)', borderRadius: 12, padding: '12px 14px', fontSize: 13, lineHeight: 1.55, color: 'var(--tone-red-tx)', marginBottom: 16 }

const XIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
)
const Chevron = ({ open }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    style={{ flexShrink: 0, color: 'var(--text-muted)', transition: 'transform .15s', transform: open ? 'rotate(90deg)' : 'none' }}><path d="M9 5l7 7-7 7" /></svg>
)

export default function CampaignsPage() {
  const { contacts, setContacts, campaigns, setCampaigns, dncSet } = useData()
  // Call-center admin tools: admins and call center managers.
  const { canManageCallCenter: isAdmin } = useAuth()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [showModal, setShowModal] = useState(false)
  const [showAI, setShowAI] = useState(false)
  const [editCamp, setEditCamp] = useState(null)
  const [campForm, setCampForm] = useState({ name:'', description:'', status:'Active', script:'', tips:'' })
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(null)
  const [importProgress, setImportProgress] = useState('')
  const [showContacts, setShowContacts] = useState(null)
  const [editContact, setEditContact] = useState(null)
  const [showClearConfirm, setShowClearConfirm] = useState(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(null)
  const [showScriptModal, setShowScriptModal] = useState(null)
  const [clearConfirmText, setClearConfirmText] = useState('')
  // Inbound script/tips — the fallback the dialer shows on any call with no
  // campaign (inbound, ST search, leads without their own script).
  const [inbForm, setInbForm] = useState(null)
  const [inbMsg, setInbMsg] = useState('')
  const [inbOpen, setInbOpen] = useState(false)   // collapsed by default — it's set-and-forget config
  const [inbDirty, setInbDirty] = useState(false)
  useEffect(() => {
    if (!isAdmin) return
    sb.from('app_settings').select('value').eq('key', 'inbound_script').maybeSingle()
      .then(({ data }) => { let v = null; try { v = JSON.parse(data?.value || 'null') } catch {}; setInbForm({ script: v?.script || '', tips: v?.tips || '' }) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])
  useEffect(() => {
    if (!inbDirty || !inbForm) return
    const t = setTimeout(async () => {
      setInbDirty(false)
      try {
        await sb.from('app_settings').upsert({ key: 'inbound_script', value: JSON.stringify(inbForm) }, { onConflict: 'key' })
        setInbMsg('Saved'); setTimeout(() => setInbMsg(''), 2500)
      } catch (e) { setInbMsg('Error: ' + e.message) }
    }, 900)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inbDirty, inbForm])

  const fileRef = useRef()
  const pendingCampRef = useRef(null)

  const openNew = () => {
    setEditCamp(null)
    setCampForm({ name:'', description:'', status:'Active', script:'', tips:'' })
    setShowModal(true)
  }
  const openEdit = (c) => {
    setEditCamp(c)
    setCampForm({ name:c.name||'', description:c.description||'', status:c.status||'Active', script:c.script||'', tips:c.tips||'' })
    setShowModal(true)
  }

  const save = async () => {
    if (!campForm.name.trim()) return
    setSaving(true)
    try {
      if (editCamp) {
        const { data } = await sb.from('campaigns').update(campForm).eq('id', editCamp.id).select().single()
        if (data) setCampaigns(prev => prev.map(c => c.id === data.id ? data : c))
      } else {
        const { data } = await sb.from('campaigns').insert(campForm).select().single()
        if (data) setCampaigns(prev => [...prev, data])
      }
      setShowModal(false)
    } finally { setSaving(false) }
  }

  const deleteCampaign = async (id) => {
    setSaving(true)
    try {
      const campContacts = contacts.filter(c => c.campaign_id === id).map(c => c.id)
      if (campContacts.length) {
        await sb.from('contacts').delete().eq('campaign_id', id)
      }
      await sb.from('campaigns').delete().eq('id', id)
      setCampaigns(prev => prev.filter(c => c.id !== id))
      setContacts(prev => prev.filter(c => c.campaign_id !== id))
      setShowDeleteConfirm(null)
    } finally { setSaving(false) }
  }

  const clearCampaignContacts = async (campId) => {
    const campName = campaigns.find(c => c.id === campId)?.name || ''
    if (clearConfirmText !== campName) return
    setSaving(true)
    try {
      const ids = contacts.filter(c => c.campaign_id === campId).map(c => c.id)
      if (ids.length) {
        await sb.from('call_logs').delete().in('contact_id', ids)
        await sb.from('contacts').delete().eq('campaign_id', campId)
        setContacts(prev => prev.filter(c => c.campaign_id !== campId))
      }
      setShowClearConfirm(null)
      setClearConfirmText('')
    } finally { setSaving(false) }
  }

  const startUpload = (campId) => { pendingCampRef.current = campId; fileRef.current.click() }

  const handleFile = (e) => {
    const file = e.target.files[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => parseAndImport(ev.target.result, pendingCampRef.current)
    reader.readAsText(file); e.target.value = ''
  }

  const parseAndImport = async (text, campId) => {
    const lines = text.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { toast('CSV empty.'); return }
    const headers = parseLine(lines[0])
    const cols = {}
    ;['name','phone','email','address','city','state','zip','source','notes','extid'].forEach(k => { cols[k] = findCol(headers, k) })
    const get = (row, key) => cols[key] >= 0 ? (row[cols[key]] || '').replace(/^"|"$/g, '').trim() : ''
    const rows = []; let dncSkipped = 0
    for (let i = 1; i < lines.length; i++) {
      const row = parseLine(lines[i])
      const nm = get(row, 'name'); if (!nm) continue
      const phone = cleanPhone(get(row, 'phone'))
      if (phone && dncSet.has(normPhone(phone))) { dncSkipped++; continue }
      const rec = { name: nm, status: 'Pending', attempts: 0 }
      if (phone) rec.phone = phone
      if (get(row,'email')) rec.email = get(row,'email')
      if (get(row,'address')) rec.address = get(row,'address')
      if (get(row,'city')) rec.city = get(row,'city')
      if (get(row,'state')) rec.state = get(row,'state')
      if (get(row,'zip')) rec.zip = get(row,'zip')
      if (get(row,'source')) rec.source = get(row,'source')
      if (get(row,'notes')) rec.import_notes = get(row,'notes')
      if (get(row,'extid')) rec.external_id = get(row,'extid')
      if (campId) rec.campaign_id = campId
      rows.push(rec)
    }
    if (!rows.length) { toast('No valid rows.'); return }
    const campName = campaigns.find(c => c.id === campId)?.name || campId
    if (!confirm(`Import ${rows.length} contacts to "${campName}"?${dncSkipped ? `\n\n ${dncSkipped} DNC matches skipped.` : ''}`)) return
    setImporting(campId); setImportProgress(`Importing 0/${rows.length}...`)
    try {
      let created = 0
      for (let i = 0; i < rows.length; i += 1000) {
        const { data, error } = await sb.from('contacts').insert(rows.slice(i, i + 1000)).select()
        if (error) throw error
        created += data?.length || 0
        setImportProgress(`Importing ${created}/${rows.length}...`)
        if (data) setContacts(prev => [...prev, ...data])
      }
      setImportProgress(`done ${created} imported!`)
      setTimeout(() => setImportProgress(''), 3000)
    } catch (e) {
      toast('Import error: ' + e.message)
    } finally { setImporting(null) }
  }

  const exportCampaign = (campId) => {
    const cc = contacts.filter(c => c.campaign_id === campId)
    const campName = campaigns.find(c => c.id === campId)?.name || 'Campaign'
    const esc = v => { if(v==null)return''; const s=String(v); return s.includes(',')||s.includes('"')||s.includes('\n')?`"${s.replace(/"/g,'""')}"`:`${s}` }
    const h = ['Name','Phone','Email','Address','City','State','Zip','Status','Attempts','Source']
    const csv = [h.join(','), ...cc.map(c => [c.name,c.phone,c.email,c.address,c.city,c.state,c.zip,c.status,c.attempts,c.source].map(esc).join(','))].join('\n')
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download = `${campName.replace(/[^a-z0-9]/gi,'_')}.csv`; a.click()
  }

  const dialCampaign = (campId) => {
    sessionStorage.setItem('powerDialCampaign', campId)
    navigate('/')
  }

  const saveContactEdit = async () => {
    if (!editContact) return
    const { data } = await sb.from('contacts').update({ name:editContact.name, phone:editContact.phone, email:editContact.email, address:editContact.address, city:editContact.city, state:editContact.state, zip:editContact.zip, source:editContact.source, status:editContact.status }).eq('id', editContact.id).select().single()
    if (data) setContacts(prev => prev.map(c => c.id === data.id ? data : c))
    setEditContact(null)
  }

  const deleteContact = async (id) => {
    if (!confirm('Delete this contact?')) return
    await sb.from('call_logs').delete().eq('contact_id', id)
    await sb.from('contacts').delete().eq('id', id)
    setContacts(prev => prev.filter(c => c.id !== id))
  }

  // Per-campaign counts for the cards and the summary, worked out once per data
  // change rather than on every keystroke in the editors and modals. `cc` keeps
  // the contacts in their loaded order (the contacts list shows the first 100).
  const campStats = useMemo(() => {
    const lists = new Map()
    for (const c of contacts) {
      const l = lists.get(c.campaign_id)
      if (l) l.push(c)
      else lists.set(c.campaign_id, [c])
    }
    const out = new Map()
    for (const camp of campaigns) {
      const cc = lists.get(camp.id) || []
      const total = cc.length, done = cc.filter(isDone).length, booked = cc.filter(c => c.status === 'Booked').length
      const counts = new Map()
      for (const c of cc) { const s = c.status || 'Pending'; counts.set(s, (counts.get(s) || 0) + 1) }
      const statuses = [...counts].sort((a, b) => statusRank(a[0]) - statusRank(b[0]) || b[1] - a[1])
      out.set(camp.id, { cc, total, done, booked, pct: total ? Math.round((done/total)*100) : 0, statuses })
    }
    return out
  }, [contacts, campaigns])
  const totals = useMemo(() => {
    let total = 0, done = 0, booked = 0
    for (const s of campStats.values()) { total += s.total; done += s.done; booked += s.booked }
    return { total, done, booked, remaining: total - done, pct: total ? Math.round((done/total)*100) : 0 }
  }, [campStats])
  const activeCount = campaigns.filter(c => c.status === 'Active').length
  const act = { borderRadius:99, ...(isMobile ? { minHeight:34, padding:'6px 13px', fontSize:12 } : {}) }
  const sumTone = ringTone(totals.total, totals.pct)

  return (
    <div style={{ flex:1, overflowY:'auto', background:'var(--bg)' }}>
      <div style={{ padding: isMobile ? 12 : 24, display:'flex', flexDirection:'column', gap:16 }}>

        {/* Title + page actions */}
        <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <div style={{ flex:'1 1 260px', minWidth:0 }}>
            <div style={{ fontSize:15, fontWeight:700, color:'var(--text-primary)' }}>Campaigns</div>
            <div style={{ fontSize:12.5, color:'var(--text-muted)', marginTop:2 }}>Manage contact lists and dialing campaigns</div>
          </div>
          {isAdmin && (
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              <button className="btn" onClick={() => setShowAI(true)} style={{ borderRadius:99, minHeight: isMobile ? 40 : undefined }}>AI campaign</button>
              <button className="btn primary" onClick={openNew} style={{ borderRadius:99, minHeight: isMobile ? 40 : undefined }}>+ New campaign</button>
            </div>
          )}
        </div>

        {importProgress && (
          <div role="status" style={{ background:'var(--tone-blue-bg)', border:'1px solid var(--tone-blue-bd)', borderRadius:12, padding:'10px 16px', fontSize:13, fontWeight:600, color:'var(--tone-blue-tx)' }}>
            {importProgress}
          </div>
        )}

        {/* Headline numbers — the same counts the cards show, summed */}
        {campaigns.length > 0 && (
          <SummaryPanel isMobile={isMobile} style={{ marginBottom:0 }} columns="minmax(270px, 310px) repeat(3, minmax(0, 1fr))">
            <div style={{ display:'flex', alignItems:'center', gap:16 }}>
              <Ring pct={totals.pct} size={76} stroke={7} tone={sumTone}>
                <div style={{ ...num, fontSize:19, fontWeight:800, letterSpacing:'-.02em', color:`var(--tone-${sumTone}-tx)` }}>{totals.pct}<span style={{ fontSize:11 }}>%</span></div>
              </Ring>
              <div style={{ minWidth:0 }}>
                <div style={eyebrow}>Worked through</div>
                <div style={{ ...num, fontSize:12.5, color:'var(--text-secondary)', marginTop:4 }}>{fmt(totals.done)} of {fmt(totals.total)} contacts</div>
                <div style={{ fontSize:11.5, color:'var(--text-muted)', marginTop:2 }}>Final outcome or max attempts</div>
              </div>
            </div>
            <Stat label="Contacts" value={fmt(totals.total)} sub={`${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'} · ${activeCount} active`} />
            <Stat label="Remaining" value={fmt(totals.remaining)} tone={totals.remaining > 0 ? 'amber' : undefined} sub="Still open to dial" />
            <Stat label="Booked" value={fmt(totals.booked)} tone={totals.booked > 0 ? 'green' : undefined} sub="Contacts marked Booked" />
          </SummaryPanel>
        )}

        {isAdmin && inbForm && (
          <div style={{ ...panel, overflow:'hidden' }}>
            <button type="button" className="eval-row" onClick={() => setInbOpen(v => !v)} aria-expanded={inbOpen}
              style={{ width:'100%', display:'flex', alignItems:'center', gap:12, padding: isMobile ? '12px 14px' : '14px 20px', border:'none', background:'transparent', color:'inherit', font:'inherit', textAlign:'left', cursor:'pointer', userSelect:'none' }}>
              <Chevron open={inbOpen} />
              <span style={{ flex:1, minWidth:0 }}>
                <span style={{ display:'block', fontSize:14, fontWeight:700 }}>Inbound call script & tips</span>
                <span style={{ display:'block', fontSize:12, color:'var(--text-muted)', marginTop:2 }}>Shown on any call without a campaign — inbound calls, ST searches, leads.</span>
              </span>
              <span style={{ maxWidth:'45%', textAlign:'right', fontSize:12, fontWeight: inbMsg ? 600 : 500,
                color: inbMsg ? (inbMsg.startsWith('Error') ? 'var(--tone-red-tx)' : 'var(--tone-green-tx)') : 'var(--text-muted)' }}>
                {inbMsg || (inbOpen ? 'Saves automatically' : 'Click to edit')}
              </span>
            </button>
            {inbOpen && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, padding: isMobile ? 14 : '16px 20px', borderTop:'1px solid var(--border)' }}>
              <div className="form-field" style={{ marginBottom:0 }}>
                <label className="form-label">Inbound script</label>
                <RichTextEditor value={inbForm.script} minHeight={150} placeholder="Thank you for calling Awesome Home Services, this is ..."
                  onChange={v => { setInbForm(f => ({ ...f, script: v })); setInbDirty(true) }} />
              </div>
              <div className="form-field" style={{ marginBottom:0 }}>
                <label className="form-label">Inbound tips</label>
                <RichTextEditor value={inbForm.tips} minHeight={150} placeholder="Always confirm callback number and address early..."
                  onChange={v => { setInbForm(f => ({ ...f, tips: v })); setInbDirty(true) }} />
              </div>
            </div>
            )}
          </div>
        )}

        {campaigns.length === 0 ? (
          <EmptyState>{isAdmin ? 'No campaigns yet. Create your first one.' : 'No campaigns yet.'}</EmptyState>
        ) : (
          // Cards share a row height so their actions line up; while a contacts
          // list is open the cards size to their own content instead, so its
          // neighbours don't stretch around it.
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(min(340px, 100%), 1fr))', gap:16, alignItems: showContacts ? 'start' : undefined }}>
            {campaigns.map(camp => {
              const { cc, total, done, booked, pct, statuses } = campStats.get(camp.id) || NO_STATS
              const hasScript = !!(camp.script || camp.tips)
              const tone = ringTone(total, pct)
              return (
                <div key={camp.id} className="lift-hover" style={{ ...panel, padding: isMobile ? '14px 14px 12px' : '16px 18px 14px', display:'flex', flexDirection:'column', gap:14, minWidth:0 }}>
                  {/* Header — progress ring, name, status */}
                  <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                    <div title={`${pct}% done — ${fmt(done)} of ${fmt(total)} contacts at a final outcome or max attempts`} style={{ flexShrink:0 }}>
                      <Ring pct={pct} size={54} stroke={5} tone={tone}>
                        <div style={{ textAlign:'center', lineHeight:1 }}>
                          <div style={{ ...num, fontSize:13, fontWeight:800, letterSpacing:'-.02em', color:`var(--tone-${tone}-tx)` }}>{pct}<span style={{ fontSize:9 }}>%</span></div>
                          <div style={{ fontSize:8.5, fontWeight:700, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text-muted)', marginTop:2 }}>done</div>
                        </div>
                      </Ring>
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div title={camp.name} style={{ fontSize:15.5, fontWeight:700, lineHeight:1.25, color:'var(--text-primary)', overflow:'hidden', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', wordBreak:'break-word' }}>
                        {camp.name}
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:5, flexWrap:'wrap' }}>
                        <ToneChip tone={CAMP_TONE[camp.status] || 'blue'} small>{camp.status || 'Pending'}</ToneChip>
                        {hasScript && <ToneChip tone="blue" small title="This campaign has a call script or tips">Script</ToneChip>}
                      </div>
                    </div>
                    {isAdmin && (
                      <button onClick={() => setShowDeleteConfirm(camp.id)} title="Delete campaign" aria-label="Delete campaign"
                        style={{ width:28, height:28, padding:0, borderRadius:99, border:'1px solid var(--border)', background:'transparent', color:'var(--text-muted)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, alignSelf:'flex-start', transition:'background .12s, color .12s, border-color .12s' }}
                        onMouseEnter={e => { e.currentTarget.style.background='var(--tone-red-bg)'; e.currentTarget.style.color='var(--tone-red-tx)'; e.currentTarget.style.borderColor='var(--tone-red-bd)' }}
                        onMouseLeave={e => { e.currentTarget.style.background='transparent'; e.currentTarget.style.color='var(--text-muted)'; e.currentTarget.style.borderColor='var(--border)' }}>
                        <XIcon />
                      </button>
                    )}
                  </div>

                  {camp.description && (
                    <div title={camp.description} style={{ marginTop:-4, fontSize:12.5, lineHeight:1.5, color:'var(--text-secondary)', overflow:'hidden', display:'-webkit-box', WebkitLineClamp:3, WebkitBoxOrient:'vertical' }}>
                      {camp.description}
                    </div>
                  )}

                  {/* Counts — a real row, so it stays three across on a phone */}
                  <div className="mgrid" style={{ display:'grid', gridTemplateColumns:'repeat(3, minmax(0, 1fr))', margin: isMobile ? '0 -14px' : '0 -18px', borderTop:'1px solid var(--border)', borderBottom:'1px solid var(--border)' }}>
                    {[['Total', total, null], ['Remaining', total - done, 'amber'], ['Booked', booked, 'green']].map(([l, v, t], i) => (
                      <div key={l} style={{ padding: isMobile ? '10px 14px' : '11px 18px', minWidth:0, borderLeft: i ? '1px solid var(--border)' : 'none' }}>
                        <div style={eyebrow}>{l}</div>
                        <div style={{ ...num, fontSize:20, fontWeight:800, letterSpacing:'-.02em', lineHeight:1.15, marginTop:4, color: t && v > 0 ? `var(--tone-${t}-tx)` : 'var(--text-primary)' }}>{fmt(v)}</div>
                      </div>
                    ))}
                  </div>

                  {/* Where the list stands, status by status */}
                  {total > 0 ? (
                    <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                      {statuses.map(([st, n]) => <ToneChip key={st} tone={statusTone(st)} small>{st} {fmt(n)}</ToneChip>)}
                    </div>
                  ) : (
                    <div style={{ fontSize:12.5, color:'var(--text-muted)' }}>No contacts yet{isAdmin ? ' — upload a CSV to start dialing.' : '.'}</div>
                  )}

                  {/* Actions */}
                  <div style={{ marginTop:'auto', display:'flex', gap:6, flexWrap:'wrap' }}>
                    <button className="btn sm primary" onClick={() => dialCampaign(camp.id)} style={act}>Power Dial</button>
                    <button className="btn sm" onClick={() => setShowScriptModal(camp)} style={act}>{hasScript ? 'View Script' : 'Add Script'}</button>
                    {isAdmin && (
                      <>
                        <button className="btn sm" onClick={() => startUpload(camp.id)} disabled={importing === camp.id} style={act}>
                          {importing === camp.id ? 'Uploading...' : '+ Upload'}
                        </button>
                        <button className="btn sm" onClick={() => openEdit(camp)} style={act}>Edit</button>
                      </>
                    )}
                    <button className="btn sm" onClick={() => exportCampaign(camp.id)} style={act}>Export</button>
                    <button className="btn sm" onClick={() => setShowContacts(showContacts === camp.id ? null : camp.id)} aria-expanded={showContacts === camp.id}
                      style={{ ...act, ...(showContacts === camp.id ? { background:'var(--accent-bg)', color:'var(--accent-text)', borderColor:'var(--accent)' } : {}) }}>
                      {showContacts === camp.id ? 'Hide contacts' : 'Contacts'}
                    </button>
                    {isAdmin && (
                      <button className="btn sm danger" onClick={() => { setShowClearConfirm(camp.id); setClearConfirmText('') }} style={act}>Clear</button>
                    )}
                  </div>

                  {/* Contact list */}
                  {showContacts === camp.id && (
                    <div style={{ maxHeight:260, overflow:'auto', border:'1px solid var(--border)', borderRadius:12 }}>
                      <table className="data-table" style={{ fontSize:11.5 }}>
                        <thead><tr><th style={cellTh}>Name</th><th style={cellTh}>Phone</th><th style={cellTh}>Status</th>{isAdmin&&<th style={cellTh}>Actions</th>}</tr></thead>
                        <tbody>
                          {cc.slice(0,100).map(contact => (
                            <tr key={contact.id}>
                              <td style={{ ...cellTd, fontWeight:600 }}>{contact.name}</td>
                              <td style={{ ...cellTd, whiteSpace:'nowrap' }}>{contact.phone || <span style={{ color:'var(--text-muted)' }}>—</span>}</td>
                              <td style={cellTd}><ToneChip tone={statusTone(contact.status||'Pending')} small>{contact.status||'Pending'}</ToneChip></td>
                              {isAdmin && <td style={cellTd}>
                                <div style={{display:'flex',gap:4}}>
                                  <button className="btn sm" onClick={() => setEditContact({...contact})}>Edit</button>
                                  <button className="btn sm danger" onClick={() => deleteContact(contact.id)}>Remove</button>
                                </div>
                              </td>}
                            </tr>
                          ))}
                          {cc.length > 100 && <tr><td colSpan={4} style={{ ...cellTd, padding:'8px 12px', color:'var(--text-muted)', textAlign:'center' }}>+{fmt(cc.length-100)} more contacts</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <input type="file" accept=".csv" ref={fileRef} style={{display:'none'}} onChange={handleFile} />

      {showAI && (
        <AICampaignModal
          onClose={() => setShowAI(false)}
          onCreated={async (data) => {
            setShowAI(false)
            setImportProgress(data.addedToExisting
              ? `✓ Added ${data.created} contacts to "${data.campaignName}".`
              : `✓ Created "${data.campaignName}" with ${data.created} contacts.`)
            setTimeout(() => setImportProgress(''), 5000)
            // Show it now rather than waiting on realtime (the campaign used to
            // appear only after a reload — "it won't save", Deanna, Sep 24).
            const camp = data.campaign
            if (camp) setCampaigns(prev => prev.some(c => c.id === camp.id) ? prev.map(c => c.id === camp.id ? camp : c) : [...prev, camp])
            const rows = []
            for (let from = 0; ; from += 1000) {
              const { data: page, error } = await sb.from('contacts').select('*').eq('campaign_id', data.campaignId).order('created_at').range(from, from + 999)
              if (error) break
              rows.push(...(page || []))
              if (!page || page.length < 1000) break
            }
            if (rows.length) setContacts(prev => {
              const have = new Set(prev.map(c => c.id))
              return [...prev, ...rows.filter(r => !have.has(r.id))]
            })
          }}
        />
      )}

      {/* Campaign modal */}
      {showModal && (
        <Modal title={editCamp ? 'Edit campaign' : 'New campaign'} onClose={() => setShowModal(false)} width={560}>
          <div style={{ display:'grid', gridTemplateColumns:'minmax(0, 1fr) 150px', gap:12 }}>
            <div className="form-field"><label className="form-label">Name</label><input className="form-input" value={campForm.name} onChange={e=>setCampForm(p=>({...p,name:e.target.value}))} placeholder="e.g. Rocky MTN Acquisition" autoFocus /></div>
            <div className="form-field"><label className="form-label">Status</label>
              <select className="form-input" value={campForm.status} onChange={e=>setCampForm(p=>({...p,status:e.target.value}))}>
                {['Active','Paused','Complete'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="form-field"><label className="form-label">Description</label><textarea className="form-input" value={campForm.description} onChange={e=>setCampForm(p=>({...p,description:e.target.value}))} placeholder="Brief description of this campaign" /></div>
          <div className="form-field">
            <label className="form-label">Call script</label>
            <RichTextEditor value={campForm.script} onChange={v=>setCampForm(p=>({...p,script:v}))}
              placeholder={'Hi, this is [Name] with Awesome Home Services...'} minHeight={120} />
          </div>
          <div className="form-field">
            <label className="form-label">Tips & talking points</label>
            <RichTextEditor value={campForm.tips} onChange={v=>setCampForm(p=>({...p,tips:v}))}
              placeholder={'Emphasize continuity of service...'} minHeight={100} />
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setShowModal(false)}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : editCamp ? 'Save' : 'Create'}</button>
          </div>
        </Modal>
      )}

      {/* Script/Tips viewer */}
      {showScriptModal && (
        <Modal title={`${showScriptModal.name} — Script & tips`} onClose={() => setShowScriptModal(null)} width={640}>
          {showScriptModal.script ? (
            <div style={{ marginBottom:20 }}>
              <div style={{ ...eyebrow, marginBottom:8 }}>Call script</div>
              <RichText html={showScriptModal.script} style={richBox} />
            </div>
          ) : <div style={{ color:'var(--text-muted)', fontSize:13, marginBottom:16 }}>No script added yet.</div>}
          {showScriptModal.tips ? (
            <div>
              <div style={{ ...eyebrow, marginBottom:8 }}>Tips & talking points</div>
              <RichText html={showScriptModal.tips} style={richBox} />
            </div>
          ) : <div style={{ color:'var(--text-muted)', fontSize:13 }}>No tips added yet.</div>}
          <div className="modal-actions">
            {isAdmin && <button className="btn" onClick={() => { openEdit(showScriptModal); setShowScriptModal(null) }}>Edit script</button>}
            <button className="btn primary" onClick={() => setShowScriptModal(null)}>Close</button>
          </div>
        </Modal>
      )}

      {/* Clear contacts confirmation */}
      {showClearConfirm && (
        <Modal title="Clear all contacts?" onClose={() => setShowClearConfirm(null)}>
          <div style={dangerBox}>
            This will permanently delete all contacts and call logs for this campaign. This cannot be undone.
          </div>
          <div className="form-field">
            <label className="form-label">Type the campaign name to confirm</label>
            <input className="form-input" value={clearConfirmText} onChange={e=>setClearConfirmText(e.target.value)}
              placeholder={campaigns.find(c=>c.id===showClearConfirm)?.name || ''} />
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setShowClearConfirm(null)}>Cancel</button>
            <button className="btn danger" disabled={clearConfirmText !== campaigns.find(c=>c.id===showClearConfirm)?.name || saving}
              onClick={() => clearCampaignContacts(showClearConfirm)}>
              {saving ? 'Clearing...' : 'Yes, delete all contacts'}
            </button>
          </div>
        </Modal>
      )}

      {/* Delete campaign confirmation */}
      {showDeleteConfirm && (
        <Modal title="Delete Campaign?" onClose={() => setShowDeleteConfirm(null)}>
          <div style={dangerBox}>
            <strong>You are about to permanently delete "{campaigns.find(c => c.id === showDeleteConfirm)?.name}".</strong>
            <br /><br />
            This will delete the campaign and all contacts attached to it. Call logs and rep stats will be preserved for Analytics. This cannot be undone.
            <br /><br />
            To clear the contact list and re-upload, use the Clear button instead.
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setShowDeleteConfirm(null)}>Cancel</button>
            <button className="btn danger" onClick={() => deleteCampaign(showDeleteConfirm)} disabled={saving}>
              {saving ? 'Deleting...' : 'Yes, delete campaign'}
            </button>
          </div>
        </Modal>
      )}

      {/* Contact edit modal */}
      {editContact && (
        <Modal title="Edit contact" onClose={() => setEditContact(null)} width={560}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', columnGap:12 }}>
            {[['Name','name'],['Phone','phone'],['Email','email'],['Address','address'],['City','city'],['State','state'],['Zip','zip'],['Source','source']].map(([label, field]) => (
              <div key={field} className="form-field">
                <label className="form-label">{label}</label>
                <input className="form-input" value={editContact[field]||''} onChange={e=>setEditContact(prev=>({...prev,[field]:e.target.value}))} />
              </div>
            ))}
          </div>
          <div className="form-field"><label className="form-label">Status</label>
            <select className="form-input" value={editContact.status||'Pending'} onChange={e=>setEditContact(prev=>({...prev,status:e.target.value}))}>
              {['Pending','No Answer','Voicemail','Booked','Not Interested','DNC','Bad Data','Max Attempts'].map(s=><option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setEditContact(null)}>Cancel</button>
            <button className="btn primary" onClick={saveContactEdit}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
