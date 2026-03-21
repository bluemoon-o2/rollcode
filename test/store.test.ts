import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store";

describe("state store", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stores runs, events and supervisor decisions", () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-store-"));
    roots.push(root);
    const store = new StateStore(join(root, "state.json"));

    const agent = store.upsertAgent({
      id: "agent-test",
      name: "test",
      cwd: root,
      workerThreadId: "worker-1",
      supervisorThreadId: "supervisor-1",
    });
    const run = store.insertRun({
      id: "run-1",
      agentId: agent.id,
      goal: "ship it",
      status: "working",
      detached: false,
      ownerPid: 123,
      pendingInstruction: "start",
      workerTurnCount: 0,
      latestWorkerTurnId: null,
      latestSupervisorTurnId: null,
      memoryReminderDue: false,
      lastError: null,
    });

    store.addTurnOutput(run.id, "worker", "turn-worker", {
      userMessage: "working",
      handoff: {
        summary: "not done",
        evidence: ["read repo"],
        unresolved: ["needs changes"],
        completionClaim: false,
      },
    });
    store.addSupervisorDecision(run.id, "turn-supervisor", {
      action: "repair",
      rationale: "needs more evidence",
      nextInstruction: "write the tests",
      memoryAction: "review",
    });
    store.addEvent({
      runId: run.id,
      threadRole: "system",
      eventType: "info",
      payload: { message: "hello" },
      createdAt: new Date().toISOString(),
    });

    expect(store.getLatestWorkerOutput(run.id)?.handoff.summary).toBe(
      "not done",
    );
    expect(store.getLatestSupervisorDecision(run.id)?.action).toBe("repair");
    expect(store.listEvents(run.id)).toHaveLength(1);
    expect(store.getLatestRun(agent.id)?.id).toBe(run.id);

    store.close();
  });

  test("lists run history in descending update order", () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-store-history-"));
    roots.push(root);
    const store = new StateStore(join(root, "state.json"));

    const agent = store.upsertAgent({
      id: "agent-history",
      name: "history",
      cwd: root,
      workerThreadId: "worker-h",
      supervisorThreadId: "supervisor-h",
    });

    const run1 = store.insertRun({
      id: "run-history-1",
      agentId: agent.id,
      goal: "first",
      status: "working",
      detached: false,
      ownerPid: null,
      pendingInstruction: null,
      workerTurnCount: 0,
      latestWorkerTurnId: null,
      latestSupervisorTurnId: null,
      memoryReminderDue: false,
      lastError: null,
    });
    const run2 = store.insertRun({
      id: "run-history-2",
      agentId: agent.id,
      goal: "second",
      status: "blocked",
      detached: false,
      ownerPid: null,
      pendingInstruction: null,
      workerTurnCount: 1,
      latestWorkerTurnId: null,
      latestSupervisorTurnId: null,
      memoryReminderDue: false,
      lastError: "error",
    });

    store.updateRun(run1.id, { status: "completed" });
    const runs = store.listRuns(agent.id, 10);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.id).toBe(run1.id);
    expect(runs[1]?.id).toBe(run2.id);

    store.close();
  });

  test("stores app settings values", () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-store-settings-"));
    roots.push(root);
    const store = new StateStore(join(root, "state.json"));

    expect(store.getSetting("lastSeenReleaseNotesVersion")).toBeNull();
    store.setSetting("lastSeenReleaseNotesVersion", "2.0.0");
    expect(store.getSetting("lastSeenReleaseNotesVersion")).toBe("2.0.0");

    store.setSetting("lastSeenReleaseNotesVersion", "2.0.1");
    expect(store.getSetting("lastSeenReleaseNotesVersion")).toBe("2.0.1");
    store.close();
  });

  test("flushes debounced writes on close", () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-store-close-"));
    roots.push(root);
    const previous = process.env.ROLLCODE_STATE_PERSIST_DEBOUNCE_MS;
    process.env.ROLLCODE_STATE_PERSIST_DEBOUNCE_MS = "5000";

    try {
      const statePath = join(root, "state.json");
      const store = new StateStore(statePath);
      store.setSetting("closeFlush", "yes");
      store.close();

      const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
        appSettings?: Record<string, { value: string }>;
      };
      expect(persisted.appSettings?.closeFlush?.value).toBe("yes");
    } finally {
      if (previous === undefined) {
        delete process.env.ROLLCODE_STATE_PERSIST_DEBOUNCE_MS;
      } else {
        process.env.ROLLCODE_STATE_PERSIST_DEBOUNCE_MS = previous;
      }
    }
  });

  test("recovers from corrupted state file and keeps a quarantine copy", () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-store-corrupt-"));
    roots.push(root);
    const statePath = join(root, "state.json");
    writeFileSync(statePath, "{bad json", "utf8");

    const store = new StateStore(statePath);
    store.setSetting("recovered", "yes");
    store.close();

    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      version?: number;
      appSettings?: Record<string, { value: string }>;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.appSettings?.recovered?.value).toBe("yes");

    const backups = readdirSync(root).filter((name) =>
      name.startsWith("state.json.corrupt-"),
    );
    expect(backups).toHaveLength(1);
    const backupContent = readFileSync(join(root, backups[0]), "utf8");
    expect(backupContent).toBe("{bad json");
  });

  test("merges concurrent state writers instead of clobbering keys", () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-store-concurrent-"));
    roots.push(root);
    const statePath = join(root, "state.json");
    const previous = process.env.ROLLCODE_STATE_PERSIST_DEBOUNCE_MS;
    process.env.ROLLCODE_STATE_PERSIST_DEBOUNCE_MS = "0";

    try {
      const storeA = new StateStore(statePath);
      const storeB = new StateStore(statePath);

      storeA.setSetting("fromA", "1");
      storeB.setSetting("fromB", "1");

      storeA.close();
      storeB.close();

      const reopened = new StateStore(statePath);
      expect(reopened.getSetting("fromA")).toBe("1");
      expect(reopened.getSetting("fromB")).toBe("1");
      reopened.close();
    } finally {
      if (previous === undefined) {
        delete process.env.ROLLCODE_STATE_PERSIST_DEBOUNCE_MS;
      } else {
        process.env.ROLLCODE_STATE_PERSIST_DEBOUNCE_MS = previous;
      }
    }
  });

  test("keeps only recent events in state when retention limit is configured", () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-store-retention-"));
    roots.push(root);
    const previous = process.env.ROLLCODE_MAX_EVENTS_IN_STATE;
    process.env.ROLLCODE_MAX_EVENTS_IN_STATE = "3";

    try {
      const store = new StateStore(join(root, "state.json"));
      const agent = store.upsertAgent({
        id: "agent-retention",
        name: "retention",
        cwd: root,
        workerThreadId: null,
        supervisorThreadId: null,
      });
      const run = store.insertRun({
        id: "run-retention",
        agentId: agent.id,
        goal: "retention",
        status: "working",
        detached: false,
        ownerPid: null,
        pendingInstruction: null,
        workerTurnCount: 0,
        latestWorkerTurnId: null,
        latestSupervisorTurnId: null,
        memoryReminderDue: false,
        lastError: null,
      });

      for (let index = 0; index < 5; index += 1) {
        store.addEvent({
          runId: run.id,
          threadRole: "system",
          eventType: "retain",
          payload: `e${index}`,
          createdAt: new Date(1_700_000_000_000 + index).toISOString(),
        });
      }
      store.close();

      const reopened = new StateStore(join(root, "state.json"));
      const events = reopened.listEvents(run.id, 20);
      reopened.close();

      expect(events).toHaveLength(3);
      expect(events.map((event) => event.payload)).toEqual(["e2", "e3", "e4"]);
    } finally {
      if (previous === undefined) {
        delete process.env.ROLLCODE_MAX_EVENTS_IN_STATE;
      } else {
        process.env.ROLLCODE_MAX_EVENTS_IN_STATE = previous;
      }
    }
  });
});
