#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${OPENCLAW_WORKSPACE:-${1:-/srv/openclaw/workspace}}"
DEST="$WORKSPACE/skills"

mkdir -p "$DEST"
cp -a "$SCRIPT_DIR"/agents/* "$DEST"/

echo "Installed ShowRun OpenClaw skills to $DEST"
