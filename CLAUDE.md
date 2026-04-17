# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`myopex` — CLI that captures every UI state of a web app as a hierarchical YAML fingerprint + per-component screenshots in one browser boot. Target users are coding agents that edit frontends and need structured UI verification instead of pixel diffs or "look at this screenshot" prompts. README.md is the user-facing reference; this file is the developer one.

## Commands

```
# scenarios — primary command; captures every state from myopex.scenarios.ts
myopex scenarios --config myopex.scenarios.ts --url http://localhost:5173 --out .myopex-baseline

# single-state capture
myopex capture --url <url> --out <dir> --state <name>

# capture live + diff against saved baseline (exit 1 on regression — CI-safe)
myopex verify --url <url> --baseline <dir>

# compare two saved captures; auto-detects flat vs scenarios layout
myopex diff --old <dir> --new <dir>

# tests (vitest)
npm test                    # full suite
npx vitest run <path>       # single file
npx vitest watch            # watch mode
```

Run `npm link` once in this repo to make `myopex` global on your $PATH. The `bin/myopex.sh` wrapper resolves symlinks so `npm install -g myopex` also works post-publish.

## Architecture big picture

The capture pipeline has four moving parts that span multiple files — changes in any one need to consider the others:

**1. Region discovery — five-tier fallback chain** (`src/extract/region-discovery.ts`). Regions (top-level containers) are found via:
1. ARIA landmarks (banner, navigation, main, complementary, contentinfo, form, search) from the CDP AX tree
2. ARIA dialogs (`role=dialog`/`alertdialog`) — handles teleported modals (Vue `<Teleport>`, React portals) that live outside any landmark
3. Semantic HTML tags (`<header>`, `<nav>`, etc.) — fills gaps tier 1 didn't cover
4. Framework selectors (`.vue-flow`, `[data-canvas]`) from `constants.FRAMEWORK_SELECTORS`
5. User-provided config selectors (additive)

`[data-testid]` elements are **not** regions — they're collected separately and injected as components into whichever region contains them by bounds overlap.

**2. CDP bridge — `backendDOMNodeId` → `RemoteObjectId` → live DOM** (`src/extract/accessibility.ts`, `cdp-resolve.ts`, `visual-props.ts`). `backendDOMNodeId` is a Chrome DevTools Protocol concept; it does NOT exist inside `page.evaluate()`. To extract computed styles and bounds you must go through CDP (`DOM.resolveNode` → `Runtime.callFunctionOn`). Don't try to shortcut this in page.evaluate — it won't work. CDP sessions have in-flight message limits; if parallelizing calls in `cdp-resolve.ts`, cap concurrency at 20–50.

**3. Component extraction — two paths, three `resolveStatus` states** (`src/extract/merge.ts`). Components come from:
- **AX-tree path** — real ARIA roles (`button`, `link`, `tab`, etc.). `resolveStatus: 'ok'` when CDP visual props resolved, `'failed'` when they didn't (other fields are placeholder; don't trust them).
- **Testid-injection path** — stamped `role: 'generic'`, `resolveStatus: 'fallback'`. Visual props ARE reliable; the role is not. Invariants that depend on role (e.g., the transparent-background check in `diff-engine.ts`) must skip `fallback` components, because `generic` lies about what kind of element it actually is.

**4. Scenarios — one browser, fresh page per state** (`src/scenarios.ts`). `runScenarios` launches Chromium once and opens a new Page per scenario (prevents state leakage between runs). `captureFromPage` is the non-lifecycle-managing variant of `runCapture` — use it when you already have a Page. Action steps use a 5-second default timeout so typo'd selectors fail fast; `{ wait: N }` and `setup` are the escapes for legitimate long waits.

## Claude Code plugin

`claude-plugin/` ships inside the npm package and contains a Claude Code skill (`skills/myopex/SKILL.md` + references) and a slash command (`commands/myopex-verify.md`). The skill teaches agents when to run myopex and how to read the YAML + diff report. Any tool-level behavior change that affects the workflow — new invariants, new output fields, CLI flag changes, discovery tier additions — needs a corresponding edit to the skill docs so the two don't drift. Local install is a symlink into `~/.claude/skills/myopex` and `~/.claude/commands/myopex-verify.md`; edits to source files propagate immediately.

## Repo-specific code rules

Follows `../ClaudeCodeRules.md` (monorepo root). Specifics that sharpen the general rules for this repo:

- Files under 500 lines (700 max). `merge.ts` is the longest today — keep it there.
- All browser/Playwright interaction stays in `src/extract/`. `capture.ts` and `scenarios.ts` orchestrate but should not reach into Page internals beyond the helpers extract/ exposes.
- No hardcoded product-specific selectors. Framework-generic ones (`.vue-flow`, `[data-canvas]`) go in `constants.FRAMEWORK_SELECTORS`; project-specific ones go in the user's scenarios config.
- Visual property extraction (computed styles, bounds, visibility) lives in `visual-props.ts` only — don't duplicate it.
- Every module in `extract/` and `fingerprint/` has a matching test under `tests/` with the same path. New modules need tests before merging.
- Never use `rm`. Use `trash`. No exceptions.
