#!/bin/bash
# Initialize the chain-state.jsonl file for tracking the OpenCode MEM chain
# This script creates the initial chain state and demonstrates worktree pruning integration

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."
CHAIN_STATE="${WORKDIR}/chain-state.jsonl"

# Create chain-state.jsonl with initial entry
timestamp="$(date '+%Y-%m-%dT%H:%M:%S')"
current_sha="$(git -C "${WORKDIR}" rev-parse HEAD 2>/dev/null || echo 'unknown')"

# Get worktrees count safely
worktrees_count=0
if find "~/.worktrees" -maxdepth 1 -type d -name "wt-*" 2>/dev/null >/dev/null; then
    worktrees_count=$(find "~/.worktrees" -maxdepth 1 -type d -name "wt-*" 2>/dev/null | wc -l)
    worktrees_count=$(echo "$worktrees_count" | tr -d ' ' | tr -d '\n')
fi

# Initial chain entry
echo "{\"timestamp\": \"${timestamp}\", \"action\": \"chain_initialized\", \"sha\": \"${current_sha}\", \"worktrees_count\": ${worktrees_count}, \"description\": \"OpenCode MEM chain initialized with worktree pruning integration\"}" > "${CHAIN_STATE}"

echo "Chain initialized successfully!"
echo "Chain state file: ${CHAIN_STATE}"
cat "${CHAIN_STATE}"

# Show current branch and commit
echo "=== Current Branch/State ==="
echo "Repository: ${WORKDIR}"
echo "Current branch: $(git -C "${WORKDIR}" branch --show-current 2>/dev/null || echo 'unknown')"
echo "Current commit: $(git -C "${WORKDIR}" rev-parse HEAD 2>/dev/null || echo 'unknown')"

# Show worktrees state
echo "=== Worktree State ==="
echo "Current worktrees:"
if find "~/.worktrees" -maxdepth 1 -type d -name "wt-*" 2>/dev/null | head -1 >/dev/null; then
    find "~/.worktrees" -maxdepth 1 -type d -name "wt-*" 2>/dev/null | while read -r wt; do
        if [[ -d "${wt}" ]]; then
            sha="$(git -C "${wt}" rev-parse HEAD 2>/dev/null || echo 'unknown')"
            echo "  - ${wt} (SHA: ${sha})"
        fi
    done
else
    echo "  (none)"
fi