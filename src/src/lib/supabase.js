import { createClient } from '@supabase/supabase-js'

// Hardcoded fallback for Railway deployment
const SUPA_URL = import.meta.env.VITE_SUPABASE_URL || 'https://zadiisjngiuwuxggmyqu.supabase.co'
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InphZGlpc2puZ2l1d3V4Z2dteXF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMDU3MjMsImV4cCI6MjA5ODU4MTcyM30.MSkXOgj9g07ZT4hA0TBsYGxCKz0z_DDTLU4O3Nxh-Gc'

export const sb = createClient(SUPA_URL, SUPA_KEY, {
  realtime: { params: { eventsPerSecond: 10 } }
})
