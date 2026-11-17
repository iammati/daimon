/// Per-tab PTY session. Each session owns its PTY master fd and shell process.
/// No shared mutable state between sessions — the compiler enforces this.

use anyhow::{Context, Result};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use shell_parser::{is_alt_screen_enter, is_command_start_marker, is_prompt_marker, strip_osc133, strip_pty_modes};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Messages sent from session → WebSocket → frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionEvent {
    /// Raw PTY output chunk for this session.
    Output { tab_id: String, data: String },
    /// PTY process exited.
    Exit { tab_id: String, code: i32 },
    /// Shell prompt detected — daimon's OSC 133;A marker (prompt ready).
    Prompt { tab_id: String, context: String },
    /// Command started — daimon's OSC 133;C marker (preexec).
    CommandStart { tab_id: String },
    /// Alt-screen entered (vim/nano).
    AltScreenEnter { tab_id: String },
    /// Alt-screen exited.
    AltScreenExit { tab_id: String },
    /// Response to a request command (git status, git log, etc).
    Response { req_id: String, ok: bool, data: serde_json::Value },
}

/// Messages sent frontend → WebSocket → session.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionCommand {
    /// Write raw bytes to the PTY (keystrokes, commands). `command`: the command line
    /// this write starts, remembered so a reattaching UI can label the running block.
    Write { tab_id: String, data: String, #[serde(default)] command: Option<String> },
    /// Reattach to a session (after the UI restarted): running command, output, context.
    Attach { req_id: String, tab_id: String },
    /// Make the running full-screen program repaint (after a reattach).
    Redraw { tab_id: String },
    /// Daemon build and session count (the app checks before replacing an old daemon).
    DaemonInfo { req_id: String },
    /// Stop the daemon (ends all sessions).
    Shutdown { req_id: String },
    /// Resize the PTY window.
    Resize { tab_id: String, cols: u16, rows: u16 },
    /// Close/kill the session.
    Close { tab_id: String },
    /// Run `git --no-pager status --porcelain=v1 -b` in cwd.
    GitStatus { req_id: String, cwd: String },
    /// Run `git --no-pager log` in cwd, with the user's extra args (revisions, filters, paths).
    GitLog { req_id: String, cwd: String, limit: usize, #[serde(default)] args: Vec<String> },
    /// Run `git --no-pager branch` in cwd.
    GitBranch { req_id: String, cwd: String },
    /// Run `git --no-pager diff` with optional extra args in cwd.
    GitDiff { req_id: String, cwd: String, args: Vec<String> },
    /// List k8s contexts from kubeconfig.
    ListContexts { req_id: String },
    /// Run `u8s sync` to refresh kubeconfig.
    SyncContexts { req_id: String },
    /// List OpenStack regions.
    ListRegions { req_id: String },
    /// List filesystem paths for autocomplete.
    ListPaths { req_id: String, prefix: String, cwd: String, kind: String },
    /// Full completion: specs + filesystem + manpages via gc-suggest.
    Complete { req_id: String, buffer: String, cwd: String },
    /// Get files changed in a commit + commit body.
    CommitDetail { req_id: String, hash: String, cwd: String },
    /// Get unified diff for a single file in a commit.
    FileDiff { req_id: String, hash: String, file_path: String, cwd: String },
    /// Full content of a file version: git blob if given/known, else the working-tree file.
    FileContent { req_id: String, blob: String, file_path: String, cwd: String },
    /// Open Graph preview (title, description, image) of a public http(s) URL.
    LinkPreview { req_id: String, url: String },
    /// Add a command to history (with ms timestamp).
    HistoryAdd { req_id: String, cmd: String, ts: i64 },
    /// List history entries, most-recent first.
    HistoryList { req_id: String, limit: usize },
    /// Save a completed block to the DB.
    BlockSave { req_id: String, block: serde_json::Value },
    /// Load blocks for a session.
    BlockList { req_id: String, session_id: String, limit: usize },
    /// Load recent blocks across all sessions, newest first.
    BlockRecent { req_id: String, limit: usize },
    /// Clear all blocks for a session.
    BlockClear { req_id: String, session_id: String },
    /// FTS5 search across block inputs.
    BlockSearch { req_id: String, query: String, limit: usize },
    /// Search history by substring.
    HistorySearch { req_id: String, query: String, limit: usize },
    /// Set a preference value.
    PrefSet { req_id: String, key: String, value: String },
    /// Get a preference value.
    PrefGet { req_id: String, key: String },
    /// Run `tailscale status --json`.
    TailscaleStatus { req_id: String },
    /// Run `tailscale up` (connect / re-auth).
    TailscaleUp { req_id: String },
    /// Run `tailscale down` (disconnect).
    TailscaleDown { req_id: String },
    /// Run `tailscale login --force-reauth` and return the auth URL.
    TailscaleLoginUrl { req_id: String },
}

/// Pick the shell to run. Daimon's OSC 133 integration is loaded via ZDOTDIR,
/// which only zsh honours — so prefer zsh even when $SHELL is something else
/// (e.g. bash, the default on most Linux/WSL distros). Override with DAIMON_SHELL.
fn pick_shell() -> String {
    if let Ok(s) = std::env::var("DAIMON_SHELL") {
        return s;
    }
    let env_shell = std::env::var("SHELL").ok();
    if let Some(s) = &env_shell {
        if s.ends_with("/zsh") {
            return s.clone();
        }
    }
    for p in ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh", "/opt/homebrew/bin/zsh"] {
        if std::path::Path::new(p).exists() {
            return p.into();
        }
    }
    tracing::warn!("zsh not found — falling back to $SHELL; shell integration will be unavailable");
    env_shell.unwrap_or_else(|| "/bin/sh".into())
}

/// What a reconnecting UI needs to pick a session back up (see `Session::attach`).
#[derive(Default)]
struct SessionState {
    /// A command is running (between OSC 133;C and the next 133;A).
    running: bool,
    /// What the UI said it was running (the `command` field of the Write that started it).
    command: Option<String>,
    command_hint: Option<String>,
    started_at: i64,
    alt_screen: bool,
    /// Output of the running command as sent to the UI — the tail, capped.
    output: String,
    /// JSON context from the last prompt (cwd, git, …).
    context: Option<String>,
    exited: bool,
    size: (u16, u16),
    modes: Modes,
}

const REPLAY_LIMIT: usize = 2 << 20;

impl SessionState {
    /// Keep the last REPLAY_LIMIT bytes. Trims only once the buffer reaches twice that, so
    /// the move is amortised: PTY reads are a few hundred bytes, and shifting 2 MB on every
    /// one of them made this the daemon's hottest spot.
    fn push_output(&mut self, data: &str) {
        self.output.push_str(data);
        if self.output.len() > 2 * REPLAY_LIMIT {
            let mut cut = self.output.len() - REPLAY_LIMIT;
            while !self.output.is_char_boundary(cut) { cut += 1; }
            self.output.drain(..cut);
        }
    }

    /// The replayable tail (at most REPLAY_LIMIT bytes).
    fn replay_tail(&self) -> &str {
        let mut cut = self.output.len().saturating_sub(REPLAY_LIMIT);
        while !self.output.is_char_boundary(cut) { cut += 1; }
        &self.output[cut..]
    }
}

/// Terminal modes a program set that a fresh terminal must be told again on reattach:
/// private modes (mouse, bracketed paste, cursor, …) and the kitty keyboard flags stack.
#[derive(Default)]
struct Modes {
    private: std::collections::BTreeMap<u16, bool>,
    kitty_main: Vec<u32>,
    kitty_alt: Vec<u32>,
}

const TRACKED_MODES: &[u16] = &[25, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 2004];

impl Modes {
    fn track(&mut self, s: &str, alt: bool) {
        static PRIV: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
        static KITTY: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
        let priv_re = PRIV.get_or_init(|| regex_lite::Regex::new(r"\x1b\[\?([0-9;]+)([hl])").unwrap());
        let kitty_re = KITTY.get_or_init(|| regex_lite::Regex::new(r"\x1b\[([><=])([0-9]*)(?:;([0-9]*))?u").unwrap());
        // Runs on every PTY read: only scan (slow in regex-lite) when a match is possible.
        let has_priv = s.contains("\x1b[?");
        let has_kitty = s.contains("\x1b[>") || s.contains("\x1b[<") || s.contains("\x1b[=");
        if !has_priv && !has_kitty { return; }
        for c in priv_re.captures_iter(s) {
            let on = &c[2] == "h";
            for code in c[1].split(';').filter_map(|n| n.parse::<u16>().ok()) {
                if TRACKED_MODES.contains(&code) { self.private.insert(code, on); }
            }
        }
        let stack = if alt { &mut self.kitty_alt } else { &mut self.kitty_main };
        for c in kitty_re.captures_iter(s) {
            let n: u32 = c[2].parse().unwrap_or(0);
            match &c[1] {
                ">" => { stack.push(n); if stack.len() > 16 { stack.remove(0); } }
                "<" => { let k = (n.max(1) as usize).min(stack.len()); stack.truncate(stack.len() - k); }
                _ => {
                    // CSI = flags ; mode u — 1 set, 2 or, 3 and-not
                    let cur = stack.last().copied().unwrap_or(0);
                    let new = match c.get(3).map(|m| m.as_str()).unwrap_or("1") {
                        "2" => cur | n,
                        "3" => cur & !n,
                        _ => n,
                    };
                    if let Some(top) = stack.last_mut() { *top = new } else { stack.push(new) }
                }
            }
        }
    }

    fn kitty(stack: &[u32]) -> String {
        stack.iter().map(|f| format!("\x1b[>{f}u")).collect()
    }

    /// Sequences that restore these modes in a fresh terminal: each screen's kitty
    /// keyboard stack (main first, then switch to the alternate screen if it's active),
    /// then the private modes.
    fn prelude(&self, alt: bool) -> String {
        let mut s = Self::kitty(&self.kitty_main);
        if alt {
            s.push_str("\x1b[?1049h");
            s.push_str(&Self::kitty(&self.kitty_alt));
        }
        for (code, on) in &self.private {
            s.push_str(&format!("\x1b[?{}{}", code, if *on { 'h' } else { 'l' }));
        }
        s
    }
}

/// Reply to `attach`: everything a UI needs to show this session as it is now.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachInfo {
    pub exists: bool,
    pub running: bool,
    pub command: Option<String>,
    pub started_at: i64,
    pub alt_screen: bool,
    /// For a running command: the output so far (block commands), or the modes to
    /// restore (full-screen programs, which are made to redraw instead).
    pub output: String,
    pub context: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Longest prefix of `buf` that is complete UTF-8 (a multi-byte character split across
/// reads stays in the buffer for the next read).
fn take_utf8(buf: &mut Vec<u8>) -> String {
    let valid = match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => buf.len(), // invalid bytes: decode lossily
    };
    let rest = buf.split_off(valid);
    let s = String::from_utf8_lossy(buf).into_owned();
    *buf = rest;
    s
}

/// True if `s` ends inside an OSC (ESC ]), APC (ESC _) or DCS (ESC P) string.
fn has_open_string(s: &str) -> bool {
    let mut rest = s;
    while let Some(i) = rest.find('\x1b') {
        let after = &rest[i + 1..];
        if let Some(kind) = after.chars().next().filter(|c| matches!(c, ']' | '_' | 'P')) {
            let body = &after[1..];
            let st = body.find("\x1b\\");
            let end = if kind == ']' { [body.find('\x07'), st].into_iter().flatten().min() } else { st };
            match end {
                None => return true,
                Some(e) => { rest = &body[e..]; continue; }
            }
        }
        rest = after;
    }
    false
}

/// Don't hold back output forever waiting for a terminator.
const HOLD_LIMIT: usize = 32 << 20;

pub struct Session {
    pub tab_id: String,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    event_tx: mpsc::Sender<SessionEvent>,
    state: Arc<Mutex<SessionState>>,
}

impl Session {
    /// Spawn a new PTY session running the user's default shell.
    /// Streams output to `event_tx` until the shell exits.
    pub fn spawn(tab_id: String, event_tx: mpsc::Sender<SessionEvent>) -> Result<Self> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 120, pixel_width: 0, pixel_height: 0 })
            .context("openpty failed")?;

        let shell = pick_shell();
        let mut cmd = CommandBuilder::new(&shell);
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("TERM_PROGRAM", "daimon");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("FORCE_COLOR", "1");
        cmd.env("CLICOLOR_FORCE", "1");
        // Don't leak a parent agent's non-interactive overrides into the user's shell: e.g. a
        // daemon started from Claude Code inherits GIT_EDITOR=true, so `git commit` would
        // "edit" with `true` and abort on an empty message instead of opening an editor.
        for (k, _) in std::env::vars_os() {
            let k = k.to_string_lossy();
            if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") {
                cmd.env_remove(k.as_ref());
            }
        }
        if std::env::var_os("CLAUDECODE").is_some() {
            cmd.env_remove("GIT_EDITOR");
        }
        // Point ZDOTDIR at our integration dir which sources ~/.zshrc + adds OSC 133 hooks
        let workspace_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent().unwrap().parent().unwrap()
            .to_path_buf();
        let integration_dir = workspace_root.join("shell-integration");
        if integration_dir.exists() {
            cmd.env("ZDOTDIR", &integration_dir);
        }
        // Point DAIMON_BIN at the compiled CLI binary so shell hooks work in dev
        let daimon_bin = workspace_root.join("target/debug/daimon");
        if daimon_bin.exists() {
            cmd.env("DAIMON_BIN", daimon_bin);
        }

        let mut child = pair.slave.spawn_command(cmd).context("spawn shell failed")?;
        let writer: Box<dyn Write + Send> = pair.master.take_writer().context("take_writer")?;
        let mut reader = pair.master.try_clone_reader().context("clone_reader")?;
        let master = pair.master;

        let writer = Arc::new(Mutex::new(writer));
        let state = Arc::new(Mutex::new(SessionState { size: (120, 24), ..Default::default() }));
        let tx = event_tx.clone();
        let tid = tab_id.clone();
        let reply_writer = writer.clone();
        let st = state.clone();

        // One dedicated reader thread per session — owns the PTY master reader.
        // No shared state with other sessions.
        std::thread::spawn(move || {
            let mut buf = [0u8; 16384];
            let mut bytes: Vec<u8> = Vec::new(); // incomplete UTF-8 carried across reads
            let mut pending = String::new(); // incomplete OSC/APC/DCS carried across reads
            let mut graphics = crate::kitty_graphics::KittyGraphics::default();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        bytes.extend_from_slice(&buf[..n]);
                        pending.push_str(&take_utf8(&mut bytes));

                        // Wait for the rest of an unterminated OSC/APC/DCS string.
                        if pending.len() < HOLD_LIMIT && has_open_string(&pending) {
                            continue;
                        }

                        // Kitty graphics → inline images; answer the program's queries.
                        let (raw, replies) = graphics.process(&std::mem::take(&mut pending));
                        if !replies.is_empty() {
                            let mut w = reply_writer.lock().unwrap();
                            for r in replies { let _ = w.write_all(r.as_bytes()); }
                        }

                        // Detect semantic events before any stripping
                        let alt_enter = is_alt_screen_enter(&raw);
                        let alt_exit = raw.contains("\x1b[?1049l");
                        let prompt = is_prompt_marker(&raw);
                        let cmd_start = is_command_start_marker(&raw);

                        // Strip PTY mode sequences + OSC 133 markers (already detected above).
                        // OSC 8 hyperlinks pass through: xterm and the block renderer both handle them.
                        let data = strip_osc133(&strip_pty_modes(&raw));

                        {
                            let mut s = st.lock().unwrap();
                            if cmd_start {
                                s.running = true;
                                s.command = s.command_hint.take();
                                s.started_at = now_ms();
                                s.output.clear();
                                s.modes = Modes::default();
                            }
                            if alt_enter { s.alt_screen = true; }
                            let alt = s.alt_screen;
                            s.modes.track(&raw, alt);
                            if alt_exit { s.alt_screen = false; s.modes.kitty_alt.clear(); }
                            if s.running { s.push_output(&data); }
                            if prompt {
                                s.running = false;
                                s.alt_screen = false;
                                if let Some(ctx) = extract_context_json(&raw) { s.context = Some(ctx); }
                            }
                        }

                        let _ = tx.blocking_send(SessionEvent::Output {
                            tab_id: tid.clone(),
                            data: data.clone(),
                        });
                        if alt_enter {
                            let _ = tx.blocking_send(SessionEvent::AltScreenEnter { tab_id: tid.clone() });
                        }
                        if alt_exit {
                            let _ = tx.blocking_send(SessionEvent::AltScreenExit { tab_id: tid.clone() });
                        }
                        if cmd_start {
                            let _ = tx.blocking_send(SessionEvent::CommandStart { tab_id: tid.clone() });
                        }
                        if prompt {
                            let ctx = extract_context_json(&raw).unwrap_or_default();
                            let _ = tx.blocking_send(SessionEvent::Prompt {
                                tab_id: tid.clone(),
                                context: ctx,
                            });
                        }
                    }
                    Err(_) => break,
                }
            }

            st.lock().unwrap().exited = true;
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            let _ = tx.blocking_send(SessionEvent::Exit { tab_id: tid, code });
        });

        Ok(Self { tab_id, writer, master, event_tx, state })
    }

    pub fn write(&self, data: &str, command: Option<String>) -> Result<()> {
        if self.state.lock().unwrap().exited {
            anyhow::bail!("session exited");
        }
        if command.is_some() {
            self.state.lock().unwrap().command_hint = command;
        }
        let mut w = self.writer.lock().unwrap();
        w.write_all(data.as_bytes())?;
        Ok(())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        tracing::debug!("resize tab={} {}x{}", self.tab_id, cols, rows);
        self.master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })?;
        self.state.lock().unwrap().size = (cols, rows);
        Ok(())
    }

    /// Snapshot for a reconnecting UI. A full-screen program can't be replayed from a
    /// capped byte tail, so it only gets its modes restored; the UI then asks for a
    /// `redraw` once its terminal is ready to receive one.
    pub fn attach(&self) -> AttachInfo {
        let s = self.state.lock().unwrap();
        AttachInfo {
            exists: !s.exited,
            running: s.running && !s.exited,
            command: s.command.clone(),
            started_at: s.started_at,
            alt_screen: s.alt_screen,
            output: if !s.running {
                String::new()
            } else if s.alt_screen {
                s.modes.prelude(true)
            } else {
                format!("{}{}", s.modes.prelude(false), s.replay_tail())
            },
            context: s.context.clone(),
        }
    }

    /// Make the running program repaint: resize to one row less and back (SIGWINCH).
    pub fn redraw(&self) {
        let (cols, rows) = self.state.lock().unwrap().size;
        let _ = self.master.resize(PtySize { cols, rows: rows.saturating_sub(1).max(1), pixel_width: 0, pixel_height: 0 });
        std::thread::sleep(std::time::Duration::from_millis(30));
        let _ = self.master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 });
    }
}

fn extract_context_json(data: &str) -> Option<String> {
    // OSC 133;C<json>BEL or OSC 133;A<json>BEL
    let start = data.find("\x1b]133;")?;
    let rest = &data[start + 6..];
    let end = rest.find('\x07').or_else(|| rest.find("\x1b\\"))?;
    let payload = &rest[..end];
    // payload starts with 'A' or 'C', json follows
    let json_start = payload.find('{').or_else(|| payload.find('['))?;
    Some(payload[json_start..].to_string())
}

/// Manager: owns all sessions for all tabs.
/// Keyed by tab_id — no session can touch another session's PTY.
pub struct SessionManager {
    sessions: std::collections::HashMap<String, Session>,
    event_tx: mpsc::Sender<SessionEvent>,
}

impl SessionManager {
    pub fn new(event_tx: mpsc::Sender<SessionEvent>) -> Self {
        Self { sessions: Default::default(), event_tx }
    }

    pub fn open(&mut self, tab_id: String) -> Result<()> {
        let session = Session::spawn(tab_id.clone(), self.event_tx.clone())?;
        self.sessions.insert(tab_id, session);
        Ok(())
    }

    pub fn write(&mut self, tab_id: &str, data: &str, command: Option<String>) -> Result<()> {
        self.sessions
            .get(tab_id)
            .context("no session for tab")?
            .write(data, command)
    }

    /// Reattach a UI to a session; `exists: false` if there's no live one.
    pub fn attach(&self, tab_id: &str) -> AttachInfo {
        match self.sessions.get(tab_id) {
            Some(s) => s.attach(),
            None => AttachInfo {
                exists: false, running: false, command: None, started_at: 0,
                alt_screen: false, output: String::new(), context: None,
            },
        }
    }

    pub fn redraw(&self, tab_id: &str) {
        if let Some(s) = self.sessions.get(tab_id) { s.redraw(); }
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn resize(&self, tab_id: &str, cols: u16, rows: u16) -> Result<()> {
        self.sessions
            .get(tab_id)
            .context("no session for tab")?
            .resize(cols, rows)
    }

    pub fn close(&mut self, tab_id: &str) {
        self.sessions.remove(tab_id);
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    /// Session spawns, receives output, exits cleanly.
    #[tokio::test]
    async fn session_spawns_and_exits() {
        let (tx, mut rx) = mpsc::channel(64);
        let session = Session::spawn("tab-1".into(), tx).unwrap();

        // Run a quick command and exit
        session.write("echo hello_daimon\nexit\n", None).unwrap();

        let mut got_output = false;
        let mut got_exit = false;

        while let Ok(Some(ev)) = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            rx.recv(),
        )
        .await
        {
            match ev {
                SessionEvent::Output { data, .. } => {
                    if data.contains("hello_daimon") { got_output = true; }
                }
                SessionEvent::Exit { .. } => { got_exit = true; break; }
                _ => {}
            }
        }

        assert!(got_output, "expected output containing hello_daimon");
        assert!(got_exit, "expected exit event");
    }

    /// Two sessions don't interfere — each gets its own output.
    #[tokio::test]
    async fn two_sessions_independent() {
        let (tx1, mut rx1) = mpsc::channel(64);
        let (tx2, mut rx2) = mpsc::channel(64);

        let s1 = Session::spawn("tab-1".into(), tx1).unwrap();
        let s2 = Session::spawn("tab-2".into(), tx2).unwrap();

        s1.write("echo from_tab_1\nexit\n", None).unwrap();
        s2.write("echo from_tab_2\nexit\n", None).unwrap();

        let mut tab1_saw_tab2 = false;

        while let Ok(Some(ev)) = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            rx1.recv(),
        )
        .await
        {
            if let SessionEvent::Output { data, .. } = ev {
                if data.contains("from_tab_2") { tab1_saw_tab2 = true; }
                if data.contains("from_tab_1") { break; }
            }
        }

        // Drain tab2 to avoid leaking threads
        while let Ok(Some(SessionEvent::Exit { .. })) = tokio::time::timeout(
            std::time::Duration::from_secs(5), rx2.recv()).await { break; }

        assert!(!tab1_saw_tab2, "tab-1 must not see tab-2 output");
    }

    /// Writing to a closed session returns an error, doesn't panic.
    #[test]
    fn write_to_missing_session_errors() {
        let (tx, _rx) = mpsc::channel(64);
        let mut mgr = SessionManager::new(tx);
        assert!(mgr.write("nonexistent", "hello\n", None).is_err());
    }
}
