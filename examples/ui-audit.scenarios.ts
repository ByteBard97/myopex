// examples/ui-audit.scenarios.ts
//
// This is a reference scenario config. Copy it to your project root as
// `ui-audit.scenarios.ts`, adapt the states to your app, then run:
//
//   npx ui-audit scenarios --url http://localhost:5173 --config ui-audit.scenarios.ts
//
// Three ways to describe a UI state — use whichever fits the case:
//
//   1. URL-based    — `url: '...'`       — zero code, for route/query-param states
//   2. Declarative  — `steps: [...]`     — action list, no Playwright knowledge needed
//   3. Raw setup    — `setup: (page)...` — full Playwright access, for edge cases
//
// You can mix all three in a single scenario. Steps run before setup.

import type { Scenario } from '../src/scenarios'

const scenarios: Scenario[] = [
  // ─── 1. URL-based state (simplest) ──────────────────────────────────────
  // Just the default page load. No url override → uses the CLI --url.
  {
    name: 'home',
  },

  // App already supports route-based states? Point at the URL.
  {
    name: 'settings-modal',
    url: 'http://localhost:5173/?modal=settings',
  },

  // ─── 2. Declarative steps (vibe-coder friendly) ─────────────────────────
  // Open the drawer by clicking the menu button.
  {
    name: 'drawer-open',
    steps: [
      { click: '[data-testid=menu-button]' },
      { waitFor: '.drawer.open' },
    ],
  },

  // Fill out a form and capture the error state.
  {
    name: 'login-error',
    steps: [
      { fill: 'input[name=email]', value: 'broken@test.com' },
      { fill: 'input[name=password]', value: 'wrong' },
      { click: 'button[type=submit]' },
      { waitFor: '.error-message' },
    ],
  },

  // Clear localStorage and reload to capture the empty state.
  {
    name: 'empty',
    steps: [
      { evaluate: 'localStorage.clear()' },
      { goto: 'http://localhost:5173' },
    ],
  },

  // Hover a tooltip trigger.
  {
    name: 'tooltip-visible',
    steps: [
      { hover: '[data-testid=help-icon]' },
      { wait: 200 }, // tooltip delay
    ],
  },

  // ─── 3. Raw Playwright setup (power mode) ───────────────────────────────
  // For anything the declarative DSL can't express. The setup function
  // receives the Playwright Page object directly.
  //
  // Typical uses:
  //   - Route mocking / API stubbing
  //   - Conditional logic
  //   - Complex DOM inspection before capture
  {
    name: 'api-error',
    setup: async (page) => {
      // Mock all API calls to fail
      await page.route('**/api/**', (route) => route.abort())
      await page.reload()
    },
  },

  // ─── Mixed: steps + setup ──────────────────────────────────────────────
  // Steps run first, then the setup function. Use this when you want most
  // of the flow to be declarative but need one bit of Playwright power.
  {
    name: 'authenticated-dashboard',
    steps: [
      { setLocalStorage: { authToken: 'test-token-123' } },
      { goto: 'http://localhost:5173/dashboard' },
    ],
    setup: async (page) => {
      // Wait for async user data to load before capturing
      await page.waitForFunction(() => (window as unknown as { userLoaded?: boolean }).userLoaded === true)
    },
    settleMs: 6000, // This page is slow — give it more time
  },
]

export default scenarios
