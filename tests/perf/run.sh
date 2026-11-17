#!/usr/bin/env bash
# Performance regression check for daimon.
#
#   tests/perf/run.sh          daemon: throughput vs a raw PTY, echo latency, slow/stuck clients
#   tests/perf/run.sh --e2e    also the production app end to end (needs ./build.sh output and
#                              a display; opens a window for a minute)
#
# Everything runs against its own daemon, port and data dirs; a running daimon is untouched.
# Fails (exit 1) when a check below misses. Raw numbers are printed as JSON.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/daimon-perf.XXXXXX")"
PORT="${DAIMON_PERF_PORT:-7890}"
DAEMON_PID=""
cleanup() { [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

command -v zsh >/dev/null || { echo "perf: zsh is required"; exit 1; }

echo "[perf] building release pty-daemon…"
cargo build --release -q -p pty-daemon --manifest-path "$ROOT/Cargo.toml"

mkdir -p "$WORK/files" "$WORK/data" "$WORK/state"
python3 - "$WORK/files" <<'EOF'
import os, sys
d = sys.argv[1]
with open(os.path.join(d, "plain.txt"), "w") as w:
    for i in range(200000): w.write(f"line {i:07d} the quick brown fox jumps over the lazy dog 0123456789\n")
with open(os.path.join(d, "sgr.txt"), "w") as w:
    for i in range(150000): w.write(f"\x1b[3{i%8}mline {i:07d}\x1b[0m \x1b[1;4{(i+3)%8}mbold\x1b[0m quick brown fox jumps over\n")
EOF

DAIMON_PORT=$PORT XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state" RUST_LOG=warn \
  "$ROOT/target/release/pty-daemon" >"$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 100); do [ -f "$WORK/state/daimon/token" ] && (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break; sleep 0.1; done

echo "[perf] daemon benchmarks…"
python3 "$HERE/daemon_bench.py" "$PORT" "$WORK/state/daimon/token" "$DAEMON_PID" "$WORK/files" | tee "$WORK/daemon.json"

python3 - "$WORK/daemon.json" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
fails = []
for k, raw in r["raw_pty_MB_s"].items():
    got = r["throughput_MB_s"][k]
    if got < 0.7 * raw: fails.append(f"{k}: {got} MB/s through the daemon, under 70% of the raw PTY's {raw}")
if r["echo_ms"]["p99"] > 5: fails.append(f"echo p99 {r['echo_ms']['p99']} ms > 5 ms")
if r["slow_client_share_of_output"] < 1.0: fails.append(f"slow client got {r['slow_client_share_of_output']:.0%} of the output")
if not r["slow_client_sees_later_output"]: fails.append("slow client stopped receiving output")
if not r["others_continue_past_stuck_client"]: fails.append("a stuck client stalled everyone")
if not r["stuck_client_disconnected"]: fails.append("a stuck client was never disconnected")
for f in fails: print("[perf] FAIL", f)
print("[perf] daemon:", "FAIL" if fails else "ok")
sys.exit(1 if fails else 0)
EOF

if [ "${1:-}" = "--e2e" ]; then
  APP="$ROOT/dist/daimon2-$(uname -s | tr A-Z a-z | sed 's/darwin/macos/')-x64/daimon"
  [ -x "$APP" ] || { echo "[perf] no production build at $APP — run ./build.sh"; exit 1; }
  echo "[perf] end to end (app window opens)…"
  python3 "$HERE/e2e.py" "$APP" $((PORT + 1)) "$WORK" "$WORK/files" | tee "$WORK/e2e.json"
  python3 - "$WORK/e2e.json" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
b = r["bench"] or sys.exit("[perf] FAIL no bench result from the app")
fails = []
for x in b["results"]:
    if x["cmd"] == "echo hi" and x["painted_ms"] > 150: fails.append(f"echo hi painted after {x['painted_ms']} ms")
    if x["frame_gap_max_ms"] > 2000: fails.append(f"{x['cmd'][:30]}: UI froze {x['frame_gap_max_ms']} ms")
web = r["end_pss_mb"][1].get("WebKitWebProces", 0)
# Regression guard, not a target: ~1.5 GB today, mostly the peak of streaming a 13.6 MB
# output (OutputStream and the replay buffer keep several copies of it).
if web > 2000: fails.append(f"web process at {web} MB after the run")
for f in fails: print("[perf] FAIL", f)
print("[perf] e2e:", "FAIL" if fails else "ok")
sys.exit(1 if fails else 0)
EOF
fi
