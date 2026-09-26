/**
 * The planner-MCP notice under the composer's Plan rows (t706).
 *
 * ⛔ **Advisory, never a gate.** Not every fleet has an MCP-capable worker, and a gate that
 * cannot be satisfied on a one-account fleet is a feature that cannot be used. A planner files
 * its pieces with the `task_split` tool, which only MCP-capable workers have — so this says
 * what happens without one, and points at the Workers table where the capability is shown,
 * rather than refusing to file.
 *
 * ⛔ **Capability language, never adapter names.** Which CLIs have MCP tools changes (t618
 * promoted Codex); the notice names the capability and where to read it.
 */

export type PlannerMcpTone = 'caution'

export interface PlannerMcpNotice {
  id: 'planner_mcp'
  tone: PlannerMcpTone
  text: string
}

/**
 * What the planner can file with, given who would draw the plan.
 *
 * @param pinned the pinned worker and its adapter's MCP capability, or null on Auto.
 * `hasMcp: null` is unknown — the adapter list has not answered yet — and stays silent,
 * because a warning drawn from a list that has not loaded is a warning about nothing.
 * @param fleetHasMcp whether any pinnable worker's adapter has MCP tools.
 */
export function plannerMcpNotice(
  pinned: { label: string; hasMcp: boolean | null } | null,
  fleetHasMcp: boolean
): PlannerMcpNotice | null {
  if (pinned) {
    if (pinned.hasMcp !== false) return null
    return {
      id: 'planner_mcp',
      tone: 'caution',
      text:
        `Planner pinned to ${pinned.label}, whose adapter has no Warmstart MCP tools — ` +
        'the planner files its pieces with the task_split tool, so the split cannot be filed ' +
        'by tool. Pin a worker whose adapter has MCP tools (see the Workers table), or leave ' +
        'the worker on Auto, instead.'
    }
  }
  if (fleetHasMcp) return null
  return {
    id: 'planner_mcp',
    tone: 'caution',
    text:
      'No worker in this fleet has Warmstart MCP tools (see the Workers table) — whichever ' +
      'worker draws the plan has no task_split tool, so the pieces cannot be filed by tool.'
  }
}
