import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { buildFingerprint } from '../../src/extract/merge'
import { join } from 'path'

describe('merge: build UIFingerprint', () => {
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

  it('produces a v2 fingerprint with page metadata', async () => {
    const fp = await buildFingerprint(page)
    expect(fp.version).toBe(2)
    expect(fp.page.url).toContain('sample-page.html')
    expect(fp.page.viewport).toEqual({ width: 1440, height: 900 })
  })

  it('discovers ARIA landmark regions', async () => {
    const fp = await buildFingerprint(page)
    const regionRoles = Object.values(fp.regions).map(r => r.role)
    expect(regionRoles).toContain('banner')
    expect(regionRoles).toContain('navigation')
    expect(regionRoles).toContain('main')
    expect(regionRoles).toContain('contentinfo')
  })

  it('regions have real visual properties from CDP resolve', async () => {
    const fp = await buildFingerprint(page)
    const header = Object.values(fp.regions).find(r => r.role === 'banner')!
    // Note: header height is 49px (48px height + 1px border-bottom in fixture CSS)
    expect(header.bounds.height).toBeGreaterThanOrEqual(48)
    expect(header.background).not.toBe('')
    expect(header.background).not.toBe('rgba(0, 0, 0, 0)')
  })

  it('regions contain child components with visual properties', async () => {
    const fp = await buildFingerprint(page)
    const nav = Object.values(fp.regions).find(r => r.role === 'navigation')!
    expect(nav.components.length).toBeGreaterThanOrEqual(3)

    // Children should have their OWN bounds, not the parent's
    for (const comp of nav.components) {
      expect(comp.props.bounds.width).toBeGreaterThan(0)
      expect(comp.props.bounds.height).toBeGreaterThan(0)
    }
  })

  it('component IDs use composite key format', async () => {
    const fp = await buildFingerprint(page)
    const nav = Object.values(fp.regions).find(r => r.role === 'navigation')!
    for (const comp of nav.components) {
      // Should be regionKey/role["name"] or regionKey/role[index]
      expect(comp.id).toContain('/')
    }
  })

  it('state defaults to "default"', async () => {
    const fp = await buildFingerprint(page)
    expect(fp.state.name).toBe('default')
  })

  it('handles two nav elements with different aria-labels as separate regions', async () => {
    const fp = await buildFingerprint(page)
    const navRegions = Object.values(fp.regions).filter(r => r.role === 'navigation')
    expect(navRegions.length).toBeGreaterThanOrEqual(2)
    // Each should have its own components, not shared
    for (const nav of navRegions) {
      expect(nav.childCount).toBeGreaterThan(0)
    }
  })

  it('discovers VueFlow canvas as a region', async () => {
    const fp = await buildFingerprint(page)
    const canvasRegion = Object.values(fp.regions).find(r => r.role === 'main-canvas')
    expect(canvasRegion).toBeDefined()
    expect(canvasRegion!.bounds.width).toBeGreaterThan(0)
  })
})
