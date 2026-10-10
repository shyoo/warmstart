/** One request at a time; changes during it get one follow-up using the latest selection. */
export function latestRequest() {
  let selected = ''
  let revision = 0
  let running = false
  let next: (() => Promise<void>) | null = null
  return {
    select(key: string) {
      if (selected !== key) { selected = key; revision++ }
    },
    async run(key: string, work: (current: () => boolean) => Promise<void>): Promise<void> {
      const invoke = async (): Promise<void> => {
        running = true
        const started = revision
        try { await work(() => selected === key && revision === started) }
        finally {
          running = false
          const followUp = next
          next = null
          if (followUp) await followUp()
        }
      }
      if (running) { next = invoke; return }
      await invoke()
    }
  }
}
