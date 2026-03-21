import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRunCheckpointPath, getRunSessionStatusPath } from "../src/config";
import { runRuntimeDoctor } from "../src/runtime/doctor";
import { StateStore } from "../src/state/store";
import { readTextIfExists, writeText } from "../src/utils/fs";

describe("runtime doctor", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.ROLLCODE_HOME;
  });

  test("detects and fixes stale owner/checkpoint/session files", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-doctor-"));
    tempDirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");

    const store = new StateStore(join(root, "state.json"));
    const agent = store.upsertAgent({
      id: "agent-1",
      name: "agent-1",
      cwd: root,
      workerThreadId: null,
      supervisorThreadId: null,
    });
    const activeRun = store.insertRun({
      id: "run-active",
      agentId: agent.id,
      goal: "active",
      status: "working",
      detached: true,
      ownerPid: 999_999,
      pendingInstruction: "continue",
      workerTurnCount: 0,
      latestWorkerTurnId: null,
      latestSupervisorTurnId: null,
      memoryReminderDue: false,
      lastError: null,
    });
    const completedRun = store.insertRun({
      id: "run-complete",
      agentId: agent.id,
      goal: "done",
      status: "completed",
      detached: false,
      ownerPid: null,
      pendingInstruction: null,
      workerTurnCount: 1,
      latestWorkerTurnId: "worker-1",
      latestSupervisorTurnId: "supervisor-1",
      memoryReminderDue: false,
      lastError: null,
    });

    const invalidCheckpointPath = getRunCheckpointPath(agent.id, activeRun.id);
    await writeText(invalidCheckpointPath, "{bad json\n");
    const staleCheckpointPath = getRunCheckpointPath(agent.id, completedRun.id);
    await writeText(
      staleCheckpointPath,
      `${JSON.stringify(
        {
          runId: completedRun.id,
          phase: "worker-dispatched",
          pendingWorkerArtifacts: null,
          plan: [],
          diff: "",
          commandOutput: "",
          commandExecutions: [],
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    const invalidSessionPath = getRunSessionStatusPath(agent.id, activeRun.id);
    await writeText(invalidSessionPath, "not-json\n");

    const dryRun = await runRuntimeDoctor({ store, fix: false });
    const dryCodes = dryRun.issues.map((issue) => issue.code);
    expect(dryCodes).toContain("orphan-run-owner");
    expect(dryCodes).toContain("invalid-checkpoint");
    expect(dryCodes).toContain("stale-checkpoint");
    expect(dryCodes).toContain("invalid-session-status");

    const fixed = await runRuntimeDoctor({ store, fix: true });
    expect(fixed.fixesApplied.length).toBeGreaterThan(0);

    const refreshed = store.getRunById(activeRun.id);
    expect(refreshed?.ownerPid).toBeNull();
    expect((await readTextIfExists(invalidCheckpointPath))?.trim() ?? "").toBe(
      "",
    );
    expect((await readTextIfExists(staleCheckpointPath))?.trim() ?? "").toBe(
      "",
    );
    expect((await readTextIfExists(invalidSessionPath))?.trim() ?? "").toBe("");

    store.close();
  });
});
