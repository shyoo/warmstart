<#
.SYNOPSIS
  Build Multi Agent Controller on Windows: checks, bundle, packaged app, and optionally an installer.

.DESCRIPTION
  A wrapper over the npm scripts, with the two things that actually go wrong on this machine handled
  up front:

  1. Electron 44 ships no postinstall, so `node_modules/electron/dist` can be empty and every suite
     that starts a window fails in a way that reads as a broken build. `ensure-electron.mjs` runs
     first, always.

  2. electron-builder deletes and rewrites `release\`, so a running app - or a daemon left behind by
     an earlier `test:pack` - fails the build with `EBUSY: resource busy or locked, rmdir`. This
     script looks for those processes first and tells you which PIDs to close.

  It never runs `npm run test:e2e`: that is the only suite that spends tokens.

.PARAMETER Installer
  Also build the NSIS installer (x64 + arm64). Adds several minutes.

.PARAMETER SkipTests
  Bundle and package without running the suites. For a quick loop only - `test:pack` is the only
  check that can catch a native module left inside the asar.

.PARAMETER StopDaemon
  Stop a running app or daemon that is holding `release\`, instead of reporting it and exiting.

  ⛔ Refuses while the daemon has agent processes under it. Windows has no SIGTERM: Stop-Process is
  TerminateProcess, so the daemon's own shutdown - which closes sessions and releases claims - does
  not run, and any agent CLI it spawned is left orphaned, signed in, and able to keep spending. That
  is not something a build script gets to decide.

.PARAMETER Quick
  Typecheck, lint, unit tests and bundle. No packaging.

.EXAMPLE
  .\scripts\build-win.ps1
  Checks, bundle, packaged app, and drive it. About 5 minutes.

.EXAMPLE
  .\scripts\build-win.ps1 -Installer
  The above, plus "release\Multi Agent Controller Setup <version>.exe".

.EXAMPLE
  .\scripts\build-win.ps1 -Quick
  Fast inner loop: types, lint, unit tests, bundle.
#>
[CmdletBinding()]
param(
  [switch]$Installer,
  [switch]$SkipTests,
  [switch]$Quick,
  [Alias('Force', 'ForceKill')]
  [switch]$StopDaemon
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$started = Get-Date
$step = 0

function Step($name) {
  $script:step++
  Write-Host ""
  Write-Host "==> [$script:step] $name" -ForegroundColor Cyan
}

function Run($command) {
  Write-Host "    $command" -ForegroundColor DarkGray
  & cmd /d /c $command
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "FAILED: $command (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

# ---------------------------------------------------------------- -StopDaemon
#
# Everything under the repo's own release\ directory is, by definition, this build's output - which
# is what makes stopping it by verified path defensible where "kill anything called electron.exe"
# never is.
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

function Stop-Holders($holders, $releaseDir) {
  # ⛔ The refusal that matters. A daemon with an agent CLI under it is doing real work on somebody's
  # account. TerminateProcess does not run the daemon's shutdown, so those agents are not stopped
  # with it - they are orphaned, still signed in, and still able to spend. Losing that is the
  # user's call to make, with the facts in front of them.
  $descendants = Get-Descendants @($holders.ProcessId)
  $foreign = $descendants | Where-Object {
    -not ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($releaseDir, 'OrdinalIgnoreCase'))
  }

  if ($foreign) {
    Write-Host ""
    Write-Host "REFUSING to stop it: the daemon has live work under it." -ForegroundColor Red
    foreach ($p in $foreign) {
      Write-Host ("  PID {0,-7} {1}" -f $p.ProcessId, $p.ExecutablePath) -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "Those are agent processes, not part of the build. Windows has no SIGTERM, so stopping" -ForegroundColor Yellow
    Write-Host "the daemon will NOT stop them - they would be left orphaned and still able to spend." -ForegroundColor Yellow
    Write-Host "Cancel or finish the running task first, or stop those PIDs yourself if you mean to." -ForegroundColor Yellow
    exit 1
  }

  Write-Host ""
  Write-Host "Stopping (-StopDaemon)..." -ForegroundColor Yellow

  # Children first, so nothing re-parents onto a live tree, and re-verified at the moment of the
  # kill: a pid read seconds ago can belong to something else by now.
  foreach ($p in @($descendants) + @($holders)) {
    $now = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ProcessId)" -ErrorAction SilentlyContinue
    if ($null -eq $now) { continue }
    if (-not ($now.ExecutablePath -and $now.ExecutablePath.StartsWith($releaseDir, 'OrdinalIgnoreCase'))) {
      Write-Host ("  PID {0} is no longer this build's - leaving it alone" -f $p.ProcessId) -ForegroundColor DarkGray
      continue
    }
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host ("  stopped {0}  {1}" -f $p.ProcessId, $now.ExecutablePath) -ForegroundColor DarkGray
  }

  Start-Sleep -Milliseconds 700
  $left = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($releaseDir, 'OrdinalIgnoreCase') }
  if ($left) {
    Write-Host "Still holding release\ after the stop:" -ForegroundColor Red
    foreach ($p in $left) { Write-Host ("  PID {0}" -f $p.ProcessId) -ForegroundColor Red }
    exit 1
  }

  Write-Host "⚠️  The daemon was terminated, not asked to stop, so its sessions were never marked" -ForegroundColor DarkGray
  Write-Host "    closed. The next start reconciles orphans, claims and tasks - that path exists" -ForegroundColor DarkGray
  Write-Host "    precisely because a daemon can die without warning." -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- who is holding release\ ?
#
# ⛔ Reports PIDs; it does not kill anything. Killing by image name would take out the user's other
# Electron apps, and killing a bare pid is how you kill a stranger that inherited the number. Only
# you know whether that window matters.
function Assert-ReleaseIsFree {
  $releaseDir = Join-Path $repo 'release'
  if (-not (Test-Path $releaseDir)) { return }

  $holders = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($releaseDir, 'OrdinalIgnoreCase') }

  if (-not $holders) { return }

  Write-Host ""
  Write-Host "The build cannot replace release\ while these are running:" -ForegroundColor Yellow
  foreach ($p in $holders) {
    Write-Host ("  PID {0,-7} started {1}  {2}" -f $p.ProcessId, $p.CreationDate, $p.ExecutablePath)
  }

  if ($StopDaemon) {
    Stop-Holders $holders $releaseDir
    return
  }

  Write-Host ""
  Write-Host "Stop those PIDs, then run this again." -ForegroundColor Yellow
  Write-Host "  Stop-Process -Id $($holders.ProcessId -join ',')" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "⚠️  Closing the window is not enough. orchestratord is spawned detached and outlives" -ForegroundColor DarkGray
  Write-Host "    the UI on purpose - the whole premise is unattended progress across quota windows" -ForegroundColor DarkGray
  Write-Host "    that are hours long. A daemon stranded by an earlier test:pack looks the same." -ForegroundColor DarkGray
  Write-Host "⛔  Stop it by PID. Never by image name: 'Multi Agent Controller.exe' and 'electron.exe'" -ForegroundColor DarkGray
  Write-Host "    are shared with other apps and other agent windows." -ForegroundColor DarkGray
  exit 1
}

Write-Host "Multi Agent Controller - Windows build" -ForegroundColor Green
Write-Host "repo: $repo" -ForegroundColor DarkGray

Step "Electron runtime (it does not download itself)"
Run "node scripts/ensure-electron.mjs"

if (-not $SkipTests) {
  Step "Types and lint"
  Run "npm run typecheck"
  Run "npm run lint"

  Step "Unit tests"
  Run "npm test"
}

Step "Bundle"
Run "npm run build"

if ($Quick) {
  Write-Host ""
  Write-Host ("Done in {0:n0}s. Bundle only - nothing was packaged." -f ((Get-Date) - $started).TotalSeconds) -ForegroundColor Green
  Write-Host "Run without -Quick to package, or with -Installer to build the .exe." -ForegroundColor DarkGray
  exit 0
}

if (-not $SkipTests) {
  Step "Daemon and UI suites"
  Run "npm run test:daemon"
  Run "npm run test:ui"
}

Step "Packaged app"
Assert-ReleaseIsFree
Run "npm run pack"

if (-not $SkipTests) {
  Step "Drive the packaged app"
  # ⛔ The only suite that can catch a native left inside the asar, an app that cannot start its own
  # daemon, or a PTY that will not open. Everything above passes in all three of those cases.
  Run "npm run test:pack"
}

if ($Installer) {
  Step "Installer"
  Assert-ReleaseIsFree
  Run "npm run dist:win"
}

# ---------------------------------------------------------------- what came out
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$elapsed = ((Get-Date) - $started).TotalSeconds

Write-Host ""
Write-Host ("Done in {0:n0}s. Version {1}." -f $elapsed, $version) -ForegroundColor Green

$app = Join-Path $repo 'release\win-unpacked\Multi Agent Controller.exe'
if (Test-Path $app) {
  $i = Get-Item $app
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
Write-Host ""
Write-Host "To run what you just built:" -ForegroundColor Cyan
Write-Host "  & '$app'" -ForegroundColor DarkGray
