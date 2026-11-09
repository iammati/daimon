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

    let db = store::Store::open()?;
    let addr = "127.0.0.1:7878";
    info!("daimon pty-daemon listening on ws://{}", addr);
    ws::serve(addr, db).await
}
