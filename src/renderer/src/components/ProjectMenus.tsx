import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { errorMessage } from '@shared/errors.js'
import type { Project, Task } from '@shared/tasks'
import { rpc } from '../lib/daemon'
import { menuPosition, type MenuPlacement, type Rect } from '../lib/menuposition'
import { PROJECT_FILTERS, type ProjectFilter } from '../lib/sidebartasks'
import { PillOptions } from './Pill'

/**
 * The sidebar's two small menus (t901): the project filter under the funnel, and the menu a right
 * click on a project row opens.
 *
 * ⚠️ Same portal, placement and dismissal as `Pill`, for the same reason: the sidebar scrolls, and a
 * menu drawn inside it would be clipped at its edge. The context menu anchors to the pointer, so it
 * takes a rectangle rather than a button.
 */
function FloatingMenu({
  anchor,
  align = 'left',
  onClose,
  ignore,
  children
}: {
  anchor: Rect
  align?: 'left' | 'right'
  onClose: () => void
  /** The button that opened the menu: a press on it toggles rather than dismisses-then-reopens. */
  ignore?: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<MenuPlacement | null>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    setPlace(
      menuPosition(anchor, { width: menu.offsetWidth, height: menu.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }, align)
    )
  }, [anchor, align])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (menuRef.current?.contains(target) || ignore?.current?.contains(target)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // A menu pinned to a point the page has scrolled away from is pinned to nothing.
    const onMove = (): void => onClose()
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [onClose, ignore])

  return createPortal(
    <div
      ref={menuRef}
      className={`pill-menu${place ? ` pill-menu--${place.placement}` : ' pill-menu--measuring'}`}
      role="presentation"
      style={place ? { left: place.left, top: place.top, maxHeight: place.maxHeight } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body
  )
}

/** A funnel, in the text colour, like every other icon the sidebar draws. */
function FunnelIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true">
      <path d="M2 3h12L9.5 8.5V13l-3-1.5v-3Z" />
    </svg>
  )
}

export function ProjectFilterButton({
  filter,
  onChange
}: {
  filter: ProjectFilter
  onChange: (filter: ProjectFilter) => void
}): React.JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<Rect | null>(null)
  const close = useCallback(() => setAnchor(null), [])
  const label = PROJECT_FILTERS.find((f) => f.id === filter)?.label ?? 'Active'
  return (
    <>
      <button
        ref={buttonRef}
        className={`nav-filter${filter !== 'active' ? ' nav-filter--on' : ''}`}
        title={`Showing ${label.toLowerCase()} projects`}
        aria-label={`Filter projects (showing ${label.toLowerCase()})`}
        aria-haspopup="true"
        aria-expanded={anchor !== null}
        onClick={() => {
          if (anchor) return close()
          const r = buttonRef.current?.getBoundingClientRect()
          if (r) setAnchor({ left: r.left, top: r.top, width: r.width, height: r.height })
        }}
      >
        <FunnelIcon />
      </button>
      {anchor && (
        <FloatingMenu anchor={anchor} onClose={close} ignore={buttonRef}>
          <PillOptions
            ariaLabel="Which projects to list"
            value={filter}
            options={PROJECT_FILTERS.map((f) => ({ value: f.id, label: f.label }))}
            onPick={(value) => {
              onChange(value as ProjectFilter)
              close()
            }}
          />
        </FloatingMenu>
      )}
    </>
  )
}

/** What a person is agreeing to. Both entry points ask this, word for word. */
export function confirmArchive(project: Pick<Project, 'name'>): boolean {
  return confirm(
    `Archive ${project.name}? It leaves the sidebar's Active list and its idle pool worktrees are ` +
      'removed from disk (a worktree with work in it is kept; branches and stashes are never deleted). ' +
      'Its tasks and history stay, and Unarchive brings it back.'
  )
}

/** Archive or unarchive, asking first for the one that removes anything. Null when declined. */
export async function toggleArchive(project: Pick<Project, 'id' | 'name' | 'archivedAt'>): Promise<Project | null> {
  if (project.archivedAt !== null) return rpc('project.unarchive', { id: project.id })
  if (!confirmArchive(project)) return null
  return rpc('project.archive', { id: project.id })
}

/** What a person is agreeing to when they delete. Both entry points ask this, word for word. */
export function confirmDelete(project: Pick<Project, 'name' | 'root'>): boolean {
  return confirm(
    `Delete ${project.name} from Warmstart? It leaves every list, archived included, and its idle pool ` +
      `worktrees are removed. Nothing in ${project.root} is deleted — not a file, branch or stash — and ` +
      'its tasks and history are kept. Adding the folder again brings it back.'
  )
}

/** Delete, asking first. False when declined; throws the daemon's refusal. */
export async function deleteProject(project: Pick<Project, 'id' | 'name' | 'root'>): Promise<boolean> {
  if (!confirmDelete(project)) return false
  await rpc('project.delete', { id: project.id })
  return true
}

/**
 * One line of text, renamed in place: Enter saves, Esc abandons (t906).
 *
 * ⚠️ Inside the menu rather than a `prompt()`: Electron does not implement `window.prompt`, and a
 * modal for one word would be heavier than the thing it edits.
 */
function RenameField({
  label,
  initial,
  maxLength,
  onSave,
  onCancel
}: {
  label: string
  initial: string
  maxLength: number
  onSave: (next: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.select(), [])
  const save = async (): Promise<void> => {
    const next = draft.trim()
    if (!next || next === initial) return onCancel()
    setBusy(true)
    setError(null)
    try {
      await onSave(next)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }
  return (
    <form
      className="menu-rename"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <input
        ref={input}
        className="menu-rename-input"
        aria-label={label}
        value={draft}
        maxLength={maxLength}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // ⚠️ Stopped here so the menu's own Escape handler does not close the menu as well.
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      <button type="submit" className="btn btn--primary" disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {error && <div className="pill-option-hint project-menu-error">{error}</div>}
    </form>
  )
}

function MenuItem({
  label,
  hint,
  danger,
  disabled,
  autoFocus,
  onClick
}: {
  label: string
  hint?: string | null
  danger?: boolean
  disabled?: boolean
  autoFocus?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className={`pill-option${danger ? ' pill-option--danger' : ''}`}
      disabled={disabled}
      autoFocus={autoFocus}
      onClick={onClick}
    >
      <span className="pill-option-text">
        <span className="pill-option-label">{label}</span>
        {hint && <span className="pill-option-hint">{hint}</span>}
      </span>
    </button>
  )
}

/**
 * The right-click menu on a project row: Rename, Archive and Delete (t901, t906).
 *
 * ⛔ Archive and Delete are drawn disabled, with the reason, while the project holds a task that can
 * still run (`holdsProjectOpen`). The daemon refuses both anyway; this only saves the round trip.
 * ⚠️ Delete is red and last, and asks first: it is the one entry that removes the project from view.
 */
export function ProjectRowMenu({
  project,
  at,
  openTasks,
  onClose,
  onDone,
  onDeleted
}: {
  project: Pick<Project, 'id' | 'name' | 'root' | 'archivedAt'>
  at: { x: number; y: number }
  openTasks: number
  onClose: () => void
  onDone: () => Promise<void> | void
  onDeleted?: () => void
}): React.JSX.Element {
  const [anchor] = useState<Rect>(() => ({ left: at.x, top: at.y, width: 0, height: 0 }))
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const archived = project.archivedAt !== null
  const blocked = openTasks > 0
  const blockedHint = blocked
    ? `${openTasks} unfinished ${openTasks === 1 ? 'task' : 'tasks'}: finish or cancel first`
    : null
  const run = (action: () => Promise<unknown>, after?: () => void): void => {
    setBusy(true)
    setError(null)
    void action()
      .then(async (done) => {
        if (done) {
          await onDone()
          after?.()
        }
        onClose()
      })
      .catch((err: unknown) => {
        setError(errorMessage(err))
        setBusy(false)
      })
  }
  return (
    <FloatingMenu anchor={anchor} onClose={onClose}>
      <div className="pill-options" role="menu" aria-label={`${project.name} actions`}>
        {renaming ? (
          <RenameField
            label="Project name"
            initial={project.name}
            maxLength={200}
            onCancel={() => setRenaming(false)}
            onSave={async (name) => {
              await rpc('project.rename', { id: project.id, name })
              await onDone()
              onClose()
            }}
          />
        ) : (
          <>
            <MenuItem label="Rename project…" disabled={busy} autoFocus onClick={() => setRenaming(true)} />
            <MenuItem
              label={archived ? 'Unarchive project' : 'Archive project…'}
              hint={archived ? null : blockedHint}
              disabled={busy || (!archived && blocked)}
              onClick={() => run(() => toggleArchive(project))}
            />
            <MenuItem
              label="Delete project…"
              hint={blockedHint}
              danger
              disabled={busy || blocked}
              onClick={() => run(() => deleteProject(project), onDeleted)}
            />
          </>
        )}
        {error && <div className="pill-option-hint project-menu-error">{error}</div>}
      </div>
    </FloatingMenu>
  )
}

/**
 * The right-click menu on a sidebar task row (t906): rename the task without opening it.
 *
 * ⚠️ Through `task.update { title }`, the call `TitleEditor` makes, so the two cannot disagree: it
 * trims, clears the controller's summary, and never re-dispatches a held or finished task.
 */
export function TaskRowMenu({
  task,
  at,
  onClose,
  onDone
}: {
  task: Pick<Task, 'id' | 'seq' | 'title'>
  at: { x: number; y: number }
  onClose: () => void
  onDone: () => Promise<void> | void
}): React.JSX.Element {
  const [anchor] = useState<Rect>(() => ({ left: at.x, top: at.y, width: 0, height: 0 }))
  const [renaming, setRenaming] = useState(false)
  return (
    <FloatingMenu anchor={anchor} onClose={onClose}>
      <div className="pill-options" role="menu" aria-label={`t${task.seq} actions`}>
        {renaming ? (
          <RenameField
            label="Task title"
            initial={task.title}
            maxLength={500}
            onCancel={() => setRenaming(false)}
            onSave={async (title) => {
              await rpc('task.update', { id: task.id, title })
              await onDone()
              onClose()
            }}
          />
        ) : (
          <MenuItem label="Rename task…" autoFocus onClick={() => setRenaming(true)} />
        )}
      </div>
    </FloatingMenu>
  )
}
