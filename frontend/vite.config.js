import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: command === 'serve' ? [react()] : [],
  css: {
    postcss: {
      plugins: [
        tailwindcss(),
        autoprefixer()
      ]
    }
  },
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
}))
