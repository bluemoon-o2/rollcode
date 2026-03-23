<p align="center">
  <img
    alt="RollCode Banner"
    src="https://capsule-render.vercel.app/api?type=waving&height=220&color=0:0f172a,35:1d4ed8,70:0ea5e9,100:22c55e&text=RollCode&fontSize=62&fontColor=ffffff&fontAlignY=38&desc=Persistent%20Coding%20Runtime&descAlignY=58&descSize=18"
  />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bluemoon-o2/rollcode"><img alt="npm" src="https://img.shields.io/npm/v/@bluemoon-o2/rollcode.svg?style=for-the-badge" /></a>
  <a href="https://www.npmjs.com/package/@bluemoon-o2/rollcode"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@bluemoon-o2/rollcode?style=for-the-badge" /></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@bluemoon-o2/rollcode?style=for-the-badge" /></a>
  <a href="https://discord.gg/u6T5e2kGJm"><img alt="discord" src="https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white" /></a>
</p>

<p align="center">
  <a href="https://bun.sh/"><img alt="bun" src="https://img.shields.io/badge/Bun-%3E%3D1.3-000000?style=flat-square&logo=bun" /></a>
  <a href="https://www.typescriptlang.org/"><img alt="typescript" src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" /></a>
  <a href="#get-started"><img alt="runtime" src="https://img.shields.io/badge/runtime-codex%20app--server-111827?style=flat-square" /></a>
</p>

<p align="center">
  <strong>Persistent coding runtime on top of <code>codex app-server</code>.</strong><br/>
  Worker/supervisor orchestration · git-backed memory · evidence-gated completion.
</p>

<p align="center">
  <a href="#get-started">Get Started</a> ·
  <a href="#cli-reference">CLI</a> ·
  <a href="#agent-memory">Memory</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="#star-history">Stars</a> ·
  <a href="#contributors">Contributors</a> ·
  <a href="#runtime-configuration">Configuration</a> ·
  <a href="#development">Development</a>
</p>

## Why RollCode

- worker/supervisor dual-lane orchestration
- deterministic runtime state machine + dispatch rules
- plan-analysis guardrails and completion gating
- runtime checkpoint persistence + supervisor resume recovery
- worker loop stall guard (repeat/oscillation without plan progress)
- git-backed memory with commit history per agent
- optional git worktree isolation per run
- optional parallel worker lanes (`adaptive` or `always`)
- parallel helper circuit breaker with cooldown re-enable
- reusable skills from bundled/global/agent/project scopes
- namespaced skill registry + alias/local-first/ambiguous resolution
- skill preference orchestration (`always/prefer/avoid/skill_rules`)
- runtime skill telemetry + stale-skill diagnostics

## Philosophy

RollCode is designed for long-lived agents, not isolated chats.

| Session-based coding CLIs | RollCode runtime |
| --- | --- |
| conversation state is mostly tied to the current session | agent memory persists across sessions |
| completion can rely on narrative confidence | completion requires supervisor-approved evidence |
| memory is often ad-hoc (`AGENTS.md`, prompt habits) | memory is a git repo with inspectable history |
| orchestration is implicit | orchestration is explicit (`worker -> supervisor -> decision`) |

## Get Started

### Prerequisites

- [Bun](https://bun.sh/) `>=1.3.0`
- `codex` CLI available in `PATH` (RollCode starts `codex app-server --listen stdio://`)
- a valid Codex provider/account setup

### Install

```bash
npm install -g @bluemoon-o2/rollcode
```

### First Run

```bash
cd /path/to/your/repo
rollcode
```

In launcher:

1. run `/codex` to configure provider/auth/model
2. enter your goal in plain language to start the run

### Run From Source

```bash
git clone <this-repo-url>
cd rollcode
bun install
bun run build
./rollcode.js
```

## CLI Reference

```bash
rollcode
rollcode --help
rollcode --version
rollcode run "<goal>" [--detach] [--agent <agentId>]
rollcode resume [--run <runId>]
rollcode attach <runId>
rollcode agents
rollcode info
rollcode memory [status|diff|log] [--agent <agentId>]
rollcode doctor [--fix]
```

Notes:

- `run --detach` runs the autonomous loop without opening the interactive TUI (currently in the same process).
- `attach` supports run id prefixes.
- `memory` inspects the current agent by default (or `--agent <id>`).

## In-Session Commands

Common slash commands during a run:

- `/supervisor [on|off|status]` toggle or inspect supervisor details
- `/resume` continue autonomous progress
- `/memory [status|profile|remember <text>]` inspect memory, view operator profile, or store a durable preference
- `/skills` list resolved skills for this run
- `/skills reload` manually reload the skill catalog for the active run
- `/doctor` run runtime health checks
- `/doctor fix` run checks and apply safe fixes
- `/hotkeys` show keyboard shortcuts
- `/changelog` show release notes/changelog entries
- `/feedback <message>` submit a GitHub Discussion via `gh api graphql` in category `general`
- `/codex` open Codex provider configuration dialog
- `/exit` leave current session

## Agent Memory

Each agent gets its own git memory repository under:

```text
$ROLLCODE_HOME/agents/<agent-id>/memory
```

Useful inspections:

```bash
rollcode memory status
rollcode memory diff
rollcode memory log
```

Memory files are markdown with frontmatter (`description`, `limit`, etc.), and updates are committed so you can audit learning over time.
During turns, RollCode adds task-scoped memory recall from non-system files, and each file's `limit` bounds how much content can be injected into prompts.
Default memory layout is:

- `system/identity.md`: agent identity and operating rules
- `system/project-context.md`: durable project context
- `system/operator-profile.md`: Letta-style durable operator preference profile
- `project/*`: on-demand project notes
- `episodes/*`: run-level episodic summaries

When operators send steering messages, RollCode can capture durable preference signals into `system/operator-profile.md` (deduplicated, timestamped) so future runs inherit personalization.

## Skills Resolution

RollCode discovers `SKILL.md` from:

1. `skills/builtin` (bundled)
2. `$ROLLCODE_HOME/skills` (global)
3. `$ROLLCODE_HOME/agents/<agent-id>/skills` (agent)
4. `<project>/.skills` (project)

Priority is: `project > agent > global > bundled`.
Resolved skills are mirrored for Codex under:

```text
~/.codex/skills/rollcode/shared
```

If a skill root includes `.claude-plugin/marketplace.json`, RollCode resolves local
plugin sources and imports each plugin's `skills/` directory into discovery.

Skill preferences (optional JSON):

- global: `$ROLLCODE_HOME/skill-preferences.json`
- project: `<project>/.skills/preferences.json`

Supported keys:

- `always_use_skills`
- `prefer_skills`
- `avoid_skills`
- `skill_rules`
- `skill_aliases`
- `skill_discovery` (`auto` | `suggest` | `off`)
- `skill_staleness_days` (`0` disables stale detection)

## Runtime Configuration

Key environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `ROLLCODE_HOME` | `~/.rollcode` | RollCode state root |
| `ROLLCODE_CODEX_CONFIG_DIR` | `CODEX_HOME` or `~/.codex` | Codex auth/config directory |
| `ROLLCODE_CODEX_SKILLS_MIRROR_DIR` | `~/.codex/skills/rollcode` | where resolved skills are mirrored |
| `ROLLCODE_MAX_TURNS_PER_RUN` | `24` | turn cap before supervisor must finish/block |
| `ROLLCODE_MEMORY_REMINDER_INTERVAL` | `12` | turns between explicit memory reminders |
| `ROLLCODE_AUTO_RETRY_ENABLED` | `true` | enable transient failure retries |
| `ROLLCODE_AUTO_RETRY_MAX_RETRIES` | `3` | max retry attempts |
| `ROLLCODE_AUTO_RETRY_BASE_DELAY_MS` | `2000` | retry backoff base delay |
| `ROLLCODE_AUTO_RETRY_MAX_DELAY_MS` | `60000` | retry backoff max delay |
| `ROLLCODE_PARALLEL_WORKERS_ENABLED` | `true` | enable helper worker lanes |
| `ROLLCODE_PARALLEL_WORKER_LANES` | `2` | total lanes (primary + helpers) |
| `ROLLCODE_PARALLEL_EXECUTION_MODE` | `adaptive` | `adaptive` or `always` |
| `ROLLCODE_PARALLEL_HELPER_EXECUTOR` | `thread` | helper lane executor (`thread` or `process`) |
| `ROLLCODE_PARALLEL_HELPER_ERROR_THRESHOLD` | `2` | helper-error streak to open helper circuit |
| `ROLLCODE_PARALLEL_HELPER_CIRCUIT_COOLDOWN_TURNS` | `2` | worker turns to keep helper circuit open |
| `ROLLCODE_LOOP_STALL_REPEAT_THRESHOLD` | `3` | repeated-worker-loop threshold before blocking |
| `ROLLCODE_SKILL_DISCOVERY_MODE` | `auto` | `auto`, `suggest`, or `off` for in-run skill catalog refresh |
| `ROLLCODE_SKILL_STALENESS_DAYS` | `60` | days without usage before stale-skill diagnostics (`0` disables) |
| `ROLLCODE_WORKER_COLLABORATION_MODE` | `plan` | worker turn collaboration mode (`default` or `plan`) |
| `ROLLCODE_SUPERVISOR_COLLABORATION_MODE` | `default` | supervisor turn collaboration mode (`default` or `plan`) |
| `ROLLCODE_TASK_ISOLATION_MODE` | `none` | `none` or `worktree` |

Run checkpoint metadata is persisted per run at:

```text
$ROLLCODE_HOME/agents/<agent-id>/events/<run-id>.checkpoint.json
```

Session heartbeat/status metadata is persisted at:

```text
$ROLLCODE_HOME/agents/<agent-id>/events/<run-id>.session.json
```

## Development

```bash
bun install
bun run build
bun run typecheck
bun run lint
bun test ./test/*.test.ts
```

## Release Notes Workflow

```bash
# 1) bump package.json version
# 2) add matching section in CHANGELOG.md
bun run release:sync-notes
```

`npm publish`/`bun publish` will run `prepublishOnly`, which executes `release:sync-notes` and then `build`.
If the current version section is missing or empty in `CHANGELOG.md`, publish stops.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for:

- branch/commit expectations
- PR checklist and validation requirements
- AI-assisted contribution policy
- issue templates and triage workflow

## Star History

<p align="center">
  <a href="https://star-history.com/#bluemoon-o2/rollcode&Date">
    <img
      alt="Star History Chart"
      src="https://api.star-history.com/svg?repos=bluemoon-o2/rollcode&type=Date"
    />
  </a>
</p>

## Contributors

<p align="center">
  <a href="https://github.com/bluemoon-o2/rollcode/graphs/contributors">
    <img alt="Contributors" src="https://contrib.rocks/image?repo=bluemoon-o2/rollcode" />
  </a>
</p>

Current contributors (from git history):

- `bluemoon-o2`

## License

RollCode is licensed under Apache 2.0. See [LICENSE](./LICENSE).
