//! Open Graph link previews for URLs found in command output.
//!
//! The webview can't read other origins (CORS), so the daemon fetches the page with `curl`
//! (same approach as `git`: a subprocess, no HTTP stack compiled in), reads at most
//! `MAX_BYTES` of it and pulls the `og:` / `twitter:` / `<title>` tags out of the head.
//! Results — including misses — are cached for the daemon's lifetime.

use regex_lite::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

const MAX_BYTES: usize = 512 * 1024;
const CACHE_CAP: usize = 512;

fn cache() -> &'static Mutex<HashMap<String, Value>> {
    static C: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Preview for `url`, or `null` when the page has nothing worth showing (or can't be fetched).
pub fn link_preview(url: &str) -> Value {
    if let Some(v) = cache().lock().unwrap().get(url) {
        return v.clone();
    }
    let v = if allowed(url) { fetch(url).map(|html| parse(url, &html)).unwrap_or(Value::Null) } else { Value::Null };
    let mut c = cache().lock().unwrap();
    if c.len() >= CACHE_CAP {
        c.clear();
    }
    c.insert(url.to_string(), v.clone());
    v
}

/// Public http(s) URLs only: no credentials, no loopback / private / link-local / bare hosts.
/// Output often mentions dev servers and internal endpoints; those are never fetched.
fn allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') || authority.starts_with('[') {
        return false; // userinfo, or an IPv6 literal
    }
    let host = authority.split(':').next().unwrap_or("").to_ascii_lowercase();
    if host.is_empty() || !host.contains('.') {
        return false;
    }
    if [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".test", ".invalid"]
        .iter()
        .any(|s| host.ends_with(s))
    {
        return false;
    }
    let octets: Vec<u8> = host.split('.').filter_map(|p| p.parse().ok()).collect();
    if octets.len() == 4 && host.split('.').count() == 4 {
        return !matches!(
            octets[..],
            [0, ..] | [10, ..] | [127, ..] | [169, 254, ..] | [192, 168, ..] | [100, 64..=127, ..]
        ) && !(octets[0] == 172 && (16..=31).contains(&octets[1]));
    }
    true
}

fn fetch(url: &str) -> Option<String> {
    let mut child = Command::new("curl")
        .args([
            "-sSL",
            "--compressed",
            "--max-time", "6",
            "--max-redirs", "5",
            "--proto", "=http,https",
            "--proto-redir", "=http,https",
            "-A", "Mozilla/5.0 (compatible; daimon-link-preview)",
            "-H", "Accept: text/html,application/xhtml+xml",
            "--",
            url,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut buf = Vec::with_capacity(64 * 1024);
    let _ = child.stdout.take()?.take(MAX_BYTES as u64).read_to_end(&mut buf);
    let _ = child.kill();
    let _ = child.wait();
    // The tags we want live in <head>; stop there so a huge body isn't scanned.
    let text = String::from_utf8_lossy(&buf);
    let end = text.find("</head>").or_else(|| text.find("</HEAD>")).unwrap_or(text.len());
    Some(text[..end].to_string())
}

fn re(pat: &str) -> Regex {
    Regex::new(pat).expect("static regex")
}

fn attrs(tag: &str) -> HashMap<String, String> {
    static ATTR: OnceLock<Regex> = OnceLock::new();
    let attr = ATTR.get_or_init(|| re(r#"([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#));
    attr.captures_iter(tag)
        .map(|c| {
            let v = c.get(2).or(c.get(3)).or(c.get(4)).map(|m| m.as_str()).unwrap_or("");
            (c[1].to_ascii_lowercase(), decode_entities(v))
        })
        .collect()
}

fn parse(url: &str, html: &str) -> Value {
    static META: OnceLock<Regex> = OnceLock::new();
    static LINK: OnceLock<Regex> = OnceLock::new();
    static TITLE: OnceLock<Regex> = OnceLock::new();
    let meta_re = META.get_or_init(|| re(r"(?is)<meta\b[^>]*>"));
    let link_re = LINK.get_or_init(|| re(r"(?is)<link\b[^>]*>"));
    let title_re = TITLE.get_or_init(|| re(r"(?is)<title\b[^>]*>(.*?)</title>"));

    let mut meta: HashMap<String, String> = HashMap::new();
    for m in meta_re.find_iter(html) {
        let a = attrs(m.as_str());
        let key = a.get("property").or_else(|| a.get("name")).map(|k| k.to_ascii_lowercase());
        if let (Some(k), Some(v)) = (key, a.get("content")) {
            let v = v.trim();
            if !v.is_empty() {
                meta.entry(k).or_insert_with(|| v.to_string());
            }
        }
    }
    let get = |keys: &[&str]| keys.iter().find_map(|k| meta.get(*k).cloned());

    let title = get(&["og:title", "twitter:title"])
        .or_else(|| title_re.captures(html).map(|c| decode_entities(c[1].trim())))
        .filter(|t| !t.is_empty());
    let description = get(&["og:description", "twitter:description", "description"]);
    let image = get(&["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"])
        .map(|i| resolve(url, &i));
    let site_name = get(&["og:site_name", "application-name"]);

    let mut icon = None;
    for m in link_re.find_iter(html) {
        let a = attrs(m.as_str());
        let rel = a.get("rel").map(|r| r.to_ascii_lowercase()).unwrap_or_default();
        if rel.split_whitespace().any(|r| r == "icon") || rel.contains("apple-touch-icon") {
            if let Some(h) = a.get("href") {
                icon = Some(resolve(url, h));
                if rel.split_whitespace().any(|r| r == "icon") {
                    break; // prefer a plain icon over the touch icon
                }
            }
        }
    }
    let icon = icon.unwrap_or_else(|| resolve(url, "/favicon.ico"));

    if title.is_none() && description.is_none() && image.is_none() {
        return Value::Null;
    }
    json!({
        "url": url,
        "title": title.map(|t| clip(&t, 200)),
        "description": description.map(|d| clip(&d, 300)),
        "image": image,
        "siteName": site_name.map(|s| clip(&s, 80)),
        "icon": icon,
    })
}

fn clip(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n { s } else { format!("{}…", s.chars().take(n).collect::<String>().trim_end()) }
}

/// Resolve `href` against the page `base` (enough for og:image / icon hrefs).
fn resolve(base: &str, href: &str) -> String {
    let href = href.trim();
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    let scheme = if base.starts_with("https://") { "https:" } else { "http:" };
    if let Some(rest) = href.strip_prefix("//") {
        return format!("{scheme}//{rest}");
    }
    let after = &base[scheme.len() + 2..];
    let host_end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let origin = &base[..scheme.len() + 2 + host_end];
    if href.starts_with('/') {
        return format!("{origin}{href}");
    }
    let path = after[host_end..].split(['?', '#']).next().unwrap_or("");
    let dir = &path[..path.rfind('/').map(|i| i + 1).unwrap_or(0)];
    let dir = if dir.is_empty() { "/" } else { dir };
    format!("{origin}{dir}{href}")
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(semi) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let ent = &rest[1..semi];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ if ent.starts_with("#x") || ent.starts_with("#X") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
            _ if ent.starts_with('#') => ent[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => { out.push(c); rest = &rest[semi + 1..]; }
            None => { out.push('&'); rest = &rest[1..]; }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_hosts() {
        assert!(allowed("https://github.com/iammati/daimon.git"));
        assert!(!allowed("http://localhost:3000"));
        assert!(!allowed("http://127.0.0.1/x"));
        assert!(!allowed("http://192.168.1.5"));
        assert!(!allowed("http://172.20.0.1"));
        assert!(!allowed("https://user:pw@example.com"));
        assert!(!allowed("http://[::1]/"));
        assert!(!allowed("http://foo.internal/"));
        assert!(!allowed("ftp://example.com"));
    }

    #[test]
    fn parses_og_tags() {
        let html = r#"<html><head><title>Fallback</title>
            <meta property="og:title" content="iammati/daimon" />
            <meta name="description" content="A &amp; B">
            <meta property='og:image' content='/img/card.png'>
            <link rel="icon" href="fav.svg"></head>"#;
        let v = parse("https://example.com/a/b", html);
        assert_eq!(v["title"], "iammati/daimon");
        assert_eq!(v["description"], "A & B");
        assert_eq!(v["image"], "https://example.com/img/card.png");
        assert_eq!(v["icon"], "https://example.com/a/fav.svg");
    }

    #[test]
    fn empty_page_is_null() {
        assert!(parse("https://example.com", "<html><head></head>").is_null());
    }
}
