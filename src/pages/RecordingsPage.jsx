import { useState, useEffect, useRef } from 'react'
import { toast } from '../lib/dialogs'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useIsMobile } from '../lib/useIsMobile'
import EvalModal from '../components/EvalModal'
import { PageTabs, Segmented, ToneChip, Face, num, panel } from '../components/ui'

// Recordings tab — reads the call_recordings registry via /api/recordings.
// Every inbound and outbound customer call lands there at recording time;
// the server joins on the outcome/notes the rep filed and the job booked
// on the call (click the job chip to open it in ServiceTitan).

const OUTCOME_TONE = {
  'Booked':         'green',
  'No Answer':      'gray',
  'Voicemail':      'blue',
  'Not Interested': 'red',
  'DNC':            'red',
  'Bad Data':       'gray',
  'Text Sent':      'purple',
}

const scoreTone = (pct) => pct >= 90 ? 'green' : pct >= 75 ? 'amber' : 'red'

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

// The call's QA score as a tile (the All-evals look); opens the breakdown.
function ScoreTile({ pct, onClick, size }) {
  const t = scoreTone(Number(pct))
  return (
    <button onClick={onClick} title="Open the call evaluation" aria-label={`QA score ${Math.round(Number(pct))} — open the call evaluation`}
      style={{ ...num, width:size, height:size, borderRadius:11, flexShrink:0, padding:0, cursor:'pointer', lineHeight:1,
        display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:2,
        color:`var(--tone-${t}-tx)`, background:`var(--tone-${t}-bg)`, border:`1px solid var(--tone-${t}-bd)` }}>
      <span style={{ fontSize:14, fontWeight:800, letterSpacing:'-.02em' }}>{Math.round(Number(pct))}</span>
      <span style={{ fontSize:8, fontWeight:700, letterSpacing:'.08em' }}>QA</span>
    </button>
  )
}

const DIRECTIONS = [['all', 'All calls'], ['inbound', 'Inbound'], ['outbound', 'Outbound'], ['voicemail', 'Voicemails']]
const PERIODS = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All']]

export default function RecordingsPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  // Phone layout (≤768px): filters share rows, list rows stack into two
  // lines, and anything tappable clears 40px.
  const isMobile = useIsMobile()
  const tap = isMobile ? { minHeight:40 } : undefined

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
          // Chunk the IN list — with ServiceTitan calls registered the page
          // holds far more than the old 300-sid cap allowed.
          let evs = []
          for (let i = 0; i < sids.length; i += 200) {
            const { data } = await sb.from('call_evaluations')
              .select('id, call_sid, recording_sid, rep, contact_name, phone, pct, earned, possible, summary, scores, created_at')
              .in('call_sid', sids.slice(i, i + 200))
            if (data?.length) evs = evs.concat(data)
          }
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
    // ServiceTitan calls ('st-<id>') need a short-lived signed URL first —
    // ST ids are guessable, so that proxy isn't open like Twilio's.
    if (String(sid || '').startsWith('st-')) {
      ;(async () => {
        try {
          const { data: { session } } = await sb.auth.getSession()
          const r = await fetch(`/api/st/recording-url/${sid}`, { headers: { Authorization: `Bearer ${session?.access_token}` } })
          const d = await r.json()
          if (!r.ok) throw new Error(d.error || 'No recording')
          startAudio(rec, d.url)
        } catch (e) { toast(`Could not load this recording — ${e.message}`) }
      })()
      return
    }
    startAudio(rec, sid ? `/api/twilio/recording/${sid}` : rec.url)
  }
  const startAudio = (rec, src) => {
    const audio = new Audio(src)
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

  const downloadRec = async (rec) => {
    const sid0 = recSid(rec)
    if (String(sid0 || '').startsWith('st-')) {
      try {
        const { data: { session } } = await sb.auth.getSession()
        const r = await fetch(`/api/st/recording-url/${sid0}`, { headers: { Authorization: `Bearer ${session?.access_token}` } })
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || 'No recording')
        window.open(`${d.url}&download=1`, '_blank')
      } catch (e) { toast(`Could not download — ${e.message}`) }
      return
    }
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

  const pill = { borderRadius:99, padding:'7px 14px', ...tap }

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--bg)' }}>

      {/* ── Header bar — direction as page tabs (Voicemails carries the shared
          inbox's unheard count), the period on the right. ── */}
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', flexShrink:0, padding: isMobile ? '0 12px' : '0 24px',
        display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        <PageTabs value={dirFilter || 'all'} onChange={id => setDirFilter(id === 'all' ? '' : id)}
          tabs={DIRECTIONS.map(([id, label]) => [id, label, id === 'voicemail' && newVmCount ? newVmCount : null])} />
        <div style={{ marginLeft: isMobile ? 0 : 'auto', width: isMobile ? '100%' : undefined, paddingBottom: isMobile ? 8 : 0 }}>
          <Segmented value={dateRange} onChange={setDateRange} options={PERIODS} fill={isMobile} />
        </div>
      </div>

      <div style={{ flex:1, overflowY:'auto' }}>
        <div style={{ padding: isMobile ? 12 : 24, display:'flex', flexDirection:'column', gap: isMobile ? 12 : 16 }}>

          {/* Filters — on a phone the rep picker gets a full row, outcome and
              booked pair up, and search takes the row under them. */}
          <div style={{ display:'flex', gap: isMobile ? 8 : 10, flexWrap:'wrap', alignItems:'center' }}>
            {isAdmin && (
              <select className="form-input" aria-label="Rep" value={repFilter} onChange={e => setRepFilter(e.target.value)}
                style={{ ...pill, width: isMobile ? '100%' : 190 }}>
                <option value="">All reps</option>
                {profiles.map(p => <option key={p.id} value={p.name || p.email}>{p.name || p.email}</option>)}
              </select>
            )}
            <select className="form-input" aria-label="Outcome" value={outcomeFilter} onChange={e => setOutcomeFilter(e.target.value)}
              style={{ ...pill, width: isMobile ? 'auto' : 170, flex: isMobile ? '1 1 40%' : undefined, minWidth:0 }}>
              <option value="">All outcomes</option>
              {outcomes.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
            <button className="btn" onClick={() => setBookedOnly(b => !b)} aria-pressed={bookedOnly}
              style={{ borderRadius:99, justifyContent:'center', flex: isMobile ? '1 1 40%' : undefined, ...tap,
                ...(bookedOnly ? { background:'var(--tone-green-bg)', borderColor:'var(--tone-green-bd)', color:'var(--tone-green-tx)' } : {}) }}>
              {bookedOnly ? '✓ ' : ''}Booked calls only
            </button>
            <input className="form-input" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search recordings"
              placeholder="Customer, phone, notes, or job #..."
              style={{ ...pill, width:'auto', flex: isMobile ? '1 1 100%' : '1 1 200px', minWidth: isMobile ? 0 : 200 }} />
          </div>

          {loadErr && (
            <div style={{ padding:'10px 14px', fontSize:12.5, color:'var(--tone-red-tx)', background:'var(--tone-red-bg)', border:'1px solid var(--tone-red-bd)', borderRadius:12 }}>
              {loadErr}
            </div>
          )}

          {/* The list — count and totals ride in its header row */}
          <div style={{ ...panel, overflow:'hidden' }}>
            <div style={{ padding: isMobile ? '12px 14px' : '14px 20px', display:'flex', alignItems:'center', gap:'6px 10px', flexWrap:'wrap' }}>
              <span style={{ ...num, fontSize:14.5, fontWeight:700 }}>
                {loading ? 'Recordings' : `${filtered.length} recording${filtered.length !== 1 ? 's' : ''}`}
              </span>
              <span style={{ fontSize:12, color:'var(--text-muted)' }}>
                {isAdmin ? 'Every inbound and outbound customer call, with the outcome and notes attached' : 'Your recorded calls'}
              </span>
              <div style={{ marginLeft: isMobile ? 0 : 'auto', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                {!loading && bookedCount > 0 && <ToneChip tone="green">{bookedCount} booked</ToneChip>}
                {!loading && filtered.length > 0 && (
                  <span style={{ ...num, fontSize:12, color:'var(--text-muted)' }}>
                    Avg length <b style={{ color:'var(--text-primary)' }}>{fmtDuration(Math.round(filtered.reduce((s,r) => s + (r.duration || 0), 0) / filtered.length))}</b>
                  </span>
                )}
                {newVmCount > 0 && dirFilter !== 'voicemail' && (
                  <button onClick={() => setDirFilter('voicemail')}
                    style={{ ...num, fontSize:11.5, fontWeight:700, padding: isMobile ? '0 14px' : '3px 11px', borderRadius:99, cursor:'pointer', ...tap,
                      background:'var(--tone-amber-bg)', color:'var(--tone-amber-tx)', border:'1px solid var(--tone-amber-bd)' }}>
                    {newVmCount} new voicemail{newVmCount === 1 ? '' : 's'}
                  </button>
                )}
              </div>
            </div>

            {loading ? (
              <div style={{ padding: isMobile ? '4px 12px 14px' : '4px 18px 16px', display:'flex', flexDirection:'column', gap:10 }}>
                {[0, 1, 2, 3, 4].map(i => <div key={i} className="skel" style={{ height:46, borderRadius:10 }} />)}
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ borderTop:'1px solid var(--border)', padding:'40px 20px', textAlign:'center', color:'var(--text-muted)' }}>
                <div style={{ fontSize:14, fontWeight:600, color:'var(--text-secondary)', marginBottom:4 }}>No recordings found</div>
                <div style={{ fontSize:12.5 }}>Recordings appear here automatically once calls complete.</div>
              </div>
            ) : filtered.map((rec) => {
              const isPlaying = playingId === rec.id
              const isOpen = expandedId === rec.id
              const dirIn = rec.direction === 'inbound'
              const isVm = rec.direction === 'voicemail'
              const unheard = isVm && !rec.heard_at
              const bodyText = rec.notes || (isVm ? rec.transcript : '')
              const scored = rec.evaluation && rec.evaluation.pct != null
              // The outcome chip sits beside the name on desktop; on a phone it
              // moves to the second line with the time and duration.
              const outcomeChip = rec.outcome && <ToneChip tone={OUTCOME_TONE[rec.outcome] || 'gray'} small>{rec.outcome}</ToneChip>
              return (
                <div key={rec.id} className={isPlaying ? undefined : 'eval-row'}
                  style={{ padding: isMobile ? '12px 12px' : '11px 18px', borderTop:'1px solid var(--border)', background: isPlaying ? 'var(--accent-bg)' : 'transparent' }}>
                  {/* Phone: the row wraps into two lines — who (play, caller, rep,
                      job) on the first; when, how long, outcome and the buttons on
                      the second. The caller block claims the rest of line one so
                      the meta is pushed down. */}
                  <div style={{ display:'flex', alignItems: isMobile ? 'flex-start' : 'center', gap: isMobile ? '8px 10px' : 14, flexWrap: isMobile ? 'wrap' : undefined }}>

                    {/* Play button */}
                    <button onClick={() => togglePlay(rec)} aria-label={isPlaying ? 'Pause' : 'Play recording'}
                      style={{ width: isMobile ? 40 : 36, height: isMobile ? 40 : 36, borderRadius:'50%', flexShrink:0, cursor:'pointer', padding:0,
                        background: isPlaying ? 'var(--tone-green-tx)' : 'var(--surface-2)',
                        border: `1px solid ${isPlaying ? 'var(--tone-green-tx)' : 'var(--border)'}`,
                        color: isPlaying ? 'var(--surface)' : 'var(--text-secondary)',
                        display:'flex', alignItems:'center', justifyContent:'center' }}>
                      {isPlaying ? (
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1" width="3" height="10" rx="1"/><rect x="7" y="1" width="3" height="10" rx="1"/></svg>
                      ) : (
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7-4.5-7-4.5z"/></svg>
                      )}
                    </button>

                    {/* Customer + chips + notes preview */}
                    <div style={{ flex: isMobile ? '1 1 calc(100% - 50px)' : 1, minWidth:0, cursor: bodyText ? 'pointer' : 'default' }}
                      onClick={() => bodyText && setExpandedId(isOpen ? null : rec.id)}>
                      <div style={{ display:'flex', alignItems:'center', gap:7, flexWrap:'wrap' }}>
                        {unheard && <span title="New — nobody has listened yet" style={{ width:8, height:8, borderRadius:'50%', background:'var(--tone-amber-tx)', flexShrink:0 }} />}
                        <span style={{ fontSize:13.5, fontWeight: unheard ? 800 : 650, color:'var(--text-primary)' }}>
                          {rec.contact_name || 'Unknown caller'}
                        </span>
                        {rec.direction && (
                          <ToneChip small tone={isVm ? 'amber' : dirIn ? 'blue' : 'purple'} title={isVm ? 'Voicemail' : dirIn ? 'Inbound call' : 'Outbound call'}>
                            {isVm ? 'VM' : dirIn ? 'IN' : 'OUT'}
                          </ToneChip>
                        )}
                        {isMobile && isAdmin && rec.rep && <span style={{ fontSize:11.5, color:'var(--text-muted)' }}>· {rec.rep}</span>}
                        {!isMobile && outcomeChip}
                        {rec.st_job_id && (
                          <button onClick={(e) => { e.stopPropagation(); window.open(`https://go.servicetitan.com/#/Job/Index/${rec.st_job_id}`, '_blank') }}
                            title="Open this job in ServiceTitan"
                            style={{ border:'none', background:'none', padding:0, cursor:'pointer', font:'inherit', display:'inline-flex' }}>
                            <ToneChip tone="green" small>Job {rec.st_job_number || `#${rec.st_job_id}`} ↗</ToneChip>
                          </button>
                        )}
                      </div>
                      <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace: isOpen ? 'normal' : 'nowrap' }}>
                        <span style={num}>{fmtPhone(rec.phone)}</span>
                        {bodyText ? ` — ${isOpen ? '' : bodyText.slice(0, 110)}${!isOpen && bodyText.length > 110 ? '…' : ''}` : ''}
                      </div>
                      {isOpen && bodyText && (
                        <div style={{ marginTop:8, padding:'10px 13px', fontSize:12.5, lineHeight:1.55, whiteSpace:'pre-wrap',
                          background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:10, color:'var(--text-secondary)' }}>
                          {bodyText}
                        </div>
                      )}
                      {isPlaying && (
                        <div style={{ marginTop:7, height:3, background:'var(--border)', borderRadius:99, overflow:'hidden' }}>
                          <div style={{ height:'100%', width:`${progress}%`, background:'var(--tone-green-tx)', borderRadius:99, transition:'width .2s' }} />
                        </div>
                      )}
                    </div>

                    {/* QA score — its own column on desktop (blank when the call
                        wasn't scored, so the columns line up); on a phone it joins
                        the buttons below. */}
                    {!isMobile && (scored
                      ? <ScoreTile pct={rec.evaluation.pct} onClick={() => setOpenEval(rec.evaluation)} size={38} />
                      : <div style={{ width:38, flexShrink:0 }} />)}

                    {/* Meta — stacked at the right on desktop, inline on the phone's second line */}
                    <div style={isMobile ? { display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', minHeight:40 } : { textAlign:'right', flexShrink:0, minWidth:92 }}>
                      <div style={{ ...num, fontSize:13, fontWeight:700, color:'var(--text-primary)' }}>{fmtDuration(rec.duration)}</div>
                      <div style={{ ...num, fontSize:11, color:'var(--text-muted)' }}>{fmtWhen(rec.call_started_at || rec.created_at)}</div>
                      {isMobile && outcomeChip}
                    </div>

                    {isAdmin && !isMobile && (
                      <div style={{ display:'flex', alignItems:'center', gap:7, flexShrink:0, width:140 }}>
                        {rec.rep && (
                          <>
                            <Face name={rec.rep} size={20} />
                            <span style={{ fontSize:12, color:'var(--text-secondary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{rec.rep}</span>
                          </>
                        )}
                      </div>
                    )}

                    {/* Actions — the QA score joins them on a phone as a proper 40px button */}
                    <div style={{ display:'flex', gap:6, flexShrink:0, justifyContent:'flex-end', marginLeft: isMobile ? 'auto' : undefined, minWidth: isMobile ? undefined : 118 }}>
                      {isMobile && scored && (
                        <ScoreTile pct={rec.evaluation.pct} onClick={() => setOpenEval(rec.evaluation)} size={40} />
                      )}
                      {rec.external_id && (
                        <button className="btn sm" onClick={() => window.open(`https://go.servicetitan.com/#/Customer/${rec.external_id}`, '_blank')}
                          title="Open this customer in ServiceTitan"
                          style={{ borderRadius:99, padding: isMobile ? '5px 14px' : undefined, ...tap }}>
                          ST
                        </button>
                      )}
                      <button className="btn sm" onClick={() => downloadRec(rec)}
                        style={{ borderRadius:99, padding: isMobile ? '5px 14px' : undefined, ...tap }}>
                        Download
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {openEval && <EvalModal evalRow={openEval} onClose={() => setOpenEval(null)} />}
    </div>
  )
}
