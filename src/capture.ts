// src/capture.ts
import { chromium, type Page } from 'playwright'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { buildFingerprint, type BuildOptions } from './extract/merge'
import { captureFullPage } from './extract/screenshots'
import { serializeFingerprint } from './fingerprint/yaml'
import type { UIFingerprint } from './fingerprint/types'
import { DEFAULT_VIEWPORT, SETTLE_MS } from './constants'

/**
 * Capture a fingerprint from an already-open Playwright page.
 * Does NOT manage browser lifecycle — caller owns the page.
 * Used by the scenarios command to reuse one browser across states.
 */
export async function captureFromPage(
  page: Page,
  outDir: string,
  stateName: string,
  vueDepth?: number,
): Promise<UIFingerprint> {
  mkdirSync(outDir, { recursive: true })

  const fp = await buildFingerprint(page, { stateName, outDir, vueDepth } as BuildOptions)

  await writeScreenshots(page, fp, outDir)
  await captureFullPage(page, outDir)

  const filename = stateName === 'default' ? 'fingerprint.yaml' : `fingerprint-${stateName}.yaml`
  writeFileSync(join(outDir, filename), serializeFingerprint(fp))

  const regionCount = Object.keys(fp.regions).length
  const compCount = Object.values(fp.regions).reduce((n, r) => n + r.components.length, 0)
  console.log(`  [${stateName}] ${regionCount} regions, ${compCount} components`)

  // Loud on the silent-failure mode: regions captured but zero components.
  // Almost always means the app's interactive elements lack data-testid or
  // aria-label — component extraction reads the AX tree and skips unnamed
  // nodes. Caller (scenarios.ts) may also aggregate this into a summary.
  if (regionCount > 0 && compCount === 0) {
    console.warn(
      `  [${stateName}] warning: regions captured but 0 components — ` +
      `interactive elements likely lack data-testid or aria-label. ` +
      `Add them to key buttons/links/inputs and re-capture.`,
    )
  }

  return fp
}

/**
 * Capture a fingerprint by launching a browser, navigating, and closing.
 * Convenience wrapper for standalone CLI use.
 */
export async function runCapture(
  url: string,
  outDir: string,
  stateName: string,
  vueDepth?: number,
): Promise<UIFingerprint> {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT, colorScheme: 'dark' })

  await context.addInitScript(() => {
    const style = document.createElement('style')
    style.textContent = '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }'
    document.head.appendChild(style)
  })

  const page = await context.newPage()
  await page.goto(url)
  // Smart settle: prefer networkidle, fall back to the hard ceiling.
  // Most apps settle well under SETTLE_MS; we only block the full budget
  // on apps with streaming / long-polling that never go idle.
  try {
    await page.waitForLoadState('networkidle', { timeout: SETTLE_MS })
  } catch {
    // networkidle never fired — the waitForLoadState call itself already
    // consumed our settle budget, so we're ready to capture.
  }
  await page.waitForTimeout(200)

  const fp = await captureFromPage(page, outDir, stateName, vueDepth)

  await browser.close()
  console.log(`  Fingerprint: ${join(outDir, stateName === 'default' ? 'fingerprint.yaml' : `fingerprint-${stateName}.yaml`)}`)
  return fp
}

/** Capture region + component screenshots for a fingerprint. */
async function writeScreenshots(page: Page, fp: UIFingerprint, outDir: string): Promise<void> {
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
        ;(region as unknown as Record<string, unknown>)._screenshotFile = `screenshots/${filename}`
      } catch {
        // Region may be partially offscreen
      }
    }

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
}
