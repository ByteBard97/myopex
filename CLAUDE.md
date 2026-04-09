# ui-audit — Claude Code Rules

## What This Is
CLI tool for AI agent UI verification. Extracts DOM properties + accessibility tree + component screenshots into a hierarchical YAML fingerprint.

## Commands
- `npm run dev -- capture --url <url> --out <dir> --state <name>`
- `npm run dev -- verify --url <url> --baseline <dir> --state <name>`
- `npm run dev -- diff --old <dir> --new <dir> --state <name>`

## Code Rules

Follows `../ClaudeCodeRules.md` (monorepo root). Key rules:
- Files under 500 lines (700 max). Ideally under 500.
- Tests for every module in extract/ and fingerprint/
- All browser interaction in extract/ directory only
- No hardcoded product-specific selectors — framework selectors (.vue-flow) are OK, project selectors (.device-node) go in config
- backendDOMNodeId is a CDP concept, NOT available in page.evaluate() — always use CDP bridge
- CDP sessions have in-flight message limits — if parallelizing cdp-resolve.ts, cap concurrency at 20-50
- Visual property extraction logic lives in visual-props.ts — do NOT duplicate in other files
