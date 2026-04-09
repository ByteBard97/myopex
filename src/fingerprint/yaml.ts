import { stringify, parse } from 'yaml'
import type { UIFingerprint } from './types'

const YAML_OPTS = {
  indent: 2,
  lineWidth: 120,
  defaultStringType: 'PLAIN' as const,
  defaultKeyType: 'PLAIN' as const,
}

export function serializeFingerprint(fp: UIFingerprint): string {
  // Compute _estimated_tokens per region before serialization
  for (const region of Object.values(fp.regions)) {
    const regionYaml = stringify(region, YAML_OPTS)
    region._estimated_tokens = Math.ceil(regionYaml.length / 4)
  }
  return stringify(fp, YAML_OPTS)
}

export function deserializeFingerprint(yamlStr: string): UIFingerprint {
  return parse(yamlStr) as UIFingerprint
}
