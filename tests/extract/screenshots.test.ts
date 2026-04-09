import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { captureComponentScreenshot } from '../../src/extract/screenshots'
import { join } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'

const OUT_DIR = join(__dirname, '../../.test-screenshots')

describe('screenshot capture', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true })
    mkdirSync(OUT_DIR, { recursive: true })
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await page.goto(`file://${join(__dirname, '../../fixtures/sample-page.html')}`)
    await page.waitForTimeout(500)
  })

  afterAll(async () => {
    await browser.close()
    if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true })
  })

  it('captures a PNG of a visible element', async () => {
    const file = await captureComponentScreenshot(page, 'header', OUT_DIR, 'header')
    expect(file).not.toBeNull()
    expect(existsSync(join(OUT_DIR, file!))).toBe(true)
  })

  it('returns null for nonexistent element', async () => {
    const file = await captureComponentScreenshot(page, '.nope', OUT_DIR, 'nope')
    expect(file).toBeNull()
  })
})
