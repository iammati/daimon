/// WebSocket server — one connection per tab, multiplexed over a single port.

use crate::session::{SessionCommand, SessionEvent, SessionManager};
use crate::store::Store;
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::Message;

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
use tracing::{error, info};

pub async fn serve(listener: TcpListener, db: Store, token: String, port: u16) -> Result<()> {
    let db = Arc::new(db);
    let token = Arc::new(token);

    // Single event bus: all sessions → all connected WebSocket clients
    let (event_tx, event_rx) = mpsc::channel::<SessionEvent>(1024);
    let mgr = Arc::new(Mutex::new(SessionManager::new(event_tx.clone())));

    // Broadcast task: fan out session events to all connected clients
    let clients: Arc<Mutex<Vec<mpsc::Sender<SessionEvent>>>> = Arc::new(Mutex::new(vec![]));
    let clients_bcast = clients.clone();
    tokio::spawn(async move {
        let mut rx = event_rx;
        while let Some(ev) = rx.recv().await {
            let mut list = clients_bcast.lock().await;
            list.retain(|tx| tx.try_send(ev.clone()).is_ok());
        }
    });

    info!("WebSocket server ready");

    loop {
        let (stream, addr) = listener.accept().await?;
        info!("connection from {}", addr);

        let mgr = mgr.clone();
        let db = db.clone();
        let token = token.clone();
        let (client_tx, mut client_rx) = mpsc::channel::<SessionEvent>(256);
        clients.lock().await.push(client_tx.clone());

        tokio::spawn(async move {
            // Every client must present the token (?token=…): the daemon runs shells, and
            // any web page can open a WebSocket to localhost.
            let check = |req: &Request, resp: Response| -> std::result::Result<Response, ErrorResponse> {
                let ok = req.uri().query().is_some_and(|q| {
                    q.split('&').any(|kv| kv.strip_prefix("token=").is_some_and(|t| constant_time_eq(t.as_bytes(), token.as_bytes())))
                });
                if ok { return Ok(resp); }
                let mut deny = ErrorResponse::new(Some("unauthorized".into()));
                *deny.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
                Err(deny)
            };
            let ws = match tokio_tungstenite::accept_hdr_async(stream, check).await {
                Ok(ws) => ws,
                Err(e) => { info!("rejected connection from {}: {}", addr, e); return; }
            };
            let (mut sink, mut source) = ws.split();

            let send_task = tokio::spawn(async move {
                while let Some(ev) = client_rx.recv().await {
                    let json = serde_json::to_string(&ev).unwrap();
                    if sink.send(Message::Text(json.into())).await.is_err() { break; }
                }
            });

            while let Some(Ok(msg)) = source.next().await {
                if let Message::Text(text) = msg {
                    let cmd: Result<SessionCommand, _> = serde_json::from_str(&text);
                    match cmd {
                        Ok(SessionCommand::Write { tab_id, data, command }) => {
                            let mut mgr = mgr.lock().await;
                            if mgr.write(&tab_id, &data, command.clone()).is_err() {
                                if let Err(e) = mgr.open(tab_id.clone()) {
                                    error!("open session {}: {}", tab_id, e);
                                    continue;
                                }
                                let _ = mgr.write(&tab_id, &data, command);
                            }
                        }
                        Ok(SessionCommand::Attach { req_id, tab_id }) => {
                            let info = mgr.lock().await.attach(&tab_id);
                            info!("attach {}: exists={} running={}", tab_id, info.exists, info.running);
                            let data = serde_json::to_value(info).unwrap_or_default();
                            let _ = client_tx.send(SessionEvent::Response { req_id, ok: true, data }).await;
                        }
                        Ok(SessionCommand::Redraw { tab_id }) => {
                            mgr.lock().await.redraw(&tab_id);
                        }
                        Ok(SessionCommand::DaemonInfo { req_id }) => {
                            let sessions = mgr.lock().await.len();
                            let data = serde_json::json!({ "build": crate::daemon_info::build_id(), "sessions": sessions, "pid": std::process::id() });
                            let _ = client_tx.send(SessionEvent::Response { req_id, ok: true, data }).await;
                        }
                        Ok(SessionCommand::Shutdown { req_id }) => {
                            info!("shutdown requested");
                            let _ = client_tx.send(SessionEvent::Response { req_id, ok: true, data: serde_json::Value::Bool(true) }).await;
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                            crate::daemon_info::unpublish(port);
                            std::process::exit(0);
                        }
                        Ok(SessionCommand::Resize { tab_id, cols, rows }) => {
                            let mgr = mgr.lock().await;
                            let _ = mgr.resize(&tab_id, cols, rows);
                        }
                        Ok(SessionCommand::Close { tab_id }) => {
                            mgr.lock().await.close(&tab_id);
                        }
                        Ok(SessionCommand::GitStatus { req_id, cwd }) => {
                            let tx = client_tx.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = crate::commands::git_status(&cwd);
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::GitLog { req_id, cwd, limit }) => {
                            let tx = client_tx.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = crate::commands::git_log(&cwd, limit);
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::GitBranch { req_id, cwd }) => {
                            let tx = client_tx.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = crate::commands::git_branch(&cwd);
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::GitDiff { req_id, cwd, args }) => {
                            let tx = client_tx.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = crate::commands::git_diff(&args, &cwd);
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::ListContexts { req_id }) => {
                            let tx = client_tx.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = crate::commands::list_contexts();
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::SyncContexts { req_id }) => {
                            let tx = client_tx.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = crate::commands::sync_contexts();
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::ListRegions { req_id }) => {
                            let tx = client_tx.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = crate::commands::list_regions();
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::ListPaths { req_id, prefix, cwd, kind }) => {
                            let tx = client_tx.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = crate::commands::list_paths(&prefix, &cwd, &kind);
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::Complete { req_id, buffer, cwd }) => {
                            let tx = client_tx.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = crate::complete::complete(&buffer, &cwd);
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::CommitDetail { req_id, hash, cwd }) => {
                            let tx = client_tx.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = crate::commands::git_commit_detail(&hash, &cwd);
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::FileDiff { req_id, hash, file_path, cwd }) => {
                            let tx = client_tx.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = crate::commands::git_file_diff(&hash, &file_path, &cwd);
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::FileContent { req_id, blob, file_path, cwd }) => {
                            let tx = client_tx.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = crate::commands::git_file_content(&blob, &file_path, &cwd);
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        // ── Store commands ────────────────────────────────────────────
                        Ok(SessionCommand::HistoryAdd { req_id, cmd, ts }) => {
                            let tx = client_tx.clone();
                            let db = db.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = match db.history_add(&cmd, ts) {
                                    Ok(_) => serde_json::Value::Bool(true),
                                    Err(e) => { error!("historyAdd: {}", e); serde_json::Value::Bool(false) }
                                };
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::HistoryList { req_id, limit }) => {
                            let tx = client_tx.clone();
                            let db = db.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = match db.history_list(limit) {
                                    Ok(entries) => serde_json::to_value(entries).unwrap_or_default(),
                                    Err(e) => { error!("historyList: {}", e); serde_json::Value::Array(vec![]) }
                                };
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::BlockSave { req_id, block }) => {
                            let tx = client_tx.clone();
                            let db = db.clone();
                            tokio::task::spawn_blocking(move || {
                                let result = (|| -> anyhow::Result<()> {
                                    let b = crate::store::BlockRow {
                                        id: block["id"].as_str().unwrap_or("").to_string(),
                                        session_id: block["session_id"].as_str().unwrap_or("").to_string(),
                                        input: block["input"].as_str().unwrap_or("").to_string(),
                                        cwd: block["cwd"].as_str().unwrap_or("").to_string(),
                                        ctx: block["ctx"].as_str().unwrap_or("").to_string(),
                                        ts: block["ts"].as_i64().unwrap_or(0),
                                        exit_code: block["exit_code"].as_i64().unwrap_or(0) as i32,
                                        output_json: block["output_json"].as_str().unwrap_or("[]").to_string(),
                                    };
                                    db.block_save(&b)
                                })();
                                let data = serde_json::Value::Bool(result.is_ok());
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::BlockList { req_id, session_id, limit }) => {
                            let tx = client_tx.clone();
                            let db = db.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = match db.blocks_for_session(&session_id, limit) {
                                    Ok(rows) => serde_json::to_value(rows).unwrap_or_default(),
                                    Err(e) => { error!("blockList: {}", e); serde_json::Value::Array(vec![]) }
                                };
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::BlockRecent { req_id, limit }) => {
                            let tx = client_tx.clone();
                            let db = db.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = match db.blocks_recent(limit) {
                                    Ok(rows) => serde_json::to_value(rows).unwrap_or_default(),
                                    Err(e) => { error!("blockRecent: {}", e); serde_json::Value::Array(vec![]) }
                                };
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::BlockClear { req_id, session_id }) => {
                            let tx = client_tx.clone();
                            let db = db.clone();
                            tokio::task::spawn_blocking(move || {
                                let ok = db.blocks_delete_session(&session_id).is_ok();
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok, data: serde_json::Value::Bool(ok) });
                            });
                        }
                        Ok(SessionCommand::BlockSearch { req_id, query, limit }) => {
                            let tx = client_tx.clone();
                            let db = db.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = match db.blocks_search(&query, limit) {
                                    Ok(rows) => serde_json::to_value(rows).unwrap_or_default(),
                                    Err(e) => { error!("blockSearch: {}", e); serde_json::Value::Array(vec![]) }
                                };
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::HistorySearch { req_id, query, limit }) => {
                            let tx = client_tx.clone();
                            let db = db.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = match db.history_search(&query, limit) {
                                    Ok(rows) => serde_json::to_value(rows).unwrap_or_default(),
                                    Err(e) => { error!("historySearch: {}", e); serde_json::Value::Array(vec![]) }
                                };
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Ok(SessionCommand::PrefSet { req_id, key, value }) => {
                            let tx = client_tx.clone();
                            let db = db.clone();
                            tokio::task::spawn_blocking(move || {
                                let ok = db.pref_set(&key, &value).is_ok();
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok, data: serde_json::Value::Bool(ok) });
                            });
                        }
                        Ok(SessionCommand::PrefGet { req_id, key }) => {
                            let tx = client_tx.clone();
                            let db = db.clone();
                            tokio::task::spawn_blocking(move || {
                                let data = match db.pref_get(&key) {
                                    Ok(Some(v)) => serde_json::Value::String(v),
                                    _ => serde_json::Value::Null,
                                };
                                let _ = tx.blocking_send(SessionEvent::Response { req_id, ok: true, data });
                            });
                        }
                        Err(e) => error!("bad command: {}: {}", text, e),
                    }
                }
            }

            send_task.abort();
        });
    }
}
