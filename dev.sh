#!/usr/bin/env bash
# dev.sh — start daimon2 (daemon + Vite UI + Electrobun app)
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

# Kill stale processes
kill $(lsof -ti:7878) 2>/dev/null || true
kill $(lsof -ti:7880) 2>/dev/null || true
kill $(lsof -ti:7881) 2>/dev/null || true

# 1. Rust pty-daemon
echo "[dev] starting pty-daemon..."
cargo run -p pty-daemon --manifest-path "$ROOT/Cargo.toml" &
DAEMON_PID=$!

# 2. Vite dev server (daimon UI)
echo "[dev] starting Vite UI..."
cd "$ROOT/ui" && bun run dev &
UI_PID=$!

# 3. Wait for Vite to be ready
echo "[dev] waiting for UI..."
for i in $(seq 1 20); do
  curl -sf http://localhost:7881 > /dev/null 2>&1 && break
  sleep 0.3
done

# 4. Launch Electrobun
echo "[dev] launching Electrobun app..."

patch_cottontail() {
  local macos_dir="$ROOT/app/build/dev-macos-arm64/daimon2-dev.app/Contents/MacOS"
  local dylib="$macos_dir/allow_magnification.dylib"
  local ct="$macos_dir/cottontail"
  local real="$macos_dir/cottontail.real"
  [ -f "$ct" ] || return
  # Skip if already a wrapper script
  head -1 "$ct" 2>/dev/null | grep -q "^#!/bin/sh" && return
  cp "$ROOT/app/allow_magnification.dylib" "$dylib"
  mv "$ct" "$real"
  printf '#!/bin/sh\nDYLIB="$(dirname "$0")/allow_magnification.dylib"\nREAL="$(dirname "$0")/cottontail.real"\nexec env DYLD_INSERT_LIBRARIES="$DYLIB" "$REAL" "$@"\n' > "$ct"
  chmod +x "$ct"
  echo "[dev] magnification patch applied"
}

# Build synchronously, patch cottontail for magnification, then run
cd "$ROOT/app" && node node_modules/electrobun/bin/electrobun.cjs build
patch_cottontail
node node_modules/electrobun/bin/electrobun.cjs run &
APP_PID=$!

echo "[dev] all started. pids: daemon=$DAEMON_PID ui=$UI_PID app=$APP_PID"
echo "[dev] Ctrl+C to stop all"

trap "kill $DAEMON_PID $UI_PID $APP_PID 2>/dev/null; exit" INT TERM
wait
