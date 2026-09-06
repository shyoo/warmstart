import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ProjectDocDraft, ProjectDocName } from '@shared/tasks.js'

/**
 * What a directory appears to be built with, and what that suggests running.
 *
 * ⛔ **Pure, and it imports nothing from `projects.ts`.** It is read by the project store (for the
 * starter config) and by the setup flow (for the wizard), and a cycle between the two would be paid
 * for at module load in the daemon's entry path.
 *
 * ⛔ **Everything here is a *proposal*.** The check list is what the verifying finish policies are
 * trusting when they say work was checked — see `setProjectChecks` — so nothing in this file writes
 * anything. It reads a few manifest files, says what it thinks, and a person accepts or edits it.
 * ⚠️ That also means a detector may be conservative at no cost and must never be optimistic: a
 * proposed command that does not exist fails a landing, and a command this file declined to propose
 * costs somebody one line of typing.
 */

/** A stack, its evidence, and the commands worth proposing for it — cheapest first. */
interface Detector {
  id: string
  detect: (root: string) => string[] | null
}

/** Read a file, or answer null. A directory this cannot read is a directory with nothing to say. */
function read(root: string, name: string): string | null {
  try {
    return readFileSync(join(root, name), 'utf8')
  } catch {
    return null
  }
}

function has(root: string, name: string): boolean {
  return existsSync(join(root, name))
}

/** Do any of this directory's own entries match? ⚠️ One level; a recursive walk is not worth it here. */
function anyEntry(root: string, match: (name: string) => boolean): boolean {
  try {
    return readdirSync(root).some(match)
  } catch {
    return false
  }
}

/**
 * ⚠️ Order matters and is not alphabetical: the cheap, fast checks come first so a red one stops the
 * run before the slow ones start. That is the same order `runChecks` executes in.
 */
const NODE_SCRIPT_ORDER = ['typecheck', 'lint', 'test', 'build']

const DETECTORS: Detector[] = [
  {
    id: 'node',
    detect: (root) => {
      const raw = read(root, 'package.json')
      if (raw === null) return null
      try {
        const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> }
        const scripts = parsed.scripts ?? {}
        return NODE_SCRIPT_ORDER.filter((name) => typeof scripts[name] === 'string').map(
          (name) => `npm run ${name}`
        )
      } catch {
        // A `package.json` that does not parse is still evidence this is a node project; it is just
        // not evidence about any particular script.
        return []
      }
    }
  },
  {
    id: 'python',
    detect: (root) => {
      const pyproject = read(root, 'pyproject.toml')
      const requirements = read(root, 'requirements.txt')
      const isPython =
        pyproject !== null ||
        requirements !== null ||
        has(root, 'setup.py') ||
        has(root, 'setup.cfg') ||
        anyEntry(root, (n) => n.endsWith('.py'))
      if (!isPython) return null

      // ⚠️ Declared, not installed. A tool named in the project's own manifest is one the project
      // has decided to use; whether this machine has it is a question for the first run, and
      // proposing it is how somebody finds out they need to install it.
      const declared = `${pyproject ?? ''}\n${requirements ?? ''}`.toLowerCase()
      const checks: string[] = []
      if (declared.includes('ruff')) checks.push('ruff check .')
      if (declared.includes('mypy')) checks.push('mypy .')
      // ⚠️ A `tests/` directory of `test_*.py` is what pytest is *for*, and it is much commoner than
      // a project that names pytest in a requirements file it pins for production.
      const hasTests =
        declared.includes('pytest') ||
        has(root, 'pytest.ini') ||
        (has(root, 'tests') && anyEntry(join(root, 'tests'), (n) => /^test_.*\.py$/.test(n))) ||
        anyEntry(root, (n) => /^test_.*\.py$/.test(n))
      if (hasTests) checks.push('pytest -q')
      return checks
    }
  },
  {
    id: 'rust',
    detect: (root) => {
      if (!has(root, 'Cargo.toml')) return null
      // ⛔ `cargo check` rather than `clippy`: clippy is a separate component that may not be
      // installed, and a proposed check that is not installed fails every landing on the project.
      return ['cargo check', 'cargo test']
    }
  },
  {
    id: 'go',
    detect: (root) => {
      if (!has(root, 'go.mod')) return null
      return ['go vet ./...', 'go test ./...']
    }
  },
  {
    id: 'make',
    detect: (root) => {
      const makefile = read(root, 'Makefile') ?? read(root, 'makefile')
      if (makefile === null) return null
      // ⚠️ Only targets that are actually declared. A `make test` proposed against a Makefile with
      // no `test` target is a landing that fails on "No rule to make target".
      const targets = new Set(
        makefile
          .split('\n')
          .map((line) => /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line)?.[1])
          .filter((t): t is string => typeof t === 'string')
      )
      return ['lint', 'check', 'test'].filter((t) => targets.has(t)).map((t) => `make ${t}`)
    }
  }
]

/** Which stacks this directory shows evidence of, in detector order. */
export function detectStack(root: string): string[] {
  return DETECTORS.filter((d) => d.detect(root) !== null).map((d) => d.id)
}

/**
 * Check commands worth proposing for a project.
 *
 * ⛔ **Proposed, never written.** The check list is what `commit-and-verify` and `commit-and-merge`
 * are trusting when they say work is verified, so it is not something to infer behind somebody's
 * back. This returns a suggestion for a person to accept, edit or ignore.
 *
 * ⚠️ A polyglot repo gets every stack's proposals in detector order, deduplicated. Nothing here
 * tries to decide which stack is "the" one — a repo with a `package.json` and a `tests/` directory
 * full of `test_*.py` has two, and both are worth running.
 */
export function proposeChecks(root: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const detector of DETECTORS) {
    for (const check of detector.detect(root) ?? []) {
      if (seen.has(check)) continue
      seen.add(check)
      out.push(check)
    }
  }
  return out
}

// ------------------------------------------------------------------ the orientation docs

/**
 * Entries that do not make a directory non-empty.
 *
 * ⚠️ `.git` is on this list on purpose: a fresh `git init` is still an *empty project*, and that is
 * precisely the case the scaffolding exists for. The rest are files an operating system or a cloud
 * client put there without being asked.
 */
const IGNORABLE_ENTRIES = new Set(['.git', '.ds_store', 'thumbs.db', 'desktop.ini'])

/** Does this directory hold anything that is somebody's work? */
export function isEmptyProjectDir(root: string): boolean {
  try {
    if (!statSync(root).isDirectory()) return false
    return readdirSync(root).every((name) => IGNORABLE_ENTRIES.has(name.toLowerCase()))
  } catch {
    return false
  }
}

/**
 * The name to open the add form with: what the repo calls itself, then what npm calls it, then the
 * directory's own name. ⚠️ Never empty — `basename` always answers something.
 */
export function suggestProjectName(root: string): string {
  const raw = read(root, 'package.json')
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { name?: unknown }
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        // ⚠️ A scoped package is `@scope/thing`; the project is the thing.
        return parsed.name.trim().replace(/^@[^/]+\//, '')
      }
    } catch {
      // Fall through to the directory name.
    }
  }
  return basename(root) || root
}

/**
 * Starter text for the three files that orient a person and an agent in a project.
 *
 * ⛔ **Templates, not descriptions.** Nothing here claims to know what the project does — the tool
 * has read a manifest and a directory listing, and writing a confident paragraph about a codebase
 * from that is exactly the unsourced sentence this repository's own rules forbid. Every line that
 * would need to be *learned* is a marked TODO, and everything stated as fact is something that was
 * read off the disk or chosen in the form.
 *
 * ⚠️ The drafts are shown in an editable box before anything is written, so what lands is what a
 * person read. That is why the content travels back with the create request rather than being
 * regenerated at write time.
 */
export function proposeDocs(input: {
  root: string
  name: string
  checks: string[]
  landingTarget: string
  /** Which files are missing. ⛔ An existing file is never proposed — it would read as an offer to overwrite it. */
  missing: ProjectDocName[]
}): ProjectDocDraft[] {
  const { name, checks, landingTarget, missing } = input
  const stack = detectStack(input.root)
  const stackLine = stack.length > 0 ? stack.join(', ') : 'not detected'
  const checkList =
    checks.length > 0
      ? checks.map((c) => `- \`${c}\``).join('\n')
      : '- _None declared yet._ Add them in Project → Settings → Verification.'

  const templates: Record<ProjectDocName, string> = {
    'README.md': `# ${name}

> TODO: one sentence on what this project is for, written for somebody who has never seen it.

## What it is

TODO: the high-level overview — the problem it solves, who uses it, and what it is not.

## Getting started

TODO: how to install and run it locally. Detected stack: ${stackLine}.

## Checks

Run these before committing:

${checkList}

## Layout

TODO: the directories that matter and what lives in each. Keep this short; a map, not a manual.

---

Companion docs: [\`AGENTS.md\`](AGENTS.md) for how coding agents work here, and
[\`HANDOFF.md\`](HANDOFF.md) for the current state and what to pick up next.
`,
    'AGENTS.md': `# ${name} — agent guide

How to work in this codebase. Read [\`HANDOFF.md\`](HANDOFF.md) first: it is the only file that
carries current state.

## Before you start

- Detected stack: ${stackLine}.
- TODO: anything an agent cannot infer from the code — a service that must be running, a credential
  that must be present, a directory that is generated and must not be hand-edited.

## Checks

Run these and make them pass before you report done:

${checkList}

## When you commit

- Work on a branch, never directly on \`${landingTarget}\`.
- One coherent commit per task where it is safe to squash; explain *why*, not *what*.
- ⛔ Never commit generated output, dependency directories, credentials, or anything gitignored.
- Update [\`HANDOFF.md\`](HANDOFF.md) in the same commit: what changed, and what is next.

## House rules

- TODO: the conventions this project actually holds — naming, error handling, test placement.
- TODO: the things that have bitten somebody here before. An entry earns its place by having cost
  a real debugging session; delete it when the pitfall becomes impossible.
`,
    'HANDOFF.md': `# ${name} — Handoff

**Current state and what to do next, not a changelog.** Replaced as work lands, never stacked.

## Where things stand

Project added to Multi Agent Controller. Nothing has been worked on through it yet.

- Detected stack: ${stackLine}.
- Checks: ${checks.length > 0 ? checks.map((c) => `\`${c}\``).join(' · ') : 'none declared yet'}.
- Work lands on \`${landingTarget}\`.

## What is unproven

- TODO: what nobody has verified yet, and what would verify it.

## Next

1. TODO: the next thing to pick up, with enough context to start without re-reading the repo.
`
  }

  return missing.map((docName) => ({ name: docName, content: templates[docName] }))
}
