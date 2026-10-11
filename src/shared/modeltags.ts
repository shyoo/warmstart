import { defaultModelClass, MODEL_CLASSES, MODEL_CLASS_LABELS, type ModelClass } from './modelclass.js'

/**
 * Tags on a worker's (model, effort) pair, and the tags a task requires of it (t1024 plan, t1042).
 *
 * ⛔ **A tag is an operator's routing assertion, never a capability.** Nothing here may infer `ZDR`
 * or `Audio` from a provider or a model name; the operator puts a tag on a pair they permit for that
 * work, and a task requiring it matches only that. A task requiring several tags needs **every** one
 * on the *same* pair, and a pair missing one is a failed match, not a partial one.
 *
 * ⭐ Low, Med and High are ordinary tags here. They used to be a separate `modelClass` field with
 * one value per row; `classTag` / `tagClass` are the only places the old spelling survives, for
 * stored rows, saved composer choices and callers that still send `modelClass`.
 */

/** Longest a tag may be, in characters — chips ellipsize anyway, this bounds what is stored. */
export const MAX_TAG_LENGTH = 24
/** Most tags one pair, or one task's requirement, may carry. */
export const MAX_TAGS = 12

/** The three tags offered before an operator has made any: the old capability classes. */
export const BUILTIN_TAGS: readonly string[] = MODEL_CLASSES.map((c) => classTag(c))

/** A tag's identity: case-insensitive, whitespace-collapsed. `ZDR` and `zdr` are one tag. */
export function tagKey(tag: string): string {
  return tag.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** One tag as stored: trimmed, inner whitespace collapsed, spelling kept. Empty when nothing is left. */
function cleanOne(tag: string): string {
  return tag.trim().replace(/\s+/g, ' ')
}

/**
 * The tags in `input`, deduplicated by identity (first spelling wins), empties dropped, order kept.
 *
 * ⚠️ Lenient on purpose: this is what a *reader* of stored data uses, so a malformed value yields
 * fewer tags rather than a crash at startup. A writer at the daemon boundary uses `checkTags`.
 */
export function cleanTags(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const tag = cleanOne(raw)
    if (!tag) continue
    const key = tagKey(tag)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/**
 * The same, strict: for input a person or an agent sent. Throws on a wrong shape, an over-long tag
 * or too many, with `what` naming the field. Duplicates and blanks are tidied rather than refused —
 * they are slips, not attacks — but a tag that is *too long* is refused, never truncated into a
 * different tag.
 */
export function checkTags(input: unknown, what: string): string[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error(`${what} must be a list of tags`)
  for (const raw of input) {
    if (typeof raw !== 'string') throw new Error(`${what} must contain only text`)
    if (cleanOne(raw).length > MAX_TAG_LENGTH) {
      throw new Error(`tag '${cleanOne(raw).slice(0, MAX_TAG_LENGTH)}…' in ${what} is longer than ${MAX_TAG_LENGTH} characters`)
    }
  }
  const tags = cleanTags(input)
  if (tags.length > MAX_TAGS) throw new Error(`${what} may name at most ${MAX_TAGS} tags`)
  return tags
}

/** The marker that makes an operator's own tag a capability tier: `Tier:Ultra`. */
export const TIER_PREFIX = 'Tier:'

/** A custom tier's name without its marker, or null when `tag` is not one. */
function customTierName(tag: string): string | null {
  const t = cleanOne(tag)
  if (t.slice(0, TIER_PREFIX.length).toLowerCase() !== TIER_PREFIX.toLowerCase()) return null
  const name = t.slice(TIER_PREFIX.length).trim()
  return name || null
}

/** `tag` as an operator's custom capability tier (`Ultra` → `Tier:Ultra`); built-in tiers are unchanged. */
export function asTierTag(tag: string): string {
  const t = cleanOne(tag)
  return !t || isTierTag(t) ? t : `${TIER_PREFIX}${t}`
}

/** How a tag reads to a person: a custom tier loses its `Tier:` marker. */
export function tagDisplay(tag: string): string {
  return customTierName(tag) ?? tag
}

/**
 * Is `tag` a capability tier: `Low`, `Med`, `High` (or their aliases), or a custom `Tier:<name>`?
 *
 * ⛔ Tiers match as OR, features as AND. The marker is stored in the tag itself so a custom tier
 * needs no catalogue, schema change or migration.
 */
export function isTierTag(tag: string): boolean {
  return tagClass(tag) !== null || customTierName(tag) !== null
}

/**
 * Does a pair carrying `have` satisfy a task requiring `need`?
 *
 * ⛔ **Capability tiers (Low/Med/High) are evaluated as OR; feature tags are evaluated as AND.**
 * A task asking for `High` and `Med` matches any pair whose tier is `High` OR `Med`.
 * Any orthogonal feature tag (such as `Audio` or `ZDR`) must be present on the matching pair.
 * No requirement always matches.
 */
export function matchesModelTags(have: readonly string[] | null | undefined, need: readonly string[] | null | undefined): boolean {
  if (!need || need.length === 0) return true
  if (!have || have.length === 0) return false
  const keys = new Set(have.map(tagKey))

  const tierNeed = need.filter(isTierTag)
  const featureNeed = need.filter((t) => !isTierTag(t))

  if (tierNeed.length > 0 && !tierNeed.some((t) => keys.has(tagKey(t)))) {
    return false
  }

  return featureNeed.every((t) => keys.has(tagKey(t)))
}

/** Does a pair carrying `have` satisfy a task requiring `need`? */
export function hasAllTags(have: readonly string[] | null | undefined, need: readonly string[] | null | undefined): boolean {
  return matchesModelTags(have, need)
}

/** The requirement not met by `have`, for the hold reason: `ZDR + Audio` minus `ZDR` is `Audio`. */
export function missingTags(have: readonly string[] | null | undefined, need: readonly string[] | null | undefined): string[] {
  if (!need || need.length === 0) return []
  const keys = new Set((have ?? []).map(tagKey))
  const tierNeed = need.filter(isTierTag)
  const featureNeed = need.filter((t) => !isTierTag(t))

  const missingFeatures = featureNeed.filter((t) => !keys.has(tagKey(t)))
  const missingTiers = tierNeed.length > 0 && !tierNeed.some((t) => keys.has(tagKey(t))) ? tierNeed : []

  return [...missingTiers, ...missingFeatures]
}

/** The same set, whatever the order or case — what "unchanged" means when comparing two selections. */
export function sameTags(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const ka = new Set((a ?? []).map(tagKey))
  const kb = new Set((b ?? []).map(tagKey))
  return ka.size === kb.size && [...ka].every((k) => kb.has(k))
}

/**
 * How a requirement reads in a pill, a hold reason and a log line:
 * - Single tier / feature: `High` or `Audio`
 * - Multiple tiers: `High | Med`
 * - Tiers + features: `(High | Med) + Audio` or `High + Audio`
 * - Multiple features: `Audio + ZDR`
 */
export function tagsLabel(tags: readonly string[]): string {
  if (!tags || tags.length === 0) return ''
  const tierNeed = tags.filter(isTierTag).map(tagDisplay)
  const featureNeed = tags.filter((t) => !isTierTag(t))

  if (tierNeed.length > 1) {
    const tierPart = tierNeed.join(' | ')
    if (featureNeed.length > 0) {
      return `(${tierPart}) + ${featureNeed.join(' + ')}`
    }
    return tierPart
  }

  return tags.map(tagDisplay).join(' + ')
}

/** A capability class as the tag that replaced it: `med` → `Med`. */
export function classTag(modelClass: ModelClass): string {
  return modelClass === 'med' ? 'Med' : MODEL_CLASS_LABELS[modelClass]
}

/** The capability class a tag spells, if it spells one (`High`, `high`, `Medium` and `Med` all do). */
export function tagClass(tag: string): ModelClass | null {
  const key = tagKey(tag)
  if (key === 'medium') return 'med'
  return MODEL_CLASSES.find((c) => c === key) ?? null
}

/** The tag a model carries before an operator says otherwise: its built-in class. */
export function inferredTags(model: string | null | undefined): string[] {
  return [classTag(defaultModelClass(model))]
}

/**
 * Every tag the fleet knows, for a picker's suggestions: the built-ins, then each tag any pair
 * carries, first spelling kept.
 *
 * ⚠️ There is no catalogue to maintain. A tag exists because a pair carries it, and an edit to that
 * pair is also how a spelling changes.
 */
export function fleetTags(
  workers: ReadonlyArray<{ modelRoutes?: ReadonlyArray<{ tags?: readonly string[] }> | null } | null | undefined>
): string[] {
  const all: string[] = [...BUILTIN_TAGS]
  for (const w of workers) for (const r of w?.modelRoutes ?? []) all.push(...(r.tags ?? []))
  return cleanTags(all)
}

/**
 * A requirement as stored from the old `modelClass` spelling.
 *
 * Returns `[]` for no class, and throws on a value that is not one of the three — the daemon
 * boundary's refusal, in the old wording, for a caller that still sends `modelClass`.
 */
export function tagsFromLegacyClass(modelClass: string | null | undefined): string[] {
  if (modelClass === null || modelClass === undefined || modelClass === '') return []
  const cls = MODEL_CLASSES.find((c) => c === modelClass)
  if (!cls) throw new Error(`invalid modelClass '${modelClass}'`)
  return [classTag(cls)]
}

/**
 * A stored object that may still carry the old single class, with the class turned into one tag.
 *
 * ⛔ **A reader's rule, mirroring migration 90 — not a second migration.** Task constraints, child
 * defaults and a quota warning's redirect were written as `modelClass` before tags; the migration
 * rewrites what is on disk, and this makes a row that slipped past it (a restored backup, a draft in
 * a not-yet-migrated file) resolve Low/Med/High exactly as it did. Existing `tags` always win. An
 * unknown class value is dropped, never turned into a tag nobody typed.
 */
export function upgradeLegacyClass<T extends object>(
  value: T,
  classKey = 'modelClass',
  tagsKey = 'modelTags'
): T {
  const o = value as Record<string, unknown>
  if (!(classKey in o)) return value
  const { [classKey]: legacy, ...rest } = o
  if (!(tagsKey in rest) && typeof legacy === 'string') {
    const cls = MODEL_CLASSES.find((c) => c === legacy)
    if (cls) rest[tagsKey] = [classTag(cls)]
  }
  return rest as T
}
