/// Measures wall time of each shell hook component and reports slow ones.
/// Run manually: `daimon shell-profiling`
pub fn run() -> anyhow::Result<()> {
    let checks: &[(&str, fn() -> anyhow::Result<()>)] = &[
        ("git info (libgit2)",  profile_git),
        ("env var reads",       profile_env),
        ("OSC 133 emit",        profile_osc),
    ];

    println!("daimon shell-profiling\n");

    let mut any_slow = false;
    for (name, f) in checks {
        let start = std::time::Instant::now();
        f()?;
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        let flag = if ms > 20.0 { " ⚠ slow" } else { "" };
        if ms > 20.0 { any_slow = true; }
        println!("  {name:<30} {ms:>6.1}ms{flag}");
    }

    if any_slow {
        println!("\n⚠  components above 20ms add visible prompt lag");
    } else {
        println!("\n✓  all hooks within budget");
    }

    Ok(())
}

fn profile_git() -> anyhow::Result<()> {
    let pwd = std::env::var("PWD").unwrap_or_else(|_| ".".into());
    let _ = crate::precmd::git_info_pub(&pwd);
    Ok(())
}

fn profile_env() -> anyhow::Result<()> {
    let _ = std::env::var("OS_REGION_NAME");
    let _ = std::env::var("KUBECTL_CONTEXT");
    let _ = std::env::var("CCLOUD_PROMPT_NOCOLOR");
    Ok(())
}

fn profile_osc() -> anyhow::Result<()> {
    print!("\x1b]133;A{{}}\x1b\\");
    Ok(())
}
