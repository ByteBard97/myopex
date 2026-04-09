import { describe, it, expect } from 'vitest'
import { diffFingerprints } from '../../src/fingerprint/diff-engine'
import type { UIFingerprint, Region, Component } from '../../src/fingerprint/types'

function makeComponent(id: string, overrides: Partial<Component['props']> = {}): Component {
  return {
    id,
    props: {
      role: 'generic', name: 'test',
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      visible: true, backgroundColor: 'rgb(26, 34, 50)',
      color: 'rgb(226, 232, 240)', fontSize: '14px',
      borderWidth: '1px', opacity: '1', display: 'block',
      overflow: 'visible', textOverflow: false,
      textContent: 'Test', childCount: 0,
      ...overrides,
    },
  }
}

function makeFingerprint(regions: Record<string, Region>): UIFingerprint {
  return {
    version: 2,
    page: {
      url: '/', title: 'Test',
      viewport: { width: 1440, height: 900 },
      theme: 'dark', background: '#000',
      layout: 'main', landmarks: ['main'],
      capturedAt: '2026-04-08T00:00:00Z',
    },
    regions,
    ungrouped: [],
    state: { name: 'default', modals: 'none', selection: null },
  }
}

describe('diff engine', () => {
  it('passes when fingerprints are identical', () => {
    const region: Region = {
      role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 },
      background: '#000', childCount: 1,
      components: [makeComponent('main/generic[0]')],
    }
    const fp = makeFingerprint({ main: region })
    const report = diffFingerprints(fp, fp)
    expect(report.pass).toBe(true)
    expect(report.failed).toBe(0)
  })

  it('detects transparent background invariant violation', () => {
    const region: Region = {
      role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 },
      background: '#000', childCount: 1,
      components: [makeComponent('main/generic[0]', { backgroundColor: 'rgba(0, 0, 0, 0)' })],
    }
    const fp = makeFingerprint({ main: region })
    const report = diffFingerprints(fp, fp)
    expect(report.pass).toBe(false)
    expect(report.failures.some(f => f.property === 'backgroundColor')).toBe(true)
  })

  it('detects text overflow invariant violation', () => {
    const region: Region = {
      role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 },
      background: '#000', childCount: 1,
      components: [makeComponent('main/generic[0]', { textOverflow: true })],
    }
    const fp = makeFingerprint({ main: region })
    const report = diffFingerprints(fp, fp)
    expect(report.pass).toBe(false)
  })

  it('detects missing region', () => {
    const old = makeFingerprint({
      main: { role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 }, background: '#000', childCount: 0, components: [] },
      banner: { role: 'banner', bounds: { x: 0, y: 0, width: 1440, height: 56 }, background: '#1E293B', childCount: 0, components: [] },
    })
    const current = makeFingerprint({
      main: { role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 }, background: '#000', childCount: 0, components: [] },
    })
    const report = diffFingerprints(old, current)
    expect(report.missing).toContain('banner')
  })

  it('detects background color change from baseline', () => {
    const region1: Region = {
      role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 },
      background: '#000', childCount: 1,
      components: [makeComponent('main/generic[0]', { backgroundColor: 'rgb(26, 34, 50)' })],
    }
    const region2: Region = {
      role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 },
      background: '#000', childCount: 1,
      components: [makeComponent('main/generic[0]', { backgroundColor: 'rgb(255, 0, 0)' })],
    }
    const old = makeFingerprint({ main: region1 })
    const current = makeFingerprint({ main: region2 })
    const report = diffFingerprints(old, current)
    expect(report.pass).toBe(false)
    expect(report.failures.some(f =>
      f.property === 'backgroundColor' && f.expected === 'rgb(26, 34, 50)'
    )).toBe(true)
  })

  it('detects zero-size invariant via bounds.width and bounds.height', () => {
    const region: Region = {
      role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 },
      background: '#000', childCount: 1,
      components: [makeComponent('main/generic[0]', {
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      })],
    }
    const fp = makeFingerprint({ main: region })
    const report = diffFingerprints(fp, fp)
    expect(report.pass).toBe(false)
    expect(report.failures.some(f => f.property === 'bounds.width')).toBe(true)
    expect(report.failures.some(f => f.property === 'bounds.height')).toBe(true)
  })

  it('matches components by composite ID, not by index', () => {
    const old = makeFingerprint({
      main: { role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 }, background: '#000', childCount: 2,
        components: [
          makeComponent('main/button["Save"]'),
          makeComponent('main/button["Cancel"]'),
        ],
      },
    })
    const current = makeFingerprint({
      main: { role: 'main', bounds: { x: 0, y: 0, width: 1440, height: 900 }, background: '#000', childCount: 1,
        components: [
          makeComponent('main/button["Cancel"]'), // Save removed, Cancel still present
        ],
      },
    })
    const report = diffFingerprints(old, current)
    // Save should be missing, Cancel should match
    expect(report.failures.some(f => f.component === 'main/button["Save"]' && f.property === 'exists')).toBe(true)
    expect(report.failures.some(f => f.component === 'main/button["Cancel"]')).toBe(false)
  })
})
