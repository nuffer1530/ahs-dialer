import { useState, useRef } from 'react'
import { useData } from '../lib/DataContext'
import { useAuth } from '../lib/AuthContext'
import { sb } from '../lib/supabase'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import { isDone, normPhone, findCol, parseLine, cleanPhone } from '../lib/utils'

export default function CampaignsPage() {
  const { contacts, setContacts, campaigns, setCampaigns, dncSet } = useData()
  const { isAdmin } = useAuth()
  const [showModal, setShowModal] = useState(false)
  const [editCamp, setEditCamp] = useState(null)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [status, setStatus] = useState('Active')
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(null) // campId being imported
  const [importProgress, setImportProgress] = useState('')
  const [showContacts, setShowContacts] = useState(null) // campId to show contacts
  const [editContact, setEditContact] = useState(null)
  const fileRef = useRef()
  const pendingCampRef = useRef(null)

  const openNew = () => { setEditCamp(null); setName(''); setDesc(''); setStatus('Active'); setShowModal(true) }
  const openEdit = (c) => { setEditCamp(c); setName(c.name||''); setDesc(c.description||''); setStatus(c.status||'Active'); setShowModal(true) }

  const save = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      if (editCamp) {
        const { data } = await sb.from('campaigns').update({ name, description: desc, status }).eq('id', editCamp.id).select().single()
        if (data) setCampaigns(prev => prev.map(c => c.id === data.id ? data : c))
      } else {
        const { data } = await sb.from('campaigns').insert({ name, description: desc, status }).select().single()
        if (data) setCampaigns(prev => [...prev, data])
      }
      setShowModal(false)
    } finally { setSaving(false) }
  }

  const deleteCampaign = async (id) => {
    if (!confirm('Delete this campaign? Contacts will remain but will be unassigned.')) return
    await sb.from('contacts').update({ campaign_id: null }).eq('campaign_id', id)
    await sb.from('campaigns').delete().eq('id', id)
    setCampaigns(prev => prev.filter(c => c.id !== id))
    setContacts(prev => prev.map(c => c.campaign_id === id ? { ...c, campaign_id: null } : c))
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
      const rawPhone = get(row, 'phone')
      const phone = cleanPhone(rawPhone)
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
    const campContacts = contacts.filter(c => c.campaign_id === campId)
    const campName = campaigns.find(c => c.id === campId)?.name || 'Campaign'
    const headers = ['Name','Phone','Email','Address','City','State','Zip','Status','Attempts','Source','ExternalID']
    const esc = v => { if (v==null) return ''; const s=String(v); return s.includes(',')||s.includes('"')||s.includes('\n')?`"${s.replace(/"/g,'""')}"`:`${s}` }
    const rows = campContacts.map(c => [c.name,c.phone,c.email,c.address,c.city,c.state,c.zip,c.status,c.attempts,c.source,c.external_id].map(esc).join(','))
    const csv = [headers.join(','), ...rows].join('\n')
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download = `${campName.replace(/[^a-z0-9]/gi,'_')}.csv`; a.click()
  }

  // Contact edit
  const saveContactEdit = async () => {
    if (!editContact) return
    const { data } = await sb.from('contacts').update({
      name: editContact.name, phone: editContact.phone, email: editContact.email,
      address: editContact.address, city: editContact.city, state: editContact.state, zip: editContact.zip,
      source: editContact.source, status: editContact.status,
    }).eq('id', editContact.id).select().single()
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

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))', gap:14 }}>
        {campaigns.map(camp => {
          const cc = contacts.filter(c => c.campaign_id === camp.id)
          const total = cc.length, done = cc.filter(isDone).length, booked = cc.filter(c => c.status === 'Booked').length
          const pct = total ? Math.round((done/total)*100) : 0
          return (
            <div key={camp.id} className="card" style={{ display:'flex', flexDirection:'column', gap:10, padding:'16px 18px' }}>
              <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8 }}>
                <div>
                  <div style={{ fontSize:15, fontWeight:600 }}>{camp.name}</div>
                  {camp.description && <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:2 }}>{camp.description}</div>}
                </div>
                <Badge status={camp.status} style={{ flexShrink:0 }} />
              </div>
              <div style={{ height:6, background:'var(--surface-2)', borderRadius:99, overflow:'hidden' }}>
                <div style={{ height:'100%', width:`${pct}%`, background:'var(--success)', borderRadius:99 }}></div>
              </div>
              <div style={{ display:'flex', gap:14 }}>
                {[['Total',total],['Remaining',total-done,'warning'],['Booked',booked,'success'],['Done',pct+'%']].map(([l,v,c])=>(
                  <div key={l} style={{ textAlign:'center' }}>
                    <div style={{ fontSize:18, fontWeight:600, color: c ? `var(--${c})` : 'var(--text-primary)' }}>{v}</div>
                    <div style={{ fontSize:10, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:.4 }}>{l}</div>
                  </div>
                ))}
              </div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {isAdmin && (
                  <>
                    <button className="btn sm" onClick={() => startUpload(camp.id)} disabled={importing === camp.id}>
                      {importing === camp.id ? '⏳ Importing…' : '+ Upload'}
                    </button>
                    <button className="btn sm" onClick={() => openEdit(camp)}>Edit</button>
                    <button className="btn sm danger" onClick={() => deleteCampaign(camp.id)}>Delete</button>
                  </>
                )}
                <button className="btn sm" onClick={() => exportCampaign(camp.id)}>⬇ Export</button>
                <button className="btn sm" onClick={() => setShowContacts(showContacts === camp.id ? null : camp.id)}>
                  {showContacts === camp.id ? 'Hide contacts' : 'View contacts'}
                </button>
              </div>

              {/* Inline contact list */}
              {showContacts === camp.id && (
                <div style={{ marginTop:8, borderTop:'1px solid var(--border)', paddingTop:10 }}>
                  <div style={{ maxHeight:300, overflowY:'auto' }}>
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
                        {cc.length > 100 && <tr><td colSpan={4} style={{padding:'8px 10px',color:'var(--text-muted)',textAlign:'center'}}>+{cc.length-100} more — export CSV to see all</td></tr>}
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
        <Modal title={editCamp ? 'Edit campaign' : 'New campaign'} onClose={() => setShowModal(false)}>
          <div className="form-field"><label className="form-label">Name</label><input className="form-input" value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Rocky MTN Acquisition" autoFocus /></div>
          <div className="form-field"><label className="form-label">Description</label><textarea className="form-input" value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Optional description" /></div>
          <div className="form-field"><label className="form-label">Status</label>
            <select className="form-input" value={status} onChange={e=>setStatus(e.target.value)}>
              {['Active','Paused','Complete'].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setShowModal(false)}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={saving}>{saving ? '…' : editCamp ? 'Save' : 'Create'}</button>
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
