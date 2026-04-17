// myopex.scenarios.ts
//
// Starter template. Copy this to your project root, then adapt each
// entry to match your app's actual routes, selectors, and UI states.
// Delete entries that don't apply; add ones that do.
//
// Run:
//   npx myopex scenarios --config myopex.scenarios.ts --out .myopex-baseline
//
// Three ways to describe a state — use whichever fits:
//   1. url     — route or query-param states, zero code
//   2. steps   — declarative click / fill / waitFor list, no Playwright knowledge
//   3. setup   — raw Playwright Page access, for route mocking or complex flows
//
// Steps run before setup. Both run before capture.

import type { Scenario } from 'myopex'

const scenarios: Scenario[] = [
  // ── Default page load ─────────────────────────────────────────────────
  { name: 'home' },

  // ── Route / query-param states (no code) ──────────────────────────────
  // { name: 'settings-modal', url: 'http://localhost:5173/?modal=settings' },
  // { name: 'admin-dashboard', url: 'http://localhost:5173/admin' },

  // ── Declarative interaction states ────────────────────────────────────
  // {
  //   name: 'drawer-open',
  //   steps: [
  //     { click: '[data-testid=menu-button]' },
  //     { waitFor: '.drawer.open' },
  //   ],
  // },
  //
  // {
  //   name: 'login-error',
  //   steps: [
  //     { fill: 'input[name=email]', value: 'broken@test.com' },
  //     { fill: 'input[name=password]', value: 'wrong' },
  //     { click: 'button[type=submit]' },
  //     { waitFor: '.error-message' },
  //   ],
  // },
  //
  // {
  //   name: 'tooltip-visible',
  //   steps: [
  //     { hover: '[data-testid=help-icon]' },
  //     { wait: 200 },
  //   ],
  // },

  // ── Storage-driven states ─────────────────────────────────────────────
  // {
  //   name: 'empty',
  //   steps: [
  //     { evaluate: 'localStorage.clear()' },
  //     { goto: 'http://localhost:5173' },
  //   ],
  // },
  //
  // {
  //   name: 'authenticated',
  //   steps: [
  //     { setLocalStorage: { authToken: 'test-token-123' } },
  //     { goto: 'http://localhost:5173/dashboard' },
  //   ],
  // },

  // ── API error state (needs raw setup) ─────────────────────────────────
  // {
  //   name: 'api-error',
  //   setup: async (page) => {
  //     await page.route('**/api/**', (route) => route.abort())
  //     await page.reload()
  //   },
  // },

  // ── Slow page (needs a longer settle) ─────────────────────────────────
  // {
  //   name: 'heavy-dashboard',
  //   steps: [
  //     { setLocalStorage: { authToken: 'test-token-123' } },
  //     { goto: 'http://localhost:5173/dashboard' },
  //   ],
  //   setup: async (page) => {
  //     await page.waitForFunction(() => (window as any).userLoaded === true)
  //   },
  //   settleMs: 6000,
  // },
]

export default scenarios
