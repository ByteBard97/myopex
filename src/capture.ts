// src/capture.ts
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { buildFingerprint, type BuildOptions } from './extract/merge'
import { captureComponentScreenshot, captureFullPage } from './extract/screenshots'
import { serializeFingerprint } from './fingerprint/yaml'
import { DEFAULT_VIEWPORT, SETTLE_MS } from './constants'

export async function runCapture(url: string, outDir: string, stateName: string): Promise<void> {
  mkdirSync(outDir, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT, colorScheme: 'dark' })

  // Disable animations for deterministic screenshots
  await context.addInitScript(() => {
    const style = document.createElement('style')
    style.textContent = '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }'
    document.head.appendChild(style)
  })

  const page = await context.newPage()
  await page.goto(url)
  await page.waitForTimeout(SETTLE_MS)

  // Build fingerprint
  const options: BuildOptions = { stateName }
  const fp = await buildFingerprint(page, options)

  // Per-region screenshots using region selectors
  const screenshotDir = join(outDir, 'screenshots')
  for (const [regionKey, region] of Object.entries(fp.regions)) {
    for (const comp of region.components) {
      if (comp.props.visible && comp.props.bounds.width > 0) {
        const slug = comp.id.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').substring(0, 60)
        // Attempt screenshot via role+name selector within the region
        const selector = comp.props.name
          ? `[aria-label="${comp.props.name}"]`
          : `[role="${comp.props.role}"]`
        const file = await captureComponentScreenshot(page, selector, screenshotDir, slug)
        if (file) {
          comp.props.screenshotFile = `screenshots/${file}`
        }
      }
    }
  }

  // Full page screenshot
  await captureFullPage(page, outDir)

  // Serialize and write
  const filename = stateName === 'default' ? 'fingerprint.yaml' : `fingerprint-${stateName}.yaml`
  const yamlStr = serializeFingerprint(fp)
  writeFileSync(join(outDir, filename), yamlStr)

  await browser.close()

  console.log(`  ${Object.keys(fp.regions).length} regions, ${Object.values(fp.regions).reduce((n, r) => n + r.components.length, 0)} components`)
  console.log(`  Fingerprint: ${join(outDir, filename)}`)
}
