#!/usr/bin/env bash
# Cross-builds win_backdrop.dll from WSL/Linux: rustc's bundled lld links against the
# MSVC + Windows SDK libraries of a Visual Studio install on the Windows side.
# Prints the path of the built DLL. Exits non-zero if the toolchain isn't available.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET=x86_64-pc-windows-msvc

rustup target list --installed 2>/dev/null | grep -qx "$TARGET" \
  || { echo "rust target $TARGET not installed (rustup target add $TARGET)" >&2; exit 1; }

newest() { ls -d "$@" 2>/dev/null | sort -V | tail -1; }
MSVC=$(newest /mnt/c/Program\ Files*/Microsoft\ Visual\ Studio/*/*/VC/Tools/MSVC/*/lib/x64)
KIT=$(newest /mnt/c/Program\ Files*/Windows\ Kits/10/Lib/*/um/x64)
[ -n "$MSVC" ] && [ -n "$KIT" ] \
  || { echo "Visual Studio C++ tools / Windows SDK not found under /mnt/c" >&2; exit 1; }
UCRT="${KIT%/um/x64}/ucrt/x64"

U=$'\x1f'  # cargo's separator for flags that contain spaces
CARGO_ENCODED_RUSTFLAGS="-Clinker=rust-lld${U}-Lnative=${MSVC}${U}-Lnative=${KIT}${U}-Lnative=${UCRT}" \
  cargo build -q --manifest-path "$ROOT/Cargo.toml" -p win-backdrop --release --target "$TARGET" >&2
echo "$ROOT/target/$TARGET/release/win_backdrop.dll"
