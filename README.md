# myopex

> Your coding agent is brilliant and legally blind. Myopex fixes the second problem.

Capture every UI state of your app as a structured YAML fingerprint + screenshots in one browser boot. Your agent reads the diff instead of squinting at pixels.

---

## The problem

You're vibe-coding with Claude Code, Cursor, or Aider. The agent changes a flex layout and confidently says *"done."* The save button is now invisible on the error state. You don't find out until you click around manually — or worse, until you ship.

"Just let the agent run Playwright." Sure — 15-30 seconds of browser boot **per check**, and the agent still has to describe a screenshot in words. Agents get impatient. They check one state. They skip. They lie.

## The fix

`myopex` captures all your app's UI states in **a single browser session** and writes a structured YAML file per state with the accessibility tree, computed styles, bounds, and per-component screenshots. Your agent reads the YAML, sees exactly what's on the page, and diffs against a known-good baseline — no pixel guessing, no browser reboot tax.

- **One browser boot, all states.** 10 states in one run, not 10 cold starts.
- **Smart settle.** Uses `networkidle` as the primary signal, not a flat 4-second sleep. Responsive apps capture in under a second.
- **YAML output designed for LLMs.** Stable semantic IDs, per-region token counts, no pixel diffs.
- **Declarative state config.** No Playwright knowledge required — or let Claude write the config for you in 30 seconds.
- **Structured diff reports.** Cleanly separates "this is broken regardless of baseline" from "this changed from last known-good."

## Install

```bash
npm install -g myopex
npx playwright install chromium
```

Requires Node.js >= 20.

---

## Quick start (2 minutes)

**Step 1.** Define your app's UI states in `myopex.scenarios.ts` at your project root:

```ts
// myopex.scenarios.ts
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
myopex scenarios --url http://localhost:5173 --config myopex.scenarios.ts
```

One browser boot, every state captured. Now you have:

```
.myopex-scenarios/
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

> Read my app code and write a `myopex.scenarios.ts` that covers every meaningful UI state. Use the `steps` DSL for interactions, `url` for route-based states, and `setup` for anything else. See `examples/myopex.scenarios.ts` for the format.

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

**Mixing them:** `steps` run first, then `setup`, then capture. Use per-scenario `settleMs` to override the settle ceiling for slow pages. See `examples/myopex.scenarios.ts` for the full reference.

---

## Commands

### `scenarios` — capture all states at once (recommended)

```bash
myopex scenarios --url http://localhost:5173 --config myopex.scenarios.ts
```

One browser boot, every state in your config, smart network-idle wait per state. **This is the command you want 90% of the time.**

### `capture` — single snapshot

```bash
myopex capture --url http://localhost:5173 --out .myopex --state default
```

### `verify` — compare against a baseline

```bash
myopex verify --url http://localhost:5173 --baseline .myopex
```

Exits **0 on pass, 1 on regression**. Writes `report.json` with structured diff output. Drop it into CI.

### `diff` — offline comparison (no browser)

```bash
myopex diff --old .myopex-before --new .myopex-after
```

Compares two saved fingerprints without booting a browser.

---

## Output format

Each state produces a `fingerprint-<state>.yaml`:

```yaml
version: 2
page:
  url: http://localhost:5173/
  title: My App
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

### Invariants — always-wrong (regardless of baseline)

- Element not visible
- Transparent background (theme not applied?)
- Text overflowing / truncated
- Zero width or height

These are bugs in the **current** page, full stop. No baseline needed.

### Regressions — changed from known-good (matched by composite ID)

- Exact compares: `visible`, `backgroundColor`, `display`, `textOverflow`
- Numeric compares with tolerance: `bounds.width` (±50px), `bounds.height` (±30px), `bounds.x` / `bounds.y` (±100px)
- Missing or added regions and components

The split matters because they require different responses: invariant failures always need fixing, regressions need investigation only if the baseline was correct.

---

## How is this different from X?

| Tool | What it does | Why it doesn't solve this |
|---|---|---|
| **Percy / Chromatic / Applitools** | Pixel-diff visual regression | Opaque to LLMs — an agent sees "these pixels differ" and has to guess what changed |
| **Playwright `toHaveScreenshot`** | Pixel snapshots in test runner | Same — pixel diffs, no structured data |
| **axe-core / pa11y / Lighthouse** | Accessibility violations + perf audits | Finds a11y bugs; doesn't fingerprint layout or track regressions |
| **Playwright `page.accessibility.snapshot()`** | Raw AX tree JSON | Just the tree — no bounds, no styles, no screenshots, no diff engine, no baseline format |
| **Playwright MCP / browser-use / Stagehand** | Let LLMs drive browsers via AX tree | They're for *driving* (click this, type that), not *verifying state* after a code change |
| **Storybook + Chromatic** | Per-story visual regression | Requires writing stories per state; doesn't capture real app states in context |
| **Claude Computer Use** | Pure vision | No structure — the whole point of myopex is to give the agent something cheaper than pixels to reason about |

myopex is specifically for: *agent edits code → `myopex scenarios` → agent reads structured diff → agent fixes → loop.* The closest adjacent is Playwright MCP, but it boots a browser for every question and is designed for action, not verification.

---

## Claude Code / Cursor / Aider workflow

1. **Once:** Ask your agent to write `myopex.scenarios.ts` for your app.
2. **Once:** `myopex scenarios --url http://localhost:5173 --config myopex.scenarios.ts --out .myopex-baseline` — capture the known-good baseline.
3. **Every iteration:** agent edits code → `myopex scenarios --out .myopex-current` → `myopex diff --old .myopex-baseline --new .myopex-current` → agent reads `report.json` → agent fixes.
4. **In CI:** `myopex verify --baseline .myopex-baseline` — exits 1 on regression, 0 on pass.

The agent reads structured YAML for context, and only opens the per-component PNGs when a specific component is flagged in the diff. That keeps token usage predictable and focused.

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

## Limitations

- **Single viewport.** Defaults to 1440×900. No responsive breakpoint matrix yet.
- **No color contrast checking.** Use `axe-core` for that — different tool, different job.
- **Doesn't catch animation bugs.** Animations are intentionally disabled during capture for deterministic screenshots.
- **No iframe support.** CDP operates on the top-level document only.
- **Requires semantic HTML or ARIA to be useful.** The more `<main>`, `<nav>`, `role="..."`, and `aria-label` your app uses, the better the fingerprint. A `<div>` soup will produce thin output.
- **Dark mode by default.** `colorScheme: 'dark'` is the default. Override in your scenario `setup` if you test light mode.

---

## Tech stack

- **Playwright** — browser automation + element screenshots
- **Chrome DevTools Protocol** — accessibility tree + DOM node resolution
- **TypeScript** — strict mode, ES2022 target
- **yaml** — serialize / deserialize
- **vitest** — unit + integration tests

## License

MIT
