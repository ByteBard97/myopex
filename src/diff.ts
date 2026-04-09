// src/diff.ts
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { deserializeFingerprint } from './fingerprint/yaml'
import { diffFingerprints } from './fingerprint/diff-engine'

/** Find the fingerprint YAML file in a directory. Tries exact state name first, then any .yaml file. */
function loadFingerprint(dir: string, stateName: string): string {
  const exact = stateName === 'default' ? 'fingerprint.yaml' : `fingerprint-${stateName}.yaml`
  try {
    return readFileSync(join(dir, exact), 'utf-8')
  } catch {
    // Fallback: find any fingerprint-*.yaml in the directory
    const files = readdirSync(dir).filter(f => f.startsWith('fingerprint') && f.endsWith('.yaml'))
    if (files.length === 0) throw new Error(`No fingerprint YAML found in ${dir}`)
    return readFileSync(join(dir, files[0]), 'utf-8')
  }
}

export async function runDiff(oldDir: string, newDir: string, stateName: string): Promise<void> {
  const oldFp = deserializeFingerprint(loadFingerprint(oldDir, stateName))
  const newFp = deserializeFingerprint(loadFingerprint(newDir, stateName))

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
