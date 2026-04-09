// src/capture.ts
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { buildFingerprint, type BuildOptions } from './extract/merge'
import { captureFullPage } from './extract/screenshots'
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

  // Per-component screenshots using bounds-based clipping (avoids selector ambiguity)
  const screenshotDir = join(outDir, 'screenshots')
  mkdirSync(screenshotDir, { recursive: true })
  for (const region of Object.values(fp.regions)) {
    for (const comp of region.components) {
      const b = comp.props.bounds
      if (comp.props.visible && b.width > 0 && b.height > 0) {
        const slug = comp.id.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').substring(0, 60)
        const filename = `${slug}.png`
        try {
          await page.screenshot({
            path: join(screenshotDir, filename),
            type: 'png',
            clip: { x: b.x, y: b.y, width: b.width, height: b.height },
          })
          comp.props.screenshotFile = `screenshots/${filename}`
        } catch {
          // Element may be offscreen or have invalid bounds
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
