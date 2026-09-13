#!/usr/bin/env bash
#
# build-mac.sh - Build Warmstart on macOS: checks, bundle, packaged app, and optionally an installer.
#
# Equivalent to scripts/build-win.ps1 for macOS:
#  - Content-addressed step caching (.build-cache/)
#  - Safe process inspection and stopping (guards against killing unrelated processes)
#  - Options for --quick, --skip-tests, --installer, --fresh, --stop-daemon, --restart
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# ---------------------------------------------------------------- Parameters
INSTALLER=0
SKIP_TESTS=0
QUICK=0
FRESH=0
STOP_DAEMON=0
STOP_AGENTS=0
RESTART=0
HELP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --installer|-i)
      INSTALLER=1
      shift
      ;;
    --skip-tests|-s)
      SKIP_TESTS=1
      shift
      ;;
    --quick|-q)
      QUICK=1
      shift
      ;;
    --fresh|-f|--no-cache|--rebuild)
      FRESH=1
      shift
      ;;
    --stop-daemon)
      STOP_DAEMON=1
      shift
      ;;
    --stop-agents)
      STOP_AGENTS=1
      STOP_DAEMON=1
      shift
      ;;
    --restart|-r)
      RESTART=1
      STOP_DAEMON=1
      shift
      ;;
    --help|-h|-\?)
      HELP=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Run ./scripts/build-mac.sh --help for options." >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------- Colors
ESC="\033"
COLOR_RESET="${ESC}[0m"
COLOR_CYAN="${ESC}[36m"
COLOR_GREEN="${ESC}[32m"
COLOR_YELLOW="${ESC}[33m"
COLOR_RED="${ESC}[31m"
COLOR_GRAY="${ESC}[90m"

# ---------------------------------------------------------------- Help
if [[ "$HELP" -eq 1 ]]; then
  echo ""
  echo -e "  ${COLOR_GREEN}build-mac.sh - build Warmstart on macOS${COLOR_RESET}"
  echo "  Checks, bundle, packaged app, drive it. ~90s cold; seconds when nothing changed."
  echo ""
  echo -e "  ${COLOR_CYAN}HOW MUCH TO BUILD${COLOR_RESET}"
  echo "    (none)         types, lint, unit, bundle, suites, package, drive the package"
  echo "    -q, --quick    types, lint, unit, bundle. Packages nothing"
  echo "    -s, --skip-tests"
  echo "                   bundle and package, no suites. ⛔ test:pack is the only check that"
  echo "                   catches a native module left inside the asar"
  echo "    -i, --installer"
  echo "                   also build the DMG installer into release/. Adds several minutes"
  echo ""
  echo -e "  ${COLOR_CYAN}THE STEP CACHE${COLOR_RESET}"
  echo "    (default)      each step is skipped when a SHA-256 of the files it reads is"
  echo "                   unchanged and its outputs are still on disk"
  echo "    -f, --fresh    ignore the cache and rebuild everything. Alias: --no-cache, --rebuild"
  echo ""
  echo -e "  ${COLOR_CYAN}WHAT IS ALREADY RUNNING${COLOR_RESET}"
  echo "    (default)      report the PIDs holding the output directory, and stop"
  echo "    --stop-daemon  stop this repo's app and daemon first"
  echo "                   ⛔ refuses while agent CLIs are running under the daemon"
  echo "    --stop-agents  ...and stop those agent CLIs too. ⚠️ ends real work on a real"
  echo "                   account mid-run. Implies --stop-daemon"
  echo ""
  echo -e "  ${COLOR_CYAN}AFTERWARDS${COLOR_RESET}"
  echo "    -r, --restart  stop what is running, build, then start what was just built."
  echo "                   Implies --stop-daemon. ⭐ This is the inner loop: it is the only"
  echo "                   option that guarantees you are running the binary you just made"
  echo "    -h, --help     this. Alias: -?"
  echo ""
  echo -e "  ${COLOR_CYAN}EXAMPLES${COLOR_RESET}"
  echo -e "    ${COLOR_GRAY}./scripts/build-mac.sh -r                 build and run the result${COLOR_RESET}"
  echo -e "    ${COLOR_GRAY}./scripts/build-mac.sh -q                 fast inner loop, no packaging${COLOR_RESET}"
  echo -e "    ${COLOR_GRAY}./scripts/build-mac.sh -i -r              build the installer too${COLOR_RESET}"
  echo -e "    ${COLOR_GRAY}./scripts/build-mac.sh -f                 distrust the cache${COLOR_RESET}"
  echo ""
  exit 0
fi

# ---------------------------------------------------------------- Node check
if ! command -v node >/dev/null 2>&1; then
  echo -e "${COLOR_RED}Node.js is not found on PATH. Node 22+ is required to build.${COLOR_RESET}" >&2
  exit 1
fi

STARTED_SEC=$(date +%s)
STEP=0
RAN_COUNT=0
SKIPPED_COUNT=0

step_header() {
  STEP=$((STEP + 1))
  echo ""
  echo -e "${COLOR_CYAN}==> [$STEP] $1${COLOR_RESET}"
}

run_cmd() {
  echo -e "${COLOR_GRAY}    $*${COLOR_RESET}"
  "$@"
}

# ================================================================ Step Cache
CACHE_DIR="$REPO/.build-cache"
CACHE_SCHEMA=1

if [[ "$FRESH" -eq 1 && -d "$CACHE_DIR" ]]; then
  rm -rf "$CACHE_DIR"
fi
mkdir -p "$CACHE_DIR"

CACHE_HELPER="$CACHE_DIR/cache-helper.cjs"
cat << 'HELPER_EOF' > "$CACHE_HELPER"
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const action = process.argv[2];
const repo = process.cwd();

function hashFile(fp) {
  try {
    const content = fs.readFileSync(fp);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return 'missing';
  }
}

function walkInputs(inputs) {
  const lines = [];
  const sortedInputs = [...inputs].sort();
  for (const rel of sortedInputs) {
    const full = path.join(repo, rel);
    if (!fs.existsSync(full)) {
      lines.push(`${rel}|missing`);
      continue;
    }
    const stat = fs.statSync(full);
    if (!stat.isDirectory()) {
      lines.push(`${rel}|${stat.size}|${hashFile(full)}`);
    } else {
      const walkDir = (d) => {
        let entries = [];
        try { entries = fs.readdirSync(d); } catch { return; }
        for (const name of entries.sort()) {
          const childFull = path.join(d, name);
          let childStat;
          try { childStat = fs.statSync(childFull); } catch { continue; }
          if (childStat.isDirectory()) {
            walkDir(childFull);
          } else {
            const childRel = path.relative(repo, childFull).replace(/\\/g, '/');
            lines.push(`${childRel}|${childStat.size}|${hashFile(childFull)}`);
          }
        }
      };
      walkDir(full);
    }
  }
  return lines;
}

if (action === 'fingerprint') {
  const buildScript = process.argv[3];
  const inputs = process.argv.slice(4);
  const lines = walkInputs([...inputs, buildScript]);
  const manifest = lines.join('\n');
  const hash = crypto.createHash('sha256').update(manifest).digest('hex');
  process.stdout.write(hash);
  process.exit(0);
}

if (action === 'check-stamp') {
  const name = process.argv[3];
  const key = process.argv[4];
  const schema = Number(process.argv[5]);
  const rawOutputs = process.argv[6] ? process.argv[6].split(';').filter(Boolean) : [];

  const stampPath = path.join(repo, '.build-cache', `${name}.json`);
  if (!fs.existsSync(stampPath)) {
    process.stdout.write('MISSING\n');
    process.exit(0);
  }
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch {
    process.stdout.write('CORRUPT\n');
    process.exit(0);
  }

  if (stamp.schema !== schema || stamp.key !== key) {
    process.stdout.write('STALE\n');
    process.exit(0);
  }

  const missingOutputs = [];
  for (const outPattern of rawOutputs) {
    if (outPattern.includes('*')) {
      const dir = path.dirname(path.join(repo, outPattern));
      const baseRe = new RegExp('^' + path.basename(outPattern).replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      let found = false;
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (baseRe.test(f)) { found = true; break; }
        }
      }
      if (!found) missingOutputs.push(outPattern);
    } else {
      if (!fs.existsSync(path.join(repo, outPattern))) {
        missingOutputs.push(outPattern);
      }
    }
  }

  if (missingOutputs.length > 0) {
    process.stdout.write(`OUTPUT_MISSING:${missingOutputs.join(', ')}\n`);
    process.exit(0);
  }

  process.stdout.write(`HIT:${stamp.at}\n`);
  process.exit(0);
}

if (action === 'save-stamp') {
  const name = process.argv[3];
  const key = process.argv[4];
  const schema = Number(process.argv[5]);
  const stampPath = path.join(repo, '.build-cache', `${name}.json`);
  fs.writeFileSync(stampPath, JSON.stringify({ schema, key, at: new Date().toISOString() }, null, 2), 'utf8');
  process.exit(0);
}

if (action === 'assert-bundle-current') {
  const newestMtime = (dir) => {
    const full = path.join(repo, dir);
    if (!fs.existsSync(full)) return 0;
    let max = 0;
    const walk = (d) => {
      let entries = [];
      try { entries = fs.readdirSync(d); } catch { return; }
      for (const e of entries) {
        const fp = path.join(d, e);
        try {
          const s = fs.statSync(fp);
          if (s.isDirectory()) walk(fp);
          else max = Math.max(max, s.mtimeMs);
        } catch {}
      }
    };
    walk(full);
    return max;
  };
  const built = newestMtime('out');
  const source = newestMtime('src');
  if (built === 0) {
    console.error('No out/ to package - run without --skip-tests, or `npm run build` first.');
    process.exit(1);
  }
  if (source > built) {
    console.error('\n⛔ STALE: out/ was built earlier than src/ modifications.');
    console.error('   Packaging this would ship code that is no longer in the tree. Re-run with --fresh.');
    process.exit(1);
  }
  process.exit(0);
}

if (action === 'get-repo-processes') {
  const stopDaemon = process.argv[3] === '1';
  const stopAgents = process.argv[4] === '1';
  const releasePrefix = path.join(repo, 'release') + path.sep;
  const devElectronPrefix = path.join(repo, 'node_modules', 'electron', 'dist') + path.sep;
  const outBundleSubstr = path.join(repo, 'out') + path.sep;

  let psOut = '';
  try {
    psOut = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,lstart=,args='], { encoding: 'utf8', timeout: 10000 });
  } catch (err) {
    console.error('Failed to run ps:', err.message);
    process.exit(0);
  }

  const procs = [];
  for (const line of psOut.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: pid ppid DOW MON DD HH:MM:SS YYYY args...
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/);
    if (match) {
      procs.push({
        pid: parseInt(match[1], 10),
        ppid: parseInt(match[2], 10),
        lstart: match[3],
        cmd: match[4]
      });
    }
  }

  const isRepoProc = (p) => {
    if (p.cmd.startsWith(releasePrefix)) return true;
    if (p.cmd.startsWith(devElectronPrefix)) return true;
    if (p.cmd.includes(outBundleSubstr)) return true;
    return false;
  };

  const holders = procs.filter(isRepoProc);
  if (holders.length === 0) {
    if (stopDaemon) console.log('    nothing of this repo\'s is running');
    process.exit(0);
  }

  // Find all descendants of holders
  const holderPids = new Set(holders.map(h => h.pid));
  const descendants = [];
  let frontier = [...holderPids];
  while (frontier.length > 0) {
    const nextFrontier = [];
    for (const p of procs) {
      if (frontier.includes(p.ppid) && !holderPids.has(p.pid) && !descendants.some(d => d.pid === p.pid)) {
        descendants.push(p);
        nextFrontier.push(p.pid);
      }
    }
    frontier = nextFrontier;
  }

  if (!stopDaemon) {
    console.log('\nThe build cannot replace release/ while these are running:');
    for (const h of holders) {
      console.log(`  PID ${String(h.pid).padEnd(7)} started ${h.lstart}  ${h.cmd.slice(0, 80)}`);
    }
    console.log('\nStop those PIDs, then run this again - or re-run with --stop-daemon.');
    console.log(`  kill ${holders.map(h => h.pid).join(' ')}`);
    process.exit(1);
  }

  // If there are descendants that are not part of holders, they may be agent CLIs
  if (descendants.length > 0 && !stopAgents) {
    console.log('\nREFUSING to stop it: the daemon has live work under it.');
    for (const d of descendants) {
      console.log(`  PID ${String(d.pid).padEnd(7)} ${d.cmd.slice(0, 80)}`);
    }
    console.log('\nThose are agent processes, not part of the build.');
    console.log('Cancel or finish the running task first, or re-run with --stop-agents to stop them too.');
    process.exit(1);
  }

  console.log('Stopping repo processes...');
  // Stop descendants first, then holders
  const toStop = [...descendants, ...holders];
  for (const p of toStop) {
    // Verify identity by re-reading ps
    try {
      const verify = execFileSync('ps', ['-p', String(p.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
      if (verify === p.lstart) {
        process.kill(p.pid, 'SIGTERM');
        console.log(`  stopped ${String(p.pid).padEnd(7)} (${p.cmd.slice(0, 60)})`);
      }
    } catch {}
  }
  process.exit(0);
}
HELPER_EOF

invoke_step() {
  local name="$1"
  local title="$2"
  local inputs_str="$3"
  local outputs_str="$4"
  shift 4

  step_header "$title"

  # Fingerprint inputs
  local key
  IFS=' ' read -r -a inputs_array <<< "$inputs_str"
  key=$(node "$CACHE_HELPER" fingerprint "scripts/build-mac.sh" "${inputs_array[@]}")

  local check_result
  check_result=$(node "$CACHE_HELPER" check-stamp "$name" "$key" "$CACHE_SCHEMA" "$outputs_str")

  if [[ "$FRESH" -eq 0 && "$check_result" =~ ^HIT:(.*) ]]; then
    local when="${BASH_REMATCH[1]}"
    echo -e "${COLOR_GRAY}    skipped - inputs unchanged since $when${COLOR_RESET}"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi

  if [[ "$check_result" =~ ^OUTPUT_MISSING:(.*) ]]; then
    echo -e "${COLOR_GRAY}    output missing (${BASH_REMATCH[1]}) - running anyway${COLOR_RESET}"
  fi

  # Run the step command
  "$@"

  # Save stamp
  node "$CACHE_HELPER" save-stamp "$name" "$key" "$CACHE_SCHEMA"
  RAN_COUNT=$((RAN_COUNT + 1))
}

# The input sets, matching scripts/build-win.ps1
LOCK="package-lock.json"
TSCONFIGS="tsconfig.json tsconfig.node.json tsconfig.web.json"
BUNDLE_IN="src costmodels electron.vite.config.ts version.json package.json $LOCK $TSCONFIGS"
PACK_IN="out electron-builder.yml version.json package.json resources $LOCK"
BUNDLE_OUT="out/main/index.js;out/main/orchestratord.js;out/main/agentyard-mcp.js;out/preload/index.cjs;out/renderer/index.html"
if [[ "$(uname -m)" == "arm64" ]]; then
  PACKED_APP="release/mac-arm64/Warmstart.app"
else
  PACKED_APP="release/mac/Warmstart.app"
fi

# ================================================================ Build Pipeline
echo -e "${COLOR_GREEN}Warmstart - macOS build${COLOR_RESET}"
echo -e "${COLOR_GRAY}repo: $REPO${COLOR_RESET}"
if [[ "$FRESH" -eq 1 ]]; then
  echo -e "${COLOR_GRAY}cache: ignored (--fresh)${COLOR_RESET}"
fi

if [[ "$STOP_DAEMON" -eq 1 ]]; then
  step_header "Stop this repo's app and daemon"
  node "$CACHE_HELPER" get-repo-processes "$STOP_DAEMON" "$STOP_AGENTS"
fi

# 1. Electron runtime
step_header "Electron runtime (it does not download itself)"
run_cmd node scripts/ensure-electron.mjs

# 2. Checks (Types, Lint, Unit)
if [[ "$SKIP_TESTS" -eq 0 ]]; then
  invoke_step 'typecheck' 'Types' "src $TSCONFIGS $LOCK" "" run_cmd npm run typecheck
  invoke_step 'lint' 'Lint' "src test scripts eslint.config.js $LOCK" "" run_cmd npm run lint
  invoke_step 'unit' 'Unit tests' "src test costmodels vitest.config.ts $LOCK" "" run_cmd npm test
fi

# 3. Bundle
invoke_step 'bundle' 'Bundle' "$BUNDLE_IN" "$BUNDLE_OUT" run_cmd npm run build

if [[ "$QUICK" -eq 1 ]]; then
  ELAPSED=$(( $(date +%s) - STARTED_SEC ))
  echo ""
  echo -e "${COLOR_GREEN}Done in ${ELAPSED}s ($RAN_COUNT ran, $SKIPPED_COUNT skipped). Bundle only - nothing was packaged.${COLOR_RESET}"
  echo -e "${COLOR_GRAY}Run without -q to package, or with -i to build the .dmg.${COLOR_RESET}"
  rm -f "$CACHE_HELPER"
  exit 0
fi

# 4. Daemon & UI suites (if not skipping tests)
if [[ "$SKIP_TESTS" -eq 0 ]]; then
  invoke_step 'test-daemon' 'Daemon suite' "out test $LOCK" "" run_cmd npm run test:daemon
  invoke_step 'test-ui' 'UI suite' "out test $LOCK" "" run_cmd npm run test:ui
fi

# 5. Packaged app
run_pack() {
  node "$CACHE_HELPER" assert-bundle-current
  node "$CACHE_HELPER" get-repo-processes 0 0
  npx --no-install electron-builder --dir
}
invoke_step 'pack' 'Packaged app' "$PACK_IN" "$PACKED_APP" run_pack

# 6. Drive the packaged app (if not skipping tests)
if [[ "$SKIP_TESTS" -eq 0 ]]; then
  invoke_step 'test-pack' 'Drive the packaged app' "out test electron-builder.yml $LOCK" "" run_cmd npm run test:pack
fi

# 7. Installer (if requested)
if [[ "$INSTALLER" -eq 1 ]]; then
  run_installer() {
    node "$CACHE_HELPER" assert-bundle-current
    node "$CACHE_HELPER" get-repo-processes 0 0
    npx --no-install electron-builder --mac
  }
  invoke_step 'installer' 'Installer' "$PACK_IN" "release/warmstart-*.dmg" run_installer
fi

# Clean up helper
rm -f "$CACHE_HELPER"

# ---------------------------------------------------------------- Summary
VERSION=$(node -p "require('./package.json').version")
ELAPSED=$(( $(date +%s) - STARTED_SEC ))

echo ""
echo -e "${COLOR_GREEN}Done in ${ELAPSED}s. Version ${VERSION}. ${RAN_COUNT} step(s) ran, ${SKIPPED_COUNT} skipped as unchanged.${COLOR_RESET}"
if [[ "$SKIPPED_COUNT" -gt 0 ]]; then
  echo -e "${COLOR_GRAY}  --fresh rebuilds everything, ignoring the cache.${COLOR_RESET}"
fi

# Find the unpacked .app bundle
TARGET_APP=""
if [[ -d "release/mac-arm64/Warmstart.app" ]]; then
  TARGET_APP="release/mac-arm64/Warmstart.app"
elif [[ -d "release/mac/Warmstart.app" ]]; then
  TARGET_APP="release/mac/Warmstart.app"
fi

if [[ -n "$TARGET_APP" ]]; then
  APP_SIZE=$(du -sh "$TARGET_APP" 2>/dev/null | cut -f1)
  echo -e "  app        ${REPO}/${TARGET_APP}  (${APP_SIZE})"
fi

for dmg in release/Warmstart-*.dmg; do
  if [[ -f "$dmg" ]]; then
    DMG_SIZE=$(du -sh "$dmg" 2>/dev/null | cut -f1)
    echo -e "  installer  ${REPO}/${dmg}  (${DMG_SIZE})"
  fi
done

echo ""
echo -e "${COLOR_GRAY}⚠️  Unsigned by design - macOS Gatekeeper will refuse until cleared by hand.${COLOR_RESET}"
echo -e "${COLOR_GRAY}    That is the honest state of a pre-alpha, not a build failure.${COLOR_RESET}"

if [[ "$RESTART" -eq 1 && "$QUICK" -eq 1 ]]; then
  echo ""
  echo -e "${COLOR_YELLOW}⚠️  --restart had nothing to start: --quick bundles but packages nothing.${COLOR_RESET}"
  echo -e "${COLOR_GRAY}    Run without --quick to package, then restart.${COLOR_RESET}"
elif [[ "$RESTART" -eq 1 ]]; then
  echo ""
  if [[ -z "$TARGET_APP" ]]; then
    echo -e "${COLOR_YELLOW}⚠️  --restart found no packaged app to start.${COLOR_RESET}"
  else
    echo -e "${COLOR_CYAN}Starting what was just built...${COLOR_RESET}"
    echo -e "${COLOR_GRAY}  open $TARGET_APP${COLOR_RESET}"
    open "$TARGET_APP"
    echo -e "${COLOR_GRAY}⚠️  It is now running, and orchestratord outlives the window it opens.${COLOR_RESET}"
    echo -e "${COLOR_GRAY}    The next build needs --restart again, or --stop-daemon.${COLOR_RESET}"
  fi
else
  if [[ -n "$TARGET_APP" ]]; then
    echo ""
    echo -e "${COLOR_CYAN}To run what you just built:${COLOR_RESET}"
    echo -e "${COLOR_GRAY}  open '${REPO}/${TARGET_APP}'${COLOR_RESET}"
    echo -e "${COLOR_GRAY}⭐  Or let the script do it: --restart stops what is running, rebuilds, and starts the${COLOR_RESET}"
    echo -e "${COLOR_GRAY}    result - the only way to be sure you are looking at the binary you just made.${COLOR_RESET}"
  fi
fi
