import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspaceIsolation } from "../src/git/isolation";

function runGit(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout ? new TextDecoder().decode(result.stdout).trim() : "";
  const stderr = result.stderr ? new TextDecoder().decode(result.stderr).trim() : "";
  return { ok: result.exitCode === 0, stdout, stderr };
}

describe("git isolation", () => {
  const roots: string[] = [];
  const originalHome = process.env.ROLLCODE_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.ROLLCODE_HOME;
    } else {
      process.env.ROLLCODE_HOME = originalHome;
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns same cwd when isolation mode is none", () => {
    const cwd = "/tmp/no-isolation";
    const context = prepareWorkspaceIsolation(cwd, "none");
    expect(context.mode).toBe("none");
    expect(context.baseCwd).toBe(cwd);
    expect(context.executionCwd).toBe(cwd);
  });

  test("falls back to base cwd when worktree mode is requested outside git", () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-git-isolation-none-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");

    const context = prepareWorkspaceIsolation(workspace, "worktree");
    expect(context.mode).toBe("none");
    expect(context.executionCwd).toBe(workspace);
    expect(context.note || "").toContain("not a git repository");
  });

  test("creates isolated worktree when mode is worktree", () => {
    const gitVersion = runGit(["--version"]);
    if (!gitVersion.ok) {
      expect(true).toBeTrue();
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "rollcode-git-isolation-worktree-"));
    roots.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");

    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    expect(runGit(["-C", repo, "init"]).ok).toBeTrue();
    expect(runGit(["-C", repo, "config", "user.email", "test@example.com"]).ok).toBeTrue();
    expect(runGit(["-C", repo, "config", "user.name", "RollCode Test"]).ok).toBeTrue();

    writeFileSync(join(repo, "README.md"), "seed\n", "utf8");
    expect(runGit(["-C", repo, "add", "."]).ok).toBeTrue();
    expect(runGit(["-C", repo, "commit", "-m", "init"]).ok).toBeTrue();

    const context = prepareWorkspaceIsolation(repo, "worktree");
    expect(context.mode).toBe("worktree");
    expect(typeof context.worktreePath).toBe("string");
    expect(typeof context.branchName).toBe("string");
    expect(context.executionCwd).not.toBe(repo);
    expect(context.executionCwd).toContain(".rollcode-home");
  });
});
