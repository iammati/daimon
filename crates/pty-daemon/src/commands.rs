/// Out-of-band commands: git queries, k8s/openstack context listing.
/// Each returns a serde_json::Value for the Response event.

use serde_json::{json, Value};
use std::process::Command;

fn run(cmd: &str, args: &[&str], cwd: Option<&str>) -> Result<String, String> {
    let mut c = Command::new(cmd);
    c.args(args);
    if let Some(dir) = cwd {
        c.current_dir(dir);
    }
    match c.output() {
        Ok(out) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn git_status(cwd: &str) -> Value {
    match run("git", &["--no-pager", "status", "--porcelain=v1", "-b"], Some(cwd)) {
        Err(e) => json!({ "error": e }),
        Ok(raw) => {
            let mut branch = String::new();
            let mut ahead = 0i32;
            let mut behind = 0i32;
            let mut staged: Vec<Value> = vec![];
            let mut unstaged: Vec<Value> = vec![];
            let mut untracked: Vec<String> = vec![];

            for line in raw.lines() {
                if let Some(rest) = line.strip_prefix("## ") {
                    // ## main...origin/main [ahead 1, behind 2]
                    let parts: Vec<&str> = rest.splitn(2, "...").collect();
                    branch = parts[0].to_string();
                    if let Some(info) = parts.get(1) {
                        if let Some(a) = info.split("ahead ").nth(1) {
                            ahead = a.split([',', ']']).next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                        }
                        if let Some(b) = info.split("behind ").nth(1) {
                            behind = b.split([',', ']']).next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                        }
                    }
                } else if line.len() >= 3 {
                    let xy = &line[..2];
                    let path = line[3..].to_string();
                    if xy == "??" {
                        untracked.push(path);
                    } else {
                        let x = &xy[..1];
                        let y = &xy[1..];
                        if x != " " && x != "?" { staged.push(json!({ "xy": x, "path": path })); }
                        if y != " " && y != "?" { unstaged.push(json!({ "xy": y, "path": path })); }
                    }
                }
            }
            json!({ "branch": branch, "ahead": ahead, "behind": behind, "staged": staged, "unstaged": unstaged, "untracked": untracked })
        }
    }
}

pub fn git_commit_detail(hash: &str, cwd: &str) -> Value {
    let numstat = run("git", &["--no-pager", "show", "--first-parent", "--numstat", "--format=", hash], Some(cwd));
    let body = run("git", &["--no-pager", "show", "--no-patch", "--format=%B", hash], Some(cwd));

    let files: Vec<Value> = match numstat {
        Err(e) => return json!({ "error": e }),
        Ok(raw) => raw.lines()
            .filter(|l| !l.is_empty())
            .filter_map(|l| {
                let mut parts = l.splitn(3, '\t');
                let add: i64 = parts.next()?.trim().parse().unwrap_or(0);
                let del: i64 = parts.next()?.trim().parse().unwrap_or(0);
                let path = parts.next()?.trim().to_string();
                // Binary files show "-" for add/del
                Some(json!({ "status": "M", "path": path, "additions": add, "deletions": del }))
            })
            .collect(),
    };

    let body_str = body.unwrap_or_default().trim().to_string();
    json!({ "files": files, "body": body_str })
}

pub fn git_file_diff(hash: &str, file_path: &str, cwd: &str) -> Value {
    match run("git", &["--no-pager", "show", "--first-parent", hash, "--", file_path], Some(cwd)) {
        Err(e) => json!({ "error": e }),
        Ok(diff) => json!(diff),
    }
}

pub fn git_log(cwd: &str, limit: usize) -> Value {
    let limit_str = limit.to_string();
    let fmt = "%H|%h|%aI|%s|%an|%D";
    match run("git", &["--no-pager", "log", &format!("-{}", limit_str), &format!("--format={}", fmt)], Some(cwd)) {
        Err(e) => json!({ "error": e }),
        Ok(raw) => {
            let entries: Vec<Value> = raw.lines().enumerate().map(|(i, line)| {
                let parts: Vec<&str> = line.splitn(6, '|').collect();
                json!({
                    "hash": parts.get(1).unwrap_or(&""),
                    "fullHash": parts.get(0).unwrap_or(&""),
                    "date": parts.get(2).unwrap_or(&""),
                    "subject": parts.get(3).unwrap_or(&""),
                    "author": parts.get(4).unwrap_or(&""),
                    "isHead": i == 0,
                })
            }).collect();
            json!(entries)
        }
    }
}

pub fn git_branch(cwd: &str) -> Value {
    match run("git", &["--no-pager", "branch", "--format=%(refname:short)|%(HEAD)"], Some(cwd)) {
        Err(e) => json!({ "error": e }),
        Ok(raw) => {
            let branches: Vec<String> = raw.lines()
                .filter_map(|l| {
                    let parts: Vec<&str> = l.splitn(2, '|').collect();
                    Some(parts[0].trim().to_string())
                })
                .collect();
            // current branch first
            let current = raw.lines()
                .find_map(|l| {
                    let parts: Vec<&str> = l.splitn(2, '|').collect();
                    if parts.get(1) == Some(&"*") { Some(parts[0].trim().to_string()) } else { None }
                })
                .unwrap_or_default();
            json!({ "branches": branches, "current": current })
        }
    }
}

pub fn list_contexts() -> Value {
    let home = std::env::var("HOME").unwrap_or_default();
    let kubeconfig = format!("{}/Library/Application Support/SAPCC/u8s/.kube/config", home);
    match run("kubectl", &["config", "get-contexts", "-o", "name", "--kubeconfig", &kubeconfig], None) {
        Err(_) => {
            // Fallback: system kubeconfig
            match run("kubectl", &["config", "get-contexts", "-o", "name"], None) {
                Err(e) => json!({ "error": e }),
                Ok(raw) => json!(raw.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>()),
            }
        }
        Ok(raw) => json!(raw.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>()),
    }
}

pub fn sync_contexts() -> Value {
    match run("u8s", &["sync"], None) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "error": e }),
    }
}

pub fn list_regions() -> Value {
    match run("ccloud-multitool", &["list-regions"], None) {
        Err(e) => json!({ "error": e }),
        Ok(raw) => json!(raw.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>()),
    }
}

pub fn list_paths(prefix: &str, cwd: &str, kind: &str) -> Value {
    use std::path::Path;

    let base = if prefix.starts_with('/') || prefix.starts_with('~') {
        let expanded = if let Some(rest) = prefix.strip_prefix("~/") {
            let home = std::env::var("HOME").unwrap_or_default();
            format!("{}/{}", home, rest)
        } else {
            prefix.to_string()
        };
        expanded
    } else {
        format!("{}/{}", cwd.trim_end_matches('/'), prefix)
    };

    // If prefix ends with '/' treat as dir, else list parent and filter
    let (search_dir, filter) = if base.ends_with('/') || base.is_empty() {
        (base.clone(), "".to_string())
    } else {
        let p = Path::new(&base);
        let dir = p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_else(|| ".".to_string());
        let file = p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
        (dir, file)
    };

    let dir = std::fs::read_dir(&search_dir).ok();
    let mut entries: Vec<Value> = dir.into_iter().flatten().flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !filter.is_empty() && !name.to_lowercase().starts_with(&filter.to_lowercase()) { return None; }
            let is_dir = e.file_type().ok()?.is_dir();
            if kind == "dir" && !is_dir { return None; }
            if kind == "file" && is_dir { return None; }
            let display = if prefix.ends_with('/') || prefix.is_empty() {
                name.clone()
            } else {
                let stem = prefix.rsplit('/').next().unwrap_or(prefix);
                let without_stem = &prefix[..prefix.len() - stem.len()];
                format!("{}{}", without_stem, name)
            };
            Some(json!({ "value": if is_dir { format!("{}/", display) } else { display }, "isDir": is_dir, "name": name }))
        })
        .collect();
    // dirs first, then files, each group sorted case-insensitively
    entries.sort_by(|a, b| {
        let a_dir = a["isDir"].as_bool().unwrap_or(false);
        let b_dir = b["isDir"].as_bool().unwrap_or(false);
        b_dir.cmp(&a_dir).then_with(|| {
            let a_name = a["name"].as_str().unwrap_or("").to_lowercase();
            let b_name = b["name"].as_str().unwrap_or("").to_lowercase();
            a_name.cmp(&b_name)
        })
    });
    // strip internal "name" field before returning
    let entries: Vec<Value> = entries.into_iter().map(|mut e| { e.as_object_mut().map(|o| o.remove("name")); e }).collect();

    json!(entries)
}

pub fn git_diff(args: &[String], cwd: &str) -> Value {
    let mut git_args = vec!["--no-pager", "diff", "--color=never"];
    let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git_args.extend_from_slice(&args_refs);
    match run("git", &git_args, Some(cwd)) {
        Err(e) => json!({ "error": e }),
        Ok(raw) => json!({ "raw": raw }),
    }
}
