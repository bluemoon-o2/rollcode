import { describe, expect, test } from "bun:test";
import type { RunRecord } from "../src/domain/types";
import type { ResumePickerOption } from "../src/tui/ResumePicker";
import { filterAndSortResumeOptions } from "../src/tui/resumePickerSearch";

function makeRun(
  id: string,
  goal: string,
  updatedAt: string,
  status: RunRecord["status"] = "working",
): RunRecord {
  return {
    id,
    agentId: "agent-demo",
    goal,
    status,
    detached: false,
    ownerPid: null,
    pendingInstruction: null,
    workerTurnCount: 0,
    latestWorkerTurnId: null,
    latestSupervisorTurnId: null,
    memoryReminderDue: false,
    lastError: null,
    createdAt: updatedAt,
    updatedAt,
    completedAt: null,
  };
}

function makeOption(
  id: string,
  goal: string,
  updatedAt: string,
  agentName = "demo-agent",
): ResumePickerOption {
  return {
    run: makeRun(id, goal, updatedAt),
    agentName,
  };
}

describe("resume picker search", () => {
  test("recent mode keeps updatedAt descending order when query is empty", () => {
    const options: ResumePickerOption[] = [
      makeOption("run-1", "older task", "2026-03-20T10:00:00.000Z"),
      makeOption("run-2", "newer task", "2026-03-21T10:00:00.000Z"),
    ];
    const result = filterAndSortResumeOptions(options, "", "recent");
    expect(result.map((item) => item.run.id)).toEqual(["run-2", "run-1"]);
  });

  test("supports exact phrase query with quotes", () => {
    const options: ResumePickerOption[] = [
      makeOption("run-1", "implement rollback strategy", "2026-03-22T01:00:00.000Z"),
      makeOption("run-2", "implement fast strategy", "2026-03-22T02:00:00.000Z"),
    ];
    const result = filterAndSortResumeOptions(
      options,
      "\"rollback strategy\"",
      "relevance",
    );
    expect(result.map((item) => item.run.id)).toEqual(["run-1"]);
  });

  test("supports regex mode via re: prefix", () => {
    const options: ResumePickerOption[] = [
      makeOption("run-alpha", "sync docs", "2026-03-22T01:00:00.000Z"),
      makeOption("run-beta", "fix runtime loop", "2026-03-22T02:00:00.000Z"),
    ];
    const result = filterAndSortResumeOptions(options, "re:run-b", "recent");
    expect(result.map((item) => item.run.id)).toEqual(["run-beta"]);
  });
});
