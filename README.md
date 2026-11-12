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
