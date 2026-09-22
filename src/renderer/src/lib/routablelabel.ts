import { resolveModelClass, type ModelClass } from '@shared/modelclass'

/**
 * What the **Routable models** pill reads. Pure so the L1 suite can pin it without a table.
 *
 * ⛔ **Names, not a count.** `2 models` says nothing an operator choosing where a task lands needs —
 * the pill names the allowlist (with model capability class and configured effort level, truncated by
 * the pill's own ellipsis with the full list on the tooltip), and the menu behind the pill is the editor.
 * The empty state reads as what it is — a deliberate, inert default, matching `ROUTABLE_MODELS_HELP` —
 * because a blank beside `Model` would read as "nothing chosen yet" rather than its opposite.
 */
export function routableModelsLabel(
  selected: string[],
  worker?: {
    modelClasses?: Record<string, ModelClass> | null
    modelEfforts?: Record<string, string | null> | null
  } | null
): string {
  if (selected.length === 0) return 'default model only'
  return selected
    .map((id) => {
      const cls = resolveModelClass(id, worker)
      const eff = worker?.modelEfforts?.[id]
      if (eff) {
        return `${id} (${cls}, ${eff} effort)`
      }
      return `${id} (${cls})`
    })
    .join(', ')
}
