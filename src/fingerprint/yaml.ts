import { stringify, parse } from 'yaml'
import type { UIFingerprint } from './types'

const YAML_OPTS = {
  indent: 2,
  lineWidth: 120,
  defaultStringType: 'PLAIN' as const,
  defaultKeyType: 'PLAIN' as const,
}

export function serializeFingerprint(fp: UIFingerprint): string {
  // Compute _estimated_tokens per region on a shallow copy to avoid mutating input
  const regionsWithTokens: Record<string, typeof fp.regions[string]> = {}
  for (const [key, region] of Object.entries(fp.regions)) {
    const regionYaml = stringify(region, YAML_OPTS)
    regionsWithTokens[key] = { ...region, _estimated_tokens: Math.ceil(regionYaml.length / 4) }
  }
  const output = { ...fp, regions: regionsWithTokens }
  return stringify(output, YAML_OPTS)
}

export function deserializeFingerprint(yamlStr: string): UIFingerprint {
  return parse(yamlStr) as UIFingerprint
}
