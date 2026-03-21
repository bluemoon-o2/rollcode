import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("memory manager", () => {
  let rollcodeHome = "";

  beforeEach(() => {
    rollcodeHome = mkdtempSync(join(tmpdir(), "rollcode-memory-"));
    process.env.ROLLCODE_HOME = rollcodeHome;
  });

  afterEach(() => {
    rmSync(rollcodeHome, { recursive: true, force: true });
    delete process.env.ROLLCODE_HOME;
  });

  test("initializes and materializes consolidated memory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rollcode-project-"));
    const { MemoryManager } = await import("../src/memory/manager");
    const memory = new MemoryManager("agent-memory-test");
    await memory.ensureInitialized(cwd);

    const before = await memory.status();
    expect(before).toContain("identity.md");
    expect(before).toContain("project-context.md");

    const summary = await memory.materializeDecision(
      {
        id: "run-1",
        agentId: "agent-memory-test",
        goal: "improve prompts",
        status: "working",
        detached: false,
        ownerPid: null,
        pendingInstruction: null,
        workerTurnCount: 1,
        latestWorkerTurnId: null,
        latestSupervisorTurnId: null,
        memoryReminderDue: false,
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
      },
      {
        summary:
          "Prefer concise system prompts with explicit output contracts.",
        evidence: ["worker used structured handoff"],
        unresolved: [],
        completionClaim: true,
      },
      {
        action: "complete",
        rationale: "durable lesson for future runs",
        memoryAction: "consolidate",
      },
    );

    expect(summary).toContain("Prefer concise system prompts");
    const after = await memory.status();
    expect(after).toContain("episodes/");
    expect(memory.log()).toContain("memory: consolidate");

    rmSync(cwd, { recursive: true, force: true });
  });

  test("builds task recall from non-system files and enforces frontmatter limits", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rollcode-project-"));
    const { MemoryManager } = await import("../src/memory/manager");
    const memory = new MemoryManager("agent-memory-recall-test");
    await memory.ensureInitialized(cwd);

    const notePath = join(memory.memoryDir, "project", "deploy-notes.md");
    writeFileSync(
      notePath,
      [
        "---",
        "description: rollback runbook for deployments",
        "limit: 48",
        "---",
        "Rollback strategy: revert commit, restore migrations, validate smoke checks, then reopen traffic gradually.",
        "",
      ].join("\n"),
      "utf8",
    );

    const recall = await memory.buildTaskRecall({
      goal: "prepare rollback strategy for failed release",
      pendingInstruction: "collect rollback runbook",
      maxResults: 3,
    });

    expect(recall).toContain("project/deploy-notes.md");
    expect(recall).toContain("[truncated by memory limit 48]");

    rmSync(cwd, { recursive: true, force: true });
  });

  test("installs frontmatter pre-commit hook and blocks read_only file edits", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rollcode-project-"));
    const { MemoryManager } = await import("../src/memory/manager");
    const memory = new MemoryManager("agent-memory-hook-test");
    await memory.ensureInitialized(cwd);

    const runGit = (args: string[]) =>
      Bun.spawnSync({
        cmd: ["git", ...args],
        cwd: memory.memoryDir,
        stdout: "pipe",
        stderr: "pipe",
      });

    const hookPath = join(memory.memoryDir, ".git", "hooks", "pre-commit");
    const hook = readFileSync(hookPath, "utf8");
    expect(hook).toContain("Frontmatter validation failed:");

    const lockedPath = join(memory.memoryDir, "system", "locked.md");
    writeFileSync(
      lockedPath,
      [
        "---",
        "description: locked entry",
        "limit: 42",
        "read_only: true",
        "---",
        "seed",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(runGit(["add", "system/locked.md"]).exitCode).toBe(0);
    expect(
      runGit(["commit", "--no-verify", "-m", "seed read-only file"]).exitCode,
    ).toBe(0);

    writeFileSync(
      lockedPath,
      [
        "---",
        "description: locked entry",
        "limit: 42",
        "read_only: true",
        "---",
        "changed",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(runGit(["add", "system/locked.md"]).exitCode).toBe(0);
    const commit = runGit(["commit", "-m", "attempt read-only edit"]);
    const stdout = new TextDecoder().decode(commit.stdout);
    const stderr = new TextDecoder().decode(commit.stderr);

    expect(commit.exitCode).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toContain("read_only");

    rmSync(cwd, { recursive: true, force: true });
  });

  test("pre-commit hook rejects unknown frontmatter keys", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rollcode-project-"));
    const { MemoryManager } = await import("../src/memory/manager");
    const memory = new MemoryManager("agent-memory-hook-key-test");
    await memory.ensureInitialized(cwd);

    const runGit = (args: string[]) =>
      Bun.spawnSync({
        cmd: ["git", ...args],
        cwd: memory.memoryDir,
        stdout: "pipe",
        stderr: "pipe",
      });

    const badPath = join(memory.memoryDir, "system", "bad.md");
    writeFileSync(
      badPath,
      [
        "---",
        "description: bad frontmatter",
        "limit: 9",
        "unexpected: value",
        "---",
        "body",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(runGit(["add", "system/bad.md"]).exitCode).toBe(0);
    const commit = runGit(["commit", "-m", "add bad frontmatter"]);
    const stdout = new TextDecoder().decode(commit.stdout);
    const stderr = new TextDecoder().decode(commit.stderr);

    expect(commit.exitCode).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toContain("unknown frontmatter key");

    rmSync(cwd, { recursive: true, force: true });
  });
});
