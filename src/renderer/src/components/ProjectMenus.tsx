import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { errorMessage } from '@shared/errors.js'
import type { Project } from '@shared/tasks'
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

/**
 * The right-click menu on a project row.
 *
 * ⛔ Archive is drawn disabled, with the reason, while the project holds a task that can still run
 * (`holdsProjectOpen`). The daemon refuses it anyway; this only saves the round trip.
 */
export function ProjectRowMenu({
  project,
  at,
  openTasks,
  onClose,
  onDone
}: {
  project: Pick<Project, 'id' | 'name' | 'archivedAt'>
  at: { x: number; y: number }
  openTasks: number
  onClose: () => void
  onDone: () => Promise<void> | void
}): React.JSX.Element {
  const [anchor] = useState<Rect>(() => ({ left: at.x, top: at.y, width: 0, height: 0 }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const archived = project.archivedAt !== null
  const blocked = !archived && openTasks > 0
  return (
    <FloatingMenu anchor={anchor} onClose={onClose}>
      <div className="pill-options" role="menu" aria-label={`${project.name} actions`}>
        <button
          type="button"
          role="menuitem"
          className="pill-option"
          disabled={busy || blocked}
          autoFocus
          onClick={() => {
            setBusy(true)
            setError(null)
            void toggleArchive(project)
              .then(async (done) => {
                if (done) await onDone()
                onClose()
              })
              .catch((err: unknown) => {
                setError(errorMessage(err))
                setBusy(false)
              })
          }}
        >
          <span className="pill-option-text">
            <span className="pill-option-label">{archived ? 'Unarchive project' : 'Archive project…'}</span>
            {blocked && (
              <span className="pill-option-hint">
                {openTasks} unfinished {openTasks === 1 ? 'task' : 'tasks'}: finish or cancel first
              </span>
            )}
          </span>
        </button>
        {error && <div className="pill-option-hint project-menu-error">{error}</div>}
      </div>
    </FloatingMenu>
  )
}
