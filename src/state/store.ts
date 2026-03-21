import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getStatePath } from "../config";
import type {
  AgentRecord,
  EventRecord,
  RunTurnHistoryEntry,
  RunRecord,
  SupervisorDecision,
  ThreadRole,
  WorkerTurnOutput,
} from "../domain/types";
import { nowIso } from "../utils/time";

const DEFAULT_STATE_PERSIST_DEBOUNCE_MS = 80;
const DEFAULT_MAX_EVENTS_IN_STATE = 5000;
const DEFAULT_MAX_TURN_OUTPUTS_IN_STATE = 2000;
const DEFAULT_MAX_SUPERVISOR_DECISIONS_IN_STATE = 2000;
const DEFAULT_MAX_MEMORY_CHECKPOINTS_IN_STATE = 2000;
const DEFAULT_STATE_FILE_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STATE_FILE_LOCK_STALE_MS = 30_000;
const STATE_FILE_LOCK_RETRY_MS = 25;

const lockSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function isErrnoCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return (error as { code?: string }).code === code;
}

function fsyncDirBestEffort(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Best effort only; directory fsync support varies by platform/filesystem.
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function writeStateAtomic(path: string, state: PersistedState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  let tempFd: number | null = null;
  try {
    tempFd = openSync(tempPath, "w", 0o600);
    writeFileSync(tempFd, payload, "utf8");
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = null;
    renameSync(tempPath, path);
    fsyncDirBestEffort(dirname(path));
  } finally {
    if (tempFd !== null) {
      closeSync(tempFd);
    }
    rmSync(tempPath, { force: true });
  }
}

function quarantineCorruptedState(path: string, content: string): void {
  const backupPath = `${path}.corrupt-${Date.now()}-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, backupPath);
    return;
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) {
      // Fall back to a best-effort content copy below.
    }
  }
  try {
    writeFileSync(backupPath, content, "utf8");
  } catch {
    // Best effort only.
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(lockSleepBuffer, 0, 0, ms);
}

function parseIsoMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readStateLockPayload(
  lockPath: string,
): { pid?: number; createdAt?: string } | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
    const payload: { pid?: number; createdAt?: string } = {};
    if (typeof parsed.pid === "number") {
      payload.pid = parsed.pid;
    }
    if (typeof parsed.createdAt === "string") {
      payload.createdAt = parsed.createdAt;
    }
    return payload;
  } catch {
    return null;
  }
}

function isStateLockStale(lockPath: string, staleMs: number): boolean {
  const payload = readStateLockPayload(lockPath);
  if (typeof payload?.pid === "number" && !isPidAlive(payload.pid)) {
    return true;
  }
  if (typeof payload?.createdAt === "string") {
    if (Date.now() - parseIsoMs(payload.createdAt) > staleMs) {
      return true;
    }
  }
  try {
    const stats = statSync(lockPath);
    return Date.now() - stats.mtimeMs > staleMs;
  } catch {
    return true;
  }
}

function withStateFileLock<T>(
  path: string,
  fn: () => T,
  options: {
    timeoutMs: number;
    staleMs: number;
  } = {
    timeoutMs: DEFAULT_STATE_FILE_LOCK_TIMEOUT_MS,
    staleMs: DEFAULT_STATE_FILE_LOCK_STALE_MS,
  },
): T {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + Math.max(1, options.timeoutMs);
  while (true) {
    let lockFd: number | null = null;
    try {
      lockFd = openSync(lockPath, "wx", 0o600);
      const payload = JSON.stringify(
        {
          pid: process.pid,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      );
      writeFileSync(lockFd, payload, "utf8");
      closeSync(lockFd);
      lockFd = null;
      try {
        return fn();
      } finally {
        rmSync(lockPath, { force: true });
      }
    } catch (error) {
      if (lockFd !== null) {
        closeSync(lockFd);
      }
      if (!isErrnoCode(error, "EEXIST")) {
        throw error;
      }

      if (isStateLockStale(lockPath, options.staleMs)) {
        rmSync(lockPath, { force: true });
        continue;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`Timed out waiting for state lock: ${path}`);
      }
      sleepSync(Math.min(STATE_FILE_LOCK_RETRY_MS, remainingMs));
    }
  }
}

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

interface PersistLimits {
  events: number;
  turnOutputs: number;
  supervisorDecisions: number;
  memoryCheckpoints: number;
}

interface PersistedSettingValue {
  value: string;
  updatedAt: string;
}

interface PersistedCounters {
  events: number;
  turnOutputs: number;
  supervisorDecisions: number;
  memoryCheckpoints: number;
}

interface PersistedEventRecord extends EventRecord {
  id: number;
}

interface PersistedTurnOutputRecord {
  id: number;
  runId: string;
  threadRole: ThreadRole;
  turnId: string;
  payload: WorkerTurnOutput | SupervisorDecision;
  createdAt: string;
}

interface PersistedSupervisorDecisionRecord {
  id: number;
  runId: string;
  turnId: string;
  decision: SupervisorDecision;
  createdAt: string;
}

interface PersistedMemoryCheckpointRecord {
  id: number;
  agentId: string;
  runId: string;
  summary: string;
  createdAt: string;
}

interface PersistedState {
  version: 1;
  agents: AgentRecord[];
  runs: RunRecord[];
  events: PersistedEventRecord[];
  turnOutputs: PersistedTurnOutputRecord[];
  supervisorDecisions: PersistedSupervisorDecisionRecord[];
  memoryCheckpoints: PersistedMemoryCheckpointRecord[];
  appSettings: Record<string, PersistedSettingValue>;
  counters: PersistedCounters;
}

function createEmptyState(): PersistedState {
  return {
    version: 1,
    agents: [],
    runs: [],
    events: [],
    turnOutputs: [],
    supervisorDecisions: [],
    memoryCheckpoints: [],
    appSettings: {},
    counters: {
      events: 0,
      turnOutputs: 0,
      supervisorDecisions: 0,
      memoryCheckpoints: 0,
    },
  };
}

function ensureArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function sortByUpdatedAtDesc<T extends { updatedAt: string }>(
  values: T[],
): T[] {
  return [...values].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function trimTail<T>(values: T[], maxItems: number): T[] {
  if (values.length <= maxItems) {
    return values;
  }
  return values.slice(values.length - maxItems);
}

function trimInPlace<T>(values: T[], maxItems: number): void {
  if (values.length <= maxItems) {
    return;
  }
  values.splice(0, values.length - maxItems);
}

function normalizeState(value: unknown, limits: PersistLimits): PersistedState {
  const base = createEmptyState();
  if (!value || typeof value !== "object") {
    return base;
  }

  const candidate = value as Partial<PersistedState>;
  const rawEvents = ensureArray<Partial<PersistedEventRecord>>(
    candidate.events,
  );
  const eventsAll = rawEvents.map((event, index) => ({
    id: typeof event.id === "number" ? event.id : index + 1,
    runId: String(event.runId ?? ""),
    threadRole: (event.threadRole ?? "system") as EventRecord["threadRole"],
    eventType: String(event.eventType ?? "unknown"),
    payload: event.payload ?? null,
    createdAt: typeof event.createdAt === "string" ? event.createdAt : nowIso(),
  }));
  const events = trimTail(eventsAll, limits.events);

  const rawTurnOutputs = ensureArray<Partial<PersistedTurnOutputRecord>>(
    candidate.turnOutputs,
  );
  const turnOutputsAll = rawTurnOutputs.map((output, index) => ({
    id: typeof output.id === "number" ? output.id : index + 1,
    runId: String(output.runId ?? ""),
    threadRole:
      output.threadRole === "worker" || output.threadRole === "supervisor"
        ? output.threadRole
        : "worker",
    turnId: String(output.turnId ?? ""),
    payload: output.payload as WorkerTurnOutput | SupervisorDecision,
    createdAt:
      typeof output.createdAt === "string" ? output.createdAt : nowIso(),
  }));
  const turnOutputs = trimTail(turnOutputsAll, limits.turnOutputs);

  const rawDecisions = ensureArray<Partial<PersistedSupervisorDecisionRecord>>(
    candidate.supervisorDecisions,
  );
  const supervisorDecisionsAll = rawDecisions.map((decision, index) => ({
    id: typeof decision.id === "number" ? decision.id : index + 1,
    runId: String(decision.runId ?? ""),
    turnId: String(decision.turnId ?? ""),
    decision: (decision.decision ?? null) as SupervisorDecision,
    createdAt:
      typeof decision.createdAt === "string" ? decision.createdAt : nowIso(),
  }));
  const supervisorDecisions = trimTail(
    supervisorDecisionsAll,
    limits.supervisorDecisions,
  );

  const rawCheckpoints = ensureArray<Partial<PersistedMemoryCheckpointRecord>>(
    candidate.memoryCheckpoints,
  );
  const memoryCheckpointsAll = rawCheckpoints.map((checkpoint, index) => ({
    id: typeof checkpoint.id === "number" ? checkpoint.id : index + 1,
    agentId: String(checkpoint.agentId ?? ""),
    runId: String(checkpoint.runId ?? ""),
    summary: String(checkpoint.summary ?? ""),
    createdAt:
      typeof checkpoint.createdAt === "string"
        ? checkpoint.createdAt
        : nowIso(),
  }));
  const memoryCheckpoints = trimTail(
    memoryCheckpointsAll,
    limits.memoryCheckpoints,
  );

  const appSettings =
    candidate.appSettings &&
    typeof candidate.appSettings === "object" &&
    !Array.isArray(candidate.appSettings)
      ? (candidate.appSettings as Record<string, PersistedSettingValue>)
      : {};

  const countersCandidate = candidate.counters;
  const maxEventId = eventsAll.reduce(
    (current, event) => Math.max(current, event.id),
    0,
  );
  const maxTurnOutputId = turnOutputsAll.reduce(
    (current, output) => Math.max(current, output.id),
    0,
  );
  const maxDecisionId = supervisorDecisionsAll.reduce(
    (current, decision) => Math.max(current, decision.id),
    0,
  );
  const maxCheckpointId = memoryCheckpointsAll.reduce(
    (current, checkpoint) => Math.max(current, checkpoint.id),
    0,
  );

  return {
    version: 1,
    agents: ensureArray<AgentRecord>(candidate.agents),
    runs: ensureArray<RunRecord>(candidate.runs),
    events,
    turnOutputs,
    supervisorDecisions,
    memoryCheckpoints,
    appSettings,
    counters: {
      events: Math.max(
        maxEventId,
        typeof countersCandidate?.events === "number"
          ? countersCandidate.events
          : 0,
      ),
      turnOutputs: Math.max(
        maxTurnOutputId,
        typeof countersCandidate?.turnOutputs === "number"
          ? countersCandidate.turnOutputs
          : 0,
      ),
      supervisorDecisions: Math.max(
        maxDecisionId,
        typeof countersCandidate?.supervisorDecisions === "number"
          ? countersCandidate.supervisorDecisions
          : 0,
      ),
      memoryCheckpoints: Math.max(
        maxCheckpointId,
        typeof countersCandidate?.memoryCheckpoints === "number"
          ? countersCandidate.memoryCheckpoints
          : 0,
      ),
    },
  };
}

function compareIsoAsc(left: string, right: string): number {
  const leftMs = parseIsoMs(left);
  const rightMs = parseIsoMs(right);
  if (leftMs !== rightMs) {
    return leftMs - rightMs;
  }
  return left.localeCompare(right);
}

function stablePayloadKey(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return "[unserializable]";
  }
}

function mergeByIdLatest<T extends { id: string; updatedAt: string }>(
  disk: T[],
  local: T[],
): T[] {
  const merged = new Map<string, T>();
  for (const record of [...disk, ...local]) {
    const existing = merged.get(record.id);
    if (!existing || compareIsoAsc(existing.updatedAt, record.updatedAt) <= 0) {
      merged.set(record.id, record);
    }
  }
  return [...merged.values()].sort((left, right) =>
    compareIsoAsc(left.updatedAt, right.updatedAt),
  );
}

function mergeAppSettings(
  disk: Record<string, PersistedSettingValue>,
  local: Record<string, PersistedSettingValue>,
): Record<string, PersistedSettingValue> {
  const next: Record<string, PersistedSettingValue> = {};
  const keys = new Set([...Object.keys(disk), ...Object.keys(local)]);
  for (const key of keys) {
    const diskValue = disk[key];
    const localValue = local[key];
    if (!diskValue) {
      if (localValue) {
        next[key] = localValue;
      }
      continue;
    }
    if (!localValue) {
      next[key] = diskValue;
      continue;
    }
    next[key] =
      compareIsoAsc(diskValue.updatedAt, localValue.updatedAt) <= 0
        ? localValue
        : diskValue;
  }
  return next;
}

function mergeEvents(
  disk: PersistedEventRecord[],
  local: PersistedEventRecord[],
  limit: number,
): PersistedEventRecord[] {
  const merged = new Map<string, PersistedEventRecord>();
  for (const event of [...disk, ...local]) {
    const key = [
      event.runId,
      event.threadRole,
      event.eventType,
      event.createdAt,
      stablePayloadKey(event.payload),
    ].join("|");
    const existing = merged.get(key);
    if (!existing || compareIsoAsc(existing.createdAt, event.createdAt) <= 0) {
      merged.set(key, event);
    }
  }

  const trimmed = trimTail(
    [...merged.values()].sort((left, right) => {
      const byTime = compareIsoAsc(left.createdAt, right.createdAt);
      if (byTime !== 0) {
        return byTime;
      }
      return left.id - right.id;
    }),
    limit,
  );
  return trimmed.map((event, index) => ({
    ...event,
    id: index + 1,
  }));
}

function mergeTurnOutputs(
  disk: PersistedTurnOutputRecord[],
  local: PersistedTurnOutputRecord[],
  limit: number,
): PersistedTurnOutputRecord[] {
  const merged = new Map<string, PersistedTurnOutputRecord>();
  for (const output of [...disk, ...local]) {
    const key = [output.runId, output.threadRole, output.turnId].join("|");
    const existing = merged.get(key);
    if (!existing || compareIsoAsc(existing.createdAt, output.createdAt) <= 0) {
      merged.set(key, output);
    }
  }

  const trimmed = trimTail(
    [...merged.values()].sort((left, right) => {
      const byTime = compareIsoAsc(left.createdAt, right.createdAt);
      if (byTime !== 0) {
        return byTime;
      }
      return left.id - right.id;
    }),
    limit,
  );
  return trimmed.map((output, index) => ({
    ...output,
    id: index + 1,
  }));
}

function mergeSupervisorDecisions(
  disk: PersistedSupervisorDecisionRecord[],
  local: PersistedSupervisorDecisionRecord[],
  limit: number,
): PersistedSupervisorDecisionRecord[] {
  const merged = new Map<string, PersistedSupervisorDecisionRecord>();
  for (const decision of [...disk, ...local]) {
    const key = [decision.runId, decision.turnId].join("|");
    const existing = merged.get(key);
    if (
      !existing ||
      compareIsoAsc(existing.createdAt, decision.createdAt) <= 0
    ) {
      merged.set(key, decision);
    }
  }

  const trimmed = trimTail(
    [...merged.values()].sort((left, right) => {
      const byTime = compareIsoAsc(left.createdAt, right.createdAt);
      if (byTime !== 0) {
        return byTime;
      }
      return left.id - right.id;
    }),
    limit,
  );
  return trimmed.map((decision, index) => ({
    ...decision,
    id: index + 1,
  }));
}

function mergeMemoryCheckpoints(
  disk: PersistedMemoryCheckpointRecord[],
  local: PersistedMemoryCheckpointRecord[],
  limit: number,
): PersistedMemoryCheckpointRecord[] {
  const merged = new Map<string, PersistedMemoryCheckpointRecord>();
  for (const checkpoint of [...disk, ...local]) {
    const key = [
      checkpoint.agentId,
      checkpoint.runId,
      checkpoint.createdAt,
      checkpoint.summary,
    ].join("|");
    const existing = merged.get(key);
    if (
      !existing ||
      compareIsoAsc(existing.createdAt, checkpoint.createdAt) <= 0
    ) {
      merged.set(key, checkpoint);
    }
  }

  const trimmed = trimTail(
    [...merged.values()].sort((left, right) => {
      const byTime = compareIsoAsc(left.createdAt, right.createdAt);
      if (byTime !== 0) {
        return byTime;
      }
      return left.id - right.id;
    }),
    limit,
  );
  return trimmed.map((checkpoint, index) => ({
    ...checkpoint,
    id: index + 1,
  }));
}

function mergePersistedStates(
  disk: PersistedState,
  local: PersistedState,
  limits: PersistLimits,
): PersistedState {
  const events = mergeEvents(disk.events, local.events, limits.events);
  const turnOutputs = mergeTurnOutputs(
    disk.turnOutputs,
    local.turnOutputs,
    limits.turnOutputs,
  );
  const supervisorDecisions = mergeSupervisorDecisions(
    disk.supervisorDecisions,
    local.supervisorDecisions,
    limits.supervisorDecisions,
  );
  const memoryCheckpoints = mergeMemoryCheckpoints(
    disk.memoryCheckpoints,
    local.memoryCheckpoints,
    limits.memoryCheckpoints,
  );

  const merged: PersistedState = {
    version: 1,
    agents: mergeByIdLatest(disk.agents, local.agents),
    runs: mergeByIdLatest(disk.runs, local.runs),
    events,
    turnOutputs,
    supervisorDecisions,
    memoryCheckpoints,
    appSettings: mergeAppSettings(disk.appSettings, local.appSettings),
    counters: {
      events: Math.max(
        disk.counters.events,
        local.counters.events,
        events.length,
      ),
      turnOutputs: Math.max(
        disk.counters.turnOutputs,
        local.counters.turnOutputs,
        turnOutputs.length,
      ),
      supervisorDecisions: Math.max(
        disk.counters.supervisorDecisions,
        local.counters.supervisorDecisions,
        supervisorDecisions.length,
      ),
      memoryCheckpoints: Math.max(
        disk.counters.memoryCheckpoints,
        local.counters.memoryCheckpoints,
        memoryCheckpoints.length,
      ),
    },
  };

  return normalizeState(merged, limits);
}

function readStateFromDisk(
  path: string,
  limits: PersistLimits,
): PersistedState {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return createEmptyState();
    }
    throw new Error(
      `Failed to load RollCode state file at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    quarantineCorruptedState(path, content);
    return createEmptyState();
  }

  return normalizeState(parsed, limits);
}

export class StateStore {
  private readonly path: string;
  private readonly limits: PersistLimits;
  private state: PersistedState;
  private readonly persistDebounceMs: number;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(path: string = getStatePath()) {
    this.path = path;
    this.limits = {
      events: readPositiveIntEnv(
        "ROLLCODE_MAX_EVENTS_IN_STATE",
        DEFAULT_MAX_EVENTS_IN_STATE,
      ),
      turnOutputs: readPositiveIntEnv(
        "ROLLCODE_MAX_TURN_OUTPUTS_IN_STATE",
        DEFAULT_MAX_TURN_OUTPUTS_IN_STATE,
      ),
      supervisorDecisions: readPositiveIntEnv(
        "ROLLCODE_MAX_SUPERVISOR_DECISIONS_IN_STATE",
        DEFAULT_MAX_SUPERVISOR_DECISIONS_IN_STATE,
      ),
      memoryCheckpoints: readPositiveIntEnv(
        "ROLLCODE_MAX_MEMORY_CHECKPOINTS_IN_STATE",
        DEFAULT_MAX_MEMORY_CHECKPOINTS_IN_STATE,
      ),
    };
    const debounceCandidate = Number.parseInt(
      process.env.ROLLCODE_STATE_PERSIST_DEBOUNCE_MS ??
        String(DEFAULT_STATE_PERSIST_DEBOUNCE_MS),
      10,
    );
    this.persistDebounceMs =
      Number.isInteger(debounceCandidate) && debounceCandidate >= 0
        ? debounceCandidate
        : DEFAULT_STATE_PERSIST_DEBOUNCE_MS;
    mkdirSync(dirname(path), { recursive: true });
    this.state = this.loadFromDisk();
    this.dirty = true;
    this.persistNow();
  }

  close(): void {
    this.flush();
  }

  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistNow();
  }

  upsertAgent(record: {
    id: string;
    name: string;
    cwd: string;
    workerThreadId: string | null;
    supervisorThreadId: string | null;
  }): AgentRecord {
    const now = this.nextTimestamp(
      this.state.agents.map((agent) => agent.updatedAt),
    );
    const existing = this.state.agents.find((agent) => agent.id === record.id);
    const next: AgentRecord = {
      id: record.id,
      name: record.name,
      cwd: record.cwd,
      workerThreadId: record.workerThreadId,
      supervisorThreadId: record.supervisorThreadId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.state.agents = [
      ...this.state.agents.filter((agent) => agent.id !== record.id),
      next,
    ];
    this.persist();
    return next;
  }

  getAgentById(id: string): AgentRecord | null {
    return this.state.agents.find((agent) => agent.id === id) ?? null;
  }

  getAgentByCwd(cwd: string): AgentRecord | null {
    return (
      sortByUpdatedAtDesc(
        this.state.agents.filter((agent) => agent.cwd === cwd),
      )[0] ?? null
    );
  }

  listAgents(): AgentRecord[] {
    return sortByUpdatedAtDesc(this.state.agents);
  }

  insertRun(
    record: Omit<RunRecord, "createdAt" | "updatedAt" | "completedAt">,
  ): RunRecord {
    const now = this.nextTimestamp(this.state.runs.map((run) => run.updatedAt));
    const next: RunRecord = {
      ...record,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.state.runs = [...this.state.runs, next];
    this.persist();
    return next;
  }

  getRunById(id: string): RunRecord | null {
    return this.state.runs.find((run) => run.id === id) ?? null;
  }

  getLatestRun(agentId?: string): RunRecord | null {
    const candidates = agentId
      ? this.state.runs.filter((run) => run.agentId === agentId)
      : this.state.runs;
    return sortByUpdatedAtDesc(candidates)[0] ?? null;
  }

  listRuns(agentId?: string, limit = 30): RunRecord[] {
    const candidates = agentId
      ? this.state.runs.filter((run) => run.agentId === agentId)
      : this.state.runs;
    return sortByUpdatedAtDesc(candidates).slice(0, limit);
  }

  getSetting(key: string): string | null {
    return this.state.appSettings[key]?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.state.appSettings[key] = {
      value,
      updatedAt: nowIso(),
    };
    this.persist();
  }

  updateRun(id: string, patch: Partial<RunRecord>): RunRecord {
    const current = this.getRunById(id);
    if (!current) {
      throw new Error(`Run ${id} not found`);
    }
    const next: RunRecord = {
      ...current,
      ...patch,
      updatedAt: this.nextTimestamp(
        this.state.runs.map((run) => run.updatedAt),
      ),
    };
    this.state.runs = [...this.state.runs.filter((run) => run.id !== id), next];
    this.persist();
    return next;
  }

  addEvent(event: EventRecord): void {
    this.state.counters.events += 1;
    this.state.events.push({
      ...event,
      id: this.state.counters.events,
    });
    trimInPlace(this.state.events, this.limits.events);
    this.persist();
  }

  listEvents(runId: string, limit = 200): EventRecord[] {
    if (limit <= 0) {
      return [];
    }
    const result: EventRecord[] = [];
    for (let index = this.state.events.length - 1; index >= 0; index -= 1) {
      if (result.length >= limit) {
        break;
      }
      const event = this.state.events[index];
      if (!event || event.runId !== runId) {
        continue;
      }
      const { id: _id, ...record } = event;
      result.push(record);
    }
    return result.reverse();
  }

  addTurnOutput(
    runId: string,
    threadRole: ThreadRole,
    turnId: string,
    payload: WorkerTurnOutput | SupervisorDecision,
  ): void {
    this.state.counters.turnOutputs += 1;
    this.state.turnOutputs.push({
      id: this.state.counters.turnOutputs,
      runId,
      threadRole,
      turnId,
      payload,
      createdAt: nowIso(),
    });
    trimInPlace(this.state.turnOutputs, this.limits.turnOutputs);
    this.persist();
  }

  listTurnOutputs(runId: string, limit = 80): RunTurnHistoryEntry[] {
    if (limit <= 0) {
      return [];
    }
    const result: RunTurnHistoryEntry[] = [];
    for (
      let index = this.state.turnOutputs.length - 1;
      index >= 0;
      index -= 1
    ) {
      if (result.length >= limit) {
        break;
      }
      const output = this.state.turnOutputs[index];
      if (!output || output.runId !== runId) {
        continue;
      }
      result.push({
        threadRole: output.threadRole,
        turnId: output.turnId,
        payload: output.payload,
        createdAt: output.createdAt,
      });
    }
    return result.reverse();
  }

  getLatestWorkerOutput(runId: string): WorkerTurnOutput | null {
    for (
      let index = this.state.turnOutputs.length - 1;
      index >= 0;
      index -= 1
    ) {
      const output = this.state.turnOutputs[index];
      if (!output) {
        continue;
      }
      if (output.runId === runId && output.threadRole === "worker") {
        return (output.payload as WorkerTurnOutput | undefined) ?? null;
      }
    }
    return null;
  }

  addSupervisorDecision(
    runId: string,
    turnId: string,
    decision: SupervisorDecision,
  ): void {
    this.state.counters.supervisorDecisions += 1;
    this.state.supervisorDecisions.push({
      id: this.state.counters.supervisorDecisions,
      runId,
      turnId,
      decision,
      createdAt: nowIso(),
    });
    trimInPlace(
      this.state.supervisorDecisions,
      this.limits.supervisorDecisions,
    );
    this.persist();
  }

  getLatestSupervisorDecision(runId: string): SupervisorDecision | null {
    for (
      let index = this.state.supervisorDecisions.length - 1;
      index >= 0;
      index -= 1
    ) {
      const decision = this.state.supervisorDecisions[index];
      if (decision?.runId === runId) {
        return decision.decision;
      }
    }
    return null;
  }

  addMemoryCheckpoint(agentId: string, runId: string, summary: string): void {
    this.state.counters.memoryCheckpoints += 1;
    this.state.memoryCheckpoints.push({
      id: this.state.counters.memoryCheckpoints,
      agentId,
      runId,
      summary,
      createdAt: nowIso(),
    });
    trimInPlace(this.state.memoryCheckpoints, this.limits.memoryCheckpoints);
    this.persist();
  }

  private loadFromDisk(): PersistedState {
    return readStateFromDisk(this.path, this.limits);
  }

  private persist(): void {
    this.dirty = true;
    if (this.persistDebounceMs === 0) {
      this.persistNow();
      return;
    }
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, this.persistDebounceMs);
    this.persistTimer.unref?.();
  }

  private persistNow(): void {
    if (!this.dirty) {
      return;
    }
    withStateFileLock(this.path, () => {
      const diskState = readStateFromDisk(this.path, this.limits);
      const merged = mergePersistedStates(diskState, this.state, this.limits);
      writeStateAtomic(this.path, merged);
      this.state = merged;
    });
    this.dirty = false;
  }

  private nextTimestamp(existingIsoValues: string[]): string {
    const nowMs = Date.now();
    const maxExistingMs = existingIsoValues.reduce((current, iso) => {
      const parsed = Date.parse(iso);
      if (!Number.isFinite(parsed)) {
        return current;
      }
      return Math.max(current, parsed);
    }, 0);
    const nextMs = Math.max(nowMs, maxExistingMs + 1);
    return new Date(nextMs).toISOString();
  }
}
