import { useState, useEffect } from 'react'

// Shared breakpoint: below 768px the shell swaps the sidebar for a drawer and
// pages loosen their grids. matchMedia so rotation/resize update live.
export function useIsMobile() {
  const [m, setM] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const on = (e) => setM(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return m
}
