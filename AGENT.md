# AGENT.md

This file defines how coding agents should operate inside the RollCode repository.

## Mission

- Ship small, correct, reviewable changes.
- Preserve runtime stability for `rollcode` CLI.
- Keep docs/tests aligned with behavior changes.

## Project Snapshot

- Runtime: Bun + TypeScript
- Entry: `src/index.ts`
- Core orchestration: `src/runtime/service.ts`
- Runtime state/dispatch logic: `src/runtime/orchestration.ts`
- Planning helpers: `src/runtime/planning.ts`
- Codex bridge: `src/codex/client.ts`
- Memory system: `src/memory/*`
- TUI: `src/tui/*`
- Tests: `test/*.test.ts`

## Working Rules

- Do not use destructive git commands (`reset --hard`, force checkout) unless explicitly requested.
- Never revert user-authored unrelated changes.
- Prefer minimal diffs over broad refactors.
- Keep file naming and style consistent with existing codebase.
- Use `rg` for search and targeted edits.

## Required Local Validation

Run these before claiming completion:

```bash
bun run typecheck
bun run test
bun run build
```

Advisory check (recommended):

```bash
bun run lint
```

Notes:

- CI treats lint as advisory for now due to existing baseline issues.
- Build output is `rollcode.js`; type declarations are emitted via `tsconfig.types.json`.

## Change-Specific Expectations

- If CLI flags/commands change:
  - update `src/cli.ts` tests in `test/cli.test.ts`
  - update command docs in `README.md`
- If prompt contracts change:
  - update `test/prompts.test.ts`
- If runtime state transitions change:
  - update runtime/orchestration tests (`test/runtime*.test.ts`)
- If env vars/defaults change:
  - update `README.md` runtime configuration table

## Definition of Done

A change is done only if:

1. Behavior is implemented and scoped correctly.
2. Relevant tests are added/updated.
3. `typecheck`, `test`, and `build` pass locally.
4. Docs are updated when user-facing behavior changes.
5. Risks/limitations are explicitly called out in handoff.

## PR Hygiene

- One concern per PR.
- Include TL;DR (`What`, `Why`, `How`).
- Include validation evidence (commands run + result).
- Disclose AI assistance when applicable.

See also: [CONTRIBUTING.md](./CONTRIBUTING.md)
