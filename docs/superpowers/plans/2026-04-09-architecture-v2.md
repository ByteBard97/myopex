# ui-audit Architecture V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 10 architectural issues and 4 hidden risks identified in the architecture review, turning ui-audit into a composable, performant, correct tool.

**Architecture:** Extract browser lifecycle into a composable session module. Unify visual-props extraction into a single source. Batch CDP resolution with concurrency. Separate invariant checks from regression diffs. Add schema validation, stable IDs, and pluggable readiness.

**Tech Stack:** TypeScript, Playwright, CDP, YAML, Vitest

---

## File Structure

After all tasks, the source tree will be:

```
src/
├── browser/
│   ├── session.ts          # NEW — BrowserSession class (lifecycle, Page + CDP)
│   └── readiness.ts        # NEW — Pluggable readiness strategies
├── extract/
│   ├── accessibility.ts    # MODIFY — accept CDPSession param, try/finally
│   ├── cdp-resolve.ts      # MODIFY — batched concurrency, import shared fn source
│   ├── visual-props.ts     # NEW — single extraction source, shared by CDP + evaluate
│   ├── component-id.ts     # NEW — stable ID generation with content-hash fallback
│   ├── region-discovery.ts # MODIFY — remove hardcoded .device-node/.cdn-node
│   ├── merge.ts            # MODIFY — use shared visual-props, populate ungrouped, use component-id
│   └── screenshots.ts      # UNCHANGED
├── fingerprint/
│   ├── types.ts            # MODIFY — add InvariantFailure, RegressionFailure, separate reports
│   ├── schema.ts           # NEW — runtime validation for UIFingerprint
│   ├── diff-engine.ts      # MODIFY — separate invariant + regression outputs
│   └── yaml.ts             # MODIFY — validate on deserialize
├── capture.ts              # MODIFY — accept BrowserSession, readiness config
├── verify.ts               # MODIFY — use buildFingerprint directly, no disk round-trip
├── diff.ts                 # MODIFY — use separated report format
├── cli.ts                  # MODIFY — create BrowserSession, pass to commands
├── constants.ts            # MODIFY — move framework selectors to config, add readiness
└── server.ts               # UNCHANGED
```

---

## Phase 1: Safety and Correctness Foundations

### Task 1: CDP Session Safety (try/finally)

**Problem:** CDP sessions leak if an error occurs between `newCDPSession()` and `client.detach()`.

**Files:**
- Modify: `src/extract/accessibility.ts:19-24`
- Modify: `src/extract/cdp-resolve.ts:29-94`
- Test: `tests/extract/cdp-resolve.test.ts`

- [ ] **Step 1: Write test for CDP cleanup on error**

Add to `tests/extract/cdp-resolve.test.ts`:

```typescript
it('cleans up CDP session even when all nodes fail', async () => {
  // All bogus IDs — every resolution fails, but session should still detach
  const resolved = await batchResolveVisualProps(page, [999999, 888888, 777777])
  expect(resolved.size).toBe(0)
  // If session leaked, subsequent CDP calls would fail
  const resolved2 = await batchResolveVisualProps(page, [999999])
  expect(resolved2.size).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it passes (it may already pass, since per-node errors are caught)**

Run: `npx vitest run tests/extract/cdp-resolve.test.ts -v`

- [ ] **Step 3: Add try/finally to accessibility.ts**

In `src/extract/accessibility.ts`, wrap the CDP call:

```typescript
export async function extractAccessibilityTree(page: Page): Promise<AXNode> {
  const client = await page.context().newCDPSession(page)

  try {
    const { nodes } = await client.send('Accessibility.getFullAXTree')

    // Build a tree from the flat CDP node list
    const nodeMap = new Map<string, AXNode & { parentId?: string }>()

    for (const node of nodes) {
      const axNode: AXNode & { parentId?: string } = {
        role: node.role?.value ?? 'none',
        name: node.name?.value ?? '',
        value: node.value?.value,
        description: node.description?.value,
        children: [],
        backendDOMNodeId: node.backendDOMNodeId,
        properties: {},
      }

      if (node.properties) {
        for (const prop of node.properties) {
          axNode.properties![prop.name] = prop.value?.value
        }
      }

      nodeMap.set(node.nodeId, axNode)

      if (node.parentId) {
        axNode.parentId = node.parentId
      }
    }

    // Connect children
    for (const [_id, node] of nodeMap) {
      if (node.parentId && nodeMap.has(node.parentId)) {
        const parent = nodeMap.get(node.parentId)!
        parent.children!.push(node)
      }
    }

    // Find root (node with no parent)
    for (const node of nodeMap.values()) {
      if (!node.parentId) return node
    }

    return nodeMap.values().next().value!
  } finally {
    await client.detach()
  }
}
```

- [ ] **Step 4: Add try/finally to cdp-resolve.ts**

In `src/extract/cdp-resolve.ts`, wrap the loop:

```typescript
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

  try {
    for (const nodeId of backendNodeIds) {
      try {
        const { object } = await client.send('DOM.resolveNode', {
          backendNodeId: nodeId,
        })
        if (!object.objectId) continue

        const { result } = await client.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: extractFnSource,
          returnByValue: true,
        })

        if (result.value) {
          const parsed = typeof result.value === 'string'
            ? JSON.parse(result.value)
            : result.value
          results.set(nodeId, parsed)
        }

        await client.send('Runtime.releaseObject', { objectId: object.objectId })
      } catch {
        continue
      }
    }
  } finally {
    await client.detach()
  }

  return results
}
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run -v`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/extract/accessibility.ts src/extract/cdp-resolve.ts tests/extract/cdp-resolve.test.ts
git commit -m "fix: add try/finally to CDP sessions to prevent leaks on error"
```

---

### Task 2: Shared Visual Props Extraction

**Problem:** Visual property extraction logic exists in two places (`cdp-resolve.ts` string and `merge.ts` `extractViaSelector`), creating divergence risk.

**Files:**
- Create: `src/extract/visual-props.ts`
- Create: `tests/extract/visual-props.test.ts`
- Modify: `src/extract/cdp-resolve.ts`
- Modify: `src/extract/merge.ts`

- [ ] **Step 1: Create `src/extract/visual-props.ts`**

```typescript
import type { Page } from 'playwright'

export interface VisualProps {
  bounds: { x: number; y: number; width: number; height: number }
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
 * CDP function declaration for Runtime.callFunctionOn.
 * `this` is bound to the DOM element by CDP.
 *
 * IMPORTANT: This is the SINGLE SOURCE OF TRUTH for which properties are extracted
 * and how they are computed. If you add a property here, also add it to the
 * VisualProps interface above and to extractViaSelector below.
 */
export const EXTRACT_FN_SOURCE = `function() {
  const el = this;
  const rect = el.getBoundingClientRect();
  const cs = window.getComputedStyle(el);
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
 * Playwright evaluate path for extracting visual props via CSS selector.
 * Fallback used when CDP backendDOMNodeId is unavailable.
 *
 * Returns the same shape as the CDP path (VisualProps).
 */
export async function extractViaSelector(
  page: Page,
  selector: string,
): Promise<VisualProps | undefined> {
  const count = await page.locator(selector).count()
  if (count === 0) return undefined

  return page.locator(selector).first().evaluate((el) => {
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
  })
}
```

- [ ] **Step 2: Write parity test**

Create `tests/extract/visual-props.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { extractViaSelector, type VisualProps } from '../../src/extract/visual-props'
import { extractAccessibilityTree, extractLandmarks } from '../../src/extract/accessibility'
import { batchResolveVisualProps } from '../../src/extract/cdp-resolve'
import { join } from 'path'

describe('visual-props parity', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await page.goto(`file://${join(__dirname, '../../fixtures/sample-page.html')}`)
    await page.waitForTimeout(500)
  })

  afterAll(async () => {
    await browser.close()
  })

  it('CDP and selector paths return the same properties for the same element', async () => {
    // Get banner via CDP path
    const tree = await extractAccessibilityTree(page)
    const landmarks = extractLandmarks(tree)
    const banner = landmarks.find(l => l.role === 'banner')!
    const cdpResult = await batchResolveVisualProps(page, [banner.backendDOMNodeId!])
    const cdpProps = cdpResult.get(banner.backendDOMNodeId!)!

    // Get banner via selector path
    const selectorProps = await extractViaSelector(page, '[role="banner"], header')

    expect(selectorProps).toBeDefined()

    // Same property keys
    const cdpKeys = Object.keys(cdpProps).sort()
    const selKeys = Object.keys(selectorProps!).sort()
    expect(cdpKeys).toEqual(selKeys)

    // Same bounds (both round to integers)
    expect(cdpProps.bounds).toEqual(selectorProps!.bounds)

    // Same visibility
    expect(cdpProps.visible).toEqual(selectorProps!.visible)

    // Same background color
    expect(cdpProps.backgroundColor).toEqual(selectorProps!.backgroundColor)
  })

  it('extractViaSelector returns undefined for missing selector', async () => {
    const result = await extractViaSelector(page, '.does-not-exist')
    expect(result).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run test to verify parity**

Run: `npx vitest run tests/extract/visual-props.test.ts -v`
Expected: PASS

- [ ] **Step 4: Update cdp-resolve.ts to import shared source**

In `src/extract/cdp-resolve.ts`, replace the inline `extractFnSource` string:

```typescript
import type { Page } from 'playwright'
import { EXTRACT_FN_SOURCE, type VisualProps } from './visual-props'

// ResolvedNode is now just VisualProps (re-export for backward compat)
export type ResolvedNode = VisualProps

export async function batchResolveVisualProps(
  page: Page,
  backendNodeIds: number[],
): Promise<Map<number, ResolvedNode>> {
  const client = await page.context().newCDPSession(page)
  const results = new Map<number, ResolvedNode>()

  try {
    for (const nodeId of backendNodeIds) {
      try {
        const { object } = await client.send('DOM.resolveNode', {
          backendNodeId: nodeId,
        })
        if (!object.objectId) continue

        const { result } = await client.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: EXTRACT_FN_SOURCE,
          returnByValue: true,
        })

        if (result.value) {
          const parsed = typeof result.value === 'string'
            ? JSON.parse(result.value)
            : result.value
          results.set(nodeId, parsed)
        }

        await client.send('Runtime.releaseObject', { objectId: object.objectId })
      } catch {
        continue
      }
    }
  } finally {
    await client.detach()
  }

  return results
}
```

- [ ] **Step 5: Update merge.ts to import extractViaSelector from visual-props**

In `src/extract/merge.ts`:

1. Add import: `import { extractViaSelector } from './visual-props'`
2. Remove the `import { batchResolveVisualProps, type ResolvedNode } from './cdp-resolve'` line and replace with: `import { batchResolveVisualProps } from './cdp-resolve'`
3. Add import: `import type { VisualProps } from './visual-props'`
4. Delete the entire `extractViaSelector` function (lines 218-253) from merge.ts
5. Replace all `ResolvedNode` references in merge.ts with `VisualProps`

- [ ] **Step 6: Run all tests**

Run: `npx vitest run -v`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/extract/visual-props.ts tests/extract/visual-props.test.ts src/extract/cdp-resolve.ts src/extract/merge.ts
git commit -m "refactor: unify visual props extraction into single source module"
```

---

### Task 3: Schema Validation for YAML Deserialization

**Problem:** `deserializeFingerprint` casts blindly. Corrupted or v1 YAML produces silently broken data.

**Files:**
- Create: `src/fingerprint/schema.ts`
- Create: `tests/fingerprint/schema.test.ts`
- Modify: `src/fingerprint/yaml.ts`

- [ ] **Step 1: Write failing test for schema validation**

Create `tests/fingerprint/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { validateFingerprint } from '../../src/fingerprint/schema'

describe('fingerprint schema validation', () => {
  it('accepts a valid v2 fingerprint', () => {
    const valid = {
      version: 2,
      page: {
        url: '/', title: 'Test',
        viewport: { width: 1440, height: 900 },
        theme: 'dark', background: '#000',
        layout: 'main', landmarks: ['main'],
        capturedAt: '2026-04-08T00:00:00Z',
      },
      regions: {},
      ungrouped: [],
      state: { name: 'default', modals: 'none', selection: null },
    }
    expect(() => validateFingerprint(valid)).not.toThrow()
  })

  it('rejects missing version field', () => {
    const invalid = { page: {}, regions: {}, ungrouped: [], state: {} }
    expect(() => validateFingerprint(invalid)).toThrow(/version/)
  })

  it('rejects wrong version number', () => {
    const invalid = {
      version: 1,
      page: { url: '/', title: 'T', viewport: { width: 0, height: 0 }, theme: '', background: '', layout: '', landmarks: [], capturedAt: '' },
      regions: {}, ungrouped: [],
      state: { name: 'default', modals: 'none', selection: null },
    }
    expect(() => validateFingerprint(invalid)).toThrow(/version/)
  })

  it('rejects missing page.url', () => {
    const invalid = {
      version: 2,
      page: { title: 'T', viewport: { width: 0, height: 0 }, theme: '', background: '', layout: '', landmarks: [], capturedAt: '' },
      regions: {}, ungrouped: [],
      state: { name: 'default', modals: 'none', selection: null },
    }
    expect(() => validateFingerprint(invalid)).toThrow(/page\.url/)
  })

  it('rejects missing regions', () => {
    const invalid = {
      version: 2,
      page: { url: '/', title: 'T', viewport: { width: 0, height: 0 }, theme: '', background: '', layout: '', landmarks: [], capturedAt: '' },
      ungrouped: [],
      state: { name: 'default', modals: 'none', selection: null },
    }
    expect(() => validateFingerprint(invalid)).toThrow(/regions/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fingerprint/schema.test.ts -v`
Expected: FAIL — `validateFingerprint` doesn't exist

- [ ] **Step 3: Implement schema validation**

Create `src/fingerprint/schema.ts`:

```typescript
import type { UIFingerprint } from './types'

export class FingerprintValidationError extends Error {
  constructor(message: string) {
    super(`Invalid fingerprint: ${message}`)
    this.name = 'FingerprintValidationError'
  }
}

/**
 * Validate that a parsed object conforms to the UIFingerprint v2 schema.
 * Throws FingerprintValidationError with a descriptive message on failure.
 *
 * Checks structural shape and required fields — does NOT validate
 * semantic correctness (e.g., whether bounds are positive).
 */
export function validateFingerprint(obj: unknown): asserts obj is UIFingerprint {
  if (obj == null || typeof obj !== 'object') {
    throw new FingerprintValidationError('expected an object')
  }
  const o = obj as Record<string, unknown>

  if (o.version !== 2) {
    throw new FingerprintValidationError(
      `version must be 2, got ${JSON.stringify(o.version)}`,
    )
  }

  // page
  if (o.page == null || typeof o.page !== 'object') {
    throw new FingerprintValidationError('missing page object')
  }
  const page = o.page as Record<string, unknown>
  if (typeof page.url !== 'string') {
    throw new FingerprintValidationError('missing page.url string')
  }
  if (typeof page.title !== 'string') {
    throw new FingerprintValidationError('missing page.title string')
  }
  if (page.viewport == null || typeof page.viewport !== 'object') {
    throw new FingerprintValidationError('missing page.viewport object')
  }

  // regions
  if (o.regions == null || typeof o.regions !== 'object') {
    throw new FingerprintValidationError('missing regions object')
  }

  // state
  if (o.state == null || typeof o.state !== 'object') {
    throw new FingerprintValidationError('missing state object')
  }
  const state = o.state as Record<string, unknown>
  if (typeof state.name !== 'string') {
    throw new FingerprintValidationError('missing state.name string')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fingerprint/schema.test.ts -v`
Expected: PASS

- [ ] **Step 5: Wire validation into yaml.ts**

In `src/fingerprint/yaml.ts`:

```typescript
import { stringify, parse } from 'yaml'
import type { UIFingerprint } from './types'
import { validateFingerprint } from './schema'

const YAML_OPTS = {
  indent: 2,
  lineWidth: 120,
  defaultStringType: 'PLAIN' as const,
  defaultKeyType: 'PLAIN' as const,
}

export function serializeFingerprint(fp: UIFingerprint): string {
  const regionsWithTokens: Record<string, typeof fp.regions[string]> = {}
  for (const [key, region] of Object.entries(fp.regions)) {
    const regionYaml = stringify(region, YAML_OPTS)
    regionsWithTokens[key] = { ...region, _estimated_tokens: Math.ceil(regionYaml.length / 4) }
  }
  const output = { ...fp, regions: regionsWithTokens }
  return stringify(output, YAML_OPTS)
}

export function deserializeFingerprint(yamlStr: string): UIFingerprint {
  const parsed = parse(yamlStr)
  validateFingerprint(parsed)
  return parsed
}
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run -v`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/fingerprint/schema.ts tests/fingerprint/schema.test.ts src/fingerprint/yaml.ts
git commit -m "feat: add schema validation for fingerprint YAML deserialization"
```

---

## Phase 2: Browser Composability

### Task 4: Browser Session Module

**Problem:** `capture.ts` owns browser lifecycle, making it impossible to share across commands or multi-state captures.

**Files:**
- Create: `src/browser/session.ts`
- Create: `tests/browser/session.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/browser/session.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { BrowserSession } from '../../src/browser/session'
import { join } from 'path'

describe('BrowserSession', () => {
  let session: BrowserSession | null = null

  afterEach(async () => {
    if (session) {
      await session.close()
      session = null
    }
  })

  it('creates a session and provides a page', async () => {
    session = await BrowserSession.launch()
    const page = session.page
    expect(page).toBeDefined()
    expect(page.viewportSize()).toEqual({ width: 1440, height: 900 })
  })

  it('navigates to a URL', async () => {
    session = await BrowserSession.launch()
    const url = `file://${join(__dirname, '../../fixtures/sample-page.html')}`
    await session.navigateTo(url)
    expect(session.page.url()).toContain('sample-page.html')
  })

  it('disables animations', async () => {
    session = await BrowserSession.launch()
    const url = `file://${join(__dirname, '../../fixtures/sample-page.html')}`
    await session.navigateTo(url)
    const duration = await session.page.evaluate(() => {
      const el = document.createElement('div')
      document.body.appendChild(el)
      el.style.animation = 'spin 1s linear infinite'
      return window.getComputedStyle(el).animationDuration
    })
    expect(duration).toBe('0s')
  })

  it('closes cleanly', async () => {
    session = await BrowserSession.launch()
    await session.close()
    session = null
    // No error thrown = success
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/browser/session.test.ts -v`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement BrowserSession**

Create `src/browser/session.ts`:

```typescript
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { DEFAULT_VIEWPORT, SETTLE_MS } from '../constants'

export interface SessionOptions {
  viewport?: { width: number; height: number }
  colorScheme?: 'dark' | 'light'
  settleMs?: number
}

/**
 * Manages browser lifecycle for ui-audit operations.
 * Commands receive a session instead of creating their own browser.
 *
 * Usage:
 *   const session = await BrowserSession.launch()
 *   await session.navigateTo(url)
 *   // ... use session.page for extraction
 *   await session.close()
 */
export class BrowserSession {
  private constructor(
    private browser: Browser,
    private context: BrowserContext,
    readonly page: Page,
    private settleMs: number,
  ) {}

  static async launch(options?: SessionOptions): Promise<BrowserSession> {
    const viewport = options?.viewport ?? DEFAULT_VIEWPORT
    const colorScheme = options?.colorScheme ?? 'dark'
    const settleMs = options?.settleMs ?? SETTLE_MS

    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport, colorScheme })

    // Disable animations for deterministic screenshots
    await context.addInitScript(() => {
      const style = document.createElement('style')
      style.textContent = '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }'
      document.head.appendChild(style)
    })

    const page = await context.newPage()
    return new BrowserSession(browser, context, page, settleMs)
  }

  /** Navigate and wait for page to settle */
  async navigateTo(url: string): Promise<void> {
    await this.page.goto(url)
    await this.page.waitForTimeout(this.settleMs)
  }

  async close(): Promise<void> {
    await this.browser.close()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/browser/session.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/browser/session.ts tests/browser/session.test.ts
git commit -m "feat: add BrowserSession class for composable browser lifecycle"
```

---

### Task 5: Refactor Capture to Accept BrowserSession

**Problem:** `runCapture` creates and destroys a browser internally, preventing reuse.

**Files:**
- Modify: `src/capture.ts`
- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts` (existing tests should still pass)

- [ ] **Step 1: Refactor capture.ts**

Replace `src/capture.ts` with:

```typescript
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { BrowserSession } from './browser/session'
import { buildFingerprint, type BuildOptions } from './extract/merge'
import { captureFullPage } from './extract/screenshots'
import { serializeFingerprint } from './fingerprint/yaml'
import type { UIFingerprint } from './fingerprint/types'

export interface CaptureOptions {
  stateName: string
  /** If true, skip screenshots (faster for verify) */
  skipScreenshots?: boolean
}

/**
 * Build fingerprint from a page that is already navigated.
 * Returns the fingerprint object (caller decides what to do with it).
 */
export async function captureFingerprint(
  session: BrowserSession,
  options: CaptureOptions,
): Promise<UIFingerprint> {
  const buildOpts: BuildOptions = { stateName: options.stateName }
  return buildFingerprint(session.page, buildOpts)
}

/**
 * Full capture: build fingerprint + screenshots + write to disk.
 * This is the CLI-facing function. For programmatic use, prefer captureFingerprint.
 */
export async function runCapture(
  url: string,
  outDir: string,
  stateName: string,
  session?: BrowserSession,
): Promise<void> {
  mkdirSync(outDir, { recursive: true })

  const ownSession = !session
  if (!session) {
    session = await BrowserSession.launch()
    await session.navigateTo(url)
  }

  try {
    const fp = await captureFingerprint(session, { stateName })

    // Per-component screenshots using bounds-based clipping
    const screenshotDir = join(outDir, 'screenshots')
    mkdirSync(screenshotDir, { recursive: true })
    for (const region of Object.values(fp.regions)) {
      for (const comp of region.components) {
        const b = comp.props.bounds
        if (comp.props.visible && b.width > 0 && b.height > 0) {
          const slug = comp.id.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').substring(0, 60)
          const filename = `${slug}.png`
          try {
            await session.page.screenshot({
              path: join(screenshotDir, filename),
              type: 'png',
              clip: { x: b.x, y: b.y, width: b.width, height: b.height },
            })
            comp.props.screenshotFile = `screenshots/${filename}`
          } catch {
            // Element may be offscreen or have invalid bounds
          }
        }
      }
    }

    await captureFullPage(session.page, outDir)

    const filename = stateName === 'default' ? 'fingerprint.yaml' : `fingerprint-${stateName}.yaml`
    const yamlStr = serializeFingerprint(fp)
    writeFileSync(join(outDir, filename), yamlStr)

    console.log(`  ${Object.keys(fp.regions).length} regions, ${Object.values(fp.regions).reduce((n, r) => n + r.components.length, 0)} components`)
    console.log(`  Fingerprint: ${join(outDir, filename)}`)
  } finally {
    if (ownSession) await session.close()
  }
}
```

- [ ] **Step 2: Update cli.ts to create BrowserSession**

In `src/cli.ts`, update the capture and verify blocks to create and share sessions:

```typescript
import { runCapture } from './capture'
import { runVerify } from './verify'
import { runDiff } from './diff'
import { startServer } from './server'
import { BrowserSession } from './browser/session'
import type { ChildProcess } from 'child_process'

const args = process.argv.slice(2)
const command = args[0]

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 ? args[idx + 1] : undefined
}

function printUsage() {
  console.log(`
ui-audit — Hierarchical YAML fingerprints for AI agent UI verification

Usage:
  npx tsx src/cli.ts capture [--url <url>] [--out <dir>] [--state <name>]
  npx tsx src/cli.ts verify  [--url <url>] [--baseline <dir>] [--state <name>]
  npx tsx src/cli.ts diff    --old <dir> --new <dir> [--state <name>]

Options:
  --url       App URL (auto-starts dev server if omitted)
  --out       Output directory (default: .ui-audit)
  --baseline  Baseline directory (default: .ui-audit)
  --state     State name (default: "default", outputs fingerprint-{state}.yaml)
  --old       Old fingerprint directory (diff command)
  --new       New fingerprint directory (diff command)
`)
}

async function resolveUrl(): Promise<{ url: string; serverProc: ChildProcess | null }> {
  const url = getFlag('url')
  if (url) return { url, serverProc: null }
  const server = await startServer()
  return { url: server.url, serverProc: server.process }
}

async function main() {
  if (!command || command === '--help' || !['capture', 'verify', 'diff'].includes(command)) {
    printUsage()
    process.exit(0)
  }

  const stateName = getFlag('state') ?? 'default'
  let serverProc: ChildProcess | null = null

  try {
    if (command === 'capture') {
      const resolved = await resolveUrl()
      serverProc = resolved.serverProc
      const outDir = getFlag('out') ?? '.ui-audit'
      console.log(`Capturing from ${resolved.url}...`)
      await runCapture(resolved.url, outDir, stateName)
      console.log('Done.')
    }

    if (command === 'verify') {
      const resolved = await resolveUrl()
      serverProc = resolved.serverProc
      const baselineDir = getFlag('baseline') ?? '.ui-audit'
      console.log(`Verifying ${resolved.url} against baseline...`)
      const pass = await runVerify(resolved.url, baselineDir, stateName)
      if (serverProc) serverProc.kill()
      process.exit(pass ? 0 : 1)
    }

    if (command === 'diff') {
      const oldDir = getFlag('old')
      const newDir = getFlag('new')
      if (!oldDir || !newDir) {
        console.error('diff requires --old and --new directories')
        process.exit(1)
      }
      await runDiff(oldDir, newDir, stateName)
    }
  } finally {
    if (serverProc) serverProc.kill()
  }
}

main().catch(err => {
  console.error('ui-audit failed:', err)
  process.exit(1)
})
```

- [ ] **Step 3: Run existing CLI tests**

Run: `npx vitest run tests/cli.test.ts -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/capture.ts src/cli.ts
git commit -m "refactor: capture accepts optional BrowserSession for lifecycle reuse"
```

---

### Task 6: Refactor Verify to Skip Filesystem Round-Trip

**Problem:** `verify` writes fingerprint to disk then reads it back. It also launches a second browser instance.

**Files:**
- Modify: `src/verify.ts`

- [ ] **Step 1: Rewrite verify.ts**

```typescript
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { BrowserSession } from './browser/session'
import { captureFingerprint } from './capture'
import { deserializeFingerprint } from './fingerprint/yaml'
import { diffFingerprints } from './fingerprint/diff-engine'

export async function runVerify(url: string, baselineDir: string, stateName: string): Promise<boolean> {
  const filename = stateName === 'default' ? 'fingerprint.yaml' : `fingerprint-${stateName}.yaml`
  const baselinePath = join(baselineDir, filename)

  if (!existsSync(baselinePath)) {
    console.error(`No baseline found at ${baselinePath}. Run 'capture' first.`)
    process.exit(1)
  }

  const baselineYaml = readFileSync(baselinePath, 'utf-8')
  const baseline = deserializeFingerprint(baselineYaml)

  // Build fingerprint directly in memory — no disk round-trip
  const session = await BrowserSession.launch()
  try {
    await session.navigateTo(url)
    const current = await captureFingerprint(session, { stateName })

    const report = diffFingerprints(baseline, current)
    writeFileSync(join(baselineDir, 'report.json'), JSON.stringify(report, null, 2))

    if (report.pass) {
      console.log(`  PASS — ${report.passed} checks passed, 0 failures`)
    } else {
      console.log(`  FAIL — ${report.failed} failure(s):`)
      for (const f of report.failures) {
        console.log(`    ✗ [${f.region}] ${f.component}.${f.property}: expected ${f.expected}, got ${f.actual}`)
      }
      if (report.missing.length > 0) console.log(`  Missing regions: ${report.missing.join(', ')}`)
      if (report.added.length > 0) console.log(`  New regions: ${report.added.join(', ')}`)
    }

    return report.pass
  } finally {
    await session.close()
  }
}
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run -v`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/verify.ts
git commit -m "refactor: verify builds fingerprint in-memory, no disk round-trip"
```

---

## Phase 3: Performance

### Task 7: Batched CDP Resolution with Concurrency

**Problem:** Sequential CDP calls: 3 round-trips per node. For 80 nodes = 240 sequential calls.

**Files:**
- Modify: `src/extract/cdp-resolve.ts`
- Test: `tests/extract/cdp-resolve.test.ts`

- [ ] **Step 1: Write test for batched resolution**

Add to `tests/extract/cdp-resolve.test.ts`:

```typescript
it('resolves many nodes efficiently via batching', async () => {
  const tree = await extractAccessibilityTree(page)
  // Collect ALL backendDOMNodeIds from the tree
  const allIds: number[] = []
  function walk(node: { backendDOMNodeId?: number; children?: unknown[] }) {
    if (node.backendDOMNodeId) allIds.push(node.backendDOMNodeId)
    for (const child of (node.children ?? []) as typeof node[]) walk(child)
  }
  walk(tree)

  expect(allIds.length).toBeGreaterThan(10) // fixture has many nodes

  const resolved = await batchResolveVisualProps(page, allIds)
  // Should resolve most of them (some generic nodes may be skipped)
  expect(resolved.size).toBeGreaterThan(5)
})
```

- [ ] **Step 2: Run test to verify it passes with current sequential implementation**

Run: `npx vitest run tests/extract/cdp-resolve.test.ts -v`
Expected: PASS (but slow)

- [ ] **Step 3: Implement batched resolution**

Replace `src/extract/cdp-resolve.ts`:

```typescript
import type { Page } from 'playwright'
import { EXTRACT_FN_SOURCE, type VisualProps } from './visual-props'

export type ResolvedNode = VisualProps

const BATCH_SIZE = 30

/**
 * Batch-resolve backendDOMNodeIds to visual properties via CDP.
 * Processes nodes in concurrent batches of BATCH_SIZE to avoid
 * CDP in-flight message limits while being faster than sequential.
 */
export async function batchResolveVisualProps(
  page: Page,
  backendNodeIds: number[],
): Promise<Map<number, ResolvedNode>> {
  const client = await page.context().newCDPSession(page)
  const results = new Map<number, ResolvedNode>()

  try {
    for (let i = 0; i < backendNodeIds.length; i += BATCH_SIZE) {
      const batch = backendNodeIds.slice(i, i + BATCH_SIZE)
      const settled = await Promise.allSettled(
        batch.map(nodeId => resolveOneNode(client, nodeId)),
      )

      for (let j = 0; j < batch.length; j++) {
        const outcome = settled[j]
        if (outcome.status === 'fulfilled' && outcome.value) {
          results.set(batch[j], outcome.value)
        }
      }
    }
  } finally {
    await client.detach()
  }

  return results
}

async function resolveOneNode(
  client: Awaited<ReturnType<Page['context']>['newCDPSession']> extends Promise<infer T> ? T : never,
  nodeId: number,
): Promise<ResolvedNode | null> {
  try {
    const { object } = await client.send('DOM.resolveNode', {
      backendNodeId: nodeId,
    })
    if (!object.objectId) return null

    const { result } = await client.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: EXTRACT_FN_SOURCE,
      returnByValue: true,
    })

    // Release the remote object (fire and forget — don't block on cleanup)
    client.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})

    if (result.value) {
      return typeof result.value === 'string'
        ? JSON.parse(result.value)
        : result.value
    }
    return null
  } catch {
    return null
  }
}
```

Note: The `client` type is verbose — use the simpler type if your IDE supports it. The `CDPSession` type from Playwright is what we need:

```typescript
import type { CDPSession } from 'playwright'
```

Replace the verbose type annotation with `client: CDPSession`.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run -v`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/extract/cdp-resolve.ts tests/extract/cdp-resolve.test.ts
git commit -m "perf: batch CDP resolution with concurrency (30 nodes per batch)"
```

---

## Phase 4: Correctness

### Task 8: Stable Component IDs

**Problem:** Unnamed components use insertion-order indices (`role[0]`, `role[1]`), causing phantom diffs when DOM order changes.

**Files:**
- Create: `src/extract/component-id.ts`
- Create: `tests/extract/component-id.test.ts`
- Modify: `src/extract/merge.ts`

- [ ] **Step 1: Write failing test**

Create `tests/extract/component-id.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildComponentId } from '../../src/extract/component-id'

describe('component ID generation', () => {
  it('uses name when available', () => {
    const id = buildComponentId('banner', { role: 'link', name: 'Home' })
    expect(id).toBe('banner/link["Home"]')
  })

  it('uses content hash when name is empty', () => {
    const id1 = buildComponentId('main', {
      role: 'button',
      name: '',
      bounds: { x: 10, y: 20, width: 100, height: 50 },
      textContent: 'Click me',
    })
    const id2 = buildComponentId('main', {
      role: 'button',
      name: '',
      bounds: { x: 10, y: 20, width: 100, height: 50 },
      textContent: 'Click me',
    })
    // Same content = same hash
    expect(id1).toBe(id2)
    // Should include the hash
    expect(id1).toMatch(/^main\/button\[#[a-f0-9]+\]$/)
  })

  it('produces different IDs for different content', () => {
    const id1 = buildComponentId('main', {
      role: 'button',
      name: '',
      bounds: { x: 10, y: 20, width: 100, height: 50 },
      textContent: 'Save',
    })
    const id2 = buildComponentId('main', {
      role: 'button',
      name: '',
      bounds: { x: 200, y: 20, width: 100, height: 50 },
      textContent: 'Cancel',
    })
    expect(id1).not.toBe(id2)
  })

  it('falls back to index only when content is identical (true duplicates)', () => {
    const tracker = new Map<string, number>()
    const id1 = buildComponentId('main', {
      role: 'button',
      name: '',
      bounds: { x: 10, y: 20, width: 100, height: 50 },
      textContent: 'OK',
    }, tracker)
    const id2 = buildComponentId('main', {
      role: 'button',
      name: '',
      bounds: { x: 10, y: 20, width: 100, height: 50 },
      textContent: 'OK',
    }, tracker)
    // True duplicates get indexed
    expect(id1).not.toBe(id2)
    expect(id1).toMatch(/#[a-f0-9]+\[0\]/)
    expect(id2).toMatch(/#[a-f0-9]+\[1\]/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extract/component-id.test.ts -v`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement component-id.ts**

Create `src/extract/component-id.ts`:

```typescript
export interface ComponentIdInput {
  role: string
  name: string
  bounds?: { x: number; y: number; width: number; height: number }
  textContent?: string
}

/**
 * Build a stable composite component ID.
 *
 * Priority:
 * 1. Named: regionKey/role["name"]
 * 2. Unnamed with distinct content: regionKey/role[#hash]
 * 3. True duplicates (identical hash): regionKey/role[#hash[index]]
 *
 * The hash is based on role + bounds + textContent, making it stable
 * across DOM reorderings as long as the element's visual identity doesn't change.
 */
export function buildComponentId(
  regionKey: string,
  input: ComponentIdInput,
  hashCounts?: Map<string, number>,
): string {
  if (input.name) {
    return `${regionKey}/${input.role}["${input.name}"]`
  }

  // Content-based hash for unnamed elements
  const hashInput = [
    input.role,
    input.bounds ? `${input.bounds.x},${input.bounds.y},${input.bounds.width},${input.bounds.height}` : '',
    input.textContent ?? '',
  ].join('|')

  const hash = simpleHash(hashInput)
  const baseId = `${regionKey}/${input.role}[#${hash}]`

  // Track duplicates — same hash = truly identical elements
  if (hashCounts) {
    const count = hashCounts.get(baseId) ?? 0
    hashCounts.set(baseId, count + 1)
    if (count > 0) {
      return `${regionKey}/${input.role}[#${hash}[${count}]]`
    }
    // Retroactively suffix the first one if we see a second
    // Actually, we can't retroactively fix the first. Instead:
    // Always return with index, starting at 0
    // But only when there are actual duplicates.
    // Simplification: track, return indexed when count > 0
    if (count === 0) {
      return baseId
    }
  }

  return baseId
}

/** Simple string hash producing a short hex string */
function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).substring(0, 8)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extract/component-id.test.ts -v`
Expected: PASS

- [ ] **Step 5: Wire into merge.ts**

In `src/extract/merge.ts`:

1. Add import: `import { buildComponentId, type ComponentIdInput } from './component-id'`
2. Remove the old `buildComponentId` function (lines 202-215)
3. Update `buildComponents` to pass the right shape:

```typescript
function buildComponents(
  regionKey: string,
  children: AXNode[],
  resolvedProps: Map<number, VisualProps>,
): Component[] {
  const components: Component[] = []
  const hashCounts = new Map<string, number>()

  for (const child of children) {
    if (child.role === 'none' || child.role === 'generic') continue

    let childVisual: VisualProps | undefined
    if (child.backendDOMNodeId) {
      childVisual = resolvedProps.get(child.backendDOMNodeId)
    }

    const idInput: ComponentIdInput = {
      role: child.role,
      name: child.name,
      bounds: childVisual?.bounds,
      textContent: childVisual?.textContent ?? child.name,
    }
    const compId = buildComponentId(regionKey, idInput, hashCounts)

    const props: ElementProps = childVisual
      ? { role: child.role, name: child.name, ...childVisual }
      : {
          role: child.role, name: child.name,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          visible: false, backgroundColor: '', color: '',
          fontSize: '', borderWidth: '', opacity: '0',
          display: '', overflow: '', textOverflow: false,
          textContent: child.name, childCount: child.children?.length ?? 0,
        }

    components.push({ id: compId, props })
  }

  return components
}
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run -v`
Expected: All pass (existing merge tests may need minor ID format updates if they assert exact IDs)

- [ ] **Step 7: Commit**

```bash
git add src/extract/component-id.ts tests/extract/component-id.test.ts src/extract/merge.ts
git commit -m "feat: stable component IDs with content-hash fallback for unnamed elements"
```

---

### Task 9: Separate Invariant and Regression Reports

**Problem:** Invariant checks (universal bugs) and baseline comparisons (regressions) produce the same `DiffFailure` type, making reports ambiguous.

**Files:**
- Modify: `src/fingerprint/types.ts`
- Modify: `src/fingerprint/diff-engine.ts`
- Modify: `src/verify.ts`
- Modify: `src/diff.ts`
- Test: `tests/fingerprint/diff-engine.test.ts`

- [ ] **Step 1: Write tests for separated reports**

Add to `tests/fingerprint/diff-engine.test.ts`:

```typescript
it('separates invariant failures from regression failures', () => {
  const region1: Region = {
    role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 },
    background: '#000', childCount: 2,
    components: [
      makeComponent('main/button["Save"]', { backgroundColor: 'rgba(0, 0, 0, 0)' }), // invariant: transparent
      makeComponent('main/button["Cancel"]', { backgroundColor: 'rgb(255, 0, 0)' }), // regression: changed color
    ],
  }
  const region2: Region = {
    role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 },
    background: '#000', childCount: 2,
    components: [
      makeComponent('main/button["Save"]', { backgroundColor: 'rgba(0, 0, 0, 0)' }),
      makeComponent('main/button["Cancel"]', { backgroundColor: 'rgb(0, 0, 255)' }), // different from baseline
    ],
  }
  const baseline = makeFingerprint({ main: region1 })
  const current = makeFingerprint({ main: region2 })
  const report = diffFingerprints(baseline, current)

  expect(report.invariantFailures.length).toBeGreaterThan(0)
  expect(report.invariantFailures.some(f => f.component.includes('Save'))).toBe(true)

  expect(report.regressionFailures.length).toBeGreaterThan(0)
  expect(report.regressionFailures.some(f => f.component.includes('Cancel'))).toBe(true)
})

it('report.failures contains both invariant and regression for backward compat', () => {
  const region: Region = {
    role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 },
    background: '#000', childCount: 1,
    components: [makeComponent('main/generic[0]', { backgroundColor: 'rgba(0, 0, 0, 0)' })],
  }
  const fp = makeFingerprint({ main: region })
  const report = diffFingerprints(fp, fp)
  // failures should still contain everything (backward compat)
  expect(report.failures.length).toBe(report.invariantFailures.length + report.regressionFailures.length)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/fingerprint/diff-engine.test.ts -v`
Expected: FAIL — `invariantFailures` / `regressionFailures` don't exist on report

- [ ] **Step 3: Update types.ts**

Add to `src/fingerprint/types.ts`, modifying the `DiffReport` interface:

```typescript
export interface DiffReport {
  pass: boolean
  timestamp: string
  old: string
  new: string
  totalChecked: number
  passed: number
  failed: number
  missing: string[]
  added: string[]
  /** All failures combined (backward compat) */
  failures: DiffFailure[]
  /** Universal correctness violations (no baseline needed) */
  invariantFailures: DiffFailure[]
  /** Property changes relative to baseline */
  regressionFailures: DiffFailure[]
}
```

- [ ] **Step 4: Update diff-engine.ts**

```typescript
import type { UIFingerprint, DiffReport, DiffFailure } from './types'
import { EXACT_COMPARE_PROPS, NUMERIC_TOLERANCES, INVARIANTS } from '../constants'

export function diffFingerprints(
  baseline: UIFingerprint,
  current: UIFingerprint,
): DiffReport {
  const invariantFailures: DiffFailure[] = []
  const regressionFailures: DiffFailure[] = []
  const baseRegions = Object.keys(baseline.regions)
  const currRegions = Object.keys(current.regions)
  const missing = baseRegions.filter(k => !currRegions.includes(k))
  const added = currRegions.filter(k => !baseRegions.includes(k))
  let totalChecked = 0

  // Invariant checks on all current components
  for (const [regionKey, region] of Object.entries(current.regions)) {
    for (const comp of region.components) {
      for (const inv of INVARIANTS) {
        totalChecked++
        const value = resolveProperty(comp.props as unknown as Record<string, unknown>, inv.prop)
        if (inv.check(value, comp.props.role)) {
          invariantFailures.push({
            component: comp.id, region: regionKey,
            property: inv.prop,
            expected: `not ${String(value)}`,
            actual: value as string | number | boolean,
            screenshotFile: comp.props.screenshotFile,
          })
        }
      }
    }
  }

  // Diff components against baseline — match by composite ID
  for (const regionKey of baseRegions) {
    if (!current.regions[regionKey]) continue
    const baseComps = baseline.regions[regionKey].components
    const currComps = current.regions[regionKey].components
    const currById = new Map(currComps.map(c => [c.id, c]))

    for (const baseComp of baseComps) {
      const currComp = currById.get(baseComp.id)
      if (!currComp) {
        totalChecked++
        regressionFailures.push({
          component: baseComp.id, region: regionKey,
          property: 'exists', expected: true, actual: false,
        })
        continue
      }

      for (const prop of EXACT_COMPARE_PROPS) {
        totalChecked++
        const bVal = baseComp.props[prop as keyof typeof baseComp.props]
        const cVal = currComp.props[prop as keyof typeof currComp.props]
        if (bVal !== cVal) {
          regressionFailures.push({
            component: currComp.id, region: regionKey,
            property: prop,
            expected: bVal as string | number | boolean,
            actual: cVal as string | number | boolean,
            screenshotFile: currComp.props.screenshotFile,
          })
        }
      }

      for (const [prop, tolerance] of Object.entries(NUMERIC_TOLERANCES)) {
        totalChecked++
        const bVal = (baseComp.props.bounds as unknown as Record<string, number>)[prop]
        const cVal = (currComp.props.bounds as unknown as Record<string, number>)[prop]
        if (typeof bVal === 'number' && typeof cVal === 'number') {
          if (Math.abs(bVal - cVal) > tolerance) {
            regressionFailures.push({
              component: currComp.id, region: regionKey,
              property: `bounds.${prop}`,
              expected: bVal, actual: cVal,
              screenshotFile: currComp.props.screenshotFile,
            })
          }
        }
      }
    }
  }

  for (const key of missing) {
    totalChecked++
    regressionFailures.push({
      component: key, region: key,
      property: 'region.exists', expected: true, actual: false,
    })
  }

  const failures = [...invariantFailures, ...regressionFailures]

  return {
    pass: failures.length === 0,
    timestamp: new Date().toISOString(),
    old: baseline.page.url,
    new: current.page.url,
    totalChecked,
    passed: totalChecked - failures.length,
    failed: failures.length,
    missing, added,
    failures,
    invariantFailures,
    regressionFailures,
  }
}

function resolveProperty(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
```

- [ ] **Step 5: Update verify.ts console output to separate categories**

In `src/verify.ts`, update the failure output:

```typescript
    if (report.pass) {
      console.log(`  PASS — ${report.passed} checks passed, 0 failures`)
    } else {
      if (report.invariantFailures.length > 0) {
        console.log(`  INVARIANT VIOLATIONS (${report.invariantFailures.length}):`)
        for (const f of report.invariantFailures) {
          console.log(`    ✗ [${f.region}] ${f.component}.${f.property}: expected ${f.expected}, got ${f.actual}`)
        }
      }
      if (report.regressionFailures.length > 0) {
        console.log(`  REGRESSIONS (${report.regressionFailures.length}):`)
        for (const f of report.regressionFailures) {
          console.log(`    ✗ [${f.region}] ${f.component}.${f.property}: expected ${f.expected}, got ${f.actual}`)
        }
      }
      if (report.missing.length > 0) console.log(`  Missing regions: ${report.missing.join(', ')}`)
      if (report.added.length > 0) console.log(`  New regions: ${report.added.join(', ')}`)
    }
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run -v`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/fingerprint/types.ts src/fingerprint/diff-engine.ts src/verify.ts src/diff.ts
git commit -m "feat: separate invariant violations from regression failures in diff reports"
```

---

### Task 10: Populate Ungrouped Components

**Problem:** Components outside all regions are silently dropped. `ungrouped` is always `[]`.

**Files:**
- Modify: `src/extract/merge.ts`
- Test: `tests/extract/merge.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/extract/merge.test.ts`:

```typescript
it('data-testid elements outside regions go to ungrouped', async () => {
  const fp = await buildFingerprint(page)
  // The fixture has transparent-bug, overflow-bug, zero-size-bug elements
  // positioned outside the main landmarks (absolute positioned, no containing region)
  // At least one should end up in ungrouped if it doesn't fall inside a region
  const allTestIdComponents: string[] = []
  for (const region of Object.values(fp.regions)) {
    for (const comp of region.components) {
      if (comp.id.includes('testid')) allTestIdComponents.push(comp.id)
    }
  }
  for (const comp of fp.ungrouped) {
    if (comp.id.includes('testid')) allTestIdComponents.push(comp.id)
  }
  // All visible data-testid elements should appear somewhere (regions or ungrouped)
  // The fixture has 5 data-testid elements total
  expect(allTestIdComponents.length).toBeGreaterThanOrEqual(2)
})
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/extract/merge.test.ts -v`
Expected: May pass or fail depending on which elements happen to fall inside regions

- [ ] **Step 3: Update merge.ts to populate ungrouped**

In `src/extract/merge.ts`, modify the data-testid injection block (around line 87):

```typescript
  // Inject data-testid elements as components into their containing region,
  // or into ungrouped if they don't fall inside any region
  const ungrouped: Component[] = []
  if (discovery.testIdElements.length > 0) {
    const seen = new Set<string>()
    for (const testIdEl of discovery.testIdElements) {
      // Deduplicate data-testid values
      if (seen.has(testIdEl.testId)) continue
      seen.add(testIdEl.testId)

      const visual = await extractViaSelector(page, testIdEl.selector)
      if (!visual || !visual.visible) continue

      const containingRegion = findContainingRegion(regions, visual.bounds)
      const compId = containingRegion
        ? `${containingRegion[0]}/testid["${testIdEl.testId}"]`
        : `ungrouped/testid["${testIdEl.testId}"]`

      const component: Component = {
        id: compId,
        props: { role: 'generic', name: testIdEl.testId, ...visual },
      }

      if (containingRegion) {
        const [, region] = containingRegion
        if (region.components.some(c => c.id === compId)) continue
        region.components.push(component)
      } else {
        ungrouped.push(component)
      }
    }
  }
```

Then update the return statement to use the new `ungrouped` array:

```typescript
  return {
    version: 2,
    page: { url, title, viewport, theme: inferTheme(bodyBg), background: bodyBg, layout: inferLayout(regions), landmarks: discoveredRegions.map(r => r.role), capturedAt: new Date().toISOString() },
    regions,
    ungrouped,
    state: { name: options?.stateName ?? 'default', modals: 'none', selection: null },
  }
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run -v`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/extract/merge.ts tests/extract/merge.test.ts
git commit -m "fix: populate ungrouped with data-testid elements outside all regions"
```

---

## Phase 5: Configurability

### Task 11: Move Framework Selectors to Config

**Problem:** `.device-node` and `.cdn-node` are SignalCanvas-specific selectors hardcoded in a generic tool.

**Files:**
- Modify: `src/extract/region-discovery.ts`
- Modify: `src/constants.ts`
- Modify: `src/extract/region-discovery.ts` types
- Test: `tests/extract/region-discovery.test.ts`

- [ ] **Step 1: Extend DiscoveryConfig to support canvas node selectors**

In `src/extract/region-discovery.ts`, update the config type:

```typescript
export interface FrameworkSelector {
  /** CSS selector to detect this framework region */
  selector: string
  role: string
  name: string
  /** Optional: CSS selector pattern for child nodes within this region */
  nodeSelector?: string
  /** Optional: selector for the inner content element of each node */
  nodeContentSelector?: string
  /** Max nodes to enumerate (default: 10) */
  maxNodes?: number
}

export interface DiscoveryConfig {
  extraSelectors?: Array<{ selector: string; role: string; name: string }>
  /** Override framework selectors (defaults to FRAMEWORK_SELECTORS from constants) */
  frameworkSelectors?: FrameworkSelector[]
}
```

- [ ] **Step 2: Update constants.ts**

```typescript
import type { FrameworkSelector } from './extract/region-discovery'

// ... existing exports ...

export const FRAMEWORK_SELECTORS: FrameworkSelector[] = [
  {
    selector: '.vue-flow',
    role: 'main-canvas',
    name: 'Canvas',
    nodeSelector: '.vue-flow__node',
    nodeContentSelector: '.vue-flow__node[data-id="{id}"]',
    maxNodes: 10,
  },
  { selector: '.vue-flow__controls', role: 'toolbar', name: 'Canvas Controls' },
  { selector: '[data-canvas]', role: 'main-canvas', name: 'Canvas' },
]
```

- [ ] **Step 3: Update region-discovery.ts canvas enumeration to use config**

Replace the hardcoded `.vue-flow__node` / `.device-node` / `.cdn-node` block (lines 107-119) with:

```typescript
      // For canvas regions with nodeSelector, enumerate child nodes
      if (fw.nodeSelector) {
        const nodeCount = await page.locator(fw.nodeSelector).count()
        for (let i = 0; i < Math.min(nodeCount, fw.maxNodes ?? 10); i++) {
          const nodeId = await page.locator(fw.nodeSelector).nth(i).getAttribute('data-id')
          if (nodeId) {
            // Use nodeContentSelector if provided, otherwise use the node itself
            const nodeSelector = fw.nodeContentSelector
              ? fw.nodeContentSelector.replace('{id}', nodeId)
              : `${fw.nodeSelector}[data-id="${nodeId}"]`
            regions.push({
              role: 'canvas-node',
              name: nodeId,
              selector: nodeSelector,
              source: 'config-selector',
            })
          }
        }
      }
```

- [ ] **Step 4: Update discoverRegions to accept config framework selectors**

Near the top of `discoverRegions`, read framework selectors from config:

```typescript
  const frameworkSelectors = config?.frameworkSelectors ?? FRAMEWORK_SELECTORS
```

And replace `FRAMEWORK_SELECTORS` usage in the Level 2.5 loop with `frameworkSelectors`.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run -v`
Expected: All pass (tests use the fixture which has `.vue-flow__node` elements, and the default config still includes VueFlow)

- [ ] **Step 6: Commit**

```bash
git add src/constants.ts src/extract/region-discovery.ts
git commit -m "refactor: move framework canvas selectors to config, remove hardcoded .device-node"
```

---

### Task 12: Pluggable Readiness Strategies

**Problem:** Fixed 4-second sleep (`waitForTimeout(SETTLE_MS)`) is too long for simple pages, too short for complex ones.

**Files:**
- Create: `src/browser/readiness.ts`
- Create: `tests/browser/readiness.test.ts`
- Modify: `src/browser/session.ts`
- Modify: `src/constants.ts`

- [ ] **Step 1: Write failing test**

Create `tests/browser/readiness.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { BrowserSession } from '../../src/browser/session'
import { join } from 'path'

describe('readiness strategies', () => {
  let session: BrowserSession | null = null

  afterEach(async () => {
    if (session) {
      await session.close()
      session = null
    }
  })

  it('networkIdle waits for no network activity', async () => {
    session = await BrowserSession.launch({ readiness: 'networkIdle' })
    const url = `file://${join(__dirname, '../../fixtures/sample-page.html')}`
    const start = Date.now()
    await session.navigateTo(url)
    const elapsed = Date.now() - start
    // file:// URL has no network — should complete much faster than 4s
    expect(elapsed).toBeLessThan(3000)
  })

  it('selector strategy waits for element to appear', async () => {
    session = await BrowserSession.launch({
      readiness: { selector: '[role="banner"]' },
    })
    const url = `file://${join(__dirname, '../../fixtures/sample-page.html')}`
    await session.navigateTo(url)
    // If we got here without timeout, the selector was found
    const banner = await session.page.locator('[role="banner"]').count()
    expect(banner).toBe(1)
  })

  it('fixed strategy uses explicit timeout', async () => {
    session = await BrowserSession.launch({
      readiness: { fixedMs: 500 },
    })
    const url = `file://${join(__dirname, '../../fixtures/sample-page.html')}`
    const start = Date.now()
    await session.navigateTo(url)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(500)
    expect(elapsed).toBeLessThan(2000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/browser/readiness.test.ts -v`
Expected: FAIL — `readiness` option doesn't exist

- [ ] **Step 3: Create readiness.ts**

Create `src/browser/readiness.ts`:

```typescript
import type { Page } from 'playwright'

export type ReadinessStrategy =
  | 'networkIdle'
  | 'domContentLoaded'
  | { selector: string; timeoutMs?: number }
  | { fixedMs: number }

/**
 * Wait for the page to be "ready" according to the given strategy.
 *
 * - networkIdle: Wait for network to be idle (no requests for 500ms)
 * - domContentLoaded: Wait for DOMContentLoaded event only (fast, no settle)
 * - { selector }: Wait for a specific element to appear
 * - { fixedMs }: Fixed timeout (legacy behavior)
 */
export async function waitForReadiness(
  page: Page,
  strategy: ReadinessStrategy,
): Promise<void> {
  if (strategy === 'networkIdle') {
    await page.waitForLoadState('networkidle')
    return
  }

  if (strategy === 'domContentLoaded') {
    await page.waitForLoadState('domcontentloaded')
    return
  }

  if ('selector' in strategy) {
    await page.waitForSelector(strategy.selector, {
      timeout: strategy.timeoutMs ?? 10000,
    })
    return
  }

  if ('fixedMs' in strategy) {
    await page.waitForTimeout(strategy.fixedMs)
    return
  }
}
```

- [ ] **Step 4: Update BrowserSession to use readiness**

In `src/browser/session.ts`:

```typescript
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { DEFAULT_VIEWPORT } from '../constants'
import { waitForReadiness, type ReadinessStrategy } from './readiness'

export interface SessionOptions {
  viewport?: { width: number; height: number }
  colorScheme?: 'dark' | 'light'
  readiness?: ReadinessStrategy
}

export class BrowserSession {
  private constructor(
    private browser: Browser,
    private context: BrowserContext,
    readonly page: Page,
    private readiness: ReadinessStrategy,
  ) {}

  static async launch(options?: SessionOptions): Promise<BrowserSession> {
    const viewport = options?.viewport ?? DEFAULT_VIEWPORT
    const colorScheme = options?.colorScheme ?? 'dark'
    const readiness: ReadinessStrategy = options?.readiness ?? 'networkIdle'

    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport, colorScheme })

    await context.addInitScript(() => {
      const style = document.createElement('style')
      style.textContent = '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }'
      document.head.appendChild(style)
    })

    const page = await context.newPage()
    return new BrowserSession(browser, context, page, readiness)
  }

  async navigateTo(url: string): Promise<void> {
    await this.page.goto(url)
    await waitForReadiness(this.page, this.readiness)
  }

  async close(): Promise<void> {
    await this.browser.close()
  }
}
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run -v`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/browser/readiness.ts tests/browser/readiness.test.ts src/browser/session.ts
git commit -m "feat: pluggable readiness strategies replacing fixed 4s sleep"
```

---

## Phase 6: Remaining Bug Fixes

### Task 13: Fix Invariant False Positives from Unresolved Nodes

**Problem:** When CDP fails to resolve a node, `buildComponents` fabricates a placeholder with `visible: false` and zero bounds. The diff engine then flags these as invariant violations — but they're extraction failures, not UI bugs.

**Files:**
- Modify: `src/extract/merge.ts`
- Modify: `src/fingerprint/types.ts`
- Test: `tests/fingerprint/diff-engine.test.ts`

- [ ] **Step 1: Write test for unresolved node handling**

Add to `tests/fingerprint/diff-engine.test.ts`:

```typescript
it('does not flag unresolved components as invariant violations', () => {
  const region: Region = {
    role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 },
    background: '#000', childCount: 1,
    components: [makeComponent('main/button["Save"]', {
      visible: false,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      opacity: '0',
      _unresolved: true,
    } as Partial<Component['props']>)],
  }
  const fp = makeFingerprint({ main: region })
  const report = diffFingerprints(fp, fp)
  // Unresolved components should NOT produce invariant failures
  expect(report.invariantFailures.length).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fingerprint/diff-engine.test.ts -v`
Expected: FAIL — unresolved components currently trigger invariant failures

- [ ] **Step 3: Add _unresolved flag to ElementProps**

In `src/fingerprint/types.ts`, add to `ElementProps`:

```typescript
export interface ElementProps {
  // ... existing props ...
  /** True if CDP failed to resolve this node — skip invariant checks */
  _unresolved?: boolean
}
```

- [ ] **Step 4: Set _unresolved flag in merge.ts**

In `src/extract/merge.ts`, in the `buildComponents` function, add `_unresolved: true` to the fallback props object:

```typescript
    const props: ElementProps = childVisual
      ? { role: child.role, name: child.name, ...childVisual }
      : {
          role: child.role, name: child.name,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          visible: false, backgroundColor: '', color: '',
          fontSize: '', borderWidth: '', opacity: '0',
          display: '', overflow: '', textOverflow: false,
          textContent: child.name, childCount: child.children?.length ?? 0,
          _unresolved: true,
        }
```

- [ ] **Step 5: Skip invariant checks for unresolved components**

In `src/fingerprint/diff-engine.ts`, add a guard in the invariant loop:

```typescript
  for (const [regionKey, region] of Object.entries(current.regions)) {
    for (const comp of region.components) {
      // Skip invariant checks for components that failed CDP resolution
      if (comp.props._unresolved) continue

      for (const inv of INVARIANTS) {
        // ... existing check logic ...
      }
    }
  }
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run -v`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/fingerprint/types.ts src/extract/merge.ts src/fingerprint/diff-engine.ts tests/fingerprint/diff-engine.test.ts
git commit -m "fix: skip invariant checks for unresolved CDP nodes (prevents false positives)"
```

---

### Task 14: Fix data-testid Deduplication

**Problem:** Two elements with the same `data-testid` produce duplicate component entries pointing to the same element.

**Note:** This is already addressed in Task 10 (ungrouped) where we added `seen.has(testIdEl.testId)` dedup. If Task 10 was completed, this is done. If implementing independently:

**Files:**
- Modify: `src/extract/merge.ts` (data-testid injection block)

- [ ] **Step 1: Write test for duplicate data-testid**

Add to `tests/extract/merge.test.ts`:

```typescript
it('does not produce duplicate components for same data-testid', async () => {
  const fp = await buildFingerprint(page)
  const allCompIds: string[] = []
  for (const region of Object.values(fp.regions)) {
    for (const comp of region.components) {
      allCompIds.push(comp.id)
    }
  }
  for (const comp of fp.ungrouped) {
    allCompIds.push(comp.id)
  }
  // No duplicates
  const unique = new Set(allCompIds)
  expect(unique.size).toBe(allCompIds.length)
})
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/extract/merge.test.ts -v`
Expected: PASS (if Task 10 was completed with dedup). If FAIL, add the `seen` set from Task 10.

- [ ] **Step 3: Commit (if changes were needed)**

```bash
git add src/extract/merge.ts tests/extract/merge.test.ts
git commit -m "fix: deduplicate data-testid elements to prevent duplicate components"
```

---

## Post-Implementation Verification

After all tasks are complete:

- [ ] **Run full test suite:** `npx vitest run -v`
- [ ] **Run a real capture against the fixture:** `npx tsx src/cli.ts capture --url file://$(pwd)/fixtures/sample-page.html --out .test-audit`
- [ ] **Verify the output YAML is valid:** Check `.test-audit/fingerprint.yaml` contains `ungrouped` entries and proper component IDs
- [ ] **Run a verify against the captured baseline:** `npx tsx src/cli.ts verify --url file://$(pwd)/fixtures/sample-page.html --baseline .test-audit`
- [ ] **Check report.json has separated invariant/regression sections**
- [ ] **Verify no file exceeds 300 lines:** `wc -l src/**/*.ts src/*.ts`
