import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    // Ports can be changed so a second copy (e.g. a test preview) can run next to the main one.
    port: Number(process.env.HARNESS_WEB_PORT ?? 5173),
    strictPort: true,
    // In dev, the UI calls /api/... and Vite forwards it to the Node server.
    proxy: { '/api': `http://localhost:${process.env.HARNESS_SERVER_PORT ?? 8787}` },
  },
})
