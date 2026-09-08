/**
 * Median of an integer-valued series, rounded only after the middle pair is averaged.
 *
 * Token counts are integral; `medianFloat` is for quantities such as dollars and review scores
 * where rounding would erase the measurement.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const value =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? null)
  return value === null ? null : Math.round(value)
}

/** The same median without integer rounding, for values whose fractional part is meaningful. */
export function medianFloat(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null)
}
