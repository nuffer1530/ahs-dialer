// Real drive time between job locations, with a permanent cache.
//
// WHY THE CACHE IS NOT OPTIONAL: the Live Board refreshes every 15 minutes (96
// times a day). Asking a matrix API for every pair each time would be ~150k
// billable lookups a day. Road distance between two fixed points doesn't
// change, so each pair is fetched once and reused forever — steady-state cost
// is only the genuinely new pairs, i.e. new addresses.
//
// DEGRADES CLEANLY: with no token configured every call returns null and the
// caller falls back to straight-line distance. Nothing breaks, the feature just
// gets less precise — so this can ship before anyone buys anything.
//
// Provider: Mapbox Matrix API. One request covers up to 25 coordinates
// (a 25x25 matrix), which is the whole reason it's affordable here.

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || process.env.MAPS_API_KEY || ''
export const driveTimeEnabled = () => Boolean(MAPBOX_TOKEN)

// ~11m precision. Two calls at the same house must produce the same key or the
// cache never hits.
const r5 = (n) => Number(n).toFixed(4)
const keyOf = (a, b) => {
  const p1 = `${r5(a.lat)},${r5(a.lng)}`
  const p2 = `${r5(b.lat)},${r5(b.lng)}`
  return p1 <= p2 ? `${p1}|${p2}` : `${p2}|${p1}`   // symmetric: A→B == B→A
}

const HAVERSINE_MI = (a, b) => {
  const R = 3958.8, rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * Drive time for a list of {from, to} pairs.
 * Returns Map(pairKey -> { minutes, miles, provider }).
 * Unresolvable pairs are simply absent — callers must handle that.
 */
export async function driveTimes(pairs, supabase) {
  const out = new Map()
  if (!pairs.length) return out

  const wanted = new Map()
  for (const p of pairs) {
    if (!p?.from?.lat || !p?.to?.lat) continue
    wanted.set(keyOf(p.from, p.to), p)
  }
  if (!wanted.size) return out

  // 1) cache
  try {
    const keys = [...wanted.keys()]
    for (let i = 0; i < keys.length; i += 200) {
      const { data } = await supabase.from('drive_time_cache')
        .select('pair_key, minutes, miles, provider').in('pair_key', keys.slice(i, i + 200))
      for (const row of (data || [])) {
        out.set(row.pair_key, { minutes: Number(row.minutes), miles: Number(row.miles), provider: row.provider })
      }
    }
  } catch (e) { console.warn('drive cache read failed:', e.message) }

  const missing = [...wanted.entries()].filter(([k]) => !out.has(k))
  if (!missing.length || !MAPBOX_TOKEN) return out

  // 2) fetch the misses. Mapbox takes up to 25 coordinates per request, so
  //    build small coordinate sets and read the cells we need out of the matrix.
  const CHUNK = 12   // 12 pairs -> <=24 coords, safely inside the limit
  for (let i = 0; i < missing.length; i += CHUNK) {
    const batch = missing.slice(i, i + CHUNK)
    const coords = []
    const idx = []
    for (const [, p] of batch) {
      idx.push([coords.length, coords.length + 1])
      coords.push([p.from.lng, p.from.lat], [p.to.lng, p.to.lat])
    }
    const path = coords.map(c => `${c[0]},${c[1]}`).join(';')
    const url = `https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${path}` +
      `?annotations=duration,distance&access_token=${encodeURIComponent(MAPBOX_TOKEN)}`
    try {
      const res = await fetch(url)
      if (!res.ok) { console.warn('mapbox matrix', res.status, (await res.text()).slice(0, 160)); continue }
      const data = await res.json()
      const dur = data?.durations, dist = data?.distances
      if (!Array.isArray(dur)) continue
      const rows = []
      batch.forEach(([k], n) => {
        const [a, b] = idx[n]
        const seconds = dur?.[a]?.[b]
        const meters = dist?.[a]?.[b]
        if (seconds == null) return
        const val = {
          minutes: Math.round((seconds / 60) * 10) / 10,
          miles: meters == null ? null : Math.round((meters / 1609.34) * 10) / 10,
          provider: 'mapbox',
        }
        out.set(k, val)
        rows.push({ pair_key: k, minutes: val.minutes, miles: val.miles, provider: 'mapbox' })
      })
      if (rows.length) {
        try { await supabase.from('drive_time_cache').upsert(rows, { onConflict: 'pair_key' }) }
        catch (e) { console.warn('drive cache write failed:', e.message) }
      }
    } catch (e) {
      console.warn('mapbox matrix request failed:', e.message)
    }
  }
  return out
}

// Straight-line fallback so callers have one shape to handle either way.
export function straightLine(a, b) {
  if (!a?.lat || !b?.lat) return null
  const miles = HAVERSINE_MI(a, b)
  return { minutes: null, miles: Math.round(miles * 10) / 10, provider: 'straight-line' }
}

export const pairKey = keyOf
