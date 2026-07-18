import { DONE_OUTCOMES, MAX_ATTEMPTS, COL_MAP } from './constants'

export const isDone = (c) => DONE_OUTCOMES.includes(c.status) || c.status === 'Max Attempts'
export const isActive = (c) => !isDone(c)

export const getInitials = (name) =>
  (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

export const normPhone = (p) => (p || '').replace(/\D/g, '')

export const fmtDate = (ts) => {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export const fmtShort = (ts) => {
  if (!ts) return ''
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export const isCallbackDueToday = (c) => {
  if (!c.callback_at) return false
  const d = new Date(c.callback_at)
  const today = new Date()
  today.setHours(23, 59, 59, 999)
  return d <= today
}

export const getDupSet = (contacts) => {
  const m = {}
  contacts.forEach(c => {
    const p = normPhone(c.phone || '')
    if (!p) return
    if (!m[p]) m[p] = []
    m[p].push(c.id)
  })
  const s = new Set()
  Object.values(m).forEach(ids => { if (ids.length > 1) ids.forEach(id => s.add(id)) })
  return s
}

export const buildDNCSet = (contacts) => {
  const s = new Set()
  contacts.filter(c => c.status === 'DNC').forEach(c => {
    const p = normPhone(c.phone || '')
    if (p) s.add(p)
  })
  return s
}

// CSV parsing
export const findCol = (headers, key) => {
  const aliases = COL_MAP[key]
  const norm = headers.map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''))
  for (const a of aliases) {
    const i = norm.indexOf(a)
    if (i !== -1) return i
  }
  return -1
}

export const parseLine = (line) => {
  const r = []
  let cur = '', inQ = false
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ }
    else if (ch === ',' && !inQ) { r.push(cur.trim()); cur = '' }
    else { cur += ch }
  }
  r.push(cur.trim())
  return r
}

export const cleanPhone = (raw) => {
  if (!raw) return ''
  const phones = raw.split(/[,;]/).map(p => p.trim()).filter(Boolean)
  const unique = [...new Set(phones.map(p => normPhone(p)))].filter(p => p.length >= 7)
  if (!unique.length) return ''
  const first = phones.find(p => normPhone(p) === unique[0]) || phones[0]
  return first.trim()
}

export const exportToCSV = (rows, headers, filename) => {
  const esc = v => {
    if (v == null) return ''
    const s = String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [headers.join(','), ...rows].join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.download = filename
  a.click()
}

// Turn an uploaded image File into a small square JPEG data-URI, center-cropped
// to `size` px. Kept small (~size px, 0.8 quality → a few KB) so it lives in the
// profiles.avatar text column and ships with every profile the app loads.
export const fileToAvatarDataURL = (file, size = 128) => new Promise((resolve, reject) => {
  if (!file || !file.type?.startsWith('image/')) return reject(new Error('Please choose an image file.'))
  const reader = new FileReader()
  reader.onerror = () => reject(new Error('Could not read that file.'))
  reader.onload = () => {
    const img = new Image()
    img.onerror = () => reject(new Error("That image couldn't be loaded."))
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = size; canvas.height = size
      const ctx = canvas.getContext('2d')
      const s = Math.min(img.width, img.height)          // center-crop to a square
      const sx = (img.width - s) / 2, sy = (img.height - s) / 2
      ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size)
      resolve(canvas.toDataURL('image/jpeg', 0.8))
    }
    img.src = reader.result
  }
  reader.readAsDataURL(file)
})

// Tell TaskRouter whether this rep should receive queued calls. The inbound
// queue only routes to workers whose activity is Available, so a rep who looks
// Available in Andi but wasn't synced will silently never get a call.
// Fire-and-forget: their Andi status must still update if Twilio is down.
export const syncWorkerActivity = (profileId, status) => {
  if (!profileId) return
  fetch('/api/twilio/worker-activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, status }),
  }).catch(e => console.warn('worker activity sync failed:', e))
}

export const getTimeframeBounds = (tf) => {
  const now = new Date()
  const s0 = d => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  switch (tf) {
    case 'today': return { start: s0(now), end: now, label: 'Today' }
    case 'yesterday': { const y = new Date(now); y.setDate(y.getDate() - 1); return { start: s0(y), end: s0(now), label: 'Yesterday' } }
    case 'week': { const day = now.getDay(); const m = new Date(now); m.setDate(now.getDate() - (day === 0 ? 6 : day - 1)); return { start: s0(m), end: now, label: 'This week' } }
    case 'month': return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now, label: 'This month' }
    case '90days': { const s = new Date(now); s.setDate(s.getDate() - 90); return { start: s, end: now, label: 'Last 90 days' } }
    case 'ytd': return { start: new Date(now.getFullYear(), 0, 1), end: now, label: 'YTD' }
    default: return { start: new Date(0), end: now, label: 'All time' }
  }
}
