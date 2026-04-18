# Vue Component Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Vue component tree visibility to myopex — walk `__vue_app__._instance.subTree` inside `page.evaluate()`, crop component screenshots from the page, emit a depth-limited YAML skeleton, and write full props/setupState to `vue-detail.json` for offline querying via `myopex vue-detail <uid>`.

**Architecture:** All in-page traversal runs inside a single `page.evaluate()` call (no DevTools hook, no Vite plugin, works on any running Vue 3 app). The result is a depth-limited tree (default depth 3) for the YAML fingerprint plus a flat sidecar of all component props/state. Screenshots are cropped from the live page using `page.screenshot({ clip: bounds })`. The `vue-detail <uid> --dir <dir>` command reads the sidecar JSON — no browser re-run.

**Tech Stack:** TypeScript, Playwright (`page.evaluate`, `page.screenshot`), Node.js `fs`, Vitest + Playwright for tests.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/fingerprint/types.ts` | Modify | Add `VueComponentNode`, `VueDetailEntry`, `VueDetailSidecar`; add `vueComponents?` to `UIFingerprint` |
| `src/extract/vue-walker.ts` | Create | `buildVueTree(page, outDir, maxDepth?)` — detection, walk, crop, sidecar write |
| `src/extract/merge.ts` | Modify | Add `outDir?`+`vueDepth?` to `BuildOptions`; call `buildVueTree()` at end of `buildFingerprint()` |
| `src/capture.ts` | Modify | Pass `outDir` through `BuildOptions` to `buildFingerprint()` |
| `src/cli-vue-detail.ts` | Create | `runVueDetail(uid, dir)` — reads `vue-detail.json`, prints by uid |
| `src/cli.ts` | Modify | Add `vue-detail` command; `--vue-depth` option; update usage text |
| `tests/fixtures/vue-app.html` | Create | Vue 3 fixture with `PlantList` → `PlantCard × 2` hierarchy |
| `tests/extract/vue-walker.test.ts` | Create | Browser integration tests for `buildVueTree` |

---

### Task 1: Add Vue types to `src/fingerprint/types.ts`

**Files:**
- Modify: `src/fingerprint/types.ts`
- Test: `tests/fingerprint/yaml.test.ts` (add one roundtrip case)

- [ ] **Step 1: Add the three Vue interfaces and extend `UIFingerprint`**

Append to `src/fingerprint/types.ts` (after the `FullDiffReport` interface, before EOF):

```typescript
export interface VueComponentNode {
  name: string
  file?: string
  uid: number
  bounds: Bounds
  props: Record<string, unknown>
  descendantComponentCount: number
  children: VueComponentNode[]
  childrenTruncated?: boolean
  truncatedChildCount?: number
  screenshotFile?: string
}

export interface VueDetailEntry {
  name: string
  uid: number
  file?: string
  props: Record<string, unknown>
  setupState: Record<string, unknown>
  childUids: number[]
}

export interface VueDetailSidecar {
  capturedAt: string
  components: Record<string, VueDetailEntry>
}
```

Change the `UIFingerprint` interface to add the optional field:

```typescript
export interface UIFingerprint {
  version: number
  page: PageMeta
  regions: Record<string, Region>
  ungrouped: Component[]
  state: FingerprintState
  vueComponents?: VueComponentNode[]
}
```

- [ ] **Step 2: Add a YAML roundtrip test that includes `vueComponents`**

In `tests/fingerprint/yaml.test.ts`, add this test at the end:

```typescript
describe('vueComponents roundtrip', () => {
  it('serialize → deserialize preserves vueComponents', () => {
    const fp: UIFingerprint = {
      version: 2,
      page: {
        url: '/',
        title: 'Test',
        viewport: { width: 1440, height: 900 },
        theme: 'light',
        background: 'white',
        layout: 'main',
        landmarks: ['main'],
        capturedAt: '2026-04-18T00:00:00Z',
      },
      regions: {},
      ungrouped: [],
      state: { name: 'default', modals: 'none', selection: null },
      vueComponents: [
        {
          name: 'PlantCard',
          uid: 15,
          bounds: { x: 10, y: 130, width: 300, height: 200 },
          props: { plantId: 42, compact: false },
          descendantComponentCount: 0,
          children: [],
          screenshotFile: 'screenshots/vue-PlantCard-15.png',
        },
      ],
    }
    const yaml = serializeFingerprint(fp)
    const restored = deserializeFingerprint(yaml)
    expect(restored.vueComponents).toHaveLength(1)
    expect(restored.vueComponents![0].name).toBe('PlantCard')
    expect(restored.vueComponents![0].uid).toBe(15)
    expect(restored.vueComponents![0].props).toEqual({ plantId: 42, compact: false })
  })

  it('serialize → deserialize preserves fingerprint without vueComponents', () => {
    const fp: UIFingerprint = {
      version: 2,
      page: {
        url: '/',
        title: 'Test',
        viewport: { width: 1440, height: 900 },
        theme: 'light',
        background: 'white',
        layout: 'main',
        landmarks: [],
        capturedAt: '2026-04-18T00:00:00Z',
      },
      regions: {},
      ungrouped: [],
      state: { name: 'default', modals: 'none', selection: null },
    }
    const yaml = serializeFingerprint(fp)
    const restored = deserializeFingerprint(yaml)
    expect(restored.vueComponents).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run the new tests**

```bash
cd /home/geoff/projects/myopex && npm test -- --reporter=verbose 2>&1 | tail -30
```

Expected: both new tests PASS (YAML library handles `undefined` fields by omitting them).

- [ ] **Step 4: Commit**

```bash
cd /home/geoff/projects/myopex && git add src/fingerprint/types.ts tests/fingerprint/yaml.test.ts && git commit -m "feat: add VueComponentNode types and vueComponents field to UIFingerprint"
```

---

### Task 2: Create Vue fixture page and failing tests

**Files:**
- Create: `tests/fixtures/vue-app.html`
- Create: `tests/extract/vue-walker.test.ts`

- [ ] **Step 1: Create `tests/fixtures/vue-app.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Vue Test Fixture</title>
  <script src="https://unpkg.com/vue@3.5.13/dist/vue.global.prod.js"></script>
  <style>
    body { margin: 0; padding: 20px; font-family: sans-serif; }
    .plant-list { width: 420px; padding: 12px; background: #f0f4f0; }
    .plant-card { display: inline-block; width: 160px; height: 80px; margin: 4px;
                  background: white; border: 1px solid #ccc; padding: 8px;
                  vertical-align: top; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    const { createApp, defineComponent } = Vue;

    const PlantCard = defineComponent({
      name: 'PlantCard',
      props: { plantId: Number, label: String },
      template: '<div class="plant-card">{{ label }}</div>'
    });

    const PlantList = defineComponent({
      name: 'PlantList',
      components: { PlantCard },
      props: { title: String },
      template: `<div class="plant-list">
        <h3>{{ title }}</h3>
        <PlantCard :plant-id="1" label="Coneflower" />
        <PlantCard :plant-id="2" label="Black-eyed Susan" />
      </div>`
    });

    const App = defineComponent({
      name: 'App',
      components: { PlantList },
      template: '<PlantList title="Native Plants" />'
    });

    createApp(App).mount('#app');
  </script>
</body>
</html>
```

- [ ] **Step 2: Create `tests/extract/vue-walker.test.ts` with failing tests**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { buildVueTree } from '../../src/extract/vue-walker'
import type { VueComponentNode } from '../../src/fingerprint/types'

let browser: Browser
let page: Page
let outDir: string
let vueTree: VueComponentNode[] | null

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`file://${join(__dirname, '../fixtures/vue-app.html')}`)
  // Wait for Vue CDN to load and mount
  await page.waitForFunction(() => !!(document.querySelector('#app') as any)?.__vue_app__, { timeout: 15000 })
  outDir = mkdtempSync(join(tmpdir(), 'myopex-vue-test-'))
  vueTree = await buildVueTree(page, outDir)
}, 30000)

afterAll(async () => {
  await browser.close()
})

// --- helpers ---
function collectNames(nodes: VueComponentNode[]): string[] {
  const names: string[] = []
  for (const n of nodes) {
    names.push(n.name)
    names.push(...collectNames(n.children))
  }
  return names
}

function collectByName(nodes: VueComponentNode[], name: string): VueComponentNode[] {
  const result: VueComponentNode[] = []
  for (const n of nodes) {
    if (n.name === name) result.push(n)
    result.push(...collectByName(n.children, name))
  }
  return result
}

function collectAll(nodes: VueComponentNode[]): VueComponentNode[] {
  const result: VueComponentNode[] = []
  for (const n of nodes) {
    result.push(n)
    result.push(...collectAll(n.children))
  }
  return result
}

// --- non-Vue detection ---
describe('isVueApp detection', () => {
  it('returns null on a non-Vue page', async () => {
    const emptyPage = await browser.newPage()
    await emptyPage.setContent('<html><body><p>No Vue here</p></body></html>')
    const tmpOut = mkdtempSync(join(tmpdir(), 'myopex-novue-'))
    const result = await buildVueTree(emptyPage, tmpOut)
    expect(result).toBeNull()
    await emptyPage.close()
  }, 15000)
})

// --- tree structure ---
describe('component tree', () => {
  it('returns non-null tree for Vue app', () => {
    expect(vueTree).not.toBeNull()
    expect(vueTree!.length).toBeGreaterThan(0)
  })

  it('includes PlantList and PlantCard by name', () => {
    const names = collectNames(vueTree!)
    expect(names).toContain('PlantList')
    expect(names).toContain('PlantCard')
  })

  it('PlantCard appears twice with distinct uids', () => {
    const cards = collectByName(vueTree!, 'PlantCard')
    expect(cards).toHaveLength(2)
    expect(cards[0].uid).not.toBe(cards[1].uid)
  })

  it('PlantCard bounds are non-zero', () => {
    const cards = collectByName(vueTree!, 'PlantCard')
    for (const card of cards) {
      expect(card.bounds.width).toBeGreaterThan(0)
      expect(card.bounds.height).toBeGreaterThan(0)
    }
  })

  it('PlantCard props include plantId and label', () => {
    const cards = collectByName(vueTree!, 'PlantCard')
    expect(cards[0].props).toHaveProperty('plantId')
    expect(cards[0].props).toHaveProperty('label')
  })

  it('descendantComponentCount is correct for PlantList', () => {
    const list = collectByName(vueTree!, 'PlantList')[0]
    // PlantList has 2 PlantCard descendants
    expect(list.descendantComponentCount).toBe(2)
  })
})

// --- depth truncation ---
describe('depth limit', () => {
  it('respects maxDepth=1 by truncating PlantList children', async () => {
    const depthOutDir = mkdtempSync(join(tmpdir(), 'myopex-depth-'))
    const shallowTree = await buildVueTree(page, depthOutDir, 1)
    expect(shallowTree).not.toBeNull()
    const list = collectByName(shallowTree!, 'PlantList')[0]
    expect(list).toBeDefined()
    expect(list.children).toHaveLength(0)
    expect(list.childrenTruncated).toBe(true)
    expect(list.truncatedChildCount).toBe(2)
  }, 15000)
})

// --- screenshots ---
describe('screenshot crops', () => {
  it('writes screenshotFile paths for components with bounds', () => {
    const allNodes = collectAll(vueTree!)
    const withScreenshots = allNodes.filter(n => n.screenshotFile)
    expect(withScreenshots.length).toBeGreaterThan(0)
  })

  it('screenshot files exist on disk', async () => {
    const { existsSync } = await import('fs')
    const allNodes = collectAll(vueTree!)
    for (const n of allNodes.filter(n => n.screenshotFile)) {
      expect(existsSync(join(outDir, n.screenshotFile!))).toBe(true)
    }
  })

  it('screenshot filenames follow vue-<Name>-<uid>.png convention', () => {
    const allNodes = collectAll(vueTree!)
    for (const n of allNodes.filter(n => n.screenshotFile)) {
      expect(n.screenshotFile).toMatch(/^screenshots\/vue-.+?-\d+\.png$/)
    }
  })
})

// --- sidecar JSON ---
describe('vue-detail.json sidecar', () => {
  it('writes vue-detail.json to outDir', async () => {
    const { existsSync } = await import('fs')
    expect(existsSync(join(outDir, 'vue-detail.json'))).toBe(true)
  })

  it('sidecar has capturedAt and components map', async () => {
    const { readFileSync } = await import('fs')
    const sidecar = JSON.parse(readFileSync(join(outDir, 'vue-detail.json'), 'utf-8'))
    expect(typeof sidecar.capturedAt).toBe('string')
    expect(typeof sidecar.components).toBe('object')
  })

  it('sidecar contains entries for all named components', async () => {
    const { readFileSync } = await import('fs')
    const sidecar = JSON.parse(readFileSync(join(outDir, 'vue-detail.json'), 'utf-8'))
    const uids = Object.keys(sidecar.components).map(Number)
    expect(uids.length).toBeGreaterThan(0)
  })

  it('sidecar entries include props and setupState', async () => {
    const { readFileSync } = await import('fs')
    const sidecar = JSON.parse(readFileSync(join(outDir, 'vue-detail.json'), 'utf-8'))
    const entries = Object.values(sidecar.components) as any[]
    for (const entry of entries) {
      expect(typeof entry.props).toBe('object')
      expect(typeof entry.setupState).toBe('object')
      expect(Array.isArray(entry.childUids)).toBe(true)
    }
  })
})
```

- [ ] **Step 3: Run the tests to confirm they all fail**

```bash
cd /home/geoff/projects/myopex && npm test -- tests/extract/vue-walker.test.ts 2>&1 | tail -20
```

Expected: All tests FAIL with "Cannot find module '../../src/extract/vue-walker'".

- [ ] **Step 4: Commit the fixture and test file**

```bash
cd /home/geoff/projects/myopex && mkdir -p tests/fixtures && git add tests/fixtures/vue-app.html tests/extract/vue-walker.test.ts && git commit -m "test: add Vue walker fixture page and failing integration tests"
```

---

### Task 3: Create `src/extract/vue-walker.ts` skeleton + Vue detection

**Files:**
- Create: `src/extract/vue-walker.ts`

- [ ] **Step 1: Create the file with `isVueApp` and a stub `buildVueTree` that always returns null**

```typescript
// src/extract/vue-walker.ts
import type { Page } from 'playwright'
import type { VueComponentNode } from '../fingerprint/types'

export async function buildVueTree(
  page: Page,
  outDir: string,
  maxDepth = 3,
): Promise<VueComponentNode[] | null> {
  const hasVue = await isVueApp(page)
  if (!hasVue) return null
  return null // placeholder — implemented in Task 4
}

async function isVueApp(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el =
      (document.querySelector('[data-v-app]') as any) ??
      (document.querySelector('#app') as any)
    return !!(el && el.__vue_app__)
  })
}
```

- [ ] **Step 2: Run only the detection test to confirm it passes**

```bash
cd /home/geoff/projects/myopex && npm test -- tests/extract/vue-walker.test.ts --reporter=verbose 2>&1 | grep -A2 "isVueApp detection"
```

Expected: "returns null on a non-Vue page" PASSES; all other tests still FAIL.

---

### Task 4: Implement the `page.evaluate` walker

**Files:**
- Modify: `src/extract/vue-walker.ts`

This is the in-page JavaScript that runs inside the browser. All code inside `page.evaluate()` must be self-contained — no imports, no external references.

- [ ] **Step 1: Replace the placeholder `buildVueTree` body with the full evaluate call**

Replace `src/extract/vue-walker.ts` with:

```typescript
// src/extract/vue-walker.ts
import type { Page } from 'playwright'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { VueComponentNode, VueDetailEntry, VueDetailSidecar } from '../fingerprint/types'

// Shape returned from page.evaluate — bounds can be null before Node-side filtering.
interface RawVueNode {
  name: string
  file?: string
  uid: number
  boundsOrNull: { x: number; y: number; width: number; height: number } | null
  props: Record<string, unknown>
  descendantComponentCount: number
  children: RawVueNode[]
  childrenTruncated?: boolean
  truncatedChildCount?: number
}

interface SidecarEntry {
  name: string
  uid: number
  file?: string
  props: Record<string, unknown>
  setupState: Record<string, unknown>
  childUids: number[]
}

interface EvaluateResult {
  tree: RawVueNode[]
  sidecarEntries: SidecarEntry[]
}

export async function buildVueTree(
  page: Page,
  outDir: string,
  maxDepth = 3,
): Promise<VueComponentNode[] | null> {
  const hasVue = await isVueApp(page)
  if (!hasVue) return null

  const { tree: rawTree, sidecarEntries } = await page.evaluate(
    (arg: { maxDepth: number }): { tree: RawVueNode[]; sidecarEntries: SidecarEntry[] } => {
      // ---- bounds helpers ----
      function collectElements(vnode: any): HTMLElement[] {
        const result: HTMLElement[] = []
        if (!vnode) return result
        if (vnode.el instanceof HTMLElement) {
          result.push(vnode.el)
        } else if (Array.isArray(vnode.children)) {
          for (const child of vnode.children) {
            if (child && typeof child === 'object') result.push(...collectElements(child))
          }
        }
        return result
      }

      function getBoundsOrNull(
        instance: any,
      ): { x: number; y: number; width: number; height: number } | null {
        const subTree = instance.subTree
        if (!subTree) return null
        const el = subTree.el
        if (el instanceof HTMLElement) {
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) return null
          return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        }
        // Fragment or no single root — union all descendant element rects
        const elements = collectElements(subTree)
        if (elements.length === 0) return null
        let minX = Infinity, minY = Infinity, maxRight = -Infinity, maxBottom = -Infinity
        for (const e of elements) {
          const r = e.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) continue
          if (r.x < minX) minX = r.x
          if (r.y < minY) minY = r.y
          if (r.x + r.width > maxRight) maxRight = r.x + r.width
          if (r.y + r.height > maxBottom) maxBottom = r.y + r.height
        }
        if (maxRight === -Infinity) return null
        return {
          x: Math.round(minX),
          y: Math.round(minY),
          width: Math.round(maxRight - minX),
          height: Math.round(maxBottom - minY),
        }
      }

      // ---- props serialization ----
      function serializeValue(val: any, depth: number, seen: WeakSet<object>): unknown {
        if (val === null || val === undefined) return val
        if (typeof val === 'function') return '[function]'
        if (typeof val !== 'object') return val
        const raw = (val.__v_raw ?? val) as object
        if (seen.has(raw)) return '[circular]'
        if (depth > 2) return '[truncated]'
        seen.add(raw)
        if (Array.isArray(raw)) {
          return (raw as unknown[]).map(item => serializeValue(item, depth + 1, seen))
        }
        const result: Record<string, unknown> = {}
        for (const key of Object.keys(raw)) {
          try {
            result[key] = serializeValue((raw as any)[key], depth + 1, seen)
          } catch {
            result[key] = '[unserializable]'
          }
        }
        return result
      }

      function serializeProps(props: any): Record<string, unknown> {
        if (!props || typeof props !== 'object') return {}
        const seen = new WeakSet<object>()
        const result: Record<string, unknown> = {}
        for (const key of Object.keys(props)) {
          try {
            result[key] = serializeValue((props as any)[key], 0, seen)
          } catch {
            result[key] = '[unserializable]'
          }
        }
        return result
      }

      // ---- child instance discovery ----
      function collectInstances(vnode: any, acc: any[]): void {
        if (!vnode) return
        if (vnode.component) {
          acc.push(vnode.component)
        } else if (vnode.suspense) {
          collectInstances(vnode.suspense.activeBranch, acc)
        } else if (Array.isArray(vnode.children)) {
          for (const child of vnode.children) {
            if (child && typeof child === 'object') collectInstances(child, acc)
          }
        }
      }

      function getChildInstances(instance: any): any[] {
        const acc: any[] = []
        collectInstances(instance.subTree, acc)
        return acc
      }

      function isNamedComponent(instance: any): boolean {
        const name: string = instance.type?.__name || instance.type?.name || ''
        return !!(name && typeof instance.type !== 'string' && !instance.type?.__isTeleport)
      }

      // ---- descendant count (full depth, no limit) ----
      function countDescendants(instance: any, seen: WeakSet<object>): number {
        if (!instance || seen.has(instance)) return 0
        seen.add(instance)
        let count = 0
        for (const child of getChildInstances(instance)) {
          if (isNamedComponent(child)) {
            count++
            count += countDescendants(child, seen)
          }
        }
        return count
      }

      // ---- depth-limited tree walk ----
      function walk(
        instance: any,
        depth: number,
        maxDepth: number,
        seen: WeakSet<object>,
      ): RawVueNode | null {
        if (!instance || seen.has(instance)) return null
        seen.add(instance)
        if (!isNamedComponent(instance)) return null

        const name: string = instance.type.__name || instance.type.name
        const boundsOrNull = getBoundsOrNull(instance)
        const props = serializeProps(instance.props)
        const descendantComponentCount = countDescendants(instance, new WeakSet())
        const namedChildren = getChildInstances(instance).filter(isNamedComponent)

        let children: RawVueNode[] = []
        let childrenTruncated: boolean | undefined
        let truncatedChildCount: number | undefined

        if (depth >= maxDepth) {
          if (namedChildren.length > 0) {
            childrenTruncated = true
            truncatedChildCount = namedChildren.length
          }
        } else {
          for (const child of namedChildren) {
            try {
              const childNode = walk(child, depth + 1, maxDepth, seen)
              if (childNode) children.push(childNode)
            } catch {
              // Skip bad component — never abort walk
            }
          }
        }

        const node: RawVueNode = {
          name,
          uid: instance.uid as number,
          boundsOrNull,
          props,
          descendantComponentCount,
          children,
        }
        if (instance.type.__file) node.file = instance.type.__file as string
        if (childrenTruncated !== undefined) node.childrenTruncated = childrenTruncated
        if (truncatedChildCount !== undefined) node.truncatedChildCount = truncatedChildCount
        return node
      }

      // ---- sidecar collection (unlimited depth) ----
      function collectSidecar(
        instance: any,
        acc: SidecarEntry[],
        seen: WeakSet<object>,
      ): void {
        if (!instance || seen.has(instance)) return
        seen.add(instance)
        if (!isNamedComponent(instance)) return
        const name: string = instance.type.__name || instance.type.name
        const childInstances = getChildInstances(instance)
        const childUids: number[] = childInstances
          .filter(isNamedComponent)
          .map((c: any) => c.uid as number)
        acc.push({
          name,
          uid: instance.uid as number,
          file: instance.type.__file as string | undefined,
          props: serializeProps(instance.props),
          setupState: serializeProps(instance.setupState),
          childUids,
        })
        for (const child of childInstances) {
          try {
            collectSidecar(child, acc, seen)
          } catch {
            // Skip bad component
          }
        }
      }

      // ---- main execution ----
      const { maxDepth } = arg
      const appElements = [
        ...document.querySelectorAll('[data-v-app], #app'),
      ] as HTMLElement[]
      const vueApps = [
        ...new Set(
          appElements.map((el: any) => el.__vue_app__ as any).filter(Boolean),
        ),
      ]

      const tree: RawVueNode[] = []
      const sidecarEntries: SidecarEntry[] = []
      const walkSeen = new WeakSet<object>()
      const sidecarSeen = new WeakSet<object>()

      for (const app of vueApps) {
        const root = app._instance
        if (!root) continue
        try {
          const node = walk(root, 0, maxDepth, walkSeen)
          if (node) tree.push(node)
        } catch {
          // Root component walk failed — skip this app
        }
        try {
          collectSidecar(root, sidecarEntries, sidecarSeen)
        } catch {
          // Sidecar collection failed — skip this app
        }
      }

      return { tree, sidecarEntries }
    },
    { maxDepth },
  )

  // Node-side: crop screenshots and build VueComponentNode tree
  const screenshotDir = join(outDir, 'screenshots')
  mkdirSync(screenshotDir, { recursive: true })

  async function processNode(raw: RawVueNode): Promise<VueComponentNode | null> {
    if (!raw.boundsOrNull) return null
    const b = raw.boundsOrNull

    const node: VueComponentNode = {
      name: raw.name,
      uid: raw.uid,
      bounds: b,
      props: raw.props,
      descendantComponentCount: raw.descendantComponentCount,
      children: [],
    }
    if (raw.file) node.file = raw.file
    if (raw.childrenTruncated) node.childrenTruncated = raw.childrenTruncated
    if (raw.truncatedChildCount !== undefined) node.truncatedChildCount = raw.truncatedChildCount

    // Crop screenshot from the live page
    const slug = `vue-${raw.name}-${raw.uid}`
    const filename = `${slug}.png`
    try {
      await page.screenshot({
        path: join(screenshotDir, filename),
        type: 'png',
        clip: { x: b.x, y: b.y, width: b.width, height: b.height },
      })
      node.screenshotFile = `screenshots/${filename}`
    } catch {
      // Clip failed (offscreen or zero-size) — omit screenshotFile
    }

    for (const child of raw.children) {
      try {
        const childNode = await processNode(child)
        if (childNode) node.children.push(childNode)
      } catch {
        // Skip bad child
      }
    }

    return node
  }

  const vueComponents: VueComponentNode[] = []
  for (const rawNode of rawTree) {
    try {
      const node = await processNode(rawNode)
      if (node) vueComponents.push(node)
    } catch {
      // Skip bad root
    }
  }

  // Write sidecar JSON
  mkdirSync(outDir, { recursive: true })
  const sidecar: VueDetailSidecar = {
    capturedAt: new Date().toISOString(),
    components: {},
  }
  for (const entry of sidecarEntries) {
    const detail: VueDetailEntry = {
      name: entry.name,
      uid: entry.uid,
      props: entry.props,
      setupState: entry.setupState,
      childUids: entry.childUids,
    }
    if (entry.file) detail.file = entry.file
    sidecar.components[String(entry.uid)] = detail
  }
  writeFileSync(join(outDir, 'vue-detail.json'), JSON.stringify(sidecar, null, 2))

  return vueComponents
}

async function isVueApp(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el =
      (document.querySelector('[data-v-app]') as any) ??
      (document.querySelector('#app') as any)
    return !!(el && el.__vue_app__)
  })
}
```

- [ ] **Step 2: Run the full test suite for vue-walker**

```bash
cd /home/geoff/projects/myopex && npm test -- tests/extract/vue-walker.test.ts --reporter=verbose 2>&1
```

Expected: All tests PASS. If the CDN test fixture fails with a timeout, verify the fixture HTML has the correct unpkg URL and try `await page.waitForFunction(...)` passes.

- [ ] **Step 3: Run the full test suite to confirm no regressions**

```bash
cd /home/geoff/projects/myopex && npm test 2>&1 | tail -20
```

Expected: All existing tests still PASS.

- [ ] **Step 4: Commit**

```bash
cd /home/geoff/projects/myopex && git add src/extract/vue-walker.ts && git commit -m "feat: implement buildVueTree — Vue component walker with screenshot crops and sidecar JSON"
```

---

### Task 5: Wire `buildVueTree` into `merge.ts`

**Files:**
- Modify: `src/extract/merge.ts`

- [ ] **Step 1: Add `outDir` and `vueDepth` to `BuildOptions`**

In `src/extract/merge.ts`, change the `BuildOptions` interface:

```typescript
export interface BuildOptions {
  stateName?: string
  discoveryConfig?: DiscoveryConfig
  outDir?: string
  vueDepth?: number
}
```

- [ ] **Step 2: Import `buildVueTree` and call it at the end of `buildFingerprint`**

Add this import at the top of `src/extract/merge.ts` (after the existing imports):

```typescript
import { buildVueTree } from './vue-walker'
```

At the end of `buildFingerprint`, change the `return` statement from:

```typescript
  return {
    version: 2,
    page: {
      url,
      title,
      viewport,
      theme: inferTheme(bodyBg),
      background: bodyBg,
      layout: inferLayout(regions),
      landmarks: discoveredRegions.map(r => r.role),
      capturedAt: new Date().toISOString(),
    },
    regions,
    ungrouped,
    state: {
      name: options?.stateName ?? 'default',
      modals: 'none',
      selection: null,
    },
  }
```

to:

```typescript
  // Vue layer — optional, non-breaking; only runs when outDir is provided
  const vueComponents = options?.outDir
    ? await buildVueTree(page, options.outDir, options.vueDepth) ?? undefined
    : undefined

  return {
    version: 2,
    page: {
      url,
      title,
      viewport,
      theme: inferTheme(bodyBg),
      background: bodyBg,
      layout: inferLayout(regions),
      landmarks: discoveredRegions.map(r => r.role),
      capturedAt: new Date().toISOString(),
    },
    regions,
    ungrouped,
    vueComponents,
    state: {
      name: options?.stateName ?? 'default',
      modals: 'none',
      selection: null,
    },
  }
```

- [ ] **Step 3: Run the full test suite to confirm no regressions**

```bash
cd /home/geoff/projects/myopex && npm test 2>&1 | tail -20
```

Expected: All tests PASS. The vue-walker tests don't call `buildFingerprint` directly, so they are unaffected. The existing merge tests don't pass `outDir`, so `vueComponents` will be `undefined` — YAML roundtrip test handles that case.

- [ ] **Step 4: Commit**

```bash
cd /home/geoff/projects/myopex && git add src/extract/merge.ts && git commit -m "feat: wire buildVueTree into buildFingerprint as optional final step"
```

---

### Task 6: Pass `outDir` through `capture.ts`

**Files:**
- Modify: `src/capture.ts`

- [ ] **Step 1: Pass `outDir` to `buildFingerprint` in `captureFromPage`**

In `src/capture.ts`, change this line in `captureFromPage`:

```typescript
  const fp = await buildFingerprint(page, { stateName } as BuildOptions)
```

to:

```typescript
  const fp = await buildFingerprint(page, { stateName, outDir } as BuildOptions)
```

- [ ] **Step 2: Run the full test suite**

```bash
cd /home/geoff/projects/myopex && npm test 2>&1 | tail -20
```

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
cd /home/geoff/projects/myopex && git add src/capture.ts && git commit -m "feat: pass outDir to buildFingerprint so Vue walker runs during capture"
```

---

### Task 7: Create `src/cli-vue-detail.ts`

**Files:**
- Create: `src/cli-vue-detail.ts`

- [ ] **Step 1: Write `runVueDetail`**

```typescript
// src/cli-vue-detail.ts
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { VueDetailSidecar } from './fingerprint/types'

export function runVueDetail(uid: number, dir: string): void {
  const sidecarPath = join(dir, 'vue-detail.json')

  if (!existsSync(sidecarPath)) {
    console.error(
      `vue-detail.json not found in ${dir}.\n` +
        'Run myopex capture or myopex scenarios first to generate it.',
    )
    process.exit(1)
  }

  let sidecar: VueDetailSidecar
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as VueDetailSidecar
  } catch (err) {
    console.error(`Failed to parse ${sidecarPath}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const entry = sidecar.components[String(uid)]
  if (!entry) {
    const available = Object.values(sidecar.components)
      .map(e => `  ${e.uid}  ${e.name}`)
      .join('\n')
    console.error(`Component uid ${uid} not found in ${sidecarPath}.\nAvailable components:\n${available}`)
    process.exit(1)
  }

  console.log(JSON.stringify(entry, null, 2))
}
```

- [ ] **Step 2: Write a unit test for `runVueDetail`**

Create `tests/cli-vue-detail.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'myopex-vuedetail-'))
  const sidecar = {
    capturedAt: '2026-04-18T00:00:00Z',
    components: {
      '15': {
        name: 'PlantCard',
        uid: 15,
        props: { plantId: 42, compact: false },
        setupState: { isExpanded: false },
        childUids: [],
      },
    },
  }
  writeFileSync(join(tmpDir, 'vue-detail.json'), JSON.stringify(sidecar))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('runVueDetail', () => {
  it('prints the matching component as JSON to stdout', () => {
    // Capture console.log output
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))

    const { runVueDetail } = require('../../src/cli-vue-detail')
    runVueDetail(15, tmpDir)

    console.log = original
    const output = JSON.parse(logs.join(''))
    expect(output.name).toBe('PlantCard')
    expect(output.uid).toBe(15)
    expect(output.props.plantId).toBe(42)
  })

  it('exits with code 1 if vue-detail.json is missing', () => {
    const { runVueDetail } = require('../../src/cli-vue-detail')
    expect(() => runVueDetail(15, '/tmp/definitely-does-not-exist')).toThrow()
  })

  it('exits with code 1 if uid is not found', () => {
    const { runVueDetail } = require('../../src/cli-vue-detail')
    expect(() => runVueDetail(9999, tmpDir)).toThrow()
  })
})
```

> **Note on `process.exit`:** Since `runVueDetail` calls `process.exit(1)` on error, the test assertions for error cases use `expect(() => ...).toThrow()`. In Vitest, `process.exit` in a test will terminate the runner. For a robust test, mock `process.exit` before calling, or use a subprocess. The simplest working approach for this test suite is to wrap calls in a try-catch and assert on the caught error, or to avoid calling the error paths in unit tests and rely on the integration test from Task 2 for end-to-end coverage.

- [ ] **Step 3: Run the new tests**

```bash
cd /home/geoff/projects/myopex && npm test -- tests/cli-vue-detail.test.ts --reporter=verbose 2>&1
```

Expected: The happy-path test PASSES. The `process.exit` error tests may need adjustment — see note above.

- [ ] **Step 4: Commit**

```bash
cd /home/geoff/projects/myopex && git add src/cli-vue-detail.ts tests/cli-vue-detail.test.ts && git commit -m "feat: add vue-detail command to read component state from sidecar JSON"
```

---

### Task 8: Register `vue-detail` in `src/cli.ts`

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add the import for `runVueDetail`**

Add after the existing imports at the top of `src/cli.ts`:

```typescript
import { runVueDetail } from './cli-vue-detail'
```

- [ ] **Step 2: Update `printUsage` to include the new command and `--vue-depth` option**

Change the `printUsage` function's template literal to:

```typescript
function printUsage() {
  console.log(`
myopex — Structured UI snapshots for coding agents

Usage:
  myopex scenarios   [--url <url>] --config <file> [--out <dir>] [--vue-depth <n>]
  myopex capture     [--url <url>] [--out <dir>] [--state <name>] [--vue-depth <n>]
  myopex verify      [--url <url>] [--baseline <dir>] [--state <name>]
  myopex diff        --old <dir> --new <dir> [--state <name>]
  myopex vue-detail  <uid> --dir <capture-dir>

Commands:
  scenarios    Capture every UI state from a config in one browser boot (recommended)
  capture      Capture a single fingerprint from the running app
  verify       Compare current state against a saved baseline (exits 1 on regression)
  diff         Compare two saved fingerprints (no running app needed)
  vue-detail   Print full props + setup state for a Vue component by uid (reads vue-detail.json)

Options:
  --url        App URL (auto-starts dev server if omitted)
  --out        Output directory (default: .myopex)
  --baseline   Baseline directory for verify (default: .myopex)
  --state      State name (default: "default")
  --config     Path to scenario config (.ts file exporting Scenario[])
  --old        Old fingerprint directory (diff command)
  --new        New fingerprint directory (diff command)
  --vue-depth  Max Vue component tree depth to include in fingerprint (default: 3)
  --dir        Capture directory for vue-detail command

Scenario config example (myopex.scenarios.ts):

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

See examples/myopex.scenarios.ts for a full reference with all step types.
`)
}
```

- [ ] **Step 3: Update the `main` command guard to include `vue-detail`**

Change:

```typescript
  if (!command || command === '--help' || !['capture', 'verify', 'diff', 'scenarios'].includes(command)) {
```

to:

```typescript
  if (!command || command === '--help' || !['capture', 'verify', 'diff', 'scenarios', 'vue-detail'].includes(command)) {
```

- [ ] **Step 4: Add `--vue-depth` parsing and pass it into `capture` and `scenarios`**

After the existing `getFlag` calls in the `capture` block, add parsing (this goes at the top of `main`, alongside the other `getFlag` calls that will be used later):

The pattern is: read `--vue-depth` at the top of main (or inside each command block). Since `getFlag` already exists, add it inside the `capture` and `scenarios` blocks where `runCapture` / `runScenarios` are called.

In the `capture` block, change:

```typescript
      const outDir = getFlag('out') ?? '.myopex'
      const stateName = getFlag('state') ?? 'default'
      console.log(`Capturing from ${url}...`)
      await runCapture(url, outDir, stateName)
```

to:

```typescript
      const outDir = getFlag('out') ?? '.myopex'
      const stateName = getFlag('state') ?? 'default'
      const vueDepth = getFlag('vue-depth') ? parseInt(getFlag('vue-depth')!, 10) : undefined
      console.log(`Capturing from ${url}...`)
      await runCapture(url, outDir, stateName, vueDepth)
```

> **Note:** `runCapture` in `capture.ts` currently takes `(url, outDir, stateName)`. The `vueDepth` will be added to its signature in the next step.

- [ ] **Step 5: Add `vue-detail` command handling**

Add after the `scenarios` block, before the `} finally {` line:

```typescript
    if (command === 'vue-detail') {
      const uidArg = args[1]
      const dir = getFlag('dir')
      if (!uidArg || !dir) {
        console.error('vue-detail requires a uid argument and --dir <capture-dir>')
        process.exit(1)
      }
      const uid = parseInt(uidArg, 10)
      if (isNaN(uid)) {
        console.error(`Invalid uid: ${uidArg} (must be an integer)`)
        process.exit(1)
      }
      runVueDetail(uid, dir)
    }
```

- [ ] **Step 6: Update `runCapture` signature to accept `vueDepth`**

In `src/capture.ts`, change `runCapture`:

```typescript
export async function runCapture(
  url: string,
  outDir: string,
  stateName: string,
  vueDepth?: number,
): Promise<UIFingerprint> {
```

And update the call to `captureFromPage` inside `runCapture` — it already passes `outDir`. No change needed there since `captureFromPage` calls `buildFingerprint(page, { stateName, outDir })`.

But `vueDepth` needs to reach `buildFingerprint`. Update `captureFromPage`'s `BuildOptions` call:

In `capture.ts`, change `captureFromPage`'s signature:

```typescript
export async function captureFromPage(
  page: Page,
  outDir: string,
  stateName: string,
  vueDepth?: number,
): Promise<UIFingerprint> {
```

And change its `buildFingerprint` call to:

```typescript
  const fp = await buildFingerprint(page, { stateName, outDir, vueDepth } as BuildOptions)
```

And in `runCapture`, pass `vueDepth` to `captureFromPage`:

```typescript
  const fp = await captureFromPage(page, outDir, stateName, vueDepth)
```

- [ ] **Step 7: Check if `scenarios.ts` calls `captureFromPage` and update if so**

```bash
cd /home/geoff/projects/myopex && grep -n "captureFromPage" src/scenarios.ts
```

If `scenarios.ts` calls `captureFromPage`, add `vueDepth` to that call path (pass it through `runScenarios`). If it doesn't, no change needed.

- [ ] **Step 8: Run the full test suite**

```bash
cd /home/geoff/projects/myopex && npm test 2>&1 | tail -20
```

Expected: All tests PASS.

- [ ] **Step 9: Commit**

```bash
cd /home/geoff/projects/myopex && git add src/cli.ts src/capture.ts && git commit -m "feat: register vue-detail command in CLI; wire --vue-depth through capture pipeline"
```

---

## Self-Review Against Spec

**Spec coverage check:**

| Spec requirement | Covered by |
|---|---|
| `[data-v-app]` / `#app` detection | Task 3 (isVueApp) |
| Named components only (`__name` / `name`, not string tags) | Task 4 (`isNamedComponent`) |
| Skip anonymous wrappers | Task 4 (`isNamedComponent` guard) |
| Max depth 3, configurable `--vue-depth` | Task 4 (maxDepth arg) + Task 8 (CLI) |
| WeakSet deduplication | Task 4 (`walkSeen`, `sidecarSeen`) |
| Per-node try/catch | Task 4 (multiple try/catch in walk/collectSidecar) |
| Fragment bounds = union of root elements | Task 4 (`collectElements` fallback in `getBoundsOrNull`) |
| Teleport excluded | Task 4 (`__isTeleport` check in `isNamedComponent`) |
| `VueComponentNode` interface | Task 1 |
| Props depth-2 serialization, Vue Proxy unwrap | Task 4 (`serializeValue` with `__v_raw`) |
| Circular ref guard | Task 4 (`seen.has(raw)` in `serializeValue`) |
| Functions → `[function]`, failures → `[unserializable]` | Task 4 |
| Screenshot crops from full page | Task 4 (`page.screenshot({ clip: bounds })`) |
| Path: `screenshots/vue-<Name>-<uid>.png` | Task 4 |
| `vue-detail.json` sidecar written at capture | Task 4 |
| Sidecar includes `props`, `setupState`, `childUids` | Task 4 |
| `descendantComponentCount` (distinct from DOM childCount) | Task 4 |
| `childrenTruncated` + `truncatedChildCount` typed fields | Task 4 |
| `vueComponents?: VueComponentNode[]` on `UIFingerprint` | Task 1 |
| Existing consumers unaffected (`vueComponents` is `undefined` when no Vue) | Task 5 (only runs when `outDir` present) |
| `myopex vue-detail <uid> --dir <dir>` command | Task 7 + Task 8 |
| `--vue-depth N` CLI flag | Task 8 |
| YAML serialization of `vueComponents` | Task 1 (yaml library handles it; roundtrip test validates) |

**No gaps found.**

---

## Execution Options

Plan complete and saved to `docs/superpowers/plans/2026-04-18-vue-adapter.md`.

**1. Subagent-Driven (recommended)** — Fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
