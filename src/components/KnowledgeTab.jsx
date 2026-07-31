import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { confirmDlg } from '../lib/dialogs'

// Settings → Knowledge: what Ask Andi knows. Every save writes a revision
// (who/when/what changed) — the ledger of what the assistant is being fed.
// A policy change is: edit the article, save, done — the next answer uses it.

const CATEGORIES = [
  ['policy', 'Policies'],
  ['objections', 'Objection handling'],
  ['product', 'Services & pricing'],
  ['servicetitan', 'ServiceTitan how-to'],
  ['website', 'Website'],
  ['general', 'General'],
]
const CAT_LABEL = Object.fromEntries(CATEGORIES)

async function authed(path, opts = {}) {
  const { data: { session } } = await sb.auth.getSession()
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}`, ...(opts.headers || {}) },
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`)
  return d
}

export default function KnowledgeTab() {
  const [articles, setArticles] = useState(null)
  const [err, setErr] = useState('')
  const [edit, setEdit] = useState(null)   // { id?, title, body, category, active, note }
  const [saving, setSaving] = useState(false)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [revs, setRevs] = useState(null)   // revisions for the open article
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const [gaps, setGaps] = useState([])
  const [gapsOpen, setGapsOpen] = useState(false)

  const load = () => authed('/api/kb/list').then(d => setArticles(d.articles)).catch(e => setErr(e.message))
  useEffect(() => {
    load()
    authed('/api/kb/gaps').then(d => setGaps(d.gaps || [])).catch(() => {})
  }, [])

  const importWebsite = async () => {
    if (importing) return
    if (!(await confirmDlg('Pull in pages from awesomeservice.com? New pages become Website articles; changed pages get updated with a revision; unchanged pages are left alone.', { title: 'Import website', confirmLabel: 'Import' }))) return
    setImporting(true); setImportMsg('')
    try {
      const d = await authed('/api/kb/import-website', { method: 'POST', body: JSON.stringify({}) })
      setImportMsg(`✓ ${d.added} added · ${d.changed} updated · ${d.unchanged} unchanged · ${d.skipped} skipped`)
      load()
    } catch (e) { setImportMsg(`${e.message}`) }
    setImporting(false)
  }

  const openEdit = (a) => {
    setRevs(null)
    setEdit(a ? { id: a.id, title: a.title, body: a.body, category: a.category, active: a.active, note: '' }
      : { title: '', body: '', category: 'policy', active: true, note: '' })
  }
  const save = async () => {
    if (saving || !edit?.title.trim()) return
    setSaving(true); setErr('')
    try {
      await authed('/api/kb/save', { method: 'POST', body: JSON.stringify(edit) })
      setEdit(null)
      load()
    } catch (e) { setErr(e.message) }
    setSaving(false)
  }
  const remove = async (a) => {
    if (!(await confirmDlg(`Delete "${a.title}"? Its revision history goes with it.`, { title: 'Delete article', confirmLabel: 'Delete', danger: true }))) return
    try { await authed('/api/kb/delete', { method: 'POST', body: JSON.stringify({ id: a.id }) }); load() }
    catch (e) { setErr(e.message) }
  }
  const loadRevs = async () => {
    if (!edit?.id) return
    try { setRevs((await authed(`/api/kb/revisions?articleId=${edit.id}`)).revisions) }
    catch (e) { setErr(e.message) }
  }

  if (err && !articles) return <div style={{ padding: 20, color: 'var(--danger)', fontSize: 13 }}>{err}</div>
  if (!articles) return <div className="spinner lg" style={{ margin: '60px auto' }} />

  const shown = articles.filter(a =>
    (filter === 'all' || a.category === filter) &&
    (!search.trim() || (a.title + ' ' + a.body).toLowerCase().includes(search.toLowerCase())))

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1, minWidth: 260 }}>
          Everything Ask Andi is allowed to say about company facts lives here. Edits go live on the very
          next answer; every save keeps a revision with who changed what.
        </div>
        <input className="form-input" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 180 }} />
        <select className="form-input" value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 170 }}>
          <option value="all">All categories</option>
          {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button className="btn" onClick={importWebsite} disabled={importing}>
          {importing ? 'Importing…' : 'Import website'}
        </button>
        <button className="btn primary" onClick={() => openEdit(null)}>+ New article</button>
      </div>
      {importMsg && <div style={{ fontSize:12, fontWeight:600, marginBottom:10, color: importMsg.startsWith('✓') ? 'var(--success)' : 'var(--tone-red-tx)' }}>{importMsg}</div>}

      {gaps.length > 0 && (
        <div className="card" style={{ padding:'10px 14px', marginBottom:12, borderLeft:'3px solid var(--tone-amber-bd)' }}>
          <div onClick={() => setGapsOpen(o => !o)} style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
            <span style={{ fontSize:12.5, fontWeight:700 }}>
              {gaps.length} question{gaps.length === 1 ? '' : 's'} the knowledge base couldn't answer (last 30 days)
            </span>
            <span style={{ fontSize:11, color:'var(--text-muted)' }}>— your "what to write next" list</span>
            <span style={{ marginLeft:'auto', fontSize:11, color:'var(--text-muted)' }}>{gapsOpen ? '▾ hide' : '▸ show'}</span>
          </div>
          {gapsOpen && (
            <div style={{ marginTop:8, display:'flex', flexDirection:'column', gap:5, maxHeight:220, overflowY:'auto' }}>
              {gaps.map(g => (
                <div key={g.id} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12 }}>
                  <span style={{ flex:1 }}>{g.question}</span>
                  {g.helpful === false && <span title="Rep gave this answer a thumbs-down" style={{ flexShrink:0 }}>👎</span>}
                  <span style={{ fontSize:10.5, color:'var(--text-muted)', flexShrink:0 }}>
                    {g.rep_name || 'someone'} · {String(g.created_at).slice(5, 10)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {shown.length === 0 && (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          Nothing here yet — hit <b>New article</b>. Good starters: the dispatch fee policy, service areas,
          and your top three phone objections.
        </div>
      )}

      {CATEGORIES.filter(([v]) => shown.some(a => a.category === v)).map(([v, label]) => (
        <div key={v} style={{ marginBottom: 22 }}>
          <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: .6, color: 'var(--text-muted)', marginBottom: 8 }}>
            {label} <span style={{ fontWeight: 600 }}>· {shown.filter(a => a.category === v).length}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 10 }}>
            {shown.filter(a => a.category === v).map(a => (
              <div key={a.id} className="card" onClick={() => openEdit(a)}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'none' }}
                style={{ padding: '12px 14px', cursor: 'pointer', opacity: a.active ? 1 : .55, transition: 'all .1s',
                  display: 'flex', flexDirection: 'column', gap: 6, minHeight: 110 }}>
                <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.35 }}>{a.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, flex: 1,
                  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {a.body.replace(/<[^>]*>/g, ' ').slice(0, 220)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9.5, color: 'var(--text-muted)' }}>
                  <span>{String(a.updated_at).slice(0, 10)}</span>
                  {a.updated_by && <span>· {a.updated_by}</span>}
                  {!a.active && (
                    <span style={{ marginLeft: 'auto', fontWeight: 700, color: 'var(--tone-amber-tx)' }}>hidden</span>
                  )}
                  
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {edit && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onMouseDown={() => setEdit(null)}>
          <div onMouseDown={e => e.stopPropagation()}
            style={{ background: 'var(--surface)', borderRadius: 14, width: '100%', maxWidth: 640, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,.25)', padding: '20px 22px' }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>{edit.id ? 'Edit article' : 'New article'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 10 }}>
                <div className="form-field">
                  <label className="form-label">Title</label>
                  <input className="form-input" autoFocus value={edit.title} placeholder="Dispatch fee policy"
                    onChange={e => setEdit(p => ({ ...p, title: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label className="form-label">Category</label>
                  <select className="form-input" value={edit.category} onChange={e => setEdit(p => ({ ...p, category: e.target.value }))}>
                    {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-field">
                <label className="form-label">Content — write it the way you'd tell a new hire</label>
                <textarea className="form-input" rows={12} value={edit.body}
                  placeholder={'The dispatch fee is $89, waived if they move forward with the repair.\nIf the customer pushes back: ...'}
                  onChange={e => setEdit(p => ({ ...p, body: e.target.value }))}
                  style={{ fontSize: 13, lineHeight: 1.5, resize: 'vertical' }} />
              </div>
              {edit.id && (
                <div className="form-field">
                  <label className="form-label">What changed? (kept in the revision log)</label>
                  <input className="form-input" value={edit.note} placeholder="Fee raised to $89 per Brandyn 7/24"
                    onChange={e => setEdit(p => ({ ...p, note: e.target.value }))} />
                </div>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                <input type="checkbox" checked={edit.active} onChange={e => setEdit(p => ({ ...p, active: e.target.checked }))} />
                Active — Ask Andi may use this article
              </label>
              {edit.id && (
                <div>
                  <button className="btn sm" onClick={loadRevs}>View revision history</button>
                  {revs && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
                      {revs.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>No previous versions.</div>}
                      {revs.map(r => (
                        <details key={r.id} style={{ fontSize: 11.5, border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px' }}>
                          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                            {String(r.edited_at).slice(0, 16).replace('T', ' ')} · {r.edited_by || 'unknown'}{r.note ? ` — ${r.note}` : ''}
                          </summary>
                          <div style={{ marginTop: 6, whiteSpace: 'pre-wrap', color: 'var(--text-muted)' }}>{r.body}</div>
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {err && <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--tone-red-tx)' }}>{err}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                {edit.id && (
                  <button className="btn" onClick={() => { const a = articles.find(x => x.id === edit.id); if (a) { remove(a); setEdit(null) } }}
                    style={{ color: 'var(--danger)' }}>Delete</button>
                )}
                <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                  <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
                  <button className="btn primary" onClick={save} disabled={saving || !edit.title.trim()}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  )
}
