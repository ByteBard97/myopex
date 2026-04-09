# Agent-consumable UI state fingerprints: what exists and what to build

**The short answer: D2Snap is real, no UI fingerprint format exists, and the fastest path to what you need is a hybrid of accessibility tree + computed visual properties in a hierarchical YAML schema.** D2Snap achieves DOM compression for agent consumption but is blind to visual properties — the exact gap your tool needs to fill. No existing tool or format combines DOM structure, visual styling, and accessibility semantics into a single compact representation. The web agent ecosystem has converged on the accessibility tree as the primary structured page representation, but every framework treats visual properties as a screenshot problem rather than a structured data problem. What you're building — a text-based fingerprint that captures the visual gestalt — is a genuine gap in the tooling landscape.

---

## D2Snap is real, useful, and visually blind

D2Snap (Downsampled DOM Snapshot) is a **published, open-source algorithm** — not an LLM hallucination. The paper "Beyond Pixels: Exploring DOM Downsampling for LLM-Based Web Agents" by Thassilo Schiepanski et al. appeared on arXiv (2508.04412) in August 2025, with an MIT-licensed JavaScript implementation at `webfuse-com/D2Snap` on GitHub.

The mechanism is a post-order DOM tree traversal applying type-sensitive rules per node. **Container elements** (div, section) get merged depth-wise based on a configurable ratio `k` relative to tree height — sibling containers consolidate, preserving the higher-rated element name and joining attribute sets. **Content elements** (headings, paragraphs) get translated to Markdown, controlled by ratio `l`. **Interactive elements** (buttons, inputs, links) are preserved as-is since agents need them for action targeting. **Everything else** (template tags, decorative elements) is removed as noise. An attribute threshold parameter `m` strips semantically low-value attributes. The output is valid DOM.

AdaptiveD2Snap wraps this with a Halton Sequence iterator that cycles through increasing parameter configurations until hitting a target token budget. The results are strong: D2Snap-downsampled DOM achieved **67% task success** versus 65% for screenshot baselines on Online-Mind2Web at comparable token counts (~1K tokens). The paper's key finding is that **hierarchy is the most important UI feature for LLM performance** — even light downsampling delivers dramatic size reductions.

The critical limitation for your use case: **D2Snap preserves zero visual properties.** No colors, dimensions, fonts, spacing, or CSS styling. It operates purely on DOM structure and semantics. This makes it excellent for action-oriented web agents ("click the submit button") but insufficient for UI verification ("is the submit button blue and 120px wide?").

The closest alternatives share this blindness. **Prune4Web** (arXiv 2511.21398) achieves 25–50x element reduction using LLM-generated scoring scripts but strips visual data. **FocusAgent** (arXiv 2510.03204) prunes accessibility trees with a lightweight LLM retriever, cutting observation size by 50%+ while also ignoring visual properties. **HtmlRAG** (WWW 2025, open-source at `plageon/HtmlRAG`) compresses HTML through rule-based cleaning, lossless merging, block tree construction, and two-step embedding-based pruning — but explicitly removes CSS and JavaScript. Every DOM compression tool in the ecosystem optimizes for structural/semantic preservation while treating visual properties as disposable.

---

## The accessibility tree has won the agent representation war

Across the entire web agent ecosystem — benchmarks, frameworks, and commercial tools — **the Chrome accessibility tree has emerged as the de facto structured page representation for LLM consumption.** Understanding why, and what it misses, is essential for designing your fingerprint format.

**WebArena** (ICLR 2024, 812 tasks) uses accessibility tree with element IDs as its default observation space. Each element gets a unique numeric ID (`[1582] Add to Cart`) that agents reference in actions. **VisualWebArena** extends this with Set-of-Mark overlays on screenshots. **OSWorld** (NeurIPS 2024, 369 tasks) uses XML-formatted accessibility trees from OS-level accessibility APIs, finding that screenshot + accessibility tree is generally the strongest combination but that including the tree "drastically increases per-task latency" due to **10K+ tokens per observation**. **Mind2Web** (NeurIPS 2023) takes a different approach — a small language model pre-filters the raw DOM to 50 candidate elements, then the main LLM selects from candidates.

The framework convergence is equally clear. **Stagehand** (Browserbase, 22K GitHub stars) migrated from raw DOM parsing to Chrome Accessibility Tree as its primary representation, achieving **80–90% data reduction** versus raw DOM. Its v3 architecture uses CDP directly with a context builder that feeds models "only what's essential." **Playwright MCP server** returns structured accessibility snapshots as text, supporting depth-limiting (`-d 3`) and selector-scoping (`-s "#main"`) for granular control. Microsoft's `@playwright/cli` variant is **4x more token-efficient** than MCP (27K vs 114K tokens per session) by saving snapshots to disk instead of streaming into context. **Browser Use** (78K+ GitHub stars) extracts the accessibility tree on each step as "a structured list of every interactive element, its type, its visible label, and its index," completing tasks in **68 seconds average versus 330 seconds for vision-only approaches.**

The outliers are vision-only. OpenAI's CUA (formerly Operator) and Anthropic's Computer Use both operate through screenshots with pixel-coordinate actions — no structured page representation at all. Google's Project Mariner uses a hybrid of vision and DOM internally but doesn't expose its representation. **OmniParser** (Microsoft, open-source) does pure vision-based screen parsing via fine-tuned YOLOv8, producing a flat list of detected elements with bounding boxes and functional descriptions — but no hierarchy.

Playwright's `toMatchAriaSnapshot()` deserves specific attention as a potential fingerprint base. Introduced in Playwright 1.49, it produces a **YAML accessibility tree** capturing roles, accessible names, ARIA attributes (checked, disabled, expanded, level, pressed, selected), link destinations, input values, text content, and hierarchical containment via indentation. It supports regex patterns, partial matching, and strict child matching. The format is highly token-efficient — roughly 10–50x smaller than raw DOM. But it is **completely blind to visual properties**: no colors, fonts, dimensions, spacing, borders, backgrounds, positions, or animations. An element hidden by CSS `display:none` but present in the DOM won't show up, but an element that's technically visible but visually obscured by another element will.

---

## No UI fingerprint format exists — but the building blocks do

Searching academic literature (CHI, UIST, ICSE 2023–2025), industry tools, and the web agent ecosystem confirms: **no one has published a format that combines DOM structure, computed visual properties, and accessibility semantics into a single compact representation.** The term "UI fingerprint" in web contexts overwhelmingly refers to browser fingerprinting for device identification, not page state representation. This is a genuine gap.

The W3C Accessibility Conformance Testing (ACT) Rules specification comes closest conceptually — it defines three "common input aspects" for testing: the DOM tree, computed CSS styling, and the accessibility tree. But ACT treats these as separate input aspects, not a unified format.

Visual regression tools operate at the pixel level, not the semantic level. **Percy** captures serialized DOM + assets, re-renders in cloud browsers, then does pixel-by-pixel comparison. **BackstopJS** and **Lost Pixel** use `pixelmatch` and `odiff` respectively for pure pixel diffing. **Chromatic** renders Storybook stories in real browsers and compares pixel-perfect snapshots with anti-flake heuristics. **Argos CI** recently added ARIA snapshot comparison alongside pixel diffing — the only tool combining both approaches.

**Applitools Eyes** is the most sophisticated, using "Visual AI" (hundreds of AI/ML algorithms trained on billions of images) that identifies layout structures, recognizes elements algorithmically, and provides Root Cause Analysis mapping visual diffs back to specific DOM/CSS changes. It "marries presentation and representation" — using DOM for layout identification while validating actual rendered output. But its representation is entirely proprietary and opaque, designed for human review dashboards rather than agent consumption.

Two emerging tools are worth watching. **Plasmate** (open-source headless browser engine) compiles HTML to a "Semantic Object Model" claiming **17.5x token compression**. **AgentQL** takes a unique approach with a GraphQL-like semantic query language over simplified HTML + accessibility tree, returning only the data you ask for in a specified shape — extremely token-efficient but currently lacking visual property support.

For LLM-generated UI descriptions as verification artifacts, the pattern is nascent. **mabl's Visual Assertions** is the closest production implementation — you write a natural-language assertion ("Verify that the results are relevant to the search input"), and mabl's LLM evaluates a screenshot against it, generating structured criteria that persist as test artifacts. **@llmassert/playwright** is an open-source Playwright extension adding LLM-powered matchers that return `{ pass, score, reasoning }`. Neither stores a persistent structured description of what a page looks like for cross-version comparison.

**Screen2Words** (UIST 2021, Google/U. Toronto) is the closest research benchmark — 112K human-annotated screen summaries across 22K Android UI screens, evaluated with CIDEr, BLEU, and BERTScore. The best model uses screenshot + view hierarchy + text + app description. **ScreenAI** (Google, 5B params) generates structured text annotations listing UI element type, location, and description from screenshots — but the model isn't publicly available. **CogAgent** (Tsinghua/Zhipu AI, 9B params, open-source Apache-2.0) is the most accessible UI-specialized model, achieving SOTA on Mind2Web using screenshots only, outperforming HTML-based methods.

---

## Hierarchical UI representation is the missing piece

No existing tool generates a page→region→component→element hierarchy of UI state. This is the clearest gap in the ecosystem and potentially the highest-value thing you can build.

The progressive disclosure pattern is well-established for agent context management — Microsoft's Agent Skills standard, Claude-Mem, and others use three-tier architectures (index → details → deep dive) for managing tool descriptions and memory. But **nobody has applied this pattern to spatial UI state representation.** Stagehand's accessibility tree is hierarchical in the DOM sense but doesn't group elements into semantic regions. OmniParser detects elements but produces a flat list. Set-of-Mark segments images at multiple granularity levels but doesn't create persistent hierarchical representations.

The best analog comes from 3D scene graphs (Stanford, 2019; MIT's Hydra system). Scene graphs use multi-layer hierarchies — Building → Room → Place → Object → Parts — with nodes carrying attributes (class, material, affordances) and edges carrying relationships (spatial, semantic, functional). MIT's Hydra builds these incrementally in real-time from sensor data. The mapping to web UI is direct: **Page → Region (landmark/section) → Component (card, form, table) → Element (button, input, text).** ARIA landmarks (banner, navigation, main, complementary, contentinfo) provide a natural starting point for the region level.

Spatial indexing from computational geometry is also relevant. **R-trees** (hierarchical bounding boxes grouping nearby objects) could automatically discover visual regions from element coordinates. Quadtrees recursively subdivide 2D space. These could provide algorithmic region discovery when ARIA landmarks are insufficient.

For granularity at each level, synthesizing across frameworks suggests: the **page level** should include URL, page type classification, overall layout description (e.g., "dark-themed dashboard"), and landmark inventory; the **region level** maps to ARIA landmarks plus visually distinct sections, with aggregate visual properties (background color, dimensions) and child component count; the **component level** captures functional groupings (forms, cards, tables, menus) with visual styling and interaction state; the **element level** specifies individual widgets with roles, labels, dimensions, colors, and states.

---

## Semantic diffing exists only at the pixel level

For cross-version comparison, the industry has three tiers: pixel diffing (BackstopJS, Lost Pixel), DOM diffing (`diffDOM`, `visual-dom-diff`), and Visual AI (Applitools). None operate at the semantic level you need — where "5-step modal became 4-step wizard" is recognized as an intentional transformation while "sidebar lost an icon" is flagged as a regression.

**Applitools' Root Cause Analysis** comes closest, mapping visual differences back to specific DOM/CSS changes. But it's designed for same-component comparison (did this button change?), not cross-version semantic mapping (did this modal become that wizard?). **Percy's Visual Review Agent** (2025–2026) generates plain-English summaries of visual changes and auto-filters irrelevant diffs, reducing review time from 10–15 minutes to 4–5 minutes per build. But this is a review acceleration tool, not a structured semantic diff.

For design system migration, the pattern is well-established but manual. **MUI codemods** provide JSCodeshift-based AST transformations with explicit component-to-component mappings, but verification is visual regression testing after the fact. The **feature flag parity pattern** (used at Split/Harness) runs old and new systems in parallel, mirrors traffic to both, and logs response differences — applicable to UI with screen comparison.

Academic research on GUI test migration is active. **TEMdroid** (ICSE 2024) uses BERT-based widget matching for cross-app test migration with 76% top-1 accuracy. **ITeM** (ACM SE 2025) uses LLMs for intention-based test migration that handles interaction logic variations. These address the "which widget in V3 corresponds to which widget in V2?" problem — directly relevant to your use case.

The gap is clear: **no tool generates a structured UI changelog** saying "Button moved from header to sidebar, color changed from #3B82F6 to #2563EB, new wizard component replaced modal." LLMs have the capability for this — they can compare two structured page descriptions and produce semantic diffs — but no one has productized it.

---

## The closest existing solution and what it's missing

The **closest existing approach** to "text-based UI fingerprint for agent consumption" is **Playwright's accessibility tree snapshot augmented with Stagehand's context builder approach and Vercel's agent-browser depth/selector scoping**. Specifically:

1. Use CDP's `Accessibility.getFullAXTree()` for the structural skeleton
2. Augment each node with bounding box coordinates from `DOM.getBoxModel()` or the Layout domain
3. Scope with depth-limiting and selector-scoping per agent-browser CLI
4. Serialize to YAML per Playwright's `toMatchAriaSnapshot()` format

This gets you ~70% of the way there. What's missing:

- **Computed visual properties** (background color, text color, font size, border, opacity, overflow state)
- **Semantic region grouping** (automatic discovery of visual sections beyond ARIA landmarks)
- **Component-level aggregation** (recognizing "this is a card with 3 children" vs. listing 3 siblings)
- **State-aware variants** (same page with modal open vs. closed)
- **Visual relationship annotations** (element A overlaps element B, sidebar is 240px wide)
- **Hierarchical progressive disclosure** (page summary → region details → element specifics)

Your ui-audit tool already captures per-component DOM properties (dimensions, colors, visibility, overflow, text content). **The implementation path is to merge your existing property data with an accessibility tree skeleton in a hierarchical YAML format.**

---

## Recommended format: hierarchical YAML with visual annotations

Based on everything found, the optimal fingerprint format is a **three-level hierarchical YAML** combining accessibility tree structure with computed visual properties. Here's what a dashboard page fingerprint would look like:

```yaml
page:
  url: "/dashboard"
  title: "Project Dashboard"
  viewport: "1440×900"
  theme: "dark"
  background: "#0F172A"
  layout: "header + sidebar-left + main-canvas"
  landmarks: [banner, navigation, main, complementary]

regions:
  header:
    role: banner
    bounds: { x: 0, y: 0, w: 1440, h: 56 }
    background: "#1E293B"
    children_count: 3
    summary: "Top bar with logo, search input, and user avatar menu"
    components:
      - logo: { type: img, bounds: { w: 32, h: 32 }, alt: "Acme" }
      - search: { type: searchbox, bounds: { w: 320, h: 36 }, placeholder: "Search projects..." }
      - user-menu: { type: button, label: "Jane D.", has_avatar: true, expanded: false }

  sidebar:
    role: navigation
    bounds: { x: 0, y: 56, w: 240, h: 844 }
    background: "#1E293B"
    children_count: 8
    summary: "Vertical nav with 8 icon-label links, 'Projects' is active"
    components:
      - nav-item[0]: { icon: "home", label: "Home", active: false }
      - nav-item[1]: { icon: "folder", label: "Projects", active: true, color: "#3B82F6" }
      - nav-item[2]: { icon: "users", label: "Team", active: false }
      - nav-item[3]: { icon: "settings", label: "Settings", active: false }
      - nav-item[4]: { icon: "chart", label: "Analytics", active: false }
      - nav-item[5]: { icon: "bell", label: "Notifications", active: false, badge: 3 }
      - nav-item[6]: { icon: "docs", label: "Docs", active: false }
      - nav-item[7]: { icon: "help", label: "Help", active: false }

  canvas:
    role: main
    bounds: { x: 240, y: 56, w: 1200, h: 844 }
    background: "#0F172A"
    children_count: 3
    summary: "Canvas area containing 3 device node cards in a flow layout"
    components:
      - device-node[0]:
          type: card
          bounds: { x: 320, y: 120, w: 200, h: 140 }
          background: "#1E3A5F"
          border: "1px solid #334155"
          border_radius: 8
          children:
            - heading: { text: "Router A", level: 3, color: "#E2E8F0" }
            - status: { text: "Online", color: "#22C55E" }
            - detail: { text: "192.168.1.1", color: "#94A3B8", font_size: 12 }
      - device-node[1]:
          type: card
          bounds: { x: 580, y: 120, w: 200, h: 140 }
          background: "#1E3A5F"
          border: "1px solid #334155"
          border_radius: 8
          children:
            - heading: { text: "Switch B", level: 3, color: "#E2E8F0" }
            - status: { text: "Warning", color: "#EAB308" }
            - detail: { text: "192.168.1.2", color: "#94A3B8", font_size: 12 }
      - device-node[2]:
          type: card
          bounds: { x: 440, y: 320, w: 200, h: 140 }
          background: "#1E3A5F"
          border: "1px solid #334155"
          border_radius: 8
          children:
            - heading: { text: "Server C", level: 3, color: "#E2E8F0" }
            - status: { text: "Offline", color: "#EF4444" }
            - detail: { text: "192.168.1.3", color: "#94A3B8", font_size: 12 }

state:
  name: "project-loaded"
  modals: none
  selection: null
  scroll_position: { x: 0, y: 0 }
```

The design principles behind this format:

**Progressive readability.** An agent reading only the `page` block gets the gestalt in ~50 tokens ("dark dashboard, header + sidebar + canvas"). Reading `regions` adds spatial layout and component inventories in ~200 tokens. Reading full `components` provides every visual detail in ~800 tokens. This maps directly to the three-tier progressive disclosure pattern — index, details, deep dive.

**Visual properties are first-class.** Every node carries `bounds`, `background`, `color`, and relevant visual attributes. This is what the accessibility tree misses and what your tool already captures.

**Diffable by design.** Two fingerprints in this format can be structurally diffed (YAML diff) to produce meaningful changelogs. An LLM can compare two fingerprints and say "sidebar lost nav-item[7], device-node[1] status changed from Online to Warning, canvas background changed from #0F172A to #1A1A2E."

**State-aware.** The `state` block explicitly captures page state (which modal is open, what's selected, scroll position). Multiple fingerprints for the same URL with different state names handle your multi-state requirement.

---

## Two-day implementation path

**Day 1: Build the fingerprint generator.** You already have Playwright capturing DOM properties and screenshots. The implementation is:

1. **Extract the accessibility tree** via CDP's `Accessibility.getFullAXTree()` through Playwright's CDP session (`page.context().newCDPSession(page)`). This gives you the structural skeleton with roles, names, and states.

2. **Augment with visual properties** from your existing per-component property extraction. For each accessibility tree node that maps to a DOM element (via `backendDOMNodeId`), merge in the computed style properties you already capture: `background-color`, `color`, `font-size`, `border`, `width`, `height`, `overflow`, `opacity`. Use `window.getComputedStyle()` in a Playwright `evaluate` call, batched for performance.

3. **Build the region hierarchy** by grouping elements under ARIA landmarks first (these come free from the accessibility tree — look for roles `banner`, `navigation`, `main`, `complementary`, `contentinfo`). For pages with poor landmark markup, fall back to top-level sectioning elements (`header`, `nav`, `main`, `aside`, `footer`) and then to large container elements above a size threshold.

4. **Serialize to YAML** using the format above. Generate both the full fingerprint and a summary-only version (page + region summaries, no component details) for token-constrained contexts. The `summary` field at each region can be LLM-generated from the component list on first capture, then stored as part of the fingerprint.

5. **Handle multiple states** by parameterizing fingerprint capture. Your CLI already drives Playwright — add a `--state` flag that names the state and records it in the fingerprint. Store fingerprints as `{page}-{state}.fingerprint.yaml`.

**Day 2: Build the comparison engine.** 

1. **Structural diff** using a YAML-aware tree differ. For each region, compare component inventories — added, removed, modified components. For modified components, diff individual properties. Output a structured changelog.

2. **LLM-powered semantic diff** for the hard cases. Feed Claude the two fingerprints (old and new) with a prompt asking it to classify each difference as "intentional redesign," "potential regression," or "unclear — needs human review." The hierarchical YAML format keeps the token count manageable — two full page fingerprints should fit in under 2K tokens total.

3. **Verification mode** where an agent generates a fingerprint of its work and compares it against a stored reference fingerprint. The comparison can be structural (automated YAML diff) for exact matches or semantic (LLM-judged) for "does this match the intent?"

For your specific use cases: **self-validation** works by capturing a reference fingerprint, letting the agent make changes, capturing a new fingerprint, and diffing. **Cross-version comparison** works by storing V2 and V3 fingerprints side by side — the structural diff catches missing icons (nav-item count dropped from 8 to 7), while the LLM semantic diff recognizes that a 5-step modal became a 4-step wizard. **Reference porting** works by giving the agent a V2 fingerprint as a target specification — it reads the hierarchical description and builds toward it, periodically capturing its own fingerprint to compare.

The key architectural decision: **generate region summaries using an LLM on first capture** (screenshot + component list → one-sentence summary per region), then store those summaries as part of the fingerprint. These summaries become the "natural language layer" that lets an agent quickly understand what it's looking at without processing every component. When comparing versions, the summaries provide human-readable context for the structural diff. This hybrid approach — structured YAML for machine comparison, embedded natural language for agent comprehension — is more robust than either pure NL descriptions or pure structured data alone.

What to skip: don't build OmniParser-style visual element detection (you already have DOM access — use it). Don't try to fine-tune a UI understanding model (use Claude's existing multimodal capabilities). Don't build a pixel differ (BackstopJS/Lost Pixel already exist for that layer). Focus on the format and the merge pipeline — combining accessibility tree structure with computed visual properties is the thing nobody else has built, and it's the thing that makes your fingerprints genuinely useful for agent verification.