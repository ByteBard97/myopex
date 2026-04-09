import type { Page } from 'playwright'
import { join } from 'path'
import { mkdirSync } from 'fs'

/**
 * Capture a cropped PNG screenshot of a single DOM element.
 * Returns the relative filename, or null if the element doesn't exist or is invisible.
 */
export async function captureComponentScreenshot(
  page: Page,
  selector: string,
  outDir: string,
  slug: string,
): Promise<string | null> {
  const locator = page.locator(selector).first()
  if (await page.locator(selector).count() === 0) return null
  if (!(await locator.isVisible())) return null

  mkdirSync(outDir, { recursive: true })
  const filename = `${slug}.png`
  const filepath = join(outDir, filename)

  try {
    await locator.screenshot({ path: filepath, type: 'png', animations: 'disabled' })
    return filename
  } catch {
    return null
  }
}

/** Capture a full-page screenshot for reference. */
export async function captureFullPage(page: Page, outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true })
  const filepath = join(outDir, 'full-page.png')
  await page.screenshot({ path: filepath, fullPage: true, type: 'png' })
  return 'full-page.png'
}
