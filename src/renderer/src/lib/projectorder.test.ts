import { describe, expect, it } from 'vitest'
import { reorderedProjectIds } from './projectorder'

describe('project drag ordering', () => {
  it('moves a project before or after the project under the pointer', () => {
    expect(reorderedProjectIds(['a', 'b', 'c'], 'c', 'a', false)).toEqual(['c', 'a', 'b'])
    expect(reorderedProjectIds(['a', 'b', 'c'], 'a', 'b', true)).toEqual(['b', 'a', 'c'])
  })

  it('does nothing for stale or self drops', () => {
    const ids = ['a', 'b']
    expect(reorderedProjectIds(ids, 'a', 'a', false)).toBe(ids)
    expect(reorderedProjectIds(ids, 'missing', 'a', false)).toBe(ids)
  })
})
