// src/capture.ts
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { buildFingerprint, type BuildOptions } from './extract/merge'
import { captureFullPage } from './extract/screenshots'
import { serializeFingerprint } from './fingerprint/yaml'
import type { UIFingerprint } from './fingerprint/types'
import { DEFAULT_VIEWPORT, SETTLE_MS } from './constants'

export async function runCapture(url: string, outDir: string, stateName: string): Promise<UIFingerprint> {
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

  // Screenshots: capture each region + each component
  const screenshotDir = join(outDir, 'screenshots')
  mkdirSync(screenshotDir, { recursive: true })

  for (const [regionKey, region] of Object.entries(fp.regions)) {
    const rb = region.bounds
    if (rb.width > 0 && rb.height > 0) {
      const slug = regionKey.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').substring(0, 60)
      const filename = `region-${slug}.png`
      try {
        await page.screenshot({
          path: join(screenshotDir, filename),
          type: 'png',
          clip: { x: rb.x, y: rb.y, width: Math.min(rb.width, 1440), height: Math.min(rb.height, 900) },
        })
        ;(region as Record<string, unknown>)._screenshotFile = `screenshots/${filename}`
      } catch {
        // Region may be partially offscreen
      }
    }

    // Component-level screenshots
    for (const comp of region.components) {
      const b = comp.props.bounds
      if (comp.props.visible && b.width > 0 && b.height > 0) {
        const compSlug = comp.id.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').substring(0, 60)
        const compFilename = `${compSlug}.png`
        try {
          await page.screenshot({
            path: join(screenshotDir, compFilename),
            type: 'png',
            clip: { x: b.x, y: b.y, width: b.width, height: b.height },
          })
          comp.props.screenshotFile = `screenshots/${compFilename}`
        } catch {
          // Element may be offscreen
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

  return fp
}
