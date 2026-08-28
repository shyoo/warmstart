import { Cost } from './Cost'
import { Controller } from './Controller'
import { LooseEnds } from './LooseEnds'

/**
 * Everything that is true of the whole fleet rather than of one project.
 *
 * ⛔ Consults are **not project-scoped** in the daemon, and this is the honest home for them
 * precisely because there is nothing to scope them by. Do not invent a project column on a consult
 * to make this page tidier — the controller answers questions about the fleet, and a question about
 * which worker should run something does not belong to any one repository.
 *
 * ⚠️ Deliberately no live-session list (owner's call, 2026-08-26). What is running right now belongs
 * to the project it is running for, and until sessions carry a project id there is nothing here that
 * could say which.
 */
export function Overview({ now }: { now: number }): React.JSX.Element {
  return (
    <div className="stack">
      {/* ⛔ Above the cost model, because it is the only thing on this page that is *waiting on a
          person*. Everything below it is a number to read; this is a decision somebody owes. */}
      <LooseEnds />
      <Cost now={now} />
      <Controller now={now} />
    </div>
  )
}
