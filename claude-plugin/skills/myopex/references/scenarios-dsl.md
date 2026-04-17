# scenarios DSL reference

`myopex.scenarios.ts` default-exports a `Scenario[]`. Each scenario describes one UI state: how to reach it, and how long to wait before capturing.

## Read this first — the #1 selector gotcha

The selector string in every step is a **Playwright selector**, not a pure CSS selector. The difference matters for one specific mistake that eats hours:

```ts
// ✗ Does not work — `:text("…")` looks like a CSS pseudo-class but isn't one.
//   It's not valid CSS, not valid Playwright syntax, and won't match anything.
{ click: '.material-symbols-outlined:text("science")' }

// ✓ Valid alternatives:
{ click: 'text=science' }                                   // Playwright text engine
{ click: '.material-symbols-outlined:has-text("science")' } // CSS + :has-text()
{ click: '[data-testid=btn-seed]' }                         // the one you actually want
```

If a step click does nothing and you get `0 components` or an unchanged state, this is the first thing to check. The full selector-flavor list is below.

## Scenario shape

```ts
import type { Scenario } from 'myopex'

const scenarios: Scenario[] = [
  {
    name: string,               // required — used as output directory name and fingerprint filename
    description?: string,       // optional — for human readers
    url?: string,               // override the CLI --url for this scenario
    steps?: Step[],             // declarative action list
    setup?: (page) => Promise<void>,  // raw Playwright escape hatch
    settleMs?: number,          // override default settle timeout (default ~4000ms)
  },
]
export default scenarios
```

## Timeouts

Action steps (`click`, `fill`, `waitFor`, `hover`, `select`) use a 5-second default timeout per step — short enough that a mistyped selector or a removed testid fails the scenario in seconds rather than waiting out Playwright's 30-second default. If a specific scenario legitimately needs longer (e.g., waiting for a slow-loading async panel), use `{ wait: N }` for an explicit pause or escape into `setup` with an explicit `page.waitForSelector(sel, { timeout: 15_000 })`. The per-scenario `settleMs` option controls the post-load network-idle wait, which is separate from action timeouts.

## Execution order (per scenario)

1. Navigate to `scenario.url`, or fall back to the CLI `--url` if omitted
2. Smart settle — wait for `networkidle` up to `settleMs`, then a 200ms tail
3. Run `steps` in order
4. Run `setup(page)` if present
5. If `steps` or `setup` ran, brief 300ms settle for animations
6. Capture fingerprint + per-region and per-component screenshots

Steps always run before setup. Scenarios don't share state — each gets a fresh page.

## Selector strings — which flavors work

The selector string in every step is passed straight through to Playwright's locator engine, so every Playwright selector syntax is valid:

- **CSS** — `[data-testid=foo]`, `button.primary`, `form input[name=q]` (the default; most common)
- **Text** — `text=Submit`, `text=/error/i` (Playwright text engine — matches visible text)
- **Role** — `role=button[name="Submit"]` (ARIA role + accessible name)
- **Chained** — `[data-testid=modal] >> button.primary` (descendant within another match)
- **Has-text** — `button:has-text("Submit")` (CSS + text, combined)
- **XPath** — `xpath=//button[@id="submit"]` (escape hatch)

Prefer `data-testid` CSS selectors for interactive elements — they're stable across CSS-module hash changes, i18n text changes, and ARIA label revisions. Use `text=` and `role=` only when you can't add a testid to the element.

See the Playwright selectors guide for more: https://playwright.dev/docs/other-locators

## Step types (declarative DSL)

| Step | Example | Behavior |
|---|---|---|
| `click` | `{ click: '[data-testid=open]' }` | `page.click(selector)` |
| `fill` | `{ fill: 'input[name=q]', value: 'foo' }` | `page.fill(selector, value)` — clears then types |
| `press` | `{ press: 'input[name=q]', key: 'Enter' }` | `page.press(selector, key)` — Playwright key names |
| `hover` | `{ hover: '.tooltip-trigger' }` | `page.hover(selector)` |
| `select` | `{ select: 'select[name=x]', value: 'option-1' }` | `page.selectOption(selector, value)` |
| `waitFor` | `{ waitFor: '.loaded' }` | `page.waitForSelector(selector)` |
| `wait` | `{ wait: 300 }` | `page.waitForTimeout(ms)` — use sparingly, prefer `waitFor` |
| `goto` | `{ goto: 'http://localhost:5173/foo' }` | `page.goto(url)` mid-flow |
| `evaluate` | `{ evaluate: 'localStorage.clear()' }` | Runs arbitrary JS in page context |
| `setLocalStorage` | `{ setLocalStorage: { token: 'abc', theme: 'dark' } }` | Shortcut for `localStorage.setItem` calls |

## When to use `setup` instead of `steps`

Use `setup: async (page) => { ... }` for anything the step DSL can't express cleanly:

- Route mocking / API stubbing: `await page.route('**/api/**', r => r.fulfill({...}))`
- Conditional logic based on runtime values
- Waiting on a custom readiness signal: `await page.waitForFunction(() => window.userLoaded === true)`
- Multi-step drag-and-drop or canvas interactions
- Intercepting network requests

## Useful patterns

**Authenticated state (token-based auth):**
```ts
{ name: 'dashboard-authed',
  steps: [
    { setLocalStorage: { authToken: 'test-token-123' } },
    { goto: 'http://localhost:5173/dashboard' },
  ],
}
```

**API error state:**
```ts
{ name: 'api-error',
  setup: async (page) => {
    await page.route('**/api/**', r => r.abort())
    await page.reload()
  },
}
```

**Slow-loading page:**
```ts
{ name: 'heavy-dashboard',
  setup: async (page) => {
    await page.waitForFunction(() => window.userLoaded === true)
  },
  settleMs: 6000,
}
```

**Form error via steps:**
```ts
{ name: 'login-error',
  steps: [
    { fill: 'input[name=email]', value: 'broken@test.com' },
    { fill: 'input[name=password]', value: 'wrong' },
    { click: 'button[type=submit]' },
    { waitFor: '.error-message' },
  ],
}
```

**Drawer open with hover-revealed menu:**
```ts
{ name: 'drawer-menu-open',
  steps: [
    { click: '[data-testid=menu-button]' },
    { waitFor: '.drawer.open' },
    { hover: '[data-testid=profile-avatar]' },
    { waitFor: '.profile-menu' },
  ],
}
```

**Mixing `steps` and `setup` (ordering matters):**

`steps` run before `setup`, and both run before capture. Use `steps` for the setup you can describe declaratively, then escape into `setup` for the part that needs Playwright's full API. Useful when a declarative click reveals a panel, and you need raw Playwright to interact with what's now inside it.

```ts
{ name: 'terminal-with-command',
  steps: [
    // 1. seed some data and open the terminal — declarative is perfect here
    { click: '[data-testid=btn-seed]' },
    { wait: 400 },
    { click: '[data-testid=btn-terminal]' },
    { waitFor: 'input[data-testid=terminal-input]' },
  ],
  setup: async (page) => {
    // 2. now that the terminal is open, type a command and submit
    //    — fill + press + wait is cleaner as raw Playwright
    const input = page.locator('input[data-testid=terminal-input]')
    await input.fill('status')
    await input.press('Enter')
    await page.waitForSelector('.terminal-output', { timeout: 2000 })
  },
}
```

Rule of thumb: if `setup` needs to target something that only exists *after* the steps run, the ordering is correct. If `setup` has to re-open or re-navigate to undo what `steps` did, you wrote them in the wrong order — invert.

**Light-mode variant of an existing scenario:**
```ts
{ name: 'home-light',
  setup: async (page) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.reload()
  },
}
```
(Scenarios default to `colorScheme: 'dark'`.)

**Icon-only button (Material Symbols / Lucide / Heroicons):**
```ts
// Won't work reliably — the icon glyph has no accessible name,
// and CSS content like `.material-symbols-outlined:text("memory")` is NOT
// a Playwright selector (text() matches DOM text, not computed :content).
{ click: '.material-symbols-outlined:has-text("memory")' }    // ✗ may match the glyph element but component extraction still can't see it

// Correct — add a data-testid (or aria-label) to the button itself, then:
{ click: '[data-testid=btn-memory]' }                          // ✓
// or, if the parent button has an aria-label:
{ click: 'role=button[name="Memory usage"]' }                  // ✓
```

The rule: add the handle to the interactive element (the `<button>`/`<a>`), not to the icon glyph inside it. Myopex's component extractor looks at the AX tree; an unnamed button is effectively invisible even if you can click it.

## Common mistakes

- **Brittle selectors.** `.css-xY12Z` and `#root > div:nth-child(3)` break on every build. Use `data-testid`, stable ARIA names, or semantic tags.
- **Missing `waitFor` after async actions.** Capture runs immediately after `steps` + a 300ms tail; if the real UI takes longer, you'll capture a half-rendered state.
- **Over-using `wait: ms`.** Prefer waiting on a selector or a condition. Millisecond sleeps are flaky on slower machines.
- **Scenario name collisions.** Names become directory names; two `home` scenarios overwrite each other.
- **Writing scenarios for states that don't exist.** Read the app's routes and component tree first. A scenario for `settings-modal` fails silently if the app has no settings modal yet.
- **Hardcoding the URL in every scenario.** Leave `url` off and use the CLI `--url` so the same config works across dev/staging/preview.
- **Icon-only buttons without a handle.** If your click target is a `<button>` containing only an icon glyph (Material Symbols, SVG, emoji), a selector that matches the glyph element isn't enough — myopex's component extraction can still see the surrounding button as unnamed and report `0 components` in that region. Fix by adding `data-testid` or `aria-label` to the button itself, then select on that.
- **Using `page.click()`-style locator syntax like `.class:text("…")` literally.** That's Playwright locator method syntax, not a selector string — it doesn't work when passed directly as a CSS-style selector. Use `:has-text("…")`, `text=…`, or (better) a `data-testid`.
