# Contributing to RollCode

Thanks for contributing. This guide explains how to make changes that are easy to review and safe to merge.

## Before You Start

1. Search existing issues/PRs to avoid duplicate work.
2. For non-trivial changes, open an issue first and align on scope.
3. Keep one concern per PR (feature, fix, docs, or tooling).

## Local Setup

Requirements:

- Bun `>=1.3.0`
- Git

Install and run locally:

```bash
bun install
bun run dev
```

## Development Workflow

Recommended validation sequence:

```bash
bun run typecheck
bun run test
bun run build
```

Optional (style/static checks):

```bash
bun run lint
```

Notes:

- If you touch formatting-heavy files, run `bun run fix` before opening a PR.

## Changelog and Release Notes

`CHANGELOG.md` is the source of truth for release notes.

When preparing a new version:

1. Bump `package.json` version.
2. Add a matching section to `CHANGELOG.md` (for example `## [0.0.3] - 2026-03-23`) with at least one change line.
3. Run:

```bash
bun run release:sync-notes
```

Publishing runs this automatically via `prepublishOnly` (`release:sync-notes && build`). If changelog parsing fails, or the current version section is missing/empty, publish is blocked.

## Branches and Commits

- Branch naming: `feat/...`, `fix/...`, `docs/...`, `chore/...`
- Commit messages: short imperative summary (for example `fix memory diff rendering`)
- Keep commits focused and avoid unrelated file churn.

## Pull Request Expectations

Every PR should include:

- clear problem statement
- implementation summary (what changed and why)
- test evidence (commands run + result)
- migration notes if behavior/config changed

Use this structure in the PR description:

```md
## TL;DR
What:
Why:
How:

## Validation
- [ ] bun run typecheck
- [ ] bun run test
- [ ] bun run build
- [ ] (optional) bun run lint
```

## CI Policy

The main CI workflow runs on `pull_request` and `push` to `main`.

Required checks:

- typecheck
- tests
- build
- CLI smoke (`--help`, `--version`, `info`)
- lint (blocking for changed `src/**/*.ts(x)` and `test/**/*.ts(x)` files)

## AI-Assisted Contributions

AI-assisted PRs are welcome. Please:

- disclose AI usage in the PR
- verify behavior with real commands/tests
- be able to explain the code and tradeoffs

## Security

Do not open public issues for security vulnerabilities.
Report privately to maintainers (or use GitHub private vulnerability reporting if enabled).
