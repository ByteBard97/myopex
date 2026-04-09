// src/cli.ts
const args = process.argv.slice(2)
const command = args[0]

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 ? args[idx + 1] : undefined
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`)
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
  console.log(`${command} not yet implemented`)
}

main().catch(err => {
  console.error('ui-audit failed:', err)
  process.exit(1)
})
