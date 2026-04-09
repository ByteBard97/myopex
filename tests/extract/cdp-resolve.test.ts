import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { extractAccessibilityTree, extractLandmarks } from '../../src/extract/accessibility'
import { batchResolveVisualProps, type ResolvedNode } from '../../src/extract/cdp-resolve'
import { join } from 'path'

describe('CDP batch resolve', () => {
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

  it('resolves landmark nodes to visual properties', async () => {
    const tree = await extractAccessibilityTree(page)
    const landmarks = extractLandmarks(tree)
    const nodeIds = landmarks
      .map(l => l.backendDOMNodeId)
      .filter((id): id is number => id !== undefined)

    const resolved = await batchResolveVisualProps(page, nodeIds)
    expect(resolved.size).toBeGreaterThan(0)

    // The banner (header) should have real dimensions
    const bannerId = landmarks.find(l => l.role === 'banner')!.backendDOMNodeId!
    const bannerProps = resolved.get(bannerId)
    expect(bannerProps).toBeDefined()
    // 48px height + 1px border-bottom = 49px from getBoundingClientRect
    expect(bannerProps!.bounds.height).toBe(49)
    expect(bannerProps!.visible).toBe(true)
    expect(bannerProps!.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  })

  it('returns backgroundColor and color as strings', async () => {
    const tree = await extractAccessibilityTree(page)
    const landmarks = extractLandmarks(tree)
    const nodeIds = landmarks.map(l => l.backendDOMNodeId).filter((id): id is number => id !== undefined)
    const resolved = await batchResolveVisualProps(page, nodeIds)

    for (const [_id, props] of resolved) {
      expect(typeof props.backgroundColor).toBe('string')
      expect(typeof props.color).toBe('string')
    }
  })

  it('handles nodes that fail to resolve gracefully', async () => {
    // Pass a bogus node ID — should not throw, just skip it
    const resolved = await batchResolveVisualProps(page, [999999])
    expect(resolved.size).toBe(0)
  })

  it('resolves 10+ nodes in under 3 seconds', async () => {
    const tree = await extractAccessibilityTree(page)
    const allIds = collectNodeIds(tree)
    expect(allIds.length).toBeGreaterThan(10)

    const start = Date.now()
    const results = await batchResolveVisualProps(page, allIds)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(3000)
    expect(results.size).toBeGreaterThan(0)
  }, 10000)

  function collectNodeIds(node: any, ids: number[] = []): number[] {
    if (node.backendDOMNodeId) ids.push(node.backendDOMNodeId)
    for (const child of node.children ?? []) collectNodeIds(child, ids)
    return ids
  }
})
