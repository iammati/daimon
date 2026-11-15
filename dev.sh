#!/usr/bin/env bash
# dev.sh — start daimon2 (pty-daemon + Vite UI + Electrobun app)
# Supported hosts: macOS, Linux, and Windows via WSL2.
#
# On WSL2 the app window runs natively on Windows (WebView2) while the pty-daemon,
# shell and Vite stay in WSL — that's what gives a see-through window with real
# desktop blur. Set DAIMON_WINDOWS=0 to show the window through WSLg (WebKitGTK)
# instead; that path is also the automatic fallback if the Windows side can't be set up.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

log()  { echo "[dev] $*"; }
die()  { echo "[dev] error: $*" >&2; exit 1; }

# ── Platform detection ────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  Linux)
    if grep -qi microsoft /proc/version 2>/dev/null; then PLATFORM=wsl; else PLATFORM=linux; fi ;;
  MINGW*|MSYS*|CYGWIN*)
    die "native Windows shells aren't supported — run ./dev.sh inside WSL2 (Ubuntu/Debian)." ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac
log "platform: $PLATFORM ($(uname -m))"

# ── Toolchain checks ──────────────────────────────────────────────────────────
# rustup installs to ~/.cargo/bin, which may not be on PATH in non-login shells.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
[ -d "$HOME/.bun/bin" ] && export PATH="$HOME/.bun/bin:$PATH"

APT_PKGS="build-essential pkg-config cmake zsh libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev"

command -v cargo >/dev/null || die "cargo not found. Install Rust: curl https://sh.rustup.rs -sSf | sh"
command -v bun   >/dev/null || die "bun not found. Install: curl -fsSL https://bun.sh/install | bash"
command -v node  >/dev/null || die "node not found (needed to run the electrobun CLI)."

# ── WSL: native Windows window (default) or WSLg ──────────────────────────────
# The Windows side lives in %LOCALAPPDATA%\daimon-dev: a portable bun.exe plus a
# staged copy of app/ (Windows tooling is slow and lock-prone on the WSL filesystem).
WIN_NATIVE=0
WIN_STAGE=""
win_setup() {
  command -v cmd.exe >/dev/null && command -v powershell.exe >/dev/null && command -v wslpath >/dev/null \
    || { log "Windows interop unavailable"; return 1; }
  local la
  la=$(cd /mnt/c 2>/dev/null && cmd.exe /c "echo %LOCALAPPDATA%" 2>/dev/null | tr -d '\r')
  [ -n "$la" ] && [ "$la" != "%LOCALAPPDATA%" ] || { log "couldn't resolve %LOCALAPPDATA%"; return 1; }
  WIN_STAGE="$(wslpath -u "$la")/daimon-dev"
  mkdir -p "$WIN_STAGE/tools" "$WIN_STAGE/app" || return 1
  if [ ! -x "$WIN_STAGE/tools/bun.exe" ]; then
    log "downloading portable bun.exe for Windows → $la\\daimon-dev\\tools (one-time)..."
    ( cd "$WIN_STAGE/tools" \
      && curl.exe -fsSL -o bun.zip https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip \
      && tar.exe -xf bun.zip \
      && mv bun-windows-x64/bun.exe bun.exe \
      && rm -rf bun.zip bun-windows-x64 ) || { log "bun.exe download failed"; return 1; }
  fi
}
# Stop a previously launched Windows app (it would also lock the build output).
win_stop() {
  [ -n "$WIN_STAGE" ] || return 0
  local root; root=$(wslpath -w "$WIN_STAGE")
  (cd /mnt/c && powershell.exe -NoProfile -Command \
    "Get-Process cottontail,launcher -ErrorAction SilentlyContinue | Where-Object { \$_.Path -like '$root\\*' } | Stop-Process -Force" \
    </dev/null >/dev/null 2>&1) || true
}
# Copy app sources to the Windows side, install deps there and build.
win_build() {
  rm -rf "$WIN_STAGE/app/src"
  cp -r "$ROOT/app/src" "$WIN_STAGE/app/src" || return 1
  if ! cmp -s "$ROOT/app/package.json" "$WIN_STAGE/app/package.json" || [ ! -d "$WIN_STAGE/app/node_modules" ]; then
    cp "$ROOT/app/package.json" "$ROOT/app/bun.lock" "$WIN_STAGE/app/" || return 1
    log "installing app deps (Windows)..."
    (cd "$WIN_STAGE/app" && ../tools/bun.exe install </dev/null) || return 1
  fi
  cp "$ROOT/app/electrobun.config.ts" "$WIN_STAGE/app/" || return 1
  (cd "$WIN_STAGE/app" && ../tools/bun.exe node_modules/electrobun/bin/electrobun.cjs build </dev/null)
}
if [ "$PLATFORM" = wsl ] && [ "${DAIMON_WINDOWS:-1}" != 0 ]; then
  if win_setup; then
    WIN_NATIVE=1
    log "app window: native Windows (WebView2). DAIMON_WINDOWS=0 for WSLg."
  else
    log "falling back to the WSLg window"
  fi
fi

if [ "$PLATFORM" = macos ]; then
  xcode-select -p >/dev/null 2>&1 || die "Xcode command line tools missing: xcode-select --install"
else
  missing=""
  command -v cc >/dev/null || missing="C compiler"
  # GTK/WebKitGTK is only needed when the window is rendered on the Linux side.
  if [ "$WIN_NATIVE" = 1 ]; then
    :
  elif ! command -v pkg-config >/dev/null || ! pkg-config --exists webkit2gtk-4.1 gtk+-3.0; then
    missing="${missing:+$missing, }GTK/WebKitGTK"
  fi
  if [ -n "$missing" ]; then
    die "missing system packages ($missing). On Debian/Ubuntu run:
    sudo apt-get install -y $APT_PKGS"
  fi
  command -v zsh >/dev/null || log "warning: zsh not installed — shell integration (command blocks) needs it: sudo apt-get install zsh"
fi

if [ "$PLATFORM" = wsl ] && [ "$WIN_NATIVE" = 0 ]; then
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    die "no DISPLAY/WAYLAND_DISPLAY — WSLg is required (Windows 11, or 'wsl --update' on Windows 10)."
  fi
  # WebKitGTK's DMA-BUF renderer shows a blank window under WSLg's virtual GPU.
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
fi

# DAIMON_TRANSPARENT=1 → see-through window on Linux/WSL. WebKitGTK's accelerated
# compositing doesn't repaint transparent windows (content only appears while
# resizing), so fall back to its non-composited renderer in that mode.
# (Not needed for the native Windows window, which is see-through + blurred by default.)
if [ "$PLATFORM" != macos ] && [ "$WIN_NATIVE" = 0 ] && [ "${DAIMON_TRANSPARENT:-0}" = 1 ]; then
  export WEBKIT_DISABLE_COMPOSITING_MODE=1
  log "transparent window enabled (WebKit compositing disabled)"
fi

# ── Kill stale processes on our ports ─────────────────────────────────────────
free_port() {
  local port=$1 pids=""
  if command -v lsof >/dev/null; then
    pids=$(lsof -ti:"$port" 2>/dev/null || true)
  elif command -v fuser >/dev/null; then
    pids=$(fuser "$port"/tcp 2>/dev/null || true)
  elif command -v ss >/dev/null; then
    pids=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 || true)
  fi
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
}
for p in 7878 7880 7881; do free_port "$p"; done
[ "$WIN_NATIVE" = 1 ] && win_stop

# ── Cleanup on exit ───────────────────────────────────────────────────────────
PIDS=()
cleanup() {
  trap - INT TERM EXIT
  log "stopping..."
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  done
  [ "$WIN_NATIVE" = 1 ] && win_stop
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# ── JS dependencies ───────────────────────────────────────────────────────────
[ -d "$ROOT/ui/node_modules" ]  || (log "installing ui deps...";  cd "$ROOT/ui"  && bun install)
[ -d "$ROOT/app/node_modules" ] || (log "installing app deps..."; cd "$ROOT/app" && bun install)

# ── 1. Rust pty-daemon (build first so compile errors stop the script) ───────
log "building Rust workspace..."
cargo build --manifest-path "$ROOT/Cargo.toml" -p pty-daemon -p daimon
log "starting pty-daemon..."
cargo run -q -p pty-daemon --manifest-path "$ROOT/Cargo.toml" &
PIDS+=($!)

# ── 2. Vite dev server (daimon UI) ────────────────────────────────────────────
log "starting Vite UI..."
(cd "$ROOT/ui" && exec bun run dev) &
PIDS+=($!)

log "waiting for UI on :7881..."
for _ in $(seq 1 100); do
  curl -sf http://localhost:7881 >/dev/null 2>&1 && break
  sleep 0.3
done
curl -sf http://localhost:7881 >/dev/null 2>&1 || die "Vite didn't come up on :7881"

# ── 3. Electrobun app ─────────────────────────────────────────────────────────
if [ "$WIN_NATIVE" = 1 ]; then
  log "building Electrobun app (Windows)..."
  if win_build; then
    log "launching Electrobun app (Windows)..."
    # Windows reaches the daemon (:7878) and Vite (:7881) through WSL's localhost forwarding.
    export WSLENV="${WSLENV:+$WSLENV:}DAIMON_TRANSPARENT:DAIMON_BACKDROP"
    (cd "$WIN_STAGE/app" && exec ../tools/bun.exe node_modules/electrobun/bin/electrobun.cjs run </dev/null) &
    PIDS+=($!)
  else
    log "Windows build failed — falling back to the WSLg window"
    WIN_NATIVE=0
    { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; } || die "no DISPLAY/WAYLAND_DISPLAY for the WSLg fallback."
    pkg-config --exists webkit2gtk-4.1 gtk+-3.0 2>/dev/null || die "WSLg fallback needs GTK/WebKitGTK:
    sudo apt-get install -y $APT_PKGS"
    export WEBKIT_DISABLE_DMABUF_RENDERER=1
    [ "${DAIMON_TRANSPARENT:-0}" = 1 ] && export WEBKIT_DISABLE_COMPOSITING_MODE=1
  fi
fi

if [ "$WIN_NATIVE" = 0 ]; then
cd "$ROOT/app"
log "building Electrobun app..."
node node_modules/electrobun/bin/electrobun.cjs build

# macOS only: inject allow_magnification.dylib (pinch-zoom) into the launcher.
patch_cottontail() {
  local dylib_src="$ROOT/app/allow_magnification.dylib"
  [ -f "$dylib_src" ] || return 0
  local macos_dir
  macos_dir=$(ls -d "$ROOT"/app/build/dev-macos-*/*.app/Contents/MacOS 2>/dev/null | head -1)
  [ -n "$macos_dir" ] || return 0
  local ct="$macos_dir/cottontail" real="$macos_dir/cottontail.real"
  [ -f "$ct" ] || return 0
  head -1 "$ct" 2>/dev/null | grep -q "^#!/bin/sh" && return 0   # already wrapped
  cp "$dylib_src" "$macos_dir/allow_magnification.dylib"
  mv "$ct" "$real"
  printf '#!/bin/sh\nDYLIB="$(dirname "$0")/allow_magnification.dylib"\nREAL="$(dirname "$0")/cottontail.real"\nexec env DYLD_INSERT_LIBRARIES="$DYLIB" "$REAL" "$@"\n' > "$ct"
  chmod +x "$ct"
  log "magnification patch applied"
}
[ "$PLATFORM" = macos ] && patch_cottontail

log "launching Electrobun app..."
node node_modules/electrobun/bin/electrobun.cjs run &
PIDS+=($!)
fi

log "all started. pids: ${PIDS[*]}"
log "Ctrl+C to stop all"
# Exit (and clean up) as soon as any component dies. Polling instead of
# `wait -n` keeps this compatible with macOS's stock bash 3.2.
while :; do
  for pid in "${PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null || { log "process $pid exited"; exit 1; }
  done
  sleep 1
done
