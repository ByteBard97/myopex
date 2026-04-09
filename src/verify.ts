// src/verify.ts
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { runCapture } from './capture'
import { deserializeFingerprint } from './fingerprint/yaml'
import { diffFingerprints } from './fingerprint/diff-engine'

export async function runVerify(url: string, baselineDir: string, stateName: string): Promise<boolean> {
  const filename = stateName === 'default' ? 'fingerprint.yaml' : `fingerprint-${stateName}.yaml`
  const baselinePath = join(baselineDir, filename)

  if (!existsSync(baselinePath)) {
    console.error(`No baseline found at ${baselinePath}. Run 'capture' first.`)
    process.exit(1)
  }

  const baselineYaml = readFileSync(baselinePath, 'utf-8')
  const baseline = deserializeFingerprint(baselineYaml)

  // Capture current state into a temp subdirectory
  const currentDir = join(baselineDir, 'current')
  await runCapture(url, currentDir, stateName)

  const currentYaml = readFileSync(join(currentDir, filename), 'utf-8')
  const current = deserializeFingerprint(currentYaml)

  const report = diffFingerprints(baseline, current)
  writeFileSync(join(baselineDir, 'report.json'), JSON.stringify(report, null, 2))

  if (report.pass) {
    console.log(`  PASS — ${report.invariants.checked + report.regressions.checked} checks passed, 0 failures`)
  } else {
    if (report.invariants.failures.length > 0) {
      console.log(`  INVARIANT FAILURES (${report.invariants.failures.length}):`)
      for (const f of report.invariants.failures) {
        console.log(`    ✗ [${f.region}] ${f.component}.${f.property}: ${f.message}`)
      }
    }
    if (report.regressions.failures.length > 0) {
      console.log(`  REGRESSIONS (${report.regressions.failures.length}):`)
      for (const f of report.regressions.failures) {
        console.log(`    ✗ [${f.region}] ${f.component}.${f.property}: expected ${f.expected}, got ${f.actual}`)
      }
    }
    if (report.regressions.missing.length > 0) console.log(`  Missing regions: ${report.regressions.missing.join(', ')}`)
    if (report.regressions.added.length > 0) console.log(`  New regions: ${report.regressions.added.join(', ')}`)
  }

  return report.pass
}
