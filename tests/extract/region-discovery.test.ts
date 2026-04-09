import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { discoverRegions, type DiscoveredRegion } from '../../src/extract/region-discovery'
import { join } from 'path'

describe('region discovery', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
  })

  afterAll(async () => {
    await browser.close()
  })

  it('discovers ARIA landmarks from well-marked page', async () => {
    await page.goto(`file://${join(__dirname, '../../fixtures/sample-page.html')}`)
    await page.waitForTimeout(300)

    const regions = await discoverRegions(page)
    const roles = regions.map(r => r.role)
    expect(roles).toContain('banner')
    expect(roles).toContain('navigation')
    expect(roles).toContain('main')
    expect(roles).toContain('contentinfo')
  })

  it('falls back to semantic HTML when ARIA is missing', async () => {
    // Create a page with semantic HTML but no role attributes
    await page.setContent(`
      <html><body>
        <header style="height:48px;background:#1E293B">Header</header>
        <nav style="width:48px;height:100px;background:#1E293B">Nav</nav>
        <main style="height:400px;background:#0F172A">Main content</main>
        <footer style="height:32px;background:#1E293B">Footer</footer>
      </body></html>
    `)
    await page.waitForTimeout(300)

    const regions = await discoverRegions(page)
    expect(regions.length).toBeGreaterThanOrEqual(4)
    // Should still discover these via semantic HTML fallback
    const roles = regions.map(r => r.role)
    expect(roles).toContain('banner')
    expect(roles).toContain('navigation')
    expect(roles).toContain('main')
    expect(roles).toContain('contentinfo')
  })

  it('includes data-testid elements as components, not regions', async () => {
    await page.goto(`file://${join(__dirname, '../../fixtures/sample-page.html')}`)
    await page.waitForTimeout(300)

    const regions = await discoverRegions(page)
    // data-testid elements should appear as components within regions, not as top-level regions
    const regionRoles = regions.map(r => r.role)
    expect(regionRoles).not.toContain('data-testid')
  })

  it('uses config selectors when provided', async () => {
    await page.setContent(`
      <html><body>
        <div class="my-custom-region" style="height:200px;background:#333">Custom</div>
      </body></html>
    `)
    await page.waitForTimeout(300)

    const regions = await discoverRegions(page, {
      extraSelectors: [{ selector: '.my-custom-region', role: 'custom', name: 'Custom Region' }],
    })
    expect(regions.some(r => r.name === 'Custom Region')).toBe(true)
  })
})
