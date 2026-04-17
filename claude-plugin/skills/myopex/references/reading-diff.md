# Reading the diff report

`myopex verify` and `myopex diff` write `report.json` into the output directory. It has two cleanly separated sections — treat them differently.

## Structure

```ts
interface FullDiffReport {
  pass: boolean              // true only if both invariants and regressions are empty
  timestamp: string
  source: string             // baseline path (or fingerprint file)
  target: string             // current path (or live URL)
  invariants: {
    failures: InvariantFailure[]
    checked: number
  }
  regressions: {
    failures: RegressionFailure[]
    checked: number
    missing: string[]        // composite IDs present in baseline, absent in current
    added: string[]          // composite IDs present in current, absent in baseline
  }
}

interface InvariantFailure {
  component: string          // composite ID
  region: string
  property: string           // e.g. "visible", "textOverflow", "backgroundColor"
  value: string | number | boolean
  message: string            // human-readable explanation
  screenshotFile?: string
}

interface RegressionFailure {
  component: string
  region: string
  property: string
  expected: string | number | boolean   // baseline value
  actual: string | number | boolean     // current value
  screenshotFile?: string
}
```

## Two sections, two responses

### `invariants` — always-wrong, no baseline needed

Every failure here is a bug in the **current** page. Full stop. Fix them regardless of what the baseline says.

Checked invariants:
- `visible === false` on a rendered component → unexpected hide
- `backgroundColor` fully transparent on a **container** that should carry theme (interactive roles like `button`, `link`, `menuitem`, `listitem`, `tab`, `checkbox`, `radio`, `switch`, `cell`, etc. are intentionally excluded — they inherit their background from a parent and transparent is expected)
- `textOverflow === true` → content is being clipped
- `bounds.width === 0` or `bounds.height === 0` → zero-sized element

**How to act:** for each failure, open `screenshotFile` if provided, correlate `component` to the source code (composite ID → region → role + name), propose a fix. Do not ask the user whether to fix these; they're unambiguous bugs.

### `regressions` — changed from baseline

A regression is a property that drifted from the baseline on a component matched by composite ID. These need judgment: the baseline might have been wrong, or the change might be intentional.

**Exact compares (any difference is a regression):**
- `visible`, `backgroundColor`, `color`, `display`, `textOverflow`, `role`, `fontSize`

**Numeric compares with tolerance (difference must exceed threshold):**
- `bounds.width` — tolerance ±50px
- `bounds.height` — tolerance ±30px
- `bounds.x`, `bounds.y` — tolerance ±100px

**Set compares:**
- `regressions.missing` — components present in baseline, absent now (something got removed)
- `regressions.added` — components present now, absent in baseline (something new appeared)

**How to act:**
1. Group failures by `region`, then by `component` — layout bugs usually produce clusters, not scattered singletons
2. For each cluster, decide: is the new value correct or the baseline correct?
   - Intentional feature change → update the baseline (`myopex scenarios --out <baseline>` on the known-good branch)
   - Unintentional regression → fix the code
3. `missing` components on an interactive element (button, link) are almost always bugs. `missing` on decorative items are often intentional.
4. `added` components on a previously-minimal region may be noise or may be real new content. Check the screenshot.

## Reading efficiently

For large apps with many scenarios, `report.json` can be long. Strategies:

- **Read `pass` first.** If `true`, you're done — go ship.
- **Check invariants before regressions.** Invariants are unambiguous; regressions need thought. Fix the easy wins first, re-capture, then tackle regressions.
- **Group by region.** `failures` aren't sorted; regroup mentally by `region` field. One broken region often explains many failures.
- **Don't open every screenshot.** The YAML fields usually tell you enough (`expected: true, actual: false` on `visible` is self-explanatory). Open the screenshot only when the property alone is ambiguous (`color` changed — is the new color actually correct?).
- **Cross-reference composite IDs.** The same component appears in invariants and regressions? Start with the invariant — if that fix resolves the regression, great.

## Exit codes

- `myopex verify` exits **0** if `report.pass === true`, **1** otherwise → wire directly into CI
- `myopex diff` exits 0 unconditionally → it's a reporter, not a gate

## When the report lies

- If most components show `resolveStatus: failed` or `fallback` (visible in the fingerprint YAML, not report.json), the capture itself was unreliable. Re-run before acting on the report.
- If a regression is on a component with `resolveStatus !== 'ok'` in *either* baseline or current, discount it — the numbers may be fabricated.
- Baseline drift: if the baseline is months old and the codebase has moved on, many "regressions" are expected. Capture a fresh baseline on the closest known-good commit.
