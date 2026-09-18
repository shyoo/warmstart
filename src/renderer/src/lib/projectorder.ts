/** Move one project beside another, using the complete order last served by the daemon. */
export function reorderedProjectIds(
  ids: string[],
  movedId: string,
  targetId: string,
  after: boolean
): string[] {
  if (movedId === targetId || !ids.includes(movedId) || !ids.includes(targetId)) return ids
  const next = ids.filter((id) => id !== movedId)
  const target = next.indexOf(targetId)
  next.splice(target + (after ? 1 : 0), 0, movedId)
  return next
}
