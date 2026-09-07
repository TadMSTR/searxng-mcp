# Contributing to searxng-mcp

## What to work on

**Planning for this project is tracked outside GitHub, so the Issues tab is intentionally
quiet.** An empty Issues tab usually means a project is abandoned; here it means the backlog
lives somewhere else. The work is happening — see `CHANGELOG.md`, which is maintained per
release and is the honest record of what has changed.

- **Proposing work, asking a question, or floating an idea** →
  [Discussions](https://github.com/TadMSTR/searxng-mcp/discussions). This is the right door
  for anything open-ended, and for "would you accept a PR that does X" before you write it.
- **Bug reports** → [Issues](https://github.com/TadMSTR/searxng-mcp/issues). Those still
  belong here, and there are templates for them.
- **Security vulnerabilities** → **not** a public issue. See [SECURITY.md](SECURITY.md) for the
  private disclosure channels.

Small, self-contained PRs are welcome without asking first. For anything that changes the fetch
cascade, the domain capability database, or a tool's contract, open a Discussion first — those
have invariants that are not obvious from the code alone, and it is cheaper to talk than to
rework.

## Prerequisites

- **Node.js 20+** (`engines` requires `>=20`; CI runs the suite on both 20 and 22)
- **pnpm 10.30.3+** (pinned in `packageManager`)

pnpm specifically, not npm: `package-lock.json` is gitignored, and `pnpm-lock.yaml` is the only
audited dependency tree CI tests against. An `npm install` resolves a different one.

## Setup

```bash
git clone https://github.com/TadMSTR/searxng-mcp.git
cd searxng-mcp
pnpm install --frozen-lockfile
pnpm build
```

## The three commands CI gates on

```bash
pnpm exec tsc --noEmit   # type check
pnpm lint                # Biome — check and report (pnpm lint:fix to auto-fix)
pnpm test                # vitest run --typecheck
```

All three must pass before a PR can merge. Run them locally first; it is faster than a CI round
trip.

**`pnpm test` runs `vitest run --typecheck`.** That is not the same as `vitest run` — type errors
in test files fail the suite, not just runtime assertions. If the suite fails with `Type Errors`
in the summary and no failing assertion, that is what happened.

## Coverage

Coverage is gated in CI and enforced by `vitest.config.ts`:

| Metric | Floor | Measured 2026-09-07 |
|---|---|---|
| Lines | 90% | 92.53% |
| Statements | 89% | 90.47% |
| Functions | 87% | 88.93% |
| Branches | 85% | 85.09% |

```bash
pnpm coverage
```

**Read the comment block above `thresholds:` in `vitest.config.ts` before changing these.** It
records what was measured and when, and why the margins are what they are. The short version: the
floor once went ten releases untouched while real coverage climbed twelve points, so the gate
silently permitted a twelve-point regression.

**Branches has only ~0.09 points of headroom — about two branches.** That is deliberate: the
floor is pinned at the target rather than set below it, so the coverage just achieved cannot slip
away unnoticed. If your change costs those two branches, cover them.

If you do move a floor, record the new measured numbers and the date in that comment, the way the
existing entries do. A floor with no provenance is indistinguishable from a stale one.

**Do not lower the floor to make a PR pass.**

## Running locally

The only required environment variable is `SEARXNG_URL`. Everything else is optional and the
server degrades gracefully — the startup capability line reports exactly what is configured.

The quickest working setup is rung 2 of the compose ladder:

```bash
cd examples
export SEARXNG_SECRET=$(openssl rand -hex 32)
docker compose -f compose.crawl4ai.yml up -d
```

Then point the server at it:

```bash
SEARXNG_URL=http://localhost:8081 CACHE_URL=redis://localhost:6381 \
  FIRECRAWL_ENABLED=false RERANKER_URL= \
  node build/src/index.js
```

**A bare `docker run searxng/searxng` will not work.** SearXNG serves HTML only by default, and
every searxng-mcp call requests `format=json` — against a stock instance every call fails with a
403, which reads like an authentication problem rather than a missing output format. The ladder's
`examples/searxng/settings.yml` enables it; if you bring your own SearXNG, see
[`docs/configuration.md`](docs/configuration.md#searxng).

See [`examples/`](examples/) for all four rungs. Each file's header states what works at that
rung and what does not.

### Integration tests

A real-Valkey suite covering domain-DB concurrency is gated on `VALKEY_TEST_URL` and skipped
entirely when unset, so a plain `pnpm test` works with no Valkey present:

```bash
VALKEY_TEST_URL=redis://:<password>@<host>:<port>/<scratch-db> pnpm test
```

Use a **scratch database index** — the suite writes and deletes `domain:*` keys, and refuses to
run against index `0` or `1` as a safety guard.

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/), with a `type(scope):` prefix:

| Type | When |
|------|------|
| `feat` | New capability |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `chore` | Build, deps, tooling |
| `security` | Security fix |
| `refactor` | Code restructure, no behavior change |
| `test` | Test additions or fixes |
| `perf` | Performance, no behavior change |

Examples: `feat(kiwix): add zim routing`, `fix(domain-db): atomic write race`

`git log` is **not** a uniform sample of this, and it is worth knowing why before you copy a
neighbouring commit's style: PRs are squash-merged, so the merge commit on `main` carries the PR
title rather than a conventional prefix, and commits from before v3.4 predate the convention
entirely. Of the last 100 non-merge, non-squash commits, 95 conform and the 5 that do not are all
pre-v3.4. Follow the convention in the commits you write.

**Write the body for the next reader, not for the diff.** This repo's convention is to record the
reason and the incident behind a change, not just the rule — see `.gitignore`, `vitest.config.ts`
and any `examples/compose.*.yml` header for what that looks like in practice. If you verified
something by running it, say what you ran and what it reported.

## CHANGELOG

`CHANGELOG.md` is maintained per release, in [Keep a Changelog](https://keepachangelog.com/)
format. **PRs are expected to update it** under an `## [Unreleased]` heading, adding one if it is
not there.

Write the entry for someone deciding whether to upgrade. A bug-fix entry that does not say what
the wrong behaviour looked like is not useful to anyone trying to work out whether they hit it.

## PR process

1. Fork, and branch as `feat/<slug>` or `fix/<slug>`.
2. Make your changes. `pnpm exec tsc --noEmit`, `pnpm lint` and `pnpm test` must all pass, and
   coverage must not drop below the floor.
3. Update `CHANGELOG.md`.
4. Open a PR against `main`. The template asks what changed, why, and how you verified it —
   for the last one, state what you actually ran and what it reported.
5. CI runs automatically. Merge requires CI green.

Every PR is reviewed by [@TadMSTR](https://github.com/TadMSTR) (see `.github/CODEOWNERS`). This
is a personal project maintained by one person, so review is best-effort on timing.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
