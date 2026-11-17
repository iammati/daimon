use anyhow::Result;
use std::path::PathBuf;

fn plugins_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("can't find home dir"))?;
    Ok(home.join(".config/daimon"))
}

pub fn run_build() -> Result<()> {
    eprintln!("Plugins are bundled at app-build time via the @daimon-plugins Vite alias.");
    eprintln!("Edit ~/.config/daimon/plugins.tsx, then rebuild the app with build.sh.");
    Ok(())
}

pub fn run_init() -> Result<()> {
    let dir = plugins_dir()?;
    std::fs::create_dir_all(&dir)?;
    let src = dir.join("plugins.tsx");
    if src.exists() {
        println!("already exists: {}", src.display());
        return Ok(());
    }
    std::fs::write(
        &src,
        r#"import { registerHeaderButton } from "@/lib/daimon/plugins";
// import { TailscaleBadge } from "@/components/daimon/HeaderExtension";

// registerHeaderButton("tailscale", <TailscaleBadge />);
"#,
    )?;
    println!("created {}", src.display());
    println!("edit it, then rebuild the app with build.sh");
    Ok(())
}
