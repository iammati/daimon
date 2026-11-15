mod commands;
mod complete;
mod session;
mod store;
mod ws;

use anyhow::Result;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("pty_daemon=debug".parse()?))
        .init();

    // Started by the production app: quit when the app does. The app holds our stdin
    // open, so EOF means it exited (or crashed). A plain kill isn't enough on Windows,
    // where the daemon runs inside WSL and outlives the wsl.exe that started it.
    if std::env::args().any(|a| a == "--exit-with-parent") {
        std::thread::spawn(|| {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
            info!("parent app exited — shutting down");
            std::process::exit(0);
        });
    }

    let db = store::Store::open()?;
    let addr = "127.0.0.1:7878";
    info!("daimon pty-daemon listening on ws://{}", addr);
    ws::serve(addr, db).await
}
