export const EXACT_COMPARE_PROPS = [
  'visible', 'backgroundColor', 'display', 'textOverflow',
] as const

export const NUMERIC_TOLERANCES: Record<string, number> = {
  width: 50,
  height: 30,
  x: 100,
  y: 100,
}

export const INVARIANTS = [
  { prop: 'visible', check: (v: unknown) => v === false, msg: 'element is not visible' },
  { prop: 'backgroundColor', check: (v: unknown, role?: string) => v === 'rgba(0, 0, 0, 0)' && role !== 'none', msg: 'transparent background — theme not applied?' },
  { prop: 'textOverflow', check: (v: unknown) => v === true, msg: 'text is overflowing / truncated' },
  { prop: 'bounds.width', check: (v: unknown) => (v as number) === 0, msg: 'zero width' },
  { prop: 'bounds.height', check: (v: unknown) => (v as number) === 0, msg: 'zero height' },
] as const

export const DEFAULT_VIEWPORT = { width: 1440, height: 900 }
export const SETTLE_MS = 4000
export const AUTO_SERVER_PORT = 5198

/**
 * Framework-specific selectors auto-discovered as regions when present.
 * Handles cases where ARIA landmarks and semantic HTML are absent
 * (e.g., VueFlow canvas, React Flow, Konva).
 */
export const FRAMEWORK_SELECTORS: Array<{ selector: string; role: string; name: string }> = [
  { selector: '.vue-flow', role: 'main-canvas', name: 'Canvas' },
  { selector: '.vue-flow__controls', role: 'toolbar', name: 'Canvas Controls' },
  { selector: '[data-canvas]', role: 'main-canvas', name: 'Canvas' },
]
