import { useEffect, useState } from 'react'
import { sb } from './supabase'

// Everything waiting on ME for the My Page red badge: PTO requests I manage,
// shift swaps addressed to me as the co-worker, and (manager/admin) swaps
// awaiting the final sign-off. Same pattern as the dialer's paid-leads badge.
export function usePtoApprovals(profileId, isAdmin = false) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!profileId) { setCount(0); return }
    let stopped = false
    const load = async () => {
      const [pto, peer, mgr] = await Promise.all([
        sb.from('pto_requests').select('id', { count: 'exact', head: true })
          .eq('manager_id', profileId).eq('status', 'pending'),
        sb.from('shift_swaps').select('id', { count: 'exact', head: true })
          .eq('target_id', profileId).eq('status', 'pending_peer'),
        isAdmin
          ? sb.from('shift_swaps').select('id', { count: 'exact', head: true }).eq('status', 'pending_manager')
          : sb.from('shift_swaps').select('id', { count: 'exact', head: true })
              .eq('manager_id', profileId).eq('status', 'pending_manager'),
      ])
      if (!stopped) setCount((pto.count || 0) + (peer.count || 0) + (mgr.count || 0))
    }
    load()
    const ch = sb.channel(`pto_badge_${profileId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pto_requests' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shift_swaps' }, load)
      .subscribe()
    return () => { stopped = true; sb.removeChannel(ch) }
  }, [profileId, isAdmin])

  return count
}
