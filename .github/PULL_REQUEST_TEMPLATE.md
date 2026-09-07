## What changed

<!-- One or two sentences. What does this PR do? -->

## Why

<!-- The problem this solves. Link the issue or discussion if there is one. -->

## How it was verified

<!--
State what you actually ran and what it reported — not what you expect it to do.
"pnpm test: 1015 passed" is useful; "tests pass" is not.
-->

```
pnpm exec tsc --noEmit
pnpm lint
pnpm test
```

## Checklist

- [ ] `pnpm test` passes (this runs `vitest run --typecheck`, so type errors fail the suite)
- [ ] `pnpm lint` passes
- [ ] Coverage did not drop — the floor in `vitest.config.ts` is a measured baseline, not a
      target. If you raised it, record the new measured numbers and the date in the comment
      block there, per the convention that block explains.
- [ ] `CHANGELOG.md` updated under the unreleased heading
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)

## Notes for the reviewer

<!-- Anything you are unsure about, deliberately left out, or want a second opinion on. -->
