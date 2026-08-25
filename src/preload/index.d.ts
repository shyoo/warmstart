import type { AgentyardApi } from '@shared/ipc'

declare global {
  interface Window {
    agentyard: AgentyardApi
  }
}

export {}
