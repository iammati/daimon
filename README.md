# Daimon

A macOS terminal built different.

---

## What it is

A fast, minimal terminal with a smart shell that understands what you're doing — not just what you're typing.

- **Landing page** — resume where you left off, recent dirs with live git status, failed commands that need attention
- **Cross-session history** — every command persists to SQLite, searchable across all sessions with ⌘F
- **Command palette** — ⌘P to jump to any dir, command, or session
- **Rich output** — git diffs, `ls -la`, log streams rendered as structured blocks, not raw text
- **Inline search** — ⌘F per block to grep output in place
- **URL detection** — clickable links in output
- **Font size** — ⌘= / ⌘- live scaling, persisted

---

## Techstack

- **Rust** — PTY daemon, WebSocket server, SQLite store, shell completions
- **React + Vite** — UI rendered in WKWebView
- **Electrobun** — macOS app shell (Bun-based)

---

## Run

```sh
./dev.sh
```

Starts the Rust daemon, Vite dev server, and Electrobun app in one shot. Currently no production-builds.

### Prerequisites

All platforms: [Rust](https://rustup.rs) (stable), [Bun](https://bun.sh), Node, and `zsh` (shell integration relies on it; override the shell with `DAIMON_SHELL`).

- **macOS** — `xcode-select --install`
- **Linux (Debian/Ubuntu)** —
  ```sh
  sudo apt-get install -y build-essential pkg-config cmake zsh lsof \
    libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
  ```
- **Windows** — run `./dev.sh` inside **WSL2** (Ubuntu/Debian). The pty-daemon, shell and Vite run in WSL; the app window runs **natively on Windows** (WebView2), which gives a see-through window with real desktop blur (Settings → Appearance: *Background opacity* and *Background blur*, a 0–60 px radius). First run downloads a portable `bun.exe` and stages `app/` under `%LOCALAPPDATA%\daimon-dev`; nothing is installed system-wide. Needs the WebView2 runtime (preinstalled on Windows 11).
  - `DAIMON_WINDOWS=0 ./dev.sh` shows the window through WSLg (WebKitGTK) instead — needs the Linux packages above; also the automatic fallback if the Windows side can't be set up. There, `DAIMON_TRANSPARENT=1` gives a see-through window but no desktop blur.
  - The adjustable blur radius comes from a small helper DLL (`crates/win-backdrop`), cross-built by `dev.sh` with `rustup target add x86_64-pc-windows-msvc` and the C++ tools + Windows SDK of a Visual Studio install on the Windows side. Without those the app falls back to Windows' three fixed blur steps (off / soft / frosted).
  - `DAIMON_TRANSPARENT=0` forces an opaque window; `DAIMON_BLUR=<px>` pins the blur radius; `DAIMON_BACKDROP=none|blur|acrylic` pins one of the fixed steps.
  - Native Windows shells (PowerShell/Git Bash) aren't supported by `dev.sh`.

---

## Keyboard shortcuts

| key | action |
|-----|--------|
| `⌘P` | command palette |
| `⌘F` | search all blocks |
| `⌘T` | new session |
| `⌘K` | clear |
| `⌘=` / `⌘-` | font size |
| `⌘⇧C` | copy block (input + output) |
| `Tab` | complete |
| `↑ ↓` | history |
