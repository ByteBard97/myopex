// src/diff.ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { deserializeFingerprint } from './fingerprint/yaml'
import { diffFingerprints } from './fingerprint/diff-engine'

export async function runDiff(oldDir: string, newDir: string, stateName: string): Promise<void> {
  const filename = stateName === 'default' ? 'fingerprint.yaml' : `fingerprint-${stateName}.yaml`

  const oldFp = deserializeFingerprint(readFileSync(join(oldDir, filename), 'utf-8'))
  const newFp = deserializeFingerprint(readFileSync(join(newDir, filename), 'utf-8'))

  const report = diffFingerprints(oldFp, newFp)

  console.log(`Diff: ${oldDir} → ${newDir}`)
  console.log(`  Regions: ${Object.keys(oldFp.regions).length} → ${Object.keys(newFp.regions).length}`)
  if (report.regressions.missing.length) console.log(`  Removed regions: ${report.regressions.missing.join(', ')}`)
  if (report.regressions.added.length) console.log(`  Added regions: ${report.regressions.added.join(', ')}`)

  const totalFailures = report.invariants.failures.length + report.regressions.failures.length
  if (totalFailures > 0) {
    if (report.invariants.failures.length > 0) {
      console.log(`  ${report.invariants.failures.length} invariant failure(s):`)
      for (const f of report.invariants.failures) {
        console.log(`    [${f.region}] ${f.component}.${f.property}: ${f.message}`)
      }
    }
    if (report.regressions.failures.length > 0) {
      console.log(`  ${report.regressions.failures.length} regression(s):`)
      for (const f of report.regressions.failures) {
        console.log(`    [${f.region}] ${f.component}.${f.property}: ${f.expected} → ${f.actual}`)
      }
    }
  } else {
    console.log('  No differences.')
  }
}
