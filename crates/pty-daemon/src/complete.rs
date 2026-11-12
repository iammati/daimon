use daimon_complete::complete as spec_complete;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
pub struct CompletionItem {
    pub text: String,
    pub description: Option<String>,
    pub kind: String,
}

pub fn complete(buffer: &str, cwd: &str) -> Value {
    let suggestions = spec_complete(buffer, cwd);
    let items: Vec<CompletionItem> = suggestions
        .into_iter()
        .map(|s| CompletionItem {
            text: s.text,
            description: s.description,
            kind: format!("{:?}", s.kind).to_lowercase(),
        })
        .collect();
    serde_json::to_value(items).unwrap_or(Value::Array(vec![]))
}
