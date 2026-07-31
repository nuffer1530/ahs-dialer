import { createContext, useContext, useEffect, useState } from 'react'
import { sb } from './supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    sb.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchProfile(session.user.id)
      else setLoading(false)
    })
    const { data: { subscription } } = sb.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchProfile(session.user.id)
      else { setProfile(null); setLoading(false) }
    })
    return () => subscription.unsubscribe()
  }, [])

  // Keep OUR OWN profile row live. The status pill, queue toggles, and admin
  // skill grants all write profiles — without this, useAuth().profile.status
  // stays frozen at its login-time value, which silently disabled the
  // auto-serve gate ("I'm Available but the dialer is blank").
  useEffect(() => {
    if (!user?.id) return
    const ch = sb.channel(`own-profile-${user.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${user.id}` },
        (payload) => setProfile(prev => ({ ...(prev || {}), ...payload.new })))
      .subscribe()
    // Realtime websockets die silently on long-lived tabs — poll as a floor.
    const t = setInterval(() => fetchProfile(user.id), 60_000)
    return () => { sb.removeChannel(ch); clearInterval(t) }
  }, [user?.id])

  const fetchProfile = async (userId) => {
    const { data } = await sb.from('profiles').select('*').eq('id', userId).single()

    // A removed user is banned in Supabase auth, but any access token issued
    // before removal stays valid until it expires — so shut the door here too.
    if (data?.active === false) {
      await sb.auth.signOut()
      setUser(null)
      setProfile(null)
      setLoading(false)
      return
    }

    setProfile(data)
    setLoading(false)
  }

  const isAdmin = profile?.role === 'admin'
  const isDispatcher = profile?.role === 'dispatcher'

  return (
    <AuthContext.Provider value={{ user, profile, loading, isAdmin, isDispatcher, refreshProfile: () => fetchProfile(user?.id) }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
