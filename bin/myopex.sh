#!/usr/bin/env bash
# myopex CLI wrapper — runs the tool from any directory
#
# Usage:
#   myopex capture [--url <url>] [--out <dir>] [--state <name>]
#   myopex verify  [--url <url>] [--baseline <dir>] [--state <name>]
#   myopex diff    --old <dir> --new <dir> [--state <name>]
#
# If no --url is provided, auto-starts a dev server.

set -euo pipefail

# Resolve symlinks so `npm link` / `npm install -g` work — $0 points at the
# symlink location (e.g. ~/.npm-global/bin/myopex), not the real script.
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"

exec npx tsx "$SCRIPT_DIR/src/cli.ts" "$@"
