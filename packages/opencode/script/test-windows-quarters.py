"""Run every OpenCode test in four bounded Windows Bun processes.

The complete 262-file suite can finish its assertions but keep Bun alive after
the summary. Splitting keeps every test and its 30-second timeout while making
the CI process exit observable. A missing summary, test failure, or a chunk
that does not exit is a hard failure.
"""

from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
TEST_DIR = ROOT / "test"
EXTENSIONS = (".test.ts", ".test.tsx", ".test.js", ".test.jsx",
              ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx")
FILES = sorted(str(path.relative_to(ROOT)) for path in TEST_DIR.rglob("*")
               if path.is_file() and path.name.endswith(EXTENSIONS))
if not FILES:
    raise SystemExit("no OpenCode tests discovered")

failed = False
for index in range(4):
    group = FILES[index * len(FILES) // 4:(index + 1) * len(FILES) // 4]
    print(f"OpenCode chunk {index + 1}/4: {len(group)} files; starting", flush=True)
    with tempfile.TemporaryFile(mode="w+t", encoding="utf8", errors="replace") as log:
        process = subprocess.Popen(
            ["bun", "test", "--timeout", "30000", "--only-failures", *group],
            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
        )
        started = time.monotonic()
        while True:
            try:
                code = process.wait(timeout=30)
                break
            except subprocess.TimeoutExpired:
                elapsed = time.monotonic() - started
                print(f"OpenCode chunk {index + 1}/4: still running after {elapsed:.0f}s", flush=True)
                if elapsed < 600:
                    continue
                process.kill()
                process.wait()
                code = -1
                break

        log.seek(0)
        output = log.read()
        print(f"OpenCode chunk {index + 1}/4: exit={code}, elapsed={time.monotonic() - started:.0f}s", flush=True)
        summary = next((line for line in output.splitlines() if re.search(r"Ran \d+ tests across", line)), None)
        if code != 0 or summary is None:
            failed = True
            print("\n".join(output.splitlines()[-100:]), flush=True)
        else:
            for line in output.splitlines():
                if re.search(r"\b\d+ (pass|fail|skip)\b|Ran \d+ tests across", line):
                    print(line[:300], flush=True)

sys.exit(1 if failed else 0)
