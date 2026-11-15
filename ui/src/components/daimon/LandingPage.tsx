import { useEffect, useRef, useState } from "react";
import {
  GitBranchIcon,
  CornerDownLeftIcon,
  TabletSmartphoneIcon,
  ArrowUpDownIcon,
  SearchIcon,
  XCircleIcon,
  PlusSquareIcon,
  PanelLeftIcon,
  CommandIcon,
  SplitSquareHorizontalIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ServerIcon,
  FolderIcon,
} from "lucide-react";
import { shell } from "@/lib/daimon/rpc";
import type { Block } from "@/lib/daimon/shell";

declare const __HOME__: string;

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up.";
  if (h < 12) return "Good morning.";
  if (h < 17) return "Good afternoon.";
  return "Good evening.";
}

function formatCwd(raw: string): string {
  const home = __HOME__;
  if (raw === home) return "~";
  if (raw.startsWith(home + "/")) return "~" + raw.slice(home.length);
  return raw;
}

// Split path into directory part + final segment for typographic emphasis
function splitPath(formatted: string): { dir: string; name: string } {
  const idx = formatted.lastIndexOf("/");
  if (idx <= 0) return { dir: "", name: formatted };
  return { dir: formatted.slice(0, idx + 1), name: formatted.slice(idx + 1) };
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function exitReason(code: number, cmd: string): string {
  if (code === 127) return "Command not found";
  if (code === 1) {
    if (cmd.startsWith("cd ")) return "No such directory";
    if (cmd.includes("rm ") || cmd.includes("mv ")) return "No such file";
    return "Exited with 1";
  }
  if (code === 2) return "Incorrect usage";
  if (code === 126) return "Permission denied";
  if (code === 130) return "Interrupted";
  return `Exited with ${code}`;
}

type GitInfo = { branch: string; dirty: boolean; ahead: number; behind: number } | null;
type RecentDir = { cwd: string; ts: number; git: GitInfo };
type FailedItem = { cmd: string; cwd: string; code: number; ts: number };
type ResumeInfo = { cwd: string; cmd: string; ts: number; git: GitInfo };

type Props = {
  blocks: Block[];
  history?: string[];
  onResume: () => void;
  onCd: (path: string) => void;
  onRun?: (cmd: string) => void;
  onOpenPalette?: () => void;
};

/** Extract unique SSH hostnames from history, most-recent first, up to 5. */
function sshHosts(history: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < 5; i--) {
    const cmd = history[i]!.trim();
    if (!/^ssh\s+/.test(cmd)) continue;
    const tokens = cmd.split(/\s+/).slice(1); // drop "ssh"
    let host = "";
    for (let j = 0; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.startsWith("-")) { if (t === "-p" || t === "-i" || t === "-l") j++; continue; }
      host = t;
    }
    if (!host) continue;
    // strip user@ prefix
    const at = host.indexOf("@");
    if (at !== -1) host = host.slice(at + 1);
    if (host && !seen.has(host)) { seen.add(host); out.push(host); }
  }
  return out;
}

const SHORTCUTS: { key: string; label: string; Icon: React.FC<{ className?: string }> }[] = [
  { key: "Tab",  label: "Complete",    Icon: TabletSmartphoneIcon },
  { key: "↑ ↓", label: "History",     Icon: ArrowUpDownIcon },
  { key: "⌘K",  label: "Clear",       Icon: XCircleIcon },
  { key: "⌘F",  label: "Search",      Icon: SearchIcon },
  { key: "⌘T",  label: "New session", Icon: PlusSquareIcon },
  { key: "⌘D",  label: "Split pane",  Icon: SplitSquareHorizontalIcon },
  { key: "⌘B",  label: "Sidebar",     Icon: PanelLeftIcon },
  { key: "⌘P",  label: "Commands",    Icon: CommandIcon },
];

export function LandingPage({ blocks, history = [], onResume, onCd, onRun, onOpenPalette }: Props) {
  const [resume, setResume] = useState<ResumeInfo | null>(null);
  const [recentDirs, setRecentDirs] = useState<RecentDir[]>([]);
  const [failed, setFailed] = useState<FailedItem[]>([]);
  const [showKeys, setShowKeys] = useState(false);
  const keysRef = useRef<HTMLDivElement>(null);

  const greet = greeting();

  useEffect(() => {
    shell.blockRecent(300).then((rows) => {
      if (!rows.length) return;

      // Hero: derive from most recent block's cwd
      const heroRow = blocks.length > 0
        ? { cwd: "/" + blocks[blocks.length - 1]!.cwd.join("/"), ts: Date.now() }
        : rows[0]!;

      // Fetch git for hero cwd
      shell.gitStatus(heroRow.cwd).then((s) => {
        const dirty = s.staged.length > 0 || s.unstaged.length > 0 || s.untracked.length > 0;
        setResume({
          cwd: heroRow.cwd,
          cmd: blocks.length > 0 ? blocks[blocks.length - 1]!.input : rows[0]?.input ?? "",
          ts: heroRow.ts,
          git: { branch: s.branch, dirty, ahead: s.ahead, behind: s.behind },
        });
      }).catch(() => {
        setResume({ cwd: heroRow.cwd, cmd: rows[0]?.input ?? "", ts: heroRow.ts, git: null });
      });

      // Recent dirs
      const seenCwd = new Set<string>();
      const dirs: { cwd: string; ts: number }[] = [];
      for (const r of rows) {
        if (!seenCwd.has(r.cwd) && dirs.length < 6) {
          seenCwd.add(r.cwd);
          dirs.push({ cwd: r.cwd, ts: r.ts });
        }
      }

      // Failed commands (last 24h)
      const cutoff = Date.now() - 86400000;
      setFailed(
        rows
          .filter(r => r.exit_code !== 0 && r.ts > cutoff)
          .slice(0, 6)
          .map(r => ({ cmd: r.input, cwd: r.cwd, code: r.exit_code, ts: r.ts }))
      );

      // Git info for each recent dir
      Promise.all(
        dirs.map(async (d) => {
          try {
            const s = await shell.gitStatus(d.cwd);
            const dirty = s.staged.length > 0 || s.unstaged.length > 0 || s.untracked.length > 0;
            return { ...d, git: { branch: s.branch, dirty, ahead: s.ahead, behind: s.behind } as GitInfo };
          } catch { return { ...d, git: null }; }
        })
      ).then(setRecentDirs);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleKeys = () => {
    setShowKeys(v => {
      if (!v) setTimeout(() => keysRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
      return !v;
    });
  };

  useEffect(() => {
    const handler = () => {
      setShowKeys(true);
      setTimeout(() => keysRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
    };
    window.addEventListener("show-keys", handler);
    return () => window.removeEventListener("show-keys", handler);
  }, []);

  const heroCwd = resume ? splitPath(formatCwd(resume.cwd)) : null;
  const sshHostList = sshHosts(history);
  const recentDirList = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = blocks.length - 1; i >= 0 && out.length < 5; i--) {
      const cwd = "/" + blocks[i]!.cwd.join("/");
      if (!seen.has(cwd)) { seen.add(cwd); out.push(cwd); }
    }
    return out;
  })();

  return (
    <section className="w-full px-8 py-10 max-w-5xl">

      {/* ── Hero ── */}
      <div className="mb-14">
        <p className="mb-4 font-sans text-[14px] text-muted-foreground/80">
          {greet} You are in
        </p>

        {heroCwd ? (
          <div className="mb-6">
            <div className="font-mono text-[42px] font-normal leading-none tracking-tight text-foreground/40 break-all">
              {heroCwd.dir}
              <span className="text-foreground">{heroCwd.name}</span>
            </div>

            {resume?.git && (
              <div className="mt-3 flex items-center gap-3">
                <GitBranchIcon className="size-3.5 text-muted-foreground/60" />
                <span className="font-mono text-[13px] text-muted-foreground/85">{resume.git.branch}</span>
                {resume.git.dirty && (
                  <span className="flex items-center gap-1 font-sans text-[12px] text-amber-400/80">
                    <CircleDotIcon className="size-3" />
                    uncommitted changes
                  </span>
                )}
                {resume.git.ahead > 0 && (
                  <span className="flex items-center gap-1 font-mono text-[12px] text-emerald-400/80">
                    <ArrowUpIcon className="size-3" />
                    {resume.git.ahead} ahead
                  </span>
                )}
                {resume.git.behind > 0 && (
                  <span className="flex items-center gap-1 font-mono text-[12px] text-rose-400/80">
                    <ArrowDownIcon className="size-3" />
                    {resume.git.behind} behind
                  </span>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="font-mono text-[42px] text-muted-foreground/20 leading-none">~</div>
        )}

        <button
          onClick={onResume}
          className="flex items-center gap-2 border border-border bg-card px-4 py-2.5 font-sans text-[13px] text-foreground transition-colors hover:border-signal/50 hover:bg-accent"
        >
          <CornerDownLeftIcon className="size-3.5 text-signal" />
          Open here
        </button>
      </div>

      {/* ── SSH Hosts + Recent Dirs quick-access ── */}
      {(sshHostList.length > 0 || recentDirList.length > 0) && (
        <div className="mb-10 grid grid-cols-2 gap-0 border-t border-border pt-8">

          {/* SSH Hosts */}
          <div className="pr-8">
            {sshHostList.length > 0 && (
              <>
                <h2 className="mb-4 font-sans text-[15px] font-semibold text-foreground">SSH Hosts</h2>
                <ul className="space-y-0">
                  {sshHostList.map((host) => (
                    <li key={host}>
                      <button
                        onClick={() => (onRun ?? onCd)("ssh " + host)}
                        className="group flex w-full items-center gap-3 py-3 border-b border-border/40 text-left transition-colors hover:bg-accent last:border-0 px-1"
                      >
                        <ServerIcon className="size-3.5 shrink-0 text-muted-foreground/55" />
                        <span className="font-mono text-[13px] text-foreground truncate">{host}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {/* Recent Dirs */}
          <div className="border-l border-border pl-8">
            {recentDirList.length > 0 && (
              <>
                <h2 className="mb-4 font-sans text-[15px] font-semibold text-foreground">Recent Directories</h2>
                <ul className="space-y-0">
                  {recentDirList.map((dir) => (
                    <li key={dir}>
                      <button
                        onClick={() => onCd(dir)}
                        className="group flex w-full items-center gap-3 py-3 border-b border-border/40 text-left transition-colors hover:bg-accent last:border-0 px-1"
                      >
                        <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/55" />
                        <span className="font-mono text-[13px] text-foreground truncate">{formatCwd(dir)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Two-column body ── */}
      {(recentDirs.length > 0 || failed.length > 0) && (
        <div className="grid grid-cols-2 gap-0 border-t border-border pt-10">

          {/* Left: recent dirs */}
          <div className="pr-8">
            <h2 className="mb-1 font-sans text-[15px] font-semibold text-foreground">Jump back in</h2>
            <p className="mb-6 font-sans text-[12px] text-muted-foreground/75">Press a number to open in a new session.</p>
            <ul className="space-y-0">
              {recentDirs.map((d, i) => (
                <li key={d.cwd}>
                  <button
                    onClick={() => onCd(d.cwd)}
                    className="group flex w-full items-center gap-3 py-3 border-b border-border/40 text-left transition-colors hover:bg-accent last:border-0 px-1"
                  >
                    <span className="w-5 h-5 shrink-0 flex items-center justify-center font-mono text-[10px] text-muted-foreground/65 border border-border/80 select-none">{i + 1}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-mono text-[13px] text-foreground truncate">{formatCwd(d.cwd)}</span>
                      {d.git && (
                        <span className="flex items-center gap-1.5 mt-0.5">
                          <GitBranchIcon className="size-2.5 text-muted-foreground/55" />
                          <span className="font-mono text-[10px] text-muted-foreground/70">{d.git.branch}</span>
                          {d.git.dirty && <span className="size-1.5 rounded-full bg-amber-400/80" />}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 font-sans text-[11px] text-muted-foreground/60">{timeAgo(d.ts)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Vertical rule */}
          <div className="border-l border-border pl-8">
            <h2 className="mb-1 font-sans text-[15px] font-semibold text-foreground">
              {failed.length === 1 ? "One command failed" : `${failed.length} commands failed`}
            </h2>
            <p className="mb-6 font-sans text-[12px] text-muted-foreground/75">Open a folder to see its output or run it again.</p>
            <ul className="space-y-0">
              {failed.map((item, i) => (
                <li key={i}>
                  <button
                    onClick={() => onCd(item.cwd)}
                    className="group flex w-full flex-col items-start py-3 border-b border-border/40 text-left transition-colors hover:bg-accent last:border-0 px-1"
                  >
                    <span className="font-mono text-[13px] text-foreground truncate w-full">{item.cmd}</span>
                    <span className="mt-0.5 font-sans text-[11px] text-alarm/85">
                      {exitReason(item.code, item.cmd)}{" "}
                      <span className="text-muted-foreground/60">in {formatCwd(item.cwd)}, exit {item.code}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ── Footer CTAs ── */}
      <div className="mt-12 flex items-center gap-1 border-t border-border/40 pt-5">
        <button
          onClick={toggleKeys}
          className="flex items-center gap-1.5 px-3 py-1.5 font-sans text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors border border-transparent hover:border-border"
        >
          <ChevronRightIcon className={`size-3 transition-transform ${showKeys ? "rotate-90" : ""}`} />
          Keyboard shortcuts
        </button>
        {onOpenPalette && (
          <button
            onClick={onOpenPalette}
            className="flex items-center gap-1.5 px-3 py-1.5 font-sans text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors border border-transparent hover:border-border"
          >
            <CommandIcon className="size-3" />
            Commands
            <kbd className="ml-0.5 font-mono text-[10px] text-muted-foreground/55">⌘P</kbd>
          </button>
        )}
      </div>

      {/* Keys grid */}
      {showKeys && (
        <div ref={keysRef} className="mt-4 border border-border">
          <div className="grid grid-cols-2 sm:grid-cols-4">
            {SHORTCUTS.map(({ key, label, Icon }, idx) => (
              <div
                key={key}
                className={`flex items-center gap-3 px-4 py-3 ${idx < SHORTCUTS.length - 4 ? "border-b border-border/60" : ""} ${idx % 4 !== 3 ? "border-r border-border/60" : ""}`}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground/55" />
                <span className="flex-1 font-sans text-[12px] text-foreground/85">{label}</span>
                <kbd className="shrink-0 font-mono text-[11px] text-muted-foreground/70 bg-muted px-1.5 py-0.5">{key}</kbd>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
