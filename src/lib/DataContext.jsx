import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { sb } from './supabase'
import { buildDNCSet } from './utils'

const DataContext = createContext(null)

export function DataProvider({ children }) {
  const [contacts, setContacts] = useState([])
  const [campaigns, setCampaigns] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncStatus, setSyncStatus] = useState('loading')
  const channelRef = useRef(null)

  const loadAll = useCallback(async () => {
    setSyncStatus('loading')
    try {
      const [{ data: camps }, contacts_batch] = await Promise.all([
        sb.from('campaigns').select('*').order('created_at'),
        loadAllContacts()
      ])
      setCampaigns(camps || [])
      setContacts(contacts_batch)
      setSyncStatus('ok')
    } catch (e) {
      console.error(e)
      setSyncStatus('error')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadAllContacts = async () => {
    let all = [], from = 0, done = false
    while (!done) {
      const { data, error } = await sb.from('contacts').select('*').order('created_at').range(from, from + 999)
      if (error) throw error
      if (!data || data.length === 0) { done = true }
      else { all.push(...data); if (data.length < 1000) done = true; else from += 1000 }
    }
    return all
  }

  // Real-time subscription.
  //
  // Changes are queued and applied in one render per ~250ms: a CSV import or
  // an AI campaign lands hundreds of contact rows at once, and a render per
  // row froze every open dialer. INSERTs merge by id — pages often add the
  // row they just created themselves before the event arrives.
  const queueRef = useRef({ contacts: [], campaigns: [], timer: null })
  const applyChanges = (prev, changes) => {
    if (!changes.length) return prev
    const byId = new Map(prev.map(r => [r.id, r]))
    for (const p of changes) {
      if (p.eventType === 'DELETE') byId.delete(p.old?.id)
      else if (p.new?.id) byId.set(p.new.id, p.new)
    }
    return [...byId.values()]
  }
  const flush = useCallback(() => {
    const q = queueRef.current
    q.timer = null
    const cs = q.contacts, ps = q.campaigns
    q.contacts = []; q.campaigns = []
    if (cs.length) setContacts(prev => applyChanges(prev, cs))
    if (ps.length) setCampaigns(prev => applyChanges(prev, ps))
  }, [])
  const enqueue = useCallback((kind, payload) => {
    const q = queueRef.current
    q[kind].push(payload)
    if (!q.timer) q.timer = setTimeout(flush, 250)
  }, [flush])

  const subscribeRealtime = useCallback(() => {
    if (channelRef.current) sb.removeChannel(channelRef.current)
    channelRef.current = sb.channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, payload => enqueue('contacts', payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns' }, payload => enqueue('campaigns', payload))
      .subscribe()
  }, [enqueue])

  useEffect(() => {
    loadAll()
    subscribeRealtime()
    return () => {
      if (channelRef.current) sb.removeChannel(channelRef.current)
      clearTimeout(queueRef.current.timer)
    }
  }, [loadAll, subscribeRealtime])

  const dncSet = buildDNCSet(contacts)
  const campName = (c) => campaigns.find(x => x.id === c.campaign_id)?.name || ''

  return (
    <DataContext.Provider value={{
      contacts, setContacts, campaigns, setCampaigns,
      loading, syncStatus, dncSet, campName, reload: loadAll
    }}>
      {children}
    </DataContext.Provider>
  )
}

export const useData = () => useContext(DataContext)
