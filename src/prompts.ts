import type {
  CommandExecutionRecord,
  SupervisorDecision,
  TurnArtifacts,
  WorkerHandoff,
} from "./domain/types";
import type { MemoryPromptContext } from "./memory/manager";

const SUPERVISOR_REVIEW_PROMPT_BUDGET_CHARS = 12_000;
const SUPERVISOR_MAX_HANDOFF_ITEMS = 16;
const SUPERVISOR_MAX_PLAN_STEPS = 24;
const SUPERVISOR_MAX_COMMAND_EXECUTIONS = 12;

function clamp(input: string, max = 6000): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max)}\n...[truncated by RollCode]`;
}

function clampTail(input: string, max = 6000): string {
  if (input.length <= max) {
    return input;
  }
  return `...[truncated by RollCode]\n${input.slice(-max)}`;
}

function compactStringList(
  items: string[],
  maxItems: number,
  maxItemChars: number,
): string[] {
  const limited = items.slice(0, maxItems).map((entry) => clamp(entry, maxItemChars));
  const omitted = Math.max(0, items.length - maxItems);
  if (omitted > 0) {
    limited.push(`[...${omitted} more entries omitted]`);
  }
  return limited;
}

function compactWorkerHandoff(handoff: WorkerHandoff): WorkerHandoff {
  return {
    summary: clamp(handoff.summary, 900),
    evidence: compactStringList(
      handoff.evidence,
      SUPERVISOR_MAX_HANDOFF_ITEMS,
      220,
    ),
    unresolved: compactStringList(
      handoff.unresolved,
      SUPERVISOR_MAX_HANDOFF_ITEMS,
      220,
    ),
    completionClaim: handoff.completionClaim,
  };
}

function compactPlan(plan: TurnArtifacts["plan"]): TurnArtifacts["plan"] {
  const limited = plan.slice(0, SUPERVISOR_MAX_PLAN_STEPS).map((step) => ({
    step: clamp(step.step, 180),
    status: step.status,
  }));
  const omitted = Math.max(0, plan.length - SUPERVISOR_MAX_PLAN_STEPS);
  if (omitted > 0) {
    limited.push({
      step: `[...${omitted} more plan steps omitted]`,
      status: "pending",
    });
  }
  return limited;
}

function compactCommandExecutions(
  commandExecutions: CommandExecutionRecord[] | undefined,
): string {
  if (!Array.isArray(commandExecutions) || commandExecutions.length === 0) {
    return "(no structured command executions recorded)";
  }
  const kept = commandExecutions.slice(-SUPERVISOR_MAX_COMMAND_EXECUTIONS);
  const omitted = Math.max(0, commandExecutions.length - kept.length);
  const summary: Array<Record<string, unknown>> = kept.map((entry) => ({
    id: entry.id,
    command: clamp(entry.command, 240),
    phase: entry.phase,
    success: entry.success,
    exitCode: entry.exitCode,
    outputChars: entry.output.length,
  }));
  if (omitted > 0) {
    summary.unshift({
      omittedExecutions: omitted,
      note: "earlier command executions omitted",
    });
  }
  return JSON.stringify(summary, null, 2);
}

interface TruncationResult {
  content: string;
  droppedSections: number;
}

// gsd-2 alignment: section-boundary truncation, avoid mid-section cuts.
function truncateAtSectionBoundary(
  content: string,
  budgetChars: number,
): TruncationResult {
  if (!content || content.length <= budgetChars) {
    return { content, droppedSections: 0 };
  }

  const sections = splitIntoSections(content);
  if (sections.length <= 1) {
    const truncated = content.slice(0, budgetChars);
    return {
      content: `${truncated}\n\n[...truncated 1 sections]`,
      droppedSections: 1,
    };
  }

  let usedChars = 0;
  let keptCount = 0;
  for (const section of sections) {
    const sectionLen = section.length;
    if (usedChars + sectionLen > budgetChars && keptCount > 0) {
      break;
    }
    usedChars += sectionLen;
    keptCount += 1;
    if (usedChars >= budgetChars) {
      break;
    }
  }

  const droppedCount = sections.length - keptCount;
  if (droppedCount <= 0) {
    return { content, droppedSections: 0 };
  }
  const kept = sections.slice(0, keptCount).join("");
  return {
    content: `${kept.trimEnd()}\n\n[...truncated ${droppedCount} sections]`,
    droppedSections: droppedCount,
  };
}

function splitIntoSections(content: string): string[] {
  const pattern = /^(?=### |\-{3,}\s*$)/m;
  return content.split(pattern).filter((part) => part.length > 0);
}

function nowLabel(): string {
  return new Date().toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

export function buildWorkerBasePrompt(args: {
  cwd: string;
  memory: MemoryPromptContext;
  skillsSummary: string;
}): string {
  return `
You are the RollCode worker context (execution lane).

This thread executes implementation work. The hidden supervisor thread evaluates evidence separately.

Worker constraints:
- Do real implementation work: inspect files, edit code, run verification, and report results.
- Keep user-facing output concise and concrete.
- Do not emit meta-orchestration commentary.
- Runtime infra owns state transitions, retries, and parallel lane policy.
- Completion is evidence-driven: claim done only when artifacts and checks support it.

Current date/time:
${nowLabel()}

Current working directory (execution scope):
${args.cwd}

Resolved skills (available helpers):
${args.skillsSummary}

Pinned memory (highest priority):
${args.memory.pinnedSections}

Memory filesystem tree:
${args.memory.memoryTree}

Available non-system memory:
${args.memory.memoryIndex}

Recent episodic memory:
${args.memory.recentEpisodes}

Retrieved memory context:
${args.memory.retrievedContext}
  `.trim();
}

export function buildWorkerDeveloperPrompt(): string {
  return `
Operational expectations:
- Output must be strict JSON only. No markdown fences. No prose outside JSON.
- Required JSON shape:
  {
    "userMessage": "...",
    "handoff": {
      "summary": "...",
      "evidence": ["..."],
      "unresolved": ["..."],
      "completionClaim": false
    }
  }
- \`userMessage\` should be brief and user-facing.
- \`handoff.evidence\` must contain concrete proofs (files changed, commands/tests, observable outcomes).
- If still in progress, set \`completionClaim=false\` and list unresolved risks/gaps.
- If claiming completion, set \`completionClaim=true\` only when evidence is specific and verifiable.
- Keep task progress synchronized with \`update_plan\` (initialize/refresh plan steps as work progresses).
- Before finalizing a turn, ensure plan state reflects this turn's outcomes.
- If a critical choice depends on operator preference or missing constraints, use \`request_user_input\` with one concise question.
  `.trim();
}

export function buildSupervisorBasePrompt(args: {
  cwd: string;
  memory: MemoryPromptContext;
}): string {
  return `
You are the hidden RollCode supervisor context (review lane).

You must not execute the task. You only evaluate the worker evidence packet.

Supervisor constraints:
- Never do implementation work.
- Decide only one action: continue, repair, complete, or blocked.
- Judge completion from concrete evidence (diff/tests/command output/handoff), not tone.
- Runtime infra owns loop orchestration; this lane only reviews evidence quality.
- Always include nextInstruction. For continue/repair it must be specific and actionable; use an empty string when no follow-up instruction is needed.
- If evidence is weak, ambiguous, or under-verified, choose repair.

Decision rubric:
- complete: goal satisfied and evidence quality is strong.
- repair: task drift, missing verification, weak evidence, or risky gaps.
- continue: valid progress with a clear next best step.
- blocked: external blocker that cannot be resolved within current execution lane.

Memory action rubric:
- none: no durable learning.
- review: capture episodic lesson/checkpoint.
- consolidate: update durable project memory and episodic checkpoint.

Current date/time:
${nowLabel()}

Current working directory (review scope):
${args.cwd}

Pinned memory:
${args.memory.pinnedSections}

Memory tree:
${args.memory.memoryTree}

Retrieved memory context:
${args.memory.retrievedContext}
  `.trim();
}

export function buildSupervisorDeveloperPrompt(): string {
  return `
Supervisor output must be strict JSON only (no markdown fences) with:
- action
- rationale
- nextInstruction (always required; use "" when no follow-up is needed)
- memoryAction

Quality bar:
- rationale should reference evidence quality, not style.
- nextInstruction should be concrete and narrow when non-empty.
  `.trim();
}

export function buildWorkerTurnInput(args: {
  goal: string;
  workerTurnCount: number;
  pendingInstruction: string | null;
  latestDecision: SupervisorDecision | null;
  memoryReminder: boolean;
  workspaceMode?: "none" | "worktree";
  executionCwd?: string | null;
  parallelWorkersEnabled?: boolean;
  parallelLaneIndex?: number;
  parallelLaneCount?: number;
  parallelLaneRole?: "primary" | "helper";
  skillActivation?: string[];
  skillActivationReason?: string;
  memoryRecall?: string;
}): string {
  const sections = [
    "RollCode worker unit.",
    "",
    `Goal:\n${args.goal}`,
    "",
    `Turn: ${args.workerTurnCount + 1}`,
  ];

  if (args.pendingInstruction) {
    sections.push("", `Instruction:\n${args.pendingInstruction}`);
  } else {
    sections.push(
      "",
      "Instruction:",
      "Advance the goal with the next best concrete step.",
    );
  }

  if (args.latestDecision) {
    sections.push(
      "",
      "Latest supervisor decision:",
      JSON.stringify(args.latestDecision, null, 2),
    );
  }

  if ((args.parallelLaneCount ?? 1) > 1) {
    const laneIndex = Math.max(1, args.parallelLaneIndex ?? 1);
    const laneCount = Math.max(laneIndex, args.parallelLaneCount ?? 1);
    const role = args.parallelLaneRole ?? (laneIndex === 1 ? "primary" : "helper");
    sections.push(
      "",
      "Lane assignment:",
      `${laneIndex}/${laneCount} (${role})`,
    );
  }

  sections.push(
    "",
    "Workspace:",
    args.workspaceMode === "worktree"
      ? `worktree: ${args.executionCwd || "(unknown path)"}`
      : "default (no explicit git isolation workspace)",
  );

  if (args.memoryReminder) {
    sections.push(
      "",
      "Memory reminder: capture only durable, reusable lessons.",
    );
  }

  if (args.memoryRecall?.trim()) {
    sections.push(
      "",
      "Task-scoped memory recall:",
      clamp(args.memoryRecall.trim(), 3200),
    );
  }

  if (Array.isArray(args.skillActivation) && args.skillActivation.length > 0) {
    sections.push(
      "",
      "Skill activation:",
      args.skillActivation.map((name) => `- ${name}`).join("\n"),
    );
    if (args.skillActivationReason) {
      sections.push(`Activation reason: ${args.skillActivationReason}`);
    }
  } else if (args.skillActivationReason) {
    sections.push("", `Skill activation: ${args.skillActivationReason}`);
  }

  sections.push(
    "",
    "Parallel helpers:",
    args.parallelWorkersEnabled === false
      ? "disabled for this turn"
      : "enabled when assigned by infra",
    "",
    "Plan discipline:",
    "Maintain plan state via update_plan; keep exactly one step in_progress when applicable.",
    "Use request_user_input when blocked on user preference or missing constraints.",
    "",
    "Output contract:",
    "Strict JSON only: userMessage + handoff(summary,evidence,unresolved,completionClaim).",
  );
  return sections.join("\n");
}

export function buildSupervisorTurnInput(args: {
  goal: string;
  handoff: WorkerHandoff;
  artifacts: TurnArtifacts;
  memoryRecall?: string;
}): string {
  const commandExecutionSummary = compactCommandExecutions(
    args.artifacts.commandExecutions,
  );
  const sections = [
    "RollCode supervisor unit.",
    "### Output contract:\nstrict JSON only with action/rationale/nextInstruction/memoryAction.",
    `### Goal:\n${clamp(args.goal, 1200)}`,
    `### Worker turn id: ${args.artifacts.turnId}`,
    `### Worker handoff:\n${clamp(JSON.stringify(compactWorkerHandoff(args.handoff), null, 2), 3600)}`,
    `### Latest plan state:\n${clamp(JSON.stringify(compactPlan(args.artifacts.plan), null, 2), 2400)}`,
    `### Latest diff:\n${clamp(args.artifacts.diff || "(no diff reported)", 2600)}`,
    `### Latest command output:\n${clampTail(args.artifacts.commandOutput || "(no command output recorded)", 3600)}`,
    `### Structured command executions:\n${clamp(commandExecutionSummary, 2200)}`,
    `### Final worker message (preview):\n${clamp(args.artifacts.finalMessage || "(missing)", 1200)}`,
    ...(args.memoryRecall?.trim()
      ? [
          `### Task-scoped memory recall:\n${clamp(args.memoryRecall.trim(), 2600)}`,
        ]
      : []),
  ];
  const packet = sections.join("\n\n");
  return truncateAtSectionBoundary(
    packet,
    SUPERVISOR_REVIEW_PROMPT_BUDGET_CHARS,
  ).content;
}
