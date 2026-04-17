---
description: Capture current UI, diff against baseline, READ the output, summarize real findings vs false positives
---

Run a full myopex verification pass on the current project and produce a structured summary that distinguishes real findings from false positives. Do not declare success based on a command completing — success means the report was read end-to-end and every finding was triaged.

**Arguments:** `$ARGUMENTS` — optional. If provided as `<baseline-dir> <current-dir>`, use those paths; otherwise default to `.myopex-baseline` and `.myopex-current`.

**Procedure:**

1. **Preflight.** Check for `myopex.scenarios.ts` at the project root. If missing, stop and ask the user whether to:
   (a) write one by reading the app's routes and components, or
   (b) run a single-state capture via `myopex capture` instead.

2. **Check baseline exists.** Look for the baseline directory (default `.myopex-baseline`). If missing, stop and tell the user:
   ```
   myopex scenarios --config myopex.scenarios.ts --out .myopex-baseline
   ```
   must be run first on a known-good branch. Do not proceed without a baseline.

3. **Capture current state.**
   ```
   myopex scenarios --config myopex.scenarios.ts --out <current-dir>
   ```
   If `--url` isn't in scope, myopex auto-starts the dev server via `npm run dev`. Watch stderr for the `Capture warnings:` block — any failed scenarios or zero-component regions must be resolved *before* continuing. Fixing those first avoids noise in the diff.

4. **Diff.**
   ```
   myopex diff --old <baseline-dir> --new <current-dir>
   ```
   `myopex diff` auto-detects the scenarios layout; point it at the parent directories. Per-scenario reports land in each scenario subdir; an aggregate `report.json` lands at the top of `<current-dir>`.

5. **READ `report.json` end to end.** Not the last line. Not the summary. The whole thing. Specifically read:
   - `totals.regressions` — any non-zero count means investigate
   - `totals.invariantFailures` — any non-zero count means investigate, even if regressions are zero
   - `scenarios[].pass` — any `false` entry needs explanation
   - `missingScenarios` / `addedScenarios` — shape change across the capture set

6. **Triage each finding.** For every failure in `invariants.failures` and `regressions.failures` across the per-scenario reports:
   - **Regressions:** decide real regression (fix the code) or intended change (capture a new baseline). Do not skip — pick one explicitly.
   - **Invariants:** decide real bug or false positive. Open `screenshotFile` if the YAML alone is ambiguous. Do NOT dismiss a whole block of invariants in bulk without confirming a representative sample.

7. **Report to the user in this exact shape:**

   ```
   N scenarios captured, K with warnings
   Regressions: X total — Y confirmed bugs, Z intended, W still to investigate
   Invariants:  A total — B confirmed bugs, C confirmed false positives, D still to investigate
   Missing components: ...
   ```

   Then, for each **confirmed bug**, list the composite ID, the property, the expected vs actual, and the screenshot path. Propose a concrete fix. For each **false positive**, name why it's a false positive (e.g., "transparent bg on testid button inheriting from header") so the user can sanity-check your triage.

8. **Do not say "passed"** unless every bucket is zero or triaged with a conclusion. "Command completed without errors" is not a pass.

**Anti-patterns to avoid:**

- Running `myopex scenarios` and reporting success because no scenario threw (scenarios captured ≠ scenarios passed).
- Running `myopex diff`, reading only the `Summary:` line, and missing the block of per-finding output above it.
- Dismissing "77 transparent background" invariants as noise without opening one screenshot.
- Calling missing components a "nit" — a button that was present in baseline and absent in current almost always represents a real regression.

For deeper guidance on interpreting the report — thresholds, composite ID anatomy, anomaly patterns — the `myopex` skill's `references/reading-diff.md` and `references/reading-yaml.md` have the details.
