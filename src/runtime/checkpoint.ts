import type {
  CommandExecutionRecord,
  TurnArtifacts,
  TurnPlanStep,
  WorkerTurnOutput,
} from "../domain/types";
import { readTextIfExists, writeText } from "../utils/fs";
import { nowIso } from "../utils/time";

interface PersistedWorkerArtifacts {
  turnId: string;
  finalMessage: string;
  parsed: WorkerTurnOutput;
  plan: TurnPlanStep[];
  diff: string;
  commandOutput: string;
  commandExecutions: CommandExecutionRecord[];
}

export interface RunCheckpoint {
  runId: string;
  phase: "worker-dispatched" | "worker-completed" | "supervisor-dispatched";
  updatedAt: string;
  pendingWorkerArtifacts: PersistedWorkerArtifacts | null;
  plan: TurnPlanStep[];
  diff: string;
  commandOutput: string;
  commandExecutions: CommandExecutionRecord[];
}

export function serializeWorkerArtifacts(
  artifacts: TurnArtifacts & { parsed: WorkerTurnOutput },
): PersistedWorkerArtifacts {
  return {
    turnId: artifacts.turnId,
    finalMessage: artifacts.finalMessage,
    parsed: artifacts.parsed,
    plan: artifacts.plan,
    diff: artifacts.diff,
    commandOutput: artifacts.commandOutput,
    commandExecutions: (artifacts.commandExecutions ?? []).map((entry) => ({
      ...entry,
    })),
  };
}

export function toTurnArtifacts(
  payload: PersistedWorkerArtifacts,
): TurnArtifacts & { parsed: WorkerTurnOutput } {
  return {
    turnId: payload.turnId,
    finalMessage: payload.finalMessage,
    parsed: payload.parsed,
    plan: payload.plan,
    diff: payload.diff,
    commandOutput: payload.commandOutput,
    commandExecutions: payload.commandExecutions,
    items: [],
  };
}

export async function loadRunCheckpoint(
  path: string,
  runId: string,
): Promise<RunCheckpoint | null> {
  const raw = await readTextIfExists(path);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as RunCheckpoint;
    if (parsed.runId !== runId) {
      return null;
    }
    return {
      ...parsed,
      pendingWorkerArtifacts: parsed.pendingWorkerArtifacts
        ? {
            ...parsed.pendingWorkerArtifacts,
            commandExecutions: (
              parsed.pendingWorkerArtifacts.commandExecutions ?? []
            ).map((entry) => ({ ...entry })),
            plan: (parsed.pendingWorkerArtifacts.plan ?? []).map((entry) => ({
              ...entry,
            })),
          }
        : null,
      commandExecutions: (parsed.commandExecutions ?? []).map((entry) => ({
        ...entry,
      })),
      plan: (parsed.plan ?? []).map((entry) => ({ ...entry })),
    };
  } catch {
    return null;
  }
}

export async function saveRunCheckpoint(
  path: string,
  checkpoint: Omit<RunCheckpoint, "updatedAt">,
): Promise<void> {
  await writeText(
    path,
    `${JSON.stringify({ ...checkpoint, updatedAt: nowIso() }, null, 2)}\n`,
  );
}

export async function clearRunCheckpoint(path: string): Promise<void> {
  await writeText(path, "");
}
