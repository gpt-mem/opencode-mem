"""Run every core test on Windows in small bounded Bun processes.

Bun 1.4.2 on Windows can retain a handle after the complete 156-file suite
reports 1275 passing tests. A 78-file half also intermittently fails a
subprocess test under shared load, so each process now owns at most 39 files.
A nonzero result or a process that fails to exit remains a CI failure; no test
is skipped or given a longer per-test timeout.
"""

from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
TEST_DIR = ROOT / "test"
EXTENSIONS = (".test.ts", ".test.tsx", ".test.js", ".test.jsx",
              ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx")
FILES = sorted(str(path.relative_to(ROOT)) for path in TEST_DIR.rglob("*")
               if path.is_file() and path.name.endswith(EXTENSIONS))
if not FILES:
    raise SystemExit("no core tests discovered")

CHUNKS = min(4, len(FILES))
failed = False
for index in range(CHUNKS):
    group = FILES[index * len(FILES) // CHUNKS:(index + 1) * len(FILES) // CHUNKS]
    label = f"core chunk {index + 1}/{CHUNKS}"
    print(f"{label}: {len(group)} files", flush=True)
    try:
        result = subprocess.run(
            ["bun", "test", *group],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, timeout=240,
        )
        output = result.stdout
        print(f"{label}: exit={result.returncode}", flush=True)
        summary = next((line for line in output.splitlines() if re.search(r"Ran \d+ tests across", line)), None)
        if result.returncode != 0 or summary is None:
            failed = True
            print("\n".join(output.splitlines()[-80:]), flush=True)
        else:
            for line in output.splitlines():
                if re.search(r"\b\d+ (pass|fail|skip)\b|Ran \d+ tests across", line):
                    print(line[:300], flush=True)
    except subprocess.TimeoutExpired as error:
        output = error.stdout or b""
        if isinstance(output, bytes):
            output = output.decode(errors="replace")
        print(f"{label}: did not exit within 240s", flush=True)
        print("\n".join(output.splitlines()[-30:]), flush=True)
        failed = True

sys.exit(1 if failed else 0)
