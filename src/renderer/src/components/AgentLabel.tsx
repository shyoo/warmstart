import { agentName } from '../lib/agentname'

/**
 * An agent, written where the *model* is what is being compared: **Sonnet 5 · Claude Code**.
 *
 * ⛔ **Never the adapter id on its own.** `openai-compatible` names the way an agent is reached, not
 * the thing that ran: it is Codex CLI on one account and whatever a local endpoint is serving on
 * another, and a quality table that labels both of them `openai-compatible` invites an operator to
 * compare two measurements of different systems. The naming rules, and what happens when a model was
 * never recorded, are in `lib/agentname.ts`.
 *
 * ⚠️ The exact `adapter/model` slugs stay in the `title` on every use, so the id that was actually
 * dispatched is one hover away from the name that was prettified for reading.
 */
export function AgentLabel({
  adapterId,
  model,
  labels
}: {
  adapterId: string | null | undefined
  model: string | null | undefined
  labels: Record<string, string>
}): React.JSX.Element {
  const name = agentName(adapterId, model, labels)
  return (
    <span title={name.title}>
      {name.primary}
      {name.secondary ? <span className="dim"> · {name.secondary}</span> : null}
    </span>
  )
}
