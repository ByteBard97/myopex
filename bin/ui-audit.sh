#!/usr/bin/env bash
# ui-audit CLI wrapper — runs the tool from any directory
#
# Usage:
#   ui-audit capture [--url <url>] [--out <dir>] [--state <name>]
#   ui-audit verify  [--url <url>] [--baseline <dir>] [--state <name>]
#   ui-audit diff    --old <dir> --new <dir> [--state <name>]
#
# If no --url is provided, auto-starts a dev server.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec npx tsx "$SCRIPT_DIR/src/cli.ts" "$@"
