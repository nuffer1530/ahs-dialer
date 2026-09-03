import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { toast } from '../lib/dialogs'
import Avatar from './Avatar'

// Per-CSR monthly scorecards — view, thresholds, manual notes. Lives on the
// Team page (extracted from AdminPage Aug 2026). Weights/thresholds still
// persist to app_settings, same keys as always.
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

export default function ScorecardsPanel() {
  const { profile } = useAuth()
  const _now = new Date()
  const [profiles, setProfiles] = useState([])
  useEffect(() => {
    sb.from('profiles').select('id, name, email, avatar, role').eq('active', true).order('name')
      .then(({ data }) => setProfiles(data || []))
  }, [])
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
    4: { bg:'var(--tone-green-bg)', text:'var(--tone-green-tx)', border:'var(--tone-green-bd)' },
    3: { bg:'var(--tone-green-bg)', text:'var(--tone-green-tx)', border:'var(--tone-green-bd)' },
    2: { bg:'var(--tone-amber-bg)', text:'var(--tone-amber-tx)', border:'var(--tone-amber-bd)' },
    1: { bg:'var(--tone-red-bg)', text:'var(--tone-red-tx)', border:'var(--tone-red-bd)' },
  }

  // Load scorecard data when profile/month changes
  useEffect(() => {
    if (!scSelectedProfile) return
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
  }, [scSelectedProfile, scMonth])

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
        updated_by: profile?.id || null,
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
      toast('Error saving: ' + saveError.message)
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


  return (
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
                            <div key={key} style={{ padding:'8px', background: isMyRating ? cs.bg : 'transparent',
                              boxShadow: isMyRating ? `inset 0 0 0 1.5px ${cs.border}` : 'none',
                              borderLeft:'1px solid var(--border)', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:4 }}>
                              <div style={{ fontSize:9, fontWeight:700, textTransform:'uppercase', letterSpacing:.4, color: isMyRating ? cs.text : 'var(--text-muted)' }}>{label}</div>
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
                            <div style={{ padding:'8px', background: isMyRating ? cs.bg : 'transparent',
                              boxShadow: isMyRating ? `inset 0 0 0 1.5px ${cs.border}` : 'none',
                              borderLeft:'1px solid var(--border)', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:4 }}>
                              <div style={{ fontSize:9, fontWeight:700, textTransform:'uppercase', letterSpacing:.4, color: isMyRating ? cs.text : 'var(--text-muted)' }}>Poor</div>
                              <div style={{ fontSize:12, fontWeight: isMyRating ? 700 : 500, color: isMyRating ? cs.text : 'var(--text-secondary)' }}>{poorVal}</div>
                              <div style={{ fontSize:9, color: 'var(--text-muted)' }}>auto</div>
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
  )
}
