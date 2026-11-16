//! Daemon discovery and auth.
//!
//! The daemon outlives the app (sessions survive closing it), so whoever wants to talk
//! to it must find it and prove it may: a running daemon publishes
//! `<state dir>/daimon/daemon-<port>.json` ({pid, port, token, build}), and every
//! WebSocket must carry `?token=`. The token is stable across daemon restarts (kept in
//! `<state dir>/daimon/token`, mode 0600), so an open UI survives a daemon restart.
//!
//! `build` is a hash of the daemon executable: the app compares it with the binary it
//! bundles to notice that the running daemon is an older build.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

pub const DEFAULT_PORT: u16 = 7878;

/// `DAIMON_PORT` overrides the port (dev.sh uses its own so it never touches the
/// daemon holding your real sessions).
pub fn port() -> u16 {
    std::env::var("DAIMON_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT)
}

pub fn state_dir() -> PathBuf {
    dirs::state_dir()
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".local/state"))
        .join("daimon")
}

fn info_path(port: u16) -> PathBuf {
    state_dir().join(format!("daemon-{port}.json"))
}

pub fn log_path(port: u16) -> PathBuf {
    state_dir().join(format!("daemon-{port}.log"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Info {
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub build: String,
}

/// The shared secret, created on first use.
pub fn token() -> Result<String> {
    let path = state_dir().join("token");
    if let Ok(t) = fs::read_to_string(&path) {
        let t = t.trim().to_string();
        if t.len() >= 32 {
            return Ok(t);
        }
    }
    let mut bytes = [0u8; 32];
    use std::io::Read;
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .context("read /dev/urandom")?;
    let t: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    write_private(&path, &t)?;
    Ok(t)
}

fn write_private(path: &PathBuf, contents: &str) -> Result<()> {
    fs::create_dir_all(path.parent().unwrap())?;
    let tmp = path.with_extension("tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(contents.as_bytes())?;
    }
    #[cfg(not(unix))]
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Hash of this executable (first 16 hex chars of SHA-256).
pub fn build_id() -> String {
    std::env::current_exe()
        .and_then(fs::read)
        .map(|bytes| Sha256::digest(&bytes).iter().take(8).map(|b| format!("{b:02x}")).collect())
        .unwrap_or_else(|_| "unknown".into())
}

/// Publish the running daemon (call after the port is bound).
pub fn publish(port: u16, token: &str) -> Result<()> {
    let info = Info { pid: std::process::id(), port, token: token.to_string(), build: build_id() };
    write_private(&info_path(port), &serde_json::to_string(&info)?)
}

/// Remove our info file on clean shutdown (only if it's still ours).
pub fn unpublish(port: u16) {
    if read(port).is_some_and(|i| i.pid == std::process::id()) {
        let _ = fs::remove_file(info_path(port));
    }
}

pub fn read(port: u16) -> Option<Info> {
    serde_json::from_str(&fs::read_to_string(info_path(port)).ok()?).ok()
}

/// `--info`: what the app needs to find the daemon. `running` is null when no daemon
/// has published on this port; `selfBuild` is the build of the binary answering.
pub fn print_info() -> Result<()> {
    let port = port();
    let out = serde_json::json!({
        "port": port,
        "token": token()?,
        "selfBuild": build_id(),
        "running": read(port),
    });
    println!("{out}");
    Ok(())
}

/// `--detach`: start the daemon in its own process group, detached from the caller,
/// and return once it's listening (or another daemon already is).
#[cfg(unix)]
pub fn detach(args: &[String]) -> Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let port = port();
    if let Some(info) = read(port) {
        if std::net::TcpStream::connect(("127.0.0.1", info.port)).is_ok() {
            println!("already running (pid {})", info.pid);
            return Ok(());
        }
    }
    fs::create_dir_all(state_dir())?;
    let log = fs::OpenOptions::new().create(true).append(true).open(log_path(port))?;
    let mut child = Command::new(std::env::current_exe()?)
        .args(args.iter().filter(|a| *a != "--detach"))
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0) // not killed with the caller's group (terminal, app launcher)
        .spawn()
        .context("spawn daemon")?;

    for _ in 0..100 {
        if let Some(status) = child.try_wait()? {
            // Lost a race with another daemon: fine if that one is up.
            if read(port).is_some_and(|i| std::net::TcpStream::connect(("127.0.0.1", i.port)).is_ok()) {
                println!("already running");
                return Ok(());
            }
            anyhow::bail!("daemon exited during startup ({status}); see {}", log_path(port).display());
        }
        if read(port).is_some_and(|i| i.pid == child.id()) {
            println!("started (pid {})", child.id());
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    anyhow::bail!("daemon didn't come up within 5s; see {}", log_path(port).display())
}
