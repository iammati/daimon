import { useEffect, useRef, useState } from "react";
import {
  PaletteIcon,
  TerminalIcon,
  BellIcon,
  KeyboardIcon,
  InfoIcon,
  SearchIcon,
} from "lucide-react";
import { Keys } from "./Kbd";
import { GLASS_DEFAULT, GLASS_MIN_OPACITY, loadGlass, nativeBlurLabel, nativeBlurMode, saveGlass, type Glass } from "@/lib/daimon/appearance";
import { shell } from "@/lib/daimon/rpc";
import { usePresence } from "@/lib/daimon/presence";
import { setLinkPreviewsEnabled, useLinkPreviewsEnabled } from "@/lib/daimon/linkPreview";

type Theme = "light" | "dracula";

type Props = {
  open: boolean;
  onClose: () => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
  fontSize: number;
  onFontSize: (n: number) => void;
  showBadges: boolean;
  onShowBadges: (v: boolean) => void;
  showPowerline: boolean;
  onShowPowerline: (v: boolean) => void;
};

const CATEGORIES = [
  { id: "appearance", label: "Appearance", Icon: PaletteIcon },
  { id: "terminal",   label: "Terminal",   Icon: TerminalIcon },
  { id: "notif",      label: "Notifications", Icon: BellIcon },
  { id: "shortcuts",  label: "Shortcuts",  Icon: KeyboardIcon },
  { id: "about",      label: "About",      Icon: InfoIcon },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

const SHORTCUTS_LIST = [
  { key: "Tab",  label: "Complete" },
  { key: "↑ ↓", label: "History" },
  { key: "⌘K",  label: "Keyboard shortcuts" },
  { key: "⌘F",  label: "Search" },
  { key: "⌘T",  label: "New session" },
  { key: "⌘D",  label: "Split pane" },
  { key: "⌘B",  label: "Sidebar" },
  { key: "⌘P",  label: "Commands" },
  { key: "⌘,",  label: "Settings" },
];

type RowProps = { label: string; children: React.ReactNode };
function Row({ label, children }: RowProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30">
      <span className="font-sans text-sm text-foreground/90">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${value ? "bg-signal" : "bg-muted"}`}
      aria-checked={value}
      role="switch"
    >
      <span
        className={`inline-block size-3.5 rounded-full bg-white shadow transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`}
      />
    </button>
  );
}

export function SettingsModal({ open, onClose, theme, onTheme, fontSize, onFontSize, showBadges, onShowBadges, showPowerline, onShowPowerline }: Props) {
  const shown = usePresence(open);   // stays mounted while it animates out
  const [category, setCategory] = useState<CategoryId>("appearance");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Pref state (loaded once on open)
  const [fontFamily, setFontFamily] = useState("JetBrains Mono");
  const [scrollback, setScrollback] = useState(10000);
  const [bell, setBell] = useState(false);
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [notifThreshold, setNotifThreshold] = useState(10);
  const linkPreviews = useLinkPreviewsEnabled();
  const [glass, setGlassState] = useState<Glass>(loadGlass);
  const setGlass = (patch: Partial<Glass>) => setGlassState((g) => { const n = { ...g, ...patch }; saveGlass(n); return n; });

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setTimeout(() => searchRef.current?.focus(), 50);
    // Load prefs
    Promise.all([
      shell.prefGet("font-family"),
      shell.prefGet("scrollback-limit"),
      shell.prefGet("bell"),
      shell.prefGet("notif-enabled"),
      shell.prefGet("notif-threshold"),
    ]).then(([ff, sb, bl, ne, nt]) => {
      if (ff) setFontFamily(ff);
      if (sb) setScrollback(parseInt(sb, 10) || 10000);
      if (bl) setBell(bl === "1");
      if (ne) setNotifEnabled(ne === "1");
      if (nt) setNotifThreshold(parseInt(nt, 10) || 10);
    }).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "/" && document.activeElement !== searchRef.current) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const idx = CATEGORIES.findIndex((c) => c.id === category);
        const next = e.key === "ArrowLeft" ? Math.max(0, idx - 1) : Math.min(CATEGORIES.length - 1, idx + 1);
        setCategory(CATEGORIES[next]!.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, category]);

  if (!shown) return null;

  const q = search.toLowerCase();

  type SettingRow = { category: CategoryId; label: string; node: React.ReactNode };

  const allRows: SettingRow[] = [
    // Appearance
    {
      category: "appearance",
      label: "Font Size",
      node: (
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground w-6 text-right">{fontSize}</span>
          <input
            type="range" min={10} max={20} value={fontSize}
            onChange={(e) => onFontSize(parseInt(e.target.value, 10))}
            className="w-28 accent-[hsl(var(--signal))]"
          />
        </div>
      ),
    },
    {
      category: "appearance",
      label: "Background opacity",
      node: (
        <div className="flex items-center gap-2">
          {!document.documentElement.classList.contains("native-transparent") && (
            <span className="font-mono text-[10px] text-amber/80" title="Start with DAIMON_TRANSPARENT=1 ./dev.sh for a see-through window">
              needs DAIMON_TRANSPARENT=1
            </span>
          )}
          <span className="font-mono text-xs text-muted-foreground w-9 text-right tabular-nums">{glass.opacity}%</span>
          <input
            type="range" min={GLASS_MIN_OPACITY} max={100} value={glass.opacity}
            onChange={(e) => setGlass({ opacity: parseInt(e.target.value, 10) })}
            className="w-28 accent-[var(--signal)]"
          />
        </div>
      ),
    },
    {
      category: "appearance",
      label: "Background blur",
      node: (
        <div className="flex items-center gap-2">
          {nativeBlurMode() ? (
            <span
              className="font-mono text-xs text-muted-foreground w-14 text-right tabular-nums"
              title={nativeBlurMode() === "variable"
                ? "How strongly the desktop behind the window is blurred"
                : "Windows blurs the desktop behind the window in three steps: off, soft, frosted"}
            >{nativeBlurLabel(glass.blur, nativeBlurMode()!)}</span>
          ) : (
            <span className="font-mono text-xs text-muted-foreground w-9 text-right tabular-nums">{glass.blur}px</span>
          )}
          <input
            type="range" min={0} max={60} value={glass.blur}
            onChange={(e) => setGlass({ blur: parseInt(e.target.value, 10) })}
            className="w-28 accent-[var(--signal)]"
          />
          {(glass.opacity !== GLASS_DEFAULT.opacity || glass.blur !== GLASS_DEFAULT.blur) && (
            <button
              onClick={() => setGlass(GLASS_DEFAULT)}
              className="font-mono text-[11px] text-muted-foreground/60 hover:text-foreground"
              title="Reset opacity & blur to defaults"
            >reset</button>
          )}
        </div>
      ),
    },
    {
      category: "appearance",
      label: "Font Family",
      node: (
        <select
          value={fontFamily}
          onChange={(e) => {
            setFontFamily(e.target.value);
            shell.prefSet("font-family", e.target.value).catch(() => {});
          }}
          className="bg-muted border border-border font-mono text-[12px] text-foreground/90 px-2 py-1 outline-none"
        >
          {["JetBrains Mono","Fira Code","Cascadia Code","SF Mono","Menlo"].map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      ),
    },
    {
      category: "appearance",
      label: "Theme",
      node: (
        <Toggle
          value={theme === "dracula"}
          onChange={(v) => {
            const t: Theme = v ? "dracula" : "light";
            onTheme(t);
            shell.prefSet("theme", t).catch(() => {});
          }}
        />
      ),
    },
    {
      category: "appearance",
      label: "Context badges",
      node: (
        <Toggle
          value={showBadges}
          onChange={(v) => {
            onShowBadges(v);
            shell.prefSet("show-badges", v ? "1" : "0").catch(() => {});
          }}
        />
      ),
    },
    {
      category: "appearance",
      label: "Context powerline",
      node: (
        <Toggle
          value={showPowerline}
          onChange={(v) => {
            onShowPowerline(v);
            shell.prefSet("show-powerline", v ? "1" : "0").catch(() => {});
          }}
        />
      ),
    },
    // Terminal
    {
      category: "terminal",
      label: "Scrollback",
      node: (
        <input
          type="number" min={1000} max={100000} value={scrollback}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (v >= 1000 && v <= 100000) {
              setScrollback(v);
              shell.prefSet("scrollback-limit", String(v)).catch(() => {});
            }
          }}
          className="w-24 bg-muted border border-border font-mono text-[12px] text-foreground/90 px-2 py-1 outline-none text-right"
        />
      ),
    },
    {
      category: "terminal",
      label: "Bell",
      node: (
        <Toggle
          value={bell}
          onChange={(v) => {
            setBell(v);
            shell.prefSet("bell", v ? "1" : "0").catch(() => {});
          }}
        />
      ),
    },
    {
      category: "terminal",
      label: "Link previews",
      node: <Toggle value={linkPreviews} onChange={setLinkPreviewsEnabled} />,
    },
    // Notifications
    {
      category: "notif",
      label: "Enable",
      node: (
        <Toggle
          value={notifEnabled}
          onChange={(v) => {
            setNotifEnabled(v);
            shell.prefSet("notif-enabled", v ? "1" : "0").catch(() => {});
          }}
        />
      ),
    },
    {
      category: "notif",
      label: "Threshold (seconds)",
      node: (
        <input
          type="number" min={5} max={300} value={notifThreshold}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (v >= 5 && v <= 300) {
              setNotifThreshold(v);
              shell.prefSet("notif-threshold", String(v)).catch(() => {});
            }
          }}
          className="w-20 bg-muted border border-border font-mono text-[12px] text-foreground/90 px-2 py-1 outline-none text-right"
        />
      ),
    },
  ];

  const visibleRows = q
    ? allRows.filter((r) => r.label.toLowerCase().includes(q))
    : allRows.filter((r) => r.category === category);

  const showingSearch = q.length > 0;

  return (
    <div
      data-state={open ? "open" : "closed"}
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        data-state={open ? "open" : "closed"}
        className="modal-panel w-[760px] h-[520px] bg-card/90 glass border border-border flex overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar */}
        <aside className="w-44 border-r border-border flex flex-col shrink-0">
          <div className="px-4 pt-4 pb-3 border-b border-border/50">
            <span className="font-sans text-[13px] font-semibold text-foreground">Settings</span>
          </div>
          <nav className="flex-1 py-2">
            {CATEGORIES.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => { setCategory(id); setSearch(""); }}
                className={`w-full flex items-center gap-2.5 px-4 py-2 text-left font-sans text-[13px] transition-colors ${
                  !showingSearch && category === id
                    ? "bg-signal/10 text-foreground"
                    : "text-foreground/60 hover:bg-accent hover:text-foreground"
                }`}
              >
                <Icon className="size-3.5 shrink-0" />
                {label}
              </button>
            ))}
          </nav>
          <div className="px-4 pb-3">
            <span className="font-mono text-[10px] text-muted-foreground/40">/ to search · Esc close</span>
          </div>
        </aside>

        {/* Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Search */}
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search settings…"
              className="flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground/40"
              autoComplete="off"
              spellCheck={false}
            />
            {search && (
              <button onClick={() => setSearch("")} className="font-mono text-[11px] text-muted-foreground/50 hover:text-foreground">
                clear
              </button>
            )}
          </div>

          {/* Panel */}
          <div className="flex-1 overflow-y-auto">
            {category === "shortcuts" && !showingSearch ? (
              <div>
                {SHORTCUTS_LIST.map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between px-4 py-2.5 border-b border-border/30">
                    <span className="font-sans text-sm text-foreground/90">{label}</span>
                    <Keys combo={key} size="md" />
                  </div>
                ))}
              </div>
            ) : category === "about" && !showingSearch ? (
              <div className="px-4 py-6">
                <p className="font-sans text-sm text-foreground/80">daimon v0.1.0 — a terminal for developers</p>
              </div>
            ) : visibleRows.length > 0 ? (
              <div>
                {visibleRows.map((r) => (
                  <Row key={r.category + r.label} label={r.label}>
                    {r.node}
                  </Row>
                ))}
              </div>
            ) : (
              <p className="px-4 py-4 font-mono text-[12px] text-muted-foreground/50">No settings match "{search}"</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
