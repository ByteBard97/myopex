import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { extractAccessibilityTree, extractLandmarks, type AXNode } from '../../src/extract/accessibility'
import { join } from 'path'

describe('accessibility tree extraction', () => {
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

  it('extracts the full accessibility tree', async () => {
    const tree = await extractAccessibilityTree(page)
    expect(tree).toBeDefined()
    expect(tree.role).toBe('RootWebArea')
  })

  it('finds ARIA landmark roles', async () => {
    const landmarks = extractLandmarks(await extractAccessibilityTree(page))
    const roles = landmarks.map(l => l.role)
    expect(roles).toContain('banner')
    expect(roles).toContain('navigation')
    expect(roles).toContain('main')
    expect(roles).toContain('contentinfo')
  })

  it('includes accessible names for buttons', async () => {
    const tree = await extractAccessibilityTree(page)
    const buttons = flattenByRole(tree, 'button')
    expect(buttons.length).toBeGreaterThanOrEqual(3)
    const names = buttons.map(b => b.name)
    expect(names).toContain('Home')
    expect(names).toContain('Settings')
  })

  it('AX nodes have backendDOMNodeId for CDP resolution', async () => {
    const tree = await extractAccessibilityTree(page)
    const landmarks = extractLandmarks(tree)
    for (const landmark of landmarks) {
      expect(landmark.backendDOMNodeId).toBeDefined()
      expect(typeof landmark.backendDOMNodeId).toBe('number')
    }
  })
})

function flattenByRole(node: AXNode, role: string, results: AXNode[] = []): AXNode[] {
  if (node.role === role) results.push(node)
  for (const child of node.children ?? []) flattenByRole(child, role, results)
  return results
}
