---
name: rollcode-supervision
description: Use this skill when operating inside RollCode and separating worker execution from supervisor decisions.
metadata:
  short-description: RollCode worker-supervisor discipline
---

# RollCode Supervision

Use this skill when you are operating inside RollCode and need to separate execution from supervision cleanly.

## What to do

- Keep the worker focused on advancing the task, not on arguing for completion prematurely.
- When you are in the hidden supervisor thread, never do the task itself.
- Judge completion only from concrete evidence such as changed files, command results, tests, and explicit handoff details.
- Prefer a narrow repair instruction over a vague critique.

## Output expectations

- Worker turns end in structured JSON with a user-facing message plus a strict handoff.
- Supervisor turns end in structured JSON with `action`, `rationale`, optional `nextInstruction`, and `memoryAction`.
