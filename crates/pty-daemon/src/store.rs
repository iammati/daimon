use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Store(Arc<Mutex<Connection>>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HistoryEntry {
    pub id: i64,
    pub cmd: String,
    pub ts: i64,
    pub source: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BlockRow {
    pub id: String,
    pub session_id: String,
    pub input: String,
    pub cwd: String,
    pub ctx: String,
    pub ts: i64,
    pub exit_code: i32,
    pub output_json: String,
}

fn db_path() -> PathBuf {
    let base = dirs::data_local_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".local/share"));
    base.join("daimon").join("daimon.db")
}

impl Store {
    pub fn open() -> Result<Self> {
        let path = db_path();
        std::fs::create_dir_all(path.parent().unwrap())?;
        let conn = Connection::open(&path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
        conn.execute_batch("
            CREATE TABLE IF NOT EXISTS history (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                cmd     TEXT NOT NULL,
                ts      INTEGER NOT NULL,
                source  TEXT NOT NULL DEFAULT 'daimon'
            );
            CREATE UNIQUE INDEX IF NOT EXISTS history_cmd ON history(cmd);
            CREATE INDEX IF NOT EXISTS history_ts ON history(ts DESC);

            CREATE TABLE IF NOT EXISTS blocks (
                id          TEXT PRIMARY KEY,
                session_id  TEXT NOT NULL,
                input       TEXT NOT NULL,
                cwd         TEXT NOT NULL DEFAULT '',
                ctx         TEXT NOT NULL DEFAULT '',
                ts          INTEGER NOT NULL,
                exit_code   INTEGER NOT NULL DEFAULT 0,
                output_json TEXT NOT NULL DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS blocks_session ON blocks(session_id, ts DESC);

            CREATE TABLE IF NOT EXISTS prefs (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        ")?;
        let store = Store(Arc::new(Mutex::new(conn)));
        store.import_zsh_history()?;
        Ok(store)
    }

    // ── History ──────────────────────────────────────────────────────────────

    pub fn history_add(&self, cmd: &str, ts: i64) -> Result<i64> {
        let conn = self.0.lock().unwrap();
        // Upsert: if cmd exists update ts to latest, else insert
        conn.execute(
            "INSERT INTO history(cmd, ts, source) VALUES(?1,?2,'daimon')
             ON CONFLICT(cmd) DO UPDATE SET ts = MAX(ts, excluded.ts)",
            params![cmd, ts],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn history_list(&self, limit: usize) -> Result<Vec<HistoryEntry>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, cmd, ts, source FROM history ORDER BY ts DESC LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit as i64], |r| Ok(HistoryEntry {
            id: r.get(0)?,
            cmd: r.get(1)?,
            ts: r.get(2)?,
            source: r.get(3)?,
        }))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // ── Blocks ───────────────────────────────────────────────────────────────

    pub fn block_save(&self, b: &BlockRow) -> Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO blocks(id,session_id,input,cwd,ctx,ts,exit_code,output_json)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![b.id, b.session_id, b.input, b.cwd, b.ctx, b.ts, b.exit_code, b.output_json],
        )?;
        Ok(())
    }

    pub fn blocks_for_session(&self, session_id: &str, limit: usize) -> Result<Vec<BlockRow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,session_id,input,cwd,ctx,ts,exit_code,output_json
             FROM blocks WHERE session_id=?1 ORDER BY ts ASC LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![session_id, limit as i64], |r| Ok(BlockRow {
            id: r.get(0)?,
            session_id: r.get(1)?,
            input: r.get(2)?,
            cwd: r.get(3)?,
            ctx: r.get(4)?,
            ts: r.get(5)?,
            exit_code: r.get(6)?,
            output_json: r.get(7)?,
        }))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Most recent N blocks across all sessions, newest first.
    pub fn blocks_recent(&self, limit: usize) -> Result<Vec<BlockRow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,session_id,input,cwd,ctx,ts,exit_code,output_json
             FROM blocks ORDER BY ts DESC LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit as i64], |r| Ok(BlockRow {
            id: r.get(0)?,
            session_id: r.get(1)?,
            input: r.get(2)?,
            cwd: r.get(3)?,
            ctx: r.get(4)?,
            ts: r.get(5)?,
            exit_code: r.get(6)?,
            output_json: r.get(7)?,
        }))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn blocks_delete_session(&self, session_id: &str) -> Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute("DELETE FROM blocks WHERE session_id=?1", params![session_id])?;
        Ok(())
    }

    // ── Prefs ────────────────────────────────────────────────────────────────

    pub fn pref_set(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO prefs(key,value) VALUES(?1,?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn pref_get(&self, key: &str) -> Result<Option<String>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM prefs WHERE key=?1")?;
        let val = stmt.query_row(params![key], |r| r.get(0)).optional()?;
        Ok(val)
    }

    // ── zsh history import ───────────────────────────────────────────────────

    fn import_zsh_history(&self) -> Result<()> {
        // Only import once
        {
            let conn = self.0.lock().unwrap();
            let done: Option<String> = conn
                .query_row("SELECT value FROM prefs WHERE key='zsh_imported'", [], |r| r.get(0))
                .optional()?;
            if done.is_some() { return Ok(()); }
        }

        let hist_path = dirs::home_dir().map(|h| h.join(".zsh_history"));
        let path = match hist_path { Some(p) if p.exists() => p, _ => return Ok(()) };
        let raw = std::fs::read(&path)?;

        // zsh extended_history format: `: ts:elapsed;cmd\ncontinuation`
        // Plain format: just `cmd\n`
        let text = String::from_utf8_lossy(&raw);
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO history(cmd,ts,source) VALUES(?1,?2,'zsh')"
        )?;
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }
            if let Some(rest) = line.strip_prefix(": ") {
                // `: 1700000000:0;actual command`
                if let Some(semi) = rest.find(';') {
                    let ts_part = &rest[..semi];
                    let cmd = &rest[semi + 1..];
                    if cmd.is_empty() { continue; }
                    let ts: i64 = ts_part.split(':').next()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0);
                    // ts in zsh is unix seconds — convert to ms
                    let _ = stmt.execute(params![cmd, ts * 1000]);
                }
            } else {
                // plain entry, no timestamp — use 0
                let _ = stmt.execute(params![line, 0i64]);
            }
        }
        drop(stmt);
        conn.execute("INSERT OR REPLACE INTO prefs(key,value) VALUES('zsh_imported','1')", [])?;
        Ok(())
    }
}
