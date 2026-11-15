import { GitBranch } from "lucide-react";
import kubernetesIcon from "@/assets/kubernetes-icon.svg";
import openstackIcon from "@/assets/openstack-icon.svg";

type Props = {
  k8sContext: string | null;
  k8sNamespace: string | null;
  osRegion: string | null;
  osProject: string | null;
  osDomain: string | null;
  gitBranch: string | null;
  gitDirty: boolean;
  gitAdded: number;
  gitRemoved: number;
};

// Flat, calm statusline: lucide glyph + value, optional sub joined with a muted "·".
// Segments separated by whitespace, no fills or wedges.
function Segment({ icon, value, sub, children }: { icon: React.ReactNode; value: React.ReactNode; sub?: string | null; children?: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground/60">{icon}</span>
      <span className="text-foreground/80">{value}</span>
      {sub && <span className="text-muted-foreground/40">· {sub}</span>}
      {children}
    </span>
  );
}

export function PowerlineStatus({ k8sContext, k8sNamespace, osRegion, osProject, osDomain, gitBranch, gitDirty, gitAdded, gitRemoved }: Props) {
  const segments: React.ReactNode[] = [];

  if (k8sContext) {
    segments.push(
      <Segment
        key="k8s"
        icon={<img src={kubernetesIcon} alt="" className="size-3.5" />}
        value={k8sContext}
        sub={k8sNamespace && k8sNamespace !== "default" ? k8sNamespace : null}
      />
    );
  }
  if (osRegion) {
    segments.push(
      <Segment
        key="os"
        icon={<img src={openstackIcon} alt="" className="size-3.5" />}
        value={osRegion}
        sub={osProject ? `${osDomain ? osDomain + "/" : ""}${osProject}` : null}
      />
    );
  }
  if (gitBranch) {
    segments.push(
      <Segment
        key="git"
        icon={<GitBranch className={`size-3.5 ${gitDirty ? "text-amber" : "text-signal"}`} strokeWidth={1.75} />}
        value={<span className={gitDirty ? "text-amber" : "text-signal"}>{gitBranch}</span>}
      >
        {gitDirty && <span className="size-1.5 rounded-full bg-amber" />}
        {gitDirty && (gitAdded > 0 || gitRemoved > 0) && (
          <span className="flex items-center gap-1.5">
            {gitAdded > 0 && <span className="text-[oklch(0.78_0.17_150)]">+{gitAdded}</span>}
            {gitRemoved > 0 && <span className="text-[oklch(0.70_0.19_25)]">−{gitRemoved}</span>}
          </span>
        )}
      </Segment>
    );
  }

  if (segments.length === 0) return null;

  return (
    <div className="flex items-center gap-5 px-6 pt-3 pb-1 font-mono text-[12px] leading-none">
      {segments}
    </div>
  );
}
