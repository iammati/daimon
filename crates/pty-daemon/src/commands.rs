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

/// Per-file `+added -removed` line counts from `git diff --numstat [extra]`.
/// Binary files report `-` and are omitted. Renames are keyed by their new path.
fn numstat_map(cwd: &str, extra: &[&str]) -> std::collections::HashMap<String, (u64, u64)> {
    let mut args = vec!["--no-pager", "--no-optional-locks", "diff", "--numstat", "-M"];
    args.extend_from_slice(extra);
    let mut map = std::collections::HashMap::new();
    if let Ok(raw) = run("git", &args, Some(cwd)) {
        for line in raw.lines() {
            let mut cols = line.splitn(3, '\t');
            let (Some(a), Some(d), Some(path)) = (cols.next(), cols.next(), cols.next()) else { continue };
            let (Ok(a), Ok(d)) = (a.parse::<u64>(), d.parse::<u64>()) else { continue };
            map.insert(rename_target(path), (a, d));
        }
    }
    map
}

/// `old => new` or `dir/{old => new}/file` → new path.
fn rename_target(path: &str) -> String {
    if let (Some(open), Some(close)) = (path.find('{'), path.find('}')) {
        let inner = &path[open + 1..close];
        if let Some((_, new)) = inner.split_once(" => ") {
            let joined = format!("{}{}{}", &path[..open], new, &path[close + 1..]);
            return joined.replace("//", "/");
        }
    }
    match path.split_once(" => ") {
        Some((_, new)) => new.to_string(),
        None => path.to_string(),
    }
}

pub fn git_status(cwd: &str) -> Value {
    match run("git", &["--no-pager", "status", "--porcelain=v1", "-b"], Some(cwd)) {
        Err(e) => json!({ "error": e }),
        Ok(raw) => {
            let mut branch = String::new();
            let mut upstream: Option<String> = None;
            let mut ahead = 0i32;
            let mut behind = 0i32;
            let mut staged: Vec<(String, String, Option<String>)> = vec![];
            let mut unstaged: Vec<(String, String, Option<String>)> = vec![];
            let mut untracked: Vec<String> = vec![];

            for line in raw.lines() {
                if let Some(rest) = line.strip_prefix("## ") {
                    // ## main...origin/main [ahead 1, behind 2]   |   ## No commits yet on main
                    let rest = rest.strip_prefix("No commits yet on ").unwrap_or(rest);
                    let parts: Vec<&str> = rest.splitn(2, "...").collect();
                    branch = parts[0].split(' ').next().unwrap_or("").to_string();
                    if let Some(info) = parts.get(1) {
                        upstream = info.split(' ').next().map(|s| s.to_string()).filter(|s| !s.is_empty());
                        if let Some(a) = info.split("ahead ").nth(1) {
                            ahead = a.split([',', ']']).next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                        }
                        if let Some(b) = info.split("behind ").nth(1) {
                            behind = b.split([',', ']']).next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                        }
                    }
                } else if line.len() >= 3 {
                    let xy = &line[..2];
                    let raw_path = &line[3..];
                    if xy == "??" {
                        untracked.push(raw_path.to_string());
                    } else {
                        // Renames/copies: "old -> new"
                        let (path, from) = match raw_path.split_once(" -> ") {
                            Some((old, new)) => (new.to_string(), Some(old.to_string())),
                            None => (raw_path.to_string(), None),
                        };
                        let x = &xy[..1];
                        let y = &xy[1..];
                        if x != " " && x != "?" { staged.push((x.to_string(), path.clone(), from.clone())); }
                        if y != " " && y != "?" { unstaged.push((y.to_string(), path, None)); }
                    }
                }
            }

            let staged_stats = if staged.is_empty() { Default::default() } else { numstat_map(cwd, &["--cached"]) };
            let unstaged_stats = if unstaged.is_empty() { Default::default() } else { numstat_map(cwd, &[]) };
            let to_json = |items: Vec<(String, String, Option<String>)>, stats: &std::collections::HashMap<String, (u64, u64)>| -> Vec<Value> {
                items.into_iter().map(|(xy, path, from)| {
                    let mut v = json!({ "xy": xy, "path": path });
                    if let Some((a, d)) = stats.get(&path) { v["add"] = json!(a); v["del"] = json!(d); }
                    if let Some(f) = from { v["from"] = json!(f); }
                    v
                }).collect()
            };
            let staged = to_json(staged, &staged_stats);
            let unstaged = to_json(unstaged, &unstaged_stats);

            // Line counts of tracked changes vs HEAD — same numbers the shell prompt hook reports,
            // so the UI can refresh its status line without waiting for the next prompt.
            let (mut added, mut removed) = (0u64, 0u64);
            if !staged.is_empty() || !unstaged.is_empty() {
                if let Ok(numstat) = run("git", &["--no-pager", "--no-optional-locks", "diff", "--numstat", "HEAD"], Some(cwd)) {
                    for line in numstat.lines() {
                        let mut cols = line.split('\t');
                        added += cols.next().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
                        removed += cols.next().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
                    }
                }
            }
            json!({ "branch": branch, "upstream": upstream, "ahead": ahead, "behind": behind, "staged": staged, "unstaged": unstaged, "untracked": untracked, "added": added, "removed": removed })
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

/// Above this many local branches, only compare each branch against the trunk
/// (pairwise `rev-list` calls grow quadratically).
const BRANCH_PAIRWISE_LIMIT: usize = 40;

struct BranchInfo {
    name: String,
    current: bool,
    hash: String,
    upstream: String,
    track: String,
    date: String,
    subject: String,
}

/// `git branch` plus an inferred "branched off" tree.
///
/// Git doesn't record a branch's parent, so it is inferred: the parent of B is the
/// branch P with the fewest commits on B since their merge-base (ties → trunk, then
/// the branch that moved on least, then name). Branches that strictly contain B
/// (B is their ancestor) are never B's parent. The trunk (origin/HEAD, else
/// main/master) is the root.
pub fn git_branch(cwd: &str) -> Value {
    let fmt = "--format=%(refname:short)%1f%(HEAD)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:relative)%1f%(contents:subject)";
    let raw = match run("git", &["--no-pager", "branch", fmt], Some(cwd)) {
        Err(e) => return json!({ "error": e }),
        Ok(raw) => raw,
    };
    let infos: Vec<BranchInfo> = raw.lines().filter_map(|l| {
        let f: Vec<&str> = l.splitn(7, '\x1f').collect();
        if f.len() < 7 || f[0].starts_with('(') { return None; } // skip "(HEAD detached at …)"
        Some(BranchInfo {
            name: f[0].trim().to_string(),
            current: f[1] == "*",
            hash: f[2].to_string(),
            upstream: f[3].to_string(),
            track: f[4].to_string(),
            date: f[5].to_string(),
            subject: f[6].to_string(),
        })
    }).collect();

    let names: Vec<String> = infos.iter().map(|b| b.name.clone()).collect();
    let current = infos.iter().find(|b| b.current).map(|b| b.name.clone()).unwrap_or_default();
    let has = |n: &str| names.iter().any(|b| b == n);

    let trunk: Option<String> = run("git", &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], Some(cwd))
        .ok()
        .and_then(|r| r.trim().split_once('/').map(|(_, b)| b.to_string()))
        .filter(|b| has(b))
        .or_else(|| ["main", "master", "trunk", "develop"].iter().find(|b| has(b)).map(|b| b.to_string()));

    // (ahead of P, behind P) for branch B, i.e. commits only on B / only on P.
    let counts = |p: &str, b: &str| -> Option<(u64, u64)> {
        let out = run("git", &["rev-list", "--left-right", "--count", &format!("{p}...{b}")], Some(cwd)).ok()?;
        let mut it = out.split_whitespace().map(|n| n.parse::<u64>().ok());
        let (behind, ahead) = (it.next()??, it.next()??);
        Some((ahead, behind))
    };

    // name → (parent, ahead, behind)
    let mut parent: std::collections::HashMap<String, (String, u64, u64)> = std::collections::HashMap::new();
    for b in &names {
        if Some(b) == trunk.as_ref() { continue; }
        let candidates: Vec<&String> = if names.len() > BRANCH_PAIRWISE_LIMIT {
            trunk.iter().filter(|t| *t != b).collect()
        } else {
            names.iter().filter(|p| *p != b).collect()
        };
        let mut best: Option<((u64, bool, u64, String), (String, u64, u64))> = None;
        for p in candidates {
            let Some((ahead, behind)) = counts(p, b) else { continue };
            let is_trunk = Some(p) == trunk.as_ref();
            // P strictly contains B → P is a descendant, not a parent.
            if ahead == 0 && behind > 0 && !is_trunk { continue; }
            // Same tip: only the trunk or an alphabetically earlier branch may parent it (no 2-cycles).
            if ahead == 0 && behind == 0 && !is_trunk && p.as_str() > b.as_str() { continue; }
            // Same-tip (0,0): prefer a non-trunk sibling (closer relative) over trunk.
            let prefers_trunk = !(ahead == 0 && behind == 0 && !is_trunk);
            let key = (ahead, prefers_trunk, behind, p.clone());
            if best.as_ref().map_or(true, |(k, _)| key < *k) {
                best = Some((key, (p.clone(), ahead, behind)));
            }
        }
        if let Some((_, v)) = best { parent.insert(b.clone(), v); }
    }

    // Break any remaining cycles by re-rooting a member onto the trunk (or making it a root).
    for b in &names {
        let mut seen = std::collections::HashSet::new();
        let mut cur = b.clone();
        while let Some((p, _, _)) = parent.get(&cur) {
            if !seen.insert(cur.clone()) {
                let fix = cur.clone();
                match &trunk {
                    Some(t) if *t != fix => {
                        let (a, bh) = counts(t, &fix).unwrap_or((0, 0));
                        parent.insert(fix, (t.clone(), a, bh));
                    }
                    _ => { parent.remove(&fix); }
                }
                break;
            }
            cur = p.clone();
        }
    }

    let track_n = |track: &str, word: &str| -> u64 {
        track.split(',').map(str::trim)
            .find_map(|t| t.strip_prefix(word).and_then(|n| n.trim().parse().ok()))
            .unwrap_or(0)
    };
    let nodes: Vec<Value> = infos.iter().map(|b| {
        let (p, ahead, behind) = match parent.get(&b.name) {
            Some((p, a, bh)) => (Value::String(p.clone()), *a, *bh),
            None => (Value::Null, 0, 0),
        };
        json!({
            "name": b.name,
            "current": b.current,
            "parent": p,
            "ahead": ahead,
            "behind": behind,
            "hash": b.hash,
            "upstream": if b.upstream.is_empty() { Value::Null } else { Value::String(b.upstream.clone()) },
            "upAhead": track_n(&b.track, "ahead"),
            "upBehind": track_n(&b.track, "behind"),
            "upGone": b.track == "gone",
            "date": b.date,
            "subject": b.subject,
        })
    }).collect();

    json!({ "branches": names, "current": current, "trunk": trunk, "nodes": nodes })
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
