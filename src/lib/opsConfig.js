import { useEffect, useState } from 'react'
import { sb } from './supabase'
import { setServiceLevelConfig } from './analytics'
import { setMaxAttempts } from './constants'

// Admin-tunable operations thresholds, stored in app_settings so changing a
// target never needs a deploy. Defaults mirror what was hardcoded for months.
export const OPS_DEFAULTS = {
  serviceLevelSeconds: 30,   // answered within N seconds counts toward SL
  serviceLevelTarget: 90,    // % target
  abandonGraceSeconds: 10,   // hangups faster than this aren't abandons
  wrapUpSeconds: 60,         // wrap-up before auto-Available
  maxAttempts: 3,            // dial attempts before Max Attempts
}
export const ATTENDANCE_DEFAULTS = {
  points: { late: 0.5, absence: 1.0, early_departure: 0.5, no_call: 1.0 },
  adherenceGood: 90,         // >= green
  adherenceWarn: 75,         // >= amber, below = red
  pointsWarn: 3,             // attendance points: >= amber
  pointsCritical: 6,         // >= red
}

let _cache = null
let _at = 0

export async function loadOpsConfig(force) {
  if (!force && _cache && Date.now() - _at < 60_000) return _cache
  let ops = { ...OPS_DEFAULTS }
  let attendance = { ...ATTENDANCE_DEFAULTS, points: { ...ATTENDANCE_DEFAULTS.points } }
  try {
    const { data } = await sb.from('app_settings').select('key, value')
      .in('key', ['ops_config', 'attendance_config'])
    const parse = (k) => { try { return JSON.parse(data?.find(r => r.key === k)?.value || 'null') } catch { return null } }
    const o = parse('ops_config') || {}
    const a = parse('attendance_config') || {}
    ops = { ...ops, ...o }
    attendance = { ...attendance, ...a, points: { ...attendance.points, ...(a.points || {}) } }
  } catch { /* defaults hold */ }
  // Push into the live bindings that analytics + the dialer read directly.
  setServiceLevelConfig({ seconds: ops.serviceLevelSeconds, target: ops.serviceLevelTarget })
  setMaxAttempts(ops.maxAttempts)
  _cache = { ops, attendance }
  _at = Date.now()
  return _cache
}

export const invalidateOpsConfig = () => { _at = 0 }

export function useOpsConfig() {
  const [cfg, setCfg] = useState(_cache || { ops: OPS_DEFAULTS, attendance: ATTENDANCE_DEFAULTS })
  useEffect(() => {
    let ok = true
    loadOpsConfig().then(c => { if (ok) setCfg(c) })
    return () => { ok = false }
  }, [])
  return cfg
}
