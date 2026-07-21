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
