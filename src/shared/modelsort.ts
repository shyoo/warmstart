/**
 * Adapter-neutral, deterministic ordering for model IDs across listed, discovered, and dynamic pools.
 *
 * Groups IDs by family prefix (e.g. `gemini`, `claude`, `gpt`, `muse`, `local-llm`), orders versioned
 * entries before versionless ones by descending numeric version, then applies deterministic variant tie-breaking.
 */

const VARIANT_TIER_PRIORITY: Record<string, number> = {
  opus: 0,
  sonnet: 1,
  haiku: 2
}

interface ParsedModelId {
  id: string
  family: string
  version: number[]
  tierRank: number
}

/** Extract the normalized family prefix (first colon/hyphen segment lowercased). */
export function modelFamily(id: string): string {
  const colon = id.indexOf(':')
  if (colon > 0) return id.slice(0, colon).toLowerCase()
  const hyphen = id.indexOf('-')
  return (hyphen > 0 ? id.slice(0, hyphen) : id).toLowerCase()
}

function splitRemainder(id: string, family: string): string[] {
  const lower = id.toLowerCase()
  const prefix = lower.startsWith(`${family}:`) || lower.startsWith(`${family}-`) ? id.slice(family.length + 1) : ''
  return prefix ? prefix.split('-').filter(Boolean) : []
}

function parseVersionTokens(tokens: readonly string[]): number[] {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!/^\d+(?:\.\d+)?$/.test(token)) continue
    const parts = token.split('.').map(Number)
    // Skip snapshot dates / large numeric identifiers (e.g. 20251001) that are not generations.
    if (parts[0] === undefined || !Number.isFinite(parts[0]) || parts[0] >= 1000) continue
    // Handle hyphenated minor versions like `claude-opus-5-5` or `claude-sonnet-4-6`.
    if (parts.length === 1 && i + 1 < tokens.length && /^\d{1,2}$/.test(tokens[i + 1]!)) {
      parts.push(Number(tokens[i + 1]!))
    }
    return parts
  }
  return []
}

function variantTierRank(tokens: readonly string[]): number {
  for (const token of tokens) {
    const rank = VARIANT_TIER_PRIORITY[token.toLowerCase()]
    if (rank !== undefined) return rank
  }
  return Object.keys(VARIANT_TIER_PRIORITY).length
}

function parseModelId(id: string): ParsedModelId {
  const family = modelFamily(id)
  const tokens = splitRemainder(id, family)
  return {
    id,
    family,
    version: parseVersionTokens(tokens),
    tierRank: variantTierRank(tokens)
  }
}

function compareVersionsDesc(a: readonly number[], b: readonly number[]): number {
  const aHas = a.length > 0
  const bHas = b.length > 0
  if (aHas !== bHas) return aHas ? -1 : 1
  if (!aHas) return 0
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return bv - av
  }
  return 0
}

/**
 * Sort model IDs cleanly by family order, version descending (versioned before versionless),
 * capability tier rank (`opus` > `sonnet` > `haiku` when present), and natural alphabetical order.
 */
export function sortModelIds(
  ids: readonly string[],
  preferredFamilyOrder?: readonly string[]
): string[] {
  if (ids.length <= 1) return [...ids]

  const familyRank = new Map<string, number>()
  if (preferredFamilyOrder) {
    for (const entry of preferredFamilyOrder) {
      const fam = modelFamily(entry)
      if (!familyRank.has(fam)) familyRank.set(fam, familyRank.size)
    }
  }
  for (const id of ids) {
    const fam = modelFamily(id)
    if (!familyRank.has(fam)) familyRank.set(fam, familyRank.size)
  }

  return ids
    .map((id, index) => ({ parsed: parseModelId(id), index }))
    .sort((a, b) => {
      const famDiff = (familyRank.get(a.parsed.family) ?? 0) - (familyRank.get(b.parsed.family) ?? 0)
      if (famDiff !== 0) return famDiff

      const verDiff = compareVersionsDesc(a.parsed.version, b.parsed.version)
      if (verDiff !== 0) return verDiff

      const tierDiff = a.parsed.tierRank - b.parsed.tierRank
      if (tierDiff !== 0) return tierDiff

      const nameDiff = a.parsed.id.localeCompare(b.parsed.id, 'en', { numeric: true })
      if (nameDiff !== 0) return nameDiff

      return a.index - b.index
    })
    .map((entry) => entry.parsed.id)
}
