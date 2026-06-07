import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_TARGET || 'http://127.0.0.1:5050',
        changeOrigin: true
      },
      '/uploads': {
        target: process.env.VITE_BACKEND_TARGET || 'http://127.0.0.1:5050',
        changeOrigin: true
      }
    }
  }
})
