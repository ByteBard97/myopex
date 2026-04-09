import type { Page } from 'playwright'

export interface AXNode {
  role: string
  name: string
  value?: string
  description?: string
  children?: AXNode[]
  backendDOMNodeId?: number
  properties?: Record<string, string | boolean | number>
}

/**
 * Extract the full accessibility tree from a Playwright page via CDP.
 *
 * Uses Chrome DevTools Protocol Accessibility.getFullAXTree which returns
 * every node in the accessibility tree with roles, names, and properties.
 */
export async function extractAccessibilityTree(page: Page): Promise<AXNode> {
  const client = await page.context().newCDPSession(page)

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

    // Extract boolean/string properties (checked, disabled, expanded, etc.)
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
}

const LANDMARK_ROLES = new Set([
  'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'form', 'search',
])

/**
 * Extract ARIA landmark regions from the tree.
 * Returns a flat list of nodes with landmark roles.
 */
export function extractLandmarks(tree: AXNode): AXNode[] {
  const landmarks: AXNode[] = []
  function walk(node: AXNode) {
    if (LANDMARK_ROLES.has(node.role)) landmarks.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return landmarks
}
