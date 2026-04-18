import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { VueDetailSidecar } from './fingerprint/types'

export function runVueDetail(uid: number, dir: string): void {
  const sidecarPath = join(dir, 'vue-detail.json')

  if (!existsSync(sidecarPath)) {
    console.error(
      `vue-detail.json not found in ${dir}.\n` +
        'Run myopex capture or myopex scenarios first to generate it.',
    )
    process.exit(1)
  }

  let sidecar: VueDetailSidecar
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as VueDetailSidecar
  } catch (err) {
    console.error(`Failed to parse ${sidecarPath}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const entry = sidecar.components[String(uid)]
  if (!entry) {
    const available = Object.values(sidecar.components)
      .map(e => `  ${e.uid}  ${e.name}`)
      .join('\n')
    console.error(`Component uid ${uid} not found in ${sidecarPath}.\nAvailable components:\n${available}`)
    process.exit(1)
  }

  console.log(JSON.stringify(entry, null, 2))
}
