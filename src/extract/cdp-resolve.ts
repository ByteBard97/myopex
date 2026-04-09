import type { Page } from 'playwright'
import type { Bounds } from '../fingerprint/types'

const BATCH_SIZE = 30

export interface ResolvedNode {
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
 * Batch-resolve a list of backendDOMNodeIds to their computed visual properties
 * via CDP. Returns a Map keyed by backendDOMNodeId.
 *
 * Pipeline per node:
 *   1. DOM.resolveNode({ backendNodeId }) → RemoteObjectId
 *   2. Runtime.callFunctionOn(extractFn, objectId) → visual props
 *
 * Nodes that fail to resolve (e.g., detached or invisible) are silently skipped.
 */
export async function batchResolveVisualProps(
  page: Page,
  backendNodeIds: number[],
): Promise<Map<number, ResolvedNode>> {
  const client = await page.context().newCDPSession(page)
  const results = new Map<number, ResolvedNode>()

  // The function we'll call on each resolved DOM element
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
    // Process in batches to stay within CDP in-flight message limits
    for (let i = 0; i < backendNodeIds.length; i += BATCH_SIZE) {
      const batch = backendNodeIds.slice(i, i + BATCH_SIZE)

      // Step 1: Resolve all backendDOMNodeIds → RemoteObjectIds in parallel
      const resolvedObjects = await Promise.allSettled(
        batch.map(async nodeId => {
          const { object } = await client.send('DOM.resolveNode', { backendNodeId: nodeId })
          return { nodeId, objectId: object.objectId }
        }),
      )

      // Step 2: Extract visual props from all resolved objects in parallel
      const extractResults = await Promise.allSettled(
        resolvedObjects.map(async settled => {
          if (settled.status === 'rejected') return null
          const { nodeId, objectId } = settled.value
          if (!objectId) return null

          const { result } = await client.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: extractFnSource,
            returnByValue: true,
          })
          return { nodeId, objectId, value: result.value }
        }),
      )

      // Step 3: Collect results and fire-and-forget release
      for (const settled of extractResults) {
        if (settled.status === 'rejected' || settled.value === null) continue
        const { nodeId, objectId, value } = settled.value
        if (value) {
          const parsed = typeof value === 'string' ? JSON.parse(value) : value
          results.set(nodeId, parsed)
        }
        // Release remote object — fire and forget
        client.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
      }
    }
  } finally {
    await client.detach()
  }

  return results
}
