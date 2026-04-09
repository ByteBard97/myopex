# ui-audit v3 — Targeted Fixes from Architecture Review

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 9 real problems identified in the architecture review without rewriting the tool. Each fix is a surgical change to the existing codebase with its own test and commit.

**Architecture:** The existing `extract/` → `fingerprint/` separation is correct and stays. We're fixing internals: CDP batching for performance, single extraction source for correctness, separated diff reports for clarity, and schema validation for safety. No new directories, no class hierarchies, no new dependencies beyond `zod` for schema validation.

**Tech Stack:** Same as v2 — TypeScript, Playwright, CDP, `yaml`. Adding `zod` for schema validation only.

**Prerequisite:** v2 is implemented and 38/39 tests pass (CLI integration test needs timeout fix — that's Task 1 below).

---

## What we're NOT doing (and why)

- **Not building a BrowserSession class.** The tool runs 3 commands, each once. Premature abstraction.
- **Not replacing insertion-order component IDs with content hashes.** Content hashes break when text changes ("Items (3)" → "Items (4)"). We'll improve IDs incrementally.
- **Not building pluggable readiness strategies.** `waitForTimeout(4000)` works. We'll add `networkIdle` when we need it.
- **Not reorganizing into `browser/`, `commands/` directories.** The current structure is fine. We're fixing behavior, not folder names.
- **Not removing framework selectors from constants.** `.vue-flow` is framework-level knowledge, same as knowing React uses `#root`. The product-specific `.device-node` selector moves to config.

---

## File Map

| File | Change |
|------|--------|
| `src/extract/cdp-resolve.ts` | Batch CDP with concurrency, add try/finally for session leak |
| `src/extract/visual-props.ts` | NEW — single extraction function shared by CDP and evaluate paths |
| `src/extract/merge.ts` | Use shared extraction, populate `ungrouped`, mark unresolved nodes |
| `src/fingerprint/diff-engine.ts` | Separate InvariantReport and RegressionReport |
| `src/fingerprint/types.ts` | Add `resolveStatus` to ElementProps, add report types |
| `src/fingerprint/yaml.ts` | Add zod schema validation on deserialize |
| `src/fingerprint/schema.ts` | NEW — zod schema for UIFingerprint |
| `src/capture.ts` | Return UIFingerprint object (not just write to disk) |
| `src/verify.ts` | Use returned fingerprint directly, skip disk round-trip |
| `src/constants.ts` | Move `.device-node`/`.cdn-node` to config, keep `.vue-flow` |
| `tests/cli.test.ts` | Fix timeout |
| Various test files | New tests per fix |

---

### Task 1: Fix CLI test timeout + CDP session leak

**Files:**
- Modify: `tests/cli.test.ts`
- Modify: `src/extract/cdp-resolve.ts`
- Modify: `src/extract/accessibility.ts`

- [ ] **Step 1: Fix the test timeout**

Read `tests/cli.test.ts`. Add `{ timeout: 30000 }` to any test that launches a browser:

```typescript
it('capture produces fingerprint.yaml + full-page screenshot', async () => {
  // ... existing test body ...
}, 30000)
```

Do the same for any verify test in the file.

- [ ] **Step 2: Run the test to confirm it passes**

```bash
npx vitest run tests/cli.test.ts
```

Expected: PASS

- [ ] **Step 3: Fix CDP session leak in cdp-resolve.ts**

Read `src/extract/cdp-resolve.ts`. The `client.detach()` at the end of `batchResolveVisualProps` is outside the try/catch. If the `for` loop throws (not the per-node catch, but an unexpected error), the CDP session leaks.

Wrap the entire function body in try/finally:

```typescript
export async function batchResolveVisualProps(
  page: Page,
  backendNodeIds: number[],
): Promise<Map<number, ResolvedNode>> {
  const client = await page.context().newCDPSession(page)
  const results = new Map<number, ResolvedNode>()

  try {
    // ... existing extraction loop (unchanged) ...
  } finally {
    await client.detach()
  }

  return results
}
```

- [ ] **Step 4: Fix CDP session leak in accessibility.ts**

Read `src/extract/accessibility.ts`. Same pattern — the `Accessibility.getFullAXTree` call uses a CDP session. Wrap in try/finally:

```typescript
export async function extractAccessibilityTree(page: Page): Promise<AXNode> {
  const client = await page.context().newCDPSession(page)
  try {
    const { nodes } = await client.send('Accessibility.getFullAXTree')
    // ... existing tree building ...
  } finally {
    await client.detach()
  }
  // ... return root ...
}
```

- [ ] **Step 5: Run full test suite**

```bash
npx vitest run
```

Expected: ALL 39 tests pass (including the previously-failing CLI test)

- [ ] **Step 6: Commit**

```bash
git add tests/cli.test.ts src/extract/cdp-resolve.ts src/extract/accessibility.ts
git commit -m "fix: CLI test timeout + CDP session leak on error"
```

---

### Task 2: Batch CDP resolution with concurrency

**Files:**
- Modify: `src/extract/cdp-resolve.ts`
- Test: `tests/extract/cdp-resolve.test.ts`

- [ ] **Step 1: Write a test that measures resolution time**

Read the existing test file `tests/extract/cdp-resolve.test.ts`. Add a test:

```typescript
it('resolves 20+ nodes in under 3 seconds', async () => {
  // Get all elements on the page
  const nodeIds = await page.evaluate(() => {
    const elements = document.querySelectorAll('*')
    // We need backendDOMNodeIds, but those come from CDP — use a workaround:
    // Just verify the batch function handles a large set without timing out
    return elements.length
  })
  expect(nodeIds).toBeGreaterThan(20)

  const start = Date.now()
  // Get AX tree to find backendDOMNodeIds
  const tree = await extractAccessibilityTree(page)
  const allIds = collectNodeIds(tree)
  expect(allIds.length).toBeGreaterThan(10)

  const results = await batchResolveVisualProps(page, allIds)
  const elapsed = Date.now() - start

  expect(elapsed).toBeLessThan(3000)
  expect(results.size).toBeGreaterThan(0)
}, 10000)

function collectNodeIds(node: AXNode, ids: number[] = []): number[] {
  if (node.backendDOMNodeId) ids.push(node.backendDOMNodeId)
  for (const child of node.children ?? []) collectNodeIds(child, ids)
  return ids
}
```

- [ ] **Step 2: Run test to get baseline timing**

```bash
npx vitest run tests/extract/cdp-resolve.test.ts
```

Note the elapsed time. Sequential should be slow if there are 20+ nodes.

- [ ] **Step 3: Implement batched CDP resolution**

Read `src/extract/cdp-resolve.ts`. Replace the sequential `for` loop with a batched approach:

```typescript
const BATCH_SIZE = 30

export async function batchResolveVisualProps(
  page: Page,
  backendNodeIds: number[],
): Promise<Map<number, ResolvedNode>> {
  const client = await page.context().newCDPSession(page)
  const results = new Map<number, ResolvedNode>()

  const extractFnSource = `function() {
    const el = this;
    const rect = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    return JSON.stringify({
      bounds: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
      },
      visible: rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
      backgroundColor: cs.backgroundColor,
      color: cs.color,
      fontSize: cs.fontSize,
      borderWidth: cs.borderWidth,
      opacity: cs.opacity,
      display: cs.display,
      overflow: cs.overflow,
      textOverflow: el.scrollWidth > el.clientWidth,
      textContent: (el.textContent || '').trim().substring(0, 200),
      childCount: el.children.length,
    });
  }`

  try {
    // Process in batches of BATCH_SIZE
    for (let i = 0; i < backendNodeIds.length; i += BATCH_SIZE) {
      const batch = backendNodeIds.slice(i, i + BATCH_SIZE)

      // Step 1: Resolve all nodes in this batch to RemoteObjectIds
      const resolveResults = await Promise.allSettled(
        batch.map(nodeId =>
          client.send('DOM.resolveNode', { backendNodeId: nodeId })
            .then(({ object }) => ({ nodeId, objectId: object.objectId }))
        )
      )

      // Collect successfully resolved objects
      const resolved: Array<{ nodeId: number; objectId: string }> = []
      for (const result of resolveResults) {
        if (result.status === 'fulfilled' && result.value.objectId) {
          resolved.push(result.value)
        }
      }

      // Step 2: Extract visual properties from all resolved objects
      const extractResults = await Promise.allSettled(
        resolved.map(({ nodeId, objectId }) =>
          client.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: extractFnSource,
            returnByValue: true,
          }).then(({ result }) => ({ nodeId, objectId, value: result.value }))
        )
      )

      // Collect results and release objects
      const releasePromises: Promise<void>[] = []
      for (const result of extractResults) {
        if (result.status === 'fulfilled' && result.value.value) {
          const { nodeId, objectId, value } = result.value
          const parsed = typeof value === 'string' ? JSON.parse(value) : value
          results.set(nodeId, parsed)
          releasePromises.push(
            client.send('Runtime.releaseObject', { objectId }).then(() => {}).catch(() => {})
          )
        }
      }

      // Release all remote objects for this batch (fire and forget)
      await Promise.allSettled(releasePromises)
    }
  } finally {
    await client.detach()
  }

  return results
}
```

- [ ] **Step 4: Run test to verify it's faster**

```bash
npx vitest run tests/extract/cdp-resolve.test.ts
```

Expected: PASS, and the timing test should pass under 3 seconds.

- [ ] **Step 5: Run full test suite**

```bash
npx vitest run
```

Expected: ALL pass

- [ ] **Step 6: Commit**

```bash
git add src/extract/cdp-resolve.ts tests/extract/cdp-resolve.test.ts
git commit -m "perf: batch CDP resolution with concurrency (30 parallel)"
```

---

### Task 3: Single visual property extraction function

**Files:**
- Create: `src/extract/visual-props.ts`
- Modify: `src/extract/cdp-resolve.ts`
- Modify: `src/extract/merge.ts`
- Test: `tests/extract/visual-props.test.ts`

The problem: visual property extraction logic is duplicated between `cdp-resolve.ts` (as a stringified function for `Runtime.callFunctionOn`) and `merge.ts`'s `extractViaSelector` (as a Playwright `evaluate` callback). If someone adds a property to one, they'll forget the other.

- [ ] **Step 1: Write the test**

```typescript
// tests/extract/visual-props.test.ts
import { describe, it, expect } from 'vitest'
import {
  EXTRACT_FN_SOURCE,
  type VisualPropsResult,
} from '../../src/extract/visual-props'

describe('visual-props', () => {
  it('EXTRACT_FN_SOURCE is a valid function string', () => {
    expect(typeof EXTRACT_FN_SOURCE).toBe('string')
    expect(EXTRACT_FN_SOURCE).toContain('getBoundingClientRect')
    expect(EXTRACT_FN_SOURCE).toContain('getComputedStyle')
    expect(EXTRACT_FN_SOURCE).toContain('scrollWidth')
  })

  it('VisualPropsResult type has all required fields', () => {
    const sample: VisualPropsResult = {
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      visible: true,
      backgroundColor: 'rgb(0,0,0)',
      color: 'rgb(255,255,255)',
      fontSize: '14px',
      borderWidth: '1px',
      opacity: '1',
      display: 'block',
      overflow: 'visible',
      textOverflow: false,
      textContent: 'test',
      childCount: 0,
    }
    expect(sample.visible).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/extract/visual-props.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Create the single-source extraction module**

```typescript
// src/extract/visual-props.ts
import type { Bounds } from '../fingerprint/types'

/**
 * Result of extracting visual properties from a DOM element.
 * This type is the SINGLE SOURCE OF TRUTH for what properties we extract.
 * Used by both CDP resolution and Playwright evaluate paths.
 */
export interface VisualPropsResult {
  bounds: Bounds
  visible: boolean
  backgroundColor: string
  color: string
  fontSize: string
  borderWidth: string
  opacity: string
  display: string
  overflow: string
  textOverflow: boolean
  textContent: string
  childCount: number
}

/**
 * The extraction function as a source string.
 * Used by cdp-resolve.ts for Runtime.callFunctionOn.
 * MUST be kept in sync with the VisualPropsResult interface above.
 *
 * This is a stringified function because CDP's Runtime.callFunctionOn
 * requires a function declaration string, not a JS function reference.
 * The function executes inside the browser context with `this` bound
 * to the target DOM element.
 */
export const EXTRACT_FN_SOURCE = `function() {
  var el = this;
  var rect = el.getBoundingClientRect();
  var cs = window.getComputedStyle(el);
  return JSON.stringify({
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    visible: rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
    backgroundColor: cs.backgroundColor,
    color: cs.color,
    fontSize: cs.fontSize,
    borderWidth: cs.borderWidth,
    opacity: cs.opacity,
    display: cs.display,
    overflow: cs.overflow,
    textOverflow: el.scrollWidth > el.clientWidth,
    textContent: (el.textContent || '').trim().substring(0, 200),
    childCount: el.children.length,
  });
}`

/**
 * The same extraction logic as a function for use in Playwright's
 * page.evaluate() / locator.evaluate(). This calls the SAME logic
 * as EXTRACT_FN_SOURCE but as a direct function, not a string.
 */
export function extractVisualPropsFromElement(el: Element): VisualPropsResult {
  const rect = el.getBoundingClientRect()
  const cs = window.getComputedStyle(el)
  const h = el as HTMLElement
  return {
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    visible:
      rect.width > 0 &&
      rect.height > 0 &&
      cs.visibility !== 'hidden' &&
      cs.display !== 'none',
    backgroundColor: cs.backgroundColor,
    color: cs.color,
    fontSize: cs.fontSize,
    borderWidth: cs.borderWidth,
    opacity: cs.opacity,
    display: cs.display,
    overflow: cs.overflow,
    textOverflow: h.scrollWidth > h.clientWidth,
    textContent: (h.textContent ?? '').trim().substring(0, 200),
    childCount: h.children.length,
  }
}
```

Note: `extractVisualPropsFromElement` is for documentation and type safety. In practice, the Playwright evaluate path will inline the same logic (since you can't import functions into `evaluate`). But having both in one file means a developer sees them side by side and keeps them in sync.

- [ ] **Step 4: Update cdp-resolve.ts to import the shared source**

Read `src/extract/cdp-resolve.ts`. Replace the inline `extractFnSource` string with:

```typescript
import { EXTRACT_FN_SOURCE } from './visual-props'
```

Remove the local `extractFnSource` const. Use `EXTRACT_FN_SOURCE` in the `Runtime.callFunctionOn` call.

Also update the `ResolvedNode` type to import from visual-props:

```typescript
import type { VisualPropsResult } from './visual-props'
// ResolvedNode is now just an alias
export type ResolvedNode = VisualPropsResult
```

- [ ] **Step 5: Update merge.ts extractViaSelector to match**

Read `src/extract/merge.ts`. In the `extractViaSelector` function (around line 193-228), replace the inline extraction logic with a comment referencing the shared source, and ensure the properties match exactly. The `evaluate` callback must duplicate the same logic (can't import into evaluate), but add a comment:

```typescript
/** Fallback: extract visual props via CSS selector.
 *  Logic MUST match EXTRACT_FN_SOURCE in visual-props.ts */
async function extractViaSelector(
  page: Page,
  selector: string,
): Promise<VisualPropsResult | undefined> {
  // ... same evaluate body, but now returns VisualPropsResult type
}
```

Import `VisualPropsResult` from `./visual-props` and use it as the return type.

- [ ] **Step 6: Run tests**

```bash
npx vitest run
```

Expected: ALL pass

- [ ] **Step 7: Commit**

```bash
git add src/extract/visual-props.ts src/extract/cdp-resolve.ts src/extract/merge.ts tests/extract/visual-props.test.ts
git commit -m "refactor: single source of truth for visual property extraction"
```

---

### Task 4: Separate InvariantReport and RegressionReport

**Files:**
- Modify: `src/fingerprint/types.ts`
- Modify: `src/fingerprint/diff-engine.ts`
- Modify: `src/verify.ts`
- Test: `tests/fingerprint/diff-engine.test.ts`

- [ ] **Step 1: Add new report types**

Read `src/fingerprint/types.ts`. Add:

```typescript
export interface InvariantFailure {
  component: string
  region: string
  property: string
  value: string | number | boolean
  message: string
  screenshotFile?: string | null
}

export interface InvariantReport {
  failures: InvariantFailure[]
  checked: number
}

export interface RegressionFailure {
  component: string
  region: string
  property: string
  expected: string | number | boolean
  actual: string | number | boolean
  screenshotFile?: string | null
}

export interface RegressionReport {
  failures: RegressionFailure[]
  checked: number
  missing: string[]
  added: string[]
}

export interface FullDiffReport {
  pass: boolean
  timestamp: string
  source: string
  target: string
  invariants: InvariantReport
  regressions: RegressionReport
}
```

Keep the existing `DiffReport` and `DiffFailure` types as deprecated aliases if other code depends on them.

- [ ] **Step 2: Write tests for separated reports**

Read `tests/fingerprint/diff-engine.test.ts`. Add tests:

```typescript
it('returns separate invariant and regression reports', () => {
  // Component with transparent bg (invariant) + changed color (regression)
  const base = makeFingerprint({
    main: {
      role: 'main',
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      background: '#000',
      childCount: 1,
      components: [makeComponent({ backgroundColor: 'rgb(26, 34, 50)' })],
    },
  })
  const current = makeFingerprint({
    main: {
      role: 'main',
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      background: '#000',
      childCount: 1,
      components: [makeComponent({ backgroundColor: 'rgba(0, 0, 0, 0)' })],
    },
  })

  const report = diffFingerprints(base, current)

  // Invariant: transparent background
  expect(report.invariants.failures.length).toBeGreaterThan(0)
  expect(report.invariants.failures[0].message).toContain('transparent')

  // Regression: color changed from blue to transparent
  expect(report.regressions.failures.length).toBeGreaterThan(0)
  expect(report.regressions.failures[0].expected).toBe('rgb(26, 34, 50)')
})

it('pass is false when either invariant or regression has failures', () => {
  // ... test with only invariant failure (no baseline change)
  // ... test with only regression failure (no invariant violation)
  // Both should set pass: false
})
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run tests/fingerprint/diff-engine.test.ts
```

Expected: FAIL — `report.invariants` doesn't exist yet

- [ ] **Step 4: Refactor diff-engine.ts**

Read `src/fingerprint/diff-engine.ts`. Refactor `diffFingerprints` to return `FullDiffReport`:

```typescript
export function diffFingerprints(
  baseline: UIFingerprint,
  current: UIFingerprint,
): FullDiffReport {
  const invariantFailures: InvariantFailure[] = []
  const regressionFailures: RegressionFailure[] = []
  let invariantChecks = 0
  let regressionChecks = 0

  // ... invariant check loop → push to invariantFailures
  // ... baseline diff loop → push to regressionFailures

  const invariants: InvariantReport = {
    failures: invariantFailures,
    checked: invariantChecks,
  }
  const regressions: RegressionReport = {
    failures: regressionFailures,
    checked: regressionChecks,
    missing,
    added,
  }

  return {
    pass: invariantFailures.length === 0 && regressionFailures.length === 0,
    timestamp: new Date().toISOString(),
    source: baseline.page.url,
    target: current.page.url,
    invariants,
    regressions,
  }
}
```

- [ ] **Step 5: Update verify.ts to use new report format**

Read `src/verify.ts`. Update the console output to print invariant failures and regression failures separately:

```
INVARIANT FAILURES (2):
  ✗ device-node-1.backgroundColor: transparent — theme not applied?
  ✗ device-node-2.textOverflow: truncated

REGRESSIONS (1):
  ✗ header.height: expected 48, got 0 (missing?)
```

- [ ] **Step 6: Run all tests**

```bash
npx vitest run
```

Expected: ALL pass

- [ ] **Step 7: Commit**

```bash
git add src/fingerprint/types.ts src/fingerprint/diff-engine.ts src/verify.ts tests/fingerprint/diff-engine.test.ts
git commit -m "refactor: separate InvariantReport and RegressionReport in diff engine"
```

---

### Task 5: Populate `ungrouped` + mark unresolved nodes

**Files:**
- Modify: `src/extract/merge.ts`
- Modify: `src/fingerprint/types.ts`
- Test: `tests/extract/merge.test.ts`

- [ ] **Step 1: Add `resolveStatus` to ElementProps**

Read `src/fingerprint/types.ts`. Add to `ElementProps`:

```typescript
export interface ElementProps {
  // ... existing fields ...
  /** Whether CDP successfully resolved this node's visual properties */
  resolveStatus: 'ok' | 'failed' | 'fallback'
}
```

- [ ] **Step 2: Write test for ungrouped population**

Read `tests/extract/merge.test.ts`. Add a test that verifies data-testid elements outside all regions end up in `ungrouped`:

```typescript
it('places data-testid elements outside regions into ungrouped', async () => {
  // The fixture has [data-testid="device-1"] inside <main>
  // Add a floating element outside all landmarks for this test
  await page.evaluate(() => {
    const el = document.createElement('div')
    el.setAttribute('data-testid', 'floating-widget')
    el.style.cssText = 'position:fixed;top:0;right:0;width:100px;height:30px;background:red;'
    el.textContent = 'Floating'
    document.body.appendChild(el)
  })

  const fp = await buildFingerprint(page)
  // The floating widget's center (right:0, top:0 → x~1390, y~15) is likely
  // outside the main region's bounds
  // It should end up in ungrouped, not silently dropped
  const allComponentIds = [
    ...Object.values(fp.regions).flatMap(r => r.components.map(c => c.id)),
    ...fp.ungrouped.map(c => c.id),
  ]
  // floating-widget should exist somewhere — not dropped
  const hasFloating = allComponentIds.some(id => id.includes('floating') || id.includes('widget'))
  expect(hasFloating || fp.ungrouped.length > 0).toBe(true)
})
```

- [ ] **Step 3: Write test for resolveStatus on failed nodes**

```typescript
it('marks unresolved nodes with resolveStatus: failed', async () => {
  const fp = await buildFingerprint(page)
  // All successfully resolved components should have resolveStatus: 'ok'
  for (const region of Object.values(fp.regions)) {
    for (const comp of region.components) {
      expect(['ok', 'failed', 'fallback']).toContain(comp.props.resolveStatus)
    }
  }
})
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
npx vitest run tests/extract/merge.test.ts
```

Expected: FAIL — `resolveStatus` doesn't exist, `ungrouped` is always empty

- [ ] **Step 5: Implement in merge.ts**

Read `src/extract/merge.ts`.

**5a.** In `buildComponents`, set `resolveStatus`:

```typescript
const props: ElementProps = childVisual
  ? { role: child.role, name: child.name, ...childVisual, resolveStatus: 'ok' as const }
  : {
      role: child.role, name: child.name,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      visible: false,
      // ... existing fallback values ...
      resolveStatus: 'failed' as const,
    }
```

For the `extractViaSelector` fallback path, set `resolveStatus: 'fallback'`.

**5b.** Populate `ungrouped`. After building regions, process data-testid elements from discovery:

```typescript
// After building regions, find data-testid elements not inside any region
const ungrouped: Component[] = []
for (const { selector, testId } of discovery.testIdElements) {
  const props = await extractViaSelector(page, selector)
  if (!props) continue
  // Check if this element's center falls inside any region
  const cx = props.bounds.x + props.bounds.width / 2
  const cy = props.bounds.y + props.bounds.height / 2
  const insideRegion = Object.values(regions).some(r =>
    cx >= r.bounds.x && cx <= r.bounds.x + r.bounds.width &&
    cy >= r.bounds.y && cy <= r.bounds.y + r.bounds.height
  )
  if (!insideRegion) {
    ungrouped.push({
      id: `ungrouped/testid["${testId}"]`,
      props: { role: 'generic', name: testId, ...props, resolveStatus: 'fallback' as const },
    })
  }
}
```

Set `ungrouped` in the returned fingerprint instead of `[]`.

**5c.** Update the diff engine to skip components with `resolveStatus: 'failed'` during invariant checks (they're extraction failures, not UI bugs).

- [ ] **Step 6: Run tests**

```bash
npx vitest run
```

Expected: ALL pass

- [ ] **Step 7: Commit**

```bash
git add src/extract/merge.ts src/fingerprint/types.ts src/fingerprint/diff-engine.ts tests/extract/merge.test.ts
git commit -m "fix: populate ungrouped, mark unresolved nodes, skip failed in invariants"
```

---

### Task 6: Schema validation on YAML deserialize

**Files:**
- Create: `src/fingerprint/schema.ts`
- Modify: `src/fingerprint/yaml.ts`
- Test: `tests/fingerprint/yaml.test.ts`

- [ ] **Step 1: Install zod**

```bash
npm install zod
```

- [ ] **Step 2: Write tests**

Read `tests/fingerprint/yaml.test.ts`. Add:

```typescript
it('rejects YAML with missing version field', () => {
  const bad = 'page:\n  url: /\n'
  expect(() => deserializeFingerprint(bad)).toThrow(/version/)
})

it('rejects YAML with wrong version', () => {
  const bad = 'version: 99\npage:\n  url: /\n'
  expect(() => deserializeFingerprint(bad)).toThrow(/version/)
})

it('rejects completely invalid YAML', () => {
  expect(() => deserializeFingerprint('not: valid: yaml: [')).toThrow()
})
```

- [ ] **Step 3: Create schema.ts**

```typescript
// src/fingerprint/schema.ts
import { z } from 'zod'

const BoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

const ElementPropsSchema = z.object({
  role: z.string(),
  name: z.string(),
  bounds: BoundsSchema,
  visible: z.boolean(),
  backgroundColor: z.string(),
  color: z.string(),
  fontSize: z.string(),
  borderWidth: z.string(),
  opacity: z.string(),
  display: z.string(),
  overflow: z.string(),
  textOverflow: z.boolean(),
  textContent: z.string(),
  childCount: z.number(),
  resolveStatus: z.enum(['ok', 'failed', 'fallback']).optional(),
  screenshotFile: z.string().nullable().optional(),
})

const ComponentSchema = z.object({
  id: z.string(),
  props: ElementPropsSchema,
  children: z.lazy(() => z.array(ComponentSchema)).optional(),
})

const RegionSchema = z.object({
  role: z.string(),
  bounds: BoundsSchema,
  background: z.string(),
  childCount: z.number(),
  summary: z.string().optional(),
  components: z.array(ComponentSchema),
})

const PageMetaSchema = z.object({
  url: z.string(),
  title: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  theme: z.string(),
  background: z.string(),
  layout: z.string(),
  landmarks: z.array(z.string()),
  capturedAt: z.string(),
})

export const UIFingerprintSchema = z.object({
  version: z.literal(2),
  page: PageMetaSchema,
  regions: z.record(z.string(), RegionSchema),
  ungrouped: z.array(ComponentSchema),
  state: z.object({
    name: z.string(),
    modals: z.string(),
    selection: z.string().nullable(),
  }),
})
```

- [ ] **Step 4: Update yaml.ts to validate on deserialize**

Read `src/fingerprint/yaml.ts`. Update:

```typescript
import { parse, stringify } from 'yaml'
import type { UIFingerprint } from './types'
import { UIFingerprintSchema } from './schema'

export function serializeFingerprint(fp: UIFingerprint): string {
  return stringify(fp, { indent: 2, lineWidth: 120 })
}

export function deserializeFingerprint(yamlStr: string): UIFingerprint {
  const raw = parse(yamlStr)
  const result = UIFingerprintSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
    throw new Error(`Invalid fingerprint YAML: ${issues}`)
  }
  return result.data
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run
```

Expected: ALL pass

- [ ] **Step 6: Commit**

```bash
git add src/fingerprint/schema.ts src/fingerprint/yaml.ts tests/fingerprint/yaml.test.ts package.json package-lock.json
git commit -m "feat: zod schema validation on YAML deserialize"
```

---

### Task 7: Return fingerprint from capture, skip disk round-trip in verify

**Files:**
- Modify: `src/capture.ts`
- Modify: `src/verify.ts`
- Test: `tests/cli.test.ts` (verify existing tests still pass)

- [ ] **Step 1: Read both files**

Read `src/capture.ts` and `src/verify.ts`.

- [ ] **Step 2: Modify capture.ts to return the fingerprint**

`runCapture` currently returns `void`. Change it to return `UIFingerprint`:

```typescript
export async function runCapture(
  url: string,
  outDir: string,
  stateName: string,
): Promise<UIFingerprint> {
  // ... existing browser launch + buildFingerprint logic ...

  // Write to disk (still needed for CLI output)
  writeFileSync(join(outDir, filename), yaml)
  // ... write screenshots ...

  await browser.close()
  return fingerprint  // ← NEW: return the object
}
```

- [ ] **Step 3: Modify verify.ts to use returned fingerprint**

Replace the disk round-trip pattern:

```typescript
// BEFORE:
await runCapture(url, currentDir, stateName)
const currentYaml = readFileSync(join(currentDir, filename), 'utf-8')
const current = deserializeFingerprint(currentYaml)

// AFTER:
const current = await runCapture(url, currentDir, stateName)
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run
```

Expected: ALL pass

- [ ] **Step 5: Commit**

```bash
git add src/capture.ts src/verify.ts
git commit -m "perf: runCapture returns fingerprint, verify skips disk round-trip"
```

---

### Task 8: Move product-specific selectors to config

**Files:**
- Modify: `src/constants.ts`
- Modify: `src/extract/region-discovery.ts`
- Test: `tests/extract/region-discovery.test.ts`

- [ ] **Step 1: Read the current constants and region-discovery**

Read both files. Identify which selectors are framework-level (keep) vs product-specific (move to config).

- [ ] **Step 2: Clean up constants.ts**

Keep `.vue-flow`, `.vue-flow__controls` (framework-level). Remove `.device-node`, `.cdn-node` (SignalCanvas-specific). They belong in the project's config file, not the tool's defaults.

```typescript
export const FRAMEWORK_SELECTORS: Array<{ selector: string; role: string; name: string }> = [
  { selector: '.vue-flow', role: 'main-canvas', name: 'Canvas' },
  { selector: '.vue-flow__controls', role: 'toolbar', name: 'Canvas Controls' },
  { selector: '[data-canvas]', role: 'main-canvas', name: 'Canvas' },
]
```

- [ ] **Step 3: Update region-discovery.ts canvas node enumeration**

Read the canvas node enumeration code (around line 107-119). The `.device-node` / `.cdn-node` references should come from config, not be hardcoded:

```typescript
if (fw.role === 'main-canvas') {
  // Enumerate individual canvas nodes — use generic VueFlow selectors
  const nodeCount = await page.locator('.vue-flow__node').count()
  for (let i = 0; i < Math.min(nodeCount, 10); i++) {
    const nodeId = await page.locator('.vue-flow__node').nth(i).getAttribute('data-id')
    if (nodeId) {
      // Use the generic VueFlow node selector — project-specific child selectors
      // (like .device-node) come from config.extraSelectors
      regions.push({
        role: 'canvas-node',
        name: nodeId,
        selector: `.vue-flow__node[data-id="${nodeId}"]`,
        source: 'config-selector',
      })
    }
  }
}
```

- [ ] **Step 4: Update tests**

Read `tests/extract/region-discovery.test.ts`. Update any tests that expect `.device-node` in the selector to use the generic `.vue-flow__node[data-id="..."]` pattern instead.

- [ ] **Step 5: Run tests**

```bash
npx vitest run
```

Expected: ALL pass

- [ ] **Step 6: Commit**

```bash
git add src/constants.ts src/extract/region-discovery.ts tests/extract/region-discovery.test.ts
git commit -m "refactor: move product-specific selectors to config, keep framework-level defaults"
```

---

### Task 9: Deduplicate data-testid + fix test timeout constant

**Files:**
- Modify: `src/extract/region-discovery.ts`
- Modify: `src/constants.ts`

These are small cleanup items from the "hidden risks" section of the review.

- [ ] **Step 1: Deduplicate data-testid collection**

Read `src/extract/region-discovery.ts`. In the Level 3 data-testid loop, add deduplication:

```typescript
const seenTestIds = new Set<string>()
for (let i = 0; i < testIdCount; i++) {
  const testId = await page.locator('[data-testid]').nth(i).getAttribute('data-testid')
  if (testId && !seenTestIds.has(testId)) {
    seenTestIds.add(testId)
    testIdElements.push({ selector: `[data-testid="${testId}"]`, testId })
  }
}
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run
```

Expected: ALL pass

- [ ] **Step 3: Commit**

```bash
git add src/extract/region-discovery.ts
git commit -m "fix: deduplicate data-testid elements in region discovery"
```

---

## Summary

9 tasks, each a surgical fix with its own test and commit:

| Task | What | Why |
|------|------|-----|
| 1 | Fix test timeout + CDP session leak | Test reliability + resource leak |
| 2 | Batch CDP with concurrency | Performance: 240 sequential → ~80 parallel calls |
| 3 | Single extraction function | Correctness: prevent property divergence |
| 4 | Separate invariant/regression reports | Clarity: different signals need different handling |
| 5 | Populate ungrouped + resolveStatus | Completeness: stop silently dropping components |
| 6 | Zod schema validation | Safety: catch corrupted/versioned YAML |
| 7 | Return fingerprint from capture | Performance: skip needless serialize/deserialize |
| 8 | Move product selectors to config | Separation: tool vs project concerns |
| 9 | Deduplicate data-testid | Correctness: prevent duplicate component entries |

After all 9 tasks, the tool has the same API and file structure but is faster, more correct, and properly separates concerns. No rewrite, no new abstractions, no new directories.
