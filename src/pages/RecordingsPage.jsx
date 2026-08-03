import { useState, useEffect, useRef } from 'react'
import { toast } from '../lib/dialogs'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import EvalModal, { ScoreChip } from '../components/EvalModal'

// Recordings tab — reads the call_recordings registry via /api/recordings.
// Every inbound and outbound customer call lands there at recording time;
// the server joins on the outcome/notes the rep filed and the job booked
// on the call (click the job chip to open it in ServiceTitan).

const OUTCOME_COLORS = {
  'Booked':         { bg:'var(--tone-green-bg)', color:'var(--tone-green-tx)', border:'var(--tone-green-bd)' },
  'No Answer':      { bg:'var(--surface-2)', color:'var(--text-muted)', border:'var(--border)' },
  'Voicemail':      { bg:'var(--tone-blue-bg)', color:'var(--tone-blue-tx)', border:'var(--tone-blue-bd)' },
  'Not Interested': { bg:'var(--tone-red-bg)', color:'var(--tone-red-tx)', border:'var(--tone-red-bd)' },
  'DNC':            { bg:'var(--tone-red-bg)', color:'var(--tone-red-tx)', border:'var(--tone-red-bd)' },
  'Bad Data':       { bg:'var(--surface-2)', color:'var(--text-muted)', border:'var(--border)' },
  'Text Sent':      { bg:'var(--tone-purple-bg)', color:'var(--tone-purple-tx)', border:'var(--tone-purple-bd)' },
}

const fmtDuration = (s) => {
  if (!s && s !== 0) return '--'
  const m = Math.floor(s / 60), sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

const fmtWhen = (iso) => {
  if (!iso) return '--'
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Denver', month:'short', day:'numeric', hour:'numeric', minute:'2-digit',
  })
}

const fmtPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '').slice(-10)
  return d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : (p || '')
}

export default function RecordingsPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'

  const [recordings, setRecordings] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [profiles, setProfiles] = useState([])

  // Filters
  const [repFilter, setRepFilter] = useState(isAdmin ? '' : (profile?.name || profile?.email || ''))
  const [dirFilter, setDirFilter] = useState('')
  const [outcomeFilter, setOutcomeFilter] = useState('')
  const [bookedOnly, setBookedOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [dateRange, setDateRange] = useState('today')

  // Player + expanded notes
  const [playingId, setPlayingId] = useState(null)
  const [progress, setProgress] = useState(0)
  const [expandedId, setExpandedId] = useState(null)
  const audioRef = useRef(null)

  const [newVmCount, setNewVmCount] = useState(0)
  useEffect(() => {
    sb.from('profiles').select('id, name, email').eq('active', true).order('name').then(({ data }) => setProfiles(data || []))
    // Shared voicemail inbox: how many nobody has listened to yet?
    fetch('/api/recordings?direction=voicemail&limit=100')
      .then(r => r.json())
      .then(d => setNewVmCount((d.data || []).filter(r => !r.heard_at).length))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const load = async () => {
      setLoading(true); setLoadErr('')
      const now = new Date()
      let from = null
      if (dateRange === 'today') { from = new Date(now); from.setHours(0,0,0,0) }
      else if (dateRange === '7d') { from = new Date(now.getTime() - 7*24*60*60*1000) }
      else if (dateRange === '30d') { from = new Date(now.getTime() - 30*24*60*60*1000) }

      const params = new URLSearchParams()
      const rep = !isAdmin ? (profile?.name || profile?.email || '') : repFilter
      // Voicemails belong to no rep — everyone sees the shared inbox.
      if (rep && dirFilter !== 'voicemail') params.set('rep', rep)
      if (dirFilter) params.set('direction', dirFilter)
      if (bookedOnly) params.set('booked', '1')
      if (from) params.set('from', from.toISOString())
      params.set('limit', '300')

      try {
        const r = await fetch(`/api/recordings?${params}`)
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || 'Could not load recordings')
        const rows = d.data || []
        setRecordings(rows)
        // Attach QA evaluations by call sid (inbound calls get scored).
        const sids = rows.map(x => x.call_sid).filter(Boolean)
        if (sids.length) {
          const { data: evs } = await sb.from('call_evaluations')
            .select('id, call_sid, rep, contact_name, phone, pct, earned, possible, summary, scores, created_at')
            .in('call_sid', sids.slice(0, 300))
          if (evs?.length) {
            const bySid = new Map(evs.map(e => [e.call_sid, e]))
            setRecordings(prev => prev.map(x => ({ ...x, evaluation: bySid.get(x.call_sid) || null })))
          }
        }
      } catch (e) { setLoadErr(e.message); setRecordings([]) }
      setLoading(false)
    }
    if (profile) load()
  }, [profile, isAdmin, repFilter, dirFilter, bookedOnly, dateRange])
  const [openEval, setOpenEval] = useState(null)

  // Audio player controls — everything plays through the authenticated proxy.
  const recSid = (rec) => rec.recording_sid || rec.url?.split('/').pop()?.replace('.mp3', '')
  const togglePlay = (rec) => {
    if (playingId === rec.id) {
      audioRef.current?.pause()
      setPlayingId(null)
      return
    }
    if (audioRef.current) { audioRef.current.pause() }
    const sid = recSid(rec)
    const audio = new Audio(sid ? `/api/twilio/recording/${sid}` : rec.url)
    audioRef.current = audio
    // Playing a fresh voicemail marks it heard for the whole team.
    if (rec.direction === 'voicemail' && !rec.heard_at) {
      fetch('/api/recordings/heard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: rec.id }) }).catch(() => {})
      setRecordings(prev => prev.map(r => r.id === rec.id ? { ...r, heard_at: new Date().toISOString() } : r))
      setNewVmCount(n => Math.max(0, n - 1))
    }
    audio.onended = () => { setPlayingId(null); setProgress(0) }
    audio.ontimeupdate = () => setProgress(audio.duration ? (audio.currentTime / audio.duration) * 100 : 0)
    audio.onerror = () => { setPlayingId(null); toast('Could not load this recording.') }
    audio.play().then(() => setPlayingId(rec.id)).catch(() => setPlayingId(null))
  }

  useEffect(() => () => { audioRef.current?.pause() }, [])

  const downloadRec = (rec) => {
    const sid = recSid(rec)
    window.open(sid ? `/api/twilio/recording/${sid}?download=1` : rec.url, '_blank')
  }

  const filtered = recordings.filter(r => {
    if (outcomeFilter && r.outcome !== outcomeFilter) return false
    if (search) {
      const q = search.toLowerCase()
      const hay = `${r.contact_name || ''} ${r.phone || ''} ${r.notes || ''} ${r.transcript || ''} ${r.st_job_number || ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  const outcomes = [...new Set(recordings.map(r => r.outcome).filter(Boolean))]
  const bookedCount = filtered.filter(r => r.st_job_id).length

  const selStyle = { border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'7px 10px', fontSize:12, background:'var(--surface)', color:'var(--text-primary)' }
  const lblStyle = { fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:4 }

  return (
    <div style={{ flex:1, overflowY:'auto', padding:24 }}>
      {/* Header */}
      <div style={{ marginBottom:18 }}>
        <div style={{ fontSize:18, fontWeight:600, color:'var(--text-primary)' }}>Call Recordings</div>
        <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2 }}>
          {isAdmin ? 'Every inbound and outbound customer call, with the outcome and notes attached' : 'Your recorded calls'}
        </div>
      </div>

      {/* Filters */}
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap', alignItems:'flex-end' }}>
        {isAdmin && (
          <div>
            <div style={lblStyle}>Rep</div>
            <select value={repFilter} onChange={e => setRepFilter(e.target.value)} style={{ ...selStyle, minWidth:160 }}>
              <option value="">All reps</option>
              {profiles.map(p => <option key={p.id} value={p.name || p.email}>{p.name || p.email}</option>)}
            </select>
          </div>
        )}
        <div>
          <div style={lblStyle}>Period</div>
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
          <div style={lblStyle}>Direction</div>
          <select value={dirFilter} onChange={e => setDirFilter(e.target.value)} style={{ ...selStyle, minWidth:110 }}>
            <option value="">All calls</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
            <option value="voicemail">Voicemails</option>
          </select>
        </div>
        <div>
          <div style={lblStyle}>Outcome</div>
          <select value={outcomeFilter} onChange={e => setOutcomeFilter(e.target.value)} style={{ ...selStyle, minWidth:130 }}>
            <option value="">All outcomes</option>
            {outcomes.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <div style={lblStyle}>Booked</div>
          <button onClick={() => setBookedOnly(b => !b)}
            style={{ padding:'7px 12px', fontSize:12, borderRadius:'var(--radius)', border:'1px solid', cursor:'pointer',
              borderColor: bookedOnly ? 'var(--tone-green-bd)' : 'var(--border)',
              background: bookedOnly ? 'var(--tone-green-bg)' : 'var(--surface)',
              color: bookedOnly ? 'var(--tone-green-tx)' : 'var(--text-secondary)', fontWeight: bookedOnly ? 700 : 400 }}>
            Booked calls only
          </button>
        </div>
        <div style={{ flex:1, minWidth:170 }}>
          <div style={lblStyle}>Search</div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Customer, phone, notes, or job #..."
            style={{ ...selStyle, width:'100%' }} />
        </div>
      </div>

      {/* Summary */}
      <div style={{ display:'flex', gap:16, marginBottom:14, fontSize:12, color:'var(--text-muted)', alignItems:'center' }}>
        <span>{filtered.length} recording{filtered.length !== 1 ? 's' : ''}</span>
        {bookedCount > 0 && <span style={{ color:'var(--tone-green-tx)', fontWeight:600 }}>{bookedCount} booked</span>}
        {newVmCount > 0 && dirFilter !== 'voicemail' && (
          <button onClick={() => setDirFilter('voicemail')}
            style={{ fontSize:11, fontWeight:700, padding:'3px 10px', borderRadius:99, cursor:'pointer',
              background:'var(--tone-amber-bg)', color:'var(--tone-amber-tx)', border:'1px solid var(--tone-amber-bd)' }}>
            {newVmCount} new voicemail{newVmCount === 1 ? '' : 's'}
          </button>
        )}
        {filtered.length > 0 && (
          <span>Avg length: {fmtDuration(Math.round(filtered.reduce((s,r) => s + (r.duration || 0), 0) / filtered.length))}</span>
        )}
      </div>

      {loadErr && (
        <div style={{ padding:'10px 14px', marginBottom:12, fontSize:12, color:'var(--tone-red-tx)', background:'var(--tone-red-bg)', border:'1px solid var(--tone-red-bd)', borderRadius:8 }}>
          {loadErr}
        </div>
      )}

      {/* List */}
      {loading ? (
        <div style={{ display:'flex', justifyContent:'center', padding:60 }}><div className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:'center', padding:60, color:'var(--text-muted)' }}>
          <div style={{ fontSize:14, fontWeight:500, marginBottom:4 }}>No recordings found</div>
          <div style={{ fontSize:12 }}>Recordings appear here automatically once calls complete.</div>
        </div>
      ) : (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, overflow:'hidden' }}>
          {filtered.map((rec, i) => {
            const isPlaying = playingId === rec.id
            const isOpen = expandedId === rec.id
            const oc = OUTCOME_COLORS[rec.outcome] || { bg:'var(--surface-2)', color:'var(--text-muted)', border:'var(--border)' }
            const dirIn = rec.direction === 'inbound'
            const isVm = rec.direction === 'voicemail'
            const unheard = isVm && !rec.heard_at
            const bodyText = rec.notes || (isVm ? rec.transcript : '')
            return (
              <div key={rec.id}
                style={{ padding:'12px 16px', borderBottom: i < filtered.length-1 ? '1px solid var(--border)' : 'none', background: isPlaying ? 'var(--accent-bg)' : 'transparent' }}>
                <div style={{ display:'flex', alignItems:'center', gap:12 }}>

                  {/* Play button */}
                  <button onClick={() => togglePlay(rec)}
                    style={{ width:36, height:36, borderRadius:'50%', flexShrink:0, cursor:'pointer',
                      background: isPlaying ? 'var(--tone-green-bd)' : 'var(--surface-2)',
                      border: `1px solid ${isPlaying ? 'var(--tone-green-bd)' : 'var(--border)'}`,
                      display:'flex', alignItems:'center', justifyContent:'center' }}>
                    {isPlaying ? (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="#fff"><rect x="2" y="1" width="3" height="10" rx="1"/><rect x="7" y="1" width="3" height="10" rx="1"/></svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="var(--text-secondary)"><path d="M3 1.5v9l7-4.5-7-4.5z"/></svg>
                    )}
                  </button>

                  {/* Customer + chips + notes preview */}
                  <div style={{ flex:1, minWidth:0, cursor: bodyText ? 'pointer' : 'default' }}
                    onClick={() => bodyText && setExpandedId(isOpen ? null : rec.id)}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                      {unheard && <span title="New — nobody has listened yet" style={{ width:8, height:8, borderRadius:'50%', background:'var(--tone-amber-bd)', flexShrink:0 }} />}
                      {rec.direction && (
                        <span title={isVm ? 'Voicemail' : dirIn ? 'Inbound call' : 'Outbound call'}
                          style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:99, flexShrink:0,
                            background: isVm ? 'var(--tone-amber-bg)' : dirIn ? 'var(--tone-blue-bg)' : 'var(--tone-purple-bg)',
                            color: isVm ? 'var(--tone-amber-tx)' : dirIn ? 'var(--tone-blue-tx)' : 'var(--tone-purple-tx)',
                            border: `1px solid ${isVm ? 'var(--tone-amber-bd)' : dirIn ? 'var(--tone-blue-bd)' : 'var(--tone-purple-bd)'}` }}>
                          {isVm ? 'VM' : dirIn ? 'IN' : 'OUT'}
                        </span>
                      )}
                      <span style={{ fontSize:13, fontWeight: unheard ? 800 : 600, color:'var(--text-primary)' }}>
                        {rec.contact_name || 'Unknown caller'}
                      </span>
                      {rec.outcome && (
                        <span style={{ fontSize:10, fontWeight:600, padding:'2px 7px', borderRadius:99, background:oc.bg, color:oc.color, border:`1px solid ${oc.border}` }}>
                          {rec.outcome}
                        </span>
                      )}
                      {rec.evaluation && (
                        <span onClick={e => e.stopPropagation()}>
                          <ScoreChip pct={rec.evaluation.pct} onClick={() => setOpenEval(rec.evaluation)} />
                        </span>
                      )}
                      {rec.st_job_id && (
                        <button onClick={(e) => { e.stopPropagation(); window.open(`https://go.servicetitan.com/#/Job/Index/${rec.st_job_id}`, '_blank') }}
                          title="Open this job in ServiceTitan"
                          style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:99, cursor:'pointer',
                            background:'var(--tone-green-bg)', color:'var(--tone-green-tx)', border:'1px solid var(--tone-green-bd)' }}>
                          Job {rec.st_job_number || `#${rec.st_job_id}`} ↗
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace: isOpen ? 'normal' : 'nowrap' }}>
                      {fmtPhone(rec.phone)}
                      {bodyText ? ` — ${isOpen ? '' : bodyText.slice(0, 110)}${!isOpen && bodyText.length > 110 ? '…' : ''}` : ''}
                    </div>
                    {isOpen && bodyText && (
                      <div style={{ marginTop:6, padding:'8px 11px', fontSize:12, lineHeight:1.55, whiteSpace:'pre-wrap',
                        background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:8, color:'var(--text-secondary)' }}>
                        {bodyText}
                      </div>
                    )}
                    {isPlaying && (
                      <div style={{ marginTop:6, height:3, background:'var(--border)', borderRadius:99, overflow:'hidden' }}>
                        <div style={{ height:'100%', width:`${progress}%`, background:'var(--tone-green-bd)', borderRadius:99, transition:'width .2s' }} />
                      </div>
                    )}
                  </div>

                  {/* Meta */}
                  <div style={{ textAlign:'right', flexShrink:0, minWidth:92 }}>
                    <div style={{ fontSize:12, fontWeight:600, color:'var(--text-primary)' }}>{fmtDuration(rec.duration)}</div>
                    <div style={{ fontSize:10, color:'var(--text-muted)' }}>{fmtWhen(rec.call_started_at || rec.created_at)}</div>
                  </div>

                  {isAdmin && (
                    <div style={{ fontSize:11, color:'var(--text-secondary)', flexShrink:0, minWidth:90, textAlign:'right' }}>{rec.rep || ''}</div>
                  )}

                  {/* Actions */}
                  <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                    {rec.external_id && (
                      <button onClick={() => window.open(`https://go.servicetitan.com/#/Customer/${rec.external_id}`, '_blank')}
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
              </div>
            )
          })}
        </div>
      )}

      {openEval && <EvalModal evalRow={openEval} onClose={() => setOpenEval(null)} />}
    </div>
  )
}
