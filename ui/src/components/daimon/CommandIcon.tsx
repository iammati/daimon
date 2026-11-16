import {
  ActivityIcon, DatabaseIcon, FileCodeIcon, GlobeIcon, HammerIcon, HexagonIcon, LayersIcon,
  PackageIcon, ServerIcon, SquarePenIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import kubernetesLogo from "@/assets/kubernetes-icon.svg";
import openstackLogo from "@/assets/openstack-icon.svg";
import claudeCodeLogo from "@/assets/logos/claude-code.svg";
import geminiLogo from "@/assets/logos/gemini.svg";
import openaiLogo from "@/assets/logos/openai.svg";
import gitLogo from "@/assets/logos/git.svg";
import githubLogo from "@/assets/logos/github.svg";
import dockerLogo from "@/assets/logos/docker.svg";
import { commandKind, type CommandKind } from "@/lib/daimon/commandKind";

// The real brand logo (bundled SVG, see assets/logos/README.md). `mono`: a black mark, inverted
// on the dark theme so it stays visible.
const LOGOS: Partial<Record<CommandKind, { src: string; alt: string; mono?: boolean }>> = {
  claude: { src: claudeCodeLogo, alt: "Claude Code" },
  gemini: { src: geminiLogo, alt: "Gemini CLI" },
  codex: { src: openaiLogo, alt: "Codex", mono: true },
  git: { src: gitLogo, alt: "git" },
  github: { src: githubLogo, alt: "GitHub CLI", mono: true },
  docker: { src: dockerLogo, alt: "Docker" },
  kubernetes: { src: kubernetesLogo, alt: "Kubernetes" },
  openstack: { src: openstackLogo, alt: "OpenStack" },
};

// No brand logo: a generic icon in a tint.
const ICONS: Partial<Record<CommandKind, [LucideIcon, string]>> = {
  ssh: [ServerIcon, "#4fb6c9"],
  editor: [SquarePenIcon, "#57a64a"],
  node: [HexagonIcon, "#6cc24a"],
  rust: [PackageIcon, "#de8a5a"],
  python: [FileCodeIcon, "#4b8bbe"],
  monitor: [ActivityIcon, "#e5c07b"],
  terraform: [LayersIcon, "#844fba"],
  build: [HammerIcon, "#a0a8b8"],
  http: [GlobeIcon, "#61afef"],
  database: [DatabaseIcon, "#336791"],
};

/** An icon for what `cmd` runs, or `fallback` when it's nothing recognised. */
export function CommandIcon({ cmd, fallback, className = "size-3.5" }: { cmd: string | undefined; fallback: React.ReactNode; className?: string }) {
  const kind = cmd ? commandKind(cmd) : null;
  const logo = kind && LOGOS[kind];
  if (logo) return <img src={logo.src} alt={logo.alt} title={cmd} draggable={false} className={`${className} object-contain${logo.mono ? " dracula:invert" : ""}`} />;
  const icon = kind && ICONS[kind];
  if (!icon) return <>{fallback}</>;
  const [Icon, color] = icon;
  return <span title={cmd} className="contents"><Icon className={className} style={{ color }} /></span>;
}
