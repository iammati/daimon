/// Tokenize a shell buffer into words, respecting quotes.
/// Returns (words, cursor_word_index, partial_word).
pub fn tokenize(buffer: &str, cursor: usize) -> (Vec<String>, usize, String) {
    let buf = &buffer[..cursor.min(buffer.len())];
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;

    for ch in buf.chars() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"'  if !in_single => in_double = !in_double,
            ' ' | '\t' if !in_single && !in_double => {
                if !current.is_empty() {
                    words.push(current.clone());
                    current.clear();
                }
            }
            _ => current.push(ch),
        }
    }

    let partial = current.clone();
    let idx = if words.is_empty() && partial.is_empty() { 0 } else { words.len() };
    (words, idx, partial)
}
