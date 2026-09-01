import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        // Two Node entry points. orchestratord is a separate long-lived process, launched with
        // ELECTRON_RUN_AS_NODE so a packaged build needs no system Node - and so its native modules
        // match the ABI the app already ships.
        input: {
          index: resolve('src/main/index.ts'),
          orchestratord: resolve('src/daemon/index.ts'),
          // Spawned by the agent CLI, not by us - it is the target of --permission-prompt-tool.
          'agentyard-mcp': resolve('src/mcp/index.ts'),
          // Spawned by the local-llm adapter to bridge to OpenAI-compatible HTTP endpoints.
          'local-llm-bridge': resolve('src/daemon/adapters/local-llm-bridge.ts')
        },
        output: { entryFileNames: '[name].js' }
      }
    }
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
