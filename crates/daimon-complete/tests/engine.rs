use daimon_complete::{complete, SuggestionKind};

fn texts(results: &[daimon_complete::Suggestion]) -> Vec<&str> {
    results.iter().map(|s| s.text.as_str()).collect()
}

// ── subcommand completion ─────────────────────────────────────────────────

#[test]
fn git_space_returns_subcommands() {
    let r = complete("git ", "/tmp");
    assert!(!r.is_empty(), "expected subcommands for `git `");
    assert!(r.iter().all(|s| matches!(s.kind, SuggestionKind::Subcommand)));
    let t = texts(&r);
    assert!(t.contains(&"add"), "missing `add`");
    assert!(t.contains(&"commit"), "missing `commit`");
    assert!(t.contains(&"push"), "missing `push`");
}

#[test]
fn git_partial_filters() {
    let r = complete("git co", "/tmp");
    assert!(!r.is_empty());
    for s in &r {
        assert!(s.text.starts_with("co"), "unexpected: {}", s.text);
    }
    let t = texts(&r);
    assert!(t.contains(&"commit") || t.contains(&"checkout") || t.contains(&"clone"));
}

#[test]
fn docker_partial() {
    let r = complete("docker r", "/tmp");
    assert!(!r.is_empty());
    for s in &r {
        assert!(s.text.starts_with('r'), "unexpected: {}", s.text);
    }
}

#[test]
fn cargo_subcommands() {
    let r = complete("cargo ", "/tmp");
    assert!(!r.is_empty());
    let t = texts(&r);
    assert!(t.contains(&"build") || t.contains(&"run") || t.contains(&"test"));
}

// ── flag completion ───────────────────────────────────────────────────────

#[test]
fn git_commit_flags() {
    let r = complete("git commit --", "/tmp");
    assert!(!r.is_empty());
    assert!(r.iter().all(|s| matches!(s.kind, SuggestionKind::Flag)));
    let t = texts(&r);
    assert!(t.iter().any(|s| s.starts_with("--")));
}

#[test]
fn git_commit_short_flag() {
    let r = complete("git commit -", "/tmp");
    assert!(!r.is_empty());
    assert!(r.iter().all(|s| matches!(s.kind, SuggestionKind::Flag)));
}

// ── no spec fallback ──────────────────────────────────────────────────────

#[test]
fn unknown_cmd_falls_back_to_fs() {
    // Unknown command in /tmp — should return filesystem entries, not subcommands
    let r = complete("xyzunknowncmd ", "/tmp");
    // May be empty if /tmp is empty for the prefix, that's fine — but should not panic
    for s in &r {
        assert!(
            matches!(s.kind, SuggestionKind::File | SuggestionKind::Dir),
            "expected fs kind, got {:?}", s.kind
        );
    }
}

// ── empty / whitespace ────────────────────────────────────────────────────

#[test]
fn empty_buffer_returns_nothing() {
    assert!(complete("", "/tmp").is_empty());
}

#[test]
fn whitespace_only_returns_nothing() {
    assert!(complete("   ", "/tmp").is_empty());
}

// ── descriptions present for known specs ─────────────────────────────────

#[test]
fn git_subcommands_have_descriptions() {
    let r = complete("git ", "/tmp");
    let with_desc = r.iter().filter(|s| s.description.is_some()).count();
    assert!(with_desc > 0, "expected some subcommands to have descriptions");
}

// ── nested subcommand ─────────────────────────────────────────────────────

#[test]
fn docker_container_subcommand() {
    let r = complete("docker container ", "/tmp");
    // docker spec should have `container` subcommand; its children should surface
    // Even if the spec doesn't have nested docker container subcommands, should not panic
    let _ = r; // just ensure no panic / infinite loop
}

// ── all built-in specs load (subcommand-based ones) ──────────────────────

#[test]
fn subcommand_specs_complete() {
    // These specs have subcommands — `cmd ` must return results
    let cmds = ["git", "docker", "kubectl", "cargo", "bun", "npm", "brew"];
    for cmd in cmds {
        let buf = format!("{} ", cmd);
        let r = complete(&buf, "/tmp");
        assert!(!r.is_empty(), "`{cmd} ` returned no completions");
    }
}

#[test]
fn flag_only_specs_load() {
    // ssh / curl / jq are flag/arg-only — `cmd ` may return nothing but must not panic
    let cmds = ["ssh", "curl", "jq"];
    for cmd in cmds {
        let buf = format!("{} -", cmd);
        let r = complete(&buf, "/tmp");
        assert!(!r.is_empty(), "`{cmd} -` returned no flags");
        assert!(r.iter().all(|s| matches!(s.kind, SuggestionKind::Flag)));
    }
}

#[test]
fn git_add_returns_dirty_files() {
    let cwd = env!("CARGO_MANIFEST_DIR");
    let root = std::path::Path::new(cwd).parent().unwrap().parent().unwrap();
    let r = complete("git add ", root.to_str().unwrap());
    assert!(!r.is_empty(), "git add returned no dirty files in {root:?}");
    assert!(r.iter().all(|s| matches!(s.kind, SuggestionKind::File | SuggestionKind::Dir)));
}
