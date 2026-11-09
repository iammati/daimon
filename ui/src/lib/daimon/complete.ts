import { shell } from "./rpc";

export type SuggestionKind = "command" | "subcommand" | "flag" | "file" | "dir" | "git_branch" | "git_tag" | "git_remote" | "history" | "env_var" | "arg";
export type Suggestion = {
  value: string;
  label: string;
  hint: string;
  kind: SuggestionKind;
  score: number;
  replace: "token" | "all";
  ts?: number;
};

/** Current token at cursor — everything after the last unquoted space. */
function currentToken(input: string): string {
  const trailing = /\s$/.test(input);
  if (trailing) return "";
  const parts = input.split(/\s+/);
  return parts[parts.length - 1] ?? "";
}

/**
 * Native completion via gc-suggest Rust engine.
 * Returns ranked suggestions for the full buffer at the cursor.
 */
export async function completeNative(
  input: string,
  cwd: string,
  history: string[] = [],
  historyTs: number[] = [],
): Promise<{ items: Suggestion[]; token: string }> {
  const token = currentToken(input);

  // History: prefix-match on whole input, always available instantly.
  const histItems: Suggestion[] = [];
  if (input.trim()) {
    const lower = input.toLowerCase();
    const trailingSpace = /\s$/.test(input);
    const seen = new Set<string>();
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i]!;
      if (h === input || seen.has(h)) continue;
      if (!h.toLowerCase().startsWith(lower) || h.length <= input.length) continue;
      // Only suggest when input ends with space (new arg) OR history extends the current token
      // (next char is not a space — e.g. "ls -la" → "ls -lah ..." but NOT "ls -la logs").
      const nextChar = h[input.length];
      if (!trailingSpace && nextChar === " ") continue;
      seen.add(h);
      histItems.push({ value: h, label: h, hint: "history", kind: "history", score: 10, replace: "all", ...(historyTs[i] !== undefined ? { ts: historyTs[i] } : {}) });
      if (histItems.length >= 5) break;
    }
  }

  const raw = await shell.completeNative(input, cwd).catch(() => []);
  const items: Suggestion[] = raw.map((s, i) => ({
    value: s.text,
    label: s.text,
    hint: s.description ?? kindHint(s.kind),
    kind: s.kind as SuggestionKind,
    score: raw.length - i, // preserve engine rank order
    replace: "token" as const,
  }));

  // Drop engine results that don't start with the token (fuzzy engine returns substring/arbitrary matches)
  const filtered = token
    ? items.filter(s => s.value.toLowerCase().startsWith(token.toLowerCase()))
    : items;

  // Promote exact token match to top
  if (token) {
    const ltoken = token.toLowerCase();
    filtered.sort((a, b) => {
      const ae = a.value.toLowerCase() === ltoken ? 0 : 1;
      const be = b.value.toLowerCase() === ltoken ? 0 : 1;
      if (ae !== be) return ae - be;
      return 0;
    });
  }

  const result = filtered;

  // Merge: native first, history appended (deduped)
  const seen = new Set(result.map((s) => s.value));
  for (const h of histItems) {
    if (!seen.has(h.value)) result.push(h);
  }

  return { items: result, token };
}

function kindHint(kind: string): string {
  switch (kind) {
    case "file": return "file";
    case "dir": return "dir";
    case "git_branch": return "branch";
    case "git_tag": return "tag";
    case "git_remote": return "remote";
    case "env_var": return "env";
    case "flag": return "flag";
    default: return "";
  }
}

export function applySuggestion(input: string, token: string, value: string, s: Suggestion) {
  if (s.replace === "all") return value;
  const head = token ? input.slice(0, input.length - token.length) : input;
  const needsQuote = /[\s'"\\]/.test(value);
  const safe = needsQuote ? `'${value.replace(/'/g, "'\\''")}'` : value;
  if ((s.kind === "file" || s.kind === "dir") && value.startsWith("-") && !head.includes(" -- ")) {
    return head + "-- " + safe;
  }
  return head + safe;
}
