import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runVueDetail } from '../src/cli-vue-detail'

let tmpDir: string

const SAMPLE_SIDECAR = {
  capturedAt: '2026-04-18T00:00:00Z',
  components: {
    '15': {
      name: 'PlantCard',
      uid: 15,
      props: { plantId: 42, compact: false },
      setupState: { isExpanded: false },
      childUids: [],
    },
    '16': {
      name: 'SoilBar',
      uid: 16,
      props: { score: 0.8 },
      setupState: {},
      childUids: [],
    },
  },
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'myopex-vuedetail-'))
  writeFileSync(join(tmpDir, 'vue-detail.json'), JSON.stringify(SAMPLE_SIDECAR))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('runVueDetail', () => {
  it('prints the matching component as formatted JSON', () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))

    // Mock process.exit so it throws instead of killing the process
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`)
    })

    try {
      runVueDetail(15, tmpDir)
    } finally {
      spy.mockRestore()
      exitSpy.mockRestore()
    }

    expect(logs.length).toBeGreaterThan(0)
    const output = JSON.parse(logs.join(''))
    expect(output.name).toBe('PlantCard')
    expect(output.uid).toBe(15)
    expect(output.props.plantId).toBe(42)
  })

  it('calls process.exit(1) when vue-detail.json is missing', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      expect(() => runVueDetail(15, '/tmp/definitely-does-not-exist-12345')).toThrow('process.exit(1)')
    } finally {
      exitSpy.mockRestore()
      vi.restoreAllMocks()
    }
  })

  it('calls process.exit(1) when uid is not found', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      expect(() => runVueDetail(9999, tmpDir)).toThrow('process.exit(1)')
    } finally {
      exitSpy.mockRestore()
      vi.restoreAllMocks()
    }
  })
})
