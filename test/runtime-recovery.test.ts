import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAppServerClient } from "../src/codex/client";
import { getRunCheckpointPath } from "../src/config";
import { saveRunCheckpoint } from "../src/runtime/checkpoint";
import { RollcodeService } from "../src/runtime/service";
import { StateStore } from "../src/state/store";

interface ThreadState {
  workerCount: number;
  supervisorCount: number;
}

function allocateThreadId(
  state: ThreadState,
  params?: { baseInstructions?: string },
): string {
  const baseInstructions = params?.baseInstructions ?? "";
  if (baseInstructions.includes("supervisor context")) {
    state.supervisorCount += 1;
    return state.supervisorCount === 1
      ? "supervisor-thread"
      : `supervisor-thread-${state.supervisorCount}`;
  }
  state.workerCount += 1;
  return state.workerCount === 1
    ? "worker-thread"
    : `worker-helper-${state.workerCount - 1}`;
}

class FakeCodexRecovery {
  private threadState: ThreadState = { workerCount: 0, supervisorCount: 0 };
  workerCalls = 0;
  supervisorCalls = 0;
  readonly enabledSkills: string[] = [];

  async dispose() {}
  async reloadSkills() {
    return { data: [] };
  }
  async setSkillEnabled(path: string) {
    this.enabledSkills.push(path);
  }
  async startThread(params?: { baseInstructions?: string }) {
    return allocateThreadId(this.threadState, params);
  }
  async resumeThread(params: { threadId: string }) {
    return params.threadId;
  }
  async interruptTurn() {}
  async steerTurn() {}
  async readThread() {
    return { turns: [] };
  }

  async runStructuredTurn<_T>(params: { threadId: string }): Promise<unknown> {
    if (params.threadId.startsWith("worker")) {
      this.workerCalls += 1;
      throw new Error(
        "worker lane should not run when checkpoint already has pending worker artifacts",
      );
    }

    this.supervisorCalls += 1;
    return {
      turnId: "supervisor-turn-1",
      finalMessage: JSON.stringify({
        action: "complete",
        rationale: "Recovered artifacts were sufficient.",
        memoryAction: "none",
      }),
      parsed: {
        action: "complete",
        rationale: "Recovered artifacts were sufficient.",
        memoryAction: "none",
      },
      plan: [],
      diff: "",
      commandOutput: "",
      items: [],
    };
  }
}

describe("runtime checkpoint recovery", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.ROLLCODE_HOME;
    delete process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR;
  });

  test("recovers pending worker artifacts and resumes directly at supervisor lane", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-runtime-recovery-"));
    dirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = join(
      root,
      ".codex-skills-rollcode",
    );

    const store = new StateStore(join(root, "state.json"));
    const fakeCodex = new FakeCodexRecovery();
    const service = new RollcodeService(
      store,
      fakeCodex as unknown as CodexAppServerClient,
    );

    const run = await service.createRun(
      "Recover run from checkpoint.",
      root,
      false,
    );
    const checkpointPath = getRunCheckpointPath(run.agentId, run.id);
    const recoveredWorkerOutput = {
      userMessage: "Worker completed before crash.",
      handoff: {
        summary: "Recovered worker artifacts.",
        evidence: ["artifact A", "artifact B"],
        unresolved: [],
        completionClaim: true,
      },
    };
    await saveRunCheckpoint(checkpointPath, {
      runId: run.id,
      phase: "worker-completed",
      pendingWorkerArtifacts: {
        turnId: "worker-turn-recovered",
        finalMessage: JSON.stringify(recoveredWorkerOutput),
        parsed: recoveredWorkerOutput,
        plan: [{ step: "Recovered step", status: "completed" }],
        diff: "diff --git a/a b/a",
        commandOutput: "$ bun test\npass\n",
        commandExecutions: [],
      },
      plan: [{ step: "Recovered step", status: "completed" }],
      diff: "diff --git a/a b/a",
      commandOutput: "$ bun test\npass\n",
      commandExecutions: [],
    });

    const controller = await service.openSessionForRun(run.id);
    await controller.start();

    for (let index = 0; index < 80; index += 1) {
      const snapshot = controller.getSnapshot();
      if (snapshot.run.status === "completed") {
        expect(fakeCodex.workerCalls).toBe(0);
        expect(fakeCodex.supervisorCalls).toBe(1);
        expect(snapshot.latestSupervisorDecision?.action).toBe("complete");
        expect(
          snapshot.logs.some((line) =>
            line.includes(
              "Recovered pending worker artifacts from checkpoint; resuming with supervisor review.",
            ),
          ),
        ).toBeTrue();
        const checkpointContent = readFileSync(checkpointPath, "utf8");
        expect(checkpointContent.trim()).toBe("");
        await controller.dispose();
        await service.dispose();
        return;
      }
      await Bun.sleep(25);
    }

    await controller.dispose();
    await service.dispose();
    throw new Error("checkpoint recovery did not complete in time");
  });
});
