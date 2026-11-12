use serde::{Deserialize, Serialize};

/// A single CLI tool spec.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spec {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub subcommands: Vec<Subcommand>,
    #[serde(default)]
    pub flags: Vec<Flag>,
    #[serde(default)]
    pub args: Vec<Arg>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subcommand {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub subcommands: Vec<Subcommand>,
    #[serde(default)]
    pub flags: Vec<Flag>,
    #[serde(default)]
    pub args: Vec<Arg>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Flag {
    pub name: String,
    #[serde(default)]
    pub short: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// If present, the flag takes a value of this kind.
    #[serde(default)]
    pub arg: Option<ArgKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Arg {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(flatten)]
    pub kind: ArgKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArgKind {
    /// Freeform string, no completion.
    String,
    /// File path completion.
    File,
    /// Directory path completion.
    Dir,
    /// Fixed set of choices.
    Choice { choices: Vec<String> },
    /// Git branch names.
    GitBranch,
    /// Git tag names.
    GitTag,
    /// Git remote names.
    GitRemote,
    /// Any remaining args (variadic).
    Rest,
}

impl Default for ArgKind {
    fn default() -> Self { Self::String }
}
