# Closing the loop on AI-generated UI

**The root cause is simple: your AI agent had no representation of the assembled product.** It processed 45 tickets as isolated units, and your test suite — 390 unit tests, 22 E2E tests, clean type-checks — verified each piece in isolation. No check ever asked "does the whole thing look right?" This is a **product-intent verification gap**, not a testing gap, and it requires a fundamentally different layer of defense: static reachability analysis to catch unwired code, visual regression to catch layout failures, and an explicit product specification that the agent verifies against. The good news is that a 2-person team can close this gap in under a week with free, open-source tools already compatible with your Vue 3 + Vite + Playwright stack.

---

## The five things to implement this week

Before diving into the full analysis, here are the highest-leverage actions ranked by impact-to-effort ratio. Each directly addresses the failure mode where components exist but never render in the running application.

1. **Knip with Vue compiler override** — run `npx knip --production` in CI to flag every `.vue` file unreachable from `main.ts`. This single tool would have caught all four missing shell components (header, sidebar, status bar, settings) as "unused files." Setup: **2–4 hours**, cost: **free**.

2. **Playwright app-shell smoke test** — a 20-line test that navigates to `/` and asserts `toBeVisible()` on `[data-testid="app-header"]`, `[data-testid="app-sidebar"]`, `[data-testid="status-bar"]`, then screenshots the page with `toHaveScreenshot()`. This is the only check that verifies the rendered product. Setup: **1–2 hours**, cost: **free**.

3. **dependency-cruiser reachability rule** — configure a `reachable: false` rule from `src/main.ts` that fails CI when any production `.vue` file is unreachable from the entry point. Complementary to Knip and catches different edge cases. Setup: **2–3 hours**, cost: **free**.

4. **PRODUCT.md as verification artifact** — create a markdown file listing every UI region, route, and protected behavior the product must exhibit. Reference it in `CLAUDE.md` so Claude Code checks its work against product intent, not just ticket acceptance criteria. Setup: **2 hours**, cost: **free**.

5. **Playwright MCP + `/verify-ui` custom command** — give Claude Code "eyes" by installing the Playwright MCP server (`claude mcp add playwright npx @playwright/mcp@latest`) and creating a custom command that launches the dev server, navigates pages, takes screenshots, and evaluates them against the product description. Setup: **2–4 hours**, cost: **~$10–20/month in tokens**.

---

## Why standard test suites miss product-level bugs

The failure described is not a testing bug — it's an **architectural composition gap**. Understanding why requires examining what each layer of the existing test suite actually verifies.

**Unit tests (Vitest, 390 tests)** verify that individual functions, composables, and component logic produce correct outputs given correct inputs. They mount components in isolation via `@vue/test-utils` and never render the full application tree. A `<AppHeader>` component passing all its unit tests proves the header *works* — not that it *appears* in the app. Unit tests are scoped to the module boundary by design.

**E2E tests (Playwright, 22 tests)** verify user journeys through the running application. But here's the critical failure: **E2E tests only verify what they explicitly assert against.** If no E2E test ever asserted that the sidebar is visible on the home page, the sidebar's absence is invisible to the suite. The 22 tests likely tested feature-specific flows (login, data entry, settings toggle) where each feature worked correctly in its route — the tests just never checked the *shell* around those features.

**TypeScript type-checking (vue-tsc)** verifies that types are consistent across the codebase. An unused import is not a type error. A component that is correctly typed but never imported into `App.vue` passes type-checking with flying colors.

**Linting (oxlint + eslint)** catches per-file issues. The `vue/no-unused-components` rule only flags components imported *within a single SFC* but never used in that SFC's template. It cannot detect that `AppHeader.vue` exists in `src/components/` but is never imported into `App.vue` — that's a cross-file reachability problem, not a per-file lint issue.

The gap exists because **no tool in the standard pipeline checks the composition of the whole product**. Each tool operates at a different granularity (function, file, route, type) but none asks: "Starting from `main.ts`, can every production component be reached?" This is the exact gap that static reachability analysis and visual smoke testing fill.

---

## Ranked recommendations

| Approach | Catches "exists but not wired" | Effort | Cost | OSS/SaaS | Claude Code compatible | Recommended? |
|---|---|---|---|---|---|---|
| **Knip (production mode)** | ✅ Flags unreachable files from entry | Low, ~3h | Free | OSS | Yes (CI) | **Yes** |
| **dependency-cruiser reachability** | ✅ Flags modules unreachable from main.ts | Low, ~2h | Free | OSS | Yes (CI) | **Yes** |
| **Playwright shell smoke test** | ✅ Verifies rendered UI structure | Low, ~2h | Free | OSS | Yes (CI + MCP) | **Yes** |
| **PRODUCT.md + CLAUDE.md** | ✅ Agent self-checks against product spec | Low, ~2h | Free | N/A | Native | **Yes** |
| **Playwright MCP + /verify-ui** | ✅ Agent takes screenshots and evaluates | Med, ~4h | ~$15/mo | OSS | Native | **Yes** |
| **Playwright toHaveScreenshot()** | ✅ Pixel-diff catches missing layouts | Low, ~2h | Free | OSS | Yes (CI) | **Yes** |
| **Argos CI** | ✅ Visual regression + ARIA snapshots | Med, ~3h | $0–100/mo | SaaS | Yes (CI) | **Yes** |
| **Lost Pixel** | ✅ Visual regression, best free tier | Med, ~3h | $0–100/mo | OSS+SaaS | Yes (CI) | Maybe |
| **Chromatic** | ✅ Visual regression, Storybook-native | Med, ~4h | $0–179/mo | SaaS | Yes (CI) | Maybe |
| **Builder-verifier subagent** | ✅ Separate agent reviews against spec | Med, ~4h | ~$20/mo tokens | N/A | Native | **Yes** |
| **vue-unused** | ✅ Purpose-built Vue dead file detection | Low, ~1h | Free | OSS | Yes (CI) | Maybe |
| **Meticulous.ai** | ✅ Record V1 journeys, replay on V2 | Med, ~4h | Free tier→paid | SaaS | Yes (CI) | Maybe |
| **Percy** | ✅ AI-powered visual diff | Med, ~4h | $0–199/mo | SaaS | Yes (CI) | Maybe |
| **BackstopJS** | ✅ Screenshot comparison, bulk routes | Med, ~3h | Free | OSS | Yes (CI) | Maybe |
| **Applitools Eyes** | ✅ Best structural detection (Layout mode) | Med, ~4h | $399+/mo | SaaS | Yes (CI) | **No** (cost) |
| **CrewAI/LangGraph** | Indirect — framework overhead | High, ~16h | Free | OSS | No (external) | **No** |
| **Browser-use agents (CUA/Operator)** | Partial — exploratory only | High, ~8h | $0.15/page | SaaS | Partial | **No** |
| **Healenium** | ❌ Selector healing only, Java/Selenium | High | Free | OSS | No | **No** |

---

## Component dead-code and "exists but not wired" detection

This is the most directly actionable defense layer. The core insight: **static analysis can prove that a component is unreachable from the application entry point without ever running the app.**

### Knip is the single best tool for this problem

Knip builds a complete module graph from your entry points and reports any file that cannot be reached. It is the actively maintained successor to both `ts-prune` (deprecated) and `unimported` (archived March 2024) — the authors of both tools now recommend Knip. For Vue 3 projects, you must override the default compiler with `@vue/compiler-sfc` to properly parse `<script setup>` blocks:

```typescript
// knip.ts
import { parse } from 'vue/compiler-sfc'
import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  entry: ['src/main.ts', 'src/router/index.ts'],
  project: ['src/**/*.{ts,vue}'],
  compilers: {
    vue: (text: string) => {
      const { descriptor } = parse(text)
      return descriptor.scriptSetup?.content || descriptor.script?.content || ''
    },
  },
  ignore: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
}
export default config
```

Running `npx knip --production` would have flagged `AppHeader.vue`, `AppSidebar.vue`, `StatusBar.vue`, and `SettingsPanel.vue` as unused files — the exact components that were ported but never wired in. The `--production` flag is critical: it ignores test files, catching components that are only imported in tests but missing from production code.

**What Knip misses**: dynamically registered global components (`app.component('MyComp', ...)`), runtime dynamic imports with variable paths, and components registered via Vue plugins. These edge cases are rare in typical Vue 3 projects using `<script setup>`.

### dependency-cruiser adds reachability rules

Where Knip reports unused files, dependency-cruiser lets you write explicit rules about module reachability. The key configuration for this scenario:

```javascript
// .dependency-cruiser.cjs
module.exports = {
  forbidden: [{
    name: 'no-unreachable-from-main',
    severity: 'error',
    comment: 'Production modules must be reachable from main.ts',
    from: { path: 'src/main\\.ts$' },
    to: {
      path: 'src',
      pathNot: ['\\.spec\\.ts$', '\\.test\\.ts$', '__tests__', '\\.d\\.ts$'],
      reachable: false
    }
  }]
}
```

This rule says: starting from `src/main.ts`, every production file in `src/` must be reachable through the import graph. Any `.vue` file not reachable triggers a CI failure. dependency-cruiser has native Vue 3 SFC support via `@vue/compiler-sfc` and generates visual dependency graphs (`--output-type dot`) that are invaluable for understanding your component tree.

### Tools to avoid

**madge** does not support `.vue` SFC files — a long-standing issue (#122 with 42+ thumbs-ups) that has never been resolved. It shows `.vue` files as having zero dependencies, making it useless for Vue projects. **unimported** was archived in March 2024. **ts-prune** is in maintenance mode and only works on `.ts` files, not `.vue` SFCs. All three tools' authors now point to Knip.

### The CI pipeline that catches this bug

```yaml
name: Component Wiring Checks
on: [push, pull_request]
jobs:
  wiring:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'npm' }
      - run: npm ci
      - name: Knip — flag unreachable production files
        run: npx knip --production
      - name: dependency-cruiser — verify reachability from main.ts
        run: npx depcruise src --include-only "^src" --validate
      - name: Smoke test — verify shell renders
        run: |
          npx vite build && npx vite preview &
          sleep 3
          npx playwright test tests/smoke/app-shell.spec.ts
```

---

## Visual regression testing for structural verification

Any pixel-comparison tool will catch "the entire UI shell is missing" because the visual difference is enormous — you don't need AI-powered diffing for this. The question is which tool gives the best workflow for a 2-person team.

### Start with Playwright's built-in toHaveScreenshot()

This is already in your stack, costs nothing, and takes under an hour to add:

```typescript
// tests/smoke/app-shell.spec.ts
import { test, expect } from '@playwright/test'

test('app shell renders complete layout', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  
  // Structural assertions (fast, deterministic)
  await expect(page.locator('[data-testid="app-header"]')).toBeVisible()
  await expect(page.locator('[data-testid="app-sidebar"]')).toBeVisible()
  await expect(page.locator('[data-testid="status-bar"]')).toBeVisible()
  
  // Visual regression (catches layout/styling issues)
  await expect(page).toHaveScreenshot('app-shell-desktop.png', {
    maxDiffPixelRatio: 0.01,
    fullPage: true,
  })
})
```

**Limitations are real but manageable.** Cross-platform font rendering differences cause false positives — solve this by running in Docker (`mcr.microsoft.com/playwright`) for consistent screenshots. Dynamic content (timestamps, avatars) needs masking via the `mask` parameter. There's no review dashboard — failures produce three images (expected/actual/diff) that you inspect manually. For a 2-person team, this is fine. For larger teams, you'd want a review workflow.

### When to add a visual regression platform

If you find yourself spending more than 30 minutes per week managing screenshot baselines and reviewing diffs, upgrade to a platform. **Argos CI** offers the best value: **$0 on the Hobby plan** (5,000 screenshots), deterministic pixel diffing, first-class Playwright integration, and — critically — **ARIA snapshot testing** that compares accessibility tree structure beyond just pixels. This structural layer catches cases where a component renders but is semantically wrong (wrong heading levels, missing landmarks). Setup is three steps: install `@argos-ci/playwright`, replace `toHaveScreenshot()` with `argosScreenshot()`, add the GitHub Action.

**Chromatic** ($0–179/mo) is the right choice if you adopt Storybook — it captures full DOM archives rather than screenshots, making diffs debuggable with browser devtools. **Lost Pixel** has the most generous free tier at **7,000 screenshots/month** and can be fully self-hosted. **Percy** ($0–199/mo) adds AI-powered change detection that reduces false positives from dynamic content.

**Applitools Eyes** has the best structural detection technology — its Layout match mode validates element positioning regardless of content, which is precisely what catches missing shell components. But at **$399+/month** with opaque enterprise pricing, it's prohibitively expensive for a 2-person team. Every other tool catches "entire shell is missing" just fine through basic pixel comparison.

---

## Screenshot-driven AI agent feedback loops

The pattern of "agent writes code → takes screenshot → evaluates → iterates" is now mainstream in production teams. The VS Code team ships weekly using screenshot feedback loops in their agent workflow. Juri Strumpflohner (Nx) published a complete Electron workflow where Claude Code connects to a running app, takes screenshots, evaluates them multimodally, and self-corrects. This is the most direct way to close the product-intent gap.

### Playwright MCP gives Claude Code eyes

Setup takes one command:

```bash
claude mcp add playwright npx @playwright/mcp@latest
```

This gives Claude Code access to 34 browser-control tools including `browser_navigate`, `browser_take_screenshot`, and `browser_snapshot` (accessibility tree). The accessibility snapshot is particularly powerful — it's text-based (cheap in tokens) and reveals structural information that screenshots can't convey. **A critical nuance**: the MCP server uses the accessibility tree by default for interactions, not screenshots, making it significantly more token-efficient than pure vision approaches.

### The verification command pattern

Create `.claude/commands/verify-ui.md`:

```markdown
# Verify UI against product intent
1. Start dev server if not running: `npm run dev &`
2. Wait for server readiness
3. Navigate to $ARGUMENTS (or / if not specified)
4. Take accessibility snapshot — verify all expected landmarks present
5. Take screenshot at 1280x800
6. Compare against PRODUCT.md requirements for this route
7. List discrepancies between rendered UI and product specification
8. If issues found: fix, re-verify, repeat until passing
9. Run `npx playwright test tests/smoke/` to confirm no regressions
```

### What multimodal evaluation catches and misses

Multimodal LLMs are **effective** at detecting blank pages, missing major sections, broken layouts, and wrong visual hierarchy. They are **unreliable** at detecting sub-pixel shifts, subtle spacing issues, minor color differences, and alignment problems. The WebDevJudge benchmark found that **code is more critical than screenshots** for evaluating web development quality — combined modalities (code + screenshot) yield the best results.

**Cost is negligible.** A typical screenshot consumes ~1,600 tokens with Claude Sonnet. At $3/MTok input, that's **$0.005 per screenshot evaluation**. Running 50 evaluations per day costs roughly $0.25/day or about **$8/month**. Token0 (an open-source proxy) claims 70–99% additional savings by downscaling images and optimizing formats.

### The hybrid approach works best

Use **Playwright's deterministic pixel comparison** (`toHaveScreenshot()`) for regression detection and **LLM evaluation** for intent verification. The pixel-diff catches subtle visual changes the LLM misses; the LLM catches semantic issues ("this button says 'Submit' but the spec says 'Save'") that pixel-diff doesn't understand. Together they provide comprehensive coverage.

---

## Multi-agent verification and the product-intent gap

The most important finding from this research: **the core problem is not insufficient testing — it's missing product context.** An AI agent processing tickets in isolation has no representation of the assembled product. Tests verify code correctness. Nothing verifies product completeness.

### Product Behavior Contracts fill the gap

A March 2026 analysis identified this exact failure mode: "An agent can follow every repo rule, pass all tests, and still break the product by violating implicit product decisions." The proposed solution is a **Product Behavior Contract (PBC)** — a specification that lives in the repo alongside `CLAUDE.md` and captures confirmed behaviors, forbidden states, deliberate edge cases, and architectural invariants.

For a 2-person team, this doesn't need a framework. Create `PRODUCT.md`:

```markdown
# Product Specification — AppName V3

## Protected UI Regions (must render on every authenticated page)
- App header with logo, navigation, user menu — selector: [data-testid="app-header"]
- Sidebar with navigation tree — selector: [data-testid="app-sidebar"]  
- Status bar with connection indicator — selector: [data-testid="status-bar"]
- Main content area — selector: [data-testid="main-content"]

## Routes (all must return 200 and render their designated layout)
- / → Dashboard (full shell + dashboard widgets)
- /settings → Settings (full shell + settings panel)
- /projects/:id → Project detail (full shell + project content)

## Architectural Invariants
- App.vue must import and render AppHeader, AppSidebar, StatusBar
- Every route component must be lazy-loaded via the router
- No component in src/components/ should be orphaned (unreachable from main.ts)
```

Reference this in `CLAUDE.md`: "After implementing any feature, verify all items in PRODUCT.md are still satisfied. Run the app-shell smoke test. If any protected UI region is missing, fix it before marking the task complete."

### The builder-verifier pattern in Claude Code

Claude Code v2.1.32+ supports agent teams with a recommended **1 reviewer per 3–4 builders** ratio. The most effective pattern, tested by Alexey Grigorev across 5 real projects with an **89% overnight success rate**, uses a PM → SWE → QA → PM pipeline where the QA agent and PM agent independently verify against the specification.

For practical implementation, define a read-only verifier subagent in `.claude/agents/verifier.md` that has no file-write permissions, only lint/test/screenshot tools, and is triggered after every implementation. The verifier checks: (1) Knip reports no unused files, (2) all smoke tests pass, (3) screenshots match the product description in `PRODUCT.md`. This separation — the builder cannot mark its own homework — is the architectural key.

**External multi-agent frameworks (CrewAI, LangGraph, AutoGen) are unnecessary overhead** for a 2-person team. Claude Code's native subagents and agent teams provide the same builder-verifier pattern without introducing Python infrastructure or framework dependencies. AutoGen has shifted to maintenance mode in favor of Microsoft's Agent Framework; CrewAI and LangGraph are better suited to complex orchestration scenarios that exceed what a small team needs.

### LLM-as-judge has a documented overcorrection problem

A February 2026 arXiv paper found that LLMs **frequently misclassify correct code as non-compliant** — an overcorrection bias. More detailed prompts (asking for explanations and corrections) actually *increase* misjudgment rates. The practical implication: **never use LLM evaluation as the sole verification mechanism.** Always pair it with deterministic checks (Knip, Playwright assertions, type-checking). Use the LLM judge for subjective criteria ("does this match the product feel?") and deterministic tools for objective criteria ("is every component reachable?").

---

## Migration-specific verification for V1 → V2 parity

### Route coverage is the minimum viable check

No dedicated route-parity tool exists, but a simple script solves this:

```typescript
// scripts/check-route-parity.ts
import v1Routes from '../v1/router/routes'
import v2Routes from '../v2/router/routes'

const v1Paths = v1Routes.map(r => r.path)
const v2Paths = v2Routes.map(r => r.path)
const missing = v1Paths.filter(p => !v2Paths.includes(p))

if (missing.length) {
  console.error('Routes in V1 missing from V2:', missing)
  process.exit(1)
}
```

Supplement with a Playwright smoke test that hits every V2 route and verifies non-404 responses plus key element visibility. **Playwright's ARIA snapshots** (stabilized in 2025) add a structural comparison layer — capture the accessibility tree of each V1 route, then assert the same structure exists in V2. This catches semantic regressions (wrong heading hierarchy, missing landmarks) that screenshot comparison misses.

### Meticulous.ai is the standout tool for migration replay

Meticulous records user sessions via a lightweight JavaScript snippet, captures network responses, and can replay those sessions against a different URL. For migration testing, you add the snippet to V1, let it record real user sessions, then replay against V2 and compare both visually and behaviorally. The free tier exists, and the deterministic replay engine eliminates flakiness. **Caveat**: if V1 and V2 have significantly different DOM structures or API contracts, replay accuracy degrades and you may need to re-record sessions on V2.

### Golden-path testing fills the behavioral gap

Record critical user journeys (login → navigate → create → edit → delete → logout) in V1 using `npx playwright codegen`, then run the generated tests against V2. This is the simplest form of behavioral parity verification. The key journeys to record for a migration:

- Authentication flow (login/logout cycle)
- Primary CRUD operations
- Navigation through all major sections
- Settings modification and persistence
- Error states and edge cases

---

## Emerging approaches worth watching in 2025–2026

### Browser-use agents are not ready for systematic QA

Anthropic Computer Use, OpenAI Operator (CUA), and Google Project Mariner have all been tested for QA applications. The consensus: **slow (~2 minutes per page check), expensive (~$0.15 per page validation), and unreliable for regression testing.** Beta Acid's real-world experiments found Computer Use "not ready for production-level QA." OpenAI published a testing agent demo using CUA + Playwright, but marked it "preview — not recommended for high-stakes environments." Google Mariner requires a $250/month subscription and is designed for consumer productivity, not QA.

These agents are useful for **occasional exploratory testing** — discovering edge cases a human might not think to test — but cannot replace deterministic test suites for regression detection.

### Self-healing tests solve the wrong problem

Healenium, Applitools Execution Cloud, and similar tools "heal" broken test selectors by finding alternative locators when elements move. But a QA Wolf study found that **selector failures account for only ~28% of test failures**. The rest: timing issues (~30%), test data problems (~14%), visual diffs (~10%), interaction changes (~10%), runtime errors (~8%). Self-healing addresses less than a third of the problem. For Playwright-based teams, the better investment is robust selectors (`data-testid` attributes) and Playwright's built-in auto-waiting.

### Playwright's 2025 features that matter most

**Playwright CLI** (v1.49+) is purpose-built for AI agent integration — a token-efficient CLI mode where commands like `playwright-cli snapshot` complete in 50ms and return structured text rather than screenshots. **`browser.bind()`** lets you launch a browser once and share it across multiple clients (MCP server, CLI, test runner). **ARIA snapshot enhancements** add `/children` for strict matching and `/url` for link validation. **`failOnFlakyTests`** in config ensures CI stability. Together, these features make Playwright the natural bridge between AI coding agents and browser-based verification.

---

## Implementation roadmap

### Week 1: Static analysis and smoke testing

**Day 1–2: Install and configure Knip**
- Add `knip.ts` with Vue compiler override
- Run `npx knip --production`, fix initial false positives
- Add to CI pipeline as a blocking check

**Day 2–3: Add dependency-cruiser reachability rule**
- Create `.dependency-cruiser.cjs` with `reachable: false` rule from `main.ts`
- Run `npx depcruise src --include-only "^src" --validate`
- Add to CI pipeline

**Day 3–4: Write Playwright app-shell smoke tests**
- Create `tests/smoke/app-shell.spec.ts` with `toBeVisible()` assertions for every shell component
- Add `toHaveScreenshot()` for full-page visual regression on key routes
- Run in Docker for consistent screenshots in CI

**Day 4–5: Create PRODUCT.md and update CLAUDE.md**
- Document all protected UI regions, routes, and architectural invariants
- Add verification instructions to `CLAUDE.md`
- Reference `PRODUCT.md` in all ticket templates

### Month 1: AI agent verification loops

**Week 2: Playwright MCP integration**
- Run `claude mcp add playwright npx @playwright/mcp@latest`
- Create `/verify-ui` custom command
- Test the screenshot → evaluate → fix loop on a real feature

**Week 2–3: Builder-verifier subagent**
- Define `.claude/agents/verifier.md` with read-only permissions
- Configure verification checklist: Knip clean → smoke tests pass → screenshots match PRODUCT.md
- Test on 3–5 real tickets to calibrate

**Week 3–4: Visual regression platform (if needed)**
- Evaluate Argos CI free tier (5,000 screenshots, ARIA snapshots)
- Or Lost Pixel free tier (7,000 screenshots, self-hostable)
- Set up baseline screenshots from current known-good state

### Quarter 1: Full pipeline maturity

**Month 2: Migration-specific checks**
- Script route parity verification between V1 and V2
- Record golden-path user journeys from V1 with Playwright codegen
- Implement ARIA snapshot comparisons for structural parity

**Month 2–3: PM-SWE-QA pipeline**
- Define the full agent team workflow (PM grooms → SWE builds → QA verifies → PM accepts)
- Create `PROCESS.md` enforcing the gated pipeline
- Target: no code commits without QA + PM acceptance

**Month 3: Continuous improvement**
- Track false positive rates from Knip, dependency-cruiser, visual regression
- Tune thresholds and ignore patterns
- Evaluate whether to upgrade from Playwright native screenshots to a platform

---

## Claude Code patterns that prevent this failure

### The CLAUDE.md that enforces product verification

```markdown
# Project Rules

## After ANY UI implementation:
1. Run `npx knip --production` — zero unused files allowed
2. Run `npx playwright test tests/smoke/` — all shell components must render
3. Use Playwright MCP to visually verify the changed page
4. Compare rendered UI against PRODUCT.md requirements
5. If any protected UI region (header, sidebar, status bar) is missing, FIX IT

## Ticket completion criteria:
- Code compiles (vue-tsc --noEmit)
- All existing tests pass
- New tests written for new functionality
- Knip reports no unused production files
- App-shell smoke test passes
- Visual verification confirms the feature appears in the running app

## NEVER mark a ticket as complete based solely on unit tests passing.
## The assembled product must be verified, not just individual components.
```

### The custom command for visual verification

Save as `.claude/commands/verify-product.md`:

```markdown
# Verify product integrity
1. Run `npx knip --production` and report any unused files
2. Start dev server: `npm run dev &`  
3. Navigate to / using Playwright MCP
4. Take accessibility snapshot — verify all landmarks from PRODUCT.md exist
5. Take screenshot at 1280x800 viewport
6. Navigate to each route listed in PRODUCT.md, repeat steps 4-5
7. Compare all findings against PRODUCT.md
8. Run `npx playwright test tests/smoke/`
9. Report: PASS (all product requirements met) or FAIL (list gaps)
```

### The verifier subagent definition

Save as `.claude/agents/verifier.md`:

```markdown
# Role: Product Verification Agent

You are a QA engineer. You verify that the running application matches 
the product specification in PRODUCT.md. You have READ-ONLY access — 
you cannot modify code, only inspect and report.

## Your tools:
- Run tests: `npx playwright test tests/smoke/`
- Run Knip: `npx knip --production`  
- Run dependency-cruiser: `npx depcruise src --include-only "^src" --validate`
- Take screenshots via Playwright MCP
- Read PRODUCT.md and compare against actual app

## Your output:
A structured report with PASS/FAIL for each product requirement, 
screenshots of any failures, and specific file/line references for issues found.
```

### Why this works when isolated ticket processing fails

The fundamental shift is from **ticket-scoped verification** ("does this ticket's acceptance criteria pass?") to **product-scoped verification** ("does the assembled product still match the specification?"). The `PRODUCT.md` serves as the single source of truth for what the product should look like. Knip and dependency-cruiser verify that all code is connected. Smoke tests verify that connected code actually renders. The verifier subagent ties all three together and blocks completion until the product — not just the ticket — is correct.

This multi-layered defense means the failure mode described — components ported but never wired in — would be caught by **at least three independent checks**: Knip flagging unused files, dependency-cruiser flagging unreachable modules, and the smoke test failing when `[data-testid="app-header"]` isn't visible. Any one of these would have prevented the bug. Together, they make it nearly impossible for a well-ported component to silently go unwired.

---

## Conclusion

The "tests pass but product is wrong" failure is not a gap in testing tools — it's a gap in **what gets tested**. Standard CI pipelines verify code correctness at the module level. Nothing in a typical pipeline verifies that the modules compose into the intended product. The fix is three layers that didn't exist before: **static reachability analysis** (Knip + dependency-cruiser) to prove all code is connected, **visual smoke testing** (Playwright assertions + screenshots) to prove the assembled product renders correctly, and an **explicit product specification** (PRODUCT.md) that gives both humans and AI agents a ground truth to verify against. For a 2-person team, the entire defense can be built in under a week using free, open-source tools already in the Vue 3 + Playwright ecosystem. The only ongoing cost is **~$15/month in LLM tokens** for Claude Code's screenshot verification loop — a trivial price for preventing the kind of failure that shipped a featureless shell to review.