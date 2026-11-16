# Architecture

Three processes, one WebSocket.

```
┌──────────────────────────┐        ┌──────────────────────────┐
│ App shell (Electrobun)   │ opens  │ UI (React, in a webview) │
│ window, menu, native FFI │───────▶│ blocks, composer, wraith │
└────────────┬─────────────┘        └────────────┬─────────────┘
             │ finds or starts                   │ WebSocket, JSON
             ▼                                   ▼ ws://localhost:7878/?token=…
┌──────────────────────────────────────────────────────────────┐
│ pty-daemon (Rust)                                            │
│ PTY sessions · SQLite store · completions · git queries      │
└────────────┬─────────────────────────────────────────────────┘
             │ PTY
             ▼
   zsh + shell integration ──calls──▶ daimon CLI (Rust) ──▶ OSC 133 markers
```

## Parts

| part | tech | job |
|------|------|-----|
| pty-daemon | Rust, tokio, tokio-tungstenite, portable-pty, rusqlite | owns the shells, serves the WebSocket, stores history |
| shell-parser | Rust, regex-lite | detects and strips OSC 133 markers, alt-screen and PTY mode sequences |
| daimon-complete | Rust, serde_yaml, git2 | completion engine driven by YAML specs |
| daimon CLI | Rust, git2 | shell hooks (`precmd`, `preexec`), `setup`, `shell-profiling` |
| win-backdrop | Rust, `windows` crate | Windows-only DLL: variable-radius desktop blur |
| shell integration | zsh | hooks that call the CLI; a pure-zsh variant for SSH remotes |
| app shell | Electrobun, Bun, `bun:ffi` | window, app menu, daemon lifecycle, native window tweaks |
| UI | React 19, Vite, Tailwind 4, TanStack Router, Radix/shadcn, wraithterm | everything you see |

## pty-daemon

- One PTY + one reader thread per session (tab). Sessions share nothing.
- All session events go through one channel and are fanned out to every connected client.
- Listens on `127.0.0.1` only. Every connection must carry `?token=`; the token is a 32-byte random secret stored with mode 0600.
- A running daemon publishes an info file (`pid`, `port`, `token`, `build`) so the app can find it. `build` is a hash of the binary, used to spot an outdated daemon.
- Keeps the last 2 MB of output of the running command per session, so a restarted UI can reattach.
- Translates the kitty graphics protocol into iTerm2 inline images (OSC 1337), which blocks render as `<img>`.
- Git data for the structured views comes from running `git` in the session's cwd.
- Runs detached in the background, so it outlives the app.

### Protocol

JSON text frames, tagged by `type`.

- **UI → daemon, fire and forget:** `write`, `resize`, `close`, `attach`, `redraw`.
- **UI → daemon, request/response (matched by `req_id`):**
  - git: `gitStatus`, `gitLog`, `gitBranch`, `gitDiff`, `commitDetail`, `fileDiff`, `fileContent`
  - completion: `complete`, `listPaths`
  - store: `historyAdd/List/Search`, `blockSave/List/Recent/Search/Clear`, `prefGet/Set`
  - daemon: `daemonInfo`, `shutdown`
- **daemon → UI:** `output`, `prompt`, `commandStart`, `altScreenEnter`, `altScreenExit`, `exit`, `response`.

A session is created on the first `write` to an unknown tab id.

### Storage

SQLite in WAL mode, compiled into the daemon.

| table | holds |
|-------|-------|
| `history` | unique commands with last-used timestamp |
| `blocks` | finished blocks: input, cwd, context, exit code, output as JSON |
| `blocks_fts` | FTS5 index over block inputs |
| `prefs` | key/value: theme, open sessions, notification settings, … |

Font size, window opacity/blur and the markdown-preview toggle are kept in the webview's `localStorage`.

## Shell integration

How daimon knows where a command starts and ends:

1. The daemon starts zsh with its own `ZDOTDIR`. That startup file sources the user's real `~/.zshrc`, then daimon's hooks. It also defines a `daimon` function, so the CLI works at the prompt without being on `PATH`.
2. Two hooks are registered:
   - `preexec` → `daimon preexec` prints `OSC 133;C` (command started)
   - `precmd` → `daimon precmd` prints `OSC 133;A{json}` (prompt ready) with cwd, exit code, git state (libgit2, no subprocess), k8s and OpenStack context
3. The daemon sees the markers in the PTY stream, strips them, and emits `commandStart` / `prompt` events.
4. The UI turns everything between the two into a block.

**SSH:** after `ssh` connects, the UI pastes a base64 one-liner into the remote zsh. It installs hooks that emit the same markers in pure zsh, so remote commands become blocks too. Nothing is installed on the remote.

## UI

A single-page React app. It holds the sessions, panes and blocks in memory and talks to the daemon through one auto-reconnecting WebSocket client. Finished blocks, history and prefs are saved through the daemon, not in the browser.

The UI gets the daemon token and port from the page URL (set by the app shell). In a plain browser on the Vite dev server it fetches them from a dev-only endpoint.

### Two ways to show output

| | blocks | terminal |
|---|--------|----------|
| used for | normal commands | TUI programs |
| chosen when | default | daemon reports alt-screen, output contains cursor-addressing / clear-screen / mouse-tracking sequences, or the command is a known interactive one (`kubectl exec`, `docker run -it`, `sudo su`, …) |
| rendered by | daimon's own parser → React/DOM | Wraith (WebGPU canvas) |

**Blocks:** output is parsed into typed parts: plain/ANSI lines, image, `ls -la`, table, git status/log/branches/diff, logfmt, JSON/YAML. Long outputs are virtualized. `git log` and `git diff` open in a keyboard-driven pager. No terminal emulator involved.

**Markdown preview in diffs:** changed `.md` files can be shown rendered instead of as a raw diff. The UI asks the daemon for the full file (git blob, or the working-tree file as fallback), renders it with `marked`, sanitizes with DOMPurify, highlights code with highlight.js, and marks the changed parts. Markdown that likely didn't render as intended is listed as a warning.

**Terminal (Wraith):**

- `wraithterm` 0.6.1, native profile: Ghostty's `libghostty-vt` (Zig) and a Rust WebGPU renderer, compiled into one Wasm module, running in a dedicated worker. The main thread only handles input.
- One instance per TUI block, mounted when the block turns into a TUI and disposed when it ends. Inline it is a fixed-height viewport; alt-screen programs cover the whole pane.
- Wiring: PTY output → terminal; terminal input → PTY; terminal resize → PTY resize. Wraith fits itself to its container.
- Bytes that arrived before the terminal finished mounting are replayed from a per-tab buffer.
- Wraith's own command blocks (OSC 133) are turned off; daimon draws its own.
- Kitty keyboard protocol is handled by Wraith.
- A Vite plugin shipped with wraithterm keeps the worker, Wasm and font URLs intact in the build.
- WebGPU is required. There is no fallback renderer: without WebGPU the block shows the error.

## App shell

One window, pointing at the Vite dev server (dev) or the bundled UI (production).

Daemon lifecycle (production only; in dev the dev script starts the daemon):

1. Ask the daemon binary whether one is already running.
2. A daemon of the same build is running → use it.
3. An older build is running → keep it if it has sessions, otherwise shut it down.
4. None → start one, detached.

Native window tweaks, all through `bun:ffi`:

| platform | what |
|----------|------|
| macOS | native title-bar drag, pinch-to-zoom |
| Windows | desktop blur (helper DLL, or DWM fallback), custom title bar with resize edges, handing keyboard focus to WebView2, window icon |

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
| 7877 | daemon (dev), so dev never touches your real sessions |
| 7881 | Vite dev server |

## Build

- **Dev:** debug build of the Rust workspace, then daemon + Vite + the Electrobun app run side by side.
- **Production:** release build of the Rust workspace, Vite build of the UI, stable Electrobun build. The UI bundle and the daemon binary are copied into the app bundle.

## Known limits

- The daemon locates the shell integration and the debug CLI relative to the source checkout, fixed at compile time. A production build still needs the checkout in place, and `daimon` on `PATH` if there is no debug build.
- Command blocks need zsh, locally and on SSH remotes.
- TUI programs need a webview with WebGPU.
- Images inside TUI programs: the daemon still rewrites kitty graphics to OSC 1337 (done for xterm.js's image addon). Wraith's docs list kitty graphics but not OSC 1337, so these images likely don't show in the terminal. Images in normal blocks are unaffected.
