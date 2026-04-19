import { describe, it, expect } from 'vitest'
import { serializeFingerprint, deserializeFingerprint } from '../../src/fingerprint/yaml'
import type { UIFingerprint } from '../../src/fingerprint/types'

const SAMPLE_FP: UIFingerprint = {
  version: 2,
  page: {
    url: '/',
    title: 'Test',
    viewport: { width: 1440, height: 900 },
    theme: 'dark',
    background: '#0F172A',
    layout: 'header + sidebar + main',
    landmarks: ['banner', 'navigation', 'main'],
    capturedAt: '2026-04-08T00:00:00Z',
  },
  regions: {
    banner: {
      role: 'banner',
      bounds: { x: 0, y: 0, width: 1440, height: 56 },
      background: '#1E293B',
      childCount: 3,
      summary: 'Top bar with logo',
      components: [{
        id: 'banner/img["Logo"]',
        props: {
          role: 'img', name: 'Logo',
          bounds: { x: 16, y: 12, width: 32, height: 32 },
          visible: true, backgroundColor: 'transparent',
          color: '#2DD4BF', fontSize: '16px', borderWidth: '0px',
          opacity: '1', display: 'inline', overflow: 'visible',
          textOverflow: false, textContent: 'TESTAPP', childCount: 0,
          resolveStatus: 'ok',
        },
      }],
    },
  },
  ungrouped: [],
  state: { name: 'default', modals: 'none', selection: null },
}

describe('YAML serialization', () => {
  it('produces valid YAML string', () => {
    const yaml = serializeFingerprint(SAMPLE_FP)
    expect(typeof yaml).toBe('string')
    expect(yaml).toContain('version: 2')
    expect(yaml).toContain('url: /')
    expect(yaml).toContain('role: banner')
  })

  it('YAML is human-readable with proper indentation', () => {
    const yaml = serializeFingerprint(SAMPLE_FP)
    const lines = yaml.split('\n')
    expect(lines.some(l => l.startsWith('  '))).toBe(true)
    expect(lines.some(l => l.startsWith('    '))).toBe(true)
  })
})

describe('YAML deserialization', () => {
  it('parses YAML back to UIFingerprint', () => {
    const yaml = serializeFingerprint(SAMPLE_FP)
    const fp = deserializeFingerprint(yaml)
    expect(fp.version).toBe(2)
    expect(fp.page.url).toBe('/')
  })
})

describe('YAML validation', () => {
  it('rejects YAML with missing version field', () => {
    const bad = 'page:\n  url: /\n'
    expect(() => deserializeFingerprint(bad)).toThrow(/version/)
  })

  it('rejects YAML with wrong version', () => {
    const bad = 'version: 99\npage:\n  url: /\n'
    expect(() => deserializeFingerprint(bad)).toThrow(/version/)
  })

  it('rejects completely invalid YAML', () => {
    expect(() => deserializeFingerprint('not: valid: yaml: [')).toThrow()
  })

  it('rejects YAML with missing page block', () => {
    const bad = 'version: 2\nregions: {}\n'
    expect(() => deserializeFingerprint(bad)).toThrow(/page/)
  })
})

describe('vueComponents roundtrip', () => {
  it('serialize → deserialize preserves vueComponents', () => {
    const fp: UIFingerprint = {
      version: 2,
      page: {
        url: '/',
        title: 'Test',
        viewport: { width: 1440, height: 900 },
        theme: 'light',
        background: 'white',
        layout: 'main',
        landmarks: ['main'],
        capturedAt: '2026-04-18T00:00:00Z',
      },
      regions: {},
      ungrouped: [],
      state: { name: 'default', modals: 'none', selection: null },
      vueComponents: [
        {
          name: 'PlantCard',
          uid: 15,
          bounds: { x: 10, y: 130, width: 300, height: 200 },
          props: { plantId: 42, compact: false },
          descendantComponentCount: 0,
          children: [],
          screenshotFile: 'screenshots/vue-PlantCard-15.png',
        },
      ],
    }
    const yaml = serializeFingerprint(fp)
    const restored = deserializeFingerprint(yaml)
    expect(restored.vueComponents).toHaveLength(1)
    expect(restored.vueComponents![0].name).toBe('PlantCard')
    expect(restored.vueComponents![0].uid).toBe(15)
    expect(restored.vueComponents![0].props).toEqual({ plantId: 42, compact: false })
  })

  it('serialize → deserialize preserves fingerprint without vueComponents', () => {
    const fp: UIFingerprint = {
      version: 2,
      page: {
        url: '/',
        title: 'Test',
        viewport: { width: 1440, height: 900 },
        theme: 'light',
        background: 'white',
        layout: 'main',
        landmarks: [],
        capturedAt: '2026-04-18T00:00:00Z',
      },
      regions: {},
      ungrouped: [],
      state: { name: 'default', modals: 'none', selection: null },
    }
    const yaml = serializeFingerprint(fp)
    const restored = deserializeFingerprint(yaml)
    expect(restored.vueComponents).toBeUndefined()
  })
})

describe('YAML roundtrip', () => {
  it('serialize → deserialize preserves all data', () => {
    const original: UIFingerprint = {
      version: 2,
      page: {
        url: '/dashboard', title: 'Dashboard',
        viewport: { width: 1440, height: 900 },
        theme: 'deep-navy', background: 'rgb(15, 23, 42)',
        layout: 'header + sidebar + main + footer',
        landmarks: ['banner', 'navigation', 'main', 'contentinfo'],
        capturedAt: '2026-04-08T12:00:00Z',
      },
      regions: {
        main: {
          role: 'main',
          bounds: { x: 48, y: 56, width: 1392, height: 812 },
          background: 'rgb(15, 23, 42)',
          childCount: 4,
          summary: 'Canvas with 4 device nodes',
          components: [],
        },
      },
      ungrouped: [],
      state: { name: 'project-loaded', modals: 'none', selection: null },
    }

    const yaml = serializeFingerprint(original)
    const restored = deserializeFingerprint(yaml)

    expect(restored.version).toBe(original.version)
    expect(restored.page).toEqual(original.page)
    expect(restored.regions.main.role).toBe('main')
    expect(restored.regions.main.bounds).toEqual(original.regions.main.bounds)
    expect(restored.state).toEqual(original.state)
  })
})
