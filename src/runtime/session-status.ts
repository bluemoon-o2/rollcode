import type { RunStatus, ThreadRole } from "../domain/types";
import { readTextIfExists, writeText } from "../utils/fs";
import { nowIso } from "../utils/time";

export interface RunSessionStatus {
  version: 1;
  runId: string;
  agentId: string;
  pid: number;
  runStatus: RunStatus;
  activeThreadRole: ThreadRole | null;
  detached: boolean;
  ownerPid: number | null;
  executionCwd: string;
  heartbeatAt: string;
  updatedAt: string;
}

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "working" ||
    value === "supervising" ||
    value === "repairing" ||
    value === "blocked" ||
    value === "completed" ||
    value === "interrupted"
  );
}

function isThreadRole(value: unknown): value is ThreadRole | null {
  return value === "worker" || value === "supervisor" || value === null;
}

function normalizeSessionStatus(value: unknown): RunSessionStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.runId !== "string" ||
    typeof candidate.agentId !== "string" ||
    typeof candidate.pid !== "number" ||
    !Number.isFinite(candidate.pid) ||
    !isRunStatus(candidate.runStatus) ||
    !isThreadRole(candidate.activeThreadRole) ||
    typeof candidate.detached !== "boolean" ||
    (candidate.ownerPid !== null &&
      (typeof candidate.ownerPid !== "number" ||
        !Number.isFinite(candidate.ownerPid))) ||
    typeof candidate.executionCwd !== "string" ||
    typeof candidate.heartbeatAt !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    version: 1,
    runId: candidate.runId,
    agentId: candidate.agentId,
    pid: Math.max(0, Math.floor(candidate.pid)),
    runStatus: candidate.runStatus,
    activeThreadRole: candidate.activeThreadRole,
    detached: candidate.detached,
    ownerPid: candidate.ownerPid,
    executionCwd: candidate.executionCwd,
    heartbeatAt: candidate.heartbeatAt,
    updatedAt: candidate.updatedAt,
  };
}

export async function loadRunSessionStatus(
  path: string,
): Promise<RunSessionStatus | null> {
  const raw = await readTextIfExists(path);
  if (!raw) {
    return null;
  }
  try {
    return normalizeSessionStatus(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveRunSessionStatus(
  path: string,
  status: Omit<RunSessionStatus, "version" | "heartbeatAt" | "updatedAt"> & {
    heartbeatAt?: string;
    updatedAt?: string;
  },
): Promise<void> {
  const stamp = nowIso();
  const payload: RunSessionStatus = {
    version: 1,
    runId: status.runId,
    agentId: status.agentId,
    pid: Math.max(0, Math.floor(status.pid)),
    runStatus: status.runStatus,
    activeThreadRole: status.activeThreadRole,
    detached: status.detached,
    ownerPid: status.ownerPid,
    executionCwd: status.executionCwd,
    heartbeatAt: status.heartbeatAt ?? stamp,
    updatedAt: status.updatedAt ?? stamp,
  };
  await writeText(path, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function clearRunSessionStatus(path: string): Promise<void> {
  await writeText(path, "");
}
