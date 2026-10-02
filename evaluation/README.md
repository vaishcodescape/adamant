# Evaluation scorecard

Record deterministic evaluation results in the fixture JSON, then generate both reviewable and
machine-readable reports with one command:

```bash
pnpm eval:scorecard
```

The default command reads `evaluation/fixtures/phase-1-three-case-results.json` and replaces the
committed JSON and Markdown files under `evaluation/results/`. To use another result set or output
location:

```bash
pnpm eval:scorecard --input results.json --json scorecard.json --markdown scorecard.md
```

Each case records its name, expected and actual outcomes, baseline and patched verdicts, repair
attempt count, elapsed milliseconds, and one final category:

- `fixed`
- `correct-give-up-or-report-only`
- `incorrect-patch`
- `failed-repair`
- `not-evaluated` for a fixture whose baseline evidence exists but has not gone through an Adamant
  repair run yet

The acceptable-outcome rate counts both a valid fix and a correct decision not to patch, and it
excludes pending `not-evaluated` cases from the denominator. Optional `sourceSha` and `evidenceUrl`
fields keep each record tied to its fixture evidence. The reporter only scores supplied results; it
does not invoke or change the agent or model.
