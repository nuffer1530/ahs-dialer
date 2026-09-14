// Admins (Brandyn, Deanna, Brittany…) make test calls, cover phones in a
// pinch, and try things — their calls are not CSR performance. Every booking
// % and every call-QA path excludes them: telecom calls whose agent is an
// admin's ServiceTitan user, and evals whose rep is an admin's name.
const norm = (s) => String(s || '').trim().toLowerCase()

export async function loadAdminAgents(supabase) {
  const empty = { profileIds: new Set(), stUserIds: new Set(), names: new Set() }
  try {
    const [{ data: profs }, { data: maps }] = await Promise.all([
      supabase.from('profiles').select('id, name, email').eq('role', 'admin'),
      supabase.from('csr_st_users').select('profile_id, st_user_id, st_user_name'),
    ])
    for (const p of (profs || [])) {
      empty.profileIds.add(p.id)
      if (p.name) empty.names.add(norm(p.name))
      if (p.email) { empty.names.add(norm(p.email)); empty.names.add(norm(p.email.split('@')[0])) }
    }
    for (const m of (maps || [])) {
      if (!empty.profileIds.has(m.profile_id)) continue
      empty.stUserIds.add(String(m.st_user_id))
      if (m.st_user_name) empty.names.add(norm(m.st_user_name))
    }
  } catch (e) { console.warn('admin agents:', e.message) }
  const a = empty
  return {
    ...a,
    isAdminProfile: (id) => Boolean(id) && a.profileIds.has(id),
    isAdminName: (n) => Boolean(n) && a.names.has(norm(n)),
    isAdminStUser: (id) => id != null && a.stUserIds.has(String(id)),
    // A ServiceTitan telecom call (or its leadCall) taken by an admin.
    isAdminCall: (c) => {
      const lc = c?.leadCall || c || {}
      const ag = lc.agent || {}, cb = lc.createdBy || {}
      return a.stUserIds.has(String(ag.id ?? '')) || a.stUserIds.has(String(cb.id ?? '')) || a.names.has(norm(ag.name)) || a.names.has(norm(cb.name))
    },
  }
}
