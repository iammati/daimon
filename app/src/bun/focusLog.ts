// Focus tracing (dev builds, or DAIMON_FOCUS_LOG=1): one timeline of the native window events,
// the host's focus hand-offs and the page's decisions, so "the command input didn't get focus"
// can be traced to the step that failed. Printed with a [focus] prefix and appended to
// <tmp>/daimon-focus.log (on Windows: %TEMP%\daimon-focus.log).

import { appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = process.env.DAIMON_FOCUS_LOG === "1" ||
  (process.env.DAIMON_FOCUS_LOG !== "0" && process.env.NODE_ENV !== "production");
export const focusLogPath = join(tmpdir(), "daimon-focus.log");
const t0 = Date.now();

if (enabled) {
  try { writeFileSync(focusLogPath, `# daimon focus log, started ${new Date().toISOString()}\n`); } catch { /* read-only tmp */ }
}

export function focusLog(source: "host" | "page", msg: string) {
  if (!enabled) return;
  const line = `${String(Date.now() - t0).padStart(7)}ms ${source} ${msg}`;
  console.log(`[focus] ${line}`);
  try { appendFileSync(focusLogPath, line + "\n"); } catch { /* ignore */ }
}

export const focusLogEnabled = enabled;
