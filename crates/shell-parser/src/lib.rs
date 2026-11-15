/// Pure PTY output parsing — no I/O, fully unit-testable.

/// Strip ANSI escape sequences from raw PTY output.
pub fn strip_ansi(s: &str) -> String {
    // Remove CSI sequences: ESC [ ... letter
    let re_csi = regex_lite::Regex::new(r"\x1b\[[0-9;?]*[a-zA-Z]").unwrap();
    // Remove OSC sequences: ESC ] ... BEL or ST
    let re_osc = regex_lite::Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)").unwrap();
    let s = re_csi.replace_all(s, "");
    let s = re_osc.replace_all(&s, "");
    s.replace('\r', "")
}

/// Strip PTY mode-set sequences that must not reach the frontend xterm.
/// Preserved: cursor visibility, mouse reporting, alt-screen, focus events.
pub fn strip_pty_modes(s: &str) -> String {
    let re = regex_lite::Regex::new(r"\x1b\[\?[0-9;]*[hlsur]").unwrap();
    re.replace_all(s, |caps: &regex_lite::Captures| {
        let m = caps.get(0).unwrap().as_str();
        // Extract the numeric code(s) — everything between '?' and the final letter
        let code_str = &m[3..m.len()-1];
        let preserve = code_str.split(';').any(|c| matches!(c,
            // Cursor show/hide
            "25" |
            // Alt-screen
            "1049" | "47" | "1047" |
            // Mouse reporting modes
            "1000" | "1001" | "1002" | "1003" |
            // Mouse coordinate encoding
            "1005" | "1006" | "1015" |
            // Focus in/out events
            "1004" |
            // Bracketed paste (xterm handles this)
            "2004"
        ));
        if preserve { m.to_string() } else { String::new() }
    }).into_owned()
}

/// Detect alt-screen enter sequence (vim, nano, htop).
pub fn is_alt_screen_enter(s: &str) -> bool {
    s.contains("\x1b[?1049h")
}

/// Detect alt-screen exit sequence.
pub fn is_alt_screen_exit(s: &str) -> bool {
    s.contains("\x1b[?1049l")
}

/// Detect OSC 133;A prompt start — shell is ready for input.
pub fn is_prompt_marker(s: &str) -> bool {
    s.contains("\x1b]133;A")
}

/// Detect OSC 133;C preexec — command is about to run.
pub fn is_command_start_marker(s: &str) -> bool {
    s.contains("\x1b]133;C")
}

/// Commands that stream interactively in daimon's block view.
/// These own their PTY session for the lifetime of the command.
pub fn is_streaming_interactive(cmd: &str) -> bool {
    let cmd = cmd.trim();
    matches_prefix(cmd, &[
        "ssh ", "ssh\t",
        "mosh ", "mosh\t",
        "telnet ", "telnet\t",
        "nc ", "nc\t",
        "ncat ", "ncat\t",
    ])
}

/// Commands that trigger xterm panel (alt-screen TUI).
pub fn is_tui_command(cmd: &str) -> bool {
    let cmd = cmd.trim();
    matches_prefix(cmd, &[
        "vim", "vi ", "vi\t",
        "nano ", "nano\t",
        "htop", "top",
        "less ", "less\t",
        "man ",
    ])
}

/// Strip OSC 133 shell integration sequences (command boundary markers).
/// These are emitted by daimon's zsh integration and must not appear in rendered output.
pub fn strip_osc133(s: &str) -> String {
    let re = regex_lite::Regex::new(r"\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\)").unwrap();
    re.replace_all(s, "").into_owned()
}

/// Convert OSC 8 hyperlinks to [OSC8:URL:TEXT] markers for frontend rendering.
/// ESC]8;;URL ST text ESC]8;; ST → [OSC8:URL:TEXT]
pub fn convert_osc8(s: &str) -> String {
    // Match: ESC]8;params;url(BEL|ST) ... text ... ESC]8;;(BEL|ST)
    let re = regex_lite::Regex::new(
        r"\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)(.*?)\x1b\]8;;(?:\x07|\x1b\\)"
    ).unwrap();
    re.replace_all(s, |caps: &regex_lite::Captures| {
        let url = caps.get(1).map_or("", |m| m.as_str());
        let text = caps.get(2).map_or("", |m| m.as_str());
        if url.is_empty() {
            text.to_string()
        } else {
            format!("[OSC8:{}:{}]", url, text)
        }
    }).into_owned()
}

fn matches_prefix(cmd: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|p| cmd.starts_with(p) || cmd == p.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_color_codes() {
        assert_eq!(strip_ansi("\x1b[32mhello\x1b[0m"), "hello");
    }

    #[test]
    fn strip_ansi_removes_cursor_movement() {
        assert_eq!(strip_ansi("\x1b[2Khello"), "hello");
    }

    #[test]
    fn strip_ansi_removes_osc() {
        assert_eq!(strip_ansi("\x1b]0;title\x07hello"), "hello");
    }

    #[test]
    fn strip_pty_modes_removes_cursor_keys_mode() {
        // ?1h = cursor keys application mode — not in preserve list, gets stripped
        assert_eq!(strip_pty_modes("\x1b[?1hhello"), "hello");
    }

    #[test]
    fn strip_pty_modes_preserves_bracketed_paste() {
        assert_eq!(strip_pty_modes("\x1b[?2004hhello\x1b[?2004l"), "\x1b[?2004hhello\x1b[?2004l");
    }

    #[test]
    fn strip_pty_modes_preserves_mouse_reporting() {
        assert_eq!(strip_pty_modes("\x1b[?1000h"), "\x1b[?1000h");
        assert_eq!(strip_pty_modes("\x1b[?1002h"), "\x1b[?1002h");
        assert_eq!(strip_pty_modes("\x1b[?1006h"), "\x1b[?1006h");
    }

    #[test]
    fn strip_pty_modes_preserves_cursor_visibility() {
        assert_eq!(strip_pty_modes("\x1b[?25lhello\x1b[?25h"), "\x1b[?25lhello\x1b[?25h");
    }

    #[test]
    fn alt_screen_detection() {
        assert!(is_alt_screen_enter("\x1b[?1049h"));
        assert!(is_alt_screen_exit("\x1b[?1049l"));
        assert!(!is_alt_screen_enter("hello"));
    }

    #[test]
    fn prompt_marker_detection() {
        assert!(is_prompt_marker("\x1b]133;Asome context json\x07"));
        assert!(!is_prompt_marker("$ "));
    }

    #[test]
    fn streaming_interactive_commands() {
        assert!(is_streaming_interactive("ssh nous"));
        assert!(is_streaming_interactive("mosh user@host"));
        assert!(is_streaming_interactive("nc localhost 8080"));
        assert!(!is_streaming_interactive("ls -la"));
        assert!(!is_streaming_interactive("git status"));
    }

    #[test]
    fn tui_commands() {
        assert!(is_tui_command("vim file.txt"));
        assert!(is_tui_command("nano"));
        assert!(is_tui_command("htop"));
        assert!(!is_tui_command("ssh nous"));
        assert!(!is_tui_command("ls"));
    }

    #[test]
    fn osc8_hyperlinks_converted() {
        // BEL terminator
        assert_eq!(
            convert_osc8("\x1b]8;;https://example.com\x07click here\x1b]8;;\x07"),
            "[OSC8:https://example.com:click here]"
        );
        // ST terminator
        assert_eq!(
            convert_osc8("\x1b]8;;https://example.com\x1b\\click here\x1b]8;;\x1b\\"),
            "[OSC8:https://example.com:click here]"
        );
        // Empty URL → strip both markers, keep text
        assert_eq!(
            convert_osc8("\x1b]8;;\x07plain\x1b]8;;\x07"),
            "plain"
        );
        // No OSC8 → unchanged
        assert_eq!(convert_osc8("hello world"), "hello world");
    }
}
