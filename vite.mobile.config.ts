import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const shared = resolve('src/shared')

/**
 * The phone-facing web app the daemon serves out of `out/mobile` when remote access is on
 * (`src/daemon/remote/server.ts`). Separate from `electron.vite.config.ts`, which handles main,
 * preload and renderer only — this is a plain static web build with no Electron in it.
 */
export default defineConfig({
  root: 'src/mobile',
  base: './',
  build: {
    outDir: resolve('out/mobile'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('src/mobile/index.html') }
  },
  resolve: { alias: { '@shared': shared, '@renderer': resolve('src/renderer/src') } },
  plugins: [react()],
  publicDir: resolve('src/mobile/public')
})
