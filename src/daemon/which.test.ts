import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatCmdInvocation, quoteCmdArg, spawnEnv, unwrapForPty, which } from './which.js'

describe('quoteCmdArg', () => {
  it('quotes empty string as double quotes', () => {
    expect(quoteCmdArg('')).toBe('""')
  })

  it('leaves clean arguments untouched', () => {
    expect(quoteCmdArg('--version')).toBe('--version')
    expect(quoteCmdArg('exec')).toBe('exec')
    expect(quoteCmdArg('abc123_-')).toBe('abc123_-')
  })

  it('quotes arguments containing spaces', () => {
    expect(quoteCmdArg('C:\\Users\\Sunghwan Yoo')).toBe('"C:\\Users\\Sunghwan Yoo"')
    expect(quoteCmdArg('foo bar')).toBe('"foo bar"')
  })

  it('doubles trailing backslashes before the closing quote', () => {
    expect(quoteCmdArg('C:\\Users\\Sunghwan Yoo\\')).toBe('"C:\\Users\\Sunghwan Yoo\\\\"')
  })

  it('escapes internal quotes and backslashes preceding them', () => {
    expect(quoteCmdArg('foo"bar')).toBe('"foo\\"bar"')
    expect(quoteCmdArg('foo\\"bar')).toBe('"foo\\\\\\"bar"')
  })
})

describe('formatCmdInvocation', () => {
  it('does nothing on non-cmd.exe commands', () => {
    const res = formatCmdInvocation('git.exe', ['merge-base', 'main'])
    expect(res).toEqual({ command: 'git.exe', args: ['merge-base', 'main'] })
    expect(res.windowsVerbatimArguments).toBeUndefined()
  })

  it('formats cmd.exe /c invocations into a single outer-quoted command string with /s', () => {
    if (process.platform !== 'win32') return
    const res = formatCmdInvocation('win32' === process.platform ? 'C:\\Windows\\system32\\cmd.exe' : 'cmd.exe', [
      '/d',
      '/c',
      'C:\\Users\\Sunghwan Yoo\\codex.CMD',
      'exec',
      '--cd',
      'C:\\Users\\Sunghwan Yoo\\scratch'
    ])
    expect(res.command).match(/cmd\.exe$/i)
    expect(res.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\Users\\Sunghwan Yoo\\codex.CMD" exec --cd "C:\\Users\\Sunghwan Yoo\\scratch""'
    ])
    expect(res.windowsVerbatimArguments).toBe(true)
  })

  it('leaves cmd.exe without /c or /k untouched', () => {
    if (process.platform !== 'win32') return
    const res = formatCmdInvocation('cmd.exe', ['/d'])
    expect(res).toEqual({ command: 'cmd.exe', args: ['/d'] })
  })
})

describe('unwrapForPty', () => {
  it('does nothing on non-cmd.exe commands', () => {
    const res = unwrapForPty('claude.exe', ['--version'])
    expect(res).toEqual({ command: 'claude.exe', args: ['--version'] })
  })

  it('unwraps cmd.exe /c command and args for native pty execution on Windows', () => {
    if (process.platform !== 'win32') return
    const res = unwrapForPty('cmd.exe', [
      '/d',
      '/c',
      'C:\\Users\\Sunghwan Yoo\\codex.CMD',
      'exec',
      '--version'
    ])
    expect(res).toEqual({
      command: 'C:\\Users\\Sunghwan Yoo\\codex.CMD',
      args: ['exec', '--version']
    })
  })

  it('leaves non-batch commands (like shell builtins) under cmd.exe untouched', () => {
    if (process.platform !== 'win32') return
    const res = unwrapForPty('cmd.exe', ['/d', '/c', 'echo agentyard-pty-probe'])
    expect(res).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/c', 'echo agentyard-pty-probe']
    })
  })
})

describe('which', () => {
  it('returns absolute path if file exists', () => {
    expect(which(process.execPath)).toBe(process.execPath)
  })

  it('returns null for non-existent commands', () => {
    expect(which('nonexistent_binary_xyz_12345')).toBeNull()
  })

  it('searches standard Unix bin directories even if PATH is minimal', () => {
    if (process.platform === 'win32') return
    const origPath = process.env.PATH
    try {
      process.env.PATH = '/usr/bin:/bin'
      const agyPath = join(homedir(), '.local', 'bin', 'agy')
      if (existsSync(agyPath)) {
        expect(which('agy')).toBe(agyPath)
      }
    } finally {
      process.env.PATH = origPath
    }
  })
})

describe('spawnEnv', () => {
  it('strips CLAUDE and ANTHROPIC prefixed variables', () => {
    const origClaude = process.env.CLAUDE_TEST_VAR
    const origAnthropic = process.env.ANTHROPIC_API_KEY
    try {
      process.env.CLAUDE_TEST_VAR = 'strip_me'
      process.env.ANTHROPIC_API_KEY = 'strip_me_too'
      const env = spawnEnv()
      expect(env.CLAUDE_TEST_VAR).toBeUndefined()
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      if (origClaude !== undefined) process.env.CLAUDE_TEST_VAR = origClaude
      else delete process.env.CLAUDE_TEST_VAR
      if (origAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropic
      else delete process.env.ANTHROPIC_API_KEY
    }
  })
})