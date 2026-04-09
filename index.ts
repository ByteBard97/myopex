#!/usr/bin/env npx tsx
/**
 * ui-audit — DOM property extraction + component screenshot tool for AI agent verification.
 *
 * Captures per-component: bounding box, computed styles, visibility, overflow, text content,
 * and a cropped PNG screenshot. Diffs against a baseline JSON to produce a structured report.
 *
 * Usage:
 *   npx tsx tools/ui-audit/index.ts capture --url http://localhost:5173 --out .ui-audit
 *   npx tsx tools/ui-audit/index.ts verify  --url http://localhost:5173 --baseline .ui-audit
 *
 * Exit codes: 0 = pass (or capture mode), 1 = failures found
 *
 * The report JSON + per-component PNGs are designed for AI agent consumption:
 * - Agent reads report.json (structured property data, not visual)
 * - Agent looks at individual PNGs only for flagged components (focused, not full-page)
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawn, type ChildProcess } from 'child_process'

// --- Types ---

interface ComponentAudit {
  selector: string
  visible: boolean
  width: number
  height: number
  x: number
  y: number
  backgroundColor: string
  color: string
  opacity: string
  borderWidth: string
  fontSize: string
  display: string
  overflow: string
  textOverflow: boolean
  textContent: string
  childCount: number
  screenshotFile: string | null
}

interface Baseline {
  url: string
  viewport: { width: number; height: number }
  capturedAt: string
  components: Record<string, ComponentAudit>
}

interface DiffFailure {
  component: string
  property: string
  expected: string | number | boolean
  actual: string | number | boolean
  screenshotFile: string | null
}

interface VerifyReport {
  pass: boolean
  url: string
  verifiedAt: string
  passed: number
  failed: number
  missing: string[]
  added: string[]
  failures: DiffFailure[]
  components: Record<string, ComponentAudit>
}

// --- Configuration ---

const VIEWPORT = { width: 1440, height: 900 }
const SETTLE_MS = 4000

/**
 * CSS selectors to audit. Uses both V2 and V3 class names so the same
 * tool can capture baselines from either version.
 */
const AUDIT_SELECTORS = [
  // Shell structure (V3 class, V2 fallback)
  '.shell-layout',
  '.shell-header, .header-bar',
  '.icon-ribbon, .shell-ribbon, .sidebar-ribbon',
  '.shell-status, .status-bar',
  // Canvas (shared VueFlow classes)
  '.vue-flow',
  '.vue-flow__controls',
  // Page tabs
  '.page-tab-bar, .page-tabs',
  // Device nodes — target the inner styled component, not the VueFlow wrapper
  // (VueFlow wrapper is intentionally transparent)
  '.vue-flow__node:nth-child(1) .device-node, .vue-flow__node:nth-child(1) .cdn-node',
  '.vue-flow__node:nth-child(2) .device-node, .vue-flow__node:nth-child(2) .cdn-node',
  '.vue-flow__node:nth-child(3) .device-node, .vue-flow__node:nth-child(3) .cdn-node',
  '.vue-flow__node:nth-child(4) .device-node, .vue-flow__node:nth-child(4) .cdn-node',
  // Device node header (first node)
  '.vue-flow__node:first-child .device-header, .vue-flow__node:first-child .cdn-header',
  // Edges (sample)
  '.vue-flow__edge:nth-child(1) .vue-flow__edge-path',
  '.vue-flow__edge:nth-child(2) .vue-flow__edge-path',
  // Toggle bar / toolbar
  '.toggle-bar, [class*="toggle-bar"], .canvas-toolbar',
  // Search bar (if visible)
  '.sc-search-bar, .canvas-search',
  // Any element with data-testid (future-proof)
  '[data-testid]',
]

/** Properties to compare during verify. Tolerance applied to numeric values. */
const COMPARE_PROPERTIES: (keyof ComponentAudit)[] = [
  'visible', 'backgroundColor', 'display', 'textOverflow',
]

/** Numeric properties where we allow a tolerance range. */
const NUMERIC_TOLERANCE: Partial<Record<keyof ComponentAudit, number>> = {
  width: 50,
  height: 30,
  x: 100,
  y: 100,
}

/** Properties that trigger a failure if they indicate a broken state. */
const INVARIANT_CHECKS: Array<{
  property: keyof ComponentAudit
  check: (value: unknown, comp?: ComponentAudit) => boolean
  message: string
}> = [
  { property: 'visible', check: v => v === false, message: 'element is not visible' },
  { property: 'backgroundColor', check: (v, comp) => v === 'rgba(0, 0, 0, 0)' && !comp?.selector.includes('edge-path') && !comp?.selector.includes('svg'), message: 'background is transparent (theme not applied?)' },
  { property: 'textOverflow', check: v => v === true, message: 'text is overflowing/truncated' },
  { property: 'width', check: v => (v as number) === 0, message: 'element has zero width' },
  { property: 'height', check: v => (v as number) === 0, message: 'element has zero height' },
]

// --- Core functions ---

function slugify(selector: string): string {
  return selector
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60)
}

async function auditPage(url: string, outDir: string): Promise<Baseline> {
  const screenshotDir = join(outDir, 'screenshots')
  mkdirSync(screenshotDir, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' })

  // Disable animations for deterministic screenshots
  await context.addInitScript(() => {
    const style = document.createElement('style')
    style.textContent = '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }'
    document.head.appendChild(style)
  })

  const page = await context.newPage()
  await page.goto(url)
  await page.waitForTimeout(SETTLE_MS)

  const components: Record<string, ComponentAudit> = {}

  for (const selector of AUDIT_SELECTORS) {
    const locator = page.locator(selector).first()
    const count = await page.locator(selector).count()
    if (count === 0) continue

    const slug = slugify(selector)
    const visible = await locator.isVisible()

    const props = await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const cs = window.getComputedStyle(el)
      const h = el as HTMLElement
      return {
        visible: rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        backgroundColor: cs.backgroundColor,
        color: cs.color,
        opacity: cs.opacity,
        borderWidth: cs.borderWidth,
        fontSize: cs.fontSize,
        display: cs.display,
        overflow: cs.overflow,
        textOverflow: h.scrollWidth > h.clientWidth,
        textContent: (h.textContent ?? '').trim().substring(0, 200),
        childCount: h.children.length,
      }
    })

    let screenshotFile: string | null = null
    if (visible && props.width > 0 && props.height > 0) {
      try {
        const filename = `${slug}.png`
        const filepath = join(screenshotDir, filename)
        await locator.screenshot({ path: filepath, type: 'png', animations: 'disabled' })
        screenshotFile = `screenshots/${filename}`
      } catch {
        // Some elements can't be screenshotted (e.g., SVG paths)
      }
    }

    components[slug] = { selector, ...props, screenshotFile }
  }

  // Also capture full page for reference
  await page.screenshot({ path: join(outDir, 'full-page.png'), fullPage: true, type: 'png' })

  await browser.close()

  return {
    url,
    viewport: VIEWPORT,
    capturedAt: new Date().toISOString(),
    components,
  }
}

function compareBaselines(baseline: Baseline, current: Baseline): VerifyReport {
  const failures: DiffFailure[] = []
  const baseKeys = Object.keys(baseline.components)
  const currKeys = Object.keys(current.components)
  const missing = baseKeys.filter(k => !currKeys.includes(k))
  const added = currKeys.filter(k => !baseKeys.includes(k))

  // Check invariants on ALL current components (regardless of baseline)
  for (const [key, comp] of Object.entries(current.components)) {
    for (const check of INVARIANT_CHECKS) {
      const value = comp[check.property]
      if (check.check(value, comp)) {
        failures.push({
          component: key,
          property: check.property,
          expected: `not ${String(value)}`,
          actual: value as string | number | boolean,
          screenshotFile: comp.screenshotFile,
        })
      }
    }
  }

  // Diff properties against baseline
  for (const key of baseKeys) {
    if (!current.components[key]) continue
    const base = baseline.components[key]
    const curr = current.components[key]

    for (const prop of COMPARE_PROPERTIES) {
      const bVal = base[prop]
      const cVal = curr[prop]
      if (bVal !== cVal) {
        failures.push({
          component: key,
          property: prop,
          expected: bVal as string | number | boolean,
          actual: cVal as string | number | boolean,
          screenshotFile: curr.screenshotFile,
        })
      }
    }

    // Numeric comparisons with tolerance
    for (const [prop, tolerance] of Object.entries(NUMERIC_TOLERANCE)) {
      const bVal = base[prop as keyof ComponentAudit] as number
      const cVal = curr[prop as keyof ComponentAudit] as number
      if (typeof bVal === 'number' && typeof cVal === 'number') {
        if (Math.abs(bVal - cVal) > tolerance) {
          failures.push({
            component: key,
            property: prop,
            expected: bVal,
            actual: cVal,
            screenshotFile: curr.screenshotFile,
          })
        }
      }
    }
  }

  // Missing baseline components are failures
  for (const key of missing) {
    failures.push({
      component: key,
      property: 'exists',
      expected: true,
      actual: false,
      screenshotFile: null,
    })
  }

  const totalChecked = Object.keys(current.components).length * (COMPARE_PROPERTIES.length + INVARIANT_CHECKS.length)
  return {
    pass: failures.length === 0,
    url: current.url,
    verifiedAt: new Date().toISOString(),
    passed: totalChecked - failures.length,
    failed: failures.length,
    missing,
    added,
    failures,
    components: current.components,
  }
}

// --- Server management ---

const AUTO_SERVER_PORT = 5198

async function isServerRunning(url: string): Promise<boolean> {
  try {
    const res = await fetch(url)
    return res.ok
  } catch {
    return false
  }
}

async function startServer(): Promise<{ url: string; process: ChildProcess }> {
  const url = `http://localhost:${AUTO_SERVER_PORT}`
  if (await isServerRunning(url)) return { url, process: null as unknown as ChildProcess }

  console.log(`  Starting dev server on port ${AUTO_SERVER_PORT}...`)
  const proc = spawn('npx', ['vite', '--port', String(AUTO_SERVER_PORT)], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '../..'),
    stdio: 'pipe',
  })

  // Wait for server to be ready
  const start = Date.now()
  while (Date.now() - start < 15000) {
    if (await isServerRunning(url)) return { url, process: proc }
    await new Promise(r => setTimeout(r, 500))
  }
  proc.kill()
  throw new Error(`Dev server failed to start on port ${AUTO_SERVER_PORT}`)
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const urlArg = args.find((_, i) => args[i - 1] === '--url')
  const outDir = args.find((_, i) => args[i - 1] === '--out' || args[i - 1] === '--baseline') ?? '.ui-audit'

  // If no --url provided, auto-start a dev server
  let url = urlArg ?? ''
  let serverProc: ChildProcess | null = null

  if (!url) {
    const server = await startServer()
    url = server.url
    serverProc = server.process
  }

  if (!command || !['capture', 'verify'].includes(command)) {
    console.log(`
ui-audit — DOM property extraction + component screenshot tool

Usage:
  npx tsx tools/ui-audit/index.ts capture --url <url> --out <dir>
  npx tsx tools/ui-audit/index.ts verify  --url <url> --baseline <dir>

Commands:
  capture   Take a baseline snapshot (properties + screenshots)
  verify    Compare current state against baseline, output report

Options:
  --url       App URL (default: http://localhost:5173)
  --out       Output directory for capture (default: .ui-audit)
  --baseline  Baseline directory for verify (default: .ui-audit)
`)
    process.exit(0)
  }

  if (command === 'capture') {
    console.log(`Capturing baseline from ${url}...`)
    const baseline = await auditPage(url, outDir)
    const baselinePath = join(outDir, 'baseline.json')
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2))
    console.log(`  ${Object.keys(baseline.components).length} components captured`)
    console.log(`  Baseline: ${baselinePath}`)
    console.log(`  Screenshots: ${join(outDir, 'screenshots/')}`)
    console.log('Done.')
  }

  if (command === 'verify') {
    const baselinePath = join(outDir, 'baseline.json')
    if (!existsSync(baselinePath)) {
      console.error(`No baseline found at ${baselinePath}. Run 'capture' first.`)
      process.exit(1)
    }

    const baseline: Baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'))
    console.log(`Verifying ${url} against baseline...`)

    const currentDir = join(outDir, 'current')
    const current = await auditPage(url, currentDir)
    const report = compareBaselines(baseline, current)

    const reportPath = join(outDir, 'report.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2))

    if (report.pass) {
      console.log(`  PASS — ${report.passed} checks passed, 0 failures`)
    } else {
      console.log(`  FAIL — ${report.failed} failure(s):`)
      for (const f of report.failures) {
        console.log(`    ✗ ${f.component}.${f.property}: expected ${f.expected}, got ${f.actual}`)
        if (f.screenshotFile) {
          console.log(`      screenshot: ${join(currentDir, f.screenshotFile)}`)
        }
      }
      if (report.missing.length > 0) {
        console.log(`  Missing components: ${report.missing.join(', ')}`)
      }
      if (report.added.length > 0) {
        console.log(`  New components (not in baseline): ${report.added.join(', ')}`)
      }
    }

    console.log(`  Report: ${reportPath}`)
    if (serverProc) serverProc.kill()
    process.exit(report.pass ? 0 : 1)
  }

  if (serverProc) serverProc.kill()
}

main().catch(err => {
  console.error('ui-audit failed:', err)
  process.exit(1)
})
