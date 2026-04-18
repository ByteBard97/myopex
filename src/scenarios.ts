// src/scenarios.ts
import { chromium, type Page } from 'playwright'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { captureFromPage } from './capture'
import { DEFAULT_VIEWPORT, SETTLE_MS } from './constants'

/**
 * A declarative step that runs as part of a scenario setup.
 *
 * Designed so non-webdevs (and coding agents writing configs) can describe
 * UI states without having to learn the Playwright API. For anything the
 * DSL can't express, use the `setup` function instead — both can be mixed
 * in a single scenario and steps run before setup.
 */
export type Step =
  | { click: string }
  | { fill: string; value: string }
  | { press: string; key: string }
  | { hover: string }
  | { select: string; value: string }
  | { waitFor: string }
  | { wait: number }
  | { goto: string }
  | { evaluate: string }
  | { setLocalStorage: Record<string, string> }

/**
 * A scenario defines a named UI state and how to reach it.
 *
 * Three ways to describe a state, from simplest to most flexible:
 *
 *   1. `url` — URL-based state (zero code, e.g. `?modal=settings`)
 *   2. `steps` — declarative action list (no Playwright knowledge needed)
 *   3. `setup` — raw Playwright function (for anything the DSL can't do)
 *
 * You can mix all three in a single scenario. Order of execution:
 *   - navigate to scenario.url (or the CLI --url if not set)
 *   - smart-settle wait (network idle + animation skip)
 *   - run `steps` in order
 *   - run `setup` function
 *   - brief settle
 *   - capture fingerprint
 */
export interface Scenario {
  /** Name of the state — used as folder name and fingerprint filename. */
  name: string
  /** Optional description for the report. */
  description?: string
  /** URL override for this scenario. Falls back to the CLI --url if omitted. */
  url?: string
  /** Declarative steps to reach the state — no Playwright knowledge required. */
  steps?: Step[]
  /**
   * Raw Playwright setup function. Receives the Page after navigation + steps.
   * Use this when declarative steps aren't expressive enough (e.g. route mocking,
   * evaluating complex expressions, conditional flows).
   */
  setup?: (page: Page) => Promise<void>
  /** Override the settle timeout for this scenario (default: SETTLE_MS). */
  settleMs?: number
}

/**
 * Smart wait for the page to be ready for capture.
 *
 * Prefers `networkidle` over a fixed timeout — most apps settle in well under
 * the hard ceiling. Falls back to a short fixed wait if networkidle never
 * fires (SSE streams, long-polling, chatty analytics).
 */
async function smartSettle(page: Page, settleMs: number): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: settleMs })
  } catch {
    // Network never idled (streaming, long-polling, etc). The wait itself
    // already gave us `settleMs` of budget — that's enough.
  }
  // Short guaranteed tail for late-mounting UI (JS frameworks that render
  // after their first idle window).
  await page.waitForTimeout(200)
}

/**
 * Execute a single declarative step against a Playwright page.
 */
async function runStep(page: Page, step: Step): Promise<void> {
  if ('click' in step) return void (await page.click(step.click))
  if ('fill' in step) return void (await page.fill(step.fill, step.value))
  if ('press' in step) return void (await page.press(step.press, step.key))
  if ('hover' in step) return void (await page.hover(step.hover))
  if ('select' in step) return void (await page.selectOption(step.select, step.value))
  if ('waitFor' in step) return void (await page.waitForSelector(step.waitFor))
  if ('wait' in step) return void (await page.waitForTimeout(step.wait))
  if ('goto' in step) return void (await page.goto(step.goto))
  if ('evaluate' in step) {
    const code = step.evaluate
    await page.evaluate((js) => {
      // eslint-disable-next-line no-new-func
      return new Function(js)()
    }, code)
    return
  }
  if ('setLocalStorage' in step) {
    const entries = step.setLocalStorage
    await page.evaluate((kv) => {
      for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v)
    }, entries)
    return
  }
  throw new Error(`Unknown step: ${JSON.stringify(step)}`)
}

/**
 * Run all scenarios against a URL. For each scenario:
 *   1. Navigate to scenario.url (or fallback baseUrl)
 *   2. Smart-settle (network idle with fallback)
 *   3. Run scenario.steps (declarative) and scenario.setup (raw)
 *   4. Capture a fingerprint + screenshots
 *   5. Save to outDir/{scenario.name}/
 *
 * Uses ONE browser across all scenarios for speed — this is the whole point.
 * Each scenario gets a fresh page (no accumulated state leakage).
 */
export async function runScenarios(
  baseUrl: string,
  scenarios: Scenario[],
  outDir: string,
  vueDepth?: number,
): Promise<void> {
  mkdirSync(outDir, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT, colorScheme: 'dark' })

  // Disable animations for deterministic screenshots
  await context.addInitScript(() => {
    const style = document.createElement('style')
    style.textContent = '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }'
    document.head.appendChild(style)
  })

  console.log(`Running ${scenarios.length} scenario(s) against ${baseUrl}...\n`)

  type Outcome = { name: string; status: 'ok' | 'zero-components' | 'failed' }
  const outcomes: Outcome[] = []

  for (const scenario of scenarios) {
    const scenarioDir = join(outDir, scenario.name)
    const page = await context.newPage()
    const settleMs = scenario.settleMs ?? SETTLE_MS

    // Action timeout: short enough to catch typos in testid/selectors quickly
    // without waiting out Playwright's 30s default. settleMs handles genuine
    // slow-render cases separately; per-scenario waits can still use
    // { wait: N } for explicit long pauses.
    page.setDefaultTimeout(5000)

    try {
      // Fresh navigation for each scenario
      const targetUrl = scenario.url ?? baseUrl
      await page.goto(targetUrl)
      await smartSettle(page, settleMs)

      // Declarative steps first (most vibe-coder-friendly path)
      if (scenario.steps) {
        for (const step of scenario.steps) {
          await runStep(page, step)
        }
      }

      // Raw setup function second (for anything the DSL can't express)
      if (scenario.setup) {
        await scenario.setup(page)
      }

      // Brief settle after actions (animations, late renders)
      if (scenario.steps || scenario.setup) {
        await page.waitForTimeout(300)
      }

      // Capture fingerprint + screenshots
      const fp = await captureFromPage(page, scenarioDir, scenario.name, vueDepth)
      const compCount = Object.values(fp.regions).reduce((n, r) => n + r.components.length, 0)
      outcomes.push({ name: scenario.name, status: compCount === 0 ? 'zero-components' : 'ok' })
    } catch (err) {
      console.error(`  [${scenario.name}] FAILED: ${err instanceof Error ? err.message : String(err)}`)
      outcomes.push({ name: scenario.name, status: 'failed' })
    } finally {
      await page.close()
    }
  }

  await browser.close()
  console.log(`\nDone. Output: ${outDir}/`)

  // Aggregate warnings. Keeps silent-failure modes from being mistaken for
  // success — the overall command exits 0 either way, but the caller sees a
  // loud block on stderr that summarizes what to investigate.
  const failed = outcomes.filter(o => o.status === 'failed')
  const zero = outcomes.filter(o => o.status === 'zero-components')
  if (failed.length === 0 && zero.length === 0) return

  console.warn(`\nCapture warnings:`)
  if (failed.length > 0) {
    console.warn(`  ${failed.length} scenario(s) failed: ${failed.map(f => f.name).join(', ')}`)
    console.warn(`  Review the FAILED lines above for the specific error per scenario.`)
  }
  if (zero.length > 0) {
    console.warn(`  ${zero.length} scenario(s) captured 0 components: ${zero.map(z => z.name).join(', ')}`)
    console.warn(`  Likely cause: interactive elements lack data-testid or aria-label,`)
    console.warn(`  so the accessibility tree has no named children for component extraction.`)
    console.warn(`  Fix: add data-testid to key buttons/links/inputs, then re-run scenarios.`)
  }
}

/**
 * Load scenarios from a TypeScript config file.
 * The config file should default-export a Scenario[].
 */
export async function loadScenarioConfig(configPath: string): Promise<Scenario[]> {
  const mod = await import(configPath)
  const scenarios = mod.default ?? mod.scenarios
  if (!Array.isArray(scenarios)) {
    throw new Error(`Scenario config at ${configPath} must export a Scenario[] as default or named 'scenarios'`)
  }
  return scenarios
}
