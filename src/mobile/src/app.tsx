import { useEffect, useState } from 'react'
import type { DaemonEvent } from '@shared/protocol'
import { connectEvents, onAuthChange, store, type EventsStatus } from './api.js'
import { AttentionScreen } from './screens/Attention.js'
import { NewScreen } from './screens/New.js'
import { Pair, pairCodeFromHash } from './screens/Pair.js'
import { QuotaScreen } from './screens/Quota.js'
import { TaskDetailScreen } from './screens/TaskDetail.js'
import { TasksScreen } from './screens/Tasks.js'
import { SettingsScreen } from './screens/Settings.js'

/**
 * The shell: hash routing, the pairing gate, the bottom tabs, and the live socket.
 *
 * Routes: `#/` attention, `#/quota`, `#/tasks`, `#/task/:id`, `#/new`, `#/settings`, `#/pair?code=…`.
 * Every route except pairing redirects to pairing when there is no token, and any 401 anywhere
 * clears the token and lands back here — which is what a revoked device experiences.
 */
type Route = { name: 'attention' } | { name: 'quota' } | { name: 'tasks' } | { name: 'task'; id: string } | { name: 'new' } | { name: 'settings' } | { name: 'pair' }

export function routeFromHash(hash: string): Route {
  const path = hash.startsWith('#') ? hash.slice(1) : hash
  const [bare] = path.split('?')
  if (bare === '/quota') return { name: 'quota' }
  if (bare === '/tasks') return { name: 'tasks' }
  if (bare === '/new') return { name: 'new' }
  if (bare === '/settings') return { name: 'settings' }
  if (bare === '/pair') return { name: 'pair' }
  const task = /^\/task\/([^/]+)$/.exec(bare ?? '')
  if (task?.[1]) return { name: 'task', id: decodeURIComponent(task[1]) }
  return { name: 'attention' }
}

const TITLES: Record<Route['name'], string> = {
  attention: 'Attention',
  quota: 'Quota',
  tasks: 'Tasks',
  task: 'Task',
  new: 'New task',
  settings: 'Settings',
  pair: 'Pair'
}

const REFRESH_EVENTS = new Set(['question.opened', 'approval.opened', 'task.changed', 'quota.changed'])

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>(() => routeFromHash(location.hash))
  const [paired, setPaired] = useState(() => store.get() !== null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [eventsStatus, setEventsStatus] = useState<EventsStatus>('connecting')

  useEffect(() => {
    const onHash = (): void => setRoute(routeFromHash(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => onAuthChange(() => setPaired(store.get() !== null)), [])

  useEffect(() => {
    if (!paired) return
    return connectEvents({
      onEvent: (event: DaemonEvent) => {
        if (REFRESH_EVENTS.has(event.type)) setRefreshKey((k) => k + 1)
      },
      onStatus: setEventsStatus
    })
  }, [paired])

  const go = (hash: string): void => {
    location.hash = hash
  }

  if (!paired) {
    return (
      <div className="m-app">
        <Pair initialCode={pairCodeFromHash(location.hash)} onPaired={() => {
          setPaired(true)
          go('#/')
        }} />
      </div>
    )
  }

  return (
    <div className="m-app">
      <header className="m-topbar">
        <span className="m-topbar-title">{TITLES[route.name]}</span>
        <span className={`m-dot m-dot--${eventsStatus}`} title={`live updates: ${eventsStatus}`} />
      </header>
      <main className="m-main">
        {route.name === 'attention' && <AttentionScreen refreshKey={refreshKey} openTask={(id) => go(`#/task/${id}`)} />}
        {route.name === 'quota' && <QuotaScreen refreshKey={refreshKey} />}
        {route.name === 'tasks' && <TasksScreen refreshKey={refreshKey} openTask={(id) => go(`#/task/${id}`)} newTask={() => go('#/new')} />}
        {route.name === 'task' && <TaskDetailScreen id={route.id} refreshKey={refreshKey} />}
        {route.name === 'new' && <NewScreen openTask={(id) => go(`#/task/${id}`)} />}
        {route.name === 'settings' && <SettingsScreen refreshKey={refreshKey} />}
        {route.name === 'pair' && <Pair initialCode={pairCodeFromHash(location.hash)} onPaired={() => go('#/')} />}
      </main>
      <nav className="m-tabs">
        <TabButton active={route.name === 'attention'} onPress={() => go('#/')} label="Attention" />
        <TabButton active={route.name === 'quota'} onPress={() => go('#/quota')} label="Quota" />
        <TabButton active={route.name === 'tasks' || route.name === 'task'} onPress={() => go('#/tasks')} label="Tasks" />
        <TabButton active={route.name === 'settings'} onPress={() => go('#/settings')} label="Settings" />
      </nav>
    </div>
  )
}

function TabButton({ active, onPress, label }: { active: boolean; onPress: () => void; label: string }): React.JSX.Element {
  return (
    <button className={`m-tab${active ? ' m-tab--active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onPress}>
      {label}
    </button>
  )
}
