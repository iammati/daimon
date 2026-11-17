import React, { useEffect, useRef, useState } from "react";
import { Shield, ShieldOff, ShieldAlert, Loader2 } from "lucide-react";
import openstackIcon from "@/assets/openstack-icon.svg";
import { shell } from "@/lib/daimon/rpc";
import { Keys } from "@/components/daimon/Kbd";
import { useHeaderButtons, reportPluginError } from "@/lib/daimon/plugins";

export function HeaderExtensionSlot({ extensions }: { extensions: React.ReactNode[] }) {
  return <>{extensions.map((e, i) => <React.Fragment key={i}>{e}</React.Fragment>)}</>;
}

/** Keeps a crashing plugin button from taking the header down with it. */
class PluginBoundary extends React.Component<{ id: string; children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(err: unknown) { reportPluginError(this.props.id, err); }
  override render() { return this.state.failed ? null : this.props.children; }
}

/** Renders all plugin-registered header buttons. Drop this into the header right-side area. */
export function HeaderButtonSlot() {
  const buttons = useHeaderButtons();
  return (
    <>
      {buttons.map(({ id, render: R }) => (
        <PluginBoundary key={id} id={id}>{typeof R === "function" ? <R /> : R}</PluginBoundary>
      ))}
    </>
  );
}

export function OpenStackBadge({ region, project, domain }: { region: string | null; project: string | null; domain?: string | null }) {
  if (!region) return null;
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border/40 bg-card/60 px-2.5 py-1">
      <img src={openstackIcon} alt="OpenStack" className="size-3.5 shrink-0" style={{ filter: "brightness(0) saturate(100%) invert(20%) sepia(90%) saturate(4000%) hue-rotate(340deg) brightness(90%)" }} />
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-[#DA1A32]/90 font-medium">{region}</span>
        {project && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-foreground/80">{domain ?? ""}{domain ? "/" : ""}{project}</span>
          </>
        )}
      </div>
    </div>
  );
}

// Placeholder — k8s context removed from landing page but slot kept for future use
export function K8sBadge(_props: { context?: string | null; namespace?: string | null }) {
  return null;
}

// ── Tailscale ──────────────────────────────────────────────────────────────────

type TsState = "Running" | "Stopped" | "NeedsLogin" | "unknown";

interface TsStatus {
  state: TsState;
  online: boolean;
  authURL: string;
  ip: string;
  hostname: string;
  loginIssue: boolean;
}

const POLL_MS = 8000;

export function TailscaleBadge() {
  const [status, setStatus] = useState<TsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = async () => {
    try {
      const s = await shell.tailscaleStatus();
      setStatus(s as TsStatus);
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  // auto-reconnect: if session expired (NeedsLogin + authURL empty = soft expiry),
  // try `tailscale up` once. If authURL is set, user needs to re-auth in browser.
  const prevState = useRef<TsState | null>(null);
  useEffect(() => {
    if (!status) return;
    const cur = status.state;
    const prev = prevState.current;
    prevState.current = cur;
    if (cur === "NeedsLogin" && !status.authURL && prev === "Running") {
      shell.tailscaleUp().then(poll);
    }
  }, [status?.state]);

  const toggle = async () => {
    if (busy || !status) return;
    setBusy(true);
    try {
      if (status.loginIssue || status.state === "NeedsLogin") {
        // Runs `tailscale up --login-server=...` in background; daemon opens browser auth URL
        await shell.tailscaleLoginUrl();
        return;
      }
      if (status.state === "Running") {
        await shell.tailscaleDown();
      } else {
        await shell.tailscaleUp();
      }
      await poll();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onToggle = () => toggle();
    window.addEventListener("toggle-tailscale", onToggle);
    return () => window.removeEventListener("toggle-tailscale", onToggle);
  }, [toggle]);

  if (!status) {
    return (
      <div className="no-drag flex items-stretch opacity-50">
        <div className="flex items-center gap-2 border-y border-l border-white/10 bg-black py-1.5 pl-2.5 pr-3">
          <span className="size-1.5 rounded-full shrink-0 bg-white/30" />
          <Loader2 size={12} className="animate-spin text-white shrink-0" />
          <span className="font-mono text-[12px] text-white/60">tailscale</span>
        </div>
        <div className="flex items-center border border-white/10 bg-black px-1.5">
          <Keys combo="⌘⇧T" size="xs" />
        </div>
      </div>
    );
  }

  const connected  = status.state === "Running" && !status.loginIssue;
  const loginIssue = status.loginIssue || status.state === "NeedsLogin";
  const needsAuth  = status.state === "NeedsLogin";
  const stopped    = status.state === "Stopped";

  // LED colour: lime = connected, amber = login issue / needs auth, muted = disconnected
  const ledClass = connected
    ? "bg-lime-400 shadow-[0_0_6px_2px_rgba(163,230,53,0.55)]"
    : loginIssue
      ? "bg-amber-400 shadow-[0_0_6px_2px_rgba(251,191,36,0.55)]"
      : "bg-muted-foreground/30";

  const IconEl = busy ? Loader2 : connected ? Shield : loginIssue ? ShieldAlert : ShieldOff;
  const iconClass = busy
    ? "animate-spin text-white"
    : connected
      ? "text-lime-400"
      : loginIssue
        ? "text-amber-400"
        : "text-white/50";

  const label = connected
    ? status.ip || "connected"
    : loginIssue
      ? "re-auth needed"
      : stopped
        ? "disconnected"
        : status.state.toLowerCase();

  return (
    <div className="flex items-stretch">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        title={
          connected
            ? `Tailscale · ${status.hostname} · ${status.ip}\nClick to disconnect`
            : loginIssue
              ? "Tailscale · re-authentication required\nClick to open login URL"
              : "Tailscale · disconnected\nClick to connect"
        }
        className="no-drag flex items-center gap-2 border-y border-l border-white/10 bg-black py-1.5 pl-2.5 pr-3 transition-colors hover:bg-neutral-900 disabled:cursor-default disabled:opacity-70"
      >
        <span className={`size-1.5 rounded-full shrink-0 transition-all ${ledClass}`} />
        <IconEl size={12} className={`shrink-0 ${iconClass}`} />
        <span className="font-mono text-[12px] text-white/80">{label}</span>
      </button>
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        tabIndex={-1}
        title="Toggle Tailscale (⌘⇧T)"
        className="no-drag flex items-center border border-white/10 bg-black px-1.5 transition-colors hover:bg-neutral-900 disabled:cursor-default disabled:opacity-70"
      >
        <Keys combo="⌘⇧T" size="xs" />
      </button>
    </div>
  );
}
