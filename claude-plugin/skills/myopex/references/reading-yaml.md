# Reading the fingerprint YAML

Each captured state produces `fingerprint-<state>.yaml`. This file is the source of truth for what's on the page. Read it to answer questions about layout, visibility, and styles without opening a browser.

## Full structure

```yaml
version: 2                            # bump on incompatible schema changes
page:
  url: http://localhost:5173/
  title: My App
  viewport: { width: 1440, height: 900 }
  theme: dark                         # from page background luminance
  background: rgb(15, 23, 42)
  layout: header + sidebar + main + footer   # landmark shorthand
  landmarks: [banner, navigation, main, contentinfo]
  capturedAt: 2026-04-17T14:30:00.000Z

regions:
  <regionKey>:
    role: navigation                  # ARIA role or semantic element
    bounds: { x, y, width, height }   # client rect at capture time
    background: rgb(...)
    childCount: 3                     # number of direct components
    _estimated_tokens: 280            # budget hint for context usage
    _screenshotFile: screenshots/region-<key>.png
    components:
      - id: '<regionKey>/<role>["<name>"]'
        props:
          role: button
          name: Home
          bounds: { x, y, width, height }
          visible: true
          backgroundColor: rgba(0, 0, 0, 0)
          color: rgb(148, 163, 184)
          fontSize: 16px
          display: block
          textOverflow: false
          resolveStatus: ok           # ok | fallback | failed
          screenshotFile: screenshots/<region>-<role>-<name>.png

ungrouped: [ ... ]                    # data-testid elements outside any region
state:
  name: <scenario name>
```

## Field meanings

### page
- `theme` — derived from the page background luminance; `dark` if luminance < 0.5
- `layout` — a compact summary of which landmark roles are present, in order
- `landmarks` — the ARIA landmarks found; absence of any is a red flag for accessibility

### region
- `<regionKey>` — the canonical name: ARIA landmark first, then `dialog` / `alertdialog` (useful for teleported modals that don't live inside a landmark), then semantic tag, then framework selector, then config selector. Stable across DOM refactors within the same layout.
- `_estimated_tokens` — rough count of tokens this region's YAML serialization would consume if an LLM reads it (`Math.ceil(chars / 4)`). Use it to scope reads:
  - Under ~150: safe to read fully without thinking about context budget
  - 150–300: read if relevant to the current question, skip otherwise
  - Over ~300: read only the components you need by grepping for the composite ID or region section — don't slurp the whole region block unless the question demands it
  - If the sum across all regions exceeds a few thousand tokens, prefer targeted greps (`grep -A 3 'visible: false'`, `grep 'region-name:'`) over whole-file reads
- `_screenshotFile` — relative path to a PNG of the region's bounding box. Read only when the YAML flags something you need to see.

### component
- `id` — the composite ID. Format: `<regionKey>/<role>["<name>"]` or `<regionKey>/<tag>#<testid>`. Designed to survive DOM refactors; if you refactor from `<div>` to `<section>` but keep the `aria-label`, the ID stays the same.
- `resolveStatus`:
  - `ok` — found via the accessibility tree AND its visual properties resolved cleanly. Every field reflects reality. This is what you want on most components.
  - `fallback` — NOT found via the AX tree; injected into the region because it has a `data-testid` that matched. Visual properties (bounds, colors, fontSize, display, textOverflow) are still reliable — they're extracted straight from the DOM via the testid selector. But `role` is stamped `'generic'` (myopex doesn't know the real ARIA role) and `name` is the testid string, not an accessible name. `fallback` is **fine and expected** on any non-semantic element (`<div>` with a testid, icon-only buttons you labeled with a testid). Don't chase it as a bug.
  - `failed` — found via the AX tree, but the CDP call to resolve its visual properties threw. Only `role` and `name` are real; every other field is a placeholder zero/empty-string. Do NOT trust bounds, colors, or `visible` on these components.
- `visible` — `false` means `display:none`, `visibility:hidden`, or zero-area bounds
- `textOverflow` — `true` when the text node is being truncated (overflow-hidden or white-space-nowrap cutting content)
- `screenshotFile` — relative path to per-component PNG; open only when necessary

## Reading patterns

### Answering "is X visible?"
1. Find the component by composite ID
2. Check `props.visible`
3. Cross-check `props.bounds` — non-zero `width` and `height`? Inside the viewport?

### Answering "does the theme apply?"
1. `page.background` — is it the expected theme color?
2. For each major region: `region.background` — transparent `rgba(0, 0, 0, 0)` on a full-height container usually means the theme class didn't apply
3. Spot-check a component: `props.color` and `props.backgroundColor` should match the theme's text/surface tokens

### Answering "is the layout correct?"
1. `page.layout` — does the landmark order match what you expect?
2. For each region: `bounds.x`, `bounds.y`, `bounds.width`, `bounds.height` — consistent with a header-at-top or sidebar-on-left pattern?
3. Compare a component's `bounds` to its parent region's `bounds` — a component outside its region's rect is visually detached

### Answering "is this text readable?"
1. `props.fontSize` — plausible for the role? (body = 14-16px, buttons = 14px, headings > 18px)
2. `props.color` vs region `background` — sufficient contrast? (myopex doesn't check contrast; compare manually or run axe-core for rigorous a11y)
3. `props.textOverflow` — `true` means content is being clipped

## Anomaly cheat sheet

| Signal | Probable bug |
|---|---|
| `visible: false` on key components | Render guard misfiring, or CSS `display:none` from a state the code didn't expect |
| `bounds.width: 0` or `height: 0` | Flex or grid child collapsed; missing content; zero-size parent |
| `backgroundColor: rgba(0, 0, 0, 0)` on a large container region | Theme class not applied, or the theme variable is undefined. (Interactive roles — buttons, links, menu items, list items — intentionally inherit their background from a parent and are excluded from this invariant.) |
| Region in `page.landmarks` but not in `regions` | a11y markup exists but the region container isn't queryable — usually a layout/wrapper bug |
| `textOverflow: true` on a button or heading | Too-narrow container, or too-long text after i18n / user input |
| `resolveStatus: failed` on a specific component | CDP call to resolve visuals threw — other props (bounds, colors, visible) are placeholder; ignore them |
| Many `resolveStatus: failed` at once | The CDP bridge was under load or the page navigated mid-capture — rerun the capture once before acting on the results |
| Component in `ungrouped` that should be in a region | `data-testid` element outside any landmark/semantic container — usually means the a11y structure is incomplete |
| **Region has 0 components** (but the screenshot clearly shows UI) | The app's interactive elements lack discoverable identity. Myopex's component detection needs *either* a stable accessible name (`aria-label`, visible text) *or* a `data-testid`. Icon-only buttons (e.g. Material Symbols) render a glyph but expose no text to the AX tree — they're invisible to component extraction unless labeled. Fix by adding `aria-label` or `data-testid` to the offending elements, then re-capture. Do NOT try to fix this by writing more exotic selectors — the problem is on the page, not the config. |

## Context budgeting

For large apps, loading every region eats context. Strategies:

- **Grep first.** `grep -n 'visible: false' fingerprint-*.yaml` → find affected components in seconds, then read only those regions.
- **Sum `_estimated_tokens`.** Skip regions whose total exceeds your budget unless they're directly relevant.
- **Regions matter more than components.** If a question is about "does the header look right," load the `banner` region only.
- **Screenshots are last resort.** Open `screenshotFile` only when the YAML is inconclusive — a per-component PNG is small but still 10–50x the tokens of the YAML entry.
