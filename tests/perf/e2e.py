"""End to end: start the production app in bench mode and collect its timings.

    python3 e2e.py <app> <port> <work-dir> <files-dir>

DAIMON_BENCH makes the UI run the commands below through its normal composer path and
store the timings in the `bench-result` pref (see ui/src/lib/daimon/bench.ts). Data dirs
are isolated under <work-dir>; the daemon ends with the app (DAIMON_PERSIST=0).
"""
import json, os, signal, sqlite3, subprocess, sys, time

APP, PORT, WORK, FILES = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
root = os.path.join(WORK, "e2e")
os.makedirs(os.path.join(root, "data"), exist_ok=True)
os.makedirs(os.path.join(root, "state"), exist_ok=True)
db = os.path.join(root, "data", "daimon", "daimon.db")
spec = {"reps": 3, "warmupMs": 4000, "cmds": [
    "echo hi",
    "seq 1 100000",
    f"head -c 1000000 {FILES}/sgr.txt",
    f"cat {FILES}/plain.txt",
]}
env = dict(os.environ, DAIMON_PORT=PORT, DAIMON_PERSIST="0", DAIMON_BENCH=json.dumps(spec),
           XDG_DATA_HOME=os.path.join(root, "data"), XDG_STATE_HOME=os.path.join(root, "state"))
app = subprocess.Popen([APP], env=env, stdout=open(os.path.join(root, "app.log"), "w"),
                       stderr=subprocess.STDOUT, start_new_session=True)


def tree_pss(root_pid):
    """PSS (shared pages split fairly) of the app's process tree, total and per process name."""
    kids = {}
    for p in os.listdir("/proc"):
        if p.isdigit():
            try:
                s = open(f"/proc/{p}/stat").read()
                kids.setdefault(int(s[s.rindex(")") + 2:].split()[1]), []).append(int(p))
            except Exception:
                pass
    todo, per, total = [root_pid], {}, 0.0
    while todo:
        p = todo.pop()
        todo += kids.get(p, [])
        try:
            name = open(f"/proc/{p}/comm").read().strip()
            v = [l for l in open(f"/proc/{p}/smaps_rollup") if l.startswith("Pss:")]
            mb = int(v[0].split()[1]) / 1024 if v else 0
            per[name] = round(per.get(name, 0) + mb, 1)
            total += mb
        except Exception:
            pass
    return round(total, 1), per


result, idle, t0 = None, None, time.time()
try:
    while time.time() - t0 < 600:
        time.sleep(1)
        if idle is None and time.time() - t0 > 3.5:
            idle = tree_pss(app.pid)
        try:
            row = sqlite3.connect(f"file:{db}?mode=ro", uri=True).execute(
                "select value from prefs where key='bench-result'").fetchone()
            if row:
                result = json.loads(row[0])
                break
        except Exception:
            pass
    end = tree_pss(app.pid)
finally:
    os.killpg(app.pid, signal.SIGTERM)
print(json.dumps({"idle_pss_mb": idle, "end_pss_mb": end, "bench": result}, indent=1))
