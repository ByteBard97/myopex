import type { Page } from 'playwright'
import type { UIFingerprint, Region, Component, ElementProps } from '../fingerprint/types'
import { extractAccessibilityTree, type AXNode } from './accessibility'
import { discoverRegions, type DiscoveryConfig } from './region-discovery'
import { batchResolveVisualProps, type ResolvedNode } from './cdp-resolve'

export interface BuildOptions {
  stateName?: string
  discoveryConfig?: DiscoveryConfig
}

/**
 * Build a complete UIFingerprint by:
 *   1. Discovering regions (landmark -> semantic HTML -> config fallback)
 *   2. Extracting the accessibility tree for child enumeration
 *   3. Resolving all relevant AX nodes to visual properties via CDP
 *   4. Merging into the hierarchical UIFingerprint structure
 */
export async function buildFingerprint(
  page: Page,
  options?: BuildOptions,
): Promise<UIFingerprint> {
  const url = page.url()
  const title = await page.title()
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 }

  // Step 1: Discover regions
  const discoveredRegions = await discoverRegions(page, options?.discoveryConfig)

  // Step 2: Get accessibility tree for child enumeration
  const axTree = await extractAccessibilityTree(page)

  // Step 3: Collect all backendDOMNodeIds we need to resolve
  const allNodeIds = new Set<number>()
  for (const region of discoveredRegions) {
    if (region.backendDOMNodeId) allNodeIds.add(region.backendDOMNodeId)
  }

  // Map each discovered region to its AX children
  const landmarkChildMap = buildLandmarkChildMap(axTree, discoveredRegions)
  for (const children of landmarkChildMap.values()) {
    for (const child of children) {
      if (child.backendDOMNodeId) allNodeIds.add(child.backendDOMNodeId)
    }
  }

  // Step 4: Batch resolve all nodes to visual properties
  const resolvedProps = await batchResolveVisualProps(page, [...allNodeIds])

  // Step 5: Extract body background for page-level metadata
  const bodyBg = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  )

  // Step 6: Build the fingerprint
  const regions: Record<string, Region> = {}

  for (const discovered of discoveredRegions) {
    const regionKey = buildRegionKey(discovered.role, discovered.name)

    // Get region visual props from CDP, with selector fallback
    let regionVisual: ResolvedNode | undefined
    if (discovered.backendDOMNodeId) {
      regionVisual = resolvedProps.get(discovered.backendDOMNodeId)
    }
    if (!regionVisual) {
      regionVisual = await extractViaSelector(page, discovered.selector)
      if (!regionVisual) continue
    }

    // Build child components from AX tree children
    const children = landmarkChildMap.get(discovered.role) ?? []
    const components = buildComponents(regionKey, children, resolvedProps)

    regions[regionKey] = {
      role: discovered.role,
      bounds: regionVisual.bounds,
      background: regionVisual.backgroundColor,
      childCount: regionVisual.childCount,
      components,
    }
  }

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
    ungrouped: [],
    state: {
      name: options?.stateName ?? 'default',
      modals: 'none',
      selection: null,
    },
  }
}

/** Map each landmark role to its direct AX children for component enumeration */
function buildLandmarkChildMap(
  tree: AXNode,
  regions: Array<{ role: string; backendDOMNodeId?: number }>,
): Map<string, AXNode[]> {
  const result = new Map<string, AXNode[]>()
  const targetIds = new Set(
    regions.map(r => r.backendDOMNodeId).filter((id): id is number => id != null),
  )

  function walk(node: AXNode) {
    if (node.backendDOMNodeId && targetIds.has(node.backendDOMNodeId)) {
      const region = regions.find(r => r.backendDOMNodeId === node.backendDOMNodeId)
      if (region) {
        result.set(region.role, node.children ?? [])
      }
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return result
}

/** Build Component[] from AX children, skipping generic/none roles */
function buildComponents(
  regionKey: string,
  children: AXNode[],
  resolvedProps: Map<number, ResolvedNode>,
): Component[] {
  const components: Component[] = []
  const nameCounts = new Map<string, number>()

  for (const child of children) {
    if (child.role === 'none' || child.role === 'generic') continue

    const compId = buildComponentId(regionKey, child, nameCounts)

    let childVisual: ResolvedNode | undefined
    if (child.backendDOMNodeId) {
      childVisual = resolvedProps.get(child.backendDOMNodeId)
    }

    const props: ElementProps = childVisual
      ? {
          role: child.role,
          name: child.name,
          ...childVisual,
        }
      : {
          role: child.role,
          name: child.name,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          visible: false,
          backgroundColor: '',
          color: '',
          fontSize: '',
          borderWidth: '',
          opacity: '0',
          display: '',
          overflow: '',
          textOverflow: false,
          textContent: child.name,
          childCount: child.children?.length ?? 0,
        }

    components.push({ id: compId, props })
  }

  return components
}

/** Build a composite component ID: regionKey/role["name"] or regionKey/role[index] */
function buildComponentId(
  regionKey: string,
  child: AXNode,
  nameCounts: Map<string, number>,
): string {
  if (child.name) {
    return `${regionKey}/${child.role}["${child.name}"]`
  }
  const key = `${regionKey}/${child.role}`
  const count = nameCounts.get(key) ?? 0
  nameCounts.set(key, count + 1)
  return `${key}[${count}]`
}

/** Fallback: extract visual props via CSS selector when CDP resolve is unavailable */
async function extractViaSelector(
  page: Page,
  selector: string,
): Promise<ResolvedNode | undefined> {
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

function buildRegionKey(role: string, name: string): string {
  if (name && name !== role) {
    return `${role}-${slugify(name)}`
  }
  return role
}

function inferTheme(bg: string): string {
  const match = bg.match(/\d+/g)
  if (!match) return 'unknown'
  const avg = match.slice(0, 3).reduce((sum, v) => sum + Number(v), 0) / 3
  return avg < 128 ? 'dark' : 'light'
}

function inferLayout(regions: Record<string, Region>): string {
  const parts: string[] = []
  const keys = Object.keys(regions)
  if (keys.some(k => k.startsWith('banner'))) parts.push('header')
  if (keys.some(k => k.startsWith('navigation'))) parts.push('sidebar')
  if (keys.some(k => k.startsWith('main'))) parts.push('main')
  if (keys.some(k => k.startsWith('complementary'))) parts.push('aside')
  if (keys.some(k => k.startsWith('contentinfo'))) parts.push('footer')
  return parts.join(' + ')
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30)
}
