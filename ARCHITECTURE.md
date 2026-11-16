# Architecture

Three processes, one WebSocket.

```
┌──────────────────────────┐        ┌──────────────────────────┐
│ Electrobun app (Bun)     │ opens  │ UI (React, in a webview) │
│ app/src/bun              │───────▶│ ui/src                   │
│ window, menu, native FFI │        │ blocks, composer, xterm  │
└────────────┬─────────────┘        └────────────┬─────────────┘
             │ finds or starts                   │ WebSocket, JSON
             ▼                                   ▼ ws://localhost:7878/?token=…
┌──────────────────────────────────────────────────────────────┐
│ pty-daemon (Rust)                                            │
│ PTY sessions · SQLite store · completions · git queries      │
└────────────┬─────────────────────────────────────────────────┘
             │ PTY
             ▼
   zsh + shell-integration ──calls──▶ daimon CLI (Rust) ──▶ OSC 133 markers
```

## Parts

| part | path | tech | job |
|------|------|------|-----|
| pty-daemon | `crates/pty-daemon` | Rust, tokio, tokio-tungstenite, portable-pty, rusqlite | owns the shells, serves the WebSocket, stores history |
| shell-parser | `crates/shell-parser` | Rust, regex-lite | detects and strips OSC 133 markers, alt-screen, PTY mode sequences |
| daimon-complete | `crates/daimon-complete` | Rust, serde_yaml, git2 | completion engine driven by YAML specs (`specs/`) |
| daimon CLI | `crates/daimon-cli` | Rust, git2 | `precmd` / `preexec` shell hooks, `setup`, `shell-profiling` |
| win-backdrop | `crates/win-backdrop` | Rust, `windows` crate | Windows-only DLL: variable-radius desktop blur |
| shell integration | `shell-integration/` | zsh | hooks that call the CLI; `warpify.zsh` for SSH |
| app shell | `app/` | Electrobun, Bun, `bun:ffi` | window, app menu, daemon lifecycle, native window tweaks |
| UI | `ui/` | React 19, Vite, Tailwind 4, TanStack Router, Radix/shadcn, xterm.js | everything you see |

## pty-daemon

- One PTY + one reader thread per session (tab). Sessions share nothing.
- All session events go through one channel and are fanned out to every connected client.
- Listens on `127.0.0.1` only. Every connection must carry `?token=`; the token is a 32-byte random secret stored with mode 0600.
- A running daemon publishes `daemon-<port>.json` (`pid`, `port`, `token`, `build`) so the app can find it. `build` is a hash of the binary, used to spot an outdated daemon.
- Keeps the last 2 MB of output of the running command per session, so a restarted UI can reattach (`attach`).
- Translates the kitty graphics protocol into iTerm2 inline images (OSC 1337), which the UI already renders.
- Git data for the structured views comes from running `git` in the session's cwd.

Flags: `--detach` (background, production default), `--exit-with-parent`, `--info`, `--token`.

### Protocol

JSON text frames, tagged by `type`. Defined in `crates/pty-daemon/src/session.rs`, client in `ui/src/lib/daimon/rpc.ts`.

- **UI → daemon:** `write`, `resize`, `close`, `attach`, `redraw`, plus request/response calls with a `req_id`: `gitStatus`, `gitLog`, `gitBranch`, `gitDiff`, `commitDetail`, `fileDiff`, `complete`, `listPaths`, `historyAdd/List/Search`, `blockSave/List/Recent/Search/Clear`, `prefGet/Set`, `daemonInfo`, `shutdown`.
- **daemon → UI:** `output`, `prompt`, `commandStart`, `altScreenEnter`, `altScreenExit`, `exit`, `response`.

A session is created on the first `write` to an unknown `tab_id`.

### Storage

SQLite (`daimon.db`, WAL mode), bundled with the binary.

| table | holds |
|-------|-------|
| `history` | unique commands with last-used timestamp |
| `blocks` | finished blocks: input, cwd, context, exit code, output as JSON |
| `blocks_fts` | FTS5 index over block inputs |
| `prefs` | key/value: theme, open sessions, notification settings, … |

Font size and window opacity/blur are kept in the webview's `localStorage`.

## Shell integration

How daimon knows where a command starts and ends:

1. The daemon starts zsh with `ZDOTDIR=shell-integration/`. That `.zshrc` sources the user's real `~/.zshrc`, then `daimon.zsh`.
2. `daimon.zsh` registers two hooks:
   - `preexec` → `daimon preexec` prints `OSC 133;C` (command started)
   - `precmd` → `daimon precmd` prints `OSC 133;A{json}` (prompt ready) with cwd, exit code, git state (libgit2, no subprocess), k8s and OpenStack context
3. The daemon sees the markers in the PTY stream, strips them, and emits `commandStart` / `prompt` events.
4. The UI turns everything between the two into a block.

**SSH:** after `ssh` connects, the UI pastes a base64 one-liner that sources `warpify.zsh` into the remote zsh. It emits the same markers in pure zsh, so remote commands become blocks too.

## UI

- `routes/index.tsx` — app state: sessions, panes, shortcuts.
- `lib/daimon/rpc.ts` — WebSocket client, reconnects automatically.
- `lib/daimon/shell.ts` — runs a command and parses its output into typed parts: plain/ANSI lines, image, `ls -la`, table, git status/log/branches/diff, logfmt, JSON/YAML.
- `components/daimon/BlockView.tsx` — renders those parts. Long outputs are virtualized.
- TUI programs (alt-screen or cursor-addressing output) switch the block to an xterm.js terminal: WebGL renderer with DOM fallback, image addon, kitty keyboard protocol (`lib/daimon/kittyKeyboard.ts`).

The UI gets the daemon token and port from the page URL (set by the app). In a plain browser on the Vite dev server it fetches them from `/__daimon`.

## App shell

`app/src/bun/index.ts` creates one window pointing at the Vite server (dev) or the bundled `views://daimon2/index.html` (production).

Daemon lifecycle (`daemon.ts`, production only):

1. Ask `pty-daemon --info`.
2. A daemon of the same build is running → use it.
3. An older build is running → keep it if it has sessions, otherwise shut it down.
4. None → start one with `--detach`.

Native bits, all through `bun:ffi`:

| file | platform | does |
|------|----------|------|
| `macWindowDrag.ts` + `DaimonDragOverlay.m` | macOS | native title-bar drag |
| `macMagnification.ts` | macOS | pinch-to-zoom |
| `winBackdrop.ts` | Windows | desktop blur (helper DLL or DWM fallback) |
| `winFrame.ts` | Windows | custom title bar: window styles, top-edge resize |
| `winFocus.ts` | Windows | hands keyboard focus to WebView2 |
| `winIcon.ts` | Windows | window icon |

## Platforms

| platform | webview | daemon runs |
|----------|---------|-------------|
| macOS | WKWebView | natively |
| Linux | WebKitGTK | natively |
| Windows | WebView2 | inside WSL, reached through localhost forwarding |

The daemon itself is Unix-only.

## Ports

| port | what |
|------|------|
| 7878 | daemon (production) |
| 7877 | daemon (`dev.sh`), so dev never touches your real sessions |
| 7881 | Vite dev server |

## Build

- `dev.sh` — debug build of the Rust workspace, then runs daemon + Vite + the Electrobun app (`electrobun build`, `electrobun run`).
- `build.sh` — `cargo build --release`, `vite build`, `electrobun build --env=stable`, unpacks the result into `dist/`.
- `app/electrobun.config.ts` copies `ui/dist` and `target/release/pty-daemon` into the app bundle.

## Known limits

- The daemon resolves `shell-integration/` and `target/debug/daimon` relative to the source checkout at compile time. A production build still needs the checkout in place, and `daimon` on `PATH` if there is no debug build.
- Command blocks need zsh, locally and on SSH remotes.

## Not wired up

In the repo, not used by the app:

- `static/index.html` — early standalone prototype
- `ui/src/components/daimon/TerminalCanvas.tsx`, `ui/scripts/embed-wasm.ts` — canvas renderer for a WASM VT engine that isn't in the repo
- `ui/src/components/daimon/GazeCalibration.tsx`, `ui/src/lib/daimon/gaze.ts` — eye-tracking experiment (MediaPipe)
- `ui/src/server.ts`, `ui/src/start.ts` — SSR leftovers; the Vite build enters at `index.html` → `main.tsx`
- `app/allow_magnification.dylib` — replaced by `macMagnification.ts`
