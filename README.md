# ui-audit

> Hierarchical YAML fingerprints with Chrome accessibility tree for AI agent UI verification.

Extracts the Chrome DevTools Protocol accessibility tree, resolves each node to computed visual properties via CDP `DOM.resolveNode`, groups into semantic regions, and serializes to a hierarchical YAML fingerprint. Designed for AI agents that need structured UI data — not pixel diffs.

## Install

```bash
npm install
npx playwright install chromium
```

Requires Node.js >= 20.

## Commands

### capture

Generate a fingerprint YAML + screenshots for a page state.

```bash
npx tsx src/cli.ts capture --url http://localhost:5173 --out .ui-audit
npx tsx src/cli.ts capture --url http://localhost:5173 --out .ui-audit --state modal-open
```

Produces:
- `fingerprint.yaml` (or `fingerprint-{state}.yaml`)
- `screenshots/` — per-component PNGs
- `full-page.png` — reference screenshot

### verify

Diff current state against a saved baseline. Exits 0 on pass, 1 on failure.

```bash
npx tsx src/cli.ts verify --url http://localhost:5173 --baseline .ui-audit
```

Writes `report.json` with structured diff results.

### diff

Compare two fingerprint directories offline (no browser needed).

```bash
npx tsx src/cli.ts diff --old .ui-audit-v2 --new .ui-audit-v3
```

## Multi-state capture

Capture multiple UI states in the same output directory:

```bash
npx tsx src/cli.ts capture --url ... --out .ui-audit --state default
npx tsx src/cli.ts capture --url ... --out .ui-audit --state drawer-open
npx tsx src/cli.ts capture --url ... --out .ui-audit --state error
```

Each state produces its own file: `fingerprint-default.yaml`, `fingerprint-drawer-open.yaml`, etc. The `verify` and `diff` commands accept `--state` to select which file to compare.

## Output format

```yaml
version: 2
page:
  url: "http://localhost:5173"
  title: "SignalCanvas"
  viewport: { width: 1440, height: 900 }
  theme: dark
  background: "rgb(15, 23, 42)"
  layout: header + sidebar + main + footer
  landmarks: [banner, navigation, main, contentinfo]
  capturedAt: "2026-04-08T14:30:00.000Z"
regions:
  navigation-main-navigation:
    role: navigation
    bounds: { x: 0, y: 48, width: 48, height: 852 }
    background: "rgb(30, 41, 59)"
    childCount: 3
    _estimated_tokens: 280
    components:
      - id: 'navigation-main-navigation/button["Home"]'
        props:
          role: button
          name: Home
          bounds: { x: 0, y: 48, width: 48, height: 48 }
          visible: true
          backgroundColor: "rgba(0, 0, 0, 0)"
          color: "rgb(148, 163, 184)"
          fontSize: 16px
          display: block
          textContent: H
          childCount: 0
          resolveStatus: ok
          screenshotFile: screenshots/navigation-main-navigation-button--Home--.png
ungrouped: []
state:
  name: default
  modals: none
  selection: null
```

Key features:
- **Regions** group components by ARIA landmarks, with visual properties resolved via CDP
- **Component IDs** use composite keys: `regionKey/role["name"]` for stable cross-version matching
- **`resolveStatus`** — `ok` (CDP resolved), `fallback` (selector-based), or `failed` (extraction failed)
- **`ungrouped`** — data-testid elements that fall outside all discovered regions (not silently dropped)
- **`_estimated_tokens`** per region helps agents budget context window usage
- **`screenshotFile`** links to per-component PNGs for visual inspection

## How it works

```
Page load
  → CDP Accessibility.getFullAXTree()
  → Region discovery (5-level fallback):
      1. ARIA landmarks (banner, navigation, main, complementary, contentinfo)
      2. Semantic HTML (<header>, <nav>, <main>, <aside>, <footer>)
      2.5. Framework selectors (VueFlow .vue-flow, React Flow, [data-canvas])
      3. [data-testid] elements (collected as components, not regions)
      4. Config file selectors (optional, additive)
  → Batched CDP DOM.resolveNode + Runtime.callFunctionOn (30 nodes per batch)
      (backendDOMNodeId → RemoteObjectId → getComputedStyle + getBoundingClientRect)
  → Merge into UIFingerprint hierarchy
  → YAML serialization + per-component screenshots
```

The CDP bridge is necessary because `backendDOMNodeId` is a CDP concept that doesn't exist in the browser's JS context — you cannot do this in a single `page.evaluate()` call.

## Diff engine

The `verify` and `diff` commands produce a `FullDiffReport` with two separated sections:

**Invariant checks** (on all current components, skipping `resolveStatus: failed`):
- Element not visible
- Transparent background (theme not applied?)
- Text overflow / truncation
- Zero width or height

**Regression checks** (matched by composite ID against baseline):
- Exact: `visible`, `backgroundColor`, `display`, `textOverflow`
- Numeric tolerance: `bounds.width` (±50px), `bounds.height` (±30px), `bounds.x`/`bounds.y` (±100px)
- Missing / added regions and components

The report separates these because they require different responses: invariant failures indicate bugs in the current page regardless of baseline, while regressions indicate changes from a known-good state.

## Schema validation

YAML fingerprints are validated on deserialize (no external dependencies). The validator checks:
- `version` must be `2`
- Required `page` block with url, title, background, layout, capturedAt, viewport, landmarks
- Required `regions`, `state`, and `ungrouped` blocks

Invalid or corrupted YAML files throw descriptive errors instead of silently producing broken data.

## CI integration

```yaml
# GitHub Actions
- name: UI audit
  run: |
    npx tsx src/cli.ts verify --url http://localhost:5173 --baseline .ui-audit
```

Exit code 0 = pass, 1 = failures. Capture a baseline on main, run `verify` in PR checks.

## Claude Code integration

Agent workflow:
1. Read `fingerprint.yaml` for structured data — roles, names, bounds, visibility, backgrounds
2. Check `_estimated_tokens` to decide which regions fit in context
3. Look at component PNGs only for items flagged in the diff report

The YAML is stable, diffable, and compact. Screenshots are a fallback for visual regressions that structured data alone cannot express.

## Tech stack

- **TypeScript** — strict mode, ES2022 target
- **Playwright** — browser automation + element screenshots
- **Chrome DevTools Protocol** — accessibility tree + DOM node resolution
- **yaml** — YAML serialize/deserialize
- **vitest** — 54 tests across 10 test files

## License

MIT
