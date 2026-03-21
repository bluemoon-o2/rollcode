import type {
  RunRecord,
  RunStatus,
  SupervisorDecision,
} from "../domain/types";

export type RuntimePhase =
  | "completed"
  | "blocked"
  | "turn-limit"
  | "dispatch-worker"
  | "dispatch-supervisor";

export interface RuntimeDerivedState {
  phase: RuntimePhase;
  reason: string;
}

export type RuntimeDispatchAction =
  | {
      action: "stop";
      terminalStatus: "completed" | "blocked";
      reason: string;
    }
  | {
      action: "block-turn-limit";
      reason: string;
    }
  | {
      action: "dispatch-worker";
      reason: string;
    }
  | {
      action: "dispatch-supervisor";
      reason: string;
    };

interface RuntimeDispatchRule {
  name: string;
  match: (state: RuntimeDerivedState) => RuntimeDispatchAction | null;
}

export function deriveRuntimeState(args: {
  run: RunRecord;
  hasPendingWorkerArtifacts: boolean;
  maxTurns: number;
}): RuntimeDerivedState {
  if (args.run.status === "completed") {
    return {
      phase: "completed",
      reason: "run status is completed",
    };
  }

  if (args.run.status === "blocked" && !args.run.pendingInstruction) {
    return {
      phase: "blocked",
      reason: "run is blocked and has no pending instruction",
    };
  }

  if (args.hasPendingWorkerArtifacts) {
    return {
      phase: "dispatch-supervisor",
      reason: "worker artifacts are pending supervisor review",
    };
  }

  if (args.run.workerTurnCount >= args.maxTurns) {
    return {
      phase: "turn-limit",
      reason: `worker turn limit reached (${args.maxTurns})`,
    };
  }

  return {
    phase: "dispatch-worker",
    reason: "ready for worker dispatch",
  };
}

const DISPATCH_RULES: RuntimeDispatchRule[] = [
  {
    name: "completed",
    match: (state) =>
      state.phase === "completed"
        ? {
            action: "stop",
            terminalStatus: "completed",
            reason: state.reason,
          }
        : null,
  },
  {
    name: "blocked",
    match: (state) =>
      state.phase === "blocked"
        ? {
            action: "stop",
            terminalStatus: "blocked",
            reason: state.reason,
          }
        : null,
  },
  {
    name: "turn-limit",
    match: (state) =>
      state.phase === "turn-limit"
        ? {
            action: "block-turn-limit",
            reason: state.reason,
          }
        : null,
  },
  {
    name: "dispatch-supervisor",
    match: (state) =>
      state.phase === "dispatch-supervisor"
        ? {
            action: "dispatch-supervisor",
            reason: state.reason,
          }
        : null,
  },
  {
    name: "dispatch-worker",
    match: (state) =>
      state.phase === "dispatch-worker"
        ? {
            action: "dispatch-worker",
            reason: state.reason,
          }
        : null,
  },
];

export function resolveRuntimeDispatch(
  state: RuntimeDerivedState,
): RuntimeDispatchAction {
  for (const rule of DISPATCH_RULES) {
    const action = rule.match(state);
    if (action) {
      return action;
    }
  }

  return {
    action: "stop",
    terminalStatus: "blocked",
    reason: `Unhandled runtime phase: ${state.phase}`,
  };
}

export function resolveDecisionTransition(
  decision: SupervisorDecision,
): {
  status: RunStatus;
  pendingInstruction: string | null;
  markCompleted: boolean;
} {
  const normalizedInstruction = decision.nextInstruction?.trim() ?? "";

  if (decision.action === "complete") {
    return {
      status: "completed",
      pendingInstruction: null,
      markCompleted: true,
    };
  }

  if (decision.action === "blocked") {
    return {
      status: "blocked",
      pendingInstruction: normalizedInstruction || null,
      markCompleted: false,
    };
  }

  if (decision.action === "repair") {
    return {
      status: "repairing",
      pendingInstruction:
        normalizedInstruction ||
        "Repair the issue identified by the supervisor and provide a better evidenced handoff.",
      markCompleted: false,
    };
  }

  return {
    status: "working",
    pendingInstruction:
      normalizedInstruction ||
      "Continue with the next best concrete step toward the goal.",
    markCompleted: false,
  };
}

export function getRuntimeDispatchRuleNames(): string[] {
  return DISPATCH_RULES.map((rule) => rule.name);
}
