import { useState, useRef } from 'react'
import { useData } from '../lib/DataContext'
import { useAuth } from '../lib/AuthContext'
import { useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import { isDone, normPhone, findCol, parseLine, cleanPhone } from '../lib/utils'

export default function CampaignsPage() {
  const { contacts, setContacts, campaigns, setCampaigns, dncSet } = useData()
  const { isAdmin } = useAuth()
  const navigate = useNavigate()
  const [showModal, setShowModal] = useState(false)
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
    if (lines.length < 2) { alert('CSV empty.'); return }
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
    if (!rows.length) { alert('No valid rows.'); return }
    const campName = campaigns.find(c => c.id === campId)?.name || campId
    if (!confirm(`Import ${rows.length} contacts to "${campName}"?${dncSkipped ? `\n\n⛔ ${dncSkipped} DNC matches skipped.` : ''}`)) return
    setImporting(campId); setImportProgress(`Importing 0/${rows.length}…`)
    try {
      let created = 0
      for (let i = 0; i < rows.length; i += 1000) {
        const { data, error } = await sb.from('contacts').insert(rows.slice(i, i + 1000)).select()
        if (error) throw error
        created += data?.length || 0
        setImportProgress(`Importing ${created}/${rows.length}…`)
        if (data) setContacts(prev => [...prev, ...data])
      }
      setImportProgress(`✓ ${created} imported!`)
      setTimeout(() => setImportProgress(''), 3000)
    } catch (e) {
      alert('Import error: ' + e.message)
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

  return (
    <div style={{ flex:1, overflowY:'auto', padding:24 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
        <h1 style={{ fontSize:20, fontWeight:600 }}>Campaigns</h1>
        {isAdmin && <button className="btn primary" onClick={openNew}>+ New campaign</button>}
      </div>

      {importProgress && (
        <div style={{ background:'var(--accent-bg)', border:'1px solid var(--accent)', borderRadius:'var(--radius)', padding:'10px 16px', marginBottom:16, fontSize:13, color:'var(--accent)' }}>
          {importProgress}
        </div>
      )}

      <input type="file" accept=".csv" ref={fileRef} style={{display:'none'}} onChange={handleFile} />

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(320px,1fr))', gap:14 }}>
        {campaigns.map(camp => {
          const cc = contacts.filter(c => c.campaign_id === camp.id)
          const total = cc.length, done = cc.filter(isDone).length, booked = cc.filter(c => c.status === 'Booked').length
          const pct = total ? Math.round((done/total)*100) : 0
          const hasScript = !!(camp.script || camp.tips)
          return (
            <div key={camp.id} className="card" style={{ display:'flex', flexDirection:'column', gap:10, padding:'16px 18px' }}>
              {isAdmin && (
                <button
                  onClick={() => setShowDeleteConfirm(camp.id)}
                  style={{ position:'absolute', top:10, right:10, width:22, height:22, borderRadius:'50%', border:'none', background:'var(--danger-bg)', color:'var(--danger)', cursor:'pointer', fontSize:16, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center', lineHeight:1, zIndex:1 }}
                  title="Delete campaign"
                >×</button>
              )}
              <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8 }}>
                <div>
                  <div style={{ fontSize:15, fontWeight:600 }}>{camp.name}</div>
                  {camp.description && <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:2 }}>{camp.description}</div>}
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
                  {hasScript && <span style={{ fontSize:10, background:'var(--accent-bg)', color:'var(--accent)', padding:'1px 6px', borderRadius:99, fontWeight:600 }}>📜 Script</span>}
                  <Badge status={camp.status} />
                  {isAdmin && (
                    <button
                      onClick={() => setShowDeleteConfirm(camp.id)}
                      style={{ width:20, height:20, borderRadius:'50%', border:'none', background:'var(--danger-bg)', color:'var(--danger)', cursor:'pointer', fontSize:14, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center', lineHeight:1, flexShrink:0 }}
                      title="Delete campaign"
                    >×</button>
                  )}
                </div>
              </div>

              <div style={{ height:6, background:'var(--surface-2)', borderRadius:99, overflow:'hidden' }}>
                <div style={{ height:'100%', width:`${pct}%`, background:'var(--success)', borderRadius:99 }}></div>
              </div>

              <div style={{ display:'flex', gap:14 }}>
                {[['Total',total],['Remaining',total-done,'warning'],['Booked',booked,'success'],['Done%',pct+'%']].map(([l,v,c])=>(
                  <div key={l} style={{ textAlign:'center' }}>
                    <div style={{ fontSize:18, fontWeight:600, color: c ? `var(--${c})` : 'var(--text-primary)' }}>{v}</div>
                    <div style={{ fontSize:10, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:.4 }}>{l}</div>
                  </div>
                ))}
              </div>

              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                <button className="btn sm primary" onClick={() => dialCampaign(camp.id)}>⚡ Power Dial</button>
                <button className="btn sm" onClick={() => setShowScriptModal(camp)}>📜 {hasScript ? 'View Script' : 'Add Script'}</button>
                {isAdmin && (
                  <>
                    <button className="btn sm" onClick={() => startUpload(camp.id)} disabled={importing === camp.id}>{importing === camp.id ? '⏳' : '+ Upload'}</button>
                    <button className="btn sm" onClick={() => openEdit(camp)}>Edit</button>
                    <button className="btn sm danger" onClick={() => { setShowClearConfirm(camp.id); setClearConfirmText('') }}>🗑 Clear</button>
                  </>
                )}
                <button className="btn sm" onClick={() => exportCampaign(camp.id)}>⬇</button>
                <button className="btn sm" onClick={() => setShowContacts(showContacts === camp.id ? null : camp.id)}>
                  {showContacts === camp.id ? 'Hide' : 'Contacts'}
                </button>
              </div>

              {showContacts === camp.id && (
                <div style={{ marginTop:4, borderTop:'1px solid var(--border)', paddingTop:10 }}>
                  <div style={{ maxHeight:260, overflowY:'auto' }}>
                    <table className="data-table" style={{ fontSize:11 }}>
                      <thead><tr><th>Name</th><th>Phone</th><th>Status</th>{isAdmin&&<th>Actions</th>}</tr></thead>
                      <tbody>
                        {cc.slice(0,100).map(contact => (
                          <tr key={contact.id}>
                            <td style={{padding:'6px 10px'}}>{contact.name}</td>
                            <td style={{padding:'6px 10px'}}>{contact.phone||'—'}</td>
                            <td style={{padding:'6px 10px'}}><Badge status={contact.status||'Pending'} /></td>
                            {isAdmin && <td style={{padding:'6px 10px'}}>
                              <div style={{display:'flex',gap:4}}>
                                <button className="btn sm" onClick={() => setEditContact({...contact})}>Edit</button>
                                <button className="btn sm danger" onClick={() => deleteContact(contact.id)}>Del</button>
                              </div>
                            </td>}
                          </tr>
                        ))}
                        {cc.length > 100 && <tr><td colSpan={4} style={{padding:'8px 10px',color:'var(--text-muted)',textAlign:'center'}}>+{cc.length-100} more</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {campaigns.length === 0 && (
          <div className="empty-state" style={{ gridColumn:'1/-1' }}>
            <div className="empty-icon">📋</div>
            <div>{isAdmin ? 'No campaigns yet. Create your first one.' : 'No campaigns yet.'}</div>
          </div>
        )}
      </div>

      {/* Campaign modal */}
      {showModal && (
        <Modal title={editCamp ? 'Edit campaign' : 'New campaign'} onClose={() => setShowModal(false)} width={560}>
          <div className="form-field"><label className="form-label">Name</label><input className="form-input" value={campForm.name} onChange={e=>setCampForm(p=>({...p,name:e.target.value}))} placeholder="e.g. Rocky MTN Acquisition" autoFocus /></div>
          <div className="form-field"><label className="form-label">Description</label><textarea className="form-input" value={campForm.description} onChange={e=>setCampForm(p=>({...p,description:e.target.value}))} placeholder="Brief description of this campaign" /></div>
          <div className="form-field"><label className="form-label">Status</label>
            <select className="form-input" value={campForm.status} onChange={e=>setCampForm(p=>({...p,status:e.target.value}))}>
              {['Active','Paused','Complete'].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label className="form-label">Call script</label>
            <textarea className="form-input" value={campForm.script} onChange={e=>setCampForm(p=>({...p,script:e.target.value}))}
              placeholder={'Hi, this is [Name] with Awesome Home Services...\n\nI\'m calling because we recently acquired Rocky Mountain Climate and wanted to reach out to their customers personally...'} style={{ minHeight:120 }} />
          </div>
          <div className="form-field">
            <label className="form-label">Tips & talking points</label>
            <textarea className="form-input" value={campForm.tips} onChange={e=>setCampForm(p=>({...p,tips:e.target.value}))}
              placeholder={'• Emphasize continuity of service\n• Mention the AHS guarantee\n• If they ask about pricing, offer a free quote\n• Best objection: "I already have someone" → "We want to earn your trust..."'} style={{ minHeight:100 }} />
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setShowModal(false)}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={saving}>{saving ? '…' : editCamp ? 'Save' : 'Create'}</button>
          </div>
        </Modal>
      )}

      {/* Script/Tips viewer */}
      {showScriptModal && (
        <Modal title={`📜 ${showScriptModal.name} — Script & Tips`} onClose={() => setShowScriptModal(null)} width={640}>
          {showScriptModal.script ? (
            <div style={{ marginBottom:20 }}>
              <div style={{ fontSize:12, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-secondary)', marginBottom:8 }}>Call Script</div>
              <div style={{ background:'var(--surface-2)', borderRadius:'var(--radius)', padding:'14px 16px', fontSize:13, lineHeight:1.7, whiteSpace:'pre-wrap', color:'var(--text-primary)' }}>
                {showScriptModal.script}
              </div>
            </div>
          ) : <div style={{ color:'var(--text-muted)', fontSize:13, marginBottom:16 }}>No script added yet.</div>}

          {showScriptModal.tips ? (
            <div>
              <div style={{ fontSize:12, fontWeight:600, textTransform:'uppercase', letterSpacing:.5, color:'var(--text-secondary)', marginBottom:8 }}>💡 Tips & Talking Points</div>
              <div style={{ background:'var(--warning-bg)', border:'1px solid #E8C84A', borderRadius:'var(--radius)', padding:'14px 16px', fontSize:13, lineHeight:1.7, whiteSpace:'pre-wrap', color:'var(--text-primary)' }}>
                {showScriptModal.tips}
              </div>
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
        <Modal title="⚠️ Clear all contacts?" onClose={() => setShowClearConfirm(null)}>
          <div style={{ background:'var(--danger-bg)', border:'1px solid #E8C0B8', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:13, color:'var(--danger)', marginBottom:16 }}>
            This will permanently delete ALL contacts and call logs for this campaign. This cannot be undone.
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
              {saving ? 'Clearing…' : 'Yes, delete all contacts'}
            </button>
          </div>
        </Modal>
      )}

      {/* Delete campaign confirmation */}
      {showDeleteConfirm && (
        <Modal title="⚠️ Delete Campaign?" onClose={() => setShowDeleteConfirm(null)}>
          <div style={{ background:'var(--danger-bg)', border:'1px solid #E8C0B8', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:13, color:'var(--danger)', marginBottom:16 }}>
            <strong>You are about to permanently delete "{campaigns.find(c => c.id === showDeleteConfirm)?.name}".</strong>
            <br /><br />
            This will delete the campaign and ALL contacts attached to it. Call logs and rep stats will be preserved for Analytics. <strong>This cannot be undone.</strong>
            <br /><br />
            If you just want to clear the contact list and re-upload, use the 🗑 Clear button instead.
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setShowDeleteConfirm(null)}>Cancel — keep campaign</button>
            <button className="btn danger" onClick={() => deleteCampaign(showDeleteConfirm)} disabled={saving}>
              {saving ? 'Deleting…' : 'Yes, delete campaign'}
            </button>
          </div>
        </Modal>
      )}

      {/* Contact edit modal */}
      {editContact && (
        <Modal title="Edit contact" onClose={() => setEditContact(null)} width={560}>
          {[['Name','name'],['Phone','phone'],['Email','email'],['Address','address'],['City','city'],['State','state'],['Zip','zip'],['Source','source']].map(([label, field]) => (
            <div key={field} className="form-field">
              <label className="form-label">{label}</label>
              <input className="form-input" value={editContact[field]||''} onChange={e=>setEditContact(prev=>({...prev,[field]:e.target.value}))} />
            </div>
          ))}
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
