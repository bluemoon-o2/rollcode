import { describe, expect, test } from "bun:test";
import {
  buildSupervisorBasePrompt,
  buildSupervisorDeveloperPrompt,
  buildSupervisorTurnInput,
  buildWorkerBasePrompt,
  buildWorkerDeveloperPrompt,
  buildWorkerTurnInput,
} from "../src/prompts";

const memoryFixture = {
  pinnedSections: "<system/context/identity.md>\nidentity\n</system/context/identity.md>",
  memoryTree: "/memory/\n- system/identity.md",
  memoryIndex: "- project/notes.md: notes",
  recentEpisodes: "- episodes/2026-03-20.md: last run",
  retrievedContext:
    "- project/notes.md (score: 3, limit: 200)\n  description: notes\n  snippet: keep tests stable",
};

describe("prompt design alignment", () => {
  test("worker base prompt keeps core execution constraints with lighter packet assumptions", () => {
    const prompt = buildWorkerBasePrompt({
      cwd: "/repo/demo",
      memory: memoryFixture,
      skillsSummary: "- rollcode-supervision (bundled)",
    });

    expect(prompt).toContain("RollCode worker context (execution lane)");
    expect(prompt).toContain(
      "Runtime infra owns state transitions, retries, and parallel lane policy.",
    );
    expect(prompt).not.toContain("Task workflow contract:");
    expect(prompt).toContain("Current working directory (execution scope):");
    expect(prompt).toContain("/repo/demo");
  });

  test("worker developer prompt enforces strict JSON-only output contract", () => {
    const prompt = buildWorkerDeveloperPrompt();

    expect(prompt).toContain("strict JSON only");
    expect(prompt).toContain('"userMessage"');
    expect(prompt).toContain('"handoff"');
    expect(prompt).toContain("completionClaim");
    expect(prompt).toContain("update_plan");
    expect(prompt).toContain("request_user_input");
  });

  test("supervisor prompts enforce separated review lane behavior", () => {
    const base = buildSupervisorBasePrompt({
      cwd: "/repo/demo",
      memory: memoryFixture,
    });
    const dev = buildSupervisorDeveloperPrompt();

    expect(base).toContain("hidden RollCode supervisor context (review lane)");
    expect(base).toContain("You must not execute the task.");
    expect(base).toContain("Decision rubric:");
    expect(base).not.toContain("Plan-analysis rubric:");
    expect(dev).toContain("strict JSON only");
    expect(dev).toContain(
      'nextInstruction (always required; use "" when no follow-up is needed)',
    );
  });

  test("worker turn input keeps minimal execution metadata and strict output contract", () => {
    const packet = buildWorkerTurnInput({
      goal: "Ship feature A",
      workerTurnCount: 2,
      pendingInstruction: "Implement parser edge cases",
      latestDecision: {
        action: "repair",
        rationale: "Missing edge-case verification.",
        nextInstruction: "Add failing tests first, then patch parser.",
        memoryAction: "review",
      },
      memoryReminder: true,
      workspaceMode: "worktree",
      executionCwd: "/repo/demo/.rollcode/worktrees/demo-1",
      parallelWorkersEnabled: true,
      parallelLaneIndex: 1,
      parallelLaneCount: 2,
      parallelLaneRole: "primary",
      skillActivation: ["react", "test"],
      skillActivationReason: "activation: 2 skills matched context",
      memoryRecall: "- project/notes.md: keep tests stable",
    });

    expect(packet).toContain("RollCode worker unit.");
    expect(packet).toContain("Latest supervisor decision:");
    expect(packet).toContain("Workspace:");
    expect(packet).toContain("worktree:");
    expect(packet).toContain("Lane assignment:");
    expect(packet).toContain("Skill activation:");
    expect(packet).toContain("- react");
    expect(packet).toContain("Activation reason:");
    expect(packet).toContain("Task-scoped memory recall:");
    expect(packet).toContain("Output contract:");
    expect(packet).toContain("Plan discipline:");
    expect(packet).toContain("update_plan");
    expect(packet).toContain("request_user_input");
    expect(packet).not.toContain("Plan-analysis checklist:");
  });

  test("supervisor turn input includes evidence packet and output reminder", () => {
    const review = buildSupervisorTurnInput({
      goal: "Ship feature A",
      handoff: {
        summary: "Patched parser and ran tests.",
        evidence: ["updated parser.ts", "bun test parser"],
        unresolved: [],
        completionClaim: true,
      },
      artifacts: {
        turnId: "worker-turn-9",
        finalMessage: "Feature shipped with validation.",
        plan: [{ step: "Patch parser", status: "completed" }],
        diff: "diff --git a/parser.ts b/parser.ts",
        commandOutput: "$ bun test\npass\n(exit 0)\n",
        items: [],
      },
      memoryRecall: "- episodes/2026-03-20.md: parser tests were flaky on Linux.",
    });

    expect(review).toContain("RollCode supervisor unit.");
    expect(review).toContain("Worker turn id: worker-turn-9");
    expect(review).toContain("Latest command output:");
    expect(review).toContain("Structured command executions:");
    expect(review).toContain("Task-scoped memory recall:");
    expect(review).toContain("Output contract:");
    expect(review).toContain(
      "strict JSON only with action/rationale/nextInstruction/memoryAction.",
    );
  });

  test("supervisor turn input excludes raw command stdout/stderr from structured command executions", () => {
    const review = buildSupervisorTurnInput({
      goal: "Ship feature A",
      handoff: {
        summary: "Ran tests and lint.",
        evidence: ["bun test", "bun run lint"],
        unresolved: [],
        completionClaim: true,
      },
      artifacts: {
        turnId: "worker-turn-10",
        finalMessage: '{"userMessage":"done"}',
        plan: [{ step: "Run verification", status: "completed" }],
        diff: "diff --git a/parser.ts b/parser.ts",
        commandOutput: "$ bun test\nall green\n(exit 0)\n",
        commandExecutions: [
          {
            id: "id:1",
            command: "bun test",
            output: "VERY_LONG_RAW_OUTPUT_SHOULD_NOT_BE_IN_STRUCTURED_EXECUTION_BLOCK",
            phase: "finished",
            success: true,
            exitCode: 0,
          },
        ],
        items: [],
      },
    });

    expect(review).toContain('"outputChars"');
    expect(review).not.toContain(
      "VERY_LONG_RAW_OUTPUT_SHOULD_NOT_BE_IN_STRUCTURED_EXECUTION_BLOCK",
    );
  });

  test("supervisor turn input applies section-boundary truncation when evidence packet is oversized", () => {
    const veryLong = "x".repeat(20_000);
    const review = buildSupervisorTurnInput({
      goal: veryLong,
      handoff: {
        summary: veryLong,
        evidence: Array.from({ length: 30 }, (_, index) => `evidence-${index}-${veryLong}`),
        unresolved: [],
        completionClaim: false,
      },
      artifacts: {
        turnId: "worker-turn-11",
        finalMessage: veryLong,
        plan: Array.from({ length: 40 }, (_, index) => ({
          step: `step-${index}-${veryLong}`,
          status: "pending" as const,
        })),
        diff: veryLong,
        commandOutput: veryLong,
        commandExecutions: [
          {
            id: "id:2",
            command: "bun test",
            output: veryLong,
            phase: "finished",
            success: false,
            exitCode: 1,
          },
        ],
        items: [],
      },
      memoryRecall: veryLong,
    });

    expect(review).toContain("[...truncated");
    expect(review.length).toBeLessThan(12_500);
  });
});
