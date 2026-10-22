# CI Speed Research

## Current timings (GitHub Actions, run 39142013426)

- typecheck workflow: ~2m10s total (single 4vcpu runner, no Turbo cache step)
- test workflow unit (linux): ~7m (tests step ~7m)
- test workflow unit (windows): ~18m (setup Bun ~3.5m, tests ~13.5m)
- test workflow e2e (linux): ~8m
- test workflow e2e (windows): ~26m

## Bottlenecks

1. `typecheck.yml` has no Turbo cache restore/save step (unlike `test.yml`).
2. Windows Bun setup ~3.5m and test runtime ~2x linux.
3. `bun turbo test` runs all packages on one runner; no sharding.
4. Turbo `typecheck` task has no outputs and is not cached remotely.
5. Native deps (`@opentui/*`, `@ff-labs/*`) slow installs.

## Proposed optimizations

0. Add Turbo cache to typecheck.yml (low risk).
1. Shard unit tests across multiple runners (matrix) for linux/windows.
2. Enable Turbo remote cache or artifact cache for typecheck/test.
3. Reduce Windows setup time via cached Bun + node_modules.
4. Run typecheck per-package in parallel with fail-fast grouping.
5. Profile slowest test files and optimize fixtures (already ongoing in perf/test-suite.md).

## Next steps

- Implement (0) and (1) first, measure before/after.
