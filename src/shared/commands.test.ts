import { describe, expect, it } from 'vitest'
import { commandById, commandForEvent, commandMatches, leadingCommand } from './commands'

/**
 * The composer's slash commands (t704). ⛔ The rule is that a command becomes structure the moment
 * it is typed, and that nothing else does — a path or a longer word must stay text.
 */
describe('leadingCommand', () => {
  it('recognises /delegate once the word is finished, and keeps the rest verbatim', () => {
    expect(leadingCommand('/delegate write the tests')).toEqual({
      command: commandById('delegate'),
      rest: 'write the tests'
    })
    expect(leadingCommand('/Delegate  two spaces')?.rest).toBe(' two spaces')
  })

  it('leaves everything else as text', () => {
    expect(leadingCommand('/delegate')).toBeNull()
    expect(leadingCommand('/delegates are people')).toBeNull()
    expect(leadingCommand('/usr/bin/env node')).toBeNull()
    expect(leadingCommand('please /delegate this')).toBeNull()
  })
})

describe('commandMatches', () => {
  it('offers the command while a prefix of it is typed at the start', () => {
    expect(commandMatches('/').map((c) => c.id)).toEqual(['delegate'])
    expect(commandMatches('/dEl').map((c) => c.id)).toEqual(['delegate'])
  })

  it('offers nothing once the text is anything else', () => {
    expect(commandMatches('')).toEqual([])
    expect(commandMatches('/x')).toEqual([])
    expect(commandMatches('/delegate now')).toEqual([])
    expect(commandMatches('hi /d')).toEqual([])
  })
})

it('maps the stored message event back to its chip', () => {
  expect(commandForEvent('command.delegate')?.label).toBe('Delegate')
  expect(commandForEvent(null)).toBeNull()
  expect(commandForEvent('landing.landed')).toBeNull()
})
