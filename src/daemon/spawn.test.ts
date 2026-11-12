import { describe, expect, it, vi } from 'vitest'
import type * as childProcess from 'node:child_process'
import { createRun, run } from './spawn.js'

describe('createRun', () => {
  it('defaults windowsHide to true when options are omitted', async () => {
    const mockExec = vi.fn(
      (_file: string, _args: readonly string[], _options: childProcess.ExecFileOptions, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: 'ok', stderr: '' })
      }
    ) as unknown as typeof childProcess.execFile

    const customRun = createRun(mockExec)
    await customRun('node', ['--version'])

    expect(mockExec).toHaveBeenCalled()
    const lastCall = (mockExec as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(lastCall?.[0]).toBe('node')
    expect(lastCall?.[1]).toEqual(['--version'])
    expect(lastCall?.[2]).toMatchObject({ windowsHide: true })
  })

  it('defaults windowsHide to true when options are provided without windowsHide', async () => {
    const mockExec = vi.fn(
      (_file: string, _args: readonly string[], _options: childProcess.ExecFileOptions, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: 'ok', stderr: '' })
      }
    ) as unknown as typeof childProcess.execFile

    const customRun = createRun(mockExec)
    await customRun('node', ['--version'], { timeout: 10_000, maxBuffer: 1024 * 1024 })

    expect(mockExec).toHaveBeenCalled()
    const lastCall = (mockExec as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(lastCall?.[2]).toMatchObject({
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    })
  })

  it('allows overriding windowsHide if explicitly passed', async () => {
    const mockExec = vi.fn(
      (_file: string, _args: readonly string[], _options: childProcess.ExecFileOptions, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: 'ok', stderr: '' })
      }
    ) as unknown as typeof childProcess.execFile

    const customRun = createRun(mockExec)
    await customRun('node', ['--version'], { windowsHide: false })

    expect(mockExec).toHaveBeenCalled()
    const lastCall = (mockExec as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect((lastCall?.[2] as childProcess.ExecFileOptions).windowsHide).toBe(false)
  })

  it('handles invocation without args: run(file, options)', async () => {
    const mockExec = vi.fn(
      (_file: string, _options: childProcess.ExecFileOptions, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: 'ok', stderr: '' })
      }
    ) as unknown as typeof childProcess.execFile

    const customRun = createRun(mockExec)
    await customRun('node', { timeout: 5000 })

    expect(mockExec).toHaveBeenCalled()
    const lastCall = (mockExec as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(lastCall?.[0]).toBe('node')
    expect(lastCall?.[1]).toMatchObject({ windowsHide: true, timeout: 5000 })
  })

  it('handles invocation with only file: run(file)', async () => {
    const mockExec = vi.fn(
      (_file: string, _options: childProcess.ExecFileOptions, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: 'ok', stderr: '' })
      }
    ) as unknown as typeof childProcess.execFile

    const customRun = createRun(mockExec)
    await customRun('node')

    expect(mockExec).toHaveBeenCalled()
    const lastCall = (mockExec as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(lastCall?.[0]).toBe('node')
    expect(lastCall?.[1]).toMatchObject({ windowsHide: true })
  })

  it('executes real commands successfully and returns stdout', async () => {
    const { stdout } = await run(process.execPath, ['-e', 'console.log("spawn-ok")'])
    expect(stdout.trim()).toBe('spawn-ok')
  })
})
