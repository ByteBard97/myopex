import type { UIFingerprint, FullDiffReport, InvariantFailure, RegressionFailure, InvariantReport, RegressionReport } from './types'
import { EXACT_COMPARE_PROPS, NUMERIC_TOLERANCES, INVARIANTS } from '../constants'

/**
 * Compare two fingerprints and produce a structured diff report.
 * Runs invariant checks on `current`, then diffs against `baseline`.
 * Components are matched by composite ID (not by index).
 */
export function diffFingerprints(
  baseline: UIFingerprint,
  current: UIFingerprint,
): FullDiffReport {
  const invariantFailures: InvariantFailure[] = []
  const regressionFailures: RegressionFailure[] = []
  let invariantChecks = 0
  let regressionChecks = 0

  const baseRegions = Object.keys(baseline.regions)
  const currRegions = Object.keys(current.regions)
  const missing = baseRegions.filter(k => !currRegions.includes(k))
  const added = currRegions.filter(k => !baseRegions.includes(k))

  // Invariant checks on all current components
  for (const [regionKey, region] of Object.entries(current.regions)) {
    for (const comp of region.components) {
      // Skip failed resolutions — they're extraction failures, not UI bugs
      if (comp.props.resolveStatus === 'failed') continue
      for (const inv of INVARIANTS) {
        // Testid-injected components (resolveStatus: 'fallback') are stamped
        // role='generic' because we don't round-trip through the AX tree for
        // them. That means we can't distinguish "transparent button
        // inheriting its parent's bg" (intended) from "transparent container
        // missing its theme" (bug). The other invariants (visible, overflow,
        // zero-size) don't depend on role, so we still run those.
        if (inv.prop === 'backgroundColor' && comp.props.resolveStatus === 'fallback') continue

        invariantChecks++
        const value = resolveProperty(comp.props as unknown as Record<string, unknown>, inv.prop)
        if (inv.check(value, comp.props.role)) {
          invariantFailures.push({
            component: comp.id, region: regionKey,
            property: inv.prop,
            value: value as string | number | boolean,
            message: inv.msg,
            screenshotFile: comp.props.screenshotFile,
          })
        }
      }
    }
  }

  // Diff components against baseline — match by composite ID
  for (const regionKey of baseRegions) {
    if (!current.regions[regionKey]) continue
    const baseComps = baseline.regions[regionKey].components
    const currComps = current.regions[regionKey].components
    const currById = new Map(currComps.map(c => [c.id, c]))

    for (const baseComp of baseComps) {
      const currComp = currById.get(baseComp.id)
      if (!currComp) {
        regressionChecks++
        regressionFailures.push({
          component: baseComp.id, region: regionKey,
          property: 'exists', expected: true, actual: false,
        })
        continue
      }

      for (const prop of EXACT_COMPARE_PROPS) {
        regressionChecks++
        const bVal = baseComp.props[prop as keyof typeof baseComp.props]
        const cVal = currComp.props[prop as keyof typeof currComp.props]
        if (bVal !== cVal) {
          regressionFailures.push({
            component: currComp.id, region: regionKey,
            property: prop,
            expected: bVal as string | number | boolean,
            actual: cVal as string | number | boolean,
            screenshotFile: currComp.props.screenshotFile,
          })
        }
      }

      for (const [prop, tolerance] of Object.entries(NUMERIC_TOLERANCES)) {
        regressionChecks++
        const bVal = (baseComp.props.bounds as unknown as Record<string, number>)[prop]
        const cVal = (currComp.props.bounds as unknown as Record<string, number>)[prop]
        if (typeof bVal === 'number' && typeof cVal === 'number') {
          if (Math.abs(bVal - cVal) > tolerance) {
            regressionFailures.push({
              component: currComp.id, region: regionKey,
              property: `bounds.${prop}`,
              expected: bVal, actual: cVal,
              screenshotFile: currComp.props.screenshotFile,
            })
          }
        }
      }
    }
  }

  for (const key of missing) {
    regressionChecks++
    regressionFailures.push({
      component: key, region: key,
      property: 'region.exists', expected: true, actual: false,
    })
  }

  const invariants: InvariantReport = {
    failures: invariantFailures,
    checked: invariantChecks,
  }
  const regressions: RegressionReport = {
    failures: regressionFailures,
    checked: regressionChecks,
    missing, added,
  }

  return {
    pass: invariantFailures.length === 0 && regressionFailures.length === 0,
    timestamp: new Date().toISOString(),
    source: baseline.page.url,
    target: current.page.url,
    invariants,
    regressions,
  }
}

/** Resolve a dotted property path (e.g., 'bounds.width') on an object */
function resolveProperty(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
