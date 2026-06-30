import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Go backend (Brivo Lumina). Both the JSON API and the generated image
      // files are proxied so the browser sees one origin in dev.
      '/api': { target: 'http://localhost:8090', changeOrigin: true },
      '/files': { target: 'http://localhost:8090', changeOrigin: true },
    },
  },
})
