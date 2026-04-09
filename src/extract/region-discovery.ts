import type { Page } from 'playwright'
import { extractAccessibilityTree, extractLandmarks } from './accessibility'

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

/**
 * Discover UI regions via a 3-level fallback chain:
 *   1. ARIA landmarks (CDP accessibility tree)
 *   2. Semantic HTML sectioning elements (header, nav, main, aside, footer)
 *   3. Config file selectors (optional, additive)
 *
 * data-testid elements are collected separately as components, not regions.
 */
export async function discoverRegions(
  page: Page,
  config?: DiscoveryConfig,
): Promise<DiscoveredRegion[]> {
  const regions: DiscoveredRegion[] = []
  const foundRoles = new Set<string>()

  // --- Level 1: ARIA landmarks from accessibility tree ---
  try {
    const tree = await extractAccessibilityTree(page)
    const landmarks = extractLandmarks(tree)

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

  // --- Level 3: Config file selectors (additive) ---
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

  return regions
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
