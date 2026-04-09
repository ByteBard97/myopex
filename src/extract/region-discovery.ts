import type { Page } from 'playwright'
import { extractAccessibilityTree, extractLandmarks, type AXNode } from './accessibility'

export interface DiscoveredRegion {
  role: string
  name: string
  backendDOMNodeId?: number
  /** CSS selector for this region (used for screenshot capture and fallback property extraction) */
  selector: string
  source: 'aria-landmark' | 'semantic-html' | 'config-selector'
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
 * Discover UI regions via a 4-level fallback chain:
 *   1. ARIA landmarks (CDP accessibility tree)
 *   2. Semantic HTML sectioning elements (header, nav, main, aside, footer)
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
  const foundRoles = new Set<string>()
  let axTree: AXNode | null = null

  // --- Level 1: ARIA landmarks from accessibility tree ---
  try {
    axTree = await extractAccessibilityTree(page)
    const landmarks = extractLandmarks(axTree)

    for (const landmark of landmarks) {
      const key = landmark.role + (landmark.name ? `|${landmark.name}` : '')
      if (foundRoles.has(key)) continue
      foundRoles.add(key)
      // Also mark the bare role so Level 2 won't duplicate it
      foundRoles.add(landmark.role)

      regions.push({
        role: landmark.role,
        name: landmark.name || landmark.role,
        backendDOMNodeId: landmark.backendDOMNodeId,
        selector: buildSelectorForLandmark(landmark.role, landmark.name),
        source: 'aria-landmark',
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
    if (foundRoles.has(role)) continue
    const count = await page.locator(tag).count()
    if (count > 0) {
      foundRoles.add(role)
      regions.push({
        role,
        name: role,
        selector: tag,
        source: 'semantic-html',
      })
    }
  }

  // --- Level 3: Collect [data-testid] elements as components (not regions) ---
  const testIdElements: Array<{ selector: string; testId: string }> = []
  const testIdCount = await page.locator('[data-testid]').count()
  for (let i = 0; i < testIdCount; i++) {
    const testId = await page.locator('[data-testid]').nth(i).getAttribute('data-testid')
    if (testId) {
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
