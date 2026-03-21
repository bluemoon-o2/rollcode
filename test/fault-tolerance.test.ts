import { describe, expect, test } from "bun:test";
import {
  createParallelCircuitState,
  detectStalledWorkerLoop,
  nextParallelCircuitState,
} from "../src/runtime/fault-tolerance";

describe("fault tolerance", () => {
  test("detects repeated instruction stalls when plan progress is flat", () => {
    const stalled = detectStalledWorkerLoop([
      {
        instruction: "fix parser",
        completedPlanSteps: 1,
        turn: 1,
      },
      {
        instruction: "fix parser",
        completedPlanSteps: 1,
        turn: 2,
      },
      {
        instruction: "fix parser",
        completedPlanSteps: 1,
        turn: 3,
      },
    ]);

    expect(stalled).not.toBeNull();
    expect(stalled?.reason).toContain("Repeated instruction without plan progress");
  });

  test("does not flag repeated instructions when completed plan steps increase", () => {
    const stalled = detectStalledWorkerLoop([
      { instruction: "fix parser", completedPlanSteps: 1, turn: 1 },
      { instruction: "fix parser", completedPlanSteps: 2, turn: 2 },
      { instruction: "fix parser", completedPlanSteps: 3, turn: 3 },
    ]);

    expect(stalled).toBeNull();
  });

  test("detects oscillation stalls without progress", () => {
    const stalled = detectStalledWorkerLoop([
      { instruction: "task a", completedPlanSteps: 2, turn: 1 },
      { instruction: "task b", completedPlanSteps: 2, turn: 2 },
      { instruction: "task a", completedPlanSteps: 2, turn: 3 },
      { instruction: "task b", completedPlanSteps: 2, turn: 4 },
    ]);

    expect(stalled).not.toBeNull();
    expect(stalled?.reason).toContain("Instruction oscillation without progress");
  });

  test("opens and closes helper circuit based on error streak and cooldown", () => {
    const initial = createParallelCircuitState();
    const afterFirstError = nextParallelCircuitState({
      current: initial,
      helperErrorCount: 1,
      errorThreshold: 2,
      cooldownTurns: 2,
    });
    const opened = nextParallelCircuitState({
      current: afterFirstError,
      helperErrorCount: 1,
      errorThreshold: 2,
      cooldownTurns: 2,
    });
    const cooling = nextParallelCircuitState({
      current: opened,
      helperErrorCount: 0,
      errorThreshold: 2,
      cooldownTurns: 2,
    });
    const closed = nextParallelCircuitState({
      current: cooling,
      helperErrorCount: 0,
      errorThreshold: 2,
      cooldownTurns: 2,
    });

    expect(afterFirstError.open).toBeFalse();
    expect(opened.open).toBeTrue();
    expect(opened.cooldownRemaining).toBe(2);
    expect(cooling.open).toBeTrue();
    expect(cooling.cooldownRemaining).toBe(1);
    expect(closed.open).toBeFalse();
    expect(closed.errorStreak).toBe(0);
  });
});
