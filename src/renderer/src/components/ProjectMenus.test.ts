import { beforeEach, describe, expect, it, vi } from 'vitest'
import { confirmations } from '../lib/confirmation'
import { rpc } from '../lib/daemon'
import { deleteProject, toggleArchive } from './ProjectMenus'

vi.mock('../lib/daemon', () => ({ rpc: vi.fn() }))
const project = { id: 'project', name: 'My project', root: 'repository', archivedAt: null }

beforeEach(() => vi.mocked(rpc).mockReset())
describe('project mutations require an in-app affirmative answer', () => {
  it('does not archive before the click, or when cancelled', async () => {
    const pending = toggleArchive(project)
    expect(rpc).not.toHaveBeenCalled()
    expect(confirmations.snapshot()!.options.message).toContain('branches and stashes are never deleted')
    confirmations.snapshot()!.answer(0)
    expect(await pending).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })
  it('archives only after confirmation', async () => {
    const pending = toggleArchive(project)
    expect(rpc).not.toHaveBeenCalled()
    confirmations.snapshot()!.answer(1)
    await pending
    expect(rpc).toHaveBeenCalledExactlyOnceWith('project.archive', { id: project.id })
  })
  it('unarchives without asking', async () => {
    await toggleArchive({ ...project, archivedAt: 1 })
    expect(confirmations.snapshot()).toBeNull()
    expect(rpc).toHaveBeenCalledExactlyOnceWith('project.unarchive', { id: project.id })
  })
  it('does not delete on cancellation; deletes only after confirmation', async () => {
    const declined = deleteProject(project)
    expect(rpc).not.toHaveBeenCalled()
    confirmations.snapshot()!.answer(0)
    expect(await declined).toBe(false)
    expect(rpc).not.toHaveBeenCalled()
    const accepted = deleteProject(project)
    confirmations.snapshot()!.answer(1)
    expect(await accepted).toBe(true)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('project.delete', { id: project.id })
  })
})
