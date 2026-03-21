import type { TurnPlanStep, WorkerTurnOutput } from "../domain/types";

export type ParallelExecutionMode = "always" | "adaptive";

const PLAN_STATUS_RANK: Record<TurnPlanStep["status"], number> = {
  pending: 0,
  in_progress: 1,
  completed: 2,
};

function normalizePlanStatus(value: unknown): TurnPlanStep["status"] {
  if (value === "pending" || value === "in_progress" || value === "completed") {
    return value;
  }
  return "pending";
}

function normalizePlanStepLabel(step: unknown): string {
  const value = String(step ?? "step").trim();
  return value || "step";
}

export function normalizePlanSteps(plan: TurnPlanStep[]): TurnPlanStep[] {
  const merged: TurnPlanStep[] = [];
  const indexByStep = new Map<string, number>();

  for (const entry of plan) {
    const step = normalizePlanStepLabel(entry.step);
    const status = normalizePlanStatus(entry.status);
    const existingIndex = indexByStep.get(step);
    if (existingIndex === undefined) {
      merged.push({ step, status });
      indexByStep.set(step, merged.length - 1);
      continue;
    }

    const existing = merged[existingIndex] as TurnPlanStep;
    if (PLAN_STATUS_RANK[status] > PLAN_STATUS_RANK[existing.status]) {
      existing.status = status;
    }
  }

  return merged;
}

export function mergePlanTracks(plans: TurnPlanStep[][]): TurnPlanStep[] {
  const flat = plans.flatMap((plan) =>
    plan.map((entry) => ({
      step: normalizePlanStepLabel(entry.step),
      status: normalizePlanStatus(entry.status),
    })),
  );
  return normalizePlanSteps(flat);
}

export function enforcePlanCompletionGate(args: {
  output: WorkerTurnOutput;
  plan: TurnPlanStep[];
}): {
  output: WorkerTurnOutput;
  gated: boolean;
  reason: "missing_plan" | "incomplete_steps" | null;
  unresolvedSteps: string[];
} {
  if (!args.output.handoff.completionClaim) {
    return {
      output: args.output,
      gated: false,
      reason: null,
      unresolvedSteps: [],
    };
  }

  if (args.plan.length === 0) {
    const unresolvedPrefix = "Plan gate: no plan updates were reported";
    const unresolved = [...args.output.handoff.unresolved];
    if (!unresolved.some((entry) => entry.startsWith(unresolvedPrefix))) {
      unresolved.push(`${unresolvedPrefix} for this turn.`);
    }
    const summary = `${args.output.handoff.summary} | plan gate held completion (no plan updates reported)`;
    return {
      output: {
        ...args.output,
        handoff: {
          ...args.output.handoff,
          summary,
          unresolved,
          completionClaim: false,
        },
      },
      gated: true,
      reason: "missing_plan",
      unresolvedSteps: ["(no plan updates reported)"],
    };
  }

  const incomplete = args.plan
    .filter((step) => step.status !== "completed")
    .map((step) => step.step);
  if (incomplete.length === 0) {
    return {
      output: args.output,
      gated: false,
      reason: null,
      unresolvedSteps: [],
    };
  }

  const unresolvedPrefix = "Plan gate: incomplete steps remain";
  const unresolved = [...args.output.handoff.unresolved];
  if (!unresolved.some((entry) => entry.startsWith(unresolvedPrefix))) {
    unresolved.push(
      `${unresolvedPrefix} (${incomplete.length}): ${incomplete.join(", ")}`,
    );
  }

  const summary = `${args.output.handoff.summary} | plan gate held completion (${incomplete.length} incomplete step${incomplete.length === 1 ? "" : "s"})`;

  return {
    output: {
      ...args.output,
      handoff: {
        ...args.output.handoff,
        summary,
        unresolved,
        completionClaim: false,
      },
    },
    gated: true,
    reason: "incomplete_steps",
    unresolvedSteps: incomplete,
  };
}

function hasParallelSignal(text: string | null): boolean {
  if (!text) {
    return false;
  }
  return /(parallel|independent|split|separate|helper|cross-check|verification lane|并行|独立|拆分|分别)/i.test(
    text,
  );
}

export function selectParallelLanePlan(args: {
  mode: ParallelExecutionMode;
  maxLaneCount: number;
  plan: TurnPlanStep[];
  pendingInstruction: string | null;
}): {
  helperLanesEnabled: boolean;
  activeLaneCount: number;
  reason: string;
} {
  const total = Math.max(1, Math.floor(args.maxLaneCount));
  if (total <= 1) {
    return {
      helperLanesEnabled: false,
      activeLaneCount: 1,
      reason: "single-lane configuration",
    };
  }

  if (args.mode === "always") {
    return {
      helperLanesEnabled: true,
      activeLaneCount: total,
      reason: "parallel mode=always",
    };
  }

  const normalizedPlan = normalizePlanSteps(args.plan);
  const incompleteCount = normalizedPlan.filter(
    (step) => step.status !== "completed",
  ).length;
  if (incompleteCount >= 2) {
    return {
      helperLanesEnabled: true,
      activeLaneCount: total,
      reason: "adaptive: multiple incomplete plan steps",
    };
  }

  if (hasParallelSignal(args.pendingInstruction)) {
    return {
      helperLanesEnabled: true,
      activeLaneCount: total,
      reason: "adaptive: pending instruction signals parallel work",
    };
  }

  return {
    helperLanesEnabled: false,
    activeLaneCount: 1,
    reason: "adaptive: no independent tracks detected",
  };
}
