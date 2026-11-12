use crate::registry::global;
use crate::spec::{ArgKind, Subcommand};
use crate::tokenize::tokenize;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct Suggestion {
    pub text: String,
    pub description: Option<String>,
    pub kind: SuggestionKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionKind {
    Subcommand,
    Flag,
    File,
    Dir,
    GitBranch,
    GitTag,
    GitRemote,
    Choice,
    History,
}

/// Main entry point — given a buffer and cwd, return completions.
pub fn complete(buffer: &str, cwd: &str) -> Vec<Suggestion> {
    let cursor = buffer.len();
    let (words, idx, partial) = tokenize(buffer, cursor);

    if words.is_empty() && partial.is_empty() {
        return vec![];
    }

    let cmd = if idx == 0 { &partial } else { &words[0] };
    if idx == 0 {
        // Completing the command name itself — no spec needed
        return filesystem_completions(&partial, cwd, true);
    }

    let Some(spec) = global().get(cmd) else {
        // No spec — fall back to filesystem
        return filesystem_completions(&partial, cwd, false);
    };

    // Walk subcommand tree
    let mut subcommands = &spec.subcommands;
    let mut flags = &spec.flags;
    let mut args = &spec.args;
    let mut sub_depth = 1usize;

    while sub_depth < idx {
        let word = &words[sub_depth];
        if let Some(sub) = subcommands.iter().find(|s| &s.name == word || s.aliases.contains(word)) {
            subcommands = &sub.subcommands;
            flags = &sub.flags;
            args = &sub.args;
            sub_depth += 1;
        } else {
            break;
        }
    }

    let mut out = Vec::new();

    // If partial starts with '-', complete flags
    if partial.starts_with('-') {
        for f in flags {
            if f.name.starts_with(&partial) {
                out.push(Suggestion { text: f.name.clone(), description: f.description.clone(), kind: SuggestionKind::Flag });
            }
            if let Some(short) = &f.short {
                if short.starts_with(&partial) {
                    out.push(Suggestion { text: short.clone(), description: f.description.clone(), kind: SuggestionKind::Flag });
                }
            }
        }
        return out;
    }

    // Subcommand completions at the right depth
    if sub_depth == idx {
        for s in subcommands {
            if s.name.starts_with(&partial) {
                out.push(Suggestion { text: s.name.clone(), description: s.description.clone(), kind: SuggestionKind::Subcommand });
            }
        }
        if !out.is_empty() { return out; }
    }

    // Arg completions based on arg kind
    let arg_pos = idx.saturating_sub(sub_depth);
    let arg = args.get(arg_pos)
        .or_else(|| args.last().filter(|a| matches!(a.kind, ArgKind::Rest)));

    if let Some(arg) = arg {
        return complete_arg(&arg.kind, &partial, cwd);
    }

    // Last resort: filesystem
    filesystem_completions(&partial, cwd, false)
}

fn complete_arg(kind: &ArgKind, partial: &str, cwd: &str) -> Vec<Suggestion> {
    match kind {
        ArgKind::File | ArgKind::Rest => filesystem_completions(partial, cwd, false),
        ArgKind::Dir                  => filesystem_completions(partial, cwd, true),
        ArgKind::Choice { choices }   => choices.iter()
            .filter(|c| c.starts_with(partial))
            .map(|c| Suggestion { text: c.clone(), description: None, kind: SuggestionKind::Choice })
            .collect(),
        ArgKind::GitBranch  => git_refs(partial, cwd, GitRefKind::Branch),
        ArgKind::GitTag     => git_refs(partial, cwd, GitRefKind::Tag),
        ArgKind::GitRemote  => git_refs(partial, cwd, GitRefKind::Remote),
        ArgKind::String     => vec![],
    }
}

fn filesystem_completions(partial: &str, cwd: &str, dirs_only: bool) -> Vec<Suggestion> {
    let (dir, prefix) = if partial.contains('/') {
        let p = Path::new(partial);
        let dir = if partial.ends_with('/') {
            p.to_path_buf()
        } else {
            p.parent().unwrap_or(Path::new(".")).to_path_buf()
        };
        let prefix = if partial.ends_with('/') { "" } else { p.file_name().and_then(|n| n.to_str()).unwrap_or("") };
        (dir, prefix.to_string())
    } else {
        (Path::new(cwd).to_path_buf(), partial.to_string())
    };

    let base = if dir.is_absolute() { dir.clone() } else { Path::new(cwd).join(&dir) };
    let Ok(entries) = std::fs::read_dir(&base) else { return vec![] };

    entries.flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            if !name.starts_with(&prefix) { return None; }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if dirs_only && !is_dir { return None; }
            let text = if partial.contains('/') {
                format!("{}{}", if partial.ends_with('/') { partial.to_string() } else {
                    format!("{}/", partial.rsplit_once('/').map(|(p,_)| p).unwrap_or(""))
                }, name)
            } else {
                name.clone()
            };
            let display = if is_dir { format!("{}/", text) } else { text };
            Some(Suggestion {
                text: display,
                description: None,
                kind: if is_dir { SuggestionKind::Dir } else { SuggestionKind::File },
            })
        })
        .take(50)
        .collect()
}

enum GitRefKind { Branch, Tag, Remote }

fn git_refs(partial: &str, cwd: &str, kind: GitRefKind) -> Vec<Suggestion> {
    let Ok(repo) = git2::Repository::discover(cwd) else { return vec![] };
    let mut out = Vec::new();
    match kind {
        GitRefKind::Branch => {
            let Ok(branches) = repo.branches(Some(git2::BranchType::Local)) else { return vec![] };
            for b in branches.flatten() {
                if let Some(name) = b.0.name().ok().flatten() {
                    if name.starts_with(partial) {
                        out.push(Suggestion { text: name.to_string(), description: None, kind: SuggestionKind::GitBranch });
                    }
                }
            }
        }
        GitRefKind::Tag => {
            let Ok(tags) = repo.tag_names(None) else { return vec![] };
            for tag in tags.iter().flatten() {
                if tag.starts_with(partial) {
                    out.push(Suggestion { text: tag.to_string(), description: None, kind: SuggestionKind::GitTag });
                }
            }
        }
        GitRefKind::Remote => {
            let Ok(remotes) = repo.remotes() else { return vec![] };
            for r in remotes.iter().flatten() {
                if r.starts_with(partial) {
                    out.push(Suggestion { text: r.to_string(), description: None, kind: SuggestionKind::GitRemote });
                }
            }
        }
    }
    out
}
