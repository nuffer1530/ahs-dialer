import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'

// Settings → Call Routing: hours, holidays, greetings, after-hours behavior,
// queue/hold settings, voicemail delivery — the whole inbound phone tree.
// Saves to app_settings 'call_routing'; live on the next call (~30s cache).

const DAYS = [['mon','Monday'],['tue','Tuesday'],['wed','Wednesday'],['thu','Thursday'],['fri','Friday'],['sat','Saturday'],['sun','Sunday']]
const MUSIC_LABELS = { classical:'Classical strings', waltz:'Clockwork waltz', ambient:'Ambient', electronica:'Electronica', guitars:'Acoustic guitar', rock:'Rock', softrock:'Soft rock', custom:'Custom URL…' }
const VOICE_LABELS = {
  'Polly.Joanna-Neural':'Joanna — female, natural (recommended)', 'Polly.Matthew-Neural':'Matthew — male, natural',
  'Polly.Salli-Neural':'Salli — female', 'Polly.Joey-Neural':'Joey — male', 'Polly.Kendra-Neural':'Kendra — female',
  'Polly.Kimberly-Neural':'Kimberly — female', alice:'Alice — legacy robotic',
}

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

// US federal-style holidays this company closes for, computed for a given year.
function federalHolidays(year) {
  const nthDow = (month, dow, n) => {           // n-th weekday of a month
    const d = new Date(year, month, 1)
    let count = 0
    while (true) { if (d.getDay() === dow && ++count === n) break; d.setDate(d.getDate() + 1) }
    return d
  }
  const lastDow = (month, dow) => {
    const d = new Date(year, month + 1, 0)
    while (d.getDay() !== dow) d.setDate(d.getDate() - 1)
    return d
  }
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  return [
    { date: `${year}-01-01`, name: "New Year's Day" },
    { date: iso(lastDow(4, 1)), name: 'Memorial Day' },
    { date: `${year}-07-04`, name: 'Independence Day' },
    { date: iso(nthDow(8, 1, 1)), name: 'Labor Day' },
    { date: iso(nthDow(10, 4, 4)), name: 'Thanksgiving' },
    { date: `${year}-12-25`, name: 'Christmas Day' },
  ]
}

export default function CallRoutingTab() {
  const [cfg, setCfg] = useState(null)
  const [state, setState] = useState(null)
  const [voices, setVoices] = useState([])
  const [music, setMusic] = useState([])
  const [profiles, setProfiles] = useState([])
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const [extraEmail, setExtraEmail] = useState('')

  useEffect(() => {
    authed('/api/admin/call-routing')
      .then(d => { setCfg(d.cfg); setState(d.state); setVoices(d.voices || []); setMusic(d.musicOptions || []) })
      .catch(e => setErr(e.message))
    sb.from('profiles').select('id, name, email').eq('active', true).order('name').then(({ data }) => setProfiles(data || []))
  }, [])

  const save = async () => {
    if (saving || !cfg) return
    setSaving(true); setErr(''); setSavedMsg('')
    try {
      const d = await authed('/api/admin/call-routing', { method: 'POST', body: JSON.stringify({ cfg }) })
      setCfg(d.cfg); setState(d.state)
      setSavedMsg('Saved — live on the next call.')
      setTimeout(() => setSavedMsg(''), 4000)
    } catch (e) { setErr(e.message) }
    setSaving(false)
  }

  // Immutable setters into the nested config.
  const set = (patch) => setCfg(c => ({ ...c, ...patch }))
  const setIn = (key, patch) => setCfg(c => ({ ...c, [key]: { ...c[key], ...patch } }))
  const setDay = (day, patch) => setCfg(c => ({ ...c, hours: { ...c.hours, [day]: { ...c.hours[day], ...patch } } }))
  const setOverflow = (patch) => setCfg(c => ({ ...c, queue: { ...c.queue, overflow: { ...c.queue.overflow, ...patch } } }))

  if (err && !cfg) return <div style={{ padding: 20, color: 'var(--danger)', fontSize: 13 }}>{err}</div>
  if (!cfg) return <div className="spinner lg" style={{ margin: '60px auto' }} />

  const overrideOn = cfg.override.active && !(cfg.override.until && Date.parse(cfg.override.until) < Date.now())
  const input = { border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'7px 10px', fontSize:12.5, background:'var(--surface)', color:'var(--text-primary)' }
  const lbl = { fontSize:10.5, fontWeight:700, textTransform:'uppercase', letterSpacing:.6, color:'var(--text-muted)', marginBottom:4 }
  const cardTitle = (t, sub) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13.5, fontWeight: 800 }}>{t}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ padding: 24, maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 90 }}>

        {/* Status line */}
        {state && (
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Right now the phones are{' '}
            <b style={{ color: state.open ? 'var(--tone-green-tx)' : 'var(--tone-red-tx)' }}>
              {state.open ? 'OPEN' : 'CLOSED'}
            </b>
            {' '}({state.reason === 'override' ? 'emergency override' : state.reason === 'holiday' ? `holiday: ${state.holiday?.name || ''}` : state.reason === 'hours' ? 'outside business hours' : 'within business hours'} · {state.now} Denver)
          </div>
        )}

        {/* Emergency override */}
        <div className="card" style={{ padding: 16, border: overrideOn ? '2px solid var(--tone-red-bd)' : undefined, background: overrideOn ? 'var(--tone-red-bg)' : undefined }}>
          {cardTitle('Emergency override', 'Close the phones right now — weather day, all-hands, outage. Overrides hours and holidays.')}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <button onClick={() => setIn('override', { active: !cfg.override.active })}
              style={{ padding: '9px 18px', fontSize: 13, fontWeight: 800, borderRadius: 'var(--radius)', cursor: 'pointer',
                border: '1px solid var(--tone-red-bd)',
                background: cfg.override.active ? 'var(--tone-red-bd)' : 'var(--surface)',
                color: cfg.override.active ? '#fff' : 'var(--tone-red-tx)' }}>
              {cfg.override.active ? 'PHONES CLOSED — click to reopen' : 'Close the phones'}
            </button>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={lbl}>What callers hear (optional)</div>
              <input style={{ ...input, width: '100%' }} placeholder="Due to weather we are closed today. Please leave a message…"
                value={cfg.override.message} onChange={e => setIn('override', { message: e.target.value })} />
            </div>
            <div>
              <div style={lbl}>Auto-reopen at (optional)</div>
              <input type="datetime-local" style={input} value={cfg.override.until ? cfg.override.until.slice(0, 16) : ''}
                onChange={e => setIn('override', { until: e.target.value ? new Date(e.target.value).toISOString() : null })} />
            </div>
          </div>
        </div>

        {/* Hours */}
        <div className="card" style={{ padding: 16 }}>
          {cardTitle('Hours of operation', 'Denver time. Outside these hours, the after-hours handling below takes over.')}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {DAYS.map(([k, label]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 90, fontSize: 12.5, fontWeight: 600 }}>{label}</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer', width: 70 }}>
                  <input type="checkbox" checked={!cfg.hours[k].closed} onChange={e => setDay(k, { closed: !e.target.checked })} />
                  {cfg.hours[k].closed ? 'Closed' : 'Open'}
                </label>
                {!cfg.hours[k].closed && (
                  <>
                    <input type="time" style={input} value={cfg.hours[k].open} onChange={e => setDay(k, { open: e.target.value })} />
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>to</span>
                    <input type="time" style={input} value={cfg.hours[k].close} onChange={e => setDay(k, { close: e.target.value })} />
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Holidays */}
        <div className="card" style={{ padding: 16 }}>
          {cardTitle('Holiday schedule', 'Closed all day on these dates. A custom message beats the standard closed greeting.')}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {(cfg.holidays || []).sort((a, b) => (a.date || '').localeCompare(b.date || '')).map((h, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input type="date" style={input} value={h.date || ''}
                  onChange={e => set({ holidays: cfg.holidays.map((x, xi) => xi === i ? { ...x, date: e.target.value } : x) })} />
                <input style={{ ...input, width: 160 }} placeholder="Name" value={h.name || ''}
                  onChange={e => set({ holidays: cfg.holidays.map((x, xi) => xi === i ? { ...x, name: e.target.value } : x) })} />
                <input style={{ ...input, flex: 1, minWidth: 180 }} placeholder="Custom message (optional)" value={h.message || ''}
                  onChange={e => set({ holidays: cfg.holidays.map((x, xi) => xi === i ? { ...x, message: e.target.value } : x) })} />
                <button className="btn sm" onClick={() => set({ holidays: cfg.holidays.filter((_, xi) => xi !== i) })}>Remove</button>
              </div>
            ))}
            {(cfg.holidays || []).length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No holidays set.</div>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm" onClick={() => set({ holidays: [...(cfg.holidays || []), { date: '', name: '', message: '' }] })}>+ Add date</button>
            <button className="btn sm" onClick={() => {
              const yr = new Date().getFullYear()
              const candidates = [...federalHolidays(yr), ...federalHolidays(yr + 1)]
                .filter(h => h.date >= new Date().toISOString().slice(0, 10))
                .filter(h => !(cfg.holidays || []).some(x => x.date === h.date))
                .slice(0, 8)
              set({ holidays: [...(cfg.holidays || []), ...candidates.map(h => ({ ...h, message: '' }))] })
            }}>+ Add upcoming US holidays</button>
          </div>
        </div>

        {/* Greetings */}
        <div className="card" style={{ padding: 16 }}>
          {cardTitle('Greetings & voice', 'Type it, save it, and the very next caller hears it. All spoken with the voice below.')}
          <div style={{ marginBottom: 12, maxWidth: 380 }}>
            <div style={lbl}>Voice</div>
            <select style={{ ...input, width: '100%' }} value={cfg.voice} onChange={e => set({ voice: e.target.value })}>
              {voices.map(v => <option key={v} value={v}>{VOICE_LABELS[v] || v}</option>)}
            </select>
          </div>
          {[
            ['open', 'Open-hours greeting', 'Played before the caller is queued to the floor.'],
            ['closed', 'Closed / after-hours greeting', 'Played when calling outside business hours.'],
            ['holiday', 'Holiday greeting (optional)', 'Blank = the closed greeting is used on holidays.'],
            ['voicemail', 'Voicemail prompt', 'Played right before the record beep.'],
          ].map(([k, label, hint]) => (
            <div key={k} style={{ marginBottom: 10 }}>
              <div style={lbl}>{label}</div>
              <textarea rows={2} style={{ ...input, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                placeholder={hint} value={cfg.greetings[k]} onChange={e => setIn('greetings', { [k]: e.target.value })} />
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{hint}</div>
            </div>
          ))}
        </div>

        {/* After hours */}
        <div className="card" style={{ padding: 16 }}>
          {cardTitle('After-hours & holiday handling', 'What happens once the closed greeting has played.')}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <div style={lbl}>Action</div>
              <select style={{ ...input, minWidth: 230 }} value={cfg.afterHours.action} onChange={e => setIn('afterHours', { action: e.target.value })}>
                <option value="forward">Forward to an on-call phone</option>
                <option value="voicemail">Straight to voicemail</option>
                <option value="floor">Try the floor, then voicemail</option>
              </select>
            </div>
            {cfg.afterHours.action === 'forward' && (
              <div>
                <div style={lbl}>On-call number</div>
                <input style={{ ...input, width: 170 }} placeholder="+17195551234" value={cfg.afterHours.forwardNumber}
                  onChange={e => setIn('afterHours', { forwardNumber: e.target.value })} />
              </div>
            )}
            {cfg.afterHours.action === 'floor' && (
              <div>
                <div style={lbl}>Ring the floor for (sec)</div>
                <input type="number" min="15" max="300" style={{ ...input, width: 90 }} value={cfg.afterHours.floorWaitSec}
                  onChange={e => setIn('afterHours', { floorWaitSec: parseInt(e.target.value) || 45 })} />
              </div>
            )}
          </div>
          {cfg.afterHours.action === 'forward' && !cfg.afterHours.forwardNumber && (
            <div style={{ fontSize: 11.5, color: 'var(--tone-amber-tx)', marginTop: 8 }}>
              No on-call number set — callers will go to voicemail until one is entered.
            </div>
          )}
        </div>

        {/* Queue */}
        <div className="card" style={{ padding: 16 }}>
          {cardTitle('Queue & hold', 'What callers experience while waiting for a rep during open hours.')}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
            <div>
              <div style={lbl}>Hold music</div>
              <select style={{ ...input, minWidth: 180 }} value={cfg.queue.holdMusic} onChange={e => setIn('queue', { holdMusic: e.target.value })}>
                {[...music, 'custom'].map(m => <option key={m} value={m}>{MUSIC_LABELS[m] || m}</option>)}
              </select>
            </div>
            {cfg.queue.holdMusic === 'custom' && (
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={lbl}>MP3 URL</div>
                <input style={{ ...input, width: '100%' }} placeholder="https://…/hold.mp3" value={cfg.queue.customMusicUrl}
                  onChange={e => setIn('queue', { customMusicUrl: e.target.value })} />
              </div>
            )}
          </div>
          <div style={{ marginBottom: 10 }}>
            <div style={lbl}>Comfort message (repeats between music loops)</div>
            <input style={{ ...input, width: '100%' }} value={cfg.queue.comfortMessage}
              onChange={e => setIn('queue', { comfortMessage: e.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <div style={lbl}>If the wait gets long</div>
              <select style={{ ...input, minWidth: 230 }} value={cfg.queue.overflow.action} onChange={e => setOverflow({ action: e.target.value })}>
                <option value="hold">Keep them holding (no limit)</option>
                <option value="voicemail">Voicemail after the max wait</option>
                <option value="forward">Forward after the max wait</option>
              </select>
            </div>
            {cfg.queue.overflow.action !== 'hold' && (
              <div>
                <div style={lbl}>Max wait (sec)</div>
                <input type="number" min="30" max="1800" style={{ ...input, width: 90 }} value={cfg.queue.overflow.maxWaitSec}
                  onChange={e => setOverflow({ maxWaitSec: parseInt(e.target.value) || 180 })} />
              </div>
            )}
            {cfg.queue.overflow.action === 'forward' && (
              <div>
                <div style={lbl}>Overflow number</div>
                <input style={{ ...input, width: 170 }} placeholder="+17195551234" value={cfg.queue.overflow.forwardNumber}
                  onChange={e => setOverflow({ forwardNumber: e.target.value })} />
              </div>
            )}
          </div>
        </div>

        {/* Dispatch line */}
        {cfg.dispatchLine && (
          <div className="card" style={{ padding: 16 }}>
            {cardTitle('Dispatch line — (719) 259-2681', 'The technicians’ line. Always open, rings only workers with the Dispatch skill, voicemail after the max wait. Point the ST dispatch tracking number’s forwarding here.')}
            <div style={{ marginBottom: 10 }}>
              <div style={lbl}>Greeting</div>
              <textarea rows={2} style={{ ...input, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                value={cfg.dispatchLine.greeting} onChange={e => setIn('dispatchLine', { greeting: e.target.value })} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={lbl}>Voicemail prompt (no dispatcher answered)</div>
              <textarea rows={2} style={{ ...input, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                value={cfg.dispatchLine.voicemail} onChange={e => setIn('dispatchLine', { voicemail: e.target.value })} />
            </div>
            <div>
              <div style={lbl}>Max wait before voicemail (sec)</div>
              <input type="number" min="15" max="600" style={{ ...input, width: 90 }} value={cfg.dispatchLine.maxWaitSec}
                onChange={e => setIn('dispatchLine', { maxWaitSec: parseInt(e.target.value) || 60 })} />
            </div>
          </div>
        )}

        {/* Voicemail */}
        <div className="card" style={{ padding: 16 }}>
          {cardTitle('Voicemail', 'Voicemails land in Recordings with a transcript, and email whoever is checked below.')}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
            <div>
              <div style={lbl}>Max length (sec)</div>
              <input type="number" min="30" max="600" style={{ ...input, width: 90 }} value={cfg.voicemail.maxSec}
                onChange={e => setIn('voicemail', { maxSec: parseInt(e.target.value) || 120 })} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={cfg.voicemail.transcribe !== false}
                onChange={e => setIn('voicemail', { transcribe: e.target.checked })} />
              Auto-transcribe voicemails
            </label>
          </div>
          <div style={lbl}>Email a copy to</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {profiles.map(p => {
              const em = p.email
              const on = (cfg.voicemail.emails || []).includes(em)
              return (
                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '5px 10px', border: '1px solid var(--border)', borderRadius: 99, cursor: 'pointer', background: on ? 'var(--accent-bg)' : 'var(--surface)' }}>
                  <input type="checkbox" checked={on} onChange={e => setIn('voicemail', {
                    emails: e.target.checked ? [...(cfg.voicemail.emails || []), em] : (cfg.voicemail.emails || []).filter(x => x !== em),
                  })} />
                  {p.name || em}
                </label>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input style={{ ...input, width: 240 }} placeholder="Add another email…" value={extraEmail} onChange={e => setExtraEmail(e.target.value)} />
            <button className="btn sm" onClick={() => {
              const em = extraEmail.trim()
              if (em && !(cfg.voicemail.emails || []).includes(em)) setIn('voicemail', { emails: [...(cfg.voicemail.emails || []), em] })
              setExtraEmail('')
            }}>Add</button>
            {(cfg.voicemail.emails || []).filter(em => !profiles.some(p => p.email === em)).map(em => (
              <span key={em} style={{ fontSize: 11.5, padding: '4px 9px', border: '1px solid var(--border)', borderRadius: 99, background: 'var(--surface-2)' }}>
                {em} <span style={{ cursor: 'pointer', marginLeft: 3 }} onClick={() => setIn('voicemail', { emails: cfg.voicemail.emails.filter(x => x !== em) })}>×</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Sticky save bar */}
      <div style={{ position: 'sticky', bottom: 0, background: 'var(--surface)', borderTop: '1px solid var(--border)', padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn primary" onClick={save} disabled={saving} style={{ padding: '9px 26px', fontWeight: 700 }}>
          {saving ? 'Saving…' : 'Save call routing'}
        </button>
        {savedMsg && <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--success)' }}>{savedMsg}</span>}
        {err && <span style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</span>}
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 'auto' }}>Changes apply to the next inbound call.</span>
      </div>
    </div>
  )
}
