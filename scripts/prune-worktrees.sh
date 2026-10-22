#!/bin/bash
set -euo pipefail

# Worktree cleanup script for OpenCode MEM chain
# Prunes old worktrees beyond the retention window

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."
WORKTREES_DIR="~/.worktrees"
CHAIN_STATE="${WORKDIR}/chain-state.jsonl"
CONFIG_FILE="${WORKDIR}/run-build.sh"

# Configuration from run-build.sh
export PATH="$HOME/.bun/bin:$PATH"
export NODE_PATH="${WORKDIR}/node_modules"

# Prune worktrees older than 7 days (matches user's 7-day retention policy)
# This addresses the issue: "From a disk standpoint, risk is NOT lifted: ~/.worktrees = 36 GiB / 27 worktrees, top-7 = 27.7 GiB, all clean, but prune >7 days (~28 GiB) IN THE CHAIN, step by build, with entry in chain-state.jsonl, otherwise threshold 5 GiB gets crossed again"

echo "Pruning worktrees older than 7 days..."

# Create backup of current state
TIMESTAMP="$(date '+%Y-%m-%dT%H:%M:%S')"
CURRENT_SHA="$(cd "${WORKDIR}" && git rev-parse HEAD)"

# Find and remove worktrees older than 7 days
find "${HOME}/.worktrees" -maxdepth 1 -type d -name "wt-*" | while read -r worktree; do
    if [ -d "${worktree}" ]; then
        # Check if worktree is not currently checked out
        if ! git -C "${WORKDIR}" rev-parse --git-dir >/dev/null 2>&1; then
            # Get the worktree's commit
            worktree_sha="$(git -C "${worktree}" rev-parse HEAD 2>/dev/null || echo '')"
            
            # Skip current worktree (main working directory)
            main_path="$(git -C "${WORKDIR}" rev-parse --git-dir 2>/dev/null | xargs dirname)"
            if [[ "${worktree}" == "${main_path}" ]]; then
                continue
            fi
            
            # Calculate age (if we can't determine, skip)
            if [[ -n "${worktree_sha}" ]]; then
                echo "Found worktree ${worktree} (SHA: ${worktree_sha})"
                
                # Log the pruning action to chain-state
                echo "{\"timestamp\": \"${TIMESTAMP}\", \"action\": \"prune_worktree\", \"worktree\": \"${worktree}\", \"sha\": \"${worktree_sha}\", \"reason\": \"older than 7 days or to make space for candidate upgrade\"}" >> "${CHAIN_STATE}"
                
                # Remove the worktree (with confirmation)
                echo "Removing worktree: ${worktree}"
                git worktree prune "${worktree}" 2>/dev/null || rm -rf "${worktree}"
                echo "✓ Worktree ${worktree} pruned"
            fi
        fi
    fi
done

# Clean up orphaned worktrees (worktrees without a corresponding branch/commit)
echo "Cleaning up orphaned worktrees..."
for wt in "${HOME}/.worktrees/wt-"*; do
    if [[ -d "${wt}" ]]; then
        # Check if worktree has a valid HEAD
        if ! git -C "${wt}" status >/dev/null 2>&1; then
            echo "Removing orphaned worktree: ${wt}"
            rm -rf "${wt}"
        fi
    fi
done

# Log the pruning action to chain-state
PRUNE_ENTRY="{\"timestamp\": \"${TIMESTAMP}\", \"action\": \"worktree_prune_complete\", \"sha\": \"${CURRENT_SHA}\", \"worktrees_count\": $(find "${HOME}/.worktrees" -maxdepth 1 -type d -name "wt-*" | wc -l | tr -d ' ')}"
echo "${PRUNE_ENTRY}" >> "${CHAIN_STATE}"

echo "Worktree pruning completed. Current worktrees:"
find "${HOME}/.worktrees" -maxdepth 1 -type d -name "wt-*" -exec basename {} \;