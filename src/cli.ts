// src/cli.ts
import { runCapture } from './capture'
import { runVerify } from './verify'
import { runDiff } from './diff'
import { runScenarios, loadScenarioConfig } from './scenarios'
import { runVueDetail } from './cli-vue-detail'
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
myopex — Structured UI snapshots for coding agents

Usage:
  myopex scenarios   [--url <url>] --config <file> [--out <dir>] [--vue-depth <n>]
  myopex capture     [--url <url>] [--out <dir>] [--state <name>] [--vue-depth <n>]
  myopex verify      [--url <url>] [--baseline <dir>] [--state <name>]
  myopex diff        --old <dir> --new <dir> [--state <name>]
  myopex vue-detail  <uid> --dir <capture-dir>
  # For scenarios: --dir .myopex-scenarios/<scenario-name>/

Commands:
  scenarios    Capture every UI state from a config in one browser boot (recommended)
  capture      Capture a single fingerprint from the running app
  verify       Compare current state against a saved baseline (exits 1 on regression)
  diff         Compare two saved fingerprints (no running app needed)
  vue-detail   Print full props + setup state for a Vue component by uid (reads vue-detail.json)

Options:
  --url        App URL (auto-starts dev server if omitted)
  --out        Output directory (default: .myopex)
  --baseline   Baseline directory for verify (default: .myopex)
  --state      State name (default: "default")
  --config     Path to scenario config (.ts file exporting Scenario[])
  --old        Old fingerprint directory (diff command)
  --new        New fingerprint directory (diff command)
  --vue-depth  Max Vue component tree depth (default: 3; minimum useful value is 1; 0 = root node only)
  --dir        Capture directory for vue-detail command

Scenario config example (myopex.scenarios.ts):

  export default [
    { name: 'home' },
    { name: 'settings', url: 'http://localhost:5173/?modal=settings' },
    { name: 'drawer-open', steps: [
        { click: '[data-testid=menu-button]' },
        { waitFor: '.drawer.open' },
    ]},
    { name: 'empty', steps: [
        { evaluate: 'localStorage.clear()' },
        { goto: 'http://localhost:5173' },
    ]},
  ]

See examples/myopex.scenarios.ts for a full reference with all step types.
`)
}

async function main() {
  if (!command || command === '--help' || !['capture', 'verify', 'diff', 'scenarios', 'vue-detail'].includes(command)) {
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
      const outDir = getFlag('out') ?? '.myopex'
      const stateName = getFlag('state') ?? 'default'
      const rawDepth = getFlag('vue-depth')
      const vueDepth = rawDepth !== undefined ? parseInt(rawDepth, 10) : undefined
      if (vueDepth !== undefined && (Number.isNaN(vueDepth) || vueDepth < 0)) {
        console.error(`Invalid --vue-depth: ${rawDepth} (must be a non-negative integer)`)
        process.exit(1)
      }
      console.log(`Capturing from ${url}...`)
      await runCapture(url, outDir, stateName, vueDepth)
      console.log('Done.')
    }

    if (command === 'verify') {
      let url = getFlag('url')
      if (!url) {
        const server = await startServer()
        url = server.url
        serverProc = server.process
      }
      const baselineDir = getFlag('baseline') ?? '.myopex'
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

      const outDir = getFlag('out') ?? '.myopex-scenarios'
      const rawDepth = getFlag('vue-depth')
      const vueDepth = rawDepth !== undefined ? parseInt(rawDepth, 10) : undefined
      if (vueDepth !== undefined && (Number.isNaN(vueDepth) || vueDepth < 0)) {
        console.error(`Invalid --vue-depth: ${rawDepth} (must be a non-negative integer)`)
        process.exit(1)
      }
      const scenarios = await loadScenarioConfig(resolve(configPath))
      await runScenarios(url, scenarios, outDir, vueDepth)
    }

    if (command === 'vue-detail') {
      const uidArg = args[1]
      const dir = getFlag('dir')
      if (!uidArg || !dir) {
        console.error('vue-detail requires a uid argument and --dir <capture-dir>')
        process.exit(1)
      }
      const uid = parseInt(uidArg, 10)
      if (isNaN(uid)) {
        console.error(`Invalid uid: ${uidArg} (must be an integer)`)
        process.exit(1)
      }
      runVueDetail(uid, dir)
    }
  } finally {
    if (serverProc) serverProc.kill()
  }
}

main().catch(err => {
  console.error('myopex failed:', err)
  process.exit(1)
})
