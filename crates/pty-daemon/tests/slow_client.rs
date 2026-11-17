//! A client that falls behind during an output flood must still get every byte, and keep
//! getting output afterwards. (It used to be dropped from the event bus for good while its
//! socket stayed open: the UI looked alive but no session updated any more.)
//!
//! Runs the real daemon binary with its own port and data dirs. Needs zsh.

use futures_util::{SinkExt, StreamExt};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

struct Daemon {
    child: Child,
    dir: PathBuf,
    port: u16,
    token: String,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn start_daemon() -> Daemon {
    let dir = std::env::temp_dir().join(format!("daimon-test-{}-{}", std::process::id(), free_port()));
    std::fs::create_dir_all(dir.join("data")).unwrap();
    std::fs::create_dir_all(dir.join("state")).unwrap();
    let port = free_port();
    let child = Command::new(env!("CARGO_BIN_EXE_pty-daemon"))
        .env("DAIMON_PORT", port.to_string())
        .env("XDG_DATA_HOME", dir.join("data"))
        .env("XDG_STATE_HOME", dir.join("state"))
        .env("RUST_LOG", "warn")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let start = Instant::now();
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(start.elapsed() < Duration::from_secs(10), "daemon did not start");
        std::thread::sleep(Duration::from_millis(50));
    }
    let token = std::fs::read_to_string(dir.join("state/daimon/token")).unwrap().trim().to_string();
    Daemon { child, dir, port, token }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(d: &Daemon) -> Ws {
    let url = format!("ws://127.0.0.1:{}/?token={}", d.port, d.token);
    tokio_tungstenite::connect_async(url).await.unwrap().0
}

async fn write(ws: &mut Ws, tab: &str, data: &str) {
    let msg = serde_json::json!({"type": "write", "tab_id": tab, "data": data}).to_string();
    ws.send(Message::Text(msg.into())).await.unwrap();
}

/// Next event for `tab` of type `kind`, collecting that tab's output on the way.
async fn until(ws: &mut Ws, tab: &str, kind: &str, out: &mut String, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout(left, ws.next()).await else { return false };
        let ev: serde_json::Value = serde_json::from_str(&t).unwrap();
        if ev["tab_id"] != tab { continue; }
        if ev["type"] == "output" { out.push_str(ev["data"].as_str().unwrap_or("")); }
        if ev["type"] == kind { return true; }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_client_gets_all_output() {
    if Command::new("zsh").arg("-c").arg("true").status().map(|s| !s.success()).unwrap_or(true) {
        eprintln!("skipping: zsh not available");
        return;
    }
    let d = start_daemon();
    let tab = "t1";
    let mut fast = connect(&d).await;
    let mut ignored = String::new();
    write(&mut fast, tab, "").await;
    assert!(until(&mut fast, tab, "prompt", &mut ignored, Duration::from_secs(20)).await, "no first prompt");

    // The slow client connects, then doesn't read at all while ~2.5 MB of output goes by.
    let mut slow = connect(&d).await;
    write(&mut fast, tab, "seq 1 400000; echo FLOOD''_DONE\r").await;

    // Its reader wakes up after a pause; with backpressure the flood waits for it.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mut seen = String::new();
    let slow_task = tokio::spawn(async move {
        let ok = until(&mut slow, tab, "prompt", &mut seen, Duration::from_secs(120)).await;
        (ok, seen, slow)
    });
    let mut fast_out = String::new();
    assert!(until(&mut fast, tab, "prompt", &mut fast_out, Duration::from_secs(120)).await, "fast client: flood never ended");
    let (ok, seen, mut slow) = slow_task.await.unwrap();
    assert!(ok, "slow client never saw the end of the flood");
    assert!(seen.contains("\n400000\r\n") || seen.contains("\n400000\n"), "slow client is missing output");
    assert!(seen.contains("FLOOD_DONE"));

    // And it still gets output after the flood.
    write(&mut fast, tab, "echo AFTER''_FLOOD\r").await;
    let mut after = String::new();
    assert!(until(&mut slow, tab, "prompt", &mut after, Duration::from_secs(20)).await, "slow client dropped after flood");
    assert!(after.contains("AFTER_FLOOD"));
}
