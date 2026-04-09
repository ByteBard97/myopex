// src/cli.ts
import { runCapture } from './capture'
import { runVerify } from './verify'
import { runDiff } from './diff'
import { runScenarios, loadScenarioConfig } from './scenarios'
import { startServer } from './server'
import type { ChildProcess } from 'child_process'
import { resolve } from 'path'

const args = process.argv.slice(2)
const command = args[0]

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 ? args[idx + 1] : undefined
}

function printUsage() {
  console.log(`
ui-audit — Hierarchical YAML fingerprints for AI agent UI verification

Usage:
  ui-audit capture   [--url <url>] [--out <dir>] [--state <name>]
  ui-audit verify    [--url <url>] [--baseline <dir>] [--state <name>]
  ui-audit diff      --old <dir> --new <dir> [--state <name>]
  ui-audit scenarios [--url <url>] --config <file> [--out <dir>]

Commands:
  capture     Capture a single fingerprint from the running app
  verify      Compare current state against a saved baseline
  diff        Compare two saved fingerprints (no running app needed)
  scenarios   Run multiple named scenarios from a config file

Options:
  --url       App URL (auto-starts dev server if omitted)
  --out       Output directory (default: .ui-audit)
  --baseline  Baseline directory for verify (default: .ui-audit)
  --state     State name (default: "default")
  --config    Path to scenario config (.ts file exporting Scenario[])
  --old       Old fingerprint directory (diff command)
  --new       New fingerprint directory (diff command)

Scenario config example (ui-audit.scenarios.ts):

  import type { Page } from 'playwright'
  export default [
    { name: 'initial-load' },
    { name: 'modal-open', setup: async (page: Page) => {
        await page.click('.open-modal-btn')
        await page.waitForTimeout(500)
    }},
  ]
`)
}

async function main() {
  if (!command || command === '--help' || !['capture', 'verify', 'diff', 'scenarios'].includes(command)) {
    printUsage()
    process.exit(0)
  }

  let serverProc: ChildProcess | null = null

  try {
    if (command === 'capture') {
      let url = getFlag('url')
      if (!url) {
        const server = await startServer()
        url = server.url
        serverProc = server.process
      }
      const outDir = getFlag('out') ?? '.ui-audit'
      const stateName = getFlag('state') ?? 'default'
      console.log(`Capturing from ${url}...`)
      await runCapture(url, outDir, stateName)
      console.log('Done.')
    }

    if (command === 'verify') {
      let url = getFlag('url')
      if (!url) {
        const server = await startServer()
        url = server.url
        serverProc = server.process
      }
      const baselineDir = getFlag('baseline') ?? '.ui-audit'
      const stateName = getFlag('state') ?? 'default'
      console.log(`Verifying ${url} against baseline...`)
      const pass = await runVerify(url, baselineDir, stateName)
      if (serverProc) serverProc.kill()
      process.exit(pass ? 0 : 1)
    }

    if (command === 'diff') {
      const oldDir = getFlag('old')
      const newDir = getFlag('new')
      if (!oldDir || !newDir) {
        console.error('diff requires --old and --new directories')
        process.exit(1)
      }
      const stateName = getFlag('state') ?? 'default'
      await runDiff(oldDir, newDir, stateName)
    }

    if (command === 'scenarios') {
      const configPath = getFlag('config')
      if (!configPath) {
        console.error('scenarios requires --config <path-to-scenarios.ts>')
        process.exit(1)
      }

      let url = getFlag('url')
      if (!url) {
        const server = await startServer()
        url = server.url
        serverProc = server.process
      }

      const outDir = getFlag('out') ?? '.ui-audit-scenarios'
      const scenarios = await loadScenarioConfig(resolve(configPath))
      await runScenarios(url, scenarios, outDir)
    }
  } finally {
    if (serverProc) serverProc.kill()
  }
}

main().catch(err => {
  console.error('ui-audit failed:', err)
  process.exit(1)
})
