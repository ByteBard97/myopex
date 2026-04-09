# ui-audit

CLI tool for AI agent UI verification. Extracts Chrome accessibility tree data, DOM visual properties, and component screenshots into hierarchical YAML fingerprints. Designed so an AI agent can read structured data and look at screenshots only when needed.

## Install

```bash
npm install
npx playwright install chromium
```

## Commands

### capture

Generate a fingerprint YAML and component screenshots for a page state.

```bash
npx tsx src/cli.ts capture --url http://localhost:5173 --out .ui-audit
npx tsx src/cli.ts capture --url http://localhost:5173 --out .ui-audit --state modal-open
```

Produces:
- `.ui-audit/fingerprint-default.yaml` (or `fingerprint-{state}.yaml`)
- `.ui-audit/screenshots/` — one PNG per flagged component

### verify

Diff the current state of a page against a saved baseline. Exits 0 if clean, 1 if failures.

```bash
npx tsx src/cli.ts verify --url http://localhost:5173 --baseline .ui-audit
npx tsx src/cli.ts verify --url http://localhost:5173 --baseline .ui-audit --state modal-open
```

Prints a structured report to stdout. Use in CI — the exit code is the signal.

### diff

Compare two fingerprint directories offline, without a browser.

```bash
npx tsx src/cli.ts diff --old .ui-audit-baseline --new .ui-audit-current
npx tsx src/cli.ts diff --old .ui-audit-baseline --new .ui-audit-current --state modal-open
```

## --state usage

Capture multiple UI states in the same output directory. Each state produces its own file:

```bash
npx tsx src/cli.ts capture --url http://localhost:5173 --out .ui-audit --state default
npx tsx src/cli.ts capture --url http://localhost:5173 --out .ui-audit --state drawer-open
npx tsx src/cli.ts capture --url http://localhost:5173 --out .ui-audit --state error
```

Results in `.ui-audit/fingerprint-default.yaml`, `.ui-audit/fingerprint-drawer-open.yaml`, `.ui-audit/fingerprint-error.yaml`.

`verify` and `diff` use `--state` to select which file to compare against.

## Output format

YAML fingerprint structure:

```
version: "2.0"
capturedAt: <ISO timestamp>
page:
  url: <string>
  title: <string>
  viewport: { width, height }
regions:
  - id: <string>           # e.g. "nav", "main", "sidebar"
    role: <ARIA role>
    label: <accessible name>
    bounds: { x, y, width, height }
    components:
      - id: <string>
        role: <ARIA role>
        label: <accessible name>
        bounds: { x, y, width, height }
        visible: <bool>
        state:             # CDP accessibility state
          focused: <bool>
          disabled: <bool>
          checked: <bool | "mixed">
          expanded: <bool>
          # ...
        screenshot: <path> # relative path, present if component was captured
        children: [...]    # recursive
```

Version, page metadata, and region structure are top-level. Components nest to match the DOM hierarchy within each region.

## How it works

1. **CDP accessibility tree extraction** — Connects to Chrome DevTools Protocol, calls `Accessibility.getFullAXTree` to get the full accessibility tree including states and properties.
2. **Region discovery** — Finds top-level regions using a fallback chain: ARIA landmarks (`role="navigation"`, `role="main"`, etc.) → semantic HTML (`<nav>`, `<main>`, `<aside>`, `<header>`, `<footer>`) → config selectors.
3. **CDP DOM.resolveNode** — For each component node, resolves the backing DOM node to extract visual properties (bounds, visibility, computed styles) without an extra round-trip selector query.
4. **Merge** — Combines accessibility tree data with visual properties into the `UIFingerprint` structure, then serializes to YAML.

Screenshots are captured per-component using Playwright element handles. Only components matching capture criteria (interactive, named, or explicitly configured) get screenshots.

## Example output

```yaml
version: "2.0"
capturedAt: "2026-04-08T14:30:00.000Z"
page:
  url: "http://localhost:5173"
  title: "SignalCanvas"
  viewport:
    width: 1280
    height: 720
regions:
  - id: main-nav
    role: navigation
    label: "Main navigation"
    bounds: { x: 0, y: 0, width: 1280, height: 56 }
    components:
      - id: btn-new-project
        role: button
        label: "New project"
        bounds: { x: 16, y: 12, width: 120, height: 32 }
        visible: true
        state:
          focused: false
          disabled: false
        screenshot: screenshots/btn-new-project.png
```

## CI integration

`verify` exits 0 on pass, 1 on failures:

```yaml
# GitHub Actions example
- name: UI audit
  run: |
    npx tsx src/cli.ts verify --url http://localhost:5173 --baseline .ui-audit
```

The full diff report is printed to stdout. Capture a baseline on your main branch; run `verify` in PR checks.

## Integration with Claude Code

The agent workflow:

1. Read `fingerprint-{state}.yaml` for structured component data — roles, labels, bounds, states. This is the primary signal.
2. Look at PNGs only for components flagged in the diff report (changed bounds, state flips, new/missing components).

The YAML is stable, diffable, and compact. Screenshots are a fallback for visual regressions the structured data cannot express.
