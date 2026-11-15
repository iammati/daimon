#!/usr/bin/env bash
# build.sh — local production build of daimon2 for this machine's OS/arch, from source.
#
#   release pty-daemon + daimon CLI  →  production UI bundle  →  Electrobun stable app
#
# Output: dist/daimon2-<os>-<arch>/   (run it with dist/daimon2-<os>-<arch>/daimon)
#
# The app bundles the UI (views://daimon2/) and spawns its own pty-daemon, so nothing
# from ./dev.sh needs to be running — in fact stop dev.sh first, both use port 7878.
#
# On WSL2 two apps are built from the same sources:
#   dist/daimon2-linux-<arch>/  the Linux app, shown through WSLg (needs GTK/WebKitGTK)
#   dist/daimon2-win-x64/       the native Windows app (WebView2, real desktop blur); it
#                               runs the bundled Linux daemon inside this WSL distro.
#                               The app itself lives in %LOCALAPPDATA%\daimon-build.
# DAIMON_WINDOWS=0 skips the Windows app, DAIMON_LINUX=0 the WSLg one.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

log() { echo "[build] $*"; }
die() { echo "[build] error: $*" >&2; exit 1; }

# ── Target = this machine ─────────────────────────────────────────────────────
WSL=0
case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux)  OS=linux; grep -qi microsoft /proc/version 2>/dev/null && WSL=1 ;;
  *) die "unsupported OS: $(uname -s) (macOS, Linux and WSL2 only)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
TARGET="$OS-$ARCH"
log "target: $TARGET$([ "$WSL" = 1 ] && echo ' (WSL2)')"

# ── Toolchain ─────────────────────────────────────────────────────────────────
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
[ -d "$HOME/.bun/bin" ] && export PATH="$HOME/.bun/bin:$PATH"
command -v cargo >/dev/null || die "cargo not found. Install Rust: curl https://sh.rustup.rs -sSf | sh"
command -v bun   >/dev/null || die "bun not found. Install: curl -fsSL https://bun.sh/install | bash"
command -v node  >/dev/null || die "node not found (needed to run the electrobun CLI)."

BUILD_HOST=1   # the app for this OS (macOS / Linux / WSLg)
BUILD_WIN=0    # WSL only: the native Windows app
if [ "$WSL" = 1 ] && [ "${DAIMON_WINDOWS:-1}" != 0 ]; then
  if [ "$ARCH" != x64 ]; then
    log "skipping the Windows app: only x64 is supported"
  elif command -v cmd.exe >/dev/null && command -v powershell.exe >/dev/null && command -v wslpath >/dev/null; then
    BUILD_WIN=1
  else
    log "skipping the Windows app: Windows interop unavailable"
  fi
fi
if [ "$OS" = macos ]; then
  xcode-select -p >/dev/null 2>&1 || die "Xcode command line tools missing: xcode-select --install"
else
  command -v cc >/dev/null || die "no C compiler: sudo apt-get install -y build-essential"
  GTK_HINT="sudo apt-get install -y pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev"
  if [ "${DAIMON_LINUX:-1}" = 0 ] && [ "$BUILD_WIN" = 1 ]; then
    BUILD_HOST=0
  elif ! { command -v pkg-config >/dev/null && pkg-config --exists webkit2gtk-4.1 gtk+-3.0; }; then
    [ "$BUILD_WIN" = 1 ] || die "GTK/WebKitGTK missing: $GTK_HINT"
    BUILD_HOST=0
    log "skipping the WSLg app: GTK/WebKitGTK missing ($GTK_HINT)"
  fi
fi

# ── 1. Rust (release, host target) ────────────────────────────────────────────
log "building pty-daemon + daimon CLI (release)..."
cargo build --release --manifest-path "$ROOT/Cargo.toml" -p pty-daemon -p daimon

# ── 2. UI ─────────────────────────────────────────────────────────────────────
log "building UI..."
cd "$ROOT/ui"
bun install --frozen-lockfile
# The VT-engine wasm is optional; embed it only when it has been built.
[ -f src/lib/terminal-wasm/terminal_wasm_bg.wasm ] && bun run scripts/embed-wasm.ts
bunx vite build

# ── 3. Electrobun app (stable) for this OS ────────────────────────────────────
# electrobun.config.ts copies ui/dist and target/release/pty-daemon into the bundle;
# NODE_ENV=production is inlined into the main process (bundled UI + own daemon).

# unpack <archive.tar.zst> <dir> — the stable build is a self-extracting installer;
# unpack its payload so the app can be run in place without installing anything.
unpack() {
  rm -rf "$2"; mkdir -p "$2"
  if command -v zstd >/dev/null; then
    zstd -dc "$1" | tar -xf - -C "$2"
  else
    # No system zstd: use the one Electrobun ships (for this host).
    local z; z=$(ls "$HOME"/.hutch/releases/electrobun/*/"$TARGET"/zig-zstd 2>/dev/null | tail -1)
    [ -x "$z" ] || die "zstd not found (install zstd)"
    "$z" decompress -i "$1" -o "$2/app.tar" --no-timing
    tar -xf "$2/app.tar" -C "$2"; rm "$2/app.tar"
  fi
}

build_host() {
  log "building Electrobun app ($TARGET, stable)..."
  cd "$ROOT/app"
  bun install --frozen-lockfile
  rm -rf "build/stable-$TARGET" artifacts
  NODE_ENV=production node node_modules/electrobun/bin/electrobun.cjs build --env=stable

  local archive out launcher
  archive=$(ls "$ROOT"/app/artifacts/stable-"$TARGET"-*.tar.zst 2>/dev/null | head -1)
  [ -n "$archive" ] || die "no stable-$TARGET-*.tar.zst in app/artifacts — did electrobun build for another target?"
  out="$ROOT/dist/daimon2-$TARGET"
  unpack "$archive" "$out"
  cp "$ROOT/target/release/daimon" "$out/daimon-cli"

  launcher=$(cd "$out" && { ls -d */bin/launcher */Contents/MacOS/launcher 2>/dev/null || true; } | head -1)
  [ -n "$launcher" ] || die "unpacked app has no launcher under $out"
  cat > "$out/daimon" <<EOF
#!/usr/bin/env bash
# Starts the daimon2 production build (generated by build.sh).
HERE="\$(cd "\$(dirname "\$0")" && pwd)"
# WebKitGTK's DMA-BUF renderer shows a blank window under WSLg's virtual GPU.
grep -qi microsoft /proc/version 2>/dev/null && export WEBKIT_DISABLE_DMABUF_RENDERER=1
# WebKitGTK can't repaint a see-through window with accelerated compositing.
[ "\$(uname -s)" = Linux ] && [ "\${DAIMON_TRANSPARENT:-0}" = 1 ] && export WEBKIT_DISABLE_COMPOSITING_MODE=1
exec "\$HERE/$launcher" "\$@"
EOF
  chmod +x "$out/daimon"
  log "done → $out/daimon"
}

# ── 4. WSL: native Windows app ────────────────────────────────────────────────
# Built with Windows tooling in %LOCALAPPDATA%\daimon-build, which mirrors the repo
# layout (app/, ui/dist, target/release) so electrobun.config.ts finds the same payload.
# Windows tooling is slow and lock-prone on the WSL filesystem, and the app has to live
# on the Windows side anyway.

# A running copy would lock the files we're about to replace.
win_stop() {
  (cd /mnt/c && powershell.exe -NoProfile -Command \
    "Get-Process cottontail,launcher -ErrorAction SilentlyContinue | Where-Object { \$_.Path -like '$(wslpath -w "$1")\\*' } | Stop-Process -Force" \
    </dev/null >/dev/null 2>&1) || true
}

build_windows() {
  local la stage out dll archive exe
  la=$(cd /mnt/c 2>/dev/null && cmd.exe /c "echo %LOCALAPPDATA%" 2>/dev/null | tr -d '\r')
  [ -n "$la" ] && [ "$la" != "%LOCALAPPDATA%" ] || { log "couldn't resolve %LOCALAPPDATA%"; return 1; }
  stage="$(wslpath -u "$la")/daimon-build"
  out="$stage/daimon2-win-x64"
  mkdir -p "$stage/tools" "$stage/app" "$stage/ui" "$stage/target/release" || return 1

  if [ ! -x "$stage/tools/bun.exe" ]; then
    if [ -x "$stage/../daimon-dev/tools/bun.exe" ]; then   # dev.sh already fetched one
      cp "$stage/../daimon-dev/tools/bun.exe" "$stage/tools/" || return 1
    else
      log "downloading portable bun.exe for Windows → $la\\daimon-build\\tools (one-time)..."
      ( cd "$stage/tools" \
        && curl.exe -fsSL -o bun.zip https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip \
        && tar.exe -xf bun.zip \
        && mv bun-windows-x64/bun.exe bun.exe \
        && rm -rf bun.zip bun-windows-x64 ) || { log "bun.exe download failed"; return 1; }
    fi
  fi

  log "building Electrobun app (win-x64, stable)..."
  win_stop "$out"
  rm -rf "$stage/app/src" "$stage/ui/dist" "$stage/app/build" "$stage/app/artifacts"
  cp -r "$ROOT/app/src" "$stage/app/src" && cp -r "$ROOT/ui/dist" "$stage/ui/dist" \
    && cp "$ROOT/target/release/pty-daemon" "$stage/target/release/" \
    && cp "$ROOT/app/electrobun.config.ts" "$stage/app/" || return 1
  # The Windows app starts its daemon with `wsl.exe -d <this distro>`.
  printf '%s' "${WSL_DISTRO_NAME:-}" > "$stage/app/wsl-distro"
  if ! cmp -s "$ROOT/app/package.json" "$stage/app/package.json" || [ ! -d "$stage/app/node_modules" ]; then
    cp "$ROOT/app/package.json" "$ROOT/app/bun.lock" "$stage/app/" || return 1
    (cd "$stage/app" && ../tools/bun.exe install --frozen-lockfile </dev/null) || return 1
  fi
  (cd "$stage/app" && WSLENV="${WSLENV:+$WSLENV:}NODE_ENV" NODE_ENV=production \
    ../tools/bun.exe node_modules/electrobun/bin/electrobun.cjs build --env=stable </dev/null) || return 1

  archive=$(ls "$stage"/app/artifacts/stable-win-x64-*.tar.zst 2>/dev/null | head -1)
  [ -n "$archive" ] || { log "no stable-win-x64-*.tar.zst produced"; return 1; }
  unpack "$archive" "$out"
  [ -f "$out/daimon2/bin/launcher.exe" ] || { log "unpacked Windows app has no launcher.exe"; return 1; }
  exe=$(wslpath -w "$out/daimon2/bin/launcher.exe")

  # Optional blur helper, loaded from next to the executable: any blur radius instead
  # of Windows' three fixed steps.
  if dll=$("$ROOT/crates/win-backdrop/build.sh") && cp "$dll" "$out/daimon2/bin/win_backdrop.dll"; then :
  else log "blur helper not built — the app uses Windows' fixed blur steps (see crates/win-backdrop/build.sh)"; fi

  # Launcher on the WSL side, so both builds start the same way.
  mkdir -p "$ROOT/dist/daimon2-win-x64"
  cat > "$ROOT/dist/daimon2-win-x64/daimon" <<EOF
#!/usr/bin/env bash
# Starts the native Windows production build of daimon2 (generated by build.sh).
# On Windows: $exe
export WSLENV="\${WSLENV:+\$WSLENV:}DAIMON_TRANSPARENT:DAIMON_BACKDROP"
cd "$out/daimon2/bin" && exec ./launcher.exe "\$@"
EOF
  chmod +x "$ROOT/dist/daimon2-win-x64/daimon"
  log "done → $ROOT/dist/daimon2-win-x64/daimon"
  log "       (on Windows: $exe)"
}

[ "$BUILD_HOST" = 1 ] && build_host
if [ "$BUILD_WIN" = 1 ] && ! build_windows; then
  [ "$BUILD_HOST" = 1 ] || die "Windows app failed"
  log "Windows app failed — the WSLg app above is still good"
fi
exit 0
