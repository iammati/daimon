//! Runtime UI plugins: files in ~/.config/daimon/plugins/, handed to the UI as source text
//! so it can import them without a build step (it strips TS/JSX itself). Plus `exec`, so a
//! plugin can talk to system tools without a dedicated daemon command.

use crate::session::SessionEvent;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use tokio::sync::mpsc;

/// Plugin protocol version, reported in `daemonInfo` so the UI can tell an old daemon apart.
pub const PROTOCOL: u32 = 1;

const EXTENSIONS: &[&str] = &["js", "mjs", "jsx", "ts", "tsx"];

pub fn plugins_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".config/daimon/plugins"))
}

/// Plugin files, sorted. `*.d.ts` are type declarations, not plugins.
fn plugin_files() -> Vec<PathBuf> {
    let Some(dir) = plugins_dir() else { return vec![] };
    let Ok(entries) = std::fs::read_dir(&dir) else { return vec![] };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or_default();
            p.is_file() && EXTENSIONS.contains(&ext) && !name.ends_with(".d.ts") && !name.starts_with('.')
        })
        .collect();
    files.sort();
    files
}

/// `[{ name, file, source }]`: `name` is the file stem, `file` the full file name.
/// Missing dir → empty list. Unreadable files are skipped with a warning.
pub fn list() -> Value {
    let plugins: Vec<Value> = plugin_files()
        .into_iter()
        .filter_map(|p| match std::fs::read_to_string(&p) {
            Ok(source) => Some(json!({
                "name": p.file_stem().and_then(|s| s.to_str()).unwrap_or_default(),
                "file": p.file_name().and_then(|s| s.to_str()).unwrap_or_default(),
                "source": source,
            })),
            Err(e) => {
                tracing::warn!("plugin {}: {}", p.display(), e);
                None
            }
        })
        .collect();
    Value::Array(plugins)
}

/// Name, size and mtime of every plugin file: cheap to take, changes on any edit.
fn snapshot() -> Vec<(PathBuf, u64, Option<SystemTime>)> {
    plugin_files()
        .into_iter()
        .map(|p| {
            let meta = std::fs::metadata(&p).ok();
            let len = meta.as_ref().map_or(0, |m| m.len());
            let mtime = meta.and_then(|m| m.modified().ok());
            (p, len, mtime)
        })
        .collect()
}

/// Polls the plugins dir and emits `PluginsChanged` after an edit settles. Polling (not
/// inotify/FSEvents) keeps it dependency-free and works on WSL's /mnt drives too.
pub async fn watch(events: mpsc::Sender<SessionEvent>) {
    let mut last = tokio::task::spawn_blocking(snapshot).await.unwrap_or_default();
    let mut interval = tokio::time::interval(Duration::from_millis(500));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let Ok(now) = tokio::task::spawn_blocking(snapshot).await else { continue };
        if now != last {
            last = now;
            if events.send(SessionEvent::PluginsChanged).await.is_err() {
                return;
            }
        }
    }
}

/// Run `cmd args…` (no shell) and collect its output. Times out after `timeout_ms`.
/// `{ code, stdout, stderr }`; `code` is null when killed by a signal.
pub async fn exec(cmd: String, args: Vec<String>, cwd: Option<String>, timeout_ms: u64) -> (bool, Value) {
    let mut c = tokio::process::Command::new(&cmd);
    c.args(&args).stdin(std::process::Stdio::null()).kill_on_drop(true);
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        c.current_dir(dir);
    }
    match tokio::time::timeout(Duration::from_millis(timeout_ms), c.output()).await {
        Err(_) => (false, json!({ "error": format!("{cmd}: timed out after {timeout_ms} ms") })),
        Ok(Err(e)) => (false, json!({ "error": format!("{cmd}: {e}") })),
        Ok(Ok(out)) => (true, json!({
            "code": out.status.code(),
            "stdout": String::from_utf8_lossy(&out.stdout),
            "stderr": String::from_utf8_lossy(&out.stderr),
        })),
    }
}
