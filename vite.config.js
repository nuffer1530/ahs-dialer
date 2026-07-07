import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
  preview: {
    port: parseInt(process.env.PORT) || 8080,
    host: '0.0.0.0',
    allowedHosts: ['ahs-dialer-production.up.railway.app', 'andi.awesomeservice.com']
  }
})
