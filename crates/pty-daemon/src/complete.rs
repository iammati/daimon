/// Completion engine — stubbed until ghost-complete is available as a published crate.
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
pub struct CompletionItem {
    pub text: String,
    pub description: Option<String>,
    pub kind: &'static str,
}

pub fn complete(_buffer: &str, _cwd: &str) -> Value {
    Value::Array(vec![])
}
