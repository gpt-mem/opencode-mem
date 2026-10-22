#!/usr/bin/env python3
"""Compare an orphaned worktree's files against a git ref's tree.

Used by the prune step: an orphaned worktree (dangling .git) can only be
deleted if its content is already preserved in the repository.
"""
import hashlib
import os
import subprocess
import sys

REPO = "/Users/vova/code/opencode-mem-work"
IGNORE_DIRS = {"node_modules", "dist", ".next", "coverage", ".turbo", ".cache", "build"}


def blob_hash(path: str) -> str:
    h = hashlib.sha1()
    h.update(b"blob %d\0" % os.path.getsize(path))
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tree_hashes(ref: str) -> dict:
    out = subprocess.run(
        ["git", "-C", REPO, "ls-tree", "-r", ref], capture_output=True, text=True, check=True
    ).stdout
    result = {}
    for line in out.splitlines():
        meta, path = line.split("\t", 1)
        _mode, _type, sha = meta.split()
        result[path] = sha
    return result


def worktree_files(root: str) -> dict:
    result = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS and d != ".git"]
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            if rel.startswith(".git/") or "/.git/" in rel:
                continue
            try:
                result[rel] = blob_hash(full)
            except OSError:
                pass
    return result


def main() -> int:
    root, ref = sys.argv[1], sys.argv[2]
    tree = tree_hashes(ref)
    files = worktree_files(root)
    same, differ, extra = [], [], []
    for path, sha in files.items():
        if path not in tree:
            extra.append(path)
        elif tree[path] == sha:
            same.append(path)
        else:
            differ.append(path)
    missing = [p for p in tree if p not in files]
    print(f"ref={ref} tree_files={len(tree)} worktree_files={len(files)}")
    print(f"identical={len(same)} differ={len(differ)} extra_in_worktree={len(extra)} missing_in_worktree={len(missing)}")
    for path in differ[:10]:
        print("  DIFF ", path)
    for path in extra[:10]:
        print("  EXTRA", path)
    for path in missing[:10]:
        print("  MISS ", path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
