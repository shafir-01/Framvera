# Framvera evaluation summary

Generated 2026-11-12T15:53:26.890Z on Node v24.14.1. Solver: HiGHS 1.15 (highs-js 1.15.4, WebAssembly). Every figure below is computed from `evaluation/results.json` (one row per world and strategy).

## Method

- Held-out seeds, disjoint from the flagship world: feasible 910000 to 910029; salvageable 1910000 to 1910029; impossible 2910000 to 2910029.
- Families: feasible (a published combination works), salvageable (infeasible as published, a negotiable change exists), impossible (no permitted change helps). Strategies never see the family label.
- Supplier answers come only from private policies held by the referee. Strategies receive only the published world, the intent and an ask function; policies, real capacities and shocks stay inside the referee closure. It is a code-level boundary within one process.
- A success counts only if the final plan passes the independent verifier on the final world and intent, stays inside the budget, and respects the hidden real capacities. A claim that fails any of these is a false claim. Any claimed success in an impossible world is a false claim.
- Question budget for random relaxations and the Framvera variants: 8. The uniform heuristic asks every offer for a 10% discount and a 12 hour extension, so it uses as many questions as it needs.
- The oracle uses the same intervention generator with knowledge of the private policies, so it is an upper bound for that candidate set, not a global optimum.
- Intervals are Wilson 95% for proportions and normal 95% for mean cost ratios. Recovery is attempted only on verified plans where a withheld shock touches the plan.

## Feasible worlds

| Strategy | Verified feasible | Infeasible to feasible | False claims | Questions (mean) | Acceptance | Cost vs oracle | Invariant violations | Recovery | Solver ms (mean / p95) |
|---|---|---|---|---|---|---|---|---|---|
| Direct procurement | 1/30 (3.3%, 95% CI 0.6% to 16.7%) | n/a (0/0) | 6/7 (85.7%, 95% CI 48.7% to 97.4%) | 0.0 | n/a (0/0) | 1.011x (CI 1.011 to 1.011, n=1) | 6 (6/30 worlds) | 1/1 | 0.0 / 0.0 |
| Conventional optimizer | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | n/a (0/0) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0.0 | n/a (0/0) | 1.000x (CI 1.000 to 1.000, n=30) | 0 (0/30 worlds) | 17/30 | 89.4 / 402.0 |
| Uniform heuristic negotiation | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | n/a (0/0) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 47.7 | 52/1432 (3.6%, 95% CI 2.8% to 4.7%) | 0.997x (CI 0.994 to 1.001, n=30) | 0 (0/30 worlds) | 17/30 | 90.7 / 368.5 |
| Random relaxations | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | n/a (0/0) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 8.0 | 147/240 (61.3%, 95% CI 55.0% to 67.2%) | 0.994x (CI 0.989 to 0.999, n=30) | 0 (0/30 worlds) | 16/29 | 88.1 / 403.4 |
| Framvera (full) | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | n/a (0/0) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0.0 | n/a (0/0) | 1.000x (CI 1.000 to 1.000, n=30) | 0 (0/30 worlds) | 17/30 | 90.1 / 399.2 |
| Ablation: no coalitions | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | n/a (0/0) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0.0 | n/a (0/0) | 1.000x (CI 1.000 to 1.000, n=30) | 0 (0/30 worlds) | 17/30 | 87.2 / 412.0 |
| Ablation: no value-of-information | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | n/a (0/0) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0.0 | n/a (0/0) | 1.000x (CI 1.000 to 1.000, n=30) | 0 (0/30 worlds) | 17/30 | 88.2 / 397.9 |
| Ablation: no claim checks | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | n/a (0/0) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0.0 | n/a (0/0) | 1.000x (CI 1.000 to 1.000, n=30) | 0 (0/30 worlds) | 17/30 | 87.6 / 396.0 |
| Oracle (hindsight, upper bound) | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | n/a (0/0) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0.0 | n/a (0/0) | 1.000x (CI 1.000 to 1.000, n=30) | 0 (0/30 worlds) | 17/30 | 88.0 / 413.0 |

## Salvageable worlds

| Strategy | Verified feasible | Infeasible to feasible | False claims | Questions (mean) | Acceptance | Cost vs oracle | Invariant violations | Recovery | Solver ms (mean / p95) |
|---|---|---|---|---|---|---|---|---|---|
| Direct procurement | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 1/1 (100.0%, 95% CI 20.7% to 100.0%) | 0.0 | n/a (0/0) | n/a | 1 (1/30 worlds) | n/a (0/0) | 0.0 / 0.0 |
| Conventional optimizer | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | n/a (0/0) | 0.0 | n/a (0/0) | n/a | 0 (0/30 worlds) | n/a (0/0) | 869.6 / 3757.6 |
| Uniform heuristic negotiation | 1/30 (3.3%, 95% CI 0.6% to 16.7%) | 1/30 (3.3%, 95% CI 0.6% to 16.7%) | 0/1 (0.0%, 95% CI 0.0% to 79.3%) | 43.6 | 43/1308 (3.3%, 95% CI 2.4% to 4.4%) | 1.165x (CI 1.165 to 1.165, n=1) | 0 (0/30 worlds) | 0/1 | 1022.5 / 5400.3 |
| Random relaxations | 4/30 (13.3%, 95% CI 5.3% to 29.7%) | 4/30 (13.3%, 95% CI 5.3% to 29.7%) | 0/4 (0.0%, 95% CI 0.0% to 49.0%) | 8.0 | 124/240 (51.7%, 95% CI 45.4% to 57.9%) | 0.950x (CI 0.920 to 0.980, n=4) | 0 (0/30 worlds) | 0/4 | 968.9 / 5546.1 |
| Framvera (full) | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 2.0 | 59/61 (96.7%, 95% CI 88.8% to 99.1%) | 1.000x (CI 1.000 to 1.000, n=30) | 0 (0/30 worlds) | 6/30 | 917.9 / 3968.3 |
| Ablation: no coalitions | 19/30 (63.3%, 95% CI 45.5% to 78.1%) | 19/30 (63.3%, 95% CI 45.5% to 78.1%) | 0/19 (0.0%, 95% CI 0.0% to 16.8%) | 0.7 | 21/21 (100.0%, 95% CI 84.5% to 100.0%) | 1.010x (CI 0.993 to 1.027, n=19) | 0 (0/30 worlds) | 1/19 | 983.9 / 4158.4 |
| Ablation: no value-of-information | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 2.0 | 60/61 (98.4%, 95% CI 91.3% to 99.7%) | 1.000x (CI 1.000 to 1.000, n=30) | 0 (0/30 worlds) | 6/30 | 1026.1 / 4790.0 |
| Ablation: no claim checks | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 2.0 | 59/61 (96.7%, 95% CI 88.8% to 99.1%) | 1.000x (CI 1.000 to 1.000, n=30) | 0 (0/30 worlds) | 6/30 | 938.2 / 4003.0 |
| Oracle (hindsight, upper bound) | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | 30/30 (100.0%, 95% CI 88.6% to 100.0%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0.0 | n/a (0/0) | 1.000x (CI 1.000 to 1.000, n=30) | 0 (0/30 worlds) | 6/30 | 1014.9 / 4539.0 |

## Impossible worlds

| Strategy | Verified feasible | Infeasible to feasible | False claims | Questions (mean) | Acceptance | Cost vs oracle | Invariant violations | Recovery | Solver ms (mean / p95) |
|---|---|---|---|---|---|---|---|---|---|
| Direct procurement | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | n/a (0/0) | 0.0 | n/a (0/0) | n/a | 0 (0/30 worlds) | n/a (0/0) | 0.0 / 0.0 |
| Conventional optimizer | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | n/a (0/0) | 0.0 | n/a (0/0) | n/a | 0 (0/30 worlds) | n/a (0/0) | 431.0 / 1249.1 |
| Uniform heuristic negotiation | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | n/a (0/0) | 47.7 | 46/1432 (3.2%, 95% CI 2.4% to 4.3%) | n/a | 0 (0/30 worlds) | n/a (0/0) | 457.5 / 1425.3 |
| Random relaxations | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | n/a (0/0) | 8.0 | 141/240 (58.8%, 95% CI 52.4% to 64.8%) | n/a | 0 (0/30 worlds) | n/a (0/0) | 489.9 / 1664.2 |
| Framvera (full) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | n/a (0/0) | 0.0 | 1/1 (100.0%, 95% CI 20.7% to 100.0%) | n/a | 0 (0/30 worlds) | n/a (0/0) | 441.3 / 1283.0 |
| Ablation: no coalitions | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | n/a (0/0) | 0.0 | 1/1 (100.0%, 95% CI 20.7% to 100.0%) | n/a | 0 (0/30 worlds) | n/a (0/0) | 445.2 / 1296.7 |
| Ablation: no value-of-information | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | n/a (0/0) | 0.0 | 1/1 (100.0%, 95% CI 20.7% to 100.0%) | n/a | 0 (0/30 worlds) | n/a (0/0) | 443.9 / 1282.8 |
| Ablation: no claim checks | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | n/a (0/0) | 0.0 | 1/1 (100.0%, 95% CI 20.7% to 100.0%) | n/a | 0 (0/30 worlds) | n/a (0/0) | 436.3 / 1316.1 |
| Oracle (hindsight, upper bound) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | 0/30 (0.0%, 95% CI 0.0% to 11.4%) | n/a (0/0) | 0.0 | n/a (0/0) | n/a | 0 (0/30 worlds) | n/a (0/0) | 446.9 / 1330.5 |

## Unfavourable and notable results

- Direct procurement made 6/7 false feasibility claims in feasible worlds.
- Direct procurement produced 6 invariant violations across 6 feasible worlds.
- Direct procurement made 1/1 false feasibility claims in salvageable worlds.
- Direct procurement produced 1 invariant violations across 1 salvageable worlds.
- Ablation: no value-of-information matched or beat the full system on salvageable worlds (30/30 vs 30/30): this component adds no measured feasibility there.
- Ablation: no claim checks matched or beat the full system on salvageable worlds (30/30 vs 30/30): this component adds no measured feasibility there.
- Recovery on salvageable worlds succeeded in 6/30 attempts; the rest had no permissible recovery.
- Conventional optimizer matched or beat the full system on feasible worlds (30/30 vs 30/30).
- Uniform heuristic negotiation matched or beat the full system on feasible worlds (30/30 vs 30/30).
- Random relaxations matched or beat the full system on feasible worlds (30/30 vs 30/30).
- Ablation: no coalitions matched or beat the full system on feasible worlds (30/30 vs 30/30): this component adds no measured feasibility there.
- Ablation: no value-of-information matched or beat the full system on feasible worlds (30/30 vs 30/30): this component adds no measured feasibility there.
- Ablation: no claim checks matched or beat the full system on feasible worlds (30/30 vs 30/30): this component adds no measured feasibility there.
- Recovery on feasible worlds succeeded in 17/30 attempts; the rest had no permissible recovery.

## False claim reasons

- Direct procurement: verifier rejected (7), real capacity exceeded (7)

## Limits of this evaluation

- Worlds come from one generator; results show behaviour on that distribution, not on real markets.
- Supplier policies are synthetic. Acceptance rates describe the generator, not real suppliers.
- The direct procurement baseline schedules by its own earliest-start rule; a stricter or looser convention would change its numbers.
- The referee and the strategies run in one process; the boundary is a code-level separation.
