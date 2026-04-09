// src/scenarios.ts
import { chromium, type Page } from 'playwright'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { captureFromPage } from './capture'
import { DEFAULT_VIEWPORT, SETTLE_MS } from './constants'

/**
 * A scenario defines a named UI state and how to reach it.
 * The setup function receives a Playwright Page that has already
 * navigated to the app URL. It performs whatever actions are needed
 * to put the app into the target state (click buttons, open modals, etc.).
 */
export interface Scenario {
  /** Name of the state — used as folder name and fingerprint filename */
  name: string
  /** Optional description for the report */
  description?: string
  /** Actions to perform after page load to reach this state.
   *  Receives the Playwright Page. If omitted, captures the default load state. */
  setup?: (page: Page) => Promise<void>
}

/**
 * Run all scenarios against a URL. For each scenario:
 *   1. Navigate to the URL (fresh page load)
 *   2. Wait for settle
 *   3. Run the scenario's setup actions
 *   4. Capture a fingerprint + screenshots
 *   5. Save to outDir/{scenario.name}/
 *
 * Uses ONE browser across all scenarios for speed.
 * Each scenario gets a fresh page load (not accumulated state).
 */
export async function runScenarios(
  url: string,
  scenarios: Scenario[],
  outDir: string,
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

  console.log(`Running ${scenarios.length} scenario(s) against ${url}...\n`)

  for (const scenario of scenarios) {
    const scenarioDir = join(outDir, scenario.name)
    const page = await context.newPage()

    try {
      // Fresh navigation for each scenario
      await page.goto(url)
      await page.waitForTimeout(SETTLE_MS)

      // Run scenario-specific setup actions
      if (scenario.setup) {
        await scenario.setup(page)
        await page.waitForTimeout(500) // Brief settle after actions
      }

      // Capture fingerprint + screenshots
      await captureFromPage(page, scenarioDir, scenario.name)
    } catch (err) {
      console.error(`  [${scenario.name}] FAILED: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      await page.close()
    }
  }

  await browser.close()
  console.log(`\nDone. Output: ${outDir}/`)
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
