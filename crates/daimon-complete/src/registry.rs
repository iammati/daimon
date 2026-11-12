use crate::spec::Spec;
use anyhow::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static REGISTRY: OnceLock<Registry> = OnceLock::new();

pub struct Registry {
    specs: HashMap<String, Spec>,
}

impl Registry {
    /// Load built-in specs (embedded at compile time) + user specs from
    /// ~/.config/daimon/specs/*.yaml (user files override built-ins by name).
    pub fn load() -> Result<Self> {
        let mut specs: HashMap<String, Spec> = HashMap::new();

        // Built-in specs embedded at compile time
        for (name, yaml) in BUILTIN_SPECS {
            match serde_yaml::from_str::<Spec>(yaml) {
                Ok(s) => { specs.insert(name.to_string(), s); }
                Err(e) => eprintln!("daimon-complete: bad built-in spec {name}: {e}"),
            }
        }

        // User overrides / additions
        if let Some(dir) = user_spec_dir() {
            load_dir(&dir, &mut specs);
        }

        Ok(Self { specs })
    }

    pub fn get(&self, cmd: &str) -> Option<&Spec> {
        self.specs.get(cmd)
    }
}

pub fn global() -> &'static Registry {
    REGISTRY.get_or_init(|| Registry::load().unwrap_or(Registry { specs: HashMap::new() }))
}

fn load_dir(dir: &Path, specs: &mut HashMap<String, Spec>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("yaml") { continue; }
        match std::fs::read_to_string(&path).map(|s| serde_yaml::from_str::<Spec>(&s)) {
            Ok(Ok(s)) => { specs.insert(s.name.clone(), s); }
            Ok(Err(e)) => eprintln!("daimon-complete: bad spec {}: {e}", path.display()),
            Err(e)     => eprintln!("daimon-complete: read {}: {e}", path.display()),
        }
    }
}

fn user_spec_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".config").join("daimon").join("specs"))
}

// Built-in specs embedded at compile time via include_str!
// Each entry: (command_name, yaml_content)
const BUILTIN_SPECS: &[(&str, &str)] = &[
    ("git",     include_str!("../../../specs/git.yaml")),
    ("docker",  include_str!("../../../specs/docker.yaml")),
    ("kubectl", include_str!("../../../specs/kubectl.yaml")),
    ("cargo",   include_str!("../../../specs/cargo.yaml")),
    ("bun",     include_str!("../../../specs/bun.yaml")),
    ("npm",     include_str!("../../../specs/npm.yaml")),
    ("brew",    include_str!("../../../specs/brew.yaml")),
    ("ssh",     include_str!("../../../specs/ssh.yaml")),
    ("curl",    include_str!("../../../specs/curl.yaml")),
    ("jq",      include_str!("../../../specs/jq.yaml")),
];
