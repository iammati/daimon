// The world daimon operates in: a virtual filesystem, kube contexts, regions.

export type Node = { type: "dir" | "file"; children?: Record<string, Node>; size?: number };

const f = (size: number): Node => ({ type: "file", size });
const d = (children: Record<string, Node>): Node => ({ type: "dir", children });

export const ROOT: Node = d({
  home: d({
    daimon: d({
      ".config": d({ "daimon.toml": f(412), "hammer.yaml": f(1180) }),
      ".kube": d({ config: f(9204), "cache": d({}) }),
      clusters: d({
        "eu-de-1.yaml": f(3120),
        "eu-nl-1.yaml": f(3044),
        "ap-jp-2.yaml": f(2988),
        "qa-de-1.yaml": f(2140),
      }),
      manifests: d({
        "ingress.yaml": f(844),
        "kustomization.yaml": f(310),
        "values.prod.yaml": f(2610),
        "values.stage.yaml": f(2488),
      }),
      notes: d({ "runbook.md": f(7710), "postmortem-2026-04.md": f(4320) }),
      "README.md": f(1042),
    }),
  }),
});

export function resolve(path: string[]): Node | null {
  let cur: Node = ROOT;
  for (const seg of path) {
    if (cur.type !== "dir" || !cur.children?.[seg]) return null;
    cur = cur.children[seg];
  }
  return cur;
}

export function listDir(path: string[]): { name: string; node: Node }[] {
  const n = resolve(path);
  if (!n || n.type !== "dir" || !n.children) return [];
  return Object.entries(n.children)
    .map(([name, node]) => ({ name, node }))
    .sort((a, b) => (a.node.type === b.node.type ? a.name.localeCompare(b.name) : a.node.type === "dir" ? -1 : 1));
}

declare const __HOME__: string;
const HOME_SEGS = __HOME__.replace(/^\//, "").split("/");

export const displayPath = (path: string[]): string => {
  if (path.length >= HOME_SEGS.length && HOME_SEGS.every((seg, i) => seg === path[i])) {
    const rest = path.slice(HOME_SEGS.length);
    return rest.length === 0 ? "~" : "~/" + rest.join("/");
  }
  return "/" + path.join("/");
};

export type Ctx = { name: string; region: string; project: string; healthy: boolean; nodes: number };

export const CONTEXTS: Ctx[] = [
  { name: "eu-de-1", region: "Frankfurt", project: "cc-platform", healthy: true, nodes: 148 },
  { name: "eu-nl-1", region: "Amsterdam", project: "cc-platform", healthy: true, nodes: 96 },
  { name: "ap-jp-2", region: "Osaka", project: "cc-edge", healthy: true, nodes: 44 },
  { name: "qa-de-1", region: "Frankfurt", project: "cc-sandbox", healthy: false, nodes: 12 },
];

export type Spec = { name: string; blurb: string; args?: string[]; takesPath?: boolean };

export const COMMANDS: Spec[] = [
  { name: "ls", blurb: "List what's in a folder", takesPath: true },
  { name: "cd", blurb: "Move to another folder", takesPath: true },
  { name: "cat", blurb: "Print a file", takesPath: true },
  { name: "pwd", blurb: "Show where you are" },
  { name: "u8s", blurb: "Manage Kubernetes config", args: ["ctx", "get", "apply", "diff"] },
  { name: "hammer", blurb: "Converged Cloud operations", args: ["status", "regions", "quota", "rotate"] },
  { name: "kubectl", blurb: "Talk to the cluster", args: ["get", "describe", "logs", "top"] },
  { name: "git", blurb: "Version control", args: ["status", "log", "diff", "push"] },
  { name: "help", blurb: "What daimon can do" },
  { name: "clear", blurb: "Empty the canvas" },
];
