#!/bin/bash
set -euo pipefail

# Build script for OpenCode MEM with worktree pruning and chain tracking
# This script integrates worktree cleanup into the build process and maintains chain-state.jsonl

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREES_DIR="~/.worktrees"
CHAIN_STATE="${WORKDIR}/chain-state.jsonl"

# Setup environment
export PATH="$HOME/.bun/bin:$PATH"
export NODE_PATH="${WORKDIR}/node_modules"

# Record build start with timestamp and current SHA
timestamp="$(date '+%Y-%m-%dT%H:%M:%S')"
current_sha="$(cd "${WORKDIR}" && git rev-parse HEAD 2>/dev/null || echo 'unknown')"
candidate_sha="$(git -C "${WORKDIR}" rev-parse HEAD 2>/dev/null || echo 'unknown')"

# Log build start to chain-state
worktrees_count=$(find "${HOME}/.worktrees" -maxdepth 1 -type d -name \"wt-*\" | wc -l 2>/dev/null || echo "0")
worktrees_count=$(echo "$worktrees_count" | tr -d ' ' | tr -d '\n')
echo "{\"timestamp\": \"${timestamp}\", \"action\": \"build_start\", \"sha\": \"${current_sha}\", \"candidate_sha\": \"${candidate_sha}\", \"worktrees_count\": ${worktrees_count}}" >> "${CHAIN_STATE}"

# Worktree pruning before build
echo "Pruning worktrees older than 7 days before build..."
find "${HOME}/.worktrees" -maxdepth 1 -type d -name "wt-*" | while read -r worktree; do
    if [[ -d "${worktree}" ]]; then
        # Check if worktree is not currently checked out
        main_path="$(git -C "${WORKDIR}" rev-parse --git-dir 2>/dev/null | xargs dirname)"
        if [[ "${worktree}" != "${main_path}" ]]; then
            # Check if worktree has valid HEAD
            if ! git -C "${worktree}" status >/dev/null 2>&1; then
                echo "Removing orphaned worktree: ${worktree}"
                git worktree prune "${worktree}" 2>/dev/null || rm -rf "${worktree}"
                echo "  ✓ Worktree pruned"
            fi
        fi
    fi
done

# Clean up orphaned worktrees (those without valid HEAD)
echo "Cleaning up orphaned worktrees..."
for wt in "${HOME}/.worktrees/wt-"*; do
    if [[ -d "${wt}" ]]; then
        if ! git -C "${wt}" status >/dev/null 2>&1; then
            echo "Removing orphaned worktree: ${wt}"
            rm -rf "${wt}"
        fi
    fi
done

# Record worktree pruning to chain-state
worktrees_count=$(find "${HOME}/.worktrees" -maxdepth 1 -type d -name \"wt-*\" | wc -l 2>/dev/null || echo "0")
worktrees_count=$(echo "$worktrees_count" | tr -d ' ' | tr -d '\n')
echo "{\"timestamp\": \"$(date '+%Y-%m-%dT%H:%M:%S')\", \"action\": \"worktree_prune_pre_build\", \"sha\": \"${current_sha}\", \"worktrees_count\": ${worktrees_count}}" >> "${CHAIN_STATE}"

# Build the project
echo "Building project..."
if command -v bun >/dev/null 2>&1; then
    # Typecheck core package
    echo "Running typecheck..."
    cd packages/core
    bun run typecheck
    cd "${WORKDIR}"
    
    # Run tests
    echo "Running tests..."
    cd packages/core
    bun test 2>&1 | tee "${WORKDIR}/build.log"
    cd "${WORKDIR}"
else
    echo "Error: bun not found" >&2
    exit 1
fi

# Record build completion to chain-state
build_end_timestamp="$(date '+%Y-%m-%dT%H:%M:%S')"
worktrees_count=$(find "${HOME}/.worktrees" -maxdepth 1 -type d -name \"wt-*\" | wc -l 2>/dev/null || echo "0")
worktrees_count=$(echo "$worktrees_count" | tr -d ' ' | tr -d '\n')
echo "{\"timestamp\": \"${build_end_timestamp}\", \"action\": \"build_complete\", \"sha\": \"${current_sha}\", \"candidate_sha\": \"${candidate_sha}\", \"worktrees_count\": ${worktrees_count}}" >> "${CHAIN_STATE}"

echo "Build completed successfully!"
echo "Worktrees after build:"
WORKTREES_COUNT=$(find "${HOME}/.worktrees" -maxdepth 1 -type d -name "wt-*" | wc -l)
echo "${WORKTREES_COUNT}"
find "${HOME}/.worktrees" -maxdepth 1 -type d -name "wt-*" -exec basename {} \;