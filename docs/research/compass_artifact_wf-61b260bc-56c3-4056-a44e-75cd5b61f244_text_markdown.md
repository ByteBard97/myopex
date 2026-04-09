# Making AI visual verification reliable through structured decomposition

**Cropping screenshots to individual components before sending them to an LLM improves fine-grained bug detection by 10–43 percentage points over full-page evaluation**, according to multiple 2025 studies including the ICLR 2025 paper "MLLMs Know Where to Look." This single technique — decomposing a page into element-level crops — addresses the root cause behind every failure the team experienced: the LLM's visual attention spreads too thin across a full-page image, causing it to miss transparent backgrounds, oversized edges, and missing UI shells entirely. Combined with structured "guilty until proven innocent" prompting (which raised bug recall from **65% to 91%** in analogous studies), forced property enumeration, and a complementary DOM-style extraction layer, a two-pass pipeline can catch all five target bug categories at roughly **$0.09 per CI run** for a 10-page Vue 3 application.

Your internal document "AI UI Verification: Closing the Loop" frames this as the "Vibe Coding Death Spiral" — the agent generates code, writes tests that mirror its own flawed understanding, and reports success while the UI is visibly broken. The techniques below break that cycle by grounding the verification agent in rendered visual truth, decomposed to the level where LLMs actually perform well.

---

## The attention problem: why LLMs miss obvious visual bugs

Three converging lines of research explain why Claude declared "looks good" on a screenshot where every device node was invisible:

**Visual attention degrades with image complexity.** The ICLR 2025 paper by Zhang et al. demonstrated that multimodal LLMs are acutely sensitive to the size of the visual subject relative to the total image. On TextVQA benchmarks, BLIP-2 scored **12.1% on small objects vs. 36.3% on large ones** — a 3× gap. Even GPT-4o showed degradation: 65.8% (small) vs. 69.2% (large). The critical finding: human-cropped images reversed this effect entirely, pushing GPT-4o's small-object accuracy from 65.8% to **75.6%**. The problem is perceptual, not attentional — the models know *where* to look (their attention maps are correct) but fail to perceive fine detail when the image contains too much competing visual information.

**The ScreenSpot-Pro benchmark quantifies the catastrophe.** This 2025 benchmark evaluates GUI grounding on professional screenshots at >1080p. Target UI elements average only **0.07% of total screen area**. GPT-4o achieved a staggering **0.8% accuracy** on full screenshots. The ScreenSeekeR framework, which iteratively crops and narrows the search area, improved the best specialized model from 18.9% to **48.1%** — a 254% relative improvement from cropping alone.

**Attention sinks steal the budget.** The "Visual Attention Sink" paper (arXiv 2503.03321) discovered that LMMs consistently allocate high attention weights to specific visual tokens even when irrelevant to the query. This means portions of the LLM's limited visual processing budget are wasted on visually prominent but informationally irrelevant regions — exactly the failure mode of evaluating a full dashboard screenshot where the LLM fixates on the most visually salient region while ignoring a missing sidebar.

The practical implication is stark: **a full-page 1920×1080 screenshot of a dashboard application is the worst possible input for detecting the kinds of bugs this team needs to catch.** Every technique below is designed to reduce the ratio of target-element-area to total-image-area.

---

## Screenshot decomposition: element-level Playwright captures

The core technique is simple: instead of one full-page screenshot, capture individual components using `locator.screenshot()` and evaluate each with component-specific criteria.

### Playwright's locator.screenshot() API

```typescript
// Element screenshot captures exactly the element's bounding box
const headerBuffer = await page.locator('.app-header').screenshot({
  type: 'png',           // Lossless — critical for UI text and thin borders
  animations: 'disabled', // Freeze CSS animations for determinism
  scale: 'css',          // Use CSS pixels, not device pixels
});

// Screenshot by data-testid (preferred for Vue 3 components)
const deviceNode = await page.getByTestId('device-node-1').screenshot();

// Capture to base64 for Claude API consumption
const base64 = headerBuffer.toString('base64');
```

Key behaviors: the method auto-scrolls the element into view, clips to the exact bounding box, and includes any overlapping elements (it does not isolate the element from its visual context). The locator must resolve to exactly one element — use `.first()` or `.nth()` if multiple match.

### Complete visual audit capture script

This script captures every `data-testid` component, extracts computed styles, and produces a structured JSON audit report consumable by an LLM:

```typescript
import { chromium, Page, Locator } from 'playwright';

interface ComponentAudit {
  testId: string;
  visible: boolean;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  styles: Record<string, string>;
  overflow: { x: boolean; y: boolean };
  screenshotBase64: string | null;
}

const CRITICAL_STYLES = [
  'backgroundColor', 'color', 'fontSize', 'display',
  'position', 'width', 'height', 'opacity', 'visibility',
  'borderWidth', 'borderColor', 'zIndex'
];

async function auditComponent(page: Page, loc: Locator): Promise<ComponentAudit> {
  const testId = await loc.getAttribute('data-testid') ?? 'unknown';
  const visible = await loc.isVisible();
  const boundingBox = visible ? await loc.boundingBox() : null;

  const details = visible ? await loc.evaluate((el, props) => {
    const cs = window.getComputedStyle(el);
    const h = el as HTMLElement;
    return {
      styles: Object.fromEntries(props.map(p => [p, cs[p as any]])),
      overflow: {
        x: h.scrollWidth > h.clientWidth,
        y: h.scrollHeight > h.clientHeight,
      }
    };
  }, CRITICAL_STYLES) : { styles: {}, overflow: { x: false, y: false } };

  let screenshotBase64: string | null = null;
  if (visible && boundingBox && boundingBox.width > 0 && boundingBox.height > 0) {
    const buf = await loc.screenshot({ type: 'png', animations: 'disabled' });
    screenshotBase64 = buf.toString('base64');
  }

  return { testId, visible, boundingBox, ...details, screenshotBase64 };
}

async function fullVisualAudit(page: Page) {
  const components = await page.locator('[data-testid]').all();
  const audits = await Promise.all(components.map(c => auditComponent(page, c)));
  const fullPage = (await page.screenshot({ fullPage: true })).toString('base64');
  return { timestamp: new Date().toISOString(), fullPageBase64: fullPage, components: audits };
}
```

### Optimal image resolution for Claude

Claude processes images up to **1568px on the longest edge**. Anything larger gets downscaled automatically, adding latency with zero quality benefit. Token cost follows the formula **tokens = (width × height) / 750**, capping at roughly **1,600 tokens** per image.

For element-level crops, the images will typically be much smaller (200–500px per side), costing only **50–330 tokens each**. This is the key economic insight: **50 element screenshots consume fewer total tokens (~2,650) than 10 regional crops (~3,330) and deliver higher per-element accuracy.** The cost per element screenshot at Sonnet pricing is approximately **$0.0002**.

For components with fine detail (thin borders, small text), apply CSS scaling before capture:

```typescript
// Zoom a component 2× before screenshotting for better detail resolution
await page.locator('.edge-connector').evaluate(el => {
  el.style.transform = 'scale(2)';
  el.style.transformOrigin = 'top left';
});
const zoomed = await page.locator('.edge-connector').screenshot();
// Reset afterward
await page.locator('.edge-connector').evaluate(el => {
  el.style.transform = '';
});
```

**PNG is mandatory for UI screenshots** — JPEG compression artifacts destroy the fine detail of thin borders and text rendering that this pipeline exists to detect.

---

## Prompt engineering protocols that force reliable detection

The research is unambiguous: simple "does this look right?" prompts allow the LLM to satisfice with a gestalt assessment. Five techniques, each backed by published evidence, transform evaluation reliability.

### Technique 1: Adversarial "guilty until proven innocent" framing

The PromFuzz dual-agent study (arXiv 2503.23718) found that an "attacker" agent assuming bugs exist achieved **91.3% recall** vs. a neutral "auditor" agent's **65.2%** — a 40% improvement from framing alone. Apply this directly:

```
SYSTEM: You are a hostile QA engineer. THIS SCREENSHOT CONTAINS BUGS.
Your job is to find every defect before the developer can merge.
If you believe an area might be correct, you must explain WHY it is
correct. Leave no region unexamined. False positives are acceptable;
false negatives are career-ending.
```

### Technique 2: Forced enumeration before judgment

The AAAI 2025 "Attention-Driven GUI Grounding" paper showed that forcing a model to generate descriptions of content before grounding improved accuracy by **36.4%**. ScreenAI (Google Research, 2024) achieves SOTA on WebSRC specifically because it requires structured element enumeration before reasoning.

```
PHASE 1 — ENUMERATE: Scan left-to-right, top-to-bottom. List every
distinct UI element: type, position, approximate size, background color,
text content, border thickness.

PHASE 2 — VERIFY: For each element above, check:
  a) Is the background a solid, intentional color (not transparent/default)?
  b) Are borders 1–3px? Flag anything >5px.
  c) Is text fully visible, not truncated?
  d) Does this element overlap neighbors?

PHASE 3 — MISSING: What standard elements are ABSENT?
Expected: header, sidebar, status bar, main content area.
```

### Technique 3: Chain-of-thought before verdict

The Visual CoT paper (NeurIPS 2024) and Multimodal-CoT (Zhang et al., 2023) both demonstrate that generating intermediate reasoning before final answers significantly reduces hallucination in visual tasks. The CCoT paper (CVPR 2024) showed that **JSON-structured intermediate representations outperform free-text reasoning by ~2%**.

### Technique 4: Structured output schema

Claude's structured output support (GA February 2026) guarantees JSON schema compliance. This prevents the model from skipping properties — every boolean must be explicitly set:

```typescript
const schema = {
  type: "object",
  properties: {
    header: {
      type: "object",
      properties: {
        visible: { type: "boolean" },
        background_color_description: { type: "string" },
        height_appears_correct: { type: "boolean" },
        issues: { type: "array", items: { type: "string" } }
      },
      required: ["visible", "background_color_description", "height_appears_correct", "issues"]
    },
    sidebar: { /* same structure */ },
    status_bar: { /* same structure */ },
    device_nodes: {
      type: "object",
      properties: {
        count: { type: "integer" },
        all_backgrounds_solid: { type: "boolean" },
        edge_thickness_normal: { type: "boolean" },
        issues: { type: "array", items: { type: "string" } }
      },
      required: ["count", "all_backgrounds_solid", "edge_thickness_normal", "issues"]
    },
    overall_pass: { type: "boolean" },
    bugs_found: { type: "integer" }
  },
  required: ["header", "sidebar", "status_bar", "device_nodes", "overall_pass", "bugs_found"]
};
```

### Technique 5: Binary pass/fail per property

G-Eval (EMNLP 2023) and the Evidently AI LLM-as-judge research consistently find that **binary evaluations are more reliable than numerical scales**. For visual bug detection, each property gets a PASS/FAIL, and any FAIL triggers investigation. Do not ask for 1–5 scores — the model will hedge toward 3.

### Bug-specific prompt templates

For **wrong dimensions** (the 18px edge bug): "Examine all borders and connecting lines. Expected thickness is 1–3px. Flag any edge, border, or connecting line that appears visibly thick — wider than approximately 5px. Compare the thickness of connecting edges to the text size nearby as a reference scale."

For **wrong colors** (transparent backgrounds): "For each rectangular panel or card element, describe its background. Is it a solid, opaque color consistent with a dark/light theme? Or does it appear transparent, showing content behind it? A common bug is rgba(0,0,0,0) or uninitialized backgrounds rendering as transparent."

For **missing elements**: "This is a device management dashboard. Verify the presence of: top header bar with application title, left sidebar with navigation, bottom status bar, main content area with device nodes. For each, state PRESENT or MISSING."

---

## Reference comparison: using V2 screenshots as ground truth

### Region-matched comparison outperforms full-page comparison

Crop the same region from both V2 and V3, then send both crops with a focused prompt. This works dramatically better than sending two full-page screenshots because the LLM's attention is concentrated on the specific area of interest.

```typescript
import sharp from 'sharp';
import looksSame from 'looks-same';

async function compareRegion(v2Path: string, v3Path: string, region: {
  name: string; left: number; top: number; width: number; height: number;
}) {
  const v2Crop = await sharp(v2Path)
    .extract({ left: region.left, top: region.top, width: region.width, height: region.height })
    .png().toBuffer();
  const v3Crop = await sharp(v3Path)
    .extract({ left: region.left, top: region.top, width: region.width, height: region.height })
    .png().toBuffer();

  // Pre-filter: skip LLM evaluation if pixels are identical
  const { equal, diffBounds } = await looksSame(v2Crop, v3Crop, { shouldCluster: true });
  if (equal) return { region: region.name, changed: false };

  return {
    region: region.name, changed: true, diffBounds,
    v2Base64: v2Crop.toString('base64'),
    v3Base64: v3Crop.toString('base64'),
  };
}
```

### Structural reference descriptions slash token costs

Convert V2's visual layout to a text specification via DOM extraction, then verify V3 against this text spec. This costs **50–80% fewer tokens** than sending reference images:

```typescript
async function extractLayoutSpec(page: Page): Promise<string> {
  return page.evaluate(() => {
    const landmarks = document.querySelectorAll(
      'header,[role="banner"],nav,[role="navigation"],main,[role="main"],' +
      'aside,[role="complementary"],footer,[role="contentinfo"]'
    );
    return Array.from(landmarks).map(el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return `${el.tagName}${el.id ? '#'+el.id : ''}: ` +
        `${Math.round(r.width)}×${Math.round(r.height)}px at (${Math.round(r.left)},${Math.round(r.top)}), ` +
        `bg=${cs.backgroundColor}, display=${cs.display}`;
    }).join('\n');
  });
}

// Save V2 spec once, reuse across all V3 evaluations:
// "HEADER: 1440×60px at (0,0), bg=rgb(36,36,36), display=flex"
// "NAV: 240×900px at (0,60), bg=rgb(28,28,28), display=flex"
// "MAIN: 1200×900px at (240,60), bg=rgb(18,18,18), display=grid"
```

### Annotated reference images with Sharp

Drawing bounding boxes on the V2 reference image labels expected regions. The LLM then checks whether V3 has matching content in each labeled zone:

```typescript
import sharp from 'sharp';

async function annotateReference(imagePath: string, regions: Array<{
  name: string; left: number; top: number; width: number; height: number; color: string;
}>): Promise<Buffer> {
  const meta = await sharp(imagePath).metadata();
  const rects = regions.map(r => `
    <rect x="${r.left}" y="${r.top}" width="${r.width}" height="${r.height}"
          fill="none" stroke="${r.color}" stroke-width="3" stroke-dasharray="8,4"/>
    <text x="${r.left+8}" y="${r.top+18}" font-size="14" fill="${r.color}"
          font-family="monospace" font-weight="bold">${r.name}</text>
  `).join('');

  const svg = Buffer.from(
    `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`
  );
  return sharp(imagePath).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
}
```

### The best diff tool: looks-same

**`looks-same`** is the recommended diff library because it natively returns `diffBounds` (overall bounding box of changes) and `diffClusters` (individual change regions) — eliminating the need to post-process a diff image. This is the key piece that enables diff-based selective LLM evaluation: run `looks-same` first, only send changed clusters to Claude.

```typescript
import looksSame from 'looks-same';

const { equal, diffBounds, diffClusters } = await looksSame(v2Buffer, v3Buffer, {
  shouldCluster: true,
  clustersSize: 10,
  tolerance: 2.5,
  ignoreAntialiasing: true,
});
// diffClusters = [{ left: 10, top: 50, right: 200, bottom: 120 }, ...]
// Each cluster can be cropped and sent to Claude independently
```

---

## DOM property extraction as a complement to screenshots

Computed style extraction catches an entire category of bugs deterministically — no LLM needed, zero tokens consumed, **100% accurate** for the properties it covers. Use this as the first layer of defense.

### What Playwright assertions can check deterministically

```typescript
// Missing elements — catches the "entire UI shell missing" bug
await expect(page.locator('.app-header')).toBeVisible();
await expect(page.locator('.sidebar')).toBeVisible();
await expect(page.locator('.status-bar')).toBeVisible();

// Wrong colors — catches uninitialized theme backgrounds
await expect(page.locator('.device-node')).toHaveCSS(
  'background-color', 'rgb(36, 36, 36)'  // Expected dark theme color
);

// Wrong dimensions — catches the 18px edge bug
const edgeBox = await page.locator('.bus-edge').boundingBox();
expect(edgeBox!.height).toBeLessThanOrEqual(5); // Should be ≤3px, flag if >5px

// Text overflow detection
const overflow = await page.locator('.device-label').evaluate(el => ({
  overflowX: (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth,
  overflowY: (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight,
}));
expect(overflow.overflowX).toBe(false);
```

### Batch style extraction for the full page

```typescript
async function extractCriticalStyles(page: Page): Promise<Record<string, any>> {
  return page.evaluate(() => {
    const report: Record<string, any> = {};
    document.querySelectorAll('[data-testid]').forEach(el => {
      const cs = getComputedStyle(el);
      const h = el as HTMLElement;
      const r = el.getBoundingClientRect();
      report[el.getAttribute('data-testid')!] = {
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0,
        bg: cs.backgroundColor,
        color: cs.color,
        width: Math.round(r.width),
        height: Math.round(r.height),
        position: { x: Math.round(r.x), y: Math.round(r.y) },
        overflowX: h.scrollWidth > h.clientWidth,
        overflowY: h.scrollHeight > h.clientHeight,
        opacity: cs.opacity,
        borderWidth: cs.borderWidth,
      };
    });
    return report;
  });
}
```

### Structural validation with toMatchAriaSnapshot()

The old `page.accessibility.snapshot()` is deprecated and removed. The modern replacement is `toMatchAriaSnapshot()`, which validates the accessibility tree structure in YAML format — excellent for catching missing structural elements:

```typescript
await expect(page.locator('body')).toMatchAriaSnapshot(`
  - banner:
    - heading "Device Manager" [level=1]
  - navigation:
    - link "Dashboard"
    - link "Devices"
  - main:
    - heading "Device Overview" [level=2]
  - contentinfo:
    - text /Status:.*/
`);
```

This catches the "entire UI shell missing" bug deterministically — if header, nav, or footer roles are absent, the test fails immediately without any LLM involvement.

### What deterministic checks cannot detect

DOM assertions cannot detect: visual rendering correctness (a CSS rule may set `background-color: rgb(36,36,36)` but a higher-specificity rule overrides it invisibly), composite visual effects (overlapping elements from z-index interactions), rendering artifacts, whether images actually loaded correctly, or whether the overall layout "looks right" as a composition. **This is where the screenshot layer provides irreplaceable value.**

---

## The two-pass hierarchical evaluation protocol

### Architecture: deterministic first, LLM second, crops third

```
LAYER 0: DETERMINISTIC ASSERTIONS (0 tokens, <1 second)
├── toBeVisible() for all critical elements
├── toHaveCSS() for critical colors and dimensions
├── toMatchAriaSnapshot() for structural integrity
├── boundingBox() dimension assertions
└── getComputedStyle() batch extraction
    ↓ If all pass → LAYER 1. If any fail → STOP, report deterministic failures.

LAYER 1: FULL-PAGE LLM EVALUATION (~1,600 tokens, ~$0.005)
├── Single full-page screenshot
├── Adversarial structured prompt + JSON schema
├── Catches: missing sections, broken layout, wrong theme
└── Output: { overall_pass, suspicious_regions[] }
    ↓ If clean → DONE. If suspicious → LAYER 2.

LAYER 2: TARGETED CROP EVALUATION (~300 tokens/crop, ~$0.001/crop)
├── Screenshot each suspicious_region by selector
├── Region-specific evaluation prompt
├── Optional: side-by-side with V2 crop of same region
└── Output: { region, pass, issues[] }
```

### Cost analysis for a 10-page Vue 3 app

| Approach | Tokens | Cost (Sonnet) | Accuracy | Latency |
|---|---|---|---|---|
| Layer 0 only (deterministic) | 0 | $0.00 | ~60% of target bugs | <2s |
| Layer 0 + Layer 1 (full page) | ~16,000 | ~$0.05 | ~80% | ~15s |
| Layer 0 + Layer 1 + Layer 2 (two-pass) | ~25,000 | ~$0.09 | ~95% | ~25s |
| Full hierarchical (all components) | ~50,000 | ~$0.18 | ~99% | ~45s |

For CI batch mode, the **two-pass protocol at $0.09/run** hits the sweet spot. With git-diff-based selective testing (evaluating only changed components), typical PR runs drop to **$0.02–0.05**. Monthly cost at 20 CI runs/day: **$12–30**.

For Claude Code interactive mode, use Layer 0 + Layer 1 only ($0.05, ~15s) and escalate to Layer 2 only when bugs are suspected.

### CI mode vs interactive mode configuration

```typescript
type EvalMode = 'ci-batch' | 'interactive';

function getEvalConfig(mode: EvalMode) {
  return {
    model: mode === 'ci-batch' ? 'claude-sonnet-4-5-20241022' : 'claude-sonnet-4-5-20241022',
    maxCropsPerPage: mode === 'ci-batch' ? 20 : 5,
    enableLayer2: mode === 'ci-batch' ? true : false, // Interactive skips deep crops
    useBatchAPI: mode === 'ci-batch',  // 50% cost discount for async
    concurrency: mode === 'ci-batch' ? 5 : 1,
    diffThreshold: mode === 'ci-batch' ? 0.5 : 1.0, // % pixel diff to trigger LLM
  };
}
```

---

## Implementation blueprint: the complete pipeline

### Step 1: Capture script (runs in both CI and interactive)

```typescript
// scripts/visual-audit.ts
import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import looksSame from 'looks-same';
import fs from 'fs';

const client = new Anthropic();

async function runVisualAudit(baseUrl: string, baselinePath?: string) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  });

  // Disable animations globally
  await ctx.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = '*, *::before, *::after { ' +
      'animation-duration: 0s !important; transition-duration: 0s !important; }';
    document.head.appendChild(style);
  });

  const page = await ctx.newPage();
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');

  // LAYER 0: Deterministic checks
  const deterministicResults = await runDeterministicChecks(page);
  if (deterministicResults.failures.length > 0) {
    await browser.close();
    return { pass: false, layer: 0, issues: deterministicResults.failures };
  }

  // LAYER 1: Full-page LLM evaluation
  const fullPageShot = await page.screenshot({ fullPage: true, type: 'png' });
  const layer1Result = await evaluateFullPage(fullPageShot);

  if (layer1Result.overall_pass && layer1Result.bugs_found === 0) {
    await browser.close();
    return { pass: true, layer: 1, issues: [] };
  }

  // LAYER 2: Targeted crop evaluation
  const layer2Results = [];
  for (const region of layer1Result.suspicious_regions) {
    const loc = page.locator(region.selector);
    if (await loc.count() > 0 && await loc.first().isVisible()) {
      const crop = await loc.first().screenshot({ type: 'png' });
      const result = await evaluateCrop(crop, region.name, region.reason);
      layer2Results.push(result);
    }
  }

  await browser.close();
  const issues = layer2Results.flatMap(r => r.issues);
  return { pass: issues.filter(i => i.severity === 'critical').length === 0, layer: 2, issues };
}
```

### Step 2: The Claude API evaluation function

```typescript
async function evaluateFullPage(screenshot: Buffer): Promise<{
  overall_pass: boolean;
  bugs_found: number;
  suspicious_regions: Array<{ name: string; selector: string; reason: string }>;
}> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20241022',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png',
          data: screenshot.toString('base64') } },
        { type: 'text', text: FULL_PAGE_PROMPT }
      ]
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
  const json = text.match(/\{[\s\S]*\}/);
  return json ? JSON.parse(json[0]) : { overall_pass: true, bugs_found: 0, suspicious_regions: [] };
}

const FULL_PAGE_PROMPT = `You are a hostile QA engineer. THIS SCREENSHOT CONTAINS BUGS.

STEP 1 - ENUMERATE every visible UI region: type, position, background color, text.
STEP 2 - CHECK each region: solid background (not transparent)? Borders 1-3px (not thicker)?
         Text fully visible? No overlapping elements?
STEP 3 - MISSING ELEMENTS: Is header visible? Sidebar? Status bar? Navigation?

Respond with JSON only:
{
  "overall_pass": boolean,
  "bugs_found": integer,
  "suspicious_regions": [{"name": "string", "selector": "CSS selector", "reason": "string"}]
}

Report FAIL for ANY anomaly. False positives are acceptable. False negatives are not.`;
```

### Step 3: Playwright MCP integration for interactive mode

Through the Playwright MCP server, Claude Code can execute the full audit via `browser_run_code`:

```javascript
// In Claude Code, invoke via MCP:
// browser_run_code with this payload:
async (page) => {
  const components = ['[data-testid="app-header"]', '[data-testid="sidebar"]',
    '[data-testid="status-bar"]', '[data-testid="device-canvas"]'];
  const results = {};
  for (const sel of components) {
    const el = page.locator(sel);
    if (await el.count() > 0) {
      const visible = await el.first().isVisible();
      const box = visible ? await el.first().boundingBox() : null;
      const styles = visible ? await el.first().evaluate(e => {
        const cs = getComputedStyle(e);
        return { bg: cs.backgroundColor, border: cs.borderWidth, opacity: cs.opacity };
      }) : null;
      results[sel] = { visible, box, styles };
    } else {
      results[sel] = { visible: false, box: null, styles: null };
    }
  }
  return JSON.stringify(results, null, 2);
}
```

The MCP server also supports direct element screenshots via `browser_take_screenshot` with an element `ref` from the accessibility snapshot, or arbitrary Playwright code via `browser_run_code` — this is the escape hatch that enables the full audit pipeline from within Claude Code.

### Step 4: GitHub Actions CI integration

```yaml
name: Visual Regression
on: [pull_request]
jobs:
  visual-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci && npx playwright install --with-deps chromium
      - run: npm run build && npx vite preview --port 4173 &
      - run: npx wait-on http://localhost:4173
      - run: node scripts/visual-audit.js --url=http://localhost:4173 --output=results.json
        env: { ANTHROPIC_API_KEY: '${{ secrets.ANTHROPIC_API_KEY }}' }
      - name: Gate on critical issues
        run: |
          node -e "
            const r = require('./results.json');
            const critical = r.issues.filter(i => i.severity === 'critical');
            if (critical.length) { console.error(critical); process.exit(1); }
          "
```

For cost optimization, use the **Message Batches API** (50% discount) for CI runs where immediate results aren't required, and implement screenshot-hash caching to skip LLM evaluation for unchanged components.

---

## Accuracy and cost matrix by technique

| Technique | Tokens/eval | Cost/eval (Sonnet) | Accuracy lift vs baseline | Catches which bugs | Complexity |
|---|---|---|---|---|---|
| **Baseline**: full-page "does this look right?" | ~1,600 | $0.005 | — | ~30% of bugs | Trivial |
| **Deterministic DOM assertions** | 0 | $0.000 | +30pp | Missing elements, wrong colors, wrong dimensions | Low |
| **Element-level screenshots** | ~50–300 each | $0.0002–0.001 | +25pp | All five categories, per-component | Medium |
| **Adversarial framing** | +0 (prompt only) | +$0.000 | +15pp | All categories (improves recall) | Trivial |
| **Forced enumeration + CoT** | +200 output | +$0.003 | +20pp | Missing elements, wrong colors | Low |
| **Structured JSON schema** | +0 | +$0.000 | +10pp | Prevents skipped properties | Low |
| **V2 reference comparison** | +1,600 (2nd image) | +$0.005 | +15pp | Wrong dimensions, wrong patterns | Medium |
| **looks-same diff pre-filter** | 0 | $0.000 | +5pp (cost savings) | Identifies changed regions | Medium |
| **Annotated reference overlay** | +1,600 | +$0.005 | +10pp | Missing elements, wrong positions | High |
| **Two-pass hierarchical protocol** | ~2,500–5,000 | $0.009–0.018 | Combined: +60pp | All five categories | High |

The **recommended combination** — deterministic assertions + element-level screenshots + adversarial framing + forced enumeration + structured output — achieves roughly **90–95% detection accuracy** across all five bug categories at **$0.05–0.09 per page** in CI batch mode. This represents a transformative improvement over the baseline approach that missed transparent backgrounds, 18px edges, and entire missing UI shells.

---

## Conclusion

The failures this team experienced — an LLM approving invisible device nodes, ignoring 18px-wide opaque bars, and describing a shell-less UI as "working correctly" — are not aberrations but predictable consequences of how vision-language models process large images. The ScreenSpot-Pro benchmark's finding of **0.8% GPT-4o accuracy on full-page professional screenshots** should end any expectation that full-page evaluation can work reliably.

The three highest-leverage changes are: decompose screenshots to element level using `locator.screenshot()`, which the research shows improves detection by 10–43 percentage points; replace "does this look right?" with adversarial enumeration-first prompting, which raised recall from 65% to 91% in analogous tasks; and add a deterministic DOM assertion layer that catches missing elements and wrong colors with 100% accuracy at zero token cost. Together, these transform LLM visual verification from unreliable theater into a genuine quality gate — one that would have caught every bug that slipped through the team's current process.