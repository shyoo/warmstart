import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('deploy-local.sh', () => {
  it('finds the repository when invoked through scripts/deploy-local.sh', () => {
    const repo = mkdtempSync(join(tmpdir(), 'warmstart-deploy-'))
    scratch.push(repo)
    const scripts = join(repo, 'scripts')
    mkdirSync(scripts)
    copyFileSync(join(process.cwd(), 'deploy-local.sh'), join(repo, 'deploy-local.sh'))
    writeFileSync(join(scripts, 'build-mac.sh'), '#!/usr/bin/env bash\n')
    chmodSync(join(scripts, 'build-mac.sh'), 0o755)
    symlinkSync('../deploy-local.sh', join(scripts, 'deploy-local.sh'))

    const result = spawnSync('bash', ['-x', join(scripts, 'deploy-local.sh'), '--help'], {
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toContain(`REPO=${repo}`)
  })
})
