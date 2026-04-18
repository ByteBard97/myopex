// src/extract/vue-walker.ts
import type { Page } from 'playwright'
import type { VueComponentNode } from '../fingerprint/types'

export async function buildVueTree(
  page: Page,
  outDir: string,
  maxDepth = 3,
): Promise<VueComponentNode[] | null> {
  const hasVue = await isVueApp(page)
  if (!hasVue) return null
  return null // placeholder — full implementation in Task 4
}

async function isVueApp(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el =
      (document.querySelector('[data-v-app]') as any) ??
      (document.querySelector('#app') as any)
    return !!(el && el.__vue_app__)
  })
}
