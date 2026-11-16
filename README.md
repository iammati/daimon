# Daimon

A terminal built different. Runs on macOS, Linux and Windows (via WSL2).

---

## What it is

A fast, minimal terminal with a smart shell that understands what you're doing — not just what you're typing. Every command is a block: input, output, exit code, duration, cwd.

- **Landing page** — resume where you left off, recent dirs with live git status, failed commands from the last 24h
- **Persistent sessions** — shells live in a background daemon; close the app, reopen it, running commands are still there
- **Cross-session history** — commands and blocks persist to SQLite (full-text search), `~/.zsh_history` is imported once
- **Command palette** — `⌘P` to jump to any dir, command, block or session
- **Rich output** — `git status/log/branch/diff`, `ls -la`, tables, JSON/YAML, logfmt rendered as structured blocks, not raw text
- **TUI apps inline** — vim, htop, k9s etc. run in an xterm.js view inside the block (WebGL, kitty keyboard protocol, inline images)
- **SSH** — remote zsh sessions get the same command blocks, nothing to install on the remote
- **Completions** — `Tab` for subcommands, flags, paths, git branches/tags/remotes; YAML specs, add your own in `~/.config/daimon/specs/`
- **Context** — git branch/dirty/ahead/behind, k8s context + namespace, OpenStack region/project in the prompt bar
- **Split panes** — two sessions side by side
- **Presentation mode** — `⌘⇧P` redacts secrets in output
- **Links** — clickable URLs and file paths in output
- **Notifications** — optional, for commands running longer than a threshold
- **Appearance** — light / dracula theme, font size, window opacity and blur

---

## Techstack

- **Rust** — PTY daemon, WebSocket server, SQLite store, completion engine, shell-hook CLI
- **React + Vite + Tailwind** — UI, xterm.js for TUI apps
- **Electrobun** — app shell (Bun main process + system webview: WKWebView / WebKitGTK / WebView2)
- **zsh** — shell integration via OSC 133 markers

Details: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Run

```sh
./dev.sh
```

Starts the Rust daemon (port 7877), Vite dev server (port 7881), and the Electrobun app in one shot. `Ctrl+C` stops all three.

### Production build

```sh
./build.sh
dist/daimon2-<os>-<arch>/daimon
```

Builds release binaries, the UI bundle and a stable Electrobun app for this machine. The app bundles the UI and starts its own daemon (port 7878), so `dev.sh` doesn't need to be running. On WSL2 it builds two apps: `dist/daimon2-linux-<arch>` (WSLg) and `dist/daimon2-win-x64` (native Windows); skip one with `DAIMON_LINUX=0` or `DAIMON_WINDOWS=0`.

### Prerequisites

All platforms: [Rust](https://rustup.rs) (stable, ≥ 1.86), [Bun](https://bun.sh), Node, and `zsh` (shell integration relies on it).

- **macOS** — `xcode-select --install`
- **Linux (Debian/Ubuntu)** —
  ```sh
  sudo apt-get install -y build-essential pkg-config cmake zsh lsof \
    libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
  ```
- **Windows** — run `./dev.sh` inside **WSL2** (Ubuntu/Debian). The daemon, shell and Vite run in WSL; the app window runs **natively on Windows** (WebView2) with a see-through window and real desktop blur. First run downloads a portable `bun.exe` and stages `app/` under `%LOCALAPPDATA%\daimon-dev`; nothing is installed system-wide. Needs the WebView2 runtime (preinstalled on Windows 11).
  - `DAIMON_WINDOWS=0 ./dev.sh` shows the window through WSLg (WebKitGTK) instead — needs the Linux packages above; also the automatic fallback if the Windows side can't be set up.
  - The adjustable blur radius comes from a helper DLL (`crates/win-backdrop`), cross-built with `rustup target add x86_64-pc-windows-msvc` and the C++ tools + Windows SDK of a Visual Studio install on the Windows side. Without those the app falls back to Windows' three fixed blur steps (off / soft / frosted).
  - Native Windows shells (PowerShell/Git Bash) aren't supported.

### Environment variables

| variable | effect |
|----------|--------|
| `DAIMON_SHELL` | shell to run instead of zsh (no command blocks without zsh) |
| `DAIMON_PORT` | daemon port (default `7878`, `dev.sh` uses `7877`) |
| `DAIMON_PERSIST=0` | production: daemon and sessions end with the app |
| `DAIMON_WINDOWS=0` | WSL2: use the WSLg window instead of the native Windows one |
| `DAIMON_TRANSPARENT=1` / `0` | see-through window: opt-in on Linux/WSLg, opt-out on macOS/Windows |
| `DAIMON_BLUR=<px>` | Windows: pin the blur radius |
| `DAIMON_BACKDROP=none\|blur\|acrylic` | Windows: pin one of the fixed blur steps |

### Where data lives

| what | macOS | Linux |
|------|-------|-------|
| history, blocks, prefs (`daimon.db`) | `~/Library/Application Support/daimon/` | `~/.local/share/daimon/` |
| daemon token, info file, log | `~/Library/Application Support/daimon/` | `~/.local/state/daimon/` |
| user completion specs, `config.zsh` | `~/.config/daimon/` | `~/.config/daimon/` |

---

## Keyboard shortcuts

`⌘` is `Ctrl` on Linux and Windows.

| key | action |
|-----|--------|
| `⌘P` | command palette |
| `⌘F` | search all blocks |
| `⌘H` | history panel |
| `⌘T` / `⌘W` | new / close session |
| `⌘1`–`⌘9` | switch session |
| `⌘D` / `⌘⇧D` | split pane (or switch pane) / close split |
| `⌘B` | sidebar |
| `⌘J` | context switcher |
| `⌘,` | settings |
| `⌘K` | shortcuts overview |
| `⌘⇧P` | presentation mode |
| `⌘=` / `⌘-` | font size |
| `Tab` | complete |
| `↑ ↓` | history |
| `Ctrl+C` | interrupt running command |

On a hovered block:

| key | action |
|-----|--------|
| `⌘⇧C` | copy block (input + output) |
| `⌘⇧I` / `⌘⇧O` | copy input / output |
| `⌘⇧R` | rerun |
| `⌘⇧E` | collapse / expand |
