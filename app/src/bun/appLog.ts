// Host log that survives production builds: the Windows launcher discards bun's console,
// so lines that matter for diagnosing the window (backdrop / blur setup) are also appended
// to <tmp>/daimon-main.log (on Windows: %TEMP%\daimon-main.log). Started fresh each launch.

import { appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const appLogPath = join(tmpdir(), "daimon-main.log");
const t0 = Date.now();

try { writeFileSync(appLogPath, `# daimon host log, started ${new Date().toISOString()} (pid ${process.pid})\n`); } catch { /* read-only tmp */ }

function write(level: "info" | "warn", parts: unknown[]) {
  const msg = parts.map((p) => (typeof p === "string" ? p : p instanceof Error ? `${p.name}: ${p.message}` : JSON.stringify(p))).join(" ");
  (level === "warn" ? console.warn : console.log)(msg);
  try { appendFileSync(appLogPath, `${String(Date.now() - t0).padStart(7)}ms ${level} ${msg}\n`); } catch { /* ignore */ }
}

export const appLog = (...parts: unknown[]) => write("info", parts);
export const appWarn = (...parts: unknown[]) => write("warn", parts);
