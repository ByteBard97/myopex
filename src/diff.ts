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
  if (report.missing.length) console.log(`  Removed regions: ${report.missing.join(', ')}`)
  if (report.added.length) console.log(`  Added regions: ${report.added.join(', ')}`)
  if (report.failures.length) {
    console.log(`  ${report.failures.length} difference(s):`)
    for (const f of report.failures) {
      console.log(`    [${f.region}] ${f.component}.${f.property}: ${f.expected} → ${f.actual}`)
    }
  } else {
    console.log('  No differences.')
  }
}
