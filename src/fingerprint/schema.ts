import type { UIFingerprint } from './types'

export function validateFingerprint(raw: unknown): UIFingerprint {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid fingerprint: expected an object')
  }

  const obj = raw as Record<string, unknown>

  if (obj.version !== 2) {
    throw new Error(
      `Invalid fingerprint: version must be 2, got ${JSON.stringify(obj.version)}`
    )
  }

  if (!obj.page || typeof obj.page !== 'object') {
    throw new Error('Invalid fingerprint: missing or invalid "page" block')
  }
  const page = obj.page as Record<string, unknown>
  for (const field of ['url', 'title', 'background', 'layout', 'capturedAt']) {
    if (typeof page[field] !== 'string') {
      throw new Error(`Invalid fingerprint: page.${field} must be a string`)
    }
  }
  if (!page.viewport || typeof page.viewport !== 'object') {
    throw new Error('Invalid fingerprint: page.viewport must be an object')
  }
  if (!Array.isArray(page.landmarks)) {
    throw new Error('Invalid fingerprint: page.landmarks must be an array')
  }

  if (!obj.regions || typeof obj.regions !== 'object') {
    throw new Error('Invalid fingerprint: missing or invalid "regions" block')
  }

  if (!obj.state || typeof obj.state !== 'object') {
    throw new Error('Invalid fingerprint: missing or invalid "state" block')
  }

  if (!Array.isArray(obj.ungrouped)) {
    throw new Error('Invalid fingerprint: "ungrouped" must be an array')
  }

  if (obj.vueComponents !== undefined) {
    if (!Array.isArray(obj.vueComponents)) {
      throw new Error('Invalid fingerprint: "vueComponents" must be an array')
    }
    for (const node of obj.vueComponents as unknown[]) {
      if (!node || typeof node !== 'object') {
        throw new Error('Invalid fingerprint: each vueComponents entry must be an object')
      }
      const n = node as Record<string, unknown>
      if (typeof n.name !== 'string') {
        throw new Error('Invalid fingerprint: vueComponents[].name must be a string')
      }
      if (typeof n.uid !== 'number') {
        throw new Error('Invalid fingerprint: vueComponents[].uid must be a number')
      }
    }
  }

  return obj as unknown as UIFingerprint
}
