# ui-audit — Claude Code Rules

## What This Is
CLI tool for AI agent UI verification. Extracts DOM properties + accessibility tree + component screenshots into a hierarchical YAML fingerprint.

## Commands
- `npm run dev -- capture --url <url> --out <dir> --state <name>`
- `npm run dev -- verify --url <url> --baseline <dir> --state <name>`
- `npm run dev -- diff --old <dir> --new <dir> --state <name>`

## Code Rules
- Every file under 300 lines
- Tests for every module in extract/ and fingerprint/
- All browser interaction in extract/ directory only
- No hardcoded selectors — configuration-driven with automatic fallbacks
- backendDOMNodeId is a CDP concept, NOT available in page.evaluate() — always use CDP bridge
- CDP sessions have in-flight message limits — if parallelizing cdp-resolve.ts, cap concurrency at 20-50
