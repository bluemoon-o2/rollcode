import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { DEFAULT_TASK_ISOLATION_MODE, getRollcodeHome } from "../config";

export interface WorkspaceIsolationContext {
  mode: "none" | "worktree";
  baseCwd: string;
  executionCwd: string;
  repoRoot: string | null;
  worktreePath?: string;
  branchName?: string;
  note?: string;
}

function runGit(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout ? new TextDecoder().decode(result.stdout).trim() : "";
  const stderr = result.stderr ? new TextDecoder().decode(result.stderr).trim() : "";
  return {
    ok: result.exitCode === 0,
    stdout,
    stderr,
  };
}

function sanitizePathToken(input: string): string {
  return input.replace(/^[/\\]+/, "").replace(/[^\w.-]+/g, "-");
}

function timestampToken(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function resolveRepoRoot(cwd: string): string | null {
  const probe = runGit(["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (!probe.ok || !probe.stdout) {
    return null;
  }
  return probe.stdout;
}

export function prepareWorkspaceIsolation(
  cwd: string,
  mode: "none" | "worktree" = DEFAULT_TASK_ISOLATION_MODE,
): WorkspaceIsolationContext {
  if (mode === "none") {
    return {
      mode: "none",
      baseCwd: cwd,
      executionCwd: cwd,
      repoRoot: resolveRepoRoot(cwd),
      note: "Task isolation disabled.",
    };
  }

  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) {
    return {
      mode: "none",
      baseCwd: cwd,
      executionCwd: cwd,
      repoRoot: null,
      note: "Worktree isolation requested but current directory is not a git repository.",
    };
  }

  const rootToken = sanitizePathToken(repoRoot);
  const token = `${timestampToken()}-${shortId()}`;
  const worktreeRoot = join(getRollcodeHome(), "worktrees", rootToken);
  const worktreePath = join(worktreeRoot, token);
  const branchName = `rollcode/${basename(repoRoot)}-${shortId()}`;

  mkdirSync(worktreeRoot, { recursive: true });
  const created = runGit([
    "-C",
    repoRoot,
    "worktree",
    "add",
    "-b",
    branchName,
    worktreePath,
  ]);
  if (!created.ok) {
    return {
      mode: "none",
      baseCwd: cwd,
      executionCwd: cwd,
      repoRoot,
      note: `Failed to create worktree isolation: ${created.stderr || "unknown git error"}`,
    };
  }

  return {
    mode: "worktree",
    baseCwd: cwd,
    executionCwd: worktreePath,
    repoRoot,
    worktreePath,
    branchName,
    note: `Worktree isolation enabled at ${worktreePath} (branch ${branchName}).`,
  };
}
