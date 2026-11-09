import { useEffect, useState } from "react";
import { GitBranchIcon } from "lucide-react";
import { shell } from "@/lib/daimon/rpc";
import type { Block } from "@/lib/daimon/shell";

declare const __HOME__: string;
declare const __USER__: string;

function greeting(): { text: string; emoji: string } {
  const h = new Date().getHours();
  if (h < 5) return { text: "good night", emoji: "🌙" };
  if (h < 12) return { text: "good morning", emoji: "☀️" };
  if (h < 17) return { text: "good afternoon", emoji: "⛅" };
  if (h < 20) return { text: "good evening", emoji: "🌇" };
  return { text: "good evening", emoji: "🌃" };
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatCwd(raw: string): string {
  const home = __HOME__;
  if (raw === home) return "~";
  if (raw.startsWith(home + "/")) return "~" + raw.slice(home.length);
  return raw;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

type GitInfo = { branch: string; dirty: boolean; ahead: number; behind: number } | null;

type RecentDir = {
  cwd: string;
  ts: number;
  git: GitInfo;
  lastCmd: string;
};

type NeedsYouItem =
  | { kind: "failed"; cmd: string; cwd: string; code: number; ts: number }
  | { kind: "unpushed"; cwd: string; ahead: number; branch: string };

type ResumeInfo = {
  cwd: string;
  cmd: string;
  ts: number;
  sessionId: string;
};

type Props = {
  blocks: Block[];
  onResume: () => void;
  onCd: (path: string) => void;
};

export function LandingPage({ blocks, onResume, onCd }: Props) {
  const [resume, setResume] = useState<ResumeInfo | null>(null);
  const [recentDirs, setRecentDirs] = useState<RecentDir[]>([]);
  const [needsYou, setNeedsYou] = useState<NeedsYouItem[]>([]);

  const user = capitalize(__USER__ || "there");
  const { text: greetText, emoji: greetEmoji } = greeting();

  useEffect(() => {
    // If current session has blocks, show resume from it
    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1]!;
      setResume({
        cwd: "/" + last.cwd.join("/"),
        cmd: last.input,
        ts: Date.now(),
        sessionId: "",
      });
    }

    shell.blockRecent(300).then((rows) => {
      if (!rows.length) return;

      // Resume: last block across all sessions (if current session empty)
      if (blocks.length === 0 && rows[0]) {
        const r = rows[0];
        setResume({ cwd: r.cwd, cmd: r.input, ts: r.ts, sessionId: r.session_id });
      }

      // Recent dirs: unique cwds, most recently used first
      const seenCwd = new Set<string>();
      const dirs: { cwd: string; ts: number; lastCmd: string }[] = [];
      for (const r of rows) {
        if (!seenCwd.has(r.cwd) && dirs.length < 8) {
          seenCwd.add(r.cwd);
          dirs.push({ cwd: r.cwd, ts: r.ts, lastCmd: r.input });
        }
      }

      // Needs you: failed commands (exit != 0) in the last 24h
      const cutoff = Date.now() - 86400000;
      const failed: NeedsYouItem[] = rows
        .filter(r => r.exit_code !== 0 && r.ts > cutoff)
        .slice(0, 5)
        .map(r => ({ kind: "failed" as const, cmd: r.input, cwd: r.cwd, code: r.exit_code, ts: r.ts }));
      setNeedsYou(failed);

      // Fetch git info for each unique cwd
      Promise.all(
        dirs.map(async (d) => {
          try {
            const s = await shell.gitStatus(d.cwd);
            const dirty = s.staged.length > 0 || s.unstaged.length > 0 || s.untracked.length > 0;
            const git: GitInfo = { branch: s.branch, dirty, ahead: s.ahead, behind: s.behind };
            // Add unpushed to needs-you
            if (s.ahead > 0) {
              setNeedsYou(prev => {
                if (prev.some(x => x.kind === "unpushed" && x.cwd === d.cwd)) return prev;
                return [...prev, { kind: "unpushed" as const, cwd: d.cwd, ahead: s.ahead, branch: s.branch }];
              });
            }
            return { ...d, git };
          } catch {
            return { ...d, git: null };
          }
        })
      ).then(setRecentDirs);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="max-w-2xl space-y-10 py-2">
      {/* Greeting */}
      <div>
        <h1 className="font-mono text-[22px] font-normal text-foreground/80 tracking-tight">
          <span className="mr-2">{greetEmoji}</span>
          {greetText},{" "}
          <span className="font-semibold text-foreground">{user}</span>
        </h1>
      </div>

      {/* Resume */}
      {resume && (
        <div>
          <p className="mb-3 font-mono text-[10px] text-muted-foreground/50 tracking-widest uppercase">Resume</p>
          <button
            onClick={onResume}
            className="group flex w-full items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3.5 text-left transition-colors hover:border-signal/40 hover:bg-card"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-mono text-[11px] text-signal shrink-0">↩</span>
              <span className="font-mono text-[12px] text-foreground truncate">{formatCwd(resume.cwd)}</span>
              <span className="text-muted-foreground/40 text-[11px] shrink-0">·</span>
              <span className="font-mono text-[11px] text-muted-foreground truncate max-w-[200px]">{resume.cmd}</span>
            </div>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50">{timeAgo(resume.ts)}</span>
          </button>
        </div>
      )}

      {/* Recent dirs */}
      {recentDirs.length > 0 && (
        <div>
          <p className="mb-3 font-mono text-[10px] text-muted-foreground/50 tracking-widest uppercase">Recent</p>
          <ul className="space-y-px">
            {recentDirs.map((d, i) => (
              <li key={d.cwd}>
                <button
                  onClick={() => onCd(d.cwd)}
                  className="group flex w-full items-center gap-4 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-secondary/40"
                >
                  <span className="w-5 shrink-0 rounded bg-secondary px-1.5 py-0.5 text-center font-mono text-[10px] text-muted-foreground">{i + 1}</span>
                  <span className="flex-1 truncate font-mono text-[13px] text-foreground">{formatCwd(d.cwd)}</span>
                  {d.git && (
                    <span className="flex items-center gap-1.5 shrink-0">
                      <GitBranchIcon className="size-3 text-muted-foreground/50" />
                      <span className="font-mono text-[11px] text-purple-400/80">{d.git.branch}</span>
                      {d.git.dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="uncommitted changes" />}
                      {d.git.ahead > 0 && <span className="font-mono text-[10px] text-emerald-400">↑{d.git.ahead}</span>}
                      {d.git.behind > 0 && <span className="font-mono text-[10px] text-rose-400">↓{d.git.behind}</span>}
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50 w-16 text-right">
                    {timeAgo(d.ts)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Needs you */}
      {needsYou.length > 0 && (
        <div>
          <p className="mb-3 font-mono text-[10px] text-muted-foreground/50 tracking-widest uppercase">Needs You</p>
          <ul className="space-y-px">
            {needsYou.map((item, i) => (
              <li key={i}>
                {item.kind === "failed" ? (
                  <button
                    onClick={() => onCd(item.cwd)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-secondary/40"
                  >
                    <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 font-mono text-[10px] text-rose-400">exit {item.code}</span>
                    <span className="flex-1 truncate font-mono text-[12px] text-foreground">{item.cmd}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50">{formatCwd(item.cwd)}</span>
                  </button>
                ) : (
                  <button
                    onClick={() => onCd(item.cwd)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-secondary/40"
                  >
                    <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-400">↑{item.ahead} unpushed</span>
                    <span className="flex-1 truncate font-mono text-[12px] text-foreground">{item.branch}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50">{formatCwd(item.cwd)}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Keys */}
      <div>
        <p className="mb-3 font-mono text-[10px] text-muted-foreground/50 tracking-widest uppercase">Keys</p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-[11px] sm:grid-cols-3">
          {[
            ["Tab", "complete"],
            ["↑ ↓", "history"],
            ["⌘K", "clear"],
            ["⌘F", "search"],
            ["⌘C", "copy / cancel"],
            ["⌘T", "new session"],
            ["⌘B", "toggle sidebar"],
          ].map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">{v}</dt>
              <dd className="rounded bg-secondary px-1.5 py-0.5 text-[10px]">{k}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
