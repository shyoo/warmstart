#!/usr/bin/env bash
# deploy-local.sh — build Warmstart and install directly into /Applications/Warmstart.app
#
# Options:
#   -stopapp, --stopapp, -s   Ask the running Warmstart app to quit before deploying
#   -start, --start           Launch /Applications/Warmstart.app after deployment
#   -skip-tests, --skip-tests Skip test suites during build (faster deployment)
#   -fresh, --fresh           Ignore build cache and rebuild everything
#   -h, --help                Show help
#
# Any other arguments are passed through to scripts/build-mac.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x "$SCRIPT_DIR/scripts/build-mac.sh" ]]; then
  REPO="$SCRIPT_DIR"
elif [[ -x "$SCRIPT_DIR/build-mac.sh" ]]; then
  REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  echo "Error: could not locate scripts/build-mac.sh from $SCRIPT_DIR." >&2
  exit 1
fi
TARGET_DIR="/Applications"
APP_NAME="Warmstart.app"
TARGET_APP="$TARGET_DIR/$APP_NAME"

STOP_APP=0
START_APP=0
BUILD_ARGS=()

for arg in "$@"; do
  case "$arg" in
    -stopapp|--stopapp|-s)
      STOP_APP=1
      ;;
    -start|--start)
      START_APP=1
      ;;
    -skip-tests|--skip-tests)
      BUILD_ARGS+=("--skip-tests")
      ;;
    -fresh|--fresh)
      BUILD_ARGS+=("--fresh")
      ;;
    -h|--help)
      echo "Usage: ./deploy-local.sh [options]"
      echo ""
      echo "Builds Warmstart and copies Warmstart.app directly into /Applications/."
      echo ""
      echo "Options:"
      echo "  -stopapp, --stopapp, -s    Ask the running Warmstart app to quit first"
      echo "  -start, --start            Open /Applications/Warmstart.app after deployment"
      echo "  -skip-tests, --skip-tests  Pass --skip-tests to scripts/build-mac.sh"
      echo "  -fresh, --fresh            Pass --fresh to scripts/build-mac.sh"
      echo "  -h, --help                 Show this help message"
      echo ""
      echo "Any unrecognized flags are forwarded to scripts/build-mac.sh."
      exit 0
      ;;
    *)
      BUILD_ARGS+=("$arg")
      ;;
  esac
done

get_warmstart_pids() {
  ps -ax -o pid=,command= | awk '$2 ~ /Warmstart\.app/ || $0 ~ /\/Warmstart\.app\// { print $1 }'
}

RUNNING_PIDS="$(get_warmstart_pids)"

if [[ -n "$RUNNING_PIDS" ]]; then
  if [[ "$STOP_APP" -eq 1 ]]; then
    echo "==> Stopping running Warmstart instances: $RUNNING_PIDS"
    # Gracefully ask the GUI app to quit
    osascript -e 'quit app "Warmstart"' 2>/dev/null || true

    # Wait up to 3 seconds for graceful exit.
    for i in {1..15}; do
      REMAINING="$(get_warmstart_pids)"
      if [[ -z "$REMAINING" ]]; then
        break
      fi
      sleep 0.2
    done

    REMAINING="$(get_warmstart_pids)"
    if [[ -n "$REMAINING" ]]; then
      echo "Error: Warmstart did not quit; refusing to terminate it forcibly." >&2
      exit 1
    fi
    echo "==> All Warmstart processes stopped."
  else
    echo "Error: Warmstart is currently running (PID(s): $RUNNING_PIDS)." >&2
    echo "Use '-stopapp' to automatically terminate existing instances before deploying." >&2
    exit 1
  fi
fi

# 1. Build application
echo "==> Building Warmstart via scripts/build-mac.sh..."
if [[ "${#BUILD_ARGS[@]}" -gt 0 ]]; then
  "$REPO/scripts/build-mac.sh" "${BUILD_ARGS[@]}"
else
  "$REPO/scripts/build-mac.sh"
fi

# 2. Locate built application
BUILT_APP=""
if [[ "$(uname -m)" == "arm64" && -d "$REPO/release/mac-arm64/$APP_NAME" ]]; then
  BUILT_APP="$REPO/release/mac-arm64/$APP_NAME"
elif [[ -d "$REPO/release/mac/$APP_NAME" ]]; then
  BUILT_APP="$REPO/release/mac/$APP_NAME"
elif [[ -d "$REPO/release/mac-arm64/$APP_NAME" ]]; then
  BUILT_APP="$REPO/release/mac-arm64/$APP_NAME"
fi

if [[ -z "$BUILT_APP" || ! -d "$BUILT_APP" ]]; then
  echo "Error: Built application not found in release/ directory." >&2
  exit 1
fi

# 3. Replace in /Applications
echo "==> Deploying $BUILT_APP to $TARGET_APP..."
if [[ -d "$TARGET_APP" ]]; then
  rm -rf "$TARGET_APP"
fi

ditto "$BUILT_APP" "$TARGET_APP"

# Clear Gatekeeper quarantine attribute
xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null || true

SIZE="$(du -sh "$TARGET_APP" | awk '{print $1}')"
VERSION="$(defaults read "$TARGET_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "0.0.1")"
echo "==> Deployed Warmstart v$VERSION ($SIZE) to $TARGET_APP successfully."

# 4. Optionally launch
if [[ "$START_APP" -eq 1 ]]; then
  echo "==> Launching $TARGET_APP..."
  open "$TARGET_APP"
fi
