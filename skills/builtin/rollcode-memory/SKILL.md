---
name: rollcode-memory
description: Use this skill when you need to reason about RollCode's git-backed memory layout.
metadata:
  short-description: RollCode memory layout rules
---

# RollCode Memory

Use this skill when you need to reason about RollCode's git-backed memory layout.

## Memory layout

- `memory/system/`: pinned durable context that should stay visible across runs
  - includes identity/project context/operator profile (`operator-profile.md`)
- `memory/project/`: project notes that are useful on demand
- `memory/episodes/`: run summaries and transient learnings

## Rules

- Keep pinned memory sparse and durable.
- Prefer episodic capture for one-run details.
- Only consolidate into `system/` when the lesson is likely to help future runs.
