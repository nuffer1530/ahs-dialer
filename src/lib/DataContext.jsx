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

  // Real-time subscription
  const subscribeRealtime = useCallback(() => {
    if (channelRef.current) sb.removeChannel(channelRef.current)
    channelRef.current = sb.channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, payload => {
        if (payload.eventType === 'INSERT') {
          setContacts(prev => [...prev, payload.new])
        } else if (payload.eventType === 'UPDATE') {
          setContacts(prev => prev.map(c => c.id === payload.new.id ? payload.new : c))
        } else if (payload.eventType === 'DELETE') {
          setContacts(prev => prev.filter(c => c.id !== payload.old.id))
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns' }, payload => {
        if (payload.eventType === 'INSERT') {
          setCampaigns(prev => [...prev, payload.new])
        } else if (payload.eventType === 'UPDATE') {
          setCampaigns(prev => prev.map(c => c.id === payload.new.id ? payload.new : c))
        } else if (payload.eventType === 'DELETE') {
          setCampaigns(prev => prev.filter(c => c.id !== payload.old.id))
        }
      })
      .subscribe()
  }, [])

  useEffect(() => {
    loadAll()
    subscribeRealtime()
    return () => { if (channelRef.current) sb.removeChannel(channelRef.current) }
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
