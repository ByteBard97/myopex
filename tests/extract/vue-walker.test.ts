import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { buildVueTree } from '../../src/extract/vue-walker'
import type { VueComponentNode } from '../../src/fingerprint/types'

let browser: Browser
let page: Page
let outDir: string
let vueTree: VueComponentNode[] | null

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`file://${join(__dirname, '../fixtures/vue-app.html')}`)
  // Wait for Vue CDN to load and mount
  await page.waitForFunction(() => !!(document.querySelector('#app') as any)?.__vue_app__, { timeout: 15000 })
  outDir = mkdtempSync(join(tmpdir(), 'myopex-vue-test-'))
  vueTree = await buildVueTree(page, outDir)
}, 30000)

afterAll(async () => {
  await browser.close()
})

// ---- helpers ----
function collectNames(nodes: VueComponentNode[]): string[] {
  const names: string[] = []
  for (const n of nodes) {
    names.push(n.name)
    names.push(...collectNames(n.children))
  }
  return names
}

function collectByName(nodes: VueComponentNode[], name: string): VueComponentNode[] {
  const result: VueComponentNode[] = []
  for (const n of nodes) {
    if (n.name === name) result.push(n)
    result.push(...collectByName(n.children, name))
  }
  return result
}

function collectAll(nodes: VueComponentNode[]): VueComponentNode[] {
  const result: VueComponentNode[] = []
  for (const n of nodes) {
    result.push(n)
    result.push(...collectAll(n.children))
  }
  return result
}

// ---- non-Vue detection ----
describe('isVueApp detection', () => {
  it('returns null on a non-Vue page', async () => {
    const emptyPage = await browser.newPage()
    await emptyPage.setContent('<html><body><p>No Vue here</p></body></html>')
    const tmpOut = mkdtempSync(join(tmpdir(), 'myopex-novue-'))
    const result = await buildVueTree(emptyPage, tmpOut)
    expect(result).toBeNull()
    await emptyPage.close()
  }, 15000)
})

// ---- tree structure ----
describe('component tree', () => {
  it('returns non-null tree for Vue app', () => {
    expect(vueTree).not.toBeNull()
    expect(vueTree!.length).toBeGreaterThan(0)
  })

  it('includes PlantList and PlantCard by name', () => {
    const names = collectNames(vueTree!)
    expect(names).toContain('PlantList')
    expect(names).toContain('PlantCard')
  })

  it('PlantCard appears twice with distinct uids', () => {
    const cards = collectByName(vueTree!, 'PlantCard')
    expect(cards).toHaveLength(2)
    expect(cards[0].uid).not.toBe(cards[1].uid)
  })

  it('PlantCard bounds are non-zero', () => {
    const cards = collectByName(vueTree!, 'PlantCard')
    for (const card of cards) {
      expect(card.bounds.width).toBeGreaterThan(0)
      expect(card.bounds.height).toBeGreaterThan(0)
    }
  })

  it('PlantCard props include plantId and label', () => {
    const cards = collectByName(vueTree!, 'PlantCard')
    expect(cards[0].props).toHaveProperty('plantId')
    expect(cards[0].props).toHaveProperty('label')
  })

  it('descendantComponentCount is correct for PlantList', () => {
    const list = collectByName(vueTree!, 'PlantList')[0]
    // PlantList has 2 PlantCard descendants
    expect(list.descendantComponentCount).toBe(2)
  })
})

// ---- depth truncation ----
describe('depth limit', () => {
  it('respects maxDepth=1 by truncating PlantList children', async () => {
    const depthOutDir = mkdtempSync(join(tmpdir(), 'myopex-depth-'))
    const shallowTree = await buildVueTree(page, depthOutDir, 1)
    expect(shallowTree).not.toBeNull()
    const list = collectByName(shallowTree!, 'PlantList')[0]
    expect(list).toBeDefined()
    expect(list.children).toHaveLength(0)
    expect(list.childrenTruncated).toBe(true)
    expect(list.truncatedChildCount).toBe(2)
  }, 15000)
})

// ---- screenshots ----
describe('screenshot crops', () => {
  it('writes screenshotFile paths for components with bounds', () => {
    const allNodes = collectAll(vueTree!)
    const withScreenshots = allNodes.filter(n => n.screenshotFile)
    expect(withScreenshots.length).toBeGreaterThan(0)
  })

  it('screenshot files exist on disk', async () => {
    const { existsSync } = await import('fs')
    const allNodes = collectAll(vueTree!)
    for (const n of allNodes.filter(n => n.screenshotFile)) {
      expect(existsSync(join(outDir, n.screenshotFile!))).toBe(true)
    }
  })

  it('screenshot filenames follow vue-<Name>-<uid>.png convention', () => {
    const allNodes = collectAll(vueTree!)
    for (const n of allNodes.filter(n => n.screenshotFile)) {
      expect(n.screenshotFile).toMatch(/^screenshots\/vue-.+?-\d+\.png$/)
    }
  })
})

// ---- sidecar JSON ----
describe('vue-detail.json sidecar', () => {
  it('writes vue-detail.json to outDir', async () => {
    const { existsSync } = await import('fs')
    expect(existsSync(join(outDir, 'vue-detail.json'))).toBe(true)
  })

  it('sidecar has capturedAt and components map', async () => {
    const { readFileSync } = await import('fs')
    const sidecar = JSON.parse(readFileSync(join(outDir, 'vue-detail.json'), 'utf-8'))
    expect(typeof sidecar.capturedAt).toBe('string')
    expect(typeof sidecar.components).toBe('object')
  })

  it('sidecar contains entries for all named components', async () => {
    const { readFileSync } = await import('fs')
    const sidecar = JSON.parse(readFileSync(join(outDir, 'vue-detail.json'), 'utf-8'))
    const uids = Object.keys(sidecar.components).map(Number)
    expect(uids.length).toBeGreaterThan(0)
  })

  it('sidecar entries include props and setupState', async () => {
    const { readFileSync } = await import('fs')
    const sidecar = JSON.parse(readFileSync(join(outDir, 'vue-detail.json'), 'utf-8'))
    const entries = Object.values(sidecar.components) as any[]
    for (const entry of entries) {
      expect(typeof entry.props).toBe('object')
      expect(typeof entry.setupState).toBe('object')
      expect(Array.isArray(entry.childUids)).toBe(true)
    }
  })
})
