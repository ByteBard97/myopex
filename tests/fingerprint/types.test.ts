import { describe, it, expect } from 'vitest'
import type {
  UIFingerprint, Region, Component, ElementProps, PageMeta
} from '../../src/fingerprint/types'

describe('fingerprint types', () => {
  it('PageMeta has required fields', () => {
    const meta: PageMeta = {
      url: '/',
      title: 'Test',
      viewport: { width: 1440, height: 900 },
      theme: 'dark',
      background: '#0F172A',
      layout: 'header + sidebar + main',
      landmarks: ['banner', 'navigation', 'main'],
      capturedAt: '2026-04-08T00:00:00Z',
    }
    expect(meta.url).toBe('/')
    expect(meta.landmarks).toHaveLength(3)
  })

  it('ElementProps captures visual properties', () => {
    const props: ElementProps = {
      role: 'button',
      name: 'Submit',
      bounds: { x: 100, y: 200, width: 120, height: 40 },
      visible: true,
      backgroundColor: 'rgb(59, 130, 246)',
      color: 'rgb(255, 255, 255)',
      fontSize: '14px',
      borderWidth: '1px',
      opacity: '1',
      display: 'flex',
      overflow: 'visible',
      textOverflow: false,
      textContent: 'Submit',
      childCount: 1,
      resolveStatus: 'ok',
    }
    expect(props.visible).toBe(true)
    expect(props.bounds.width).toBe(120)
  })

  it('Region groups components under a landmark', () => {
    const region: Region = {
      role: 'banner',
      bounds: { x: 0, y: 0, width: 1440, height: 56 },
      background: '#1E293B',
      childCount: 3,
      components: [],
    }
    expect(region.role).toBe('banner')
  })

  it('Region summary is optional', () => {
    const region: Region = {
      role: 'main',
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      background: '#000',
      childCount: 0,
      components: [],
    }
    expect(region.summary).toBeUndefined()
  })

  it('UIFingerprint has page + regions + state', () => {
    const fp: UIFingerprint = {
      version: 2,
      page: {
        url: '/',
        title: 'App',
        viewport: { width: 1440, height: 900 },
        theme: 'dark',
        background: '#000',
        layout: 'sidebar + main',
        landmarks: ['main'],
        capturedAt: '2026-04-08T00:00:00Z',
      },
      regions: {},
      ungrouped: [],
      state: { name: 'default', modals: 'none', selection: null },
    }
    expect(fp.version).toBe(2)
    expect(fp.page.url).toBe('/')
  })

  it('Component id uses composite key format', () => {
    const comp: Component = {
      id: 'navigation/button["Home"]',
      props: {
        role: 'button', name: 'Home',
        bounds: { x: 0, y: 0, width: 48, height: 48 },
        visible: true, backgroundColor: '', color: '', fontSize: '',
        borderWidth: '', opacity: '1', display: '', overflow: '',
        textOverflow: false, textContent: 'Home', childCount: 0,
        resolveStatus: 'ok',
      },
    }
    expect(comp.id).toContain('navigation/')
    expect(comp.id).toContain('button')
    expect(comp.id).toContain('Home')
  })
})
