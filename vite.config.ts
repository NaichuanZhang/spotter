import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The token route runs in server/index.mjs during dev too, so the browser
    // never needs the real Boson key.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    // Big local assets (mediapipe .task, wasm, avatar mp4s) live in public/ and
    // are copied verbatim — never inlined.
    assetsInlineLimit: 0,
    outDir: 'dist',
  },
})
