// Library entry point — public API for programmatic use and type imports.
//
// Most users will invoke myopex via the CLI (`myopex scenarios ...`)
// rather than import this module. It's exposed for:
//   - TypeScript users who want `Scenario` / `Step` types in their config
//   - Advanced users who want to embed capture/diff into custom scripts

export type { Scenario, Step } from './scenarios'
export type {
  UIFingerprint,
  Region,
  Component,
  ElementProps,
  FullDiffReport,
} from './fingerprint/types'

export { runScenarios, loadScenarioConfig } from './scenarios'
export { runCapture, captureFromPage } from './capture'
export { runVerify } from './verify'
export { runDiff } from './diff'
export { serializeFingerprint, deserializeFingerprint } from './fingerprint/yaml'
export { diffFingerprints } from './fingerprint/diff-engine'
