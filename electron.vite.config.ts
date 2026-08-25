import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    // A sandboxed preload must be CommonJS - Electron does not support ESM there, and with
    // "type": "module" in package.json the extension has to be .cjs to be read as CJS.
    // Dropping `sandbox: true` would also "fix" this and is not worth it.
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
    resolve: { alias: { '@shared': shared, '@renderer': resolve('src/renderer/src') } },
    plugins: [react()]
  }
})
