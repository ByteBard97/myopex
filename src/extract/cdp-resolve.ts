import type { Page } from 'playwright'
import type { Bounds } from '../fingerprint/types'

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

  for (const nodeId of backendNodeIds) {
    try {
      // Step 1: Resolve backendDOMNodeId → RemoteObjectId
      const { object } = await client.send('DOM.resolveNode', {
        backendNodeId: nodeId,
      })
      if (!object.objectId) continue

      // Step 2: Call extraction function on the resolved object
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

      // Release the remote object
      await client.send('Runtime.releaseObject', { objectId: object.objectId })
    } catch {
      // Node may be detached, in a shadow DOM, or otherwise unresolvable — skip
      continue
    }
  }

  await client.detach()
  return results
}
