import type { Page } from 'playwright'
import { extractAccessibilityTree, extractLandmarks, extractDialogs, type AXNode } from './accessibility'
import { FRAMEWORK_SELECTORS } from '../constants'

export interface DiscoveredRegion {
  role: string
  name: string
  backendDOMNodeId?: number
  /** CSS selector for this region (used for screenshot capture and fallback property extraction) */
  selector: string
  source: 'aria-landmark' | 'aria-dialog' | 'semantic-html' | 'config-selector'
}

export interface DiscoveryConfig {
  extraSelectors?: Array<{ selector: string; role: string; name: string }>
}

export interface DiscoveryResult {
  regions: DiscoveredRegion[]
  axTree: AXNode | null
  testIdElements: Array<{ selector: string; testId: string }>
}

/**
 * Discover UI regions via a 5-level fallback chain:
 *   1. ARIA landmarks (CDP accessibility tree)
 *   2. Semantic HTML sectioning elements (header, nav, main, aside, footer)
 *   2.5. Framework-specific selectors (VueFlow, React Flow, etc.)
 *   3. [data-testid] elements — collected as components within regions, not as regions
 *   4. Config file selectors (optional, additive)
 *
 * Returns the discovered regions, the AX tree (for reuse by merge), and
 * any data-testid elements found (for component injection).
 */
export async function discoverRegions(
  page: Page,
  config?: DiscoveryConfig,
): Promise<DiscoveryResult> {
  const regions: DiscoveredRegion[] = []
  // Tracks unique landmark keys (role|name) to prevent exact duplicates
  const foundKeys = new Set<string>()
  // Tracks which bare roles have been found by Level 1 — used only by Level 2
  // to avoid duplicating landmarks already discovered via ARIA.
  // Intentionally does NOT block multiple landmarks with the same role but different names.
  const rolesFoundByLevel1 = new Set<string>()
  let axTree: AXNode | null = null

  // --- Level 1: ARIA landmarks from accessibility tree ---
  try {
    axTree = await extractAccessibilityTree(page)
    const landmarks = extractLandmarks(axTree)

    for (const landmark of landmarks) {
      const key = landmark.role + (landmark.name ? `|${landmark.name}` : '')
      if (foundKeys.has(key)) continue
      foundKeys.add(key)
      rolesFoundByLevel1.add(landmark.role)

      regions.push({
        role: landmark.role,
        name: landmark.name || landmark.role,
        backendDOMNodeId: landmark.backendDOMNodeId,
        selector: buildSelectorForLandmark(landmark.role, landmark.name),
        source: 'aria-landmark',
      })
    }

    // Level 1.5: Dialogs. Treated as top-level regions because they're often
    // teleported outside any landmark (Vue <Teleport to="body">, React
    // portals) and would otherwise vanish from the fingerprint.
    const dialogs = extractDialogs(axTree)
    for (const d of dialogs) {
      const key = d.role + (d.name ? `|${d.name}` : '')
      if (foundKeys.has(key)) continue
      foundKeys.add(key)

      regions.push({
        role: d.role,
        name: d.name || d.role,
        backendDOMNodeId: d.backendDOMNodeId,
        selector: d.name
          ? `[role="${d.role}"][aria-label="${d.name}"]`
          : `[role="${d.role}"]`,
        source: 'aria-dialog',
      })
    }
  } catch {
    // CDP may fail in some contexts — fall through to HTML fallback
  }

  // --- Level 2: Semantic HTML sectioning elements (fill gaps) ---
  const semanticMap: Record<string, string> = {
    'header': 'banner',
    'nav': 'navigation',
    'main': 'main',
    'aside': 'complementary',
    'footer': 'contentinfo',
  }

  for (const [tag, role] of Object.entries(semanticMap)) {
    if (rolesFoundByLevel1.has(role)) continue
    const count = await page.locator(tag).count()
    if (count > 0) {
      foundKeys.add(role)
      regions.push({
        role,
        name: role,
        selector: tag,
        source: 'semantic-html',
      })
    }
  }

  // --- Level 2.5: Framework-specific selectors (VueFlow, React Flow, etc.) ---
  for (const fw of FRAMEWORK_SELECTORS) {
    const count = await page.locator(fw.selector).count()
    if (count > 0 && !foundKeys.has(fw.role)) {
      foundKeys.add(fw.role)
      regions.push({
        role: fw.role,
        name: fw.name,
        selector: fw.selector,
        source: 'config-selector',
      })

      // For canvas regions, enumerate individual VueFlow nodes as sub-regions
      if (fw.role === 'main-canvas') {
        const nodeCount = await page.locator('.vue-flow__node').count()
        for (let i = 0; i < Math.min(nodeCount, 10); i++) {
          const nodeId = await page.locator('.vue-flow__node').nth(i).getAttribute('data-id')
          if (nodeId) {
            regions.push({
              role: 'canvas-node',
              name: nodeId,
              selector: `.vue-flow__node[data-id="${nodeId}"]`,
              source: 'config-selector',
            })
          }
        }
      }
    }
  }

  // --- Level 3: Collect [data-testid] elements as components (not regions) ---
  const testIdElements: Array<{ selector: string; testId: string }> = []
  const seenTestIds = new Set<string>()
  const testIdCount = await page.locator('[data-testid]').count()
  for (let i = 0; i < testIdCount; i++) {
    const testId = await page.locator('[data-testid]').nth(i).getAttribute('data-testid')
    if (testId && !seenTestIds.has(testId)) {
      seenTestIds.add(testId)
      testIdElements.push({ selector: `[data-testid="${testId}"]`, testId })
    }
  }

  // --- Level 4: Config file selectors (additive) ---
  if (config?.extraSelectors) {
    for (const extra of config.extraSelectors) {
      const count = await page.locator(extra.selector).count()
      if (count > 0) {
        regions.push({
          role: extra.role,
          name: extra.name,
          selector: extra.selector,
          source: 'config-selector',
        })
      }
    }
  }

  return { regions, axTree, testIdElements }
}

/**
 * Backward-compatible wrapper that returns just the regions array.
 * Used by tests that only care about region discovery.
 */
export async function discoverRegionsCompat(
  page: Page,
  config?: DiscoveryConfig,
): Promise<DiscoveredRegion[]> {
  const result = await discoverRegions(page, config)
  return result.regions
}

function buildSelectorForLandmark(role: string, name: string): string {
  if (name && name !== role) {
    return `[role="${role}"][aria-label="${name}"], ${roleToTag(role)}[aria-label="${name}"]`
  }
  return `[role="${role}"], ${roleToTag(role)}`
}

function roleToTag(role: string): string {
  const map: Record<string, string> = {
    banner: 'header',
    navigation: 'nav',
    main: 'main',
    complementary: 'aside',
    contentinfo: 'footer',
    search: '[role="search"]',
    form: 'form',
  }
  return map[role] ?? `[role="${role}"]`
}
