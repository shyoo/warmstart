import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FleetEntry } from '../lib/daemon'
import { readFleetDensity } from '../lib/prefs'
import { FleetStrip } from './FleetStrip'

vi.mock('../lib/prefs', async (original) => ({
  ...await original<typeof import('../lib/prefs')>(),
  readFleetDensity: vi.fn(() => 'wide')
}))

describe('fleet quota rows', () => {
  it.each(['wide', 'narrow', 'single'] as const)('keeps the Argon weekly gauge in %s density', (density) => {
    vi.mocked(readFleetDensity).mockReturnValue(density)
    const labels = ['Gemini 5h', 'Gemini 7d', 'Argon 4 7d', 'Claude/GPT 5h', 'Claude/GPT 7d']
    const now = Date.UTC(2026, 9, 24)
    const entry: FleetEntry = {
      worker: {
        id: 'agy', label: 'Antigravity', adapterId: 'antigravity-cli',
        enabled: true, maxConcurrent: 1
      } as FleetEntry['worker'],
      sessions: [],
      quota: {
        workerId: 'agy', sampledAt: now, ageMs: 0, stale: false, source: 'cli',
        windows: labels.map((label, i) => ({
          id: String(i), label, group: ['gemini', 'gemini', 'argon', 'claude', 'claude'][i],
          percent: 10 + i, resetsAt: now + 86_400_000
        }))
      }
    }
    const html = renderToStaticMarkup(<FleetStrip fleet={[entry]} now={now} onProbe={async () => {}} />)
    const gauges = [...html.matchAll(/class="gauge"[^>]*title="([^"]+)"/g)].map((m) => m[1])
    expect(gauges).toEqual(labels)
    const pools = [...html.matchAll(/class="wcard-window-pool">(.*?)<\/div><\/div>/g)]
      .map((m) => [...m[1]!.matchAll(/title="([^"]+)"/g)].map((g) => g[1]))
    expect(pools).toEqual([labels.slice(0, 2), [labels[2]], labels.slice(3)])
    expect(html).toContain('14%')
    expect(html).toContain('12%')
    expect(html).toContain('1d 0h')
  })
})
