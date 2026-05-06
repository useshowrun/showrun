#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CLAUDE_AGENTS_DIR:-${1:-$HOME/.claude/agents}}"

mkdir -p "$DEST"

for skill_dir in "$SCRIPT_DIR"/showrun-*/; do
    name="$(basename "$skill_dir")"
    cp "$skill_dir/SKILL.md" "$DEST/$name.md"
done

echo "Installed ShowRun Claude Code agents to $DEST"
