import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import config from '../config/index.js'

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${config.port}`,
      '/ws': {
        target: `ws://localhost:${config.port}`,
        ws: true
      },
      '/uploads': `http://localhost:${config.port}`
    }
  },
  build: {
    outDir: path.resolve(__dirname, '..', 'dist'),
    emptyOutDir: true
  }
})
