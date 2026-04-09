import type { UIFingerprint, DiffReport, DiffFailure } from './types'
import { EXACT_COMPARE_PROPS, NUMERIC_TOLERANCES, INVARIANTS } from '../constants'

/**
 * Compare two fingerprints and produce a structured diff report.
 * Runs invariant checks on `current`, then diffs against `baseline`.
 * Components are matched by composite ID (not by index).
 */
export function diffFingerprints(
  baseline: UIFingerprint,
  current: UIFingerprint,
): DiffReport {
  const failures: DiffFailure[] = []
  const baseRegions = Object.keys(baseline.regions)
  const currRegions = Object.keys(current.regions)
  const missing = baseRegions.filter(k => !currRegions.includes(k))
  const added = currRegions.filter(k => !baseRegions.includes(k))
  let totalChecked = 0

  // Invariant checks on all current components
  for (const [regionKey, region] of Object.entries(current.regions)) {
    for (const comp of region.components) {
      for (const inv of INVARIANTS) {
        totalChecked++
        const value = comp.props[inv.prop as keyof typeof comp.props]
        if (inv.check(value, comp.props.role)) {
          failures.push({
            component: comp.id, region: regionKey,
            property: inv.prop,
            expected: `not ${String(value)}`,
            actual: value as string | number | boolean,
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
        totalChecked++
        failures.push({
          component: baseComp.id, region: regionKey,
          property: 'exists', expected: true, actual: false,
        })
        continue
      }

      for (const prop of EXACT_COMPARE_PROPS) {
        totalChecked++
        const bVal = baseComp.props[prop as keyof typeof baseComp.props]
        const cVal = currComp.props[prop as keyof typeof currComp.props]
        if (bVal !== cVal) {
          failures.push({
            component: currComp.id, region: regionKey,
            property: prop,
            expected: bVal as string | number | boolean,
            actual: cVal as string | number | boolean,
            screenshotFile: currComp.props.screenshotFile,
          })
        }
      }

      for (const [prop, tolerance] of Object.entries(NUMERIC_TOLERANCES)) {
        totalChecked++
        const bVal = (baseComp.props.bounds as Record<string, number>)[prop]
        const cVal = (currComp.props.bounds as Record<string, number>)[prop]
        if (typeof bVal === 'number' && typeof cVal === 'number') {
          if (Math.abs(bVal - cVal) > tolerance) {
            failures.push({
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
    totalChecked++
    failures.push({
      component: key, region: key,
      property: 'region.exists', expected: true, actual: false,
    })
  }

  return {
    pass: failures.length === 0,
    timestamp: new Date().toISOString(),
    old: baseline.page.url,
    new: current.page.url,
    totalChecked,
    passed: totalChecked - failures.length,
    failed: failures.length,
    missing, added, failures,
  }
}
