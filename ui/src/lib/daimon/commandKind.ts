// What kind of program a command line runs (git, kubernetes, an editor, …), so the UI can show a
// matching icon — like Warp's tab icons, but read from the command line we send, not the process.

export type CommandKind =
  | "claude" | "gemini" | "codex" | "git" | "github" | "kubernetes" | "openstack" | "docker" | "ssh" | "editor" | "node"
  | "rust" | "python" | "monitor" | "terraform" | "build" | "http" | "database";

const PROGRAMS: Record<CommandKind, string[]> = {
  claude: ["claude"],
  gemini: ["gemini"],
  codex: ["codex"],
  git: ["git", "lazygit", "tig", "gitui"],
  github: ["gh"],
  kubernetes: ["kubectl", "k9s", "helm", "helmfile", "kubectx", "kubens", "minikube", "kind", "k3d", "stern", "kustomize", "u8s"],
  openstack: ["openstack", "nova", "neutron", "glance", "cinder", "heat", "swift", "keystone"],
  docker: ["docker", "docker-compose", "podman", "lazydocker", "nerdctl"],
  ssh: ["ssh", "mosh", "sftp", "scp", "telnet"],
  editor: ["vim", "nvim", "vi", "nano", "emacs", "hx", "micro", "code"],
  node: ["node", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "deno"],
  rust: ["cargo", "rustc", "rustup"],
  python: ["python", "python3", "pip", "pip3", "uv", "uvx", "poetry", "pytest", "ipython"],
  monitor: ["htop", "top", "btop", "glances"],
  terraform: ["terraform", "tofu", "terragrunt", "pulumi"],
  build: ["make", "cmake", "ninja", "just", "gradle", "mvn"],
  http: ["curl", "wget", "http", "https", "xh"],
  database: ["psql", "mysql", "sqlite3", "redis-cli", "mongosh", "pgcli", "usql"],
};

const BY_PROGRAM = new Map<string, CommandKind>(
  (Object.entries(PROGRAMS) as [CommandKind, string[]][]).flatMap(([kind, names]) => names.map((n) => [n, kind] as const)),
);

// Words that only run the next word: look past them.
const WRAPPERS = new Set(["sudo", "doas", "env", "time", "nice", "nohup", "exec", "command", "builtin", "noglob", "caffeinate", "watch", "timeout"]);

/** The first program in `segment` that isn't a wrapper or an environment assignment. */
function programOf(segment: string): string | null {
  for (const word of segment.trim().split(/\s+/)) {
    if (!word || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;   // FOO=bar cmd
    if (word.startsWith("-") || /^\d+[smh]?$/.test(word)) continue;   // a wrapper's flag or its value: watch -n 1 cmd
    const name = word.replace(/^["']|["']$/g, "").split("/").pop()!;  // /usr/bin/git → git
    if (WRAPPERS.has(name)) continue;
    return name;
  }
  return null;
}

/**
 * The kind of a command line, or null for anything unrecognised. Matched by program name only:
 * shell aliases are deliberately not resolved. In a compound line
 * ("cd app && k9s") the first part that is recognised wins, so `cd` doesn't hide `k9s`.
 */
export function commandKind(cmd: string): CommandKind | null {
  for (const segment of cmd.split(/&&|\|\||[;|]/)) {
    const prog = programOf(segment);
    const kind = prog ? BY_PROGRAM.get(prog) : undefined;
    if (kind) return kind;
  }
  return null;
}
