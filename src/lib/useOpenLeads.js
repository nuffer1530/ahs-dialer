import { useEffect, useState } from 'react'
import { sb } from './supabase'

// Count of paid leads still waiting to be worked. Used by the Dialer nav badge
// and by the rail's collapse toggle, so both read from one definition — a badge
// that disagrees with the rail would train reps to ignore it.
//
// Realtime-driven: the count drops the moment a rep claims a lead, and also
// when a booking is dismissed or converted inside ServiceTitan (the server
// poller resolves those rows).
export function useOpenLeads() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let stopped = false
    const load = async () => {
      const { count: n } = await sb.from('st_leads')
        .select('id', { count: 'exact', head: true }).is('resolved_at', null)
      if (!stopped) setCount(n || 0)
    }
    load()
    const ch = sb.channel(`open_leads_${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'st_leads' }, load)
      .subscribe()
    return () => { stopped = true; sb.removeChannel(ch) }
  }, [])

  return count
}
