---
name: myopex
description: Use PROACTIVELY whenever you touch frontend code — CSS, layout, components, theme, accessibility, responsive rules — before claiming the work is done. Myopex captures every UI state of the app as a structured YAML fingerprint + per-component screenshots in one browser boot, so you can read exact bounds, visibility, colors, and ARIA roles instead of guessing from pixels or from the user's screenshots. Also trigger on explicit phrases ("verify the UI", "audit the UI", "did I break X state", "snapshot the UI", "check the UI", "find a UI regression", "compare before/after", "run visual tests") and on descriptions of visual bugs ("the button is cut off", "text is overflowing", "the modal isn't showing", "the dark theme is broken"). Use when debugging UI bugs that span multiple states, when iterating on responsive or themed designs, and before merging or shipping frontend changes. Do NOT use for pure backend, CLI, data-pipeline, or non-visual work. This is the specific tool to reach for when an agent would otherwise say "the UI looks fine" without actually checking.
---

# Myopex — Structured UI verification for coding agents

Myopex captures every UI state of a web app as a hierarchical YAML fingerprint plus per-component screenshots, all in a single browser boot. You read the YAML to reason about layout; you open a screenshot only when the YAML flags something specific. This replaces ad-hoc `npx playwright`, pixel diffs, and asking the user for screenshots.

## When to use this skill

Use it:
- After any change to CSS, layout, components, theme tokens, ARIA attributes, or responsive rules — before you claim "done"
- When the user asks to verify, audit, snapshot, diff, or compare the UI
- When the user describes a visual bug that could span multiple states ("the X is broken on the error state")
- When iterating on a UI fix and you need structured feedback between attempts
- Before proposing a commit that touches frontend files

Do NOT use it for:
- Backend / API / CLI / data-pipeline changes with no visual surface
- A single "does this page load" check — `curl` is fine
- Pixel-perfect visual regression tests — use Percy/Chromatic for that; myopex is for *structure*, not pixels

## The core loop

```
1. Ensure myopex.scenarios.ts exists at the project root      (one-time, per project)
2. myopex scenarios --config myopex.scenarios.ts --out .myopex-baseline   (once, on known-good code)
   Note: "known-good" means the state you consider correct for the current task. On main, that's the
   last stable commit. On a feature branch, it's the state before your changes — a prior capture on
   the same branch is a valid baseline. The baseline doesn't have to be main.
3. Sanity-check the capture — see "Sanity-checking" below     (after every capture, not optional)
4. Make your code changes
5. myopex scenarios --config myopex.scenarios.ts --out .myopex-current
6. Sanity-check again
7. myopex diff --old .myopex-baseline --new .myopex-current   (writes report.json)
8. Read report.json — fix anything it surfaces — re-run from step 5 until clean
```

For single-state work, use `myopex capture` + `myopex verify` instead — same ideas, less ceremony.

## Sanity-checking a capture

Myopex exits 0 whenever the browser run completes — including when every region has zero components or every scenario's `steps` silently missed. Trusting that 0 exit code without looking at the output is the most common way this workflow wastes a diff round. After every capture, verify:

- **No region reports `0 components` in a part of the app that clearly has interactive UI.** If one does, either your selectors missed (see `references/scenarios-dsl.md`), or the app's interactive elements lack accessible names / testids (see Preflight, below). Fix before diffing.
- **Every scenario produced a `fingerprint-<name>.yaml`.** Missing files mean the scenario threw — check the CLI stderr for the scenario name and the error.
- **The top-level `page.landmarks` list matches what you expect.** If it's empty or missing `main`, the app's a11y markup is too thin; regions will be heuristic and diffs will be noisy.
- **A random spot-check of one region's YAML looks right.** Open the per-region screenshot alongside the YAML and confirm the components block reflects what you see.

Treat the capture as a first-class artifact you have to accept, not as exhaust from a command that "worked."

## Commands

| Command | Purpose | Notes |
|---|---|---|
| `myopex scenarios --config <f> [--url <u>] [--out <dir>]` | Capture every state in the config, one browser boot | Primary command. Defaults `--out` to `.myopex-scenarios` |
| `myopex capture [--url <u>] [--out <dir>] [--state <name>]` | Capture a single state | Quick sanity checks |
| `myopex verify [--url <u>] [--baseline <dir>]` | Capture live + diff against baseline | Exits 1 on regression — CI-safe |
| `myopex diff --old <dir> --new <dir>` | Compare two saved captures, no browser | Fastest; use after two `scenarios` runs. Auto-detects flat vs scenarios layout — point at the parent dirs and it loops over matching sub-scenarios for you |

If `--url` is omitted, myopex auto-starts a dev server via the project's `npm run dev`.

## Preflight: check the app is myopex-ready

Before writing a scenarios config, spend 60 seconds confirming the target app has the structural hooks myopex needs. Myopex reads the Chrome accessibility tree — it sees an element as a "component" only when that element has either (a) a stable accessible name (visible text content, `aria-label`, `alt`, or `aria-labelledby`) or (b) a `data-testid`. Apps built with icon-only buttons (Material Symbols, Lucide, Heroicons, etc.) routinely fail this test: the glyph renders, but the AX tree shows an unnamed button that component extraction cannot key off.

Do this check before writing scenarios:

1. Grep the app's component files for `data-testid`. If zero or very few hits, the app will capture regions but report `0 components` in them.
2. Grep for `aria-label`, especially on `<button>` and `<a>` elements inside headers, nav bars, and toolbars. Icon-only buttons without one are invisible to myopex.
3. If (1) and (2) both come up thin, stop and add `data-testid` (preferred — stable across i18n and a11y revisions) to the key interactive elements first: top nav buttons, primary actions, form submit buttons, modals' open triggers. Aim for 5–20 testids on the elements you care about verifying. Then write the scenarios using those testids as selectors.

Skipping this preflight costs at minimum one wasted capture round, as the agent has to notice "0 components" in the YAML and loop back. Doing it up front is strictly faster.

## Writing the scenarios config

`myopex.scenarios.ts` is a TypeScript file at the project root that default-exports `Scenario[]`. Each scenario describes how to reach one UI state:

- **URL-based** — `{ name: 'foo', url: 'http://localhost:5173/?modal=foo' }`
- **Declarative `steps`** — `{ name: 'foo', steps: [ { click: '...' }, { waitFor: '...' } ] }`
- **Raw `setup`** — `{ name: 'foo', setup: async (page) => { ... } }`

Mix freely; `steps` run before `setup`; both run before capture.

When writing a scenarios file for a project for the first time:

1. Read the app's routes, top-level components, and `data-testid` usage — don't write scenarios for states that don't exist or aren't reachable yet.
2. Prefer `data-testid` selectors over class names (class names churn; testids are stable).
3. Cover: default page load, each major route, each modal/drawer, each empty/loading/error state, each authenticated variant. Ten to twenty scenarios is a typical baseline for a nontrivial app.
4. Use `{ setLocalStorage: ... }` over custom login flows when the app supports token-based auth.
5. Start with the template at `assets/scenarios-template.ts` in this skill — copy it, adapt each entry to the real app, delete the ones that don't apply.

Full DSL reference: `references/scenarios-dsl.md`.

## Reading the YAML output

Each captured state writes `<outDir>/<state>/fingerprint-<state>.yaml`. Shape:

```yaml
version: 2
page: { url, title, viewport, theme, background, layout, landmarks, capturedAt }
regions:
  <regionKey>:
    role, bounds, background, childCount
    _estimated_tokens: N         # per-region budget hint
    _screenshotFile: screenshots/region-<key>.png
    components:
      - id: '<regionKey>/<role>["<name>"]'    # composite ID, stable across refactors
        props:
          role, name, bounds, visible, backgroundColor, color, fontSize,
          display, textOverflow, resolveStatus, screenshotFile
ungrouped: [...]       # data-testid elements outside any region
state: { name }
```

**Anomaly patterns to look for** (these are almost always bugs, no baseline needed):
- `visible: false` — element rendered but not displayed
- `backgroundColor: rgba(0, 0, 0, 0)` on a large container — theme probably didn't apply
- `textOverflow: true` — content is being truncated
- `bounds.width: 0` or `bounds.height: 0` — zero-sized element
- `resolveStatus: failed` — properties couldn't be extracted; do NOT trust the other fields on that component
- Region listed in `landmarks` but missing from `regions` — a11y markup present but structure broken

**Reading efficiently:** the top-level `regions` map is indexed by semantic key. Use `_estimated_tokens` to skip regions you don't need. Don't parse the whole file if the question is about one region.

**Required reading — not optional:** Before your first diff, read `references/reading-yaml.md` and `references/reading-diff.md` in full. They contain the anomaly cheat sheet, false-positive patterns, and composite ID anatomy you will need to triage findings correctly. Agents that skip them re-discover documented behavior and produce inaccurate triage.

## Reading the diff report

`verify` and `diff` write `report.json` with two sections:

- **`invariants`** — things always wrong regardless of baseline (invisible elements, transparent backgrounds on containers, overflowing text, zero dimensions).
- **`regressions`** — things that changed from baseline (visibility flips, color/style changes, layout shifts, missing or added regions/components). Match by composite ID (`regionKey/role["name"]` or `regionKey/testid["<id>"]`).

Numeric compares use tolerances: `bounds.width` ±50px, `bounds.height` ±30px, `bounds.x` / `bounds.y` ±100px. Anything within tolerance is not a regression.

Full triage guide: `references/reading-diff.md`.

## After `diff`: read the output — do NOT just run the command and move on

A completed `myopex` command is not a green light. "Scenarios captured" and "diff finished" aren't pass signals. The only pass signal is **reading `report.json` (or the printed summary) end-to-end and confirming every bucket is zero or investigated.**

The specific failure mode to avoid:

> Ran `myopex scenarios` + `myopex diff`, saw `Summary: 0 regressions`, concluded "all scenarios passed." Missed the 77 invariant failures printed directly above that summary line, because only the last line was read.

**Mandatory reading checklist after every `diff`:**

1. **Regressions** (new value ≠ baseline value). For each, decide: real regression → fix the code. Intended change → recapture the baseline. Don't dismiss one without picking one.
2. **Invariants** (always-wrong, no baseline needed). For each, decide: real bug → fix. False positive → confirm against the screenshot before dismissing. Never wave off a whole block of invariants without checking at least a representative sample.
3. **Missing regions / missing components.** An interactive element present in baseline but absent in current is almost always a real bug — check before accepting.
4. **Failed scenarios.** Listed in the capture-run warnings block. A scenario that threw isn't a pass; it just didn't produce data. Fix the scenario config or the app, then re-run.

When summarizing to the user, structure it as **`N regressions, M invariants (K confirmed bugs, J confirmed false positives, L to investigate)`**. Never write "passed" unless every bucket is zero or triaged.

**Common false-positive patterns worth spot-checking before accepting an invariant:**
- `backgroundColor: transparent` on a `testid["…"]`-IDed icon button / link. Fallback components (`resolveStatus: fallback`) don't carry a real ARIA role, so this invariant is suppressed on them automatically in recent versions — but if you see one survive, transparent is usually intended (inheriting from parent).
- `textOverflow: true` on a deliberately truncated element (ellipsis badges, truncated path chips).
- `visible: false` on a tooltip or menu that closed between `steps` and the capture.

When in doubt, open the component's `screenshotFile` — myopex emits it for precisely this kind of triage.

## Do-nots

- Don't fabricate scenarios for states the app doesn't expose yet. Read the component code first; confirm the state is reachable.
- Don't rely on ephemeral CSS-module class names (`.css-xY12Z`) in selectors — they hash-change between builds. Use `data-testid` or stable ARIA names.
- Don't skip `waitFor` after an async interaction — myopex will capture mid-transition and you'll chase phantom regressions.
- Don't use `myopex capture` when you have a scenarios config — `myopex scenarios` captures all states in one boot and is strictly faster.
- Don't treat a regression as a bug without checking whether the *baseline* was correct. Sometimes the new behavior is the intended one.

## Prerequisites

The project must have:
- Node.js ≥ 20
- `myopex` installed (globally via `npm install -g myopex`, or as a dev dep)
- Chromium via Playwright: `npx playwright install chromium` (one-time per machine)
- A dev server command in `package.json` (if `--url` is omitted, myopex starts it automatically)

## When in doubt

Ask: "Would a user who only sees the code I changed be able to tell from looking at it whether every UI state still renders correctly?" If the answer is "no — they'd have to run the app and click around," that's exactly when myopex pays for itself. Capture, diff, read the report.
