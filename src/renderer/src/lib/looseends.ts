/**
 * What the Loose ends panel says after **Check merged PRs**.
 *
 * ⚠️ Every count that is not zero is named, and a sweep that found nothing says so. "Checked 3" on
 * its own would leave the operator to guess whether the merged branch they came for was one of them.
 */
export function mergedSweepNote(r: {
  ran: boolean
  checked: number
  cleanedUp: number
  kept: number
  failed: number
}): string {
  if (!r.ran) return 'a check is already running — its result will show here when the list refreshes'
  if (r.checked === 0) return 'no open or unfinished pull requests to check'
  const parts = [
    ...(r.cleanedUp > 0 ? [`${r.cleanedUp} merged and cleaned up`] : []),
    ...(r.kept > 0 ? [`${r.kept} merged but kept — the row says why`] : []),
    ...(r.failed > 0 ? [`${r.failed} could not be read from GitHub`] : [])
  ]
  const open = r.checked - r.cleanedUp - r.kept - r.failed
  if (open > 0) parts.push(`${open} still open`)
  return `checked ${r.checked} pull request(s): ${parts.join(', ')}`
}
