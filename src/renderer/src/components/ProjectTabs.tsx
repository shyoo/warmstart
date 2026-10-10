import type { JSX } from 'react'

export type ProjectTab = 'flow' | 'tasks' | 'scratchpad' | 'thread' | 'conversations' | 'sessionTui' | 'settings'

/**
 * ⛔ **Thread**, not Conversation. A conversation in this app is the agent session you resume with
 * `--resume` or `--conversation` — it has an id, it outlives the task that opened it, and Settings
 * has a page listing them. A task's messages are a different thing entirely, and giving both the
 * same name would make "which conversation is this task in?" ambiguous on the one screen that
 * answers it. See docs/glossary.md.
 */
/**
 * ⛔ **Session TUI**, not Sessions. That tab shows one thing and only one: the *raw terminal* of a
 * live agent process, keystrokes and all. Called "Sessions" it read as a list of this project's
 * sessions — which is a real and different thing, is now called **Conversations**, and is the tab
 * beside it. Two tabs, two nouns; the pane that draws a TTY says so in its name.
 */
export const PROJECT_TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: 'flow', label: 'Flow' },
  { id: 'scratchpad', label: 'Scratchpad' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'thread', label: 'Thread' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'sessionTui', label: 'Session TUI' },
  { id: 'settings', label: 'Settings' }
]

const TAB_PICTOGRAMS: Record<ProjectTab, JSX.Element> = {
  flow: (
    <>
      <rect x="2" y="2" width="4" height="4" rx="1" />
      <rect x="10" y="2" width="4" height="4" rx="1" />
      <rect x="10" y="10" width="4" height="4" rx="1" />
      <path d="M6 4h4M12 6v4M2 12h8" />
    </>
  ),
  scratchpad: (
    <><path d="M4 2.5h6l2 2V14H4Z" /><path d="M6 7h4M6 10h3" /></>
  ),
  tasks: (
    <><rect x="2" y="2" width="12" height="12" rx="2" /><path d="m4.5 5 1 1 1.5-2M9 5h3M4.5 10l1 1L7 9M9 10h3" /></>
  ),
  thread: (
    <><path d="M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 11.5H7l-4 2V11.5A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5Z" /><path d="M4.5 6h7M4.5 8.5h5" /></>
  ),
  conversations: (
    <><path d="M2 3h7a1.5 1.5 0 0 1 1.5 1.5V7A1.5 1.5 0 0 1 9 8.5H5L2 10V8.5A1.5 1.5 0 0 1 .5 7V4.5A1.5 1.5 0 0 1 2 3Z" /><path d="M6 10.5h4l3 2v-2A1.5 1.5 0 0 0 14.5 9V6.5A1.5 1.5 0 0 0 13 5h-1" /></>
  ),
  sessionTui: (
    <><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="m4 6 2 2-2 2M8 10h4" /></>
  ),
  settings: (
    <><circle cx="8" cy="8" r="2.2" /><path d="M6.5 1.8h3l.5 1.5 1.3.7 1.5-.4 1.5 2.6-1.1 1.1v1.4l1.1 1.1-1.5 2.6-1.5-.4-1.3.7-.5 1.5h-3L6 12.7l-1.3-.7-1.5.4-1.5-2.6 1.1-1.1V7.3L1.7 6.2l1.5-2.6 1.5.4L6 3.3Z" /></>
  )
}

export function ProjectTabIcon({ tab }: { tab: ProjectTab }): JSX.Element {
  return (
    <svg
      className="project-tab-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {TAB_PICTOGRAMS[tab]}
    </svg>
  )
}
