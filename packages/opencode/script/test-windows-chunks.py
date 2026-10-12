"""Run every OpenCode test in small bounded Windows Bun processes.

Large Windows Bun suites can retain handles after the assertions finish and
cause unrelated CLI tests to miss their readiness deadline under accumulated
load. Each file is assigned to exactly one chunk. A missing summary, test
failure, or a chunk that does not exit is a hard failure.
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

CHUNKS = 16
failed = []
for index in range(CHUNKS):
    group = FILES[index * len(FILES) // CHUNKS:(index + 1) * len(FILES) // CHUNKS]
    print(f"OpenCode chunk {index + 1}/{CHUNKS}: {len(group)} files; starting", flush=True)
    print("\n".join(group), flush=True)
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
                print(f"OpenCode chunk {index + 1}/{CHUNKS}: still running after {elapsed:.0f}s", flush=True)
                if elapsed < 300:
                    continue
                process.kill()
                process.wait()
                code = -1
                break

        log.seek(0)
        output = log.read()
        print(f"OpenCode chunk {index + 1}/{CHUNKS}: exit={code}, elapsed={time.monotonic() - started:.0f}s", flush=True)
        summary = next((line for line in output.splitlines() if re.search(r"Ran \d+ tests across", line)), None)
        if code != 0 or summary is None:
            print("\n".join(output.splitlines()[-100:]), flush=True)
            failed.append(index + 1)
            continue
        for line in output.splitlines():
            if re.search(r"\b\d+ (pass|fail|skip)\b|Ran \d+ tests across", line):
                print(line[:300], flush=True)

if failed:
    print(f"Failed OpenCode chunks: {failed}", flush=True)
    sys.exit(1)
