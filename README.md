# ui-audit

> **Structured UI snapshots for coding agents.** Capture every state of your app — default, drawer-open, error, empty — in one browser boot. Now your agent can sanity-check what it just built by reading a YAML file instead of booting Playwright every time.

---

## The problem

You're vibe-coding an app with Claude Code, Cursor, or Aider. The agent changes a flex layout and confidently says *"done."* The save button is now invisible on the error state. You don't find out until you click around manually — or worse, until you ship.

"Just let the agent run Playwright." Sure — 15-30 seconds of browser boot **per check**, and the agent still has to describe a screenshot in words. Agents get impatient. They check one state. They skip. They lie.

## The fix

`ui-audit` captures all your app's UI states in **a single browser session** and writes a structured YAML file per state with the accessibility tree, computed styles, bounds, and per-component screenshots. Your agent reads the YAML, sees exactly what's on the page, and diffs against a known-good baseline — no pixel guessing, no browser reboot tax.

- **One browser boot, all states.** 10 states in one run, not 10 cold starts.
- **Smart settle.** Uses `networkidle` as the primary signal, not a flat 4-second sleep. Responsive apps capture in under a second.
- **YAML output designed for LLMs.** Stable semantic IDs, per-region token counts, no pixel diffs.
- **Declarative state config.** No Playwright knowledge required — or let Claude write the config for you in 30 seconds.
- **Structured diff reports.** Cleanly separates "this is broken regardless of baseline" from "this changed from last known-good."

## Install

```bash
git clone https://github.com/bytebard97/ui-audit.git
cd ui-audit
npm install
npx playwright install chromium
npm link    # makes `ui-audit` globally available
```

Requires Node.js >= 20.

Not published to npm yet — that's next. For now, `npm link` from a clone works the same way.

---

## Quick start (2 minutes)

**Step 1.** Define your app's UI states in `ui-audit.scenarios.ts` at your project root:

```ts
// ui-audit.scenarios.ts
export default [
  { name: 'home' },
  { name: 'settings', url: 'http://localhost:5173/?modal=settings' },
  { name: 'drawer-open', steps: [
      { click: '[data-testid=menu-button]' },
      { waitFor: '.drawer.open' },
  ]},
  { name: 'empty', steps: [
      { evaluate: 'localStorage.clear()' },
      { goto: 'http://localhost:5173' },
  ]},
]
```

**Step 2.** Capture all states in one command:

```bash
ui-audit scenarios --url http://localhost:5173 --config ui-audit.scenarios.ts
```

One browser boot, every state captured. Now you have:

```
.ui-audit-scenarios/
├── home/
│   ├── fingerprint-home.yaml
│   ├── full-page.png
│   └── screenshots/        ← per-component PNGs
├── settings/
│   └── ...
├── drawer-open/
│   └── ...
└── empty/
    └── ...
```

**Step 3.** Let your agent read the YAML. After your agent makes changes, re-run the same command and diff.

## Don't want to write the scenarios yourself?

You're already using a coding agent. Just tell it:

> Read my app code and write a `ui-audit.scenarios.ts` that covers every meaningful UI state. Use the `steps` DSL for interactions, `url` for route-based states, and `setup` for anything else. See `examples/ui-audit.scenarios.ts` for the format.

Claude already knows your codebase and how to write selectors from your components. This takes about 30 seconds. **You never have to touch Playwright.**

---

## Defining states: three ways

Pick whichever fits each scenario. You can mix all three in the same config.

### 1. URL-based (zero code)

Already have `?modal=settings` or route-based states? Just point at them.

```ts
{ name: 'settings', url: 'http://localhost:5173/?modal=settings' }
```

### 2. Declarative `steps` (no Playwright knowledge)

For states that need clicks, form fills, or hovers before capture.

```ts
{ name: 'login-error', steps: [
  { fill: 'input[name=email]', value: 'broken@test.com' },
  { fill: 'input[name=password]', value: 'wrong' },
  { click: 'button[type=submit]' },
  { waitFor: '.error-message' },
]}
```

Available steps:

| Step | Description |
|---|---|
| `{ click: selector }` | Click an element |
| `{ fill: selector, value: string }` | Type into an input |
| `{ press: selector, key: string }` | Press a key (`Enter`, `Escape`, etc.) |
| `{ hover: selector }` | Hover over an element |
| `{ select: selector, value: string }` | Choose a dropdown option |
| `{ waitFor: selector }` | Wait for an element to appear |
| `{ wait: ms }` | Wait N milliseconds (use sparingly) |
| `{ goto: url }` | Navigate to a different URL |
| `{ evaluate: "js code" }` | Run arbitrary JS (e.g. `localStorage.clear()`) |
| `{ setLocalStorage: { key: value } }` | Set localStorage entries |

### 3. Raw Playwright `setup` (power mode)

For anything the DSL can't express — route mocking, conditional logic, complex waits:

```ts
{ name: 'api-error', setup: async (page) => {
  await page.route('**/api/**', (route) => route.abort())
  await page.reload()
}}
```

**Mixing them:** `steps` run first, then `setup`, then capture. Use per-scenario `settleMs` to override the settle ceiling for slow pages. See `examples/ui-audit.scenarios.ts` for the full reference.

---

## Commands

### `scenarios` — capture all states at once (recommended)

```bash
ui-audit scenarios --url http://localhost:5173 --config ui-audit.scenarios.ts
```

One browser boot, every state in your config, smart network-idle wait per state. **This is the command you want 90% of the time.**

### `capture` — single snapshot

```bash
ui-audit capture --url http://localhost:5173 --out .ui-audit --state default
```

Use when you just want the current state on disk.

### `verify` — compare against a baseline

```bash
ui-audit verify --url http://localhost:5173 --baseline .ui-audit
```

Exits **0 on pass, 1 on regression**. Writes `report.json` with structured diff output. Drop it into CI.

### `diff` — offline comparison (no browser)

```bash
ui-audit diff --old .ui-audit-before --new .ui-audit-after
```

Compares two saved fingerprints without booting a browser. Useful for investigating what changed after the fact.

---

## Output format

Each state produces a `fingerprint-<state>.yaml` that looks like this:

```yaml
version: 2
page:
  url: http://localhost:5173/
  title: SignalCanvas
  viewport: { width: 1440, height: 900 }
  theme: dark
  background: rgb(15, 23, 42)
  layout: header + sidebar + main + footer
  landmarks: [banner, navigation, main, contentinfo]
  capturedAt: 2026-04-11T14:30:00.000Z
regions:
  navigation:
    role: navigation
    bounds: { x: 0, y: 0, width: 48, height: 900 }
    background: rgb(30, 41, 59)
    childCount: 3
    _estimated_tokens: 280
    _screenshotFile: screenshots/region-navigation.png
    components:
      - id: 'navigation/button["Home"]'
        props:
          role: button
          name: Home
          bounds: { x: 0, y: 48, width: 48, height: 48 }
          visible: true
          backgroundColor: rgba(0, 0, 0, 0)
          color: rgb(148, 163, 184)
          fontSize: 16px
          display: block
          textOverflow: false
          textContent: H
          childCount: 0
          resolveStatus: ok
          screenshotFile: screenshots/navigation-button-Home-.png
ungrouped: []
state:
  name: home
```

Key design choices:

- **Composite IDs** (`regionKey/role["name"]`) stay stable across runs — they survive DOM refactors that would break selector-based IDs.
- **`resolveStatus`** (`ok` / `fallback` / `failed`) tells agents whether a component's properties were extracted reliably.
- **`_estimated_tokens`** per region lets agents budget their context window — load only the regions they actually need.
- **`ungrouped`** — `data-testid` elements outside any region aren't silently dropped.

---

## Diff report

`verify` and `diff` produce a `FullDiffReport` with two cleanly separated sections:

### Invariants — always-wrong issues (regardless of baseline)

- Element not visible
- Transparent background (theme not applied?)
- Text overflowing / truncated
- Zero width or height

These are bugs in the **current** page, full stop. No baseline needed.

### Regressions — changes from known-good (matched by composite ID)

- Exact compares: `visible`, `backgroundColor`, `display`, `textOverflow`
- Numeric compares with tolerance: `bounds.width` (±50px), `bounds.height` (±30px), `bounds.x` / `bounds.y` (±100px)
- Missing or added regions and components

The split matters because they require different responses from an agent: invariant failures always need fixing, regressions only need investigation if the baseline was correct.

---

## How it works

```
Page load
  ↓
Smart settle (networkidle with fallback ceiling)
  ↓
CDP Accessibility.getFullAXTree()
  ↓
Region discovery — 5-level fallback:
  1. ARIA landmarks (banner, navigation, main, complementary, contentinfo)
  2. Semantic HTML (<header>, <nav>, <main>, <aside>, <footer>)
  3. Framework selectors (.vue-flow, [data-canvas], ...)
  4. [data-testid] elements (collected as components, not regions)
  5. Config-file selectors (optional, additive)
  ↓
Batched CDP DOM.resolveNode + Runtime.callFunctionOn (30 nodes/batch)
  (backendDOMNodeId → RemoteObjectId → getComputedStyle + getBoundingClientRect)
  ↓
Merge into UIFingerprint hierarchy
  ↓
YAML serialization + per-region + per-component screenshots
```

The CDP bridge is necessary because `backendDOMNodeId` is a Chrome DevTools Protocol concept that doesn't exist in the browser JS context — you cannot do this in a single `page.evaluate()` call.

---

## How is this different from X?

Short answer: **it's the only tool built around the agent feedback loop.** Long answer:

| Tool | What it does | Why it doesn't solve this |
|---|---|---|
| **Percy / Chromatic / Applitools** | Pixel-diff visual regression | Great for humans reviewing a dashboard, opaque to LLMs — an agent sees "these pixels differ" and has to guess what changed |
| **Playwright `toHaveScreenshot`** | Pixel snapshots in test runner | Same — pixel diffs, no structured data |
| **axe-core / pa11y / Lighthouse** | Accessibility violations + perf audits | Finds a11y bugs; doesn't fingerprint layout or track regressions |
| **Playwright `page.accessibility.snapshot()`** | Raw AX tree JSON | Just the tree — no bounds, no styles, no screenshots, no diff engine, no baseline format |
| **Playwright MCP / browser-use / Stagehand** | Let LLMs drive browsers via AX tree | They're for *driving* (click this, type that), not *verifying state* after a code change |
| **Storybook + Chromatic** | Per-story visual regression | Requires you to write stories per state; doesn't capture real app states in context |
| **Claude Computer Use / Operator** | Pure vision | No structure at all — the whole point of `ui-audit` is to give the agent something cheaper than pixels to reason about |

`ui-audit` is specifically for: *agent edits code → `ui-audit scenarios` → agent reads structured diff → agent fixes → loop.* The closest adjacent is Playwright MCP, but it boots a browser for every question and is designed for action, not verification.

---

## Claude Code / Cursor / Aider workflow

1. **Once:** Ask your agent to write `ui-audit.scenarios.ts` for your app (or write it yourself in 5 minutes).
2. **Once:** `ui-audit scenarios --url http://localhost:5173 --config ui-audit.scenarios.ts --out .ui-audit-baseline` — capture the known-good baseline.
3. **Every iteration:** agent edits code → `ui-audit scenarios --out .ui-audit-current` → `ui-audit diff --old .ui-audit-baseline --new .ui-audit-current` → agent reads `report.json` → agent fixes.
4. **In CI:** `ui-audit verify --baseline .ui-audit-baseline` — exits 1 on regression, 0 on pass.

The agent reads structured YAML for context, and only opens the per-component PNGs when a specific component is flagged in the diff. That keeps token usage predictable and focused.

---

## Limitations (honest list)

Reddit-proofing section. The things this tool does **not** do:

- **Single viewport.** Defaults to 1440×900. No responsive breakpoint matrix yet.
- **No color contrast checking.** Use `axe-core` for accessibility violations — different tool, different job.
- **Doesn't catch animation / transition bugs.** Animations are intentionally disabled during capture for deterministic screenshots.
- **Doesn't handle iframes.** The CDP bridge operates on the top-level document.
- **Requires semantic HTML or ARIA to be useful.** The more `<main>`, `<nav>`, `role="..."`, and `aria-label` your app uses, the better the fingerprint. A class-soup `<div>` stack will produce a thin output.
- **Dark mode by default.** `colorScheme: 'dark'` is the default context. Override in code if you test light mode.
- **Not on npm yet.** Use `git clone` + `npm link` for now.

---

## Tech stack

- **Playwright** — browser automation + element screenshots
- **Chrome DevTools Protocol** — accessibility tree + DOM node resolution
- **TypeScript** — strict mode, ES2022 target
- **yaml** — serialize / deserialize
- **vitest** — unit + integration tests across `extract/` and `fingerprint/`

## License

MIT — see `LICENSE`.
