<#
.SYNOPSIS
  Build Multi Agent Controller on Windows: checks, bundle, packaged app, and optionally an installer.

.DESCRIPTION
  A wrapper over the npm scripts, with the three things that actually go wrong on this machine
  handled up front:

  1. Electron 44 ships no postinstall, so `node_modules/electron/dist` can be empty and every suite
     that starts a window fails in a way that reads as a broken build. `ensure-electron.mjs` runs
     first, always.

  2. electron-builder deletes and rewrites its output directory, so a running app - or a daemon left
     behind by an earlier `test:pack` - fails the build with `EBUSY: resource busy or locked, rmdir`.
     This script looks for those processes first and tells you which PIDs to close, or stops them for
     you with -StopDaemon.

  3. Every step used to run from scratch, every time. Steps are now content-addressed: each records a
     SHA-256 over the files it actually reads, and is skipped when that fingerprint is unchanged
     *and* its outputs are still on disk. Measured on this machine 2026-08-26, a full cold run is
     ~95s and the two suites that start the app are two thirds of it (test:daemon 50s, test:ui 12s);
     a warm run that changed nothing is a few seconds of hashing.

  ⛔ The cache is deliberately paranoid, because this repo has already been burnt three times by a
  suite reporting a confident pass for code that was no longer in the tree - which is why
  `checkBuildIsCurrent()` exists in test/lib/harness.mjs. So: fingerprints are over file *content*,
  never mtimes; a stamp is written only after the step exits 0; every stamp carries this script's own
  hash, so editing the build invalidates every key; and a skip is printed with the date the step last
  really ran, rather than passing silently.

  It never runs `npm run test:e2e`: that is the only suite that spends tokens.

.PARAMETER Installer
  Also build the NSIS installer (x64 + arm64) into `release\`. Adds several minutes.

.PARAMETER SkipTests
  Bundle and package without running the suites. For a quick loop only - `test:pack` is the only
  check that can catch a native module left inside the asar.

.PARAMETER Quick
  Typecheck, lint, unit tests and bundle. No packaging.

.PARAMETER Fresh
  Ignore every cached step and rebuild from scratch. Aliases: -NoCache, -Rebuild. Use it when you
  suspect the cache rather than the code - and if that ever turns out to be right, the bug is here
  and it is worth finding, because a build cache you have to distrust is worse than no cache.

.PARAMETER StopDaemon
  Stop this repo's running app and daemon before building, instead of reporting them and exiting.
  Covers the packaged app under `release\` and a dev instance running out of this repo's
  `node_modules\electron\dist` or with one of its `out\` bundles on the command line.

  ⛔ Refuses while the daemon has agent processes under it - see -StopAgents. Windows has no SIGTERM:
  Stop-Process is TerminateProcess, so the daemon's own shutdown - which closes sessions and releases
  claims - does not run, and any agent CLI it spawned is left orphaned, signed in, and able to keep
  spending. That is not something a build script gets to decide on its own.

.PARAMETER StopAgents
  Implies -StopDaemon, and additionally stops the agent CLI processes underneath the daemon instead
  of refusing. ⚠️ This ends real work on a real account mid-run. It is the answer to "I know, do it
  anyway" and nothing else - the default refusal exists because the alternative to stopping them is
  not "they survive", it is "they are orphaned and still spending".

  ⛔ Never by image name, at either level. A process is stopped only if it executes from a path this
  repo owns or is a verified descendant of one that does, and its (pid, creation time) pair is
  re-read at the moment of the kill - a pid read seconds ago can belong to a stranger by now.

.PARAMETER Restart
  Stop what this repo has running, build, then start what was just built. Implies -StopDaemon.

  ⭐ The inner loop, and the only option that guarantees the window in front of you is the binary
  this run produced.

  ⚠️ There is now exactly **one** packaged app in the tree, `release\win-unpacked\`, and every
  step here writes it. The second copy under release\suite\ is gone (2026-08-27): it existed so
  packaging could not collide with an app being run from the repo, and the app to *use* is the one
  the installer installs. ⛔ Which means running release\win-unpacked\ while building will block
  the pack step - correctly. Install the app if you want one you can keep open.

  ⚠️ Nothing to start under -Quick, which bundles but packages nothing; it says so rather than
  starting yesterday's app.

.PARAMETER Help
  Print the options, grouped by the question being asked, and exit. Aliases: -h, -?.
  `Get-Help .\scripts\build-win.ps1 -Full` has the reasoning behind each.

.EXAMPLE
  .\scripts\build-win.ps1 -Help
  The options, grouped by what you are trying to decide.

.EXAMPLE
  .\scripts\build-win.ps1 -Restart
  The inner loop: stop what is running, build, start the result.

.EXAMPLE
  .\scripts\build-win.ps1
  Checks, bundle, packaged app, and drive it. ~92s cold, seconds when nothing changed.

.EXAMPLE
  .\scripts\build-win.ps1 -StopAgents
  The above, after stopping whatever this repo has running - including live agent work.

.EXAMPLE
  .\scripts\build-win.ps1 -Installer
  The above, plus "release\Multi Agent Controller Setup <version>.exe".

.EXAMPLE
  .\scripts\build-win.ps1 -Quick
  Fast inner loop: types, lint, unit tests, bundle.

.EXAMPLE
  .\scripts\build-win.ps1 -Fresh
  Every step, from scratch, ignoring the cache.
#>
[CmdletBinding()]
param(
  [switch]$Installer,
  [switch]$SkipTests,
  [switch]$Quick,
  [Alias('NoCache', 'Rebuild')]
  [switch]$Fresh,
  [Alias('Force', 'ForceKill')]
  [switch]$StopDaemon,
  [switch]$StopAgents,
  [switch]$Restart,
  [Alias('h', '?')]
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# ---------------------------------------------------------------- -Help
#
# ⚠️ A hand-written summary rather than `Get-Help`, and the difference is the point: comment-based
# help prints the parameters in declaration order with their prose, which is a reference. This
# groups them by the question you are actually asking - how much do I build, what do I do about
# what is running, what do I run afterwards - and that is what somebody typing -Help wants.
if ($Help) {
  Write-Host ""
  Write-Host "  build-win.ps1 - build Multi Agent Controller on Windows" -ForegroundColor Green
  Write-Host "  Checks, bundle, packaged app, drive it. ~92s cold; seconds when nothing changed."
  Write-Host ""
  Write-Host "  HOW MUCH TO BUILD" -ForegroundColor Cyan
  Write-Host "    (none)         types, lint, unit, bundle, suites, package, drive the package"
  Write-Host "    -Quick         types, lint, unit, bundle. Packages nothing"
  Write-Host "    -SkipTests     bundle and package, no suites. ⛔ test:pack is the only check that"
  Write-Host "                   catches a native module left inside the asar"
  Write-Host "    -Installer     also build the NSIS installer into release\. Adds several minutes"
  Write-Host ""
  Write-Host "  THE STEP CACHE" -ForegroundColor Cyan
  Write-Host "    (default)      each step is skipped when a SHA-256 of the files it reads is"
  Write-Host "                   unchanged and its outputs are still on disk"
  Write-Host "    -Fresh         ignore the cache and rebuild everything.  Alias: -NoCache, -Rebuild"
  Write-Host ""
  Write-Host "  WHAT IS ALREADY RUNNING" -ForegroundColor Cyan
  Write-Host "    (default)      report the PIDs holding the output directory, and stop"
  Write-Host "    -StopDaemon    stop this repo's app and daemon first.  Alias: -Force, -ForceKill"
  Write-Host "                   ⛔ refuses while agent CLIs are running under the daemon"
  Write-Host "    -StopAgents    ...and stop those agent CLIs too. ⚠️ ends real work on a real"
  Write-Host "                   account mid-run. Implies -StopDaemon"
  Write-Host ""
  Write-Host "  AFTERWARDS" -ForegroundColor Cyan
  Write-Host "    -Restart       stop what is running, build, then start what was just built."
  Write-Host "                   Implies -StopDaemon. ⭐ This is the inner loop: it is the only"
  Write-Host "                   option that guarantees you are running the binary you just made"
  Write-Host "    -Help          this.  Alias: -h, -?"
  Write-Host ""
  Write-Host "  EXAMPLES" -ForegroundColor Cyan
  Write-Host "    .\scripts\build-win.ps1 -Restart          build and run the result" -ForegroundColor DarkGray
  Write-Host "    .\scripts\build-win.ps1 -Quick            fast inner loop, no packaging" -ForegroundColor DarkGray
  Write-Host "    .\scripts\build-win.ps1 -Installer -Restart   build the installer too" -ForegroundColor DarkGray
  Write-Host "    .\scripts\build-win.ps1 -Fresh            distrust the cache" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  Get-Help .\scripts\build-win.ps1 -Full has the reasoning behind each of these." -ForegroundColor DarkGray
  Write-Host ""
  exit 0
}

# -StopAgents is an escalation of -StopDaemon, not an alternative to it; -Restart has to clear the
# way before it can build, and would be useless without doing so.
if ($StopAgents -or $Restart) { $StopDaemon = $true }

$started = Get-Date
$step = 0
$ranCount = 0
$skippedCount = 0

function Step($name) {
  $script:step++
  Write-Host ""
  Write-Host "==> [$script:step] $name" -ForegroundColor Cyan
}

function Run($command) {
  Write-Host "    $command" -ForegroundColor DarkGray
  # ⛔ /d /c, never /d /s /c. `/s` makes cmd strip the outer quotes and take the rest literally, which
  # splits any path containing a space - and the Windows default home has one. See AGENTS.md.
  & cmd /d /c $command
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "FAILED: $command (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

# ================================================================ the step cache
#
# A step is identified by what it reads, not by when it last ran. Get-Fingerprint hashes the content
# of every input file; Invoke-Step skips the body when that hash matches the recorded one and the
# step's declared outputs are still present.
#
# ⚠️ Bump $cacheSchema whenever the *meaning* of a stamp changes - a new input set, a different hash,
# a step that starts producing something else. Old stamps are then ignored rather than believed,
# which is the difference between a cache and a trap.
$cacheDir = Join-Path $repo '.build-cache'
$cacheSchema = 1

if ($Fresh -and (Test-Path $cacheDir)) {
  Remove-Item $cacheDir -Recurse -Force -ErrorAction SilentlyContinue
}

<#
  Hash the content of a set of inputs. Each entry is a repo-relative file or directory; directories
  are walked recursively.

  ⛔ Content, not mtime, and the reason is specific rather than fastidious. `npm run build` rewrites
  out\ unconditionally, git restores files with a fresh mtime, and electron-builder touches what it
  copies - an mtime cache would either invalidate on every checkout or miss a real change, and the
  second of those is the failure this repo has actually had. Hashing ~100 files costs milliseconds
  against the 50s suite it decides.

  A missing input hashes as the literal string "missing", so deleting a file is a change.
#>
function Get-Fingerprint([string[]]$inputs) {
  $lines = [System.Text.StringBuilder]::new()
  foreach ($rel in ($inputs | Sort-Object)) {
    $full = Join-Path $repo $rel
    if (-not (Test-Path $full)) {
      [void]$lines.AppendLine("$rel|missing")
      continue
    }
    $item = Get-Item -LiteralPath $full
    $files = if ($item.PSIsContainer) {
      Get-ChildItem -LiteralPath $full -Recurse -File -ErrorAction SilentlyContinue | Sort-Object FullName
    }
    else { @($item) }
    foreach ($f in $files) {
      $name = $f.FullName.Substring($repo.Length + 1).Replace('\', '/')
      $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
      [void]$lines.AppendLine("$name|$($f.Length)|$hash")
    }
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($lines.ToString())
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') }
  finally { $sha.Dispose() }
}

function Get-Stamp([string]$name) {
  $path = Join-Path $cacheDir "$name.json"
  if (-not (Test-Path $path)) { return $null }
  try { return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch { return $null }
}

function Save-Stamp([string]$name, [string]$key) {
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  @{ schema = $cacheSchema; key = $key; at = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $cacheDir "$name.json") -Encoding UTF8
}

<#
  Run a step, or say why it was not run.

  -Outputs are repo-relative paths (wildcards allowed) that the step is claimed to produce. They are
  checked on a cache hit, so deleting out\ or release\ by hand re-runs the step that fills it rather
  than reporting a skip over an empty directory.

  ⛔ Save-Stamp is reached only if the body returns, and Run exits the process on a non-zero exit
  code. A failing step therefore never records a stamp, and the next run repeats it.
#>
function Invoke-Step {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Title,
    [string[]]$Inputs = @(),
    [string[]]$Outputs = @(),
    [Parameter(Mandatory)][scriptblock]$Body
  )

  Step $Title

  # This script's own hash is in every key: change the build and every step is stale, which is the
  # only honest answer when the thing that decides what a step *is* has changed.
  $key = Get-Fingerprint (@($Inputs) + @('scripts/build-win.ps1'))
  $stamp = Get-Stamp $Name
  $missing = @($Outputs | Where-Object { -not (Test-Path (Join-Path $repo $_)) })

  if (-not $Fresh -and $stamp -and $stamp.schema -eq $cacheSchema -and $stamp.key -eq $key -and $missing.Count -eq 0) {
    $when = try { ([datetime]$stamp.at).ToString('yyyy-MM-dd HH:mm:ss') } catch { $stamp.at }
    Write-Host "    skipped - inputs unchanged since $when" -ForegroundColor DarkGray
    $script:skippedCount++
    return
  }

  if ($stamp -and $missing.Count -gt 0) {
    Write-Host ("    output missing ({0}) - running anyway" -f ($missing -join ', ')) -ForegroundColor DarkGray
  }

  & $Body
  Save-Stamp $Name $key
  $script:ranCount++
}

# The input sets, named once. A step whose inputs are wrong is a step that reports a pass for
# something it never looked at.
$LOCK = 'package-lock.json'   # stands in for node_modules; hashing 11MB of @lydell does not pay
$TSCONFIGS = @('tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json')
$BUNDLE_IN = @('src', 'costmodels', 'electron.vite.config.ts', 'package.json', $LOCK) + $TSCONFIGS
$PACK_IN = @('out', 'electron-builder.yml', 'package.json', 'resources', $LOCK)

# What `electron-vite build` is expected to leave behind. Hash-suffixed chunk names are deliberately
# not listed - these five are the entry points, and their absence is what a half-written out\ looks
# like. `orchestratord.js` is the daemon; `agentyard-mcp.js` keeps the internal name (AGENTS.md).
$BUNDLE_OUT = @(
  'out/main/index.js', 'out/main/orchestratord.js', 'out/main/agentyard-mcp.js',
  'out/preload/index.cjs', 'out/renderer/index.html'
)
$PACKED_APP = 'release/win-unpacked/Multi Agent Controller.exe'

# ================================================================ stopping what is running
#
# ⛔ Nothing here is found by image name. "Multi Agent Controller.exe" and "electron.exe" are shared
# with the user's editor, their other agent windows, and every other Electron app on the machine.
# Ownership is proved by path: a process executing out of this repo's release\, out of this repo's
# node_modules\electron\dist, or with one of this repo's out\ bundles on its command line, is this
# build's own output by definition.

function Get-RepoProcesses {
  $sep = [IO.Path]::DirectorySeparatorChar
  $releaseDir = (Join-Path $repo 'release') + $sep
  $devElectron = (Join-Path $repo 'node_modules\electron\dist') + $sep
  $outBundle = (Join-Path $repo 'out') + $sep

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.ExecutablePath -and (
        $_.ExecutablePath.StartsWith($releaseDir, 'OrdinalIgnoreCase') -or
        $_.ExecutablePath.StartsWith($devElectron, 'OrdinalIgnoreCase'))) -or
    ($_.CommandLine -and $_.CommandLine.IndexOf($outBundle, [StringComparison]::OrdinalIgnoreCase) -ge 0)
  }
}

function Get-Descendants($rootPids) {
  $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
  $found = @()
  $frontier = @($rootPids)
  while ($frontier.Count -gt 0) {
    $children = $all | Where-Object { $frontier -contains $_.ParentProcessId }
    $children = $children | Where-Object { $found.ProcessId -notcontains $_.ProcessId }
    if (-not $children) { break }
    $found += $children
    $frontier = @($children.ProcessId)
  }
  return $found
}

<#
  Stop one process, but only if it is still the same process.

  ⛔ Pids are recycled. The one read a few seconds ago can have exited and had its number handed to
  something else, and a kill firing late then takes out a stranger. Re-read the row and compare the
  creation time - a (pid, creation time) pair is unique for as long as it matters.
#>
function Stop-Verified($proc, [string]$why) {
  $now = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ProcessId)" -ErrorAction SilentlyContinue
  if ($null -eq $now) { return }
  if ($now.CreationDate -ne $proc.CreationDate) {
    Write-Host ("  PID {0} is a different process now - leaving it alone" -f $proc.ProcessId) -ForegroundColor DarkGray
    return
  }
  $what = if ($now.ExecutablePath) { $now.ExecutablePath } else { $now.Name }
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host ("  stopped {0,-7} {1}  ({2})" -f $proc.ProcessId, $what, $why) -ForegroundColor DarkGray
}

function Stop-RepoProcesses {
  $holders = @(Get-RepoProcesses)
  if ($holders.Count -eq 0) {
    Write-Host "    nothing of this repo's is running" -ForegroundColor DarkGray
    return
  }

  Write-Host "This repo has these running:" -ForegroundColor Yellow
  foreach ($p in $holders) {
    Write-Host ("  PID {0,-7} started {1}  {2}" -f $p.ProcessId, $p.CreationDate, $p.ExecutablePath)
  }

  # Anything under the daemon that is not itself one of ours is an agent CLI: a real process doing
  # real work on somebody's account.
  $ours = @($holders.ProcessId)
  $descendants = @(Get-Descendants $ours)
  $agents = @($descendants | Where-Object { $ours -notcontains $_.ProcessId })

  if ($agents.Count -gt 0 -and -not $StopAgents) {
    Write-Host ""
    Write-Host "REFUSING to stop it: the daemon has live work under it." -ForegroundColor Red
    foreach ($p in $agents) {
      $what = if ($p.ExecutablePath) { $p.ExecutablePath } else { $p.CommandLine }
      Write-Host ("  PID {0,-7} {1}" -f $p.ProcessId, $what) -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "Those are agent processes, not part of the build. Windows has no SIGTERM, so stopping" -ForegroundColor Yellow
    Write-Host "the daemon will NOT stop them - they would be left orphaned and still able to spend." -ForegroundColor Yellow
    Write-Host "Cancel or finish the running task first, or re-run with -StopAgents to stop them too." -ForegroundColor Yellow
    exit 1
  }

  Write-Host ""
  Write-Host "Stopping..." -ForegroundColor Yellow

  # Children first, so nothing re-parents onto a live tree and outlives the sweep.
  foreach ($p in $agents) { Stop-Verified $p 'agent under this repo (-StopAgents)' }
  foreach ($p in ($descendants | Where-Object { $ours -contains $_.ProcessId })) { Stop-Verified $p 'this build' }
  foreach ($p in $holders) { Stop-Verified $p 'this build' }

  Start-Sleep -Milliseconds 700
  $left = @(Get-RepoProcesses)
  if ($left.Count -gt 0) {
    Write-Host "Still running after the stop:" -ForegroundColor Red
    foreach ($p in $left) { Write-Host ("  PID {0,-7} {1}" -f $p.ProcessId, $p.ExecutablePath) -ForegroundColor Red }
    exit 1
  }

  Write-Host "⚠️  The daemon was terminated, not asked to stop, so its sessions were never marked" -ForegroundColor DarkGray
  Write-Host "    closed. The next start reconciles orphans, claims and tasks - that path exists" -ForegroundColor DarkGray
  Write-Host "    precisely because a daemon can die without warning." -ForegroundColor DarkGray
}

<#
  Who is holding the directory electron-builder is about to delete?

  ⛔ Ask about the directory that is actually being rewritten, and nothing more - and say **whose**
  the process is rather than assuming it is stale. Every step here writes release\, so a running
  app from release\win-unpacked\ genuinely does block a build now: that is the cost of dropping
  the second copy, and it is paid by installing the app rather than running it from the repo.

  ⛔ Reports PIDs; it does not kill anything unless you asked for that with -StopDaemon. Only you
  know whether that window matters.
#>
# ⚠️ -Except is gone with release\suite\: it existed to carve one subdirectory out of the guard,
# and with a single output directory there is nothing to carve. A parameter no caller passes is a
# claim that some caller might.
function Assert-OutputIsFree([string]$relative) {
  $dir = Join-Path $repo $relative
  if (-not (Test-Path $dir)) { return }
  $prefix = $dir + [IO.Path]::DirectorySeparatorChar

  $holders = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $path = $_.ExecutablePath
      if (-not $path) { return $false }
      return $path.StartsWith($prefix, 'OrdinalIgnoreCase')
    })
  if ($holders.Count -eq 0) { return }

  Write-Host ""
  Write-Host "The build cannot replace $relative\ while these are running:" -ForegroundColor Yellow
  foreach ($p in $holders) {
    Write-Host ("  PID {0,-7} started {1}  {2}" -f $p.ProcessId, $p.CreationDate, $p.ExecutablePath)
  }
  Write-Host ""
  Write-Host "Stop those PIDs, then run this again - or re-run with -StopDaemon." -ForegroundColor Yellow
  Write-Host "  Stop-Process -Id $($holders.ProcessId -join ',')" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "⚠️  Closing the window is not enough. orchestratord is spawned detached and outlives" -ForegroundColor DarkGray
  Write-Host "    the UI on purpose - the whole premise is unattended progress across quota windows" -ForegroundColor DarkGray
  Write-Host "    that are hours long. A daemon stranded by an earlier test:pack looks the same." -ForegroundColor DarkGray
  Write-Host "⛔  Stop it by PID. Never by image name: 'Multi Agent Controller.exe' and 'electron.exe'" -ForegroundColor DarkGray
  Write-Host "    are shared with other apps and other agent windows." -ForegroundColor DarkGray
  exit 1
}

<#
  Refuse to package a bundle older than the source it claims to be.

  This is `checkBuildIsCurrent()` from test/lib/harness.mjs, applied one stage earlier. It exists
  because this script now calls electron-builder directly rather than through `npm run pack`, which
  would have re-run `npm run build` for it - that rebuild was the guarantee, and dropping it means
  stating the guarantee out loud instead of assuming it.
#>
function Assert-BundleIsCurrent {
  $newest = {
    param($dir)
    $path = Join-Path $repo $dir
    if (-not (Test-Path $path)) { return $null }
    (Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue |
      Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
  }
  $built = & $newest 'out'
  $source = & $newest 'src'
  if ($null -eq $built) {
    Write-Host "No out\ to package - run without -SkipTests, or `npm run build` first." -ForegroundColor Red
    exit 1
  }
  if ($source -and $built -lt $source) {
    Write-Host ""
    Write-Host "⛔ STALE: out\ was built $built but src\ changed $source." -ForegroundColor Red
    Write-Host "   Packaging this would ship code that is no longer in the tree. Re-run with -Fresh." -ForegroundColor Red
    exit 1
  }
}

# ================================================================ the build
Write-Host "Multi Agent Controller - Windows build" -ForegroundColor Green
Write-Host "repo: $repo" -ForegroundColor DarkGray
if ($Fresh) { Write-Host "cache: ignored (-Fresh)" -ForegroundColor DarkGray }

if ($StopDaemon) {
  Step "Stop this repo's app and daemon"
  Stop-RepoProcesses
}

# Not cached: 0.2s when the dist is already there, and it is the one check whose whole job is to
# notice that something outside this repo changed underneath it.
Step "Electron runtime (it does not download itself)"
Run "node scripts/ensure-electron.mjs"

if (-not $SkipTests) {
  Invoke-Step -Name 'typecheck' -Title 'Types' -Inputs (@('src') + $TSCONFIGS + @($LOCK)) -Body {
    Run "npm run typecheck"
  }

  Invoke-Step -Name 'lint' -Title 'Lint' -Inputs @('src', 'test', 'scripts', 'eslint.config.js', $LOCK) -Body {
    Run "npm run lint"
  }

  Invoke-Step -Name 'unit' -Title 'Unit tests' -Inputs @('src', 'test', 'costmodels', 'vitest.config.ts', $LOCK) -Body {
    Run "npm test"
  }
}

Invoke-Step -Name 'bundle' -Title 'Bundle' -Inputs $BUNDLE_IN -Outputs $BUNDLE_OUT -Body {
  Run "npm run build"
}

if ($Quick) {
  Write-Host ""
  Write-Host ("Done in {0:n0}s ({1} ran, {2} skipped). Bundle only - nothing was packaged." -f `
    ((Get-Date) - $started).TotalSeconds, $ranCount, $skippedCount) -ForegroundColor Green
  Write-Host "Run without -Quick to package, or with -Installer to build the .exe." -ForegroundColor DarkGray
  exit 0
}

if (-not $SkipTests) {
  # ⚠️ The two most expensive steps in the script - 50s and 12s measured 2026-08-26 - and so both the
  # most to gain from a cache and the most to lose from a wrong one. Both drive out\, so both are
  # keyed on it: a bundle that did not change cannot make them say something new.
  Invoke-Step -Name 'test-daemon' -Title 'Daemon suite' -Inputs @('out', 'test', $LOCK) -Body {
    Run "npm run test:daemon"
  }
  Invoke-Step -Name 'test-ui' -Title 'UI suite' -Inputs @('out', 'test', $LOCK) -Body {
    Run "npm run test:ui"
  }
}

Invoke-Step -Name 'pack' -Title 'Packaged app' -Inputs $PACK_IN -Outputs @($PACKED_APP) -Body {
  Assert-BundleIsCurrent
  Assert-OutputIsFree 'release'
  # ⛔ electron-builder directly, not `npm run pack`, because that script re-runs `npm run build` -
  # the redundancy this cache exists to remove. Assert-BundleIsCurrent above is what replaces it.
  Run "npx --no-install electron-builder --dir"
}

if (-not $SkipTests) {
  # ⛔ The only suite that can catch a native left inside the asar, an app that cannot start its own
  # daemon, or a PTY that will not open. Everything above passes in all three of those cases.
  Invoke-Step -Name 'test-pack' -Title 'Drive the packaged app' -Inputs @('out', 'test', 'electron-builder.yml', $LOCK) -Body {
    Run "npm run test:pack"
  }
}

if ($Installer) {
  Invoke-Step -Name 'installer' -Title 'Installer' -Inputs $PACK_IN -Outputs @('release/*Setup*.exe') -Body {
    Assert-BundleIsCurrent
    Assert-OutputIsFree 'release'
    Run "npx --no-install electron-builder --win"
  }
}

# ---------------------------------------------------------------- what came out
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$elapsed = ((Get-Date) - $started).TotalSeconds

Write-Host ""
Write-Host ("Done in {0:n0}s. Version {1}. {2} step(s) ran, {3} skipped as unchanged." -f `
    $elapsed, $version, $ranCount, $skippedCount) -ForegroundColor Green
if ($skippedCount -gt 0) {
  Write-Host "  -Fresh rebuilds everything, ignoring the cache." -ForegroundColor DarkGray
}

$packed = Join-Path $repo ($PACKED_APP -replace '/', '\')
if (Test-Path $packed) {
  $i = Get-Item $packed
  Write-Host ("  app        {0}  ({1:n1} MB, {2})" -f $i.FullName, ($i.Length / 1MB), $i.LastWriteTime)
}

Get-ChildItem (Join-Path $repo 'release') -Filter '*.exe' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like '*Setup*' } |
  ForEach-Object {
    Write-Host ("  installer  {0}  ({1:n0} MB, {2})" -f $_.FullName, ($_.Length / 1MB), $_.LastWriteTime)
  }

Write-Host ""
Write-Host "⚠️  Unsigned by design - SmartScreen will warn on the installer. That is the honest state" -ForegroundColor DarkGray
Write-Host "    of a pre-alpha, not a build failure." -ForegroundColor DarkGray

# ---------------------------------------------------------------- one packaged app
#
# ⚠️ There used to be two, and a block here whose whole job was to say which of them was stale.
# `release\suite\win-unpacked\` is gone as of 2026-08-27, so the question it answered no longer
# exists: every step writes `release\win-unpacked\` and it is always the thing this run produced.
# ⛔ If a second copy ever comes back, this warning comes back with it - a tree with two identical
# executables and no way to tell them apart cost somebody 98 minutes of debugging a change that
# had in fact taken effect.

if ($Restart -and $Quick) {
  # ⚠️ -Quick packages nothing, so there is no new binary to start. Starting the old one would be
  # the exact confusion -Restart exists to remove.
  Write-Host ""
  Write-Host "⚠️  -Restart had nothing to start: -Quick bundles but packages nothing." -ForegroundColor Yellow
  Write-Host "    Run without -Quick to package, then restart." -ForegroundColor DarkGray
}
elseif ($Restart) {
  Write-Host ""
  if (-not (Test-Path $newApp)) {
    Write-Host "⚠️  -Restart found nothing to start at $newApp." -ForegroundColor Yellow
  }
  else {
    Write-Host "Starting what was just built..." -ForegroundColor Cyan
    Write-Host "  $newApp" -ForegroundColor DarkGray
    $proc = Start-Process -FilePath $newApp -PassThru
    Write-Host ("  started PID {0}" -f $proc.Id) -ForegroundColor DarkGray
    Write-Host "⚠️  It is now holding that directory, and orchestratord outlives the window it opens." -ForegroundColor DarkGray
    Write-Host "    The next build needs -Restart again, or -StopDaemon." -ForegroundColor DarkGray
  }
}
else {
  Write-Host ""
  Write-Host "To run what you just built:" -ForegroundColor Cyan
  Write-Host "  & '$newApp'" -ForegroundColor DarkGray
  Write-Host "⭐  Or let the script do it: -Restart stops what is running, rebuilds, and starts the" -ForegroundColor DarkGray
  Write-Host "    result - the only way to be sure you are looking at the binary you just made." -ForegroundColor DarkGray
}
