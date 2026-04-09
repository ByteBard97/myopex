import { describe, it, expect } from 'vitest'
import {
  EXTRACT_FN_SOURCE,
  type VisualPropsResult,
} from '../../src/extract/visual-props'

describe('visual-props', () => {
  it('EXTRACT_FN_SOURCE is a valid function string', () => {
    expect(typeof EXTRACT_FN_SOURCE).toBe('string')
    expect(EXTRACT_FN_SOURCE).toContain('getBoundingClientRect')
    expect(EXTRACT_FN_SOURCE).toContain('getComputedStyle')
    expect(EXTRACT_FN_SOURCE).toContain('scrollWidth')
  })

  it('VisualPropsResult type has all required fields', () => {
    const sample: VisualPropsResult = {
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      visible: true,
      backgroundColor: 'rgb(0,0,0)',
      color: 'rgb(255,255,255)',
      fontSize: '14px',
      borderWidth: '1px',
      opacity: '1',
      display: 'block',
      overflow: 'visible',
      textOverflow: false,
      textContent: 'test',
      childCount: 0,
    }
    expect(sample.visible).toBe(true)
  })
})
