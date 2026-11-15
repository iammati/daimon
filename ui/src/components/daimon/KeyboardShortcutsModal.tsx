import { useEffect } from "react";
import {
  TabletSmartphoneIcon,
  ArrowUpDownIcon,
  XCircleIcon,
  SearchIcon,
  PlusSquareIcon,
  SplitSquareHorizontalIcon,
  PanelLeftIcon,
  CommandIcon,
  KeyboardIcon,
} from "lucide-react";

const SHORTCUTS = [
  { key: "Tab",  label: "Complete",        Icon: TabletSmartphoneIcon },
  { key: "↑ ↓", label: "History",         Icon: ArrowUpDownIcon },
  { key: "⌘K",  label: "Shortcuts",       Icon: KeyboardIcon },
  { key: "⌘F",  label: "Search",          Icon: SearchIcon },
  { key: "⌘T",  label: "New session",     Icon: PlusSquareIcon },
  { key: "⌘D",  label: "Split pane",      Icon: SplitSquareHorizontalIcon },
  { key: "⌘B",  label: "Sidebar",         Icon: PanelLeftIcon },
  { key: "⌘P",  label: "Commands",        Icon: CommandIcon },
];

type Props = { open: boolean; onClose: () => void };

export function KeyboardShortcutsModal({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[480px] border border-border bg-card shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
          <KeyboardIcon className="size-4 text-muted-foreground/60" />
          <span className="font-sans text-[13px] font-semibold text-foreground">Keyboard shortcuts</span>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground/50">Esc to close</span>
        </div>

        {/* Grid */}
        <div className="p-5">
          <ul className="space-y-1">
            {SHORTCUTS.map(({ key, label, Icon }) => (
              <li key={key} className="flex items-center gap-4 py-2 border-b border-border/30 last:border-0">
                <Icon className="size-4 shrink-0 text-muted-foreground/55" />
                <span className="flex-1 font-sans text-[13px] text-foreground/90">{label}</span>
                <kbd className="flex items-center justify-center min-w-[2.25rem] px-2.5 py-1 font-mono text-[12px] font-medium text-foreground/80 bg-muted border border-border/60 shadow-[0_1px_0_0_oklch(0_0_0/0.4)]">
                  {key}
                </kbd>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
