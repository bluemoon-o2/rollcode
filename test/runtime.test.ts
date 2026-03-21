import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAppServerClient } from "../src/codex/client";
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
  if (state.workerCount === 1) {
    return "worker-thread";
  }
  return `worker-helper-${state.workerCount - 1}`;
}

function isHelperWorkerThread(threadId: string): boolean {
  return threadId.startsWith("worker-helper-");
}

function helperWorkerTurn(threadId: string): unknown {
  return {
    turnId: `${threadId}-turn`,
    finalMessage: JSON.stringify({
      userMessage: `${threadId} completed helper analysis.`,
      handoff: {
        summary: `${threadId} reviewed parallel track.`,
        evidence: [`${threadId} evidence`],
        unresolved: [],
        completionClaim: true,
      },
    }),
    parsed: {
      userMessage: `${threadId} completed helper analysis.`,
      handoff: {
        summary: `${threadId} reviewed parallel track.`,
        evidence: [`${threadId} evidence`],
        unresolved: [],
        completionClaim: true,
      },
    },
    plan: [{ step: `${threadId} review`, status: "completed" }],
    diff: "",
    commandOutput: "",
    commandExecutions: [],
    items: [],
  };
}

class FakeCodex {
  private threadState: ThreadState = { workerCount: 0, supervisorCount: 0 };
  private workerTurns = 0;
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
    if (isHelperWorkerThread(params.threadId)) {
      return helperWorkerTurn(params.threadId);
    }
    if (params.threadId === "worker-thread") {
      this.workerTurns += 1;
      if (this.workerTurns === 1) {
        return {
          turnId: "worker-turn-1",
          finalMessage: JSON.stringify({
            userMessage: "Investigated and found a missing test.",
            handoff: {
              summary: "The test gap is identified but not fixed yet.",
              evidence: ["located the failing branch"],
              unresolved: ["test missing"],
              completionClaim: false,
            },
          }),
          parsed: {
            userMessage: "Investigated and found a missing test.",
            handoff: {
              summary: "The test gap is identified but not fixed yet.",
              evidence: ["located the failing branch"],
              unresolved: ["test missing"],
              completionClaim: false,
            },
          },
          plan: [{ step: "Add the missing test", status: "completed" }],
          diff: "",
          commandOutput: "",
          items: [],
        };
      }
      return {
        turnId: "worker-turn-2",
        finalMessage: JSON.stringify({
          userMessage: "Added the missing test and verified the behavior.",
          handoff: {
            summary:
              "The missing test is now in place and verification passed.",
            evidence: ["test added", "verification passed"],
            unresolved: [],
            completionClaim: true,
          },
        }),
        parsed: {
          userMessage: "Added the missing test and verified the behavior.",
          handoff: {
            summary:
              "The missing test is now in place and verification passed.",
            evidence: ["test added", "verification passed"],
            unresolved: [],
            completionClaim: true,
          },
        },
        plan: [{ step: "Add the missing test", status: "completed" }],
        diff: "diff --git a/test b/test",
        commandOutput: "bun test",
        items: [],
      };
    }

    if (this.workerTurns === 1) {
      return {
        turnId: "supervisor-turn-1",
        finalMessage: JSON.stringify({
          action: "repair",
          rationale: "The worker is not done yet.",
          nextInstruction:
            "Implement the missing test and re-run verification.",
          memoryAction: "review",
        }),
        parsed: {
          action: "repair",
          rationale: "The worker is not done yet.",
          nextInstruction:
            "Implement the missing test and re-run verification.",
          memoryAction: "review",
        },
        plan: [],
        diff: "",
        commandOutput: "",
        items: [],
      };
    }

    return {
      turnId: "supervisor-turn-2",
      finalMessage: JSON.stringify({
        action: "complete",
        rationale: "The evidence is now sufficient.",
        memoryAction: "consolidate",
      }),
      parsed: {
        action: "complete",
        rationale: "The evidence is now sufficient.",
        memoryAction: "consolidate",
      },
      plan: [],
      diff: "",
      commandOutput: "",
      items: [],
    };
  }
}

class FakeCodexSuggestSkillChange {
  private threadState: ThreadState = { workerCount: 0, supervisorCount: 0 };
  private workerTurns = 0;
  private supervisorTurns = 0;
  readonly enabledSkills: string[] = [];

  constructor(private readonly projectRoot: string) {}

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
    if (isHelperWorkerThread(params.threadId)) {
      return helperWorkerTurn(params.threadId);
    }
    if (params.threadId === "worker-thread") {
      this.workerTurns += 1;
      if (this.workerTurns === 1) {
        return {
          turnId: "worker-turn-1",
          finalMessage: JSON.stringify({
            userMessage: "Initial implementation done, more work needed.",
            handoff: {
              summary: "Initial pass complete; waiting for follow-up.",
              evidence: ["baseline work complete"],
              unresolved: ["follow-up needed"],
              completionClaim: false,
            },
          }),
          parsed: {
            userMessage: "Initial implementation done, more work needed.",
            handoff: {
              summary: "Initial pass complete; waiting for follow-up.",
              evidence: ["baseline work complete"],
              unresolved: ["follow-up needed"],
              completionClaim: false,
            },
          },
          plan: [{ step: "Implement baseline", status: "completed" }],
          diff: "",
          commandOutput: "",
          items: [],
        };
      }
      return {
        turnId: "worker-turn-2",
        finalMessage: JSON.stringify({
          userMessage: "Follow-up finished.",
          handoff: {
            summary: "Follow-up completed after supervisor guidance.",
            evidence: ["follow-up complete"],
            unresolved: [],
            completionClaim: true,
          },
        }),
        parsed: {
          userMessage: "Follow-up finished.",
          handoff: {
            summary: "Follow-up completed after supervisor guidance.",
            evidence: ["follow-up complete"],
            unresolved: [],
            completionClaim: true,
          },
        },
        plan: [{ step: "Implement follow-up", status: "completed" }],
        diff: "",
        commandOutput: "",
        items: [],
      };
    }

    this.supervisorTurns += 1;
    if (this.supervisorTurns === 1) {
      const lateSkillDir = join(this.projectRoot, ".skills", "late-skill");
      mkdirSync(lateSkillDir, { recursive: true });
      writeFileSync(
        join(lateSkillDir, "SKILL.md"),
        `---
name: late-skill
description: skill added during run
---

# late-skill
`,
        "utf8",
      );
      return {
        turnId: "supervisor-turn-1",
        finalMessage: JSON.stringify({
          action: "repair",
          rationale: "Need a follow-up pass.",
          nextInstruction: "Run follow-up step.",
          memoryAction: "none",
        }),
        parsed: {
          action: "repair",
          rationale: "Need a follow-up pass.",
          nextInstruction: "Run follow-up step.",
          memoryAction: "none",
        },
        plan: [],
        diff: "",
        commandOutput: "",
        items: [],
      };
    }

    return {
      turnId: "supervisor-turn-2",
      finalMessage: JSON.stringify({
        action: "complete",
        rationale: "Evidence is sufficient.",
        memoryAction: "none",
      }),
      parsed: {
        action: "complete",
        rationale: "Evidence is sufficient.",
        memoryAction: "none",
      },
      plan: [],
      diff: "",
      commandOutput: "",
      items: [],
    };
  }
}

class FakeCodexTransientSupervisor {
  private threadState: ThreadState = { workerCount: 0, supervisorCount: 0 };
  private supervisorAttempts = 0;
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
    if (isHelperWorkerThread(params.threadId)) {
      return helperWorkerTurn(params.threadId);
    }
    if (params.threadId === "worker-thread") {
      return {
        turnId: "worker-turn-1",
        finalMessage: JSON.stringify({
          userMessage: "Worker done.",
          handoff: {
            summary: "Completed task.",
            evidence: ["artifact generated"],
            unresolved: [],
            completionClaim: true,
          },
        }),
        parsed: {
          userMessage: "Worker done.",
          handoff: {
            summary: "Completed task.",
            evidence: ["artifact generated"],
            unresolved: [],
            completionClaim: true,
          },
        },
        plan: [{ step: "Complete task", status: "completed" }],
        diff: "diff --git a/a b/a",
        commandOutput: "ok",
        items: [],
      };
    }

    this.supervisorAttempts += 1;
    if (this.supervisorAttempts === 1) {
      throw new Error(
        "unexpected status 502 Bad Gateway: error code: 502, url: https://example.invalid/responses",
      );
    }
    return {
      turnId: "supervisor-turn-1",
      finalMessage: JSON.stringify({
        action: "complete",
        rationale: "Evidence is sufficient.",
        memoryAction: "none",
      }),
      parsed: {
        action: "complete",
        rationale: "Evidence is sufficient.",
        memoryAction: "none",
      },
      plan: [],
      diff: "",
      commandOutput: "",
      items: [],
    };
  }
}

class FakeCodexSupervisorSchemaFallback {
  private threadState: ThreadState = { workerCount: 0, supervisorCount: 0 };
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

  async runStructuredTurn<_T>(params: {
    threadId: string;
    outputSchema?: { required?: unknown };
  }): Promise<unknown> {
    if (isHelperWorkerThread(params.threadId)) {
      return helperWorkerTurn(params.threadId);
    }
    if (params.threadId === "worker-thread") {
      return {
        turnId: "worker-turn-1",
        finalMessage: JSON.stringify({
          userMessage: "Worker done.",
          handoff: {
            summary: "Completed task.",
            evidence: ["artifact generated"],
            unresolved: [],
            completionClaim: true,
          },
        }),
        parsed: {
          userMessage: "Worker done.",
          handoff: {
            summary: "Completed task.",
            evidence: ["artifact generated"],
            unresolved: [],
            completionClaim: true,
          },
        },
        plan: [{ step: "Complete task", status: "completed" }],
        diff: "diff --git a/a b/a",
        commandOutput: "ok",
        items: [],
      };
    }

    const required = Array.isArray(params.outputSchema?.required)
      ? params.outputSchema.required
      : [];
    const strictSchema = required.includes("nextInstruction");
    if (strictSchema) {
      throw new Error(
        "schema validation failed: required property `nextInstruction` missing",
      );
    }
    return {
      turnId: "supervisor-turn-1",
      finalMessage: JSON.stringify({
        action: "complete",
        rationale: "Evidence is sufficient.",
        memoryAction: "none",
      }),
      parsed: {
        action: "complete",
        rationale: "Evidence is sufficient.",
        memoryAction: "none",
      },
      plan: [],
      diff: "",
      commandOutput: "",
      items: [],
    };
  }
}

class FakeCodexBlockedThenContinue {
  private threadState: ThreadState = { workerCount: 0, supervisorCount: 0 };
  private workerAttempts = 0;
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
    if (isHelperWorkerThread(params.threadId)) {
      return helperWorkerTurn(params.threadId);
    }
    if (params.threadId === "worker-thread") {
      this.workerAttempts += 1;
      if (this.workerAttempts === 1) {
        throw new Error("schema parse failure in upstream bridge");
      }
      return {
        turnId: "worker-turn-2",
        finalMessage: JSON.stringify({
          userMessage: "Worker recovered and finished.",
          handoff: {
            summary: "Finished after operator guidance.",
            evidence: ["retry succeeded"],
            unresolved: [],
            completionClaim: true,
          },
        }),
        parsed: {
          userMessage: "Worker recovered and finished.",
          handoff: {
            summary: "Finished after operator guidance.",
            evidence: ["retry succeeded"],
            unresolved: [],
            completionClaim: true,
          },
        },
        plan: [{ step: "Recover run", status: "completed" }],
        diff: "",
        commandOutput: "",
        items: [],
      };
    }

    return {
      turnId: "supervisor-turn-1",
      finalMessage: JSON.stringify({
        action: "complete",
        rationale: "Recovered successfully.",
        memoryAction: "none",
      }),
      parsed: {
        action: "complete",
        rationale: "Recovered successfully.",
        memoryAction: "none",
      },
      plan: [],
      diff: "",
      commandOutput: "",
      items: [],
    };
  }
}

class FakeCodexCommandArtifacts {
  private threadState: ThreadState = { workerCount: 0, supervisorCount: 0 };
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
    if (isHelperWorkerThread(params.threadId)) {
      return helperWorkerTurn(params.threadId);
    }
    if (params.threadId === "worker-thread") {
      return {
        turnId: "worker-turn-1",
        finalMessage: JSON.stringify({
          userMessage: "Executed verification.",
          handoff: {
            summary: "Verification command completed successfully.",
            evidence: ["bun test passed"],
            unresolved: [],
            completionClaim: true,
          },
        }),
        parsed: {
          userMessage: "Executed verification.",
          handoff: {
            summary: "Verification command completed successfully.",
            evidence: ["bun test passed"],
            unresolved: [],
            completionClaim: true,
          },
        },
        plan: [{ step: "Run tests", status: "completed" }],
        diff: "",
        commandOutput: "",
        commandExecutions: [
          {
            id: "id:cmd-1",
            command: "bun test",
            output: "1 pass\n",
            phase: "finished",
            success: true,
            exitCode: 0,
          },
        ],
        items: [],
      };
    }

    return {
      turnId: "supervisor-turn-1",
      finalMessage: JSON.stringify({
        action: "complete",
        rationale: "Verification evidence is sufficient.",
        memoryAction: "none",
      }),
      parsed: {
        action: "complete",
        rationale: "Verification evidence is sufficient.",
        memoryAction: "none",
      },
      plan: [],
      diff: "",
      commandOutput: "",
      items: [],
    };
  }
}

class FakeCodexCommandNotifications {
  private threadState: ThreadState = { workerCount: 0, supervisorCount: 0 };
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

  async runStructuredTurn<_T>(params: {
    threadId: string;
    onNotification?: (method: string, params: unknown) => void;
  }): Promise<unknown> {
    if (isHelperWorkerThread(params.threadId)) {
      params.onNotification?.("turn/started", {
        threadId: params.threadId,
        turn: { id: `${params.threadId}-turn` },
      });
      params.onNotification?.("turn/completed", {
        threadId: params.threadId,
        turn: { id: `${params.threadId}-turn`, status: "completed" },
      });
      return helperWorkerTurn(params.threadId);
    }
    if (params.threadId === "worker-thread") {
      params.onNotification?.("turn/started", {
        threadId: "worker-thread",
        turn: { id: "worker-turn-1" },
      });
      params.onNotification?.("item/started", {
        threadId: "worker-thread",
        turnId: "worker-turn-1",
        itemId: "cmd-1",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "echo streamed",
        },
      });
      params.onNotification?.("item/commandExecution/outputDelta", {
        threadId: "worker-thread",
        turnId: "worker-turn-1",
        itemId: "cmd-1",
        delta: "streamed\n",
      });
      params.onNotification?.("item/completed", {
        threadId: "worker-thread",
        turnId: "worker-turn-1",
        itemId: "cmd-1",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "echo streamed",
          exitCode: 0,
          aggregatedOutput: "streamed\n",
        },
      });
      params.onNotification?.("turn/completed", {
        threadId: "worker-thread",
        turn: { id: "worker-turn-1", status: "completed" },
      });
      return {
        turnId: "worker-turn-1",
        finalMessage: JSON.stringify({
          userMessage: "Captured streamed command output.",
          handoff: {
            summary: "Command stream completed and captured.",
            evidence: ["streamed output captured"],
            unresolved: [],
            completionClaim: true,
          },
        }),
        parsed: {
          userMessage: "Captured streamed command output.",
          handoff: {
            summary: "Command stream completed and captured.",
            evidence: ["streamed output captured"],
            unresolved: [],
            completionClaim: true,
          },
        },
        plan: [{ step: "Run command", status: "completed" }],
        diff: "",
        commandOutput: "",
        commandExecutions: [],
        items: [],
      };
    }

    return {
      turnId: "supervisor-turn-1",
      finalMessage: JSON.stringify({
        action: "complete",
        rationale: "Command stream evidence is sufficient.",
        memoryAction: "none",
      }),
      parsed: {
        action: "complete",
        rationale: "Command stream evidence is sufficient.",
        memoryAction: "none",
      },
      plan: [],
      diff: "",
      commandOutput: "",
      items: [],
    };
  }
}

class FakeCodexRequestUserInputNotifications {
  private threadState: ThreadState = { workerCount: 0, supervisorCount: 0 };
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

  async runStructuredTurn<_T>(params: {
    threadId: string;
    onNotification?: (method: string, params: unknown) => void;
  }): Promise<unknown> {
    if (isHelperWorkerThread(params.threadId)) {
      return helperWorkerTurn(params.threadId);
    }
    if (params.threadId === "worker-thread") {
      params.onNotification?.("turn/started", {
        threadId: "worker-thread",
        turn: { id: "worker-turn-1" },
      });
      params.onNotification?.("serverRequest/handled", {
        method: "item/tool/requestUserInput",
        params: {
          threadId: "worker-thread",
          turnId: "worker-turn-1",
          itemId: "item-1",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Choose scope",
              options: [
                {
                  label: "Recommended scope",
                  description: "default",
                },
              ],
            },
          ],
        },
        result: {
          answers: {
            scope: {
              answers: ["Recommended scope"],
            },
          },
        },
      });
      params.onNotification?.("turn/completed", {
        threadId: "worker-thread",
        turn: { id: "worker-turn-1", status: "completed" },
      });
      return {
        turnId: "worker-turn-1",
        finalMessage: JSON.stringify({
          userMessage: "Handled user-input checkpoint and completed.",
          handoff: {
            summary: "Completed with request_user_input checkpoint.",
            evidence: ["checkpoint handled"],
            unresolved: [],
            completionClaim: true,
          },
        }),
        parsed: {
          userMessage: "Handled user-input checkpoint and completed.",
          handoff: {
            summary: "Completed with request_user_input checkpoint.",
            evidence: ["checkpoint handled"],
            unresolved: [],
            completionClaim: true,
          },
        },
        plan: [{ step: "Finish scoped implementation", status: "completed" }],
        diff: "",
        commandOutput: "",
        commandExecutions: [],
        items: [],
      };
    }
    return {
      turnId: "supervisor-turn-1",
      finalMessage: JSON.stringify({
        action: "complete",
        rationale: "request_user_input evidence is sufficient.",
        memoryAction: "none",
      }),
      parsed: {
        action: "complete",
        rationale: "request_user_input evidence is sufficient.",
        memoryAction: "none",
      },
      plan: [],
      diff: "",
      commandOutput: "",
      items: [],
    };
  }
}

class FakeCodexParallelAggregation {
  private threadState: ThreadState = { workerCount: 0, supervisorCount: 0 };
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
    if (isHelperWorkerThread(params.threadId)) {
      return {
        turnId: `${params.threadId}-turn`,
        finalMessage: JSON.stringify({
          userMessage: `${params.threadId} helper pass finished.`,
          handoff: {
            summary: "Helper verified edge cases.",
            evidence: ["helper validation complete"],
            unresolved: [],
            completionClaim: true,
          },
        }),
        parsed: {
          userMessage: `${params.threadId} helper pass finished.`,
          handoff: {
            summary: "Helper verified edge cases.",
            evidence: ["helper validation complete"],
            unresolved: [],
            completionClaim: true,
          },
        },
        plan: [{ step: "Parallel helper validation", status: "completed" }],
        diff: "",
        commandOutput: "$ bun test helper\npass\n(exit 0)\n",
        commandExecutions: [
          {
            id: "id:helper-cmd",
            command: "bun test helper",
            output: "pass\n",
            phase: "finished",
            success: true,
            exitCode: 0,
          },
        ],
        items: [],
      };
    }
    if (params.threadId === "worker-thread") {
      return {
        turnId: "worker-turn-main",
        finalMessage: JSON.stringify({
          userMessage: "Primary lane implemented the change.",
          handoff: {
            summary: "Primary implementation complete.",
            evidence: ["primary patch applied"],
            unresolved: [],
            completionClaim: true,
          },
        }),
        parsed: {
          userMessage: "Primary lane implemented the change.",
          handoff: {
            summary: "Primary implementation complete.",
            evidence: ["primary patch applied"],
            unresolved: [],
            completionClaim: true,
          },
        },
        plan: [{ step: "Implement primary patch", status: "completed" }],
        diff: "diff --git a/a b/a",
        commandOutput: "",
        commandExecutions: [],
        items: [],
      };
    }
    return {
      turnId: "supervisor-turn-1",
      finalMessage: JSON.stringify({
        action: "complete",
        rationale: "Primary and helper evidence are sufficient.",
        memoryAction: "none",
      }),
      parsed: {
        action: "complete",
        rationale: "Primary and helper evidence are sufficient.",
        memoryAction: "none",
      },
      plan: [],
      diff: "",
      commandOutput: "",
      items: [],
    };
  }
}

class FakeCodexPlanMissing {
  private threadState: ThreadState = { workerCount: 0, supervisorCount: 0 };
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
    if (isHelperWorkerThread(params.threadId)) {
      return {
        turnId: `${params.threadId}-turn`,
        finalMessage: JSON.stringify({
          userMessage: "Helper has no plan output.",
          handoff: {
            summary: "No helper plan generated.",
            evidence: ["helper observed gap"],
            unresolved: [],
            completionClaim: true,
          },
        }),
        parsed: {
          userMessage: "Helper has no plan output.",
          handoff: {
            summary: "No helper plan generated.",
            evidence: ["helper observed gap"],
            unresolved: [],
            completionClaim: true,
          },
        },
        plan: [],
        diff: "",
        commandOutput: "",
        commandExecutions: [],
        items: [],
      };
    }
    if (params.threadId === "worker-thread") {
      return {
        turnId: "worker-turn-main",
        finalMessage: JSON.stringify({
          userMessage: "Primary finished without plan updates.",
          handoff: {
            summary: "No plan updates emitted.",
            evidence: ["work complete"],
            unresolved: [],
            completionClaim: true,
          },
        }),
        parsed: {
          userMessage: "Primary finished without plan updates.",
          handoff: {
            summary: "No plan updates emitted.",
            evidence: ["work complete"],
            unresolved: [],
            completionClaim: true,
          },
        },
        plan: [],
        diff: "",
        commandOutput: "",
        commandExecutions: [],
        items: [],
      };
    }
    return {
      turnId: "supervisor-turn-1",
      finalMessage: JSON.stringify({
        action: "complete",
        rationale: "Done.",
        memoryAction: "none",
      }),
      parsed: {
        action: "complete",
        rationale: "Done.",
        memoryAction: "none",
      },
      plan: [],
      diff: "",
      commandOutput: "",
      items: [],
    };
  }
}

class FakeCodexParallelCircuitRecovery {
  private threadState: ThreadState = { workerCount: 0, supervisorCount: 0 };
  private workerTurns = 0;
  private helperInvocations = 0;
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
    if (isHelperWorkerThread(params.threadId)) {
      this.helperInvocations += 1;
      if (this.helperInvocations <= 2) {
        throw new Error(`helper lane failed (${this.helperInvocations})`);
      }
      return helperWorkerTurn(params.threadId);
    }

    if (params.threadId === "worker-thread") {
      this.workerTurns += 1;
      const completionClaim = this.workerTurns >= 4;
      const plan = Array.from({ length: this.workerTurns }, (_, index) => ({
        step: `Parallel stage ${index + 1}`,
        status: "completed",
      }));
      return {
        turnId: `worker-turn-${this.workerTurns}`,
        finalMessage: JSON.stringify({
          userMessage: completionClaim
            ? "Primary lane finished all stages."
            : "Primary lane advanced one stage.",
          handoff: {
            summary: completionClaim
              ? "All stages are complete."
              : "Progressed to next stage; work remains.",
            evidence: [`stage-${this.workerTurns} complete`],
            unresolved: completionClaim ? [] : ["remaining stages"],
            completionClaim,
          },
        }),
        parsed: {
          userMessage: completionClaim
            ? "Primary lane finished all stages."
            : "Primary lane advanced one stage.",
          handoff: {
            summary: completionClaim
              ? "All stages are complete."
              : "Progressed to next stage; work remains.",
            evidence: [`stage-${this.workerTurns} complete`],
            unresolved: completionClaim ? [] : ["remaining stages"],
            completionClaim,
          },
        },
        plan,
        diff: "",
        commandOutput: "",
        commandExecutions: [],
        items: [],
      };
    }

    if (this.workerTurns < 4) {
      return {
        turnId: `supervisor-turn-${this.workerTurns}`,
        finalMessage: JSON.stringify({
          action: "repair",
          rationale: "Need more completed stages before finish.",
          nextInstruction: "Continue parallel implementation and verification.",
          memoryAction: "none",
        }),
        parsed: {
          action: "repair",
          rationale: "Need more completed stages before finish.",
          nextInstruction: "Continue parallel implementation and verification.",
          memoryAction: "none",
        },
        plan: [],
        diff: "",
        commandOutput: "",
        items: [],
      };
    }

    return {
      turnId: "supervisor-turn-complete",
      finalMessage: JSON.stringify({
        action: "complete",
        rationale: "Stages are complete and evidence is sufficient.",
        memoryAction: "none",
      }),
      parsed: {
        action: "complete",
        rationale: "Stages are complete and evidence is sufficient.",
        memoryAction: "none",
      },
      plan: [],
      diff: "",
      commandOutput: "",
      items: [],
    };
  }
}

describe("runtime orchestration", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.ROLLCODE_HOME;
    delete process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR;
    delete process.env.ROLLCODE_SKILL_DISCOVERY_MODE;
  });

  test("repairs and then completes under supervisor control", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-runtime-"));
    dirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = join(
      root,
      ".codex-skills-rollcode",
    );
    const store = new StateStore(join(root, "state.json"));
    const service = new RollcodeService(
      store,
      new FakeCodex() as unknown as CodexAppServerClient,
    );

    const controller = await service.startInteractiveRun(
      "Fix the missing test coverage.",
      root,
    );
    await controller.start();

    for (let index = 0; index < 40; index += 1) {
      const snapshot = controller.getSnapshot();
      if (snapshot.run.status === "completed") {
        expect(snapshot.latestSupervisorDecision?.action).toBe("complete");
        expect(snapshot.run.workerTurnCount).toBe(2);
        await controller.dispose();
        await service.dispose();
        return;
      }
      await Bun.sleep(25);
    }

    await controller.dispose();
    await service.dispose();
    throw new Error("runtime did not complete in time");
  });

  test("suggest discovery mode surfaces changes without auto-reloading skill catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-runtime-"));
    dirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = join(
      root,
      ".codex-skills-rollcode",
    );
    mkdirSync(join(root, ".skills", "base-skill"), { recursive: true });
    writeFileSync(
      join(root, ".skills", "base-skill", "SKILL.md"),
      `---
name: base-skill
description: base skill
---

# base-skill
`,
      "utf8",
    );
    writeFileSync(
      join(root, ".skills", "preferences.json"),
      JSON.stringify(
        {
          skill_discovery: "suggest",
        },
        null,
        2,
      ),
      "utf8",
    );

    const codex = new FakeCodexSuggestSkillChange(root);
    const store = new StateStore(join(root, "state.json"));
    const service = new RollcodeService(
      store,
      codex as unknown as CodexAppServerClient,
    );

    const controller = await service.startInteractiveRun(
      "Handle runtime skill changes safely.",
      root,
    );
    await controller.start();
    const baselineEnabledCount = codex.enabledSkills.length;

    try {
      for (let index = 0; index < 120; index += 1) {
        const snapshot = controller.getSnapshot();
        if (snapshot.run.status === "completed") {
          expect(codex.enabledSkills.length).toBe(baselineEnabledCount);
          expect(
            snapshot.logs.some((line) =>
              line.includes("Skill catalog changed; suggestion mode active"),
            ),
          ).toBeTrue();
          expect(
            snapshot.logs.some((line) =>
              line.includes("Skill catalog reloaded (auto"),
            ),
          ).toBeFalse();
          return;
        }
        await Bun.sleep(25);
      }
      throw new Error("runtime did not complete in suggest mode test");
    } finally {
      await controller.dispose();
      await service.dispose();
    }
  });

  test("retries transient supervisor 502 once and completes the same run", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-runtime-"));
    dirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = join(
      root,
      ".codex-skills-rollcode",
    );
    const store = new StateStore(join(root, "state.json"));
    const service = new RollcodeService(
      store,
      new FakeCodexTransientSupervisor() as unknown as CodexAppServerClient,
    );

    const controller = await service.startInteractiveRun(
      "Finish task once.",
      root,
    );
    await controller.start();

    for (let index = 0; index < 220; index += 1) {
      const snapshot = controller.getSnapshot();
      if (snapshot.run.status === "completed") {
        expect(snapshot.latestSupervisorDecision?.action).toBe("complete");
        expect(snapshot.run.workerTurnCount).toBe(1);
        expect(
          snapshot.logs.some((line) =>
            line.includes("Transient upstream error during supervisor turn"),
          ),
        ).toBeTrue();
        await controller.dispose();
        await service.dispose();
        return;
      }
      await Bun.sleep(25);
    }

    await controller.dispose();
    await service.dispose();
    throw new Error(
      "runtime did not complete after transient supervisor retry",
    );
  });

  test("falls back to legacy supervisor schema when strict schema is incompatible", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-runtime-"));
    dirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = join(
      root,
      ".codex-skills-rollcode",
    );
    const store = new StateStore(join(root, "state.json"));
    const service = new RollcodeService(
      store,
      new FakeCodexSupervisorSchemaFallback() as unknown as CodexAppServerClient,
    );

    const controller = await service.startInteractiveRun(
      "Complete task with supervisor schema fallback.",
      root,
    );
    await controller.start();

    for (let index = 0; index < 140; index += 1) {
      const snapshot = controller.getSnapshot();
      if (snapshot.run.status === "completed") {
        expect(snapshot.latestSupervisorDecision?.action).toBe("complete");
        expect(snapshot.latestSupervisorDecision?.nextInstruction).toBe("");
        expect(
          snapshot.logs.some((line) =>
            line.includes("retrying once with legacy-compatible schema"),
          ),
        ).toBeTrue();
        await controller.dispose();
        await service.dispose();
        return;
      }
      await Bun.sleep(25);
    }

    await controller.dispose();
    await service.dispose();
    throw new Error("runtime did not complete after supervisor schema fallback");
  });

  test("continues the same blocked run after operator message", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-runtime-"));
    dirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = join(
      root,
      ".codex-skills-rollcode",
    );
    const store = new StateStore(join(root, "state.json"));
    const service = new RollcodeService(
      store,
      new FakeCodexBlockedThenContinue() as unknown as CodexAppServerClient,
    );

    const controller = await service.startInteractiveRun(
      "Recover the failed run.",
      root,
    );
    await controller.start();

    let blockedSnapshot = controller.getSnapshot();
    for (let index = 0; index < 80; index += 1) {
      blockedSnapshot = controller.getSnapshot();
      if (blockedSnapshot.run.status === "blocked") {
        break;
      }
      await Bun.sleep(25);
    }
    expect(blockedSnapshot.run.status).toBe("blocked");

    const runId = blockedSnapshot.run.id;
    await controller.handleCommand("继续完成任务");

    for (let index = 0; index < 80; index += 1) {
      const snapshot = controller.getSnapshot();
      if (snapshot.run.status === "completed") {
        expect(snapshot.run.id).toBe(runId);
        expect(snapshot.latestSupervisorDecision?.action).toBe("complete");
        expect(snapshot.run.workerTurnCount).toBe(1);
        await controller.dispose();
        await service.dispose();
        return;
      }
      await Bun.sleep(25);
    }

    await controller.dispose();
    await service.dispose();
    throw new Error("blocked run did not continue after operator message");
  });

  test("hydrates structured command executions from worker artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-runtime-"));
    dirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = join(
      root,
      ".codex-skills-rollcode",
    );
    const store = new StateStore(join(root, "state.json"));
    const service = new RollcodeService(
      store,
      new FakeCodexCommandArtifacts() as unknown as CodexAppServerClient,
    );

    const controller = await service.startInteractiveRun(
      "Run verification and complete.",
      root,
    );
    await controller.start();

    for (let index = 0; index < 80; index += 1) {
      const snapshot = controller.getSnapshot();
      if (snapshot.run.status === "completed") {
        expect(snapshot.commandExecutions.length).toBe(1);
        expect(snapshot.commandExecutions[0]?.command).toBe("bun test");
        expect(snapshot.commandExecutions[0]?.output).toContain("1 pass");
        expect(snapshot.commandExecutions[0]?.success).toBeTrue();
        expect(snapshot.commandExecutions[0]?.exitCode).toBe(0);
        await controller.dispose();
        await service.dispose();
        return;
      }
      await Bun.sleep(25);
    }

    await controller.dispose();
    await service.dispose();
    throw new Error("runtime did not complete in command artifact test");
  });

  test("captures streaming command execution notifications in snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-runtime-"));
    dirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = join(
      root,
      ".codex-skills-rollcode",
    );
    const store = new StateStore(join(root, "state.json"));
    const service = new RollcodeService(
      store,
      new FakeCodexCommandNotifications() as unknown as CodexAppServerClient,
    );

    const controller = await service.startInteractiveRun(
      "Capture streamed command output.",
      root,
    );
    await controller.start();

    for (let index = 0; index < 80; index += 1) {
      const snapshot = controller.getSnapshot();
      if (snapshot.run.status === "completed") {
        expect(snapshot.commandExecutions.length).toBe(1);
        expect(snapshot.commandExecutions[0]?.command).toBe("echo streamed");
        expect(snapshot.commandExecutions[0]?.output).toContain("streamed");
        expect(snapshot.commandExecutions[0]?.phase).toBe("finished");
        expect(snapshot.commandExecutions[0]?.success).toBeTrue();
        await controller.dispose();
        await service.dispose();
        return;
      }
      await Bun.sleep(25);
    }

    await controller.dispose();
    await service.dispose();
    throw new Error("runtime did not complete in command notification test");
  });

  test("records request_user_input handling when worker emits server-request notifications", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-runtime-"));
    dirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = join(
      root,
      ".codex-skills-rollcode",
    );
    const store = new StateStore(join(root, "state.json"));
    const service = new RollcodeService(
      store,
      new FakeCodexRequestUserInputNotifications() as unknown as CodexAppServerClient,
    );

    const controller = await service.startInteractiveRun(
      "Complete with a request_user_input checkpoint.",
      root,
    );
    await controller.start();

    for (let index = 0; index < 80; index += 1) {
      const snapshot = controller.getSnapshot();
      if (snapshot.run.status === "completed") {
        expect(
          snapshot.logs.some((line) =>
            line.includes("request_user_input handled automatically"),
          ),
        ).toBeTrue();
        await controller.dispose();
        await service.dispose();
        return;
      }
      await Bun.sleep(25);
    }

    await controller.dispose();
    await service.dispose();
    throw new Error("runtime did not complete in request_user_input log test");
  });

  test("merges parallel helper evidence and command artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-runtime-"));
    dirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = join(
      root,
      ".codex-skills-rollcode",
    );
    const store = new StateStore(join(root, "state.json"));
    const service = new RollcodeService(
      store,
      new FakeCodexParallelAggregation() as unknown as CodexAppServerClient,
    );

    const controller = await service.startInteractiveRun(
      "Run primary + helper lanes and merge results.",
      root,
    );
    await controller.start();

    for (let index = 0; index < 80; index += 1) {
      const snapshot = controller.getSnapshot();
      if (snapshot.run.status === "completed") {
        expect(snapshot.run.workerTurnCount).toBe(1);
        expect(snapshot.latestWorkerOutput?.handoff.evidence).toContain(
          "[lane-2] helper validation complete",
        );
        expect(snapshot.commandExecutions.length).toBeGreaterThanOrEqual(1);
        expect(
          snapshot.commandExecutions.some((entry) =>
            entry.command.includes("[lane-2] bun test helper"),
          ),
        ).toBeTrue();
        await controller.dispose();
        await service.dispose();
        return;
      }
      await Bun.sleep(25);
    }

    await controller.dispose();
    await service.dispose();
    throw new Error("runtime did not complete in parallel lane merge test");
  });

  test("routes helper lanes through process executor when enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-runtime-"));
    dirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = join(
      root,
      ".codex-skills-rollcode",
    );
    const store = new StateStore(join(root, "state.json"));
    const service = new RollcodeService(
      store,
      new FakeCodexParallelAggregation() as unknown as CodexAppServerClient,
    );

    const controller = await service.startInteractiveRun(
      "Run primary + helper lanes in process mode.",
      root,
    );
    (
      controller as unknown as {
        parallelHelperExecutor: "thread" | "process";
      }
    ).parallelHelperExecutor = "process";

    const bunApi = Bun as unknown as { spawn: typeof Bun.spawn };
    const originalSpawn = bunApi.spawn;
    const spawnCalls: string[][] = [];
    bunApi.spawn = ((cmd: unknown): ReturnType<typeof Bun.spawn> => {
      const argv = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [];
      spawnCalls.push(argv);
      const requestFlagIndex = argv.indexOf("--request-path");
      const responseFlagIndex = argv.indexOf("--response-path");
      if (requestFlagIndex >= 0 && responseFlagIndex >= 0) {
        const requestPath = argv[requestFlagIndex + 1];
        const responsePath = argv[responseFlagIndex + 1];
        if (requestPath && responsePath) {
          const request = JSON.parse(readFileSync(requestPath, "utf8")) as {
            threadId: string;
          };
          const artifacts = {
            turnId: `${request.threadId}-turn`,
            finalMessage: JSON.stringify({
              userMessage: "Helper subprocess lane finished.",
              handoff: {
                summary: "Helper verified edge cases through process lane.",
                evidence: ["helper subprocess validation complete"],
                unresolved: [],
                completionClaim: true,
              },
            }),
            parsed: {
              userMessage: "Helper subprocess lane finished.",
              handoff: {
                summary: "Helper verified edge cases through process lane.",
                evidence: ["helper subprocess validation complete"],
                unresolved: [],
                completionClaim: true,
              },
            },
            plan: [{ step: "Process helper validation", status: "completed" }],
            diff: "",
            commandOutput: "$ bun test helper\npass\n(exit 0)\n",
            commandExecutions: [
              {
                id: "helper-process-cmd",
                command: "bun test helper",
                output: "pass\n",
                phase: "finished",
                success: true,
                exitCode: 0,
              },
            ],
            items: [],
          };
          writeFileSync(
            responsePath,
            `${JSON.stringify({ ok: true, artifacts }, null, 2)}\n`,
          );
        }
      }
      const createEmptyStream = () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      return {
        stdout: createEmptyStream(),
        stderr: createEmptyStream(),
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    try {
      await controller.start();

      for (let index = 0; index < 80; index += 1) {
        const snapshot = controller.getSnapshot();
        if (snapshot.run.status === "completed") {
          expect(
            spawnCalls.some((call) => call.includes("internal-helper-lane")),
          ).toBeTrue();
          expect(snapshot.latestWorkerOutput?.handoff.evidence).toContain(
            "[lane-2] helper subprocess validation complete",
          );
          expect(
            snapshot.commandExecutions.some((entry) =>
              entry.command.includes("[lane-2] bun test helper"),
            ),
          ).toBeTrue();
          return;
        }
        await Bun.sleep(25);
      }

      throw new Error("runtime did not complete in process helper lane test");
    } finally {
      bunApi.spawn = originalSpawn;
      await controller.dispose().catch(() => undefined);
      await service.dispose().catch(() => undefined);
    }
  });

  test("opens and closes helper circuit around repeated helper lane failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-runtime-"));
    dirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = join(
      root,
      ".codex-skills-rollcode",
    );
    const store = new StateStore(join(root, "state.json"));
    const service = new RollcodeService(
      store,
      new FakeCodexParallelCircuitRecovery() as unknown as CodexAppServerClient,
    );

    const controller = await service.startInteractiveRun(
      "Drive parallel implementation lanes with verification and finish safely.",
      root,
    );
    await controller.start();

    for (let index = 0; index < 180; index += 1) {
      const snapshot = controller.getSnapshot();
      if (snapshot.run.status === "completed") {
        expect(snapshot.run.workerTurnCount).toBe(4);
        expect(
          snapshot.logs.some((line) =>
            line.includes(
              "Parallel helper circuit opened after repeated helper failures",
            ),
          ),
        ).toBeTrue();
        expect(
          snapshot.logs.some((line) =>
            line.includes(
              "Parallel helper circuit closed and helpers re-enabled.",
            ),
          ),
        ).toBeTrue();
        expect(
          snapshot.logs.some((line) =>
            line.includes("helper circuit open (cooldown"),
          ),
        ).toBeTrue();
        await controller.dispose();
        await service.dispose();
        return;
      }
      await Bun.sleep(25);
    }

    await controller.dispose();
    await service.dispose();
    throw new Error("runtime did not complete in parallel helper circuit test");
  });

  test("records plan-missing event when worker lanes emit no plan state", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-runtime-"));
    dirs.push(root);
    process.env.ROLLCODE_HOME = join(root, ".rollcode-home");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = join(
      root,
      ".codex-skills-rollcode",
    );
    const store = new StateStore(join(root, "state.json"));
    const service = new RollcodeService(
      store,
      new FakeCodexPlanMissing() as unknown as CodexAppServerClient,
    );

    const controller = await service.startInteractiveRun(
      "Complete task without plan output.",
      root,
    );
    await controller.start();

    for (let index = 0; index < 80; index += 1) {
      const snapshot = controller.getSnapshot();
      if (snapshot.run.status === "completed") {
        expect(
          snapshot.logs.some((line) =>
            line.includes(
              "Worker reported no plan updates for this turn; supervisor should verify plan completeness.",
            ),
          ),
        ).toBeTrue();
        await controller.dispose();
        await service.dispose();
        return;
      }
      await Bun.sleep(25);
    }

    await controller.dispose();
    await service.dispose();
    throw new Error("runtime did not complete in plan-missing test");
  });
});
