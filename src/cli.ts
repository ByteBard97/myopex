// src/cli.ts
import { runCapture } from './capture'
import { runVerify } from './verify'
import { runDiff } from './diff'
import { startServer } from './server'
import type { ChildProcess } from 'child_process'

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
  npx tsx src/cli.ts capture [--url <url>] [--out <dir>] [--state <name>]
  npx tsx src/cli.ts verify  [--url <url>] [--baseline <dir>] [--state <name>]
  npx tsx src/cli.ts diff    --old <dir> --new <dir> [--state <name>]

Options:
  --url       App URL (auto-starts dev server if omitted)
  --out       Output directory (default: .ui-audit)
  --baseline  Baseline directory (default: .ui-audit)
  --state     State name (default: "default", outputs fingerprint-{state}.yaml)
  --old       Old fingerprint directory (diff command)
  --new       New fingerprint directory (diff command)
`)
}

async function main() {
  if (!command || command === '--help' || !['capture', 'verify', 'diff'].includes(command)) {
    printUsage()
    process.exit(0)
  }

  const stateName = getFlag('state') ?? 'default'
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
      await runDiff(oldDir, newDir, stateName)
    }
  } finally {
    if (serverProc) serverProc.kill()
  }
}

main().catch(err => {
  console.error('ui-audit failed:', err)
  process.exit(1)
})
