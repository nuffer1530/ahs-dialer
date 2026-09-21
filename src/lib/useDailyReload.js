import { denverNext } from './denver'
import { useEffect, useState, useCallback } from 'react'

// Wallboards (department TVs, Call Center TV, Call Board) run 24/7 and nobody
// is ever supposed to touch them. Two things used to break that:
//  - the app's "Andi was updated — reload" banner appeared on the TV, and the
//    4 AM reload dropped the page out of fullscreen, so someone had to walk
//    over and click the fullscreen button again;
//  - a new deploy sat unused until that click.
// Now the "wall look" (no tabs, no nav, TV sizing) is a remembered preference
// on the device, not a browser fullscreen state, so a reload comes back
// looking identical — and the page reloads itself quietly whenever the server
// reports a new build, plus once a night for hygiene.

const KIOSK_KEY = 'andi_wall_kiosk'
export const WALL_ROUTE = /^\/(tv\/|warroom$|callboard$)/

const readPref = () => {
  try {
    const q = new URLSearchParams(window.location.search).get('kiosk')
    if (q === '1') { localStorage.setItem(KIOSK_KEY, '1'); return true }
    if (q === '0') { localStorage.removeItem(KIOSK_KEY); return false }
    const v = localStorage.getItem(KIOSK_KEY)
    if (v === '1') return true
    if (v === '0') return false
  } catch {}
  // TV browsers (Fire TV Silk, Fully Kiosk's WebView) default to the wall look.
  return /\bSilk\b|\bAFT[A-Z0-9]+\b|; wv\)/.test(navigator.userAgent || '')
}
const writePref = (on) => { try { localStorage.setItem(KIOSK_KEY, on ? '1' : '0') } catch {} }

// True when a wall route should render without app chrome — the layout reads
// this so the Call Board can drop the nav without the browser's fullscreen.
export function isWallKiosk(pathname) {
  return WALL_ROUTE.test(pathname || '') && readPref()
}
export function useWallKiosk(pathname) {
  const [on, setOn] = useState(() => isWallKiosk(pathname))
  useEffect(() => {
    setOn(isWallKiosk(pathname))
    const h = () => setOn(isWallKiosk(pathname))
    window.addEventListener('andi:wall-kiosk', h)
    return () => window.removeEventListener('andi:wall-kiosk', h)
  }, [pathname])
  return on
}

let _buildId = null
async function fetchBuildId() {
  const r = await fetch('/api/build', { cache: 'no-store' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json()
  return j?.id || null
}

export function useWallboard(rootRef, { reloadHour = 4 } = {}) {
  const [fsActive, setFsActive] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement)
  const [kiosk, setKiosk] = useState(readPref)
  const isFull = fsActive || kiosk

  useEffect(() => {
    const onFs = () => setFsActive(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const toggleFull = useCallback(() => {
    if (isFull) {
      writePref(false); setKiosk(false)
      if (document.fullscreenElement) document.exitFullscreen?.()
    } else {
      writePref(true); setKiosk(true)
      try { rootRef?.current?.requestFullscreen?.() } catch {}
    }
    window.dispatchEvent(new Event('andi:wall-kiosk'))
  }, [isFull, rootRef])

  // Silent updates: when the server's build id changes, reload — the wall
  // look is remembered, so the screen comes back exactly as it was.
  useEffect(() => {
    let stopped = false
    const check = async () => {
      try {
        const id = await fetchBuildId()
        if (stopped || !id) return
        if (_buildId === null) _buildId = id
        else if (id !== _buildId) window.location.reload()
      } catch {}
    }
    check()
    const t = setInterval(check, 2 * 60_000)
    return () => { stopped = true; clearInterval(t) }
  }, [])

  // Nightly hygiene reload in the quiet hours (staggered so several TVs
  // don't hit the server at once). Looks identical afterwards.
  useEffect(() => {
    const now = new Date()
    // Denver clock, not the stick's — a Fire TV left on UTC would reload at 10 PM.
    const next = denverNext(reloadHour, Math.floor(Math.random() * 10), Math.floor(Math.random() * 60), now)
    const t = setTimeout(() => window.location.reload(), next - now)
    return () => clearTimeout(t)
  }, [reloadHour])

  return { isFull, toggleFull, kiosk }
}

// Kept for any caller that only wants the nightly reload.
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
