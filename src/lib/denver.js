// Company clock. Wall TVs (Fire TV sticks running Fully Kiosk) don't always
// carry the right timezone — one showed 1:46 PM at 7:46 AM because the stick
// was on UTC — so anything a board displays or windows by "today" is formatted
// in America/Denver explicitly, never in the device's local zone.
export const DENVER = 'America/Denver'
export const fmtTime = (d, opts = {}) => new Date(d).toLocaleTimeString('en-US', { timeZone: DENVER, ...opts })
export const fmtDate = (d, opts = {}) => new Date(d).toLocaleDateString('en-US', { timeZone: DENVER, ...opts })

const parts = (d) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: DENVER, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d)
  const get = (t) => Number(p.find(x => x.type === t)?.value || 0)
  return { hour: get('hour') % 24, minute: get('minute'), second: get('second') }
}
// Midnight Denver today, as an absolute Date.
export function denverStartOfToday(now = new Date()) {
  const { hour, minute, second } = parts(now)
  return new Date(now.getTime() - ((hour * 3600 + minute * 60 + second) * 1000 + now.getMilliseconds()))
}
// Next occurrence of HH:MM:SS Denver, as an absolute Date (tomorrow if already past).
export function denverNext(hour, minute = 0, second = 0, now = new Date()) {
  const start = denverStartOfToday(now)
  let t = new Date(start.getTime() + (hour * 3600 + minute * 60 + second) * 1000)
  if (t <= now) t = new Date(t.getTime() + 24 * 3600_000)
  return t
}
