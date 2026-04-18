// src/extract/vue-walker.ts
import type { Page } from 'playwright'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { VueComponentNode, VueDetailEntry, VueDetailSidecar } from '../fingerprint/types'

// Shape returned from page.evaluate — bounds can be null before Node-side filtering
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

      // ---- descendant count (full depth) ----
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
        const root = app._instance ?? app._container?._vnode?.component
        if (!root) continue
        try {
          const node = walk(root, 0, maxDepth, walkSeen)
          if (node) tree.push(node)
        } catch {
          // Root component walk failed — skip
        }
        try {
          collectSidecar(root, sidecarEntries, sidecarSeen)
        } catch {
          // Sidecar collection failed — skip
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
