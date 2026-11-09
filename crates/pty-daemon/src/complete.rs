/// Completion engine — wraps gc-suggest's SuggestionEngine as a process-wide singleton.
/// suggest_sync is CPU-bound but fast (<1ms for spec hits, <5ms for filesystem).
/// Called from spawn_blocking so it never blocks the async runtime.

use gc_buffer::parse_command_context;
use gc_suggest::{SuggestionEngine, SuggestionKind};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;

static ENGINE: OnceLock<SuggestionEngine> = OnceLock::new();

fn engine() -> &'static SuggestionEngine {
    ENGINE.get_or_init(|| {
        // Load user custom spec dir if present (~/.config/ghost-complete/specs)
        let custom = dirs::config_dir()
            .map(|d| d.join("ghost-complete").join("specs"))
            .filter(|p| p.exists())
            .into_iter()
            .collect::<Vec<_>>();
        SuggestionEngine::new_with_embedded(&custom, true)
            .expect("failed to init SuggestionEngine")
    })
}

#[derive(Serialize)]
pub struct CompletionItem {
    pub text: String,
    pub description: Option<String>,
    pub kind: &'static str,
}

pub fn complete(buffer: &str, cwd: &str) -> Value {
    let cursor = buffer.chars().count();
    let ctx = parse_command_context(buffer, cursor);
    let cwd_path = Path::new(cwd);

    let result = match engine().suggest_sync(&ctx, cwd_path, buffer) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("complete error: {e}");
            return Value::Array(vec![]);
        }
    };

    let items: Vec<CompletionItem> = result
        .suggestions
        .into_iter()
        .map(|s| CompletionItem {
            text: s.text,
            description: s.description,
            kind: kind_str(s.kind),
        })
        .collect();

    serde_json::to_value(items).unwrap_or(Value::Array(vec![]))
}

fn kind_str(k: SuggestionKind) -> &'static str {
    match k {
        SuggestionKind::Command => "command",
        SuggestionKind::Subcommand => "subcommand",
        SuggestionKind::Flag => "flag",
        SuggestionKind::FilePath => "file",
        SuggestionKind::Directory => "dir",
        SuggestionKind::GitBranch => "git_branch",
        SuggestionKind::GitTag => "git_tag",
        SuggestionKind::GitRemote => "git_remote",
        SuggestionKind::History => "history",
        SuggestionKind::EnvVar => "env_var",
        _ => "arg",
    }
}
