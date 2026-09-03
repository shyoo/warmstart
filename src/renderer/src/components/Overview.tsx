import { LooseEnds } from './LooseEnds'

/**
 * Everything that is true of the whole fleet rather than of one project.
 *
 * ⚠️ Deliberately no live-session list (owner's call, 2026-08-26). What is running right now belongs
 * to the project it is running for, and until sessions carry a project id there is nothing here that
 * could say which.
 */
export function Overview(): React.JSX.Element {
  return (
    <div className="stack">
      <LooseEnds />
    </div>
  )
}
