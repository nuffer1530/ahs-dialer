import { useState, useCallback } from 'react'
import { useData } from '../lib/DataContext'
import { sb } from '../lib/supabase'
import Badge from '../components/Badge'
import { fmtDate } from '../lib/utils'
import { useNavigate } from 'react-router-dom'

export default function NotesPage() {
  const { contacts } = useData()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const navigate = useNavigate()
  let debounce = null

  const search = useCallback(async (q) => {
    if (!q.trim()) { setResults([]); setSearched(false); return }
    setLoading(true); setSearched(true)
    const { data } = await sb.from('call_logs').select('*').ilike('notes', `%${q}%`).order('created_at', { ascending: false }).limit(50)
    setResults(data || [])
    setLoading(false)
  }, [])

  const handleInput = (e) => {
    const val = e.target.value
    setQuery(val)
    clearTimeout(debounce)
    debounce = setTimeout(() => search(val), 400)
  }

  const highlight = (text, q) => {
    if (!q || !text) return text || ''
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark class="search-highlight">$1</mark>')
  }

  return (
    <div style={{ flex:1, overflowY:'auto', padding:24, display:'flex', flexDirection:'column', gap:16 }}>
      <h1 style={{ fontSize:20, fontWeight:600 }}>Notes Search</h1>
      <input
        value={query} onChange={handleInput} autoFocus
        placeholder="Search all call notes across every contact…"
        style={{ width:'100%', border:'1px solid var(--border-strong)', borderRadius:'var(--radius)', padding:'12px 16px', fontSize:15, background:'var(--surface)', color:'var(--text-primary)' }}
      />

      {loading && <div className="spinner" style={{ margin:'20px auto' }}></div>}

      {!loading && searched && results.length === 0 && (
        <div className="empty-state"><div className="empty-icon">🔍</div><div>No notes match "{query}"</div></div>
      )}

      {!loading && !searched && (
        <div style={{ color:'var(--text-muted)', fontSize:13, textAlign:'center', padding:40 }}>Type to search across all call notes.</div>
      )}

      {!loading && results.length > 0 && (
        <div>
          <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:12 }}>{results.length} result{results.length!==1?'s':''}{results.length===50?' (showing top 50)':''}</div>
          {results.map(l => {
            const c = contacts.find(x => x.id === l.contact_id)
            return (
              <div key={l.id}
                onClick={() => navigate('/')}
                style={{ padding:'12px 0', borderBottom:'1px solid var(--border)', cursor:'pointer' }}
              >
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4, flexWrap:'wrap' }}>
                  <span style={{ fontWeight:500, fontSize:13 }}>{c?.name || 'Unknown'}</span>
                  {c?.phone && <span style={{ color:'var(--text-muted)', fontSize:11 }}>{c.phone}</span>}
                  <Badge status={l.outcome} />
                  <span style={{ color:'var(--text-muted)', fontSize:11, marginLeft:'auto' }}>{l.rep} · {fmtDate(l.created_at)}</span>
                </div>
                <div style={{ fontSize:12, color:'var(--text-secondary)' }}
                  dangerouslySetInnerHTML={{ __html: highlight(l.notes || '', query) }} />
                {l.correction && <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:2 }}>✏️ Corrected from {l.correction}</div>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
