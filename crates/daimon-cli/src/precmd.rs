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
    }

    // Opt-in context modules — only emit if env vars present (set once at session init)
    if let Ok(v) = std::env::var("OS_REGION_NAME")          { obj.insert("region".into(),  v.into()); }
    if let Ok(v) = std::env::var("OS_PROJECT_NAME")         { obj.insert("project".into(), v.into()); }
    if let Ok(v) = std::env::var("OS_PROJECT_DOMAIN_NAME")  { obj.insert("domain".into(),  v.into()); }
    if let Ok(v) = std::env::var("CCLOUD_PROMPT_NOCOLOR")
        .or_else(|_| std::env::var("CCLOUD_PROMPT"))        { obj.insert("ccloudPrompt".into(), v.into()); }
    if let Ok(v) = std::env::var("KUBECTL_CONTEXT")         { obj.insert("k8sContext".into(),   v.into()); }
    if let Ok(v) = std::env::var("KUBECTL_NAMESPACE")       { obj.insert("k8sNamespace".into(), v.into()); }

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
}

pub fn git_info_pub(path: &str) -> Option<GitInfo> { git_info(path) }

fn git_info(path: &str) -> Option<GitInfo> {
    let repo = git2::Repository::discover(path).ok()?;

    let head = repo.head().ok()?;
    let branch = if head.is_branch() {
        head.shorthand().unwrap_or("HEAD").to_string()
    } else {
        head.peel_to_commit().ok()
            .map(|c| c.id().to_string()[..7].to_string())
            .unwrap_or_else(|| "HEAD".into())
    };

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(false);
    let statuses = repo.statuses(Some(&mut opts)).ok()?;
    let dirty = statuses.iter().any(|s| s.status() != git2::Status::CURRENT);

    // ahead/behind vs upstream
    let (ahead, behind) = repo.head().ok()
        .and_then(|h| h.resolve().ok())
        .and_then(|h| h.name().map(|n| n.to_string()))
        .and_then(|refname| {
            let upstream = git2::Branch::wrap(repo.find_reference(&refname).ok()?)
                .upstream().ok()?;
            let local_oid = repo.refname_to_id(&refname).ok()?;
            let upstream_oid = upstream.get().target()?;
            repo.graph_ahead_behind(local_oid, upstream_oid).ok()
        })
        .map(|(a, b)| (a as u32, b as u32))
        .unwrap_or((0, 0));

    Some(GitInfo { branch, dirty, ahead, behind })
}
