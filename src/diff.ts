// src/diff.ts
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { deserializeFingerprint } from './fingerprint/yaml'
import { diffFingerprints } from './fingerprint/diff-engine'
import type { FullDiffReport } from './fingerprint/types'

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

/**
 * Detect whether a directory is a single-state capture (fingerprint at
 * top level) or a scenarios output (one subdirectory per scenario).
 */
function detectLayout(dir: string): 'flat' | 'scenarios' {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 'flat'
  }
  const hasDirectFingerprint = entries.some(
    f => f.startsWith('fingerprint') && f.endsWith('.yaml'),
  )
  if (hasDirectFingerprint) return 'flat'

  const subDirsWithFingerprint = entries.filter(entry => {
    const full = join(dir, entry)
    try {
      if (!statSync(full).isDirectory()) return false
      return readdirSync(full).some(
        f => f.startsWith('fingerprint') && f.endsWith('.yaml'),
      )
    } catch {
      return false
    }
  })
  return subDirsWithFingerprint.length > 0 ? 'scenarios' : 'flat'
}

function printReport(report: FullDiffReport, label: string): void {
  console.log(`Diff: ${label}`)
  if (report.regressions.missing.length) console.log(`  Removed regions: ${report.regressions.missing.join(', ')}`)
  if (report.regressions.added.length) console.log(`  Added regions: ${report.regressions.added.join(', ')}`)

  const totalFailures = report.invariants.failures.length + report.regressions.failures.length
  if (totalFailures === 0) {
    console.log('  No differences.')
    return
  }
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
}

function diffSingle(oldDir: string, newDir: string, stateName: string): FullDiffReport {
  const oldFp = deserializeFingerprint(loadFingerprint(oldDir, stateName))
  const newFp = deserializeFingerprint(loadFingerprint(newDir, stateName))
  return diffFingerprints(oldFp, newFp)
}

export async function runDiff(oldDir: string, newDir: string, stateName: string): Promise<void> {
  const oldLayout = detectLayout(oldDir)
  const newLayout = detectLayout(newDir)

  // Flat mode: one state in each dir — original behavior.
  if (oldLayout === 'flat' && newLayout === 'flat') {
    const report = diffSingle(oldDir, newDir, stateName)
    printReport(report, `${oldDir} → ${newDir}`)
    writeFileSync(join(newDir, 'report.json'), JSON.stringify(report, null, 2))
    return
  }

  // Scenarios mode: loop over matching subdirs, aggregate.
  const oldScenarios = new Set(subDirNames(oldDir))
  const newScenarios = new Set(subDirNames(newDir))
  const shared = [...newScenarios].filter(n => oldScenarios.has(n)).sort()
  const missing = [...oldScenarios].filter(n => !newScenarios.has(n))
  const added = [...newScenarios].filter(n => !oldScenarios.has(n))

  if (shared.length === 0) {
    console.error(`No matching scenario subdirectories found in ${oldDir} and ${newDir}`)
    process.exit(1)
  }

  console.log(`Diffing ${shared.length} scenario(s) between ${oldDir} and ${newDir}...\n`)

  let totalInvariants = 0
  let totalRegressions = 0
  const perScenarioResults: Array<{ name: string; report: FullDiffReport }> = []

  for (const name of shared) {
    const oldSub = join(oldDir, name)
    const newSub = join(newDir, name)
    try {
      const report = diffSingle(oldSub, newSub, name)
      perScenarioResults.push({ name, report })
      totalInvariants += report.invariants.failures.length
      totalRegressions += report.regressions.failures.length
      printReport(report, `[${name}] ${oldSub} → ${newSub}`)
      // Write per-scenario report so agents can load just the one they need.
      writeFileSync(join(newSub, 'report.json'), JSON.stringify(report, null, 2))
      console.log('')
    } catch (err) {
      console.error(`  [${name}] diff failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Top-level summary — callers reading report.json at the run root get one
  // aggregate view across every scenario. Per-scenario reports stay in each
  // subdir.
  console.log(`\nSummary across ${shared.length} scenario(s):`)
  console.log(`  Total invariant failures: ${totalInvariants}`)
  console.log(`  Total regressions: ${totalRegressions}`)
  if (missing.length > 0) console.log(`  Missing scenarios (in baseline, not in current): ${missing.join(', ')}`)
  if (added.length > 0) console.log(`  New scenarios (in current, not in baseline): ${added.join(', ')}`)

  const aggregate = {
    pass: totalInvariants === 0 && totalRegressions === 0 && missing.length === 0,
    timestamp: new Date().toISOString(),
    source: oldDir,
    target: newDir,
    scenarios: perScenarioResults.map(r => ({
      name: r.name,
      pass: r.report.pass,
      invariantFailures: r.report.invariants.failures.length,
      regressions: r.report.regressions.failures.length,
    })),
    totals: {
      invariantFailures: totalInvariants,
      regressions: totalRegressions,
    },
    missingScenarios: missing,
    addedScenarios: added,
  }
  writeFileSync(join(newDir, 'report.json'), JSON.stringify(aggregate, null, 2))
}

function subDirNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter(entry => {
      const full = join(dir, entry)
      try { return statSync(full).isDirectory() } catch { return false }
    })
  } catch {
    return []
  }
}
