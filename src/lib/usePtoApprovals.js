import { useEffect, useState } from 'react'
import { sb } from './supabase'

// Pending PTO/sick requests waiting on ME (as manager). Drives the red badge
// on the My Page nav item — same pattern as the dialer's paid-leads badge.
export function usePtoApprovals(profileId) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!profileId) { setCount(0); return }
    let stopped = false
    const load = async () => {
      const { count: n } = await sb.from('pto_requests')
        .select('id', { count: 'exact', head: true })
        .eq('manager_id', profileId).eq('status', 'pending')
      if (!stopped) setCount(n || 0)
    }
    load()
    const ch = sb.channel(`pto_badge_${profileId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pto_requests' }, load)
      .subscribe()
    return () => { stopped = true; sb.removeChannel(ch) }
  }, [profileId])

  return count
}
