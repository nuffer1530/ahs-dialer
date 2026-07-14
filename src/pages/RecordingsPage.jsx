import { useState, useEffect, useRef } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useData } from '../lib/DataContext'

const OUTCOME_COLORS = {
  'Booked':         { bg:'#DCFCE7', color:'#15803D', border:'#16A34A' },
  'No Answer':      { bg:'var(--surface-2)', color:'var(--text-muted)', border:'var(--border)' },
  'Voicemail':      { bg:'#EFF6FF', color:'#1D4ED8', border:'#3B82F6' },
  'Not Interested': { bg:'#FEE2E2', color:'#B91C1C', border:'#F87171' },
  'DNC':            { bg:'#FEE2E2', color:'#7F1D1D', border:'#DC2626' },
  'Bad Data':       { bg:'var(--surface-2)', color:'var(--text-muted)', border:'var(--border)' },
  'Text Sent':      { bg:'#F3E8FF', color:'#6B21A8', border:'#A855F7' },
}

const fmtDuration = (s) => {
  if (!s && s !== 0) return '--'
  const m = Math.floor(s / 60), sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

const fmtWhen = (iso) => {
  if (!iso) return '--'
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
}

export default function RecordingsPage() {
  const { profile } = useAuth()
  const { contacts } = useData()
  const isAdmin = profile?.role === 'admin'

  const [recordings, setRecordings] = useState([])
  const [loading, setLoading] = useState(true)
  const [profiles, setProfiles] = useState([])

  // Filters
  const [repFilter, setRepFilter] = useState(isAdmin ? '' : (profile?.name || ''))
  const [outcomeFilter, setOutcomeFilter] = useState('')
  const [search, setSearch] = useState('')
  const [dateRange, setDateRange] = useState('7d')

  // Player
  const [playingId, setPlayingId] = useState(null)
  const [progress, setProgress] = useState(0)
  const audioRef = useRef(null)

  useEffect(() => {
    sb.from('profiles').select('id, name, email').order('name').then(({ data }) => setProfiles(data || []))
  }, [])

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      const now = new Date()
      let from = null
      if (dateRange === 'today') { from = new Date(now); from.setHours(0,0,0,0) }
      else if (dateRange === '7d') { from = new Date(now.getTime() - 7*24*60*60*1000) }
      else if (dateRange === '30d') { from = new Date(now.getTime() - 30*24*60*60*1000) }

      let q = sb.from('call_logs')
        .select('*, contacts(name, phone, external_id)')
        .not('recording_url', 'is', null)
        .order('created_at', { ascending: false })
        .limit(200)

      if (!isAdmin) q = q.eq('rep', profile?.name || profile?.email)
      else if (repFilter) q = q.eq('rep', repFilter)
      if (from) q = q.gte('created_at', from.toISOString())

      const { data } = await q
      setRecordings(data || [])
      setLoading(false)
    }
    if (profile) load()
  }, [profile, isAdmin, repFilter, dateRange])

  // Audio player controls
  const togglePlay = (rec) => {
    if (playingId === rec.id) {
      audioRef.current?.pause()
      setPlayingId(null)
      return
    }
    if (audioRef.current) { audioRef.current.pause() }
    const sid = rec.recording_url?.split('/').pop()?.replace('.mp3', '')
    const src = sid ? `/api/twilio/recording/${sid}` : rec.recording_url
    const audio = new Audio(src)
    audioRef.current = audio
    audio.onended = () => { setPlayingId(null); setProgress(0) }
    audio.ontimeupdate = () => setProgress(audio.duration ? (audio.currentTime / audio.duration) * 100 : 0)
    audio.onerror = () => { setPlayingId(null); alert('Could not load this recording.') }
    audio.play().then(() => setPlayingId(rec.id)).catch(() => setPlayingId(null))
  }

  useEffect(() => () => { audioRef.current?.pause() }, [])

  const downloadRec = (rec) => {
    const sid = rec.recording_url?.split('/').pop()?.replace('.mp3', '')
    const url = sid ? `/api/twilio/recording/${sid}?download=1` : rec.recording_url
    window.open(url, '_blank')
  }

  const filtered = recordings.filter(r => {
    if (outcomeFilter && r.outcome !== outcomeFilter) return false
    if (search) {
      const q = search.toLowerCase()
      const name = (r.contacts?.name || '').toLowerCase()
      const phone = (r.contacts?.phone || '').toLowerCase()
      const notes = (r.notes || '').toLowerCase()
      if (!name.includes(q) && !phone.includes(q) && !notes.includes(q)) return false
    }
    return true
  })

  const outcomes = [...new Set(recordings.map(r => r.outcome).filter(Boolean))]

  return (
    <div style={{ flex:1, overflowY:'auto', padding:24 }}>
      {/* Header */}
      <div style={{ marginBottom:18 }}>
        <div style={{ fontSize:18, fontWeight:600, color:'var(--text-primary)' }}>Call Recordings</div>
        <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2 }}>
          {isAdmin ? 'Review and coach on any rep\u2019s calls' : 'Your recorded calls'}
        </div>
      </div>

      {/* Filters */}
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap', alignItems:'flex-end' }}>
        {isAdmin && (
          <div>
            <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:4 }}>Rep</div>
            <select value={repFilter} onChange={e => setRepFilter(e.target.value)}
              style={{ border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'7px 10px', fontSize:12, background:'var(--surface)', color:'var(--text-primary)', minWidth:170 }}>
              <option value="">All reps</option>
              {profiles.map(p => <option key={p.id} value={p.name || p.email}>{p.name || p.email}</option>)}
            </select>
          </div>
        )}
        <div>
          <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:4 }}>Period</div>
          <div style={{ display:'flex', gap:4 }}>
            {[['today','Today'],['7d','7 days'],['30d','30 days'],['all','All']].map(([id, label]) => (
              <button key={id} onClick={() => setDateRange(id)}
                style={{ padding:'7px 12px', fontSize:12, borderRadius:'var(--radius)', border:'1px solid', cursor:'pointer',
                  borderColor: dateRange===id ? 'var(--accent)' : 'var(--border)',
                  background: dateRange===id ? 'var(--accent)' : 'var(--surface)',
                  color: dateRange===id ? '#fff' : 'var(--text-secondary)' }}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:4 }}>Outcome</div>
          <select value={outcomeFilter} onChange={e => setOutcomeFilter(e.target.value)}
            style={{ border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'7px 10px', fontSize:12, background:'var(--surface)', color:'var(--text-primary)', minWidth:140 }}>
            <option value="">All outcomes</option>
            {outcomes.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div style={{ flex:1, minWidth:180 }}>
          <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:4 }}>Search</div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Customer, phone, or notes..."
            style={{ width:'100%', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'7px 10px', fontSize:12, background:'var(--surface)', color:'var(--text-primary)' }} />
        </div>
      </div>

      {/* Summary */}
      <div style={{ display:'flex', gap:16, marginBottom:14, fontSize:12, color:'var(--text-muted)' }}>
        <span>{filtered.length} recording{filtered.length !== 1 ? 's' : ''}</span>
        {filtered.length > 0 && (
          <span>
            Avg length: {fmtDuration(Math.round(filtered.reduce((s,r) => s + (r.recording_duration || 0), 0) / filtered.length))}
          </span>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div style={{ display:'flex', justifyContent:'center', padding:60 }}><div className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:'center', padding:60, color:'var(--text-muted)' }}>
          <div style={{ fontSize:14, fontWeight:500, marginBottom:4 }}>No recordings found</div>
          <div style={{ fontSize:12 }}>Recordings appear here once calls are completed.</div>
        </div>
      ) : (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, overflow:'hidden' }}>
          {filtered.map((rec, i) => {
            const isPlaying = playingId === rec.id
            const oc = OUTCOME_COLORS[rec.outcome] || { bg:'var(--surface-2)', color:'var(--text-muted)', border:'var(--border)' }
            return (
              <div key={rec.id}
                style={{ padding:'12px 16px', borderBottom: i < filtered.length-1 ? '1px solid var(--border)' : 'none', display:'flex', alignItems:'center', gap:12, background: isPlaying ? 'var(--accent-bg)' : 'transparent' }}>

                {/* Play button */}
                <button onClick={() => togglePlay(rec)}
                  style={{ width:36, height:36, borderRadius:'50%', border:'none', flexShrink:0, cursor:'pointer',
                    background: isPlaying ? '#16A34A' : 'var(--surface-2)',
                    border: `1px solid ${isPlaying ? '#16A34A' : 'var(--border)'}`,
                    display:'flex', alignItems:'center', justifyContent:'center' }}>
                  {isPlaying ? (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="#fff"><rect x="2" y="1" width="3" height="10" rx="1"/><rect x="7" y="1" width="3" height="10" rx="1"/></svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="var(--text-secondary)"><path d="M3 1.5v9l7-4.5-7-4.5z"/></svg>
                  )}
                </button>

                {/* Customer + notes */}
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)' }}>
                      {rec.contacts?.name || 'Unknown caller'}
                    </span>
                    {rec.outcome && (
                      <span style={{ fontSize:10, fontWeight:600, padding:'2px 7px', borderRadius:99, background:oc.bg, color:oc.color, border:`1px solid ${oc.border}` }}>
                        {rec.outcome}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>
                    {rec.contacts?.phone || ''}
                    {rec.notes ? `${rec.contacts?.phone ? ' - ' : ''}${rec.notes.slice(0, 90)}${rec.notes.length > 90 ? '...' : ''}` : ''}
                  </div>
                  {isPlaying && (
                    <div style={{ marginTop:6, height:3, background:'var(--border)', borderRadius:99, overflow:'hidden' }}>
                      <div style={{ height:'100%', width:`${progress}%`, background:'#16A34A', borderRadius:99, transition:'width .2s' }} />
                    </div>
                  )}
                </div>

                {/* Meta */}
                <div style={{ textAlign:'right', flexShrink:0, minWidth:100 }}>
                  <div style={{ fontSize:12, fontWeight:600, color:'var(--text-primary)' }}>{fmtDuration(rec.recording_duration)}</div>
                  <div style={{ fontSize:10, color:'var(--text-muted)' }}>{fmtWhen(rec.created_at)}</div>
                </div>

                {isAdmin && (
                  <div style={{ fontSize:11, color:'var(--text-secondary)', flexShrink:0, minWidth:110, textAlign:'right' }}>{rec.rep}</div>
                )}

                {/* Actions */}
                <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                  {rec.contacts?.external_id && (
                    <button onClick={() => window.open(`https://go.servicetitan.com/#/Customer/${rec.contacts.external_id}`, '_blank')}
                      style={{ padding:'5px 10px', fontSize:11, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', color:'var(--text-secondary)', cursor:'pointer' }}>
                      ST
                    </button>
                  )}
                  <button onClick={() => downloadRec(rec)}
                    style={{ padding:'5px 10px', fontSize:11, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--surface-2)', color:'var(--text-secondary)', cursor:'pointer' }}>
                    Download
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
