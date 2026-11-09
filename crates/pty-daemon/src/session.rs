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
    /// Write raw bytes to the PTY (keystrokes, commands).
    Write { tab_id: String, data: String },
    /// Resize the PTY window.
    Resize { tab_id: String, cols: u16, rows: u16 },
    /// Close/kill the session.
    Close { tab_id: String },
    /// Run `git --no-pager status --porcelain=v1 -b` in cwd.
    GitStatus { req_id: String, cwd: String },
    /// Run `git --no-pager log` in cwd.
    GitLog { req_id: String, cwd: String, limit: usize },
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
    /// Set a preference value.
    PrefSet { req_id: String, key: String, value: String },
    /// Get a preference value.
    PrefGet { req_id: String, key: String },
}

pub struct Session {
    pub tab_id: String,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    event_tx: mpsc::Sender<SessionEvent>,
}

impl Session {
    /// Spawn a new PTY session running the user's default shell.
    /// Streams output to `event_tx` until the shell exits.
    pub fn spawn(tab_id: String, event_tx: mpsc::Sender<SessionEvent>) -> Result<Self> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 120, pixel_width: 0, pixel_height: 0 })
            .context("openpty failed")?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        cmd.env("TERM_PROGRAM", "daimon");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("FORCE_COLOR", "1");
        cmd.env("CLICOLOR_FORCE", "1");
        // Point ZDOTDIR at our integration dir which sources ~/.zshrc + adds OSC 133 hooks
        let integration_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent().unwrap().parent().unwrap()
            .join("shell-integration");
        if integration_dir.exists() {
            cmd.env("ZDOTDIR", integration_dir);
        }

        let mut child = pair.slave.spawn_command(cmd).context("spawn shell failed")?;
        let writer: Box<dyn Write + Send> = pair.master.take_writer().context("take_writer")?;
        let mut reader = pair.master.try_clone_reader().context("clone_reader")?;
        let master = pair.master;

        let writer = Arc::new(Mutex::new(writer));
        let tx = event_tx.clone();
        let tid = tab_id.clone();

        // One dedicated reader thread per session — owns the PTY master reader.
        // No shared state with other sessions.
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut pending = String::new(); // carry incomplete OSC sequences across reads
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.push_str(&String::from_utf8_lossy(&buf[..n]));

                        // Don't emit if an OSC sequence is open but not yet terminated
                        // ESC ] started but no BEL or ST yet — wait for next read
                        if pending.contains('\x1b') {
                            let has_open_osc = {
                                let mut s = pending.as_str();
                                let mut open = false;
                                while let Some(i) = s.find('\x1b') {
                                    let rest = &s[i+1..];
                                    if rest.starts_with(']') {
                                        // Check if terminated
                                        let after = &rest[1..];
                                        if !after.contains('\x07') && !after.contains("\x1b\\") {
                                            open = true;
                                            break;
                                        }
                                    }
                                    s = &s[i+1..];
                                }
                                open
                            };
                            if has_open_osc {
                                continue; // wait for next chunk to complete the sequence
                            }
                        }

                        let raw = std::mem::take(&mut pending);

                        // Detect semantic events before any stripping
                        let alt_enter = is_alt_screen_enter(&raw);
                        let alt_exit = raw.contains("\x1b[?1049l");
                        let prompt = is_prompt_marker(&raw);
                        let cmd_start = is_command_start_marker(&raw);

                        // Strip PTY mode sequences + OSC 133 markers (already detected above)
                        let data = strip_osc133(&strip_pty_modes(&raw));

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

            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            let _ = tx.blocking_send(SessionEvent::Exit { tab_id: tid, code });
        });

        Ok(Self { tab_id, writer, master, event_tx })
    }

    pub fn write(&self, data: &str) -> Result<()> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(data.as_bytes())?;
        Ok(())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        tracing::debug!("resize tab={} {}x{}", self.tab_id, cols, rows);
        self.master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })?;
        Ok(())
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

    pub fn write(&mut self, tab_id: &str, data: &str) -> Result<()> {
        self.sessions
            .get(tab_id)
            .context("no session for tab")?
            .write(data)
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
        session.write("echo hello_daimon\nexit\n").unwrap();

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

        s1.write("echo from_tab_1\nexit\n").unwrap();
        s2.write("echo from_tab_2\nexit\n").unwrap();

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
        let mgr = SessionManager::new(tx);
        assert!(mgr.write("nonexistent", "hello\n").is_err());
    }
}
