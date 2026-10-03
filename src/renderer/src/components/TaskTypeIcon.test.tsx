import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ROOT_MANDATE, TASK_TYPE_LABELS, taskTypeKey, type Task, type TaskTypeKey } from '@shared/tasks'
import { TaskTypeIcon } from './TaskTypeIcon'

type Typed = Pick<Task, 'kind' | 'mandate' | 'childDefaults'>

const base: Typed = { kind: 'work', mandate: { ...ROOT_MANDATE }, childDefaults: null }
const tasks: Record<TaskTypeKey, Typed> = {
  single: base,
  'plan-split': { ...base, kind: 'plan' },
  'plan-execute': { kind: 'plan', mandate: { ...ROOT_MANDATE, maxChildren: 1 }, childDefaults: { maxChildren: 1 } },
  conversation: { ...base, kind: 'conversation' },
  debate: { ...base, kind: 'debate' }
}

describe('TaskTypeIcon (t901)', () => {
  it('tells all five types apart, by the same key the label uses', () => {
    for (const [key, task] of Object.entries(tasks)) expect(taskTypeKey(task)).toBe(key)
    const drawn = Object.values(tasks).map((task) => renderToStaticMarkup(<TaskTypeIcon task={task} />))
    expect(new Set(drawn).size).toBe(5)
  })

  it('names its type for a screen reader and on hover', () => {
    const html = renderToStaticMarkup(<TaskTypeIcon task={tasks.debate} />)
    expect(html).toContain(`aria-label="${TASK_TYPE_LABELS.debate}"`)
    expect(html).toContain(`<title>${TASK_TYPE_LABELS.debate}</title>`)
  })

  it('⛔ carries no colour of its own, so the theme decides it', () => {
    for (const task of Object.values(tasks)) {
      const html = renderToStaticMarkup(<TaskTypeIcon task={task} />)
      const colours = [...html.matchAll(/(?:fill|stroke|color)="([^"]+)"/g)].map((m) => m[1])
      expect(colours.every((c) => c === 'none' || c === 'currentColor'), html).toBe(true)
      expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i)
    }
  })
})
