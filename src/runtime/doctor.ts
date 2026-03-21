import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  getRollcodeHome,
  getRunCheckpointPath,
  getRunSessionStatusPath,
} from "../config";
import type { RunRecord } from "../domain/types";
import type { StateStore } from "../state/store";
import { readTextIfExists, writeText } from "../utils/fs";
import { nowIso } from "../utils/time";
import { loadRunSessionStatus } from "./session-status";

export type DoctorIssueCode =
  | "orphan-run-owner"
  | "invalid-checkpoint"
  | "stale-checkpoint"
  | "invalid-session-status"
  | "stale-session-status"
  | "orphan-worktree-dir";

export interface DoctorIssue {
  code: DoctorIssueCode;
  severity: "warning" | "error";
  message: string;
  fixable: boolean;
  runId?: string;
  path?: string;
}

export interface DoctorReport {
  generatedAt: string;
  issues: DoctorIssue[];
  fixesApplied: string[];
}

interface DoctorArgs {
  store: StateStore;
  fix?: boolean;
}

function isPidAlive(pid: number | null): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isTerminalRun(run: RunRecord): boolean {
  return (
    run.status === "completed" ||
    run.status === "interrupted" ||
    (run.status === "blocked" && !run.pendingInstruction)
  );
}

async function clearFile(path: string): Promise<void> {
  await writeText(path, "");
}

async function inspectWorktreeRoot(
  fix: boolean,
  issues: DoctorIssue[],
  fixesApplied: string[],
): Promise<void> {
  const root = join(getRollcodeHome(), "worktrees");
  let repoDirs: string[] = [];
  try {
    repoDirs = await readdir(root);
  } catch {
    return;
  }

  for (const repoDir of repoDirs) {
    const repoPath = join(root, repoDir);
    let laneDirs: string[] = [];
    try {
      laneDirs = await readdir(repoPath);
    } catch {
      continue;
    }
    for (const laneDir of laneDirs) {
      const lanePath = join(repoPath, laneDir);
      let laneStat: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        laneStat = await stat(lanePath);
      } catch {
        continue;
      }
      if (!laneStat?.isDirectory()) {
        continue;
      }
      const gitPointerPath = join(lanePath, ".git");
      try {
        await stat(gitPointerPath);
      } catch {
        issues.push({
          code: "orphan-worktree-dir",
          severity: "warning",
          message: `Worktree directory has no .git pointer: ${lanePath}`,
          fixable: true,
          path: lanePath,
        });
        if (fix) {
          await rm(lanePath, { recursive: true, force: true }).catch(
            () => undefined,
          );
          fixesApplied.push(`removed orphan worktree dir: ${lanePath}`);
        }
      }
    }
  }
}

export async function runRuntimeDoctor(
  args: DoctorArgs,
): Promise<DoctorReport> {
  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  const fix = args.fix === true;
  const runs = args.store.listRuns(undefined, 100_000);

  for (const run of runs) {
    if (!isTerminalRun(run) && !isPidAlive(run.ownerPid)) {
      if (run.ownerPid !== null) {
        issues.push({
          code: "orphan-run-owner",
          severity: "warning",
          message: `Run owner process is not alive (run=${run.id}, ownerPid=${run.ownerPid}).`,
          fixable: true,
          runId: run.id,
        });
        if (fix) {
          args.store.updateRun(run.id, { ownerPid: null });
          fixesApplied.push(`cleared stale ownerPid for run ${run.id}`);
        }
      }
    }

    const checkpointPath = getRunCheckpointPath(run.agentId, run.id);
    const checkpointRaw = await readTextIfExists(checkpointPath);
    if (checkpointRaw?.trim()) {
      let parsed: Record<string, unknown> | null = null;
      try {
        const candidate = JSON.parse(checkpointRaw) as Record<string, unknown>;
        parsed = candidate;
      } catch {
        issues.push({
          code: "invalid-checkpoint",
          severity: "error",
          message: `Checkpoint JSON is invalid for run ${run.id}.`,
          fixable: true,
          runId: run.id,
          path: checkpointPath,
        });
        if (fix) {
          await clearFile(checkpointPath);
          fixesApplied.push(`cleared invalid checkpoint for run ${run.id}`);
        }
      }

      if (parsed) {
        if (parsed.runId !== run.id) {
          issues.push({
            code: "invalid-checkpoint",
            severity: "error",
            message: `Checkpoint runId mismatch for run ${run.id}.`,
            fixable: true,
            runId: run.id,
            path: checkpointPath,
          });
          if (fix) {
            await clearFile(checkpointPath);
            fixesApplied.push(
              `cleared mismatched checkpoint for run ${run.id}`,
            );
          }
        } else if (isTerminalRun(run)) {
          issues.push({
            code: "stale-checkpoint",
            severity: "warning",
            message: `Terminal run ${run.id} still has checkpoint data.`,
            fixable: true,
            runId: run.id,
            path: checkpointPath,
          });
          if (fix) {
            await clearFile(checkpointPath);
            fixesApplied.push(`cleared stale checkpoint for run ${run.id}`);
          }
        }
      }
    }

    const sessionStatusPath = getRunSessionStatusPath(run.agentId, run.id);
    const sessionStatusRaw = await readTextIfExists(sessionStatusPath);
    if (!sessionStatusRaw?.trim()) {
      continue;
    }
    const sessionStatus = await loadRunSessionStatus(sessionStatusPath);
    if (!sessionStatus) {
      issues.push({
        code: "invalid-session-status",
        severity: "error",
        message: `Session status JSON is invalid for run ${run.id}.`,
        fixable: true,
        runId: run.id,
        path: sessionStatusPath,
      });
      if (fix) {
        await clearFile(sessionStatusPath);
        fixesApplied.push(`cleared invalid session status for run ${run.id}`);
      }
      continue;
    }

    if (!isTerminalRun(run) && !isPidAlive(sessionStatus.pid)) {
      issues.push({
        code: "stale-session-status",
        severity: "warning",
        message: `Session status points to dead process pid=${sessionStatus.pid} (run=${run.id}).`,
        fixable: true,
        runId: run.id,
        path: sessionStatusPath,
      });
      if (fix) {
        await clearFile(sessionStatusPath);
        fixesApplied.push(`cleared stale session status for run ${run.id}`);
      }
    }
  }

  await inspectWorktreeRoot(fix, issues, fixesApplied);

  return {
    generatedAt: nowIso(),
    issues,
    fixesApplied,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("RollCode Doctor");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  if (report.issues.length === 0) {
    lines.push("No issues detected.");
  } else {
    lines.push(`Issues: ${report.issues.length}`);
    for (const issue of report.issues) {
      lines.push(
        `- [${issue.severity}] ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`,
      );
    }
  }
  if (report.fixesApplied.length > 0) {
    lines.push("");
    lines.push(`Fixes applied: ${report.fixesApplied.length}`);
    for (const fix of report.fixesApplied) {
      lines.push(`- ${fix}`);
    }
  }
  return lines.join("\n");
}
