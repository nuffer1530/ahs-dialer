import { useEffect, useState } from 'react'

// Weather across the top of every page (and the Call Center TV in dark mode).
// Three cities, the active NWS alert if any, and the demand-signal chip —
// hot days are no-cool calls, cold snaps are no-heats. Data comes from
// /api/weather (server-cached 15 min); we re-poll on the same cadence.
const ICONS = { sun: '☀️', partcloud: '⛅', cloud: '☁️', rain: '🌧️', snow: '❄️', storm: '⛈️', fog: '🌫️' }

export default function WeatherStrip({ dark }) {
  const [wx, setWx] = useState(null)
  useEffect(() => {
    let dead = false
    const load = () => fetch('/api/weather')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!dead && d?.cities?.length) setWx(d) })
      .catch(() => {})
    load()
    const t = setInterval(load, 15 * 60_000)
    return () => { dead = true; clearInterval(t) }
  }, [])
  if (!wx) return null

  const mut = dark ? 'rgba(255,255,255,.55)' : 'var(--text-muted)'
  const fg = dark ? '#fff' : 'var(--text-primary)'
  const div = dark ? 'rgba(255,255,255,.15)' : 'var(--border)'

  return (
    <div style={{ display:'flex', alignItems:'center', gap:12, overflow:'hidden', whiteSpace:'nowrap' }}>
      {wx.cities.map((c, i) => (
        <div key={c.key} style={{ display:'flex', alignItems:'center', gap:12 }}>
          {i > 0 && <div style={{ width:1, height:16, background:div, flexShrink:0 }} />}
          <span title={`${c.name} — ${c.short}`} style={{ display:'flex', alignItems:'center', gap:5, fontSize:12 }}>
            <span style={{ fontSize:13 }}>{ICONS[c.icon] || '☀️'}</span>
            <span style={{ color:mut }}>{c.key}</span>
            <span style={{ fontWeight:700, color:fg, fontVariantNumeric:'tabular-nums' }}>{c.temp != null ? `${c.temp}°` : '—'}</span>
            {c.high != null && <span style={{ fontSize:10, color:mut }}>{c.high}° hi</span>}
          </span>
        </div>
      ))}
      {wx.alert && (
        <span style={{ display:'flex', alignItems:'center', gap:4, background:'rgba(239,159,39,.12)', border:'1px solid #EF9F27', borderRadius:99, padding:'2px 9px', fontSize:10.5, fontWeight:700, color: dark ? '#FAC775' : '#854F0B', flexShrink:0 }}>
          ⚠️ {wx.alert.event}{wx.alert.until ? ` til ${wx.alert.until}` : ''}
        </span>
      )}
      {wx.signal && (
        <span style={{ display:'flex', alignItems:'center', gap:4, background:'rgba(127,119,221,.12)', border:'1px solid #7F77DD', borderRadius:99, padding:'2px 9px', fontSize:10.5, fontWeight:700, color: dark ? '#CECBF6' : '#3C3489', flexShrink:0 }}>
          📈 {wx.signal.text}
        </span>
      )}
    </div>
  )
}
