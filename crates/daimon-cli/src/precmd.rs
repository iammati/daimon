/// Emits OSC 133 prompt mark with context JSON.
/// Called on every precmd — must be fast.
/// Git info via libgit2 (no subprocess). Env vars read directly.
pub fn run() -> anyhow::Result<()> {
    let pwd = std::env::var("PWD").unwrap_or_else(|_| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    });

    let exit_code: i32 = std::env::var("DAIMON_EXIT_CODE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let git = git_info(&pwd);

    let mut obj = serde_json::Map::new();
    obj.insert("pwd".into(),      serde_json::Value::String(pwd));
    obj.insert("exitCode".into(), serde_json::Value::Number(exit_code.into()));

    if let Some(g) = git {
        obj.insert("gitBranch".into(),  serde_json::Value::String(g.branch));
        obj.insert("gitDirty".into(),   serde_json::Value::Bool(g.dirty));
        obj.insert("gitAhead".into(),   serde_json::Value::Number(g.ahead.into()));
        obj.insert("gitBehind".into(),  serde_json::Value::Number(g.behind.into()));
        obj.insert("gitAdded".into(),   serde_json::Value::Number(g.added.into()));
        obj.insert("gitRemoved".into(), serde_json::Value::Number(g.removed.into()));
    }

    // Opt-in context modules — only emit if env vars present (set once at session init)
    if let Ok(v) = std::env::var("OS_REGION_NAME")          { obj.insert("region".into(),  v.into()); }
    if let Ok(v) = std::env::var("OS_PROJECT_NAME")         { obj.insert("project".into(), v.into()); }
    if let Ok(v) = std::env::var("OS_PROJECT_DOMAIN_NAME")  { obj.insert("domain".into(),  v.into()); }
    if let Ok(v) = std::env::var("CCLOUD_PROMPT_NOCOLOR")
        .or_else(|_| std::env::var("CCLOUD_PROMPT"))        { obj.insert("ccloudPrompt".into(), v.into()); }
    // k8s context + namespace. Source priority:
    //   1. `u8s env` — the SAPCC u8s tool stores its per-session selection in a dotenv,
    //      NOT in kubeconfig's current-context; `u8s env` is its stable machine-readable hook.
    //   2. KUBECTL_CONTEXT / KUBECTL_NAMESPACE env (set at session init for plain kubectl users).
    //   3. kubeconfig current-context (plain kubectl, no env).
    let (u8s_ctx, u8s_ns) = u8s_context();
    match u8s_ctx.or_else(|| std::env::var("KUBECTL_CONTEXT").ok()).or_else(kube_current_context) {
        Some(ctx) if !ctx.is_empty() => { obj.insert("k8sContext".into(), ctx.into()); }
        _ => {}
    }
    match u8s_ns.or_else(|| std::env::var("KUBECTL_NAMESPACE").ok()) {
        Some(ns) if !ns.is_empty() => { obj.insert("k8sNamespace".into(), ns.into()); }
        _ => {}
    }

    let json = serde_json::Value::Object(obj).to_string();
    // OSC 133 ; A — prompt start, with daimon context payload
    print!("\x1b]133;A{json}\x1b\\");
    Ok(())
}

pub struct GitInfo {
    branch: String,
    dirty: bool,
    ahead: u32,
    behind: u32,
    added: usize,
    removed: usize,
}

/// Queries the SAPCC `u8s` tool for its current session context/namespace via `u8s env`
/// (clean `KEY=value` lines, no ANSI). Returns (None, None) if u8s is absent or errors —
/// non-u8s users are unaffected. One subprocess per precmd; u8s is built as a prompt hook.
fn u8s_context() -> (Option<String>, Option<String>) {
    let out = match std::process::Command::new("u8s").arg("env").output() {
        Ok(o) if o.status.success() => o.stdout,
        _ => return (None, None),
    };
    let text = String::from_utf8_lossy(&out);
    let mut ctx = None;
    let mut ns = None;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("U8S_CONTEXT=")   { ctx = Some(v.trim().to_string()); }
        if let Some(v) = line.strip_prefix("U8S_NAMESPACE=") { ns  = Some(v.trim().to_string()); }
    }
    (ctx, ns)
}

/// Reads `current-context` from the active kubeconfig (first KUBECONFIG path, else ~/.kube/config).
/// Line-scan with early exit — the field sits near the top, so this stays cheap even on large files.
fn kube_current_context() -> Option<String> {
    use std::io::BufRead;
    let path = std::env::var("KUBECONFIG")
        .ok()
        .and_then(|v| v.split(':').next().map(str::to_string).filter(|s| !s.is_empty()))
        .or_else(|| std::env::var("HOME").ok().map(|h| format!("{h}/.kube/config")))?;
    let file = std::fs::File::open(path).ok()?;
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
        if let Some(rest) = line.trim_start().strip_prefix("current-context:") {
            let ctx = rest.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
            return (!ctx.is_empty()).then_some(ctx);
        }
    }
    None
}

pub fn git_info_pub(path: &str) -> Option<GitInfo> { git_info(path) }

/// Git status via the `git` CLI rather than libgit2.
///
/// On large repos (multi-GB .git, big worktrees) libgit2's status/diff take seconds because it
/// has no fsmonitor support and ignores the index's untracked-cache — it always stat()s the whole
/// worktree. The `git` CLI reuses fsmonitor + untracked-cache + commit-graph, so the same query is
/// sub-second. precmd runs on every prompt, so speed here is the whole game.
///
/// One `git status --porcelain=v2 --branch` gives branch + ahead/behind + tracked dirty in a single
/// process; `--no-optional-locks` avoids touching the index lock from a background prompt.
fn git_info(path: &str) -> Option<GitInfo> {
    use std::process::Command;

    let status = Command::new("git")
        .args(["-C", path, "--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=no"])
        .output()
        .ok()?;
    if !status.status.success() { return None; } // not a repo
    let text = String::from_utf8_lossy(&status.stdout);

    let mut branch = String::from("HEAD");
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut dirty = false;
    for line in text.lines() {
        if let Some(h) = line.strip_prefix("# branch.head ") {
            if h != "(detached)" { branch = h.to_string(); }
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            // format: "+<ahead> -<behind>"
            let mut it = ab.split_whitespace();
            ahead = it.next().and_then(|s| s.strip_prefix('+')).and_then(|s| s.parse().ok()).unwrap_or(0);
            behind = it.next().and_then(|s| s.strip_prefix('-')).and_then(|s| s.parse().ok()).unwrap_or(0);
        } else if line.starts_with('1') || line.starts_with('2') || line.starts_with('u') {
            // changed (1), renamed/copied (2), or unmerged (u) tracked entry → dirty
            dirty = true;
        }
    }
    // detached HEAD → short sha
    if branch == "HEAD" {
        if let Ok(o) = Command::new("git").args(["-C", path, "rev-parse", "--short", "HEAD"]).output() {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !s.is_empty() { branch = s; }
            }
        }
    }

    let (added, removed) = diff_line_counts(path);
    Some(GitInfo { branch, dirty, ahead, behind, added, removed })
}

/// Insertions/deletions of TRACKED changes (worktree + index) vs HEAD, via `git diff --numstat`.
/// Untracked files are excluded (new files aren't "diff lines", and skipping them keeps the walk
/// cheap). Binary files report "-\t-\t<path>" in numstat and are ignored.
fn diff_line_counts(path: &str) -> (usize, usize) {
    let out = match std::process::Command::new("git")
        .args(["-C", path, "--no-optional-locks", "diff", "--numstat", "HEAD"])
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return (0, 0),
    };
    let text = String::from_utf8_lossy(&out);
    let mut added = 0usize;
    let mut removed = 0usize;
    for line in text.lines() {
        let mut cols = line.split('\t');
        let a = cols.next().unwrap_or("");
        let r = cols.next().unwrap_or("");
        if let Ok(n) = a.parse::<usize>() { added += n; }
        if let Ok(n) = r.parse::<usize>() { removed += n; }
    }
    (added, removed)
}

