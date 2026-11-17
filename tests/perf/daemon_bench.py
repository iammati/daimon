"""pty-daemon benchmarks against a raw PTY on the same machine (same zsh, same files).

    python3 daemon_bench.py <port> <token-file> <daemon-pid> <files-dir>

Prints JSON: time to first prompt, keystroke echo round trip, `cat` throughput (daimon and
raw PTY), how a slow and a stuck client fare during a flood, and daemon memory.
"""
import json, os, pty, select, socket, sys, threading, time, uuid
from ws import WS

PORT, TOKEN, DPID, FILES = int(sys.argv[1]), open(sys.argv[2]).read().strip(), int(sys.argv[3]), sys.argv[4]
BIG = {k: os.path.join(FILES, k) for k in ("plain.txt", "sgr.txt")}
R = {}
mine = lambda tab, t: (lambda e: e.get("tab_id") == tab and e["type"] == t)


def rss_mb():
    for l in open(f"/proc/{DPID}/status"):
        if l.startswith("VmRSS"):
            return round(int(l.split()[1]) / 1024, 1)


def summ(xs):
    xs = sorted(xs)
    at = lambda p: round(xs[min(len(xs) - 1, int(p / 100 * len(xs)))], 3)
    return {"n": len(xs), "p50": at(50), "p99": at(99), "max": round(xs[-1], 3)}


ws = WS(PORT, TOKEN)
R["rss_idle_mb"] = rss_mb()

ttp = []
for _ in range(5):
    tab = f"ttp-{uuid.uuid4().hex[:6]}"
    t0 = time.perf_counter()
    ws.write(tab, "")
    assert ws.until(mine(tab, "prompt"), 20), "no prompt"
    ttp.append((time.perf_counter() - t0) * 1000)
    ws.send({"type": "close", "tab_id": tab})
R["time_to_prompt_ms"] = summ(ttp)

tab = "bench"
ws.write(tab, "")
ws.until(mine(tab, "prompt"), 20)
ws.until(lambda e: False, 1.0)
lat = []
for _ in range(200):
    t0 = time.perf_counter()
    ws.write(tab, "x")
    ws.until(lambda e: e.get("tab_id") == tab and e["type"] == "output" and "x" in e["data"], 5)
    lat.append((time.perf_counter() - t0) * 1000)
    ws.write(tab, "\x7f")
    ws.until(lambda e: e.get("tab_id") == tab and e["type"] == "output", 5)
    ws.until(lambda e: False, 0.005)
R["echo_ms"] = summ(lat)


def best_mb_s(run_once, path):
    size = os.path.getsize(path)
    return round(max(size / run_once(path) / 1e6 for _ in range(3)), 1)


def daimon_cat(path):
    ws.until(lambda e: False, 0.3)
    t0 = time.perf_counter()
    ws.write(tab, f"cat {path}\r", command=f"cat {path}")
    assert ws.until(mine(tab, "prompt"), 120), "cat timed out"
    return time.perf_counter() - t0


R["throughput_MB_s"] = {k: best_mb_s(daimon_cat, p) for k, p in BIG.items()}
R["rss_after_floods_mb"] = rss_mb()

# raw PTY baseline
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp("zsh", ["zsh", "-i"])


def drain(quiet):
    while select.select([fd], [], [], quiet)[0]:
        try:
            if not os.read(fd, 1 << 16):
                break
        except OSError:
            break


drain(1.5)


def raw_cat(path):
    size = os.path.getsize(path)
    while True:
        drain(0.3)
        tag = uuid.uuid4().hex[:6]
        mark = f"DONE{tag}"
        t0 = time.perf_counter()
        # The typed line must not contain the marker: the shell echoes it before cat runs.
        os.write(fd, f"cat {path}; printf 'DONE%s\\n' {tag}\r".encode())
        tail, n = b"", 0
        while mark.encode() not in tail:
            select.select([fd], [], [], 30)
            c = os.read(fd, 1 << 16)
            n += len(c)
            tail = (tail + c)[-4096:]
        # The first command after zsh starts can come back without cat's output (shell
        # startup still settling): only a run that carried the whole file counts.
        if n >= size:
            return time.perf_counter() - t0


R["raw_pty_MB_s"] = {k: best_mb_s(raw_cat, p) for k, p in BIG.items()}
os.kill(pid, 9)

# slow client: reads, 2 ms per event; must get all output and later output too
slow = WS(PORT, TOKEN)
got = {"bytes": 0, "marker": False, "stop": False}


def slow_reader():
    while not got["stop"]:
        ev = slow.recv(2.0)
        if ev and ev.get("tab_id") == tab and ev["type"] == "output":
            got["bytes"] += len(ev["data"].encode())
            got["marker"] = got["marker"] or "MARKER_AFTER" in ev["data"]
        time.sleep(0.002)


th = threading.Thread(target=slow_reader, daemon=True)
th.start()
ws.write(tab, f"cat {BIG['plain.txt']}\r", command="cat")
ws.until(mine(tab, "prompt"), 300)
ws.write(tab, "echo MARK''ER_AFTER\r", command="echo")
ws.until(mine(tab, "prompt"), 30)
end = time.perf_counter() + 60
while not got["marker"] and time.perf_counter() < end:
    time.sleep(0.1)
got["stop"] = True
th.join()
R["slow_client_share_of_output"] = round(got["bytes"] / os.path.getsize(BIG["plain.txt"]), 3)
R["slow_client_sees_later_output"] = got["marker"]
slow.s.close()

# stuck client: never reads; the others must carry on, and it must be disconnected
stuck = WS(PORT, TOKEN)
stuck.s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 64 * 1024)
ws.until(lambda e: False, 0.3)
ws.write(tab, f"cat {BIG['plain.txt']}\r", command="cat")
R["others_continue_past_stuck_client"] = ws.until(mine(tab, "prompt"), 120) is not None
closed = False
try:
    while stuck.recv(3.0) is not None:
        pass
except (EOFError, ConnectionResetError):
    closed = True
R["stuck_client_disconnected"] = closed
print(json.dumps(R, indent=1))
