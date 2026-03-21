import { describe, expect, test } from "bun:test";
import type { RunRecord } from "../src/domain/types";
import {
  deriveRuntimeState,
  getRuntimeDispatchRuleNames,
  resolveDecisionTransition,
  resolveRuntimeDispatch,
} from "../src/runtime/orchestration";
import {
  enforcePlanCompletionGate,
  mergePlanTracks,
  normalizePlanSteps,
  selectParallelLanePlan,
} from "../src/runtime/planning";

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    agentId: "agent-1",
    goal: "Ship feature",
    status: "working",
    detached: false,
    ownerPid: 1,
    pendingInstruction: null,
    workerTurnCount: 0,
    latestWorkerTurnId: null,
    latestSupervisorTurnId: null,
    memoryReminderDue: false,
    lastError: null,
    createdAt: "2026-03-21T00:00:00.000Z",
    updatedAt: "2026-03-21T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

describe("runtime orchestration state machine", () => {
  test("derives dispatch-supervisor before turn-limit when worker artifacts are pending", () => {
    const run = makeRun({ workerTurnCount: 24 });
    const state = deriveRuntimeState({
      run,
      hasPendingWorkerArtifacts: true,
      maxTurns: 24,
    });

    expect(state.phase).toBe("dispatch-supervisor");
    const action = resolveRuntimeDispatch(state);
    expect(action.action).toBe("dispatch-supervisor");
  });

  test("blocks when run is blocked without pending instruction", () => {
    const run = makeRun({ status: "blocked", pendingInstruction: null });
    const state = deriveRuntimeState({
      run,
      hasPendingWorkerArtifacts: false,
      maxTurns: 24,
    });
    const action = resolveRuntimeDispatch(state);

    expect(state.phase).toBe("blocked");
    expect(action.action).toBe("stop");
    if (action.action === "stop") {
      expect(action.terminalStatus).toBe("blocked");
    }
  });

  test("maps supervisor decisions into deterministic run transitions", () => {
    const repair = resolveDecisionTransition({
      action: "repair",
      rationale: "Need stronger evidence",
      memoryAction: "review",
    });
    const blocked = resolveDecisionTransition({
      action: "blocked",
      rationale: "Missing external credential",
      nextInstruction: "   ",
      memoryAction: "none",
    });
    const done = resolveDecisionTransition({
      action: "complete",
      rationale: "Done",
      memoryAction: "none",
    });

    expect(repair.status).toBe("repairing");
    expect(repair.pendingInstruction).toContain("Repair the issue identified");
    expect(blocked.status).toBe("blocked");
    expect(blocked.pendingInstruction).toBeNull();
    expect(done.status).toBe("completed");
    expect(done.markCompleted).toBeTrue();
  });

  test("exposes dispatch rule order for runtime tests", () => {
    expect(getRuntimeDispatchRuleNames()).toEqual([
      "completed",
      "blocked",
      "turn-limit",
      "dispatch-supervisor",
      "dispatch-worker",
    ]);
  });
});

describe("planning and parallel orchestration helpers", () => {
  test("normalizes and merges plan tracks by highest status", () => {
    const merged = mergePlanTracks([
      [
        { step: "Task A", status: "pending" },
        { step: "Task B", status: "in_progress" },
      ],
      [
        { step: "Task A", status: "completed" },
        { step: "Task B", status: "pending" },
      ],
    ]);

    expect(merged).toEqual([
      { step: "Task A", status: "completed" },
      { step: "Task B", status: "in_progress" },
    ]);
    expect(
      normalizePlanSteps([
        { step: " Task A ", status: "pending" },
        { step: "Task A", status: "completed" },
      ]),
    ).toEqual([{ step: "Task A", status: "completed" }]);
  });

  test("gates completion claims when plan still has incomplete work", () => {
    const gated = enforcePlanCompletionGate({
      output: {
        userMessage: "Done.",
        handoff: {
          summary: "All done",
          evidence: ["artifact"],
          unresolved: [],
          completionClaim: true,
        },
      },
      plan: [
        { step: "Task A", status: "completed" },
        { step: "Task B", status: "pending" },
      ],
    });

    expect(gated.gated).toBeTrue();
    expect(gated.reason).toBe("incomplete_steps");
    expect(gated.output.handoff.completionClaim).toBeFalse();
    expect(gated.output.handoff.unresolved.join(" ")).toContain(
      "Plan gate: incomplete steps remain",
    );
  });

  test("gates completion claims when no plan updates are reported", () => {
    const gated = enforcePlanCompletionGate({
      output: {
        userMessage: "Done.",
        handoff: {
          summary: "All done",
          evidence: ["artifact"],
          unresolved: [],
          completionClaim: true,
        },
      },
      plan: [],
    });

    expect(gated.gated).toBeTrue();
    expect(gated.reason).toBe("missing_plan");
    expect(gated.output.handoff.completionClaim).toBeFalse();
    expect(gated.output.handoff.summary).toContain(
      "no plan updates reported",
    );
  });

  test("adaptive parallel mode enables helpers only with independent signals", () => {
    const noParallel = selectParallelLanePlan({
      mode: "adaptive",
      maxLaneCount: 3,
      plan: [{ step: "Task A", status: "in_progress" }],
      pendingInstruction: null,
    });
    const parallelFromPlan = selectParallelLanePlan({
      mode: "adaptive",
      maxLaneCount: 3,
      plan: [
        { step: "Task A", status: "in_progress" },
        { step: "Task B", status: "pending" },
      ],
      pendingInstruction: null,
    });
    const parallelFromInstruction = selectParallelLanePlan({
      mode: "adaptive",
      maxLaneCount: 3,
      plan: [],
      pendingInstruction: "Use helper lanes for parallel verification.",
    });

    expect(noParallel.helperLanesEnabled).toBeFalse();
    expect(noParallel.activeLaneCount).toBe(1);
    expect(parallelFromPlan.helperLanesEnabled).toBeTrue();
    expect(parallelFromPlan.activeLaneCount).toBe(3);
    expect(parallelFromInstruction.helperLanesEnabled).toBeTrue();
  });
});
