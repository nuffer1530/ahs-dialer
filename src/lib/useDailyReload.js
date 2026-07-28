import { useEffect } from 'react'

// Wallboards run 24/7 and never reload on their own — which means they run
// stale code forever (nobody clicks the update banner on a TV) and can carry
// stale mount-time state across midnight. This reloads the page once a day in
// the quiet hours (4:00-4:10 AM local, staggered so multiple TVs don't stampede),
// picking up the new day AND the latest deploy.
export function useDailyReload(hour = 4) {
  useEffect(() => {
    const now = new Date()
    const next = new Date(now)
    next.setHours(hour, Math.floor(Math.random() * 10), Math.floor(Math.random() * 60), 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    const t = setTimeout(() => window.location.reload(), next - now)
    return () => clearTimeout(t)
  }, [hour])
}
