use anyhow::Result;
use std::path::PathBuf;

fn config_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("can't find home dir"))?;
    Ok(home.join(".config/daimon"))
}

/// Editor types for the `daimon` and `react` modules. Always rewritten, so they match the
/// installed daimon.
const TYPES: &str = include_str!("plugin-types.d.ts");

/// Editor settings for the folder. Written once; the user may change it.
const TSCONFIG: &str = r#"{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "allowJs": true,
    "checkJs": false,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs"]
}
"#;

const EXAMPLE: &str = r#"// daimon plugin. No build step: save the file and daimon reloads it live.
// Any .js .jsx .ts .tsx file in this folder is a plugin. Tailwind classes work and use
// daimon's theme (bg-card, text-muted-foreground, ...). Imports: "react" and "daimon" only.
// API and docs: daimon.d.ts in this folder.
import { useEffect, useState } from "react";
import { exec, registerHeaderButton, toast } from "daimon";

function Hostname() {
  const [name, setName] = useState("…");

  useEffect(() => {
    exec("hostname").then((r) => setName(r.stdout.trim()), () => setName("?"));
  }, []);

  const copy = async () => {
    await navigator.clipboard.writeText(name);
    toast.success(`copied ${name}`);
  };

  return (
    <button
      type="button"
      title="Copy hostname"
      onClick={copy}
      className="no-drag border border-white/10 bg-black px-2.5 py-1.5 font-mono text-[12px] text-white/80 hover:bg-neutral-900"
    >
      {name}
    </button>
  );
}

registerHeaderButton("hostname", Hostname);
"#;

pub fn run_init() -> Result<()> {
    let config = config_dir()?;
    let dir = config.join("plugins");
    std::fs::create_dir_all(&dir)?;

    std::fs::write(dir.join("daimon.d.ts"), TYPES)?;
    println!("wrote   {}", dir.join("daimon.d.ts").display());

    for (file, content) in [("tsconfig.json", TSCONFIG), ("hostname.tsx", EXAMPLE)] {
        let path = dir.join(file);
        if path.exists() {
            println!("kept    {}", path.display());
        } else {
            std::fs::write(&path, content)?;
            println!("created {}", path.display());
        }
    }
    println!("\nopen {} in your editor; daimon picks up saved changes live", dir.display());

    let legacy = config.join("plugins.tsx");
    if legacy.exists() {
        println!("note: {} is no longer used (plugins now live in plugins/)", legacy.display());
    }
    Ok(())
}

pub fn run_list() -> Result<()> {
    let dir = config_dir()?.join("plugins");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default();
    files.retain(|p| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or_default();
        ["js", "mjs", "jsx", "ts", "tsx"].contains(&ext) && !name.ends_with(".d.ts") && !name.starts_with('.')
    });
    files.sort();
    if files.is_empty() {
        println!("no plugins in {} (run `daimon plugin init`)", dir.display());
    }
    for p in files {
        println!("{}", p.display());
    }
    Ok(())
}
