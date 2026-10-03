import type { JSX } from 'react'
import { TASK_TYPE_LABELS, taskTypeKey, type Task, type TaskTypeKey } from '@shared/tasks'

/**
 * The small pictogram for a task's type (t901).
 *
 * ⛔ **Drawn in `currentColor`, never in a colour of its own.** One set of shapes serves the dark,
 * light and system themes, including a live switch, because the colour comes from whatever text it
 * sits beside, and that comes from `tokens.css`. A second asset set per theme would be one more
 * thing to keep in step with the tokens by hand, and an emoji would ignore the theme altogether.
 * `taskTypeIcon.test.tsx` fails on a hard-coded colour.
 */
const SHAPES: Record<TaskTypeKey, JSX.Element> = {
  // A ticked box: one piece of work.
  single: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
      <path d="M5.5 8.2 7.3 10l3.4-3.8" />
    </>
  ),
  // One stem forking into two: a plan that files pieces.
  'plan-split': (
    <>
      <circle cx="3" cy="8" r="1.25" fill="currentColor" stroke="none" />
      <path d="M4.5 8H7c2 0 2.5-4 5.5-4M7 8c2 0 2.5 4 5.5 4" />
      <path d="m10.8 2.5 2 1.5-2 1.5M10.8 10.5l2 1.5-2 1.5" />
    </>
  ),
  // A list, then play: a plan that runs itself.
  'plan-execute': (
    <>
      <path d="M2.5 4H8M2.5 8H8M2.5 12h4" />
      <path d="M10 5.5 14 8l-4 2.5Z" />
    </>
  ),
  // One speech bubble.
  conversation: (
    <path d="M3.5 2.5h9a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7L4 14v-2.5h-.5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z" />
  ),
  // Two bubbles answering each other.
  debate: (
    <>
      <path d="M3 1.5h5a1.5 1.5 0 0 1 1.5 1.5v2.5A1.5 1.5 0 0 1 8 7H5L3 8.5V7a1.5 1.5 0 0 1-1.5-1.5V3A1.5 1.5 0 0 1 3 1.5Z" />
      <path d="M8 8h5a1.5 1.5 0 0 1 1.5 1.5v2A1.5 1.5 0 0 1 13 13v1.5L11 13H8a1.5 1.5 0 0 1-1.5-1.5v-2A1.5 1.5 0 0 1 8 8Z" />
    </>
  )
}

export function TaskTypeIcon({
  task,
  size = 14,
  className = 'task-type-icon'
}: {
  task: Pick<Task, 'kind' | 'mandate' | 'childDefaults'>
  size?: number
  className?: string
}): JSX.Element {
  const key = taskTypeKey(task)
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-type={key}
      role="img"
      aria-label={TASK_TYPE_LABELS[key]}
    >
      <title>{TASK_TYPE_LABELS[key]}</title>
      {SHAPES[key]}
    </svg>
  )
}
