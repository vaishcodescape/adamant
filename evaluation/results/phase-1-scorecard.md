# Phase 1 deterministic evaluation

Evaluated cases: **0/3**

Acceptable outcomes among evaluated cases: **0/0 (n/a)**

| Category                    | Count |
| --------------------------- | ----: |
| Fixed                       |     0 |
| Correct give-up/report-only |     0 |
| Incorrect patch             |     0 |
| Failed repair               |     0 |
| Not evaluated               |     3 |

Total attempts: **0**

Total elapsed time: **0 ms**

| Case                        | Expected           | Actual                                                                                    | Baseline | Patched | Attempts | Elapsed | Category      |
| --------------------------- | ------------------ | ----------------------------------------------------------------------------------------- | -------- | ------- | -------: | ------: | ------------- |
| unit-test assertion failure | repair and pass CI | baseline CI failed with AssertionError: 120 !== 80; Adamant repair not run                | failure  | not-run |        0 |    0 ms | not-evaluated |
| TypeScript compile failure  | repair and pass CI | baseline CI failed with TS2741 for a missing environment property; Adamant repair not run | failure  | not-run |        0 |    0 ms | not-evaluated |
| path-security failure       | repair and pass CI | baseline CI failed because PathTraversalError was not thrown; Adamant repair not run      | failure  | not-run |        0 |    0 ms | not-evaluated |
