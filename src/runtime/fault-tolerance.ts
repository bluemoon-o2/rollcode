export interface WorkerLoopSample {
  instruction: string;
  completedPlanSteps: number;
  turn: number;
}

export interface StallSignal {
  stalled: true;
  reason: string;
}

function normalizeInstruction(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

function nonIncreasingProgress(samples: WorkerLoopSample[]): boolean {
  if (samples.length < 2) {
    return true;
  }
  const first = samples[0] as WorkerLoopSample;
  const last = samples[samples.length - 1] as WorkerLoopSample;
  return last.completedPlanSteps <= first.completedPlanSteps;
}

export function detectStalledWorkerLoop(
  samples: WorkerLoopSample[],
  repeatThreshold = 3,
): StallSignal | null {
  const threshold = Math.max(2, Math.floor(repeatThreshold));
  if (samples.length < threshold) {
    return null;
  }

  const recent = samples.slice(-threshold);
  const normalized = recent.map((entry) => normalizeInstruction(entry.instruction));
  const firstInstruction = normalized[0] as string;
  if (
    firstInstruction &&
    normalized.every((instruction) => instruction === firstInstruction) &&
    nonIncreasingProgress(recent)
  ) {
    return {
      stalled: true,
      reason: `Repeated instruction without plan progress (${threshold}x): ${firstInstruction}`,
    };
  }

  if (samples.length >= 4) {
    const window = samples.slice(-4).map((entry) => normalizeInstruction(entry.instruction));
    const progressWindow = samples.slice(-4);
    if (
      window[0] &&
      window[0] === window[2] &&
      window[1] &&
      window[1] === window[3] &&
      window[0] !== window[1] &&
      nonIncreasingProgress(progressWindow)
    ) {
      return {
        stalled: true,
        reason: `Instruction oscillation without progress: ${window[0]} <-> ${window[1]}`,
      };
    }
  }

  return null;
}

export interface ParallelCircuitState {
  open: boolean;
  errorStreak: number;
  cooldownRemaining: number;
}

export function createParallelCircuitState(): ParallelCircuitState {
  return {
    open: false,
    errorStreak: 0,
    cooldownRemaining: 0,
  };
}

export function nextParallelCircuitState(args: {
  current: ParallelCircuitState;
  helperErrorCount: number;
  errorThreshold: number;
  cooldownTurns: number;
}): ParallelCircuitState {
  const threshold = Math.max(1, Math.floor(args.errorThreshold));
  const cooldownTurns = Math.max(1, Math.floor(args.cooldownTurns));
  const helperErrors = Math.max(0, Math.floor(args.helperErrorCount));

  if (args.current.open) {
    if (helperErrors > 0) {
      return {
        open: true,
        errorStreak: args.current.errorStreak,
        cooldownRemaining: cooldownTurns,
      };
    }
    if (args.current.cooldownRemaining > 1) {
      return {
        open: true,
        errorStreak: args.current.errorStreak,
        cooldownRemaining: args.current.cooldownRemaining - 1,
      };
    }
    return {
      open: false,
      errorStreak: 0,
      cooldownRemaining: 0,
    };
  }

  const nextErrorStreak = helperErrors > 0 ? args.current.errorStreak + 1 : 0;
  if (nextErrorStreak >= threshold) {
    return {
      open: true,
      errorStreak: nextErrorStreak,
      cooldownRemaining: cooldownTurns,
    };
  }

  return {
    open: false,
    errorStreak: nextErrorStreak,
    cooldownRemaining: 0,
  };
}
