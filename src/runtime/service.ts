import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { CodexAppServerClient } from "../codex/client";
import {
  isSupervisorDecision,
  isWorkerTurnOutput,
  SUPERVISOR_DECISION_SCHEMA,
  SUPERVISOR_DECISION_SCHEMA_LEGACY,
  WORKER_TURN_SCHEMA,
} from "../codex/schemas";
import {
  DEFAULT_AUTO_RETRY_BASE_DELAY_MS,
  DEFAULT_AUTO_RETRY_ENABLED,
  DEFAULT_AUTO_RETRY_MAX_DELAY_MS,
  DEFAULT_AUTO_RETRY_MAX_RETRIES,
  DEFAULT_LOOP_STALL_REPEAT_THRESHOLD,
  DEFAULT_MAX_TURNS_PER_RUN,
  DEFAULT_MEMORY_REMINDER_INTERVAL,
  DEFAULT_PARALLEL_EXECUTION_MODE,
  DEFAULT_PARALLEL_HELPER_CIRCUIT_COOLDOWN_TURNS,
  DEFAULT_PARALLEL_HELPER_ERROR_THRESHOLD,
  DEFAULT_PARALLEL_HELPER_EXECUTOR,
  DEFAULT_PARALLEL_WORKER_LANES,
  DEFAULT_PARALLEL_WORKERS_ENABLED,
  DEFAULT_SKILL_DISCOVERY_MODE,
  DEFAULT_SKILL_STALENESS_DAYS,
  DEFAULT_SUPERVISOR_COLLABORATION_MODE,
  DEFAULT_TASK_ISOLATION_MODE,
  DEFAULT_WORKER_COLLABORATION_MODE,
  getAgentEventLogPath,
  getAgentEventsDir,
  getAgentSkillTelemetryPath,
  getRunCheckpointPath,
  getRunSessionStatusPath,
} from "../config";
import type {
  AgentRecord,
  CommandExecutionRecord,
  EventRecord,
  RunRecord,
  RunSnapshot,
  SkillDiagnostic,
  SkillDiscoveryMode,
  SkillDiscoveryResult,
  SkillPreferences,
  SkillRecord,
  SupervisorDecision,
  ThreadRole,
  TurnArtifacts,
  TurnPlanStep,
  WorkerTurnOutput,
} from "../domain/types";
import {
  prepareWorkspaceIsolation,
  type WorkspaceIsolationContext,
} from "../git/isolation";
import { MemoryManager } from "../memory/manager";
import {
  buildSupervisorBasePrompt,
  buildSupervisorDeveloperPrompt,
  buildSupervisorTurnInput,
  buildWorkerBasePrompt,
  buildWorkerDeveloperPrompt,
  buildWorkerTurnInput,
} from "../prompts";
import { buildSkillActivationPlan } from "../skills/activation";
import { discoverSkillsDetailed } from "../skills/discovery";
import {
  NamespacedSkillRegistry,
  NamespacedSkillResolver,
} from "../skills/namespaced";
import { loadSkillPreferences } from "../skills/preferences";
import { mirrorSkillsForCodex } from "../skills/sync";
import {
  detectStaleSkills,
  loadSkillTelemetry,
  recordSkillUsage,
  type SkillTelemetryState,
} from "../skills/telemetry";
import { StateStore } from "../state/store";
import { appendJsonl, readTextIfExists, writeText } from "../utils/fs";
import { resolveFeedbackCommand } from "../utils/githubFeedback";
import { agentIdForCwd, newId } from "../utils/id";
import { formatLocalClock, nowIso } from "../utils/time";
import {
  clearRunCheckpoint,
  loadRunCheckpoint,
  saveRunCheckpoint,
  serializeWorkerArtifacts,
  toTurnArtifacts,
} from "./checkpoint";
import { formatDoctorReport, runRuntimeDoctor } from "./doctor";
import {
  createParallelCircuitState,
  detectStalledWorkerLoop,
  nextParallelCircuitState,
  type ParallelCircuitState,
  type WorkerLoopSample,
} from "./fault-tolerance";
import type {
  InternalHelperLaneRequest,
  InternalHelperLaneResponse,
} from "./helper-lane";
import {
  deriveRuntimeState,
  resolveDecisionTransition,
  resolveRuntimeDispatch,
} from "./orchestration";
import {
  enforcePlanCompletionGate,
  mergePlanTracks,
  normalizePlanSteps,
  selectParallelLanePlan,
} from "./planning";
import { clearRunSessionStatus, saveRunSessionStatus } from "./session-status";

type SnapshotListener = (snapshot: RunSnapshot) => void;

const INTERRUPTED_GUIDANCE_MESSAGE =
  "Interrupted – tell the agent what to do differently. Something went wrong? Use /feedback to report issues.";

function isTransientHttpError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b502\b|\b503\b|\b504\b|\b521\b|\b522\b|\b524\b|bad gateway|gateway timeout|temporar(?:y|ily) unavailable|upstream timeout|econnreset|etimedout)/i.test(
    message,
  );
}

function isSupervisorSchemaCompatibilityError(error: unknown): boolean {
  if (isTransientHttpError(error)) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:nextinstruction|required|schema|json)/i.test(message);
}

function normalizeSupervisorDecision(
  decision: SupervisorDecision,
): SupervisorDecision {
  return {
    ...decision,
    nextInstruction:
      typeof decision.nextInstruction === "string"
        ? decision.nextInstruction
        : "",
  };
}

export interface SessionController {
  start(): Promise<void>;
  getSnapshot(): RunSnapshot;
  subscribe(listener: SnapshotListener): () => void;
  interruptActiveTurn(): Promise<void>;
  handleCommand(input: string): Promise<void>;
  dispose(): Promise<void>;
}

function isPidAlive(pid: number | null): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatEvent(event: EventRecord): string {
  const stamp = formatLocalClock(event.createdAt);
  const prefix =
    event.threadRole === "worker"
      ? "worker"
      : event.threadRole === "supervisor"
        ? "supervisor"
        : "system";
  if (typeof event.payload === "string") {
    return `${stamp} [${prefix}] ${event.payload}`;
  }
  if (
    event.payload &&
    typeof event.payload === "object" &&
    "message" in (event.payload as Record<string, unknown>)
  ) {
    return `${stamp} [${prefix}] ${String((event.payload as Record<string, unknown>).message)}`;
  }
  return `${stamp} [${prefix}] ${event.eventType}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseExitCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function normalizeSkillStalenessDays(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(0, DEFAULT_SKILL_STALENESS_DAYS);
  }
  return Math.max(0, Math.floor(value));
}

type WorkerLaneRole = "primary" | "helper";
type ParallelHelperExecutor = "thread" | "process";

interface WorkerLaneRunResult extends TurnArtifacts {
  parsed: WorkerTurnOutput;
  laneRole: WorkerLaneRole;
  laneIndex: number;
  laneLabel: string;
}

interface ResolvedSkillsRuntimeState {
  skills: SkillRecord[];
  diagnostics: SkillDiagnostic[];
  fingerprint: string;
}

class SnapshotBus {
  private readonly emitter = new EventEmitter();

  subscribe(listener: SnapshotListener): () => void {
    this.emitter.on("snapshot", listener);
    return () => this.emitter.off("snapshot", listener);
  }

  publish(snapshot: RunSnapshot): void {
    this.emitter.emit("snapshot", snapshot);
  }
}

class DetachedRunWatcher implements SessionController {
  private readonly bus = new SnapshotBus();
  private interval: Timer | null = null;
  private snapshot: RunSnapshot;
  private snapshotSignature: string;

  constructor(
    private readonly service: RollcodeService,
    private readonly agent: AgentRecord,
    private readonly run: RunRecord,
  ) {
    this.snapshot = this.service.buildSnapshot(this.agent, this.run, {
      viewerOnly: true,
      showSupervisor: false,
      turnHistory: this.service.store.listTurnOutputs(run.id),
      logs: this.service.store.listEvents(run.id).map(formatEvent),
      latestWorkerOutput: this.service.store.getLatestWorkerOutput(run.id),
      latestSupervisorDecision: this.service.store.getLatestSupervisorDecision(
        run.id,
      ),
      activeThreadRole: null,
      plan: [],
      diff: "",
      commandOutput: "",
      commandExecutions: [],
    });
    this.snapshotSignature = this.computeSnapshotSignature(this.snapshot);
  }

  async start(): Promise<void> {
    this.refresh();
    this.interval = setInterval(() => this.refresh(), 1000);
  }

  getSnapshot(): RunSnapshot {
    return this.snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    return this.bus.subscribe(listener);
  }

  async interruptActiveTurn(): Promise<void> {
    this.publishSnapshot({
      ...this.snapshot,
      logs: [
        ...this.snapshot.logs,
        "Attach mode is read-only. Interrupt is only available in the owner session.",
      ],
    });
  }

  async handleCommand(input: string): Promise<void> {
    const trimmed = input.trim();
    const feedback = resolveFeedbackCommand(trimmed, {
      cwd: this.agent.cwd,
      source: "attach",
      runId: this.run.id,
      runStatus: this.run.status,
      goal: this.run.goal,
    });
    if (feedback.kind !== "not-feedback") {
      if (feedback.kind === "needs-message") {
        this.publishSnapshot({
          ...this.snapshot,
          logs: [...this.snapshot.logs, feedback.hint],
        });
        return;
      }
      this.publishSnapshot({
        ...this.snapshot,
        logs: [...this.snapshot.logs, feedback.message],
      });
      return;
    }

    switch (trimmed) {
      case "/new":
        this.publishSnapshot({
          ...this.snapshot,
          logs: [
            ...this.snapshot.logs,
            "Cannot start a new run from read-only attach mode. Exit and use /new in launcher.",
          ],
        });
        return;
      case "/supervisor":
        this.publishSnapshot({
          ...this.snapshot,
          showSupervisor: !this.snapshot.showSupervisor,
        });
        return;
      case "/memory": {
        const memory = new MemoryManager(this.agent.id);
        const status = await memory.status();
        this.publishSnapshot({
          ...this.snapshot,
          logs: [...this.snapshot.logs, status],
        });
        return;
      }
      case "/skills": {
        const discovery = await discoverSkillsDetailed(
          this.agent.cwd,
          this.agent.id,
        );
        this.publishSnapshot({
          ...this.snapshot,
          logs: [
            ...this.snapshot.logs,
            `Resolved skills: ${discovery.skills.map((skill) => `${skill.canonicalName} (${skill.source})`).join(", ") || "none"}`,
            discovery.diagnostics.length > 0
              ? `Skill diagnostics: ${discovery.diagnostics.length} (use owner session /skills for details).`
              : "Skill diagnostics: none",
          ],
        });
        return;
      }
      case "/doctor":
      case "/doctor fix": {
        if (trimmed === "/doctor fix") {
          this.publishSnapshot({
            ...this.snapshot,
            logs: [
              ...this.snapshot.logs,
              "Attach mode is read-only. Use owner session or CLI: rollcode doctor --fix",
            ],
          });
          return;
        }
        const report = await runRuntimeDoctor({
          store: this.service.store,
          fix: false,
        });
        this.publishSnapshot({
          ...this.snapshot,
          logs: [...this.snapshot.logs, formatDoctorReport(report)],
        });
        return;
      }
      default:
        this.publishSnapshot({
          ...this.snapshot,
          logs: [
            ...this.snapshot.logs,
            "This run is currently owned by another RollCode process. Attach is read-only.",
          ],
        });
        return;
    }
  }

  async dispose(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private refresh(): void {
    const run = this.service.store.getRunById(this.run.id) ?? this.run;
    const nextSnapshot = this.service.buildSnapshot(this.agent, run, {
      viewerOnly: true,
      showSupervisor: this.snapshot.showSupervisor,
      turnHistory: this.service.store.listTurnOutputs(run.id),
      logs: this.service.store.listEvents(run.id).map(formatEvent),
      latestWorkerOutput: this.service.store.getLatestWorkerOutput(run.id),
      latestSupervisorDecision: this.service.store.getLatestSupervisorDecision(
        run.id,
      ),
      activeThreadRole: null,
      plan: this.snapshot.plan,
      diff: this.snapshot.diff,
      commandOutput: this.snapshot.commandOutput,
      commandExecutions: this.snapshot.commandExecutions,
    });
    const nextSignature = this.computeSnapshotSignature(nextSnapshot);
    if (nextSignature === this.snapshotSignature) {
      return;
    }
    this.publishSnapshot(nextSnapshot, nextSignature);
  }

  private publishSnapshot(
    nextSnapshot: RunSnapshot,
    nextSignature?: string,
  ): void {
    this.snapshot = nextSnapshot;
    this.snapshotSignature =
      nextSignature ?? this.computeSnapshotSignature(nextSnapshot);
    this.bus.publish(this.snapshot);
  }

  private computeSnapshotSignature(snapshot: RunSnapshot): string {
    return JSON.stringify({
      run: {
        id: snapshot.run.id,
        goal: snapshot.run.goal,
        status: snapshot.run.status,
        detached: snapshot.run.detached,
        pendingInstruction: snapshot.run.pendingInstruction,
        workerTurnCount: snapshot.run.workerTurnCount,
        latestWorkerTurnId: snapshot.run.latestWorkerTurnId,
        latestSupervisorTurnId: snapshot.run.latestSupervisorTurnId,
        memoryReminderDue: snapshot.run.memoryReminderDue,
        lastError: snapshot.run.lastError,
        completedAt: snapshot.run.completedAt,
      },
      latestWorkerOutput: snapshot.latestWorkerOutput,
      latestSupervisorDecision: snapshot.latestSupervisorDecision,
      turnHistory: snapshot.turnHistory,
      logs: snapshot.logs,
      plan: snapshot.plan,
      diff: snapshot.diff,
      commandOutput: snapshot.commandOutput,
      commandExecutions: snapshot.commandExecutions,
      showSupervisor: snapshot.showSupervisor,
      viewerOnly: snapshot.viewerOnly,
      activeThreadRole: snapshot.activeThreadRole,
    });
  }
}

class RunRuntime implements SessionController {
  private readonly bus = new SnapshotBus();
  private readonly memory: MemoryManager;
  private readonly logPath: string;
  private readonly checkpointPath: string;
  private readonly sessionStatusPath: string;
  private readonly parallelHelperExecutor: ParallelHelperExecutor =
    DEFAULT_PARALLEL_HELPER_EXECUTOR;
  private sessionHeartbeat: Timer | null = null;
  private lastSessionStatusSignature: string | null = null;
  private logs: string[] = [];
  private plan = [] as RunSnapshot["plan"];
  private diff = "";
  private commandOutput = "";
  private commandExecutions: CommandExecutionRecord[] = [];
  private commandExecutionIndexByKey = new Map<string, number>();
  private commandExecutionFallbackCounter = 0;
  private showSupervisor = false;
  private isolation: WorkspaceIsolationContext = {
    mode: "none",
    baseCwd: ".",
    executionCwd: ".",
    repoRoot: null,
  };
  private executionCwd = ".";
  private parallelWorkerThreadIds: string[] = [];
  private parallelLaneCount = 1;
  private lastParallelLaneSelectionKey: string | null = null;
  private parallelCircuit: ParallelCircuitState = createParallelCircuitState();
  private readonly loopSamples: WorkerLoopSample[] = [];
  private lastDispatchKey: string | null = null;
  private activeParallelTurnIds = new Map<string, string>();
  private pendingWorkerArtifacts:
    | (TurnArtifacts & { parsed: WorkerTurnOutput })
    | null = null;
  private latestWorkerOutput: WorkerTurnOutput | null;
  private latestSupervisorDecision: SupervisorDecision | null;
  private activeThreadRole: ThreadRole | null = null;
  private activeTurnIds: Partial<Record<ThreadRole, string>> = {};
  private loopPromise: Promise<void> | null = null;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private closed = false;
  private resolvedSkills: SkillRecord[] = [];
  private skillDiagnostics: SkillDiagnostic[] = [];
  private skillCatalogFingerprint: string | null = null;
  private skillResolver = new NamespacedSkillResolver(
    new NamespacedSkillRegistry(),
  );
  private skillPreferences: SkillPreferences = {
    always_use_skills: [],
    prefer_skills: [],
    avoid_skills: [],
    skill_rules: [],
    skill_aliases: {},
  };
  private skillPreferenceWarnings: string[] = [];
  private lastSkillActivationKey: string | null = null;
  private readonly skillTelemetryPath: string;
  private skillTelemetryState: SkillTelemetryState = {
    version: 1,
    skills: {},
  };
  private skillDiscoveryMode: SkillDiscoveryMode = DEFAULT_SKILL_DISCOVERY_MODE;
  private skillStalenessDays = Math.max(0, DEFAULT_SKILL_STALENESS_DAYS);
  private lastSuggestedSkillFingerprint: string | null = null;
  private agent: AgentRecord;
  private run: RunRecord;

  constructor(
    private readonly service: RollcodeService,
    agent: AgentRecord,
    run: RunRecord,
  ) {
    this.agent = agent;
    this.run = run;
    this.isolation = prepareWorkspaceIsolation(
      agent.cwd,
      DEFAULT_TASK_ISOLATION_MODE,
    );
    this.executionCwd = this.isolation.executionCwd;
    this.memory = new MemoryManager(agent.id);
    this.logPath = getAgentEventLogPath(agent.id, run.id);
    this.checkpointPath = getRunCheckpointPath(agent.id, run.id);
    this.sessionStatusPath = getRunSessionStatusPath(agent.id, run.id);
    this.skillTelemetryPath = getAgentSkillTelemetryPath(agent.id);
    this.latestWorkerOutput = this.service.store.getLatestWorkerOutput(run.id);
    this.latestSupervisorDecision =
      this.service.store.getLatestSupervisorDecision(run.id);
    this.logs = this.service.store.listEvents(run.id).map(formatEvent);
  }

  async start(): Promise<void> {
    await this.bootstrap();
    if (
      this.run.status !== "completed" &&
      (this.run.status !== "blocked" || this.run.pendingInstruction)
    ) {
      await this.resumeAutonomy();
    }
  }

  getSnapshot(): RunSnapshot {
    return this.service.buildSnapshot(this.agent, this.run, {
      viewerOnly: false,
      showSupervisor: this.showSupervisor,
      turnHistory: this.service.store.listTurnOutputs(this.run.id),
      logs: this.logs,
      latestWorkerOutput: this.latestWorkerOutput,
      latestSupervisorDecision: this.latestSupervisorDecision,
      activeThreadRole: this.activeThreadRole,
      plan: this.plan,
      diff: this.diff,
      commandOutput: this.commandOutput,
      commandExecutions: this.commandExecutions,
    });
  }

  subscribe(listener: SnapshotListener): () => void {
    return this.bus.subscribe(listener);
  }

  async interruptActiveTurn(): Promise<void> {
    await this.interruptWorkerTurn();
  }

  async handleCommand(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    const feedback = resolveFeedbackCommand(trimmed, {
      cwd: this.executionCwd,
      source: "session",
      runId: this.run.id,
      runStatus: this.run.status,
      goal: this.run.goal,
    });
    if (feedback.kind !== "not-feedback") {
      if (feedback.kind === "needs-message") {
        this.pushLog(feedback.hint);
        return;
      }
      this.pushLog(feedback.message);
      return;
    }

    switch (trimmed) {
      case "/new":
        this.pushLog("Use /exit to leave this run, then use /new in launcher.");
        return;
      case "/supervisor":
        this.showSupervisor = !this.showSupervisor;
        this.publish();
        return;
      case "/resume":
        this.pushLog(
          "Resuming current run. To open run history picker, exit to launcher and use /resume there (or run `rollcode resume`).",
        );
        if (this.run.status === "blocked" && !this.run.pendingInstruction) {
          this.run = this.service.store.updateRun(this.run.id, {
            status: "working",
            pendingInstruction:
              "Continue with the next best concrete step toward the goal.",
          });
          this.publish();
        }
        await this.resumeAutonomy();
        return;
      case "/memory":
        this.pushLog(await this.memory.status());
        return;
      case "/skills":
      case "/skills reload":
        this.pushLog(
          `Resolved skills: ${this.resolvedSkills.map((skill) => `${skill.canonicalName} (${skill.source})`).join(", ") || "none"}`,
        );
        this.pushLog(
          `Skill runtime policy: discovery=${this.skillDiscoveryMode}, stalenessDays=${this.skillStalenessDays}`,
        );
        if (this.skillDiagnostics.length > 0) {
          this.pushLog(
            `Skill diagnostics (${this.skillDiagnostics.length}): ${this.skillDiagnostics
              .slice(0, 8)
              .map((entry) => entry.message)
              .join(" | ")}`,
          );
        } else {
          this.pushLog("Skill diagnostics: none");
        }
        if (trimmed === "/skills reload") {
          await this.reloadSkillsForOperatorRequest();
        }
        return;
      case "/doctor":
      case "/doctor fix": {
        const fix = trimmed === "/doctor fix";
        const report = await runRuntimeDoctor({
          store: this.service.store,
          fix,
        });
        this.pushLog(formatDoctorReport(report));
        return;
      }
      default:
        if (trimmed.startsWith("/")) {
          this.pushLog(`Unknown command: ${trimmed}`);
          return;
        }
        await this.sendOperatorMessage(trimmed);
        return;
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.stopSessionHeartbeat();
    await this.loopPromise;
    if (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
    if (
      this.run.status === "completed" ||
      this.run.status === "interrupted" ||
      (this.run.status === "blocked" && !this.run.pendingInstruction)
    ) {
      await clearRunSessionStatus(this.sessionStatusPath);
      return;
    }
    await this.persistSessionStatus(true);
  }

  private async persistSessionStatus(force = false): Promise<void> {
    const signature = JSON.stringify({
      runStatus: this.run.status,
      activeThreadRole: this.activeThreadRole,
      detached: this.run.detached,
      ownerPid: this.run.ownerPid,
      executionCwd: this.executionCwd,
    });
    if (!force && signature === this.lastSessionStatusSignature) {
      return;
    }
    this.lastSessionStatusSignature = signature;
    await saveRunSessionStatus(this.sessionStatusPath, {
      runId: this.run.id,
      agentId: this.agent.id,
      pid: process.pid,
      runStatus: this.run.status,
      activeThreadRole: this.activeThreadRole,
      detached: this.run.detached,
      ownerPid: this.run.ownerPid,
      executionCwd: this.executionCwd,
    });
  }

  private startSessionHeartbeat(): void {
    if (this.sessionHeartbeat) {
      return;
    }
    this.sessionHeartbeat = setInterval(() => {
      this.trackBackgroundTask(this.persistSessionStatus(true));
    }, 2000);
  }

  private stopSessionHeartbeat(): void {
    if (!this.sessionHeartbeat) {
      return;
    }
    clearInterval(this.sessionHeartbeat);
    this.sessionHeartbeat = null;
  }

  private async bootstrap(): Promise<void> {
    const [, skillState, loadedPreferences, loadedTelemetry] =
      await Promise.all([
        this.memory.ensureInitialized(this.executionCwd),
        this.service.resolveSkills(this.executionCwd, this.agent.id),
        loadSkillPreferences(this.executionCwd),
        loadSkillTelemetry(this.skillTelemetryPath),
      ]);
    this.skillPreferences = loadedPreferences.preferences;
    this.skillPreferenceWarnings = loadedPreferences.warnings;
    this.skillTelemetryState = loadedTelemetry;
    this.skillDiscoveryMode =
      this.skillPreferences.skill_discovery ?? DEFAULT_SKILL_DISCOVERY_MODE;
    this.skillStalenessDays = normalizeSkillStalenessDays(
      this.skillPreferences.skill_staleness_days,
    );
    this.applyResolvedSkills(skillState);

    if (this.skillPreferenceWarnings.length > 0) {
      await this.record("system", "skill-preferences-warning", {
        message: this.skillPreferenceWarnings.join(" | "),
      });
    }
    if (loadedPreferences.loadedPaths.length > 0) {
      await this.record("system", "skill-preferences", {
        message: `Loaded skill preferences from: ${loadedPreferences.loadedPaths.join(", ")}`,
      });
    }
    if (this.skillDiagnostics.length > 0) {
      await this.record("system", "skill-diagnostics", {
        message: `Detected ${this.skillDiagnostics.length} skill diagnostics.`,
        diagnostics: this.skillDiagnostics.slice(0, 24),
      });
    }
    if (
      this.skillPreferences.skill_discovery !== undefined ||
      this.skillPreferences.skill_staleness_days !== undefined
    ) {
      await this.record("system", "skill-policy", {
        message: `Skill policy loaded (discovery=${this.skillDiscoveryMode}, stalenessDays=${this.skillStalenessDays}).`,
        discoveryMode: this.skillDiscoveryMode,
        stalenessDays: this.skillStalenessDays,
      });
    }
    const staleSkills = detectStaleSkills({
      state: this.skillTelemetryState,
      skills: this.resolvedSkills,
      thresholdDays: this.skillStalenessDays,
    });
    if (staleSkills.length > 0) {
      await this.record("system", "skill-stale", {
        message: `Detected ${staleSkills.length} stale skills (not used recently).`,
        staleSkills: staleSkills.slice(0, 24),
        thresholdDays: this.skillStalenessDays,
      });
    }

    this.agent = await this.service.ensureThreads(
      this.agent,
      this.resolvedSkills,
      this.memory,
      this.executionCwd,
    );
    const requestedLaneCount = DEFAULT_PARALLEL_WORKERS_ENABLED
      ? Math.max(1, DEFAULT_PARALLEL_WORKER_LANES)
      : 1;
    const helperCount = Math.max(0, requestedLaneCount - 1);
    this.parallelWorkerThreadIds =
      helperCount > 0
        ? await this.service.createWorkerHelperThreads({
            cwd: this.executionCwd,
            skills: this.resolvedSkills,
            memory: this.memory,
            count: helperCount,
          })
        : [];
    this.parallelLaneCount = 1 + this.parallelWorkerThreadIds.length;

    if (this.isolation.note) {
      await this.record("system", "isolation", {
        message: this.isolation.note,
        mode: this.isolation.mode,
        baseCwd: this.isolation.baseCwd,
        executionCwd: this.isolation.executionCwd,
        branchName: this.isolation.branchName ?? null,
      });
    }
    if (this.parallelLaneCount > 1) {
      await this.record("system", "parallel-lanes", {
        message: `Parallel worker lanes enabled (${this.parallelLaneCount} total lanes).`,
        laneCount: this.parallelLaneCount,
        helperLanes: this.parallelWorkerThreadIds.length,
      });
    }
    if (this.parallelHelperExecutor === "process") {
      await this.record("system", "parallel-executor", {
        message: "Parallel helper executor mode: process.",
      });
    }
    await this.recoverFromCheckpoint();
    await this.persistSessionStatus(true);
    this.startSessionHeartbeat();
    this.publish();
  }

  private applyResolvedSkills(state: ResolvedSkillsRuntimeState): void {
    this.resolvedSkills = state.skills;
    this.skillCatalogFingerprint = state.fingerprint;
    const aliasDiagnostics = this.rebuildSkillResolverWithAliases();
    this.skillDiagnostics = [...state.diagnostics, ...aliasDiagnostics];
  }

  private rebuildSkillResolverWithAliases(): SkillDiagnostic[] {
    const registry = new NamespacedSkillRegistry();
    for (const skill of this.resolvedSkills) {
      registry.register(skill);
    }

    const aliasDiagnostics: SkillDiagnostic[] = [];
    for (const [alias, canonicalName] of Object.entries(
      this.skillPreferences.skill_aliases,
    )) {
      const registered = registry.registerAlias(alias, canonicalName);
      if (registered.success) {
        continue;
      }
      aliasDiagnostics.push({
        type: "warning",
        message: `Skill alias "${alias}" -> "${canonicalName}" rejected (${registered.reason}).`,
        path: "<skill_aliases>",
      });
    }
    this.skillResolver = new NamespacedSkillResolver(registry);
    return aliasDiagnostics;
  }

  private diffSkillNames(nextSkills: SkillRecord[]): {
    added: string[];
    removed: string[];
  } {
    const previousNames = new Set(
      this.resolvedSkills.map((skill) => skill.canonicalName),
    );
    const nextNames = new Set(nextSkills.map((skill) => skill.canonicalName));
    const added = [...nextNames]
      .filter((name) => !previousNames.has(name))
      .sort((left, right) => left.localeCompare(right));
    const removed = [...previousNames]
      .filter((name) => !nextNames.has(name))
      .sort((left, right) => left.localeCompare(right));
    return { added, removed };
  }

  private async forceReloadSkillsCatalog(
    trigger: "auto" | "manual",
  ): Promise<{ added: string[]; removed: string[] }> {
    const refreshed = await this.service.resolveSkills(
      this.executionCwd,
      this.agent.id,
    );
    const diff = this.diffSkillNames(refreshed.skills);
    this.applyResolvedSkills(refreshed);
    this.lastSuggestedSkillFingerprint = null;

    this.agent = await this.service.ensureThreads(
      this.agent,
      this.resolvedSkills,
      this.memory,
      this.executionCwd,
    );
    const helperCount = Math.max(0, this.parallelLaneCount - 1);
    this.parallelWorkerThreadIds =
      helperCount > 0
        ? await this.service.createWorkerHelperThreads({
            cwd: this.executionCwd,
            skills: this.resolvedSkills,
            memory: this.memory,
            count: helperCount,
          })
        : [];
    this.parallelLaneCount = 1 + this.parallelWorkerThreadIds.length;

    await this.record("system", "skills-reloaded", {
      message:
        diff.added.length > 0 || diff.removed.length > 0
          ? `Skill catalog reloaded (${trigger}; added=${diff.added.length}, removed=${diff.removed.length}).`
          : `Skill catalog reloaded (${trigger}; no additions/removals).`,
      discoveryMode: this.skillDiscoveryMode,
      trigger,
      added: diff.added,
      removed: diff.removed,
      diagnostics: this.skillDiagnostics.slice(0, 24),
    });
    return diff;
  }

  private async refreshSkillsCatalogIfChanged(): Promise<void> {
    if (this.skillDiscoveryMode === "off") {
      return;
    }
    const latest = await discoverSkillsDetailed(
      this.executionCwd,
      this.agent.id,
    );
    if (latest.fingerprint === this.skillCatalogFingerprint) {
      return;
    }
    if (this.skillDiscoveryMode === "suggest") {
      if (latest.fingerprint === this.lastSuggestedSkillFingerprint) {
        return;
      }
      const diff = this.diffSkillNames(latest.skills);
      await this.record("system", "skills-suggested", {
        message:
          diff.added.length > 0 || diff.removed.length > 0
            ? `Skill catalog changed; suggestion mode active (added=${diff.added.length}, removed=${diff.removed.length}).`
            : "Skill catalog content changed; suggestion mode active.",
        discoveryMode: this.skillDiscoveryMode,
        added: diff.added,
        removed: diff.removed,
        diagnostics: latest.diagnostics.slice(0, 24),
      });
      this.lastSuggestedSkillFingerprint = latest.fingerprint;
      return;
    }
    await this.forceReloadSkillsCatalog("auto");
  }

  private async reloadSkillsForOperatorRequest(): Promise<void> {
    const diff = await this.forceReloadSkillsCatalog("manual");
    this.pushLog(
      diff.added.length > 0 || diff.removed.length > 0
        ? `Skill catalog reloaded (added=${diff.added.length}, removed=${diff.removed.length}).`
        : "Skill catalog reloaded (no additions/removals).",
    );
  }

  private async computeSkillActivationPlan(
    pendingInstruction: string | null,
  ): Promise<ReturnType<typeof buildSkillActivationPlan>> {
    const plan = buildSkillActivationPlan({
      skills: this.resolvedSkills,
      resolver: this.skillResolver,
      preferences: this.skillPreferences,
      goal: this.run.goal,
      pendingInstruction,
      plan: this.plan,
    });
    const key = [
      plan.activatedSkills.map((skill) => skill.canonicalName).join(","),
      plan.avoidedSkills.join(","),
      plan.unresolvedRefs.join(","),
      plan.reason,
    ].join("|");
    if (key !== this.lastSkillActivationKey) {
      await this.record("system", "skill-activation", {
        message:
          plan.activatedSkills.length > 0
            ? `Activated skills: ${plan.activatedSkills
                .map((skill) => skill.canonicalName)
                .join(", ")}`
            : "No skills activated for this worker turn.",
        reason: plan.reason,
        activatedSkills: plan.activatedSkills.map(
          (skill) => skill.canonicalName,
        ),
        avoidedSkills: plan.avoidedSkills,
        unresolved: plan.unresolvedRefs,
      });
      this.lastSkillActivationKey = key;
    }
    if (plan.activatedSkills.length > 0) {
      this.skillTelemetryState = await recordSkillUsage({
        path: this.skillTelemetryPath,
        state: this.skillTelemetryState,
        canonicalNames: plan.activatedSkills.map(
          (skill) => skill.canonicalName,
        ),
      });
    }
    return plan;
  }

  private async recoverFromCheckpoint(): Promise<void> {
    const checkpoint = await loadRunCheckpoint(
      this.checkpointPath,
      this.run.id,
    );
    if (!checkpoint) {
      return;
    }

    this.plan = normalizePlanSteps(checkpoint.plan ?? []);
    this.diff = checkpoint.diff ?? "";
    this.commandOutput = checkpoint.commandOutput ?? "";
    this.commandExecutions = (checkpoint.commandExecutions ?? []).map(
      (entry) => ({ ...entry }),
    );
    this.commandExecutionIndexByKey.clear();
    for (let index = 0; index < this.commandExecutions.length; index += 1) {
      const entry = this.commandExecutions[index] as CommandExecutionRecord;
      this.commandExecutionIndexByKey.set(entry.id, index);
    }

    if (checkpoint.pendingWorkerArtifacts) {
      this.pendingWorkerArtifacts = toTurnArtifacts(
        checkpoint.pendingWorkerArtifacts,
      );
      this.latestWorkerOutput = this.pendingWorkerArtifacts.parsed;
      this.run = this.service.store.updateRun(this.run.id, {
        status: "supervising",
      });
      await this.record("system", "recovery", {
        message:
          "Recovered pending worker artifacts from checkpoint; resuming with supervisor review.",
        phase: checkpoint.phase,
      });
      return;
    }

    await this.record("system", "recovery", {
      message: "Recovered runtime checkpoint metadata.",
      phase: checkpoint.phase,
    });
  }

  private async persistCheckpoint(args: {
    phase: "worker-dispatched" | "worker-completed" | "supervisor-dispatched";
    pendingWorkerArtifacts?:
      | (TurnArtifacts & { parsed: WorkerTurnOutput })
      | null;
  }): Promise<void> {
    await saveRunCheckpoint(this.checkpointPath, {
      runId: this.run.id,
      phase: args.phase,
      pendingWorkerArtifacts: args.pendingWorkerArtifacts
        ? serializeWorkerArtifacts(args.pendingWorkerArtifacts)
        : null,
      plan: this.plan,
      diff: this.diff,
      commandOutput: this.commandOutput,
      commandExecutions: this.commandExecutions.map((entry) => ({ ...entry })),
    });
  }

  private async clearCheckpoint(): Promise<void> {
    await clearRunCheckpoint(this.checkpointPath);
  }

  private async applyLoopStallGuard(
    pendingInstruction: string | null,
    plan: TurnPlanStep[],
  ): Promise<boolean> {
    const completedPlanSteps = plan.filter(
      (step) => step.status === "completed",
    ).length;
    this.loopSamples.push({
      instruction:
        pendingInstruction ||
        "advance the goal with the next best concrete step",
      completedPlanSteps,
      turn: this.run.workerTurnCount,
    });
    if (this.loopSamples.length > 8) {
      this.loopSamples.splice(0, this.loopSamples.length - 8);
    }

    const stallSignal = detectStalledWorkerLoop(
      this.loopSamples,
      DEFAULT_LOOP_STALL_REPEAT_THRESHOLD,
    );
    if (!stallSignal) {
      return false;
    }

    this.run = this.service.store.updateRun(this.run.id, {
      status: "blocked",
      lastError: stallSignal.reason,
      pendingInstruction: null,
    });
    await this.record("system", "loop-stalled", {
      message: stallSignal.reason,
      samples: this.loopSamples.slice(-4),
    });
    this.activeThreadRole = null;
    this.publish();
    return true;
  }

  private async resumeAutonomy(): Promise<void> {
    if (this.loopPromise) {
      return;
    }
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
      this.publish();
    });
    await Promise.resolve();
  }

  private async runLoop(): Promise<void> {
    while (!this.closed) {
      const derived = deriveRuntimeState({
        run: this.run,
        hasPendingWorkerArtifacts: this.pendingWorkerArtifacts !== null,
        maxTurns: DEFAULT_MAX_TURNS_PER_RUN,
      });
      const dispatch = resolveRuntimeDispatch(derived);
      const dispatchKey = `${derived.phase}|${dispatch.action}|${dispatch.reason}`;
      if (dispatchKey !== this.lastDispatchKey) {
        await this.record("system", "dispatch", {
          message: `Dispatch -> ${dispatch.action} (${derived.phase})`,
          phase: derived.phase,
          action: dispatch.action,
          reason: dispatch.reason,
        });
        this.lastDispatchKey = dispatchKey;
      }

      if (dispatch.action === "stop") {
        await this.clearCheckpoint();
        this.activeThreadRole = null;
        this.publish();
        return;
      }

      if (dispatch.action === "block-turn-limit") {
        this.run = this.service.store.updateRun(this.run.id, {
          status: "blocked",
          lastError: `Reached max turns for run (${DEFAULT_MAX_TURNS_PER_RUN})`,
        });
        await this.record("system", "blocked", {
          message: `Blocked after ${DEFAULT_MAX_TURNS_PER_RUN} worker turns.`,
        });
        this.pendingWorkerArtifacts = null;
        await this.clearCheckpoint();
        this.activeThreadRole = null;
        this.publish();
        return;
      }

      if (dispatch.action === "dispatch-worker") {
        await this.refreshSkillsCatalogIfChanged();
        const pendingInstruction = this.run.pendingInstruction;
        const activation =
          await this.computeSkillActivationPlan(pendingInstruction);
        const lanePlan = selectParallelLanePlan({
          mode: DEFAULT_PARALLEL_EXECUTION_MODE,
          maxLaneCount: this.parallelLaneCount,
          plan: this.plan,
          pendingInstruction,
        });
        const memoryRecall = await this.memory.buildTaskRecall({
          goal: this.run.goal,
          pendingInstruction,
          latestDecision: this.latestSupervisorDecision,
          latestWorkerSummary: this.latestWorkerOutput?.handoff.summary ?? null,
          maxResults: 4,
        });
        const input = buildWorkerTurnInput({
          goal: this.run.goal,
          workerTurnCount: this.run.workerTurnCount,
          pendingInstruction,
          latestDecision: this.latestSupervisorDecision,
          memoryReminder:
            this.run.memoryReminderDue ||
            (this.run.workerTurnCount > 0 &&
              this.run.workerTurnCount % DEFAULT_MEMORY_REMINDER_INTERVAL ===
                0),
          workspaceMode: this.isolation.mode,
          executionCwd: this.executionCwd,
          parallelWorkersEnabled: lanePlan.helperLanesEnabled,
          parallelLaneIndex: 1,
          parallelLaneCount: lanePlan.activeLaneCount,
          parallelLaneRole: "primary",
          skillActivation: activation.activatedSkills.map(
            (skill) => skill.canonicalName,
          ),
          skillActivationReason: activation.reason,
          memoryRecall,
        });

        this.run = this.service.store.updateRun(this.run.id, {
          status: "working",
          memoryReminderDue: false,
          pendingInstruction: null,
          lastError: null,
        });
        this.activeThreadRole = "worker";
        this.commandOutput = "";
        this.commandExecutions = [];
        this.commandExecutionIndexByKey.clear();
        this.commandExecutionFallbackCounter = 0;
        this.activeParallelTurnIds.clear();
        await this.persistCheckpoint({
          phase: "worker-dispatched",
          pendingWorkerArtifacts: null,
        });
        this.publish();

        const workerArtifacts = await this.runWorkerTurn(
          input,
          pendingInstruction,
        );
        if (!workerArtifacts) {
          return;
        }
        const stalled = await this.applyLoopStallGuard(
          pendingInstruction,
          workerArtifacts.plan,
        );
        if (stalled) {
          this.pendingWorkerArtifacts = null;
          await this.clearCheckpoint();
          return;
        }
        this.pendingWorkerArtifacts = workerArtifacts;
        await this.persistCheckpoint({
          phase: "worker-completed",
          pendingWorkerArtifacts: workerArtifacts,
        });
        this.activeThreadRole = null;
        this.publish();
        continue;
      }

      const workerArtifacts = this.pendingWorkerArtifacts;
      if (!workerArtifacts) {
        this.activeThreadRole = null;
        this.publish();
        continue;
      }

      this.run = this.service.store.updateRun(this.run.id, {
        status: "supervising",
      });
      this.activeThreadRole = "supervisor";
      await this.persistCheckpoint({
        phase: "supervisor-dispatched",
        pendingWorkerArtifacts: workerArtifacts,
      });
      this.publish();

      const decisionArtifacts = await this.runSupervisorTurn(workerArtifacts);
      if (!decisionArtifacts) {
        return;
      }
      this.pendingWorkerArtifacts = null;

      const decision = decisionArtifacts.parsed;
      this.latestSupervisorDecision = decision;
      this.service.store.addTurnOutput(
        this.run.id,
        "supervisor",
        decisionArtifacts.turnId,
        decision,
      );
      this.service.store.addSupervisorDecision(
        this.run.id,
        decisionArtifacts.turnId,
        decision,
      );
      this.run = this.service.store.updateRun(this.run.id, {
        latestSupervisorTurnId: decisionArtifacts.turnId,
      });
      await this.record("supervisor", "decision", {
        message: `${decision.action.toUpperCase()}: ${decision.rationale}`,
        decision,
      });

      if (decision.memoryAction !== "none" && this.latestWorkerOutput) {
        this.scheduleMemoryUpdate(decision, this.latestWorkerOutput);
      }

      const transition = resolveDecisionTransition(decision);
      this.run = this.service.store.updateRun(this.run.id, {
        status: transition.status,
        pendingInstruction: transition.pendingInstruction,
        completedAt: transition.markCompleted ? nowIso() : this.run.completedAt,
      });
      this.activeThreadRole = null;
      this.publish();
      if (transition.markCompleted) {
        await this.clearCheckpoint();
        return;
      }
      if (transition.status === "blocked" && !transition.pendingInstruction) {
        await this.clearCheckpoint();
        return;
      }
      await this.persistCheckpoint({
        phase: "worker-dispatched",
        pendingWorkerArtifacts: null,
      });
    }
  }

  private async runWithTransientRetry<T>(params: {
    lane: string;
    runTurn: () => Promise<T>;
  }): Promise<T> {
    const enabled = DEFAULT_AUTO_RETRY_ENABLED;
    const maxRetries = Math.max(0, DEFAULT_AUTO_RETRY_MAX_RETRIES);
    const baseDelayMs = Math.max(1, DEFAULT_AUTO_RETRY_BASE_DELAY_MS);
    const maxDelayMs = Math.max(baseDelayMs, DEFAULT_AUTO_RETRY_MAX_DELAY_MS);
    let attempt = 0;

    while (true) {
      try {
        return await params.runTurn();
      } catch (error) {
        if (!enabled || !isTransientHttpError(error) || attempt >= maxRetries) {
          throw error;
        }
        attempt += 1;
        const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        await this.record("system", "retry", {
          message: `Transient upstream error during ${params.lane} turn. Retrying (${attempt}/${maxRetries}) in ${delayMs}ms.`,
          lane: params.lane,
          attempt,
          maxRetries,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
        await Bun.sleep(delayMs);
      }
    }
  }

  private async runWorkerTurn(
    input: string,
    pendingInstruction: string | null,
  ): Promise<(TurnArtifacts & { parsed: WorkerTurnOutput }) | null> {
    try {
      const effectiveMaxLaneCount = this.parallelCircuit.open
        ? 1
        : this.parallelLaneCount;
      const laneSelection = selectParallelLanePlan({
        mode: DEFAULT_PARALLEL_EXECUTION_MODE,
        maxLaneCount: effectiveMaxLaneCount,
        plan: this.plan,
        pendingInstruction,
      });
      const laneReason = this.parallelCircuit.open
        ? `${laneSelection.reason}; helper circuit open (cooldown ${this.parallelCircuit.cooldownRemaining})`
        : laneSelection.reason;
      const laneSelectionKey = [
        laneSelection.helperLanesEnabled ? "helpers-on" : "helpers-off",
        String(laneSelection.activeLaneCount),
        laneReason,
      ].join("|");
      if (laneSelectionKey !== this.lastParallelLaneSelectionKey) {
        await this.record("system", "parallel-policy", {
          message: `Parallel lane selection: ${laneReason}.`,
          mode: DEFAULT_PARALLEL_EXECUTION_MODE,
          helperLanesEnabled: laneSelection.helperLanesEnabled,
          activeLaneCount: laneSelection.activeLaneCount,
          helperCircuitOpen: this.parallelCircuit.open,
          helperCircuitCooldown: this.parallelCircuit.cooldownRemaining,
        });
        this.lastParallelLaneSelectionKey = laneSelectionKey;
      }
      const helperThreadIds = laneSelection.helperLanesEnabled
        ? this.parallelWorkerThreadIds.slice(
            0,
            Math.max(0, laneSelection.activeLaneCount - 1),
          )
        : [];
      const laneSpecs: Array<{
        threadId: string;
        laneRole: WorkerLaneRole;
        laneIndex: number;
      }> = [
        {
          threadId: this.agent.workerThreadId as string,
          laneRole: "primary",
          laneIndex: 1,
        },
        ...helperThreadIds.map((threadId, index) => ({
          threadId,
          laneRole: "helper" as const,
          laneIndex: index + 2,
        })),
      ];
      const activeLaneCount = laneSpecs.length;

      const settledRuns = await Promise.allSettled(
        laneSpecs.map(
          async (lane) =>
            await this.runWorkerLane({
              threadId: lane.threadId,
              input: this.withParallelLaneInput(
                input,
                lane.laneIndex,
                lane.laneRole,
                activeLaneCount,
              ),
              laneRole: lane.laneRole,
              laneIndex: lane.laneIndex,
            }),
        ),
      );

      const completedLanes: WorkerLaneRunResult[] = [];
      const helperErrors: string[] = [];
      let primaryError: string | null = null;
      for (let index = 0; index < settledRuns.length; index += 1) {
        const runResult = settledRuns[index];
        const laneSpec = laneSpecs[index];
        if (runResult?.status === "fulfilled") {
          completedLanes.push(runResult.value);
          continue;
        }
        const laneLabel = `lane-${laneSpec?.laneIndex ?? index + 1}`;
        const reason =
          runResult?.reason instanceof Error
            ? runResult.reason.message
            : String(runResult?.reason ?? "unknown worker lane failure");
        if (laneSpec?.laneRole === "primary") {
          primaryError = reason;
        } else {
          helperErrors.push(`${laneLabel}: ${reason}`);
        }
      }

      if (primaryError) {
        throw new Error(primaryError);
      }

      const primaryLane = completedLanes.find(
        (lane) => lane.laneRole === "primary",
      );
      if (!primaryLane) {
        throw new Error("Primary worker lane did not return a result");
      }

      const helperLanes = completedLanes.filter(
        (lane) => lane.laneRole === "helper",
      );
      let artifacts = this.mergeWorkerLaneResults(
        primaryLane,
        helperLanes,
        helperErrors,
      );
      artifacts = {
        ...artifacts,
        plan: normalizePlanSteps(artifacts.plan),
      };
      const completionGate = enforcePlanCompletionGate({
        output: artifacts.parsed,
        plan: artifacts.plan,
      });
      if (completionGate.gated) {
        const gateMessage =
          completionGate.reason === "missing_plan"
            ? "Completion claim gated because worker emitted no plan updates."
            : "Completion claim gated because plan still has incomplete steps.";
        artifacts = {
          ...artifacts,
          parsed: completionGate.output,
          finalMessage: JSON.stringify(completionGate.output),
        };
        await this.record("system", "plan-gate", {
          message: gateMessage,
          reason: completionGate.reason,
          unresolvedSteps: completionGate.unresolvedSteps,
        });
      }

      this.activeTurnIds.worker = undefined;
      this.activeParallelTurnIds.clear();
      this.latestWorkerOutput = artifacts.parsed;
      this.plan = artifacts.plan;
      this.diff = artifacts.diff;
      if (this.plan.length === 0) {
        await this.record("system", "plan-missing", {
          message:
            "Worker reported no plan updates for this turn; supervisor should verify plan completeness.",
        });
      }
      if (artifacts.commandOutput.trim()) {
        this.commandOutput = artifacts.commandOutput;
      }
      if (
        Array.isArray(artifacts.commandExecutions) &&
        artifacts.commandExecutions.length > 0
      ) {
        if (this.commandExecutions.length === 0) {
          this.commandExecutions = artifacts.commandExecutions.map((entry) => ({
            ...entry,
          }));
        } else {
          const existing = new Set(
            this.commandExecutions.map((entry) => entry.id),
          );
          for (const entry of artifacts.commandExecutions) {
            if (existing.has(entry.id)) {
              continue;
            }
            this.commandExecutions.push({ ...entry });
          }
        }
      }
      if (helperErrors.length > 0) {
        await this.record("system", "parallel-lane-error", {
          message: `Some parallel lanes failed (${helperErrors.length}).`,
          errors: helperErrors,
        });
      }
      const previousCircuit = this.parallelCircuit;
      this.parallelCircuit = nextParallelCircuitState({
        current: this.parallelCircuit,
        helperErrorCount: helperErrors.length,
        errorThreshold: DEFAULT_PARALLEL_HELPER_ERROR_THRESHOLD,
        cooldownTurns: DEFAULT_PARALLEL_HELPER_CIRCUIT_COOLDOWN_TURNS,
      });
      if (
        this.parallelCircuit.open !== previousCircuit.open ||
        this.parallelCircuit.cooldownRemaining !==
          previousCircuit.cooldownRemaining ||
        this.parallelCircuit.errorStreak !== previousCircuit.errorStreak
      ) {
        await this.record("system", "parallel-circuit", {
          message: this.parallelCircuit.open
            ? `Parallel helper circuit opened after repeated helper failures (streak=${this.parallelCircuit.errorStreak}).`
            : "Parallel helper circuit closed and helpers re-enabled.",
          state: this.parallelCircuit,
          previous: previousCircuit,
        });
      }
      for (const helperLane of helperLanes) {
        await this.record("worker", "parallel-message", {
          lane: helperLane.laneLabel,
          message: helperLane.parsed.userMessage,
          handoff: helperLane.parsed.handoff,
        });
      }
      this.service.store.addTurnOutput(
        this.run.id,
        "worker",
        artifacts.turnId,
        artifacts.parsed,
      );
      this.run = this.service.store.updateRun(this.run.id, {
        workerTurnCount: this.run.workerTurnCount + 1,
        latestWorkerTurnId: artifacts.turnId,
      });
      await this.record("worker", "message", {
        message: artifacts.parsed.userMessage,
        handoff: artifacts.parsed.handoff,
        parallelLanes: activeLaneCount,
        parallelReason: laneReason,
      });
      return artifacts;
    } catch (error) {
      this.activeTurnIds.worker = undefined;
      this.activeParallelTurnIds.clear();
      this.activeThreadRole = null;
      this.run = this.service.store.updateRun(this.run.id, {
        status: "blocked",
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.pendingWorkerArtifacts = null;
      await this.clearCheckpoint();
      await this.record("system", "error", {
        message: this.run.lastError,
      });
      return null;
    }
  }

  private withParallelLaneInput(
    baseInput: string,
    laneIndex: number,
    laneRole: WorkerLaneRole,
    laneCount: number,
  ): string {
    if (laneCount <= 1) {
      return baseInput;
    }
    const laneHeader =
      laneRole === "primary"
        ? "Primary implementation lane."
        : "Parallel helper lane.";
    const laneGuidance =
      laneRole === "primary"
        ? [
            "Own concrete implementation progress for this turn.",
            "Integrate helper-lane evidence before claiming completion.",
          ]
        : [
            "Focus on independent analysis and verification tracks.",
            "Avoid overlapping file ownership with the primary lane unless absolutely necessary.",
            "If edits are required, keep them minimal and explicitly describe ownership/risk in handoff.",
          ];
    return [
      baseInput,
      "",
      "Parallel lane assignment:",
      `- lane ${laneIndex}/${laneCount}`,
      `- role: ${laneRole}`,
      `- directive: ${laneHeader}`,
      ...laneGuidance.map((line) => `- ${line}`),
    ].join("\n");
  }

  private async runWorkerLaneInSubprocess(args: {
    threadId: string;
    input: string;
    laneLabel: string;
  }): Promise<TurnArtifacts & { parsed: WorkerTurnOutput }> {
    const scriptPath = process.argv[1];
    if (!scriptPath) {
      throw new Error(
        "Cannot resolve RollCode script path for helper subprocess.",
      );
    }
    const token = `${this.run.id}.${args.laneLabel}.${newId("helper")}`;
    const requestPath = join(
      getAgentEventsDir(this.agent.id),
      `${token}.request.json`,
    );
    const responsePath = join(
      getAgentEventsDir(this.agent.id),
      `${token}.response.json`,
    );
    const request: InternalHelperLaneRequest = {
      threadId: args.threadId,
      input: args.input,
      mode: DEFAULT_WORKER_COLLABORATION_MODE,
    };
    await writeText(requestPath, `${JSON.stringify(request, null, 2)}\n`);

    const processHandle = Bun.spawn(
      [
        process.execPath,
        scriptPath,
        "internal-helper-lane",
        "--request-path",
        requestPath,
        "--response-path",
        responsePath,
      ],
      {
        cwd: this.executionCwd,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]);
    const responseRaw = await readTextIfExists(responsePath);
    let response: InternalHelperLaneResponse | null = null;
    if (responseRaw?.trim()) {
      try {
        response = JSON.parse(responseRaw) as InternalHelperLaneResponse;
      } catch {
        response = null;
      }
    }
    await Promise.allSettled([
      rm(requestPath, { force: true }),
      rm(responsePath, { force: true }),
    ]);

    if (!response) {
      throw new Error(
        `Helper subprocess returned no valid response (${args.laneLabel}, exit=${exitCode}). stderr=${stderrText.trim() || "none"} stdout=${stdoutText.trim() || "none"}`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Helper subprocess failed (${args.laneLabel}): ${response.error}`,
      );
    }
    if (!isWorkerTurnOutput(response.artifacts.parsed)) {
      throw new Error(
        `Helper subprocess output did not match WorkerTurnOutput (${args.laneLabel}).`,
      );
    }
    return response.artifacts;
  }

  private async runWorkerLane(args: {
    threadId: string;
    input: string;
    laneRole: WorkerLaneRole;
    laneIndex: number;
  }): Promise<WorkerLaneRunResult> {
    const laneLabel = `lane-${args.laneIndex}`;
    const artifacts = await this.runWithTransientRetry({
      lane: args.laneRole === "primary" ? "worker" : `worker-${laneLabel}`,
      runTurn: async () => {
        if (
          args.laneRole === "helper" &&
          this.parallelHelperExecutor === "process"
        ) {
          return await this.runWorkerLaneInSubprocess({
            threadId: args.threadId,
            input: args.input,
            laneLabel,
          });
        }
        return await this.service.codex.runStructuredTurn<WorkerTurnOutput>({
          threadId: args.threadId,
          input: args.input,
          outputSchema: WORKER_TURN_SCHEMA,
          mode: DEFAULT_WORKER_COLLABORATION_MODE,
          onNotification: (method, params) => {
            if (args.laneRole === "primary") {
              this.handleNotification("worker", method, params);
              return;
            }
            this.handleParallelLaneNotification(args.threadId, method, params);
          },
        });
      },
    });

    if (!isWorkerTurnOutput(artifacts.parsed)) {
      throw new Error(`${laneLabel} output did not match WorkerTurnOutput`);
    }
    if (args.laneRole === "primary") {
      this.activeTurnIds.worker = undefined;
    } else {
      this.activeParallelTurnIds.delete(args.threadId);
    }
    return {
      ...artifacts,
      laneRole: args.laneRole,
      laneIndex: args.laneIndex,
      laneLabel,
    };
  }

  private mergeWorkerLaneResults(
    primary: WorkerLaneRunResult,
    helpers: WorkerLaneRunResult[],
    helperErrors: string[],
  ): TurnArtifacts & { parsed: WorkerTurnOutput } {
    const evidence = [...primary.parsed.handoff.evidence];
    const unresolved = [...primary.parsed.handoff.unresolved];
    const summarySegments = [primary.parsed.handoff.summary];

    for (const helper of helpers) {
      summarySegments.push(
        `${helper.laneLabel}: ${helper.parsed.handoff.summary}`,
      );
      evidence.push(
        `[${helper.laneLabel}] ${helper.parsed.handoff.summary}`,
        ...helper.parsed.handoff.evidence.map(
          (entry) => `[${helper.laneLabel}] ${entry}`,
        ),
      );
      unresolved.push(
        ...helper.parsed.handoff.unresolved.map(
          (entry) => `[${helper.laneLabel}] ${entry}`,
        ),
      );
    }
    if (helperErrors.length > 0) {
      unresolved.push(...helperErrors.map((entry) => `[parallel] ${entry}`));
      summarySegments.push(`parallel lane errors: ${helperErrors.join("; ")}`);
    }

    const mergedParsed: WorkerTurnOutput = {
      userMessage:
        helpers.length > 0 || helperErrors.length > 0
          ? `${primary.parsed.userMessage} (parallel lanes integrated)`
          : primary.parsed.userMessage,
      handoff: {
        summary: summarySegments.join(" | "),
        evidence,
        unresolved,
        completionClaim:
          primary.parsed.handoff.completionClaim &&
          helperErrors.length === 0 &&
          helpers.every((helper) => helper.parsed.handoff.completionClaim),
      },
    };

    const mergedPlans = mergePlanTracks([
      primary.plan,
      ...helpers.map((helper) => helper.plan),
    ]);
    const mergedDiff = [
      primary.diff.trim(),
      ...helpers
        .map((helper) =>
          helper.diff.trim()
            ? `[${helper.laneLabel}]\n${helper.diff.trim()}`
            : "",
        )
        .filter((diff) => diff.length > 0),
    ]
      .filter((segment) => segment.length > 0)
      .join("\n\n");
    const mergedCommandOutput = [
      primary.commandOutput.trim(),
      ...helpers
        .map((helper) =>
          helper.commandOutput.trim()
            ? `[${helper.laneLabel}]\n${helper.commandOutput.trim()}`
            : "",
        )
        .filter((output) => output.length > 0),
    ]
      .filter((segment) => segment.length > 0)
      .join("\n\n");
    const mergedExecutions: CommandExecutionRecord[] = [
      ...(primary.commandExecutions ?? []).map((entry) => ({ ...entry })),
      ...helpers.flatMap((helper) =>
        (helper.commandExecutions ?? []).map((entry) => ({
          ...entry,
          id: `${helper.laneLabel}:${entry.id}`,
          command: `[${helper.laneLabel}] ${entry.command}`,
        })),
      ),
    ];

    return {
      turnId: primary.turnId,
      finalMessage: JSON.stringify(mergedParsed),
      parsed: mergedParsed,
      plan: mergedPlans,
      diff: mergedDiff,
      commandOutput: mergedCommandOutput,
      commandExecutions: mergedExecutions,
      items: [...primary.items, ...helpers.flatMap((helper) => helper.items)],
    };
  }

  private async runSupervisorTurn(
    workerArtifacts: TurnArtifacts & { parsed: WorkerTurnOutput },
  ): Promise<(TurnArtifacts & { parsed: SupervisorDecision }) | null> {
    try {
      const memoryRecall = await this.memory.buildTaskRecall({
        goal: this.run.goal,
        pendingInstruction: this.run.pendingInstruction,
        latestDecision: this.latestSupervisorDecision,
        latestWorkerSummary: workerArtifacts.parsed.handoff.summary,
        maxResults: 5,
      });
      const supervisorInput = buildSupervisorTurnInput({
        goal: this.run.goal,
        handoff: workerArtifacts.parsed.handoff,
        artifacts: workerArtifacts,
        memoryRecall,
      });
      const runSupervisorWithSchema = async (
        outputSchema: unknown,
      ): Promise<TurnArtifacts & { parsed: SupervisorDecision }> =>
        await this.runWithTransientRetry({
          lane: "supervisor",
          runTurn: async () =>
            await this.service.codex.runStructuredTurn<SupervisorDecision>({
              threadId: this.agent.supervisorThreadId as string,
              input: supervisorInput,
              outputSchema,
              mode: DEFAULT_SUPERVISOR_COLLABORATION_MODE,
              onNotification: (method, params) =>
                this.handleNotification("supervisor", method, params),
            }),
        });
      let artifacts: TurnArtifacts & { parsed: SupervisorDecision };
      try {
        artifacts = await runSupervisorWithSchema(SUPERVISOR_DECISION_SCHEMA);
      } catch (error) {
        if (!isSupervisorSchemaCompatibilityError(error)) {
          throw error;
        }
        await this.record("system", "supervisor-schema-fallback", {
          message:
            "Supervisor strict schema rejected by upstream; retrying once with legacy-compatible schema.",
          error: error instanceof Error ? error.message : String(error),
        });
        artifacts = await runSupervisorWithSchema(
          SUPERVISOR_DECISION_SCHEMA_LEGACY,
        );
      }
      this.activeTurnIds.supervisor = undefined;
      const decision = normalizeSupervisorDecision(artifacts.parsed);
      if (!isSupervisorDecision(decision)) {
        throw new Error("Supervisor decision did not match SupervisorDecision");
      }
      return {
        ...artifacts,
        parsed: decision,
      };
    } catch (error) {
      this.activeTurnIds.supervisor = undefined;
      this.activeThreadRole = null;
      this.run = this.service.store.updateRun(this.run.id, {
        status: "blocked",
        lastError: error instanceof Error ? error.message : String(error),
      });
      await this.record("system", "error", {
        message: this.run.lastError,
      });
      return null;
    }
  }

  private async interruptWorkerTurn(): Promise<void> {
    const interrupts: Array<{ threadId: string; turnId: string }> = [];
    const primaryTurnId = this.activeTurnIds.worker;
    if (primaryTurnId && this.agent.workerThreadId) {
      interrupts.push({
        threadId: this.agent.workerThreadId,
        turnId: primaryTurnId,
      });
    }
    for (const [threadId, turnId] of this.activeParallelTurnIds.entries()) {
      if (!turnId) {
        continue;
      }
      interrupts.push({ threadId, turnId });
    }
    if (interrupts.length === 0) {
      this.pushLog("No active worker turn to interrupt.");
      return;
    }

    await Promise.allSettled(
      interrupts.map(async (target) => {
        await this.service.codex.interruptTurn(target.threadId, target.turnId);
      }),
    );
    this.activeTurnIds.worker = undefined;
    this.activeParallelTurnIds.clear();
    this.run = this.service.store.updateRun(this.run.id, {
      status: "interrupted",
      pendingInstruction:
        "Resume from the interrupted state and continue carefully.",
    });
    this.activeThreadRole = null;
    this.pendingWorkerArtifacts = null;
    await this.persistCheckpoint({
      phase: "worker-dispatched",
      pendingWorkerArtifacts: null,
    });
    await this.record("system", "interrupt", {
      message: INTERRUPTED_GUIDANCE_MESSAGE,
      interruptedLanes: interrupts.length,
    });
    this.publish();
  }

  private async sendOperatorMessage(message: string): Promise<void> {
    const activeTurnId = this.activeTurnIds.worker;
    if (activeTurnId && this.agent.workerThreadId) {
      await this.service.codex.steerTurn(
        this.agent.workerThreadId,
        activeTurnId,
        `Operator message:\n${message}`,
      );
      await this.record("system", "steer", {
        message: `Operator steered the active worker turn: ${message}`,
      });
      return;
    }

    this.run = this.service.store.updateRun(this.run.id, {
      pendingInstruction: `Operator message:\n${message}`,
      status:
        this.run.status === "completed" || this.run.status === "blocked"
          ? "working"
          : this.run.status,
      completedAt:
        this.run.status === "completed" ? null : this.run.completedAt,
    });
    if (this.loopPromise) {
      await this.loopPromise;
    }
    await this.resumeAutonomy();
  }

  private handleNotification(
    role: ThreadRole,
    method: string,
    params: unknown,
  ): void {
    const payload = asRecord(params);
    if (!payload) {
      return;
    }
    if (method === "turn/started" && payload.threadId) {
      const turn = asRecord(payload.turn);
      if (role === "worker") {
        this.activeTurnIds.worker = String(turn?.id ?? "");
      } else {
        this.activeTurnIds.supervisor = String(turn?.id ?? "");
      }
      return;
    }
    if (method === "turn/completed") {
      if (role === "worker") {
        this.activeTurnIds.worker = undefined;
      } else {
        this.activeTurnIds.supervisor = undefined;
      }
      return;
    }
    if (method === "serverRequest/handled") {
      const requestMethod = String(payload.method ?? "").trim();
      if (requestMethod === "item/tool/requestUserInput") {
        const requestParams = asRecord(payload.params);
        const response = asRecord(payload.result);
        const questions = Array.isArray(requestParams?.questions)
          ? requestParams.questions
          : [];
        const answers = asRecord(response?.answers);
        const answeredCount = answers ? Object.keys(answers).length : 0;
        void this.record(role, "request-user-input", {
          message: `request_user_input handled automatically (${answeredCount}/${questions.length} answered).`,
          questionCount: questions.length,
          answeredCount,
        });
      }
      return;
    }
    if (method === "turn/plan/updated") {
      const rawPlan = Array.isArray(payload.plan) ? payload.plan : [];
      this.plan = normalizePlanSteps(
        rawPlan.map((item) => {
          const entry = asRecord(item);
          const status = entry?.status;
          return {
            step: String(entry?.step ?? "step"),
            status:
              status === "completed" ||
              status === "in_progress" ||
              status === "pending"
                ? status
                : "pending",
          };
        }),
      );
      this.publish();
      return;
    }
    if (method === "turn/diff/updated") {
      this.diff = String(payload.diff ?? "");
      this.publish();
      return;
    }
    if (
      method === "item/started" &&
      asRecord(payload.item)?.type === "commandExecution"
    ) {
      const item = asRecord(payload.item);
      this.onCommandStarted(item, payload);
      const command = String(item?.command ?? "").trim();
      if (command) {
        this.commandOutput += `$ ${command}\n`;
      }
      this.publish();
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      const delta = String(payload.delta ?? "");
      if (delta) {
        this.onCommandOutputDelta(payload, delta);
        this.commandOutput += delta;
        this.publish();
      }
      return;
    }
    if (method === "thread/compacted" && role === "worker") {
      this.run = this.service.store.updateRun(this.run.id, {
        memoryReminderDue: true,
      });
      void this.record("system", "memory-reminder", {
        message: "Marked memory review as due after context compaction.",
      });
      return;
    }
    if (
      method === "item/completed" &&
      asRecord(payload.item)?.type === "commandExecution"
    ) {
      const item = asRecord(payload.item);
      this.onCommandCompleted(item, payload);
      if (this.commandOutput && !this.commandOutput.endsWith("\n")) {
        this.commandOutput += "\n";
      }
      this.commandOutput += `(exit ${item?.exitCode ?? "?"})\n\n`;
      this.publish();
      void this.record(role, "command", {
        message: `${String(item?.command ?? "")} (exit ${item?.exitCode ?? "?"})`,
      });
    }
  }

  private handleParallelLaneNotification(
    threadId: string,
    method: string,
    params: unknown,
  ): void {
    const payload = asRecord(params);
    if (!payload) {
      return;
    }
    if (method === "turn/started") {
      const turn = asRecord(payload.turn);
      const turnId = String(turn?.id ?? "").trim();
      if (turnId) {
        this.activeParallelTurnIds.set(threadId, turnId);
      }
      return;
    }
    if (method === "turn/completed") {
      this.activeParallelTurnIds.delete(threadId);
    }
  }

  private getCommandKey(
    item: Record<string, unknown> | null,
    payload: Record<string, unknown> | null,
    command: string,
  ): string {
    const raw =
      payload?.itemId ??
      payload?.commandExecutionId ??
      item?.id ??
      payload?.id ??
      "";
    const key = String(raw || "").trim();
    if (key) {
      return `id:${key}`;
    }
    this.commandExecutionFallbackCounter += 1;
    const fallbackCommand = command.trim() || "command";
    return `fallback:${fallbackCommand}:${this.commandExecutionFallbackCounter}`;
  }

  private ensureCommandExecution(
    key: string,
    command: string,
  ): CommandExecutionRecord {
    const existingIndex = this.commandExecutionIndexByKey.get(key);
    if (existingIndex !== undefined) {
      return this.commandExecutions[existingIndex] as CommandExecutionRecord;
    }
    const record: CommandExecutionRecord = {
      id: key,
      command: command || "command",
      output: "",
      phase: "running",
    };
    this.commandExecutions.push(record);
    this.commandExecutionIndexByKey.set(key, this.commandExecutions.length - 1);
    return record;
  }

  private pickCommandExecutionForDelta(
    payload: Record<string, unknown>,
  ): CommandExecutionRecord | null {
    const rawKey =
      payload.itemId ?? payload.commandExecutionId ?? payload.id ?? "";
    const key = String(rawKey || "").trim();
    if (key) {
      const index = this.commandExecutionIndexByKey.get(`id:${key}`);
      if (index !== undefined) {
        return this.commandExecutions[index] as CommandExecutionRecord;
      }
    }
    for (
      let index = this.commandExecutions.length - 1;
      index >= 0;
      index -= 1
    ) {
      const entry = this.commandExecutions[index] as CommandExecutionRecord;
      if (entry.phase === "running") {
        return entry;
      }
    }
    return null;
  }

  private onCommandStarted(
    item: Record<string, unknown> | null,
    payload: Record<string, unknown> | null,
  ): void {
    const command = String(item?.command ?? "").trim();
    const key = this.getCommandKey(item, payload, command);
    const record = this.ensureCommandExecution(key, command);
    if (command) {
      record.command = command;
    }
    record.phase = "running";
    record.success = undefined;
    record.exitCode = undefined;
  }

  private onCommandOutputDelta(
    payload: Record<string, unknown>,
    delta: string,
  ): void {
    const record = this.pickCommandExecutionForDelta(payload);
    if (!record) {
      return;
    }
    record.output += delta;
  }

  private onCommandCompleted(
    item: Record<string, unknown> | null,
    payload: Record<string, unknown> | null,
  ): void {
    const command = String(item?.command ?? "").trim();
    const key = this.getCommandKey(item, payload, command);
    const record = this.ensureCommandExecution(key, command);
    if (command) {
      record.command = command;
    }
    if (!record.output && typeof item?.aggregatedOutput === "string") {
      record.output = item.aggregatedOutput;
    }
    const exitCode = parseExitCode(item?.exitCode);
    record.phase = "finished";
    record.exitCode = exitCode;
    record.success = exitCode === 0;
  }

  private async record(
    threadRole: EventRecord["threadRole"],
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    const createdAt = nowIso();
    const event: EventRecord = {
      runId: this.run.id,
      threadRole,
      eventType,
      payload,
      createdAt,
    };
    this.service.store.addEvent(event);
    await appendJsonl(this.logPath, event);
    this.logs = [...this.logs, formatEvent(event)];
    this.publish();
  }

  private pushLog(message: string): void {
    this.logs = [...this.logs, message];
    this.publish();
  }

  private trackBackgroundTask(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.finally(() => {
      this.backgroundTasks.delete(task);
    });
  }

  private scheduleMemoryUpdate(
    decision: SupervisorDecision,
    workerOutput: WorkerTurnOutput,
  ): void {
    const runAtDecision = this.run;
    const task = (async () => {
      try {
        const summary = await this.memory.materializeDecision(
          runAtDecision,
          workerOutput.handoff,
          decision,
        );
        if (!summary) {
          return;
        }
        this.service.store.addMemoryCheckpoint(
          this.agent.id,
          runAtDecision.id,
          summary,
        );
        await this.record("system", "memory", {
          message: `Memory updated: ${summary}`,
        });
      } catch (error) {
        await this.record("system", "memory-error", {
          message:
            error instanceof Error
              ? `Memory update failed: ${error.message}`
              : `Memory update failed: ${String(error)}`,
        });
      }
    })();
    this.trackBackgroundTask(task);
  }

  private publish(): void {
    this.bus.publish(this.getSnapshot());
    this.trackBackgroundTask(this.persistSessionStatus(false));
  }
}

export class RollcodeService {
  readonly store: StateStore;
  readonly codex: CodexAppServerClient;

  constructor(store = new StateStore(), codex = new CodexAppServerClient()) {
    this.store = store;
    this.codex = codex;
  }

  async dispose(): Promise<void> {
    this.store.close();
    await this.codex.dispose();
  }

  async createRun(
    goal: string,
    cwd: string,
    detached: boolean,
    agentId?: string,
  ): Promise<RunRecord> {
    const agent = await this.ensureAgent(cwd, agentId);
    return this.store.insertRun({
      id: newId("run"),
      agentId: agent.id,
      goal,
      status: "working",
      detached,
      ownerPid: detached ? null : process.pid,
      pendingInstruction: goal,
      workerTurnCount: 0,
      latestWorkerTurnId: null,
      latestSupervisorTurnId: null,
      memoryReminderDue: false,
      lastError: null,
    });
  }

  async openSessionForRun(runId: string): Promise<SessionController> {
    const run = this.store.getRunById(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    const agent = this.store.getAgentById(run.agentId);
    if (!agent) {
      throw new Error(`Agent ${run.agentId} not found`);
    }
    if (
      run.detached &&
      run.ownerPid !== process.pid &&
      isPidAlive(run.ownerPid)
    ) {
      return new DetachedRunWatcher(this, agent, run);
    }
    const claimedRun = this.store.updateRun(run.id, { ownerPid: process.pid });
    return new RunRuntime(this, agent, claimedRun);
  }

  async startInteractiveRun(
    goal: string,
    cwd: string,
    agentId?: string,
  ): Promise<SessionController> {
    const run = await this.createRun(goal, cwd, false, agentId);
    return await this.openSessionForRun(run.id);
  }

  async runDetachedLoop(runId: string): Promise<void> {
    const run = this.store.getRunById(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    this.store.updateRun(run.id, {
      ownerPid: process.pid,
      detached: true,
    });
    const controller = await this.openSessionForRun(run.id);
    await controller.start();
    while (true) {
      const latest = this.store.getRunById(run.id);
      if (
        !latest ||
        latest.status === "completed" ||
        latest.status === "blocked"
      ) {
        await controller.dispose();
        return;
      }
      await Bun.sleep(500);
    }
  }

  async ensureAgent(cwd: string, requestedId?: string): Promise<AgentRecord> {
    const existing = requestedId
      ? this.store.getAgentById(requestedId)
      : this.store.getAgentByCwd(cwd);
    if (existing) {
      return existing;
    }
    const id = requestedId || agentIdForCwd(cwd);
    return this.store.upsertAgent({
      id,
      name: basename(cwd) || id,
      cwd,
      workerThreadId: null,
      supervisorThreadId: null,
    });
  }

  async resolveSkills(
    cwd: string,
    agentId: string,
  ): Promise<ResolvedSkillsRuntimeState> {
    const discovered: SkillDiscoveryResult = await discoverSkillsDetailed(
      cwd,
      agentId,
    );
    const mirrored = await mirrorSkillsForCodex(agentId, discovered.skills);
    await this.codex.reloadSkills(cwd);
    for (const skill of mirrored) {
      if (skill.mirroredSkillPath) {
        await this.codex.setSkillEnabled(skill.mirroredSkillPath, true);
      }
    }
    return {
      skills: mirrored,
      diagnostics: discovered.diagnostics,
      fingerprint: discovered.fingerprint,
    };
  }

  async ensureThreads(
    agent: AgentRecord,
    skills: SkillRecord[],
    memory: MemoryManager,
    executionCwd = agent.cwd,
  ): Promise<AgentRecord> {
    const prompts = await this.buildThreadPrompts(executionCwd, skills, memory);

    const [workerThreadId, supervisorThreadId] = await Promise.all([
      this.ensureThread(
        "worker",
        agent.workerThreadId,
        executionCwd,
        prompts.workerBase,
        prompts.workerDeveloper,
      ),
      this.ensureThread(
        "supervisor",
        agent.supervisorThreadId,
        executionCwd,
        prompts.supervisorBase,
        prompts.supervisorDeveloper,
      ),
    ]);

    return this.store.upsertAgent({
      id: agent.id,
      name: agent.name,
      cwd: agent.cwd,
      workerThreadId,
      supervisorThreadId,
    });
  }

  async createWorkerHelperThreads(args: {
    cwd: string;
    skills: SkillRecord[];
    memory: MemoryManager;
    count: number;
  }): Promise<string[]> {
    const count = Math.max(0, Math.floor(args.count));
    if (count === 0) {
      return [];
    }
    const prompts = await this.buildThreadPrompts(
      args.cwd,
      args.skills,
      args.memory,
    );
    const threadIds = await Promise.all(
      Array.from(
        { length: count },
        async () =>
          await this.ensureThread(
            "worker",
            null,
            args.cwd,
            prompts.workerBase,
            prompts.workerDeveloper,
          ),
      ),
    );
    return threadIds;
  }

  listAgents(): AgentRecord[] {
    return this.store.listAgents();
  }

  buildSnapshot(
    agent: AgentRecord,
    run: RunRecord,
    state: {
      viewerOnly: boolean;
      showSupervisor: boolean;
      turnHistory: RunSnapshot["turnHistory"];
      logs: string[];
      latestWorkerOutput: WorkerTurnOutput | null;
      latestSupervisorDecision: SupervisorDecision | null;
      activeThreadRole: ThreadRole | null;
      plan: RunSnapshot["plan"];
      diff: string;
      commandOutput: string;
      commandExecutions: CommandExecutionRecord[];
    },
  ): RunSnapshot {
    return {
      agent,
      run,
      latestWorkerOutput: state.latestWorkerOutput,
      latestSupervisorDecision: state.latestSupervisorDecision,
      turnHistory: state.turnHistory,
      logs: state.logs.slice(-120),
      plan: state.plan,
      diff: state.diff,
      commandOutput: state.commandOutput,
      commandExecutions: state.commandExecutions,
      showSupervisor: state.showSupervisor,
      viewerOnly: state.viewerOnly,
      activeThreadRole: state.activeThreadRole,
    };
  }

  private async ensureThread(
    _role: ThreadRole,
    existingThreadId: string | null,
    cwd: string,
    baseInstructions: string,
    developerInstructions: string,
  ): Promise<string> {
    if (existingThreadId) {
      try {
        return await this.codex.resumeThread({
          threadId: existingThreadId,
          cwd,
          baseInstructions,
          developerInstructions,
        });
      } catch {
        return await this.codex.startThread({
          cwd,
          baseInstructions,
          developerInstructions,
        });
      }
    }
    return await this.codex.startThread({
      cwd,
      baseInstructions,
      developerInstructions,
    });
  }

  private async buildThreadPrompts(
    cwd: string,
    skills: SkillRecord[],
    memory: MemoryManager,
  ): Promise<{
    workerBase: string;
    workerDeveloper: string;
    supervisorBase: string;
    supervisorDeveloper: string;
  }> {
    const promptContext = await memory.buildPromptContext();
    const skillSummary =
      skills
        .map(
          (skill) =>
            `- ${skill.canonicalName} (${skill.source}${skill.disableModelInvocation ? ", explicit-only" : ""})`,
        )
        .join("\n") || "- No custom RollCode skills resolved.";
    return {
      workerBase: buildWorkerBasePrompt({
        cwd,
        memory: promptContext,
        skillsSummary: skillSummary,
      }),
      workerDeveloper: buildWorkerDeveloperPrompt(),
      supervisorBase: buildSupervisorBasePrompt({
        cwd,
        memory: promptContext,
      }),
      supervisorDeveloper: buildSupervisorDeveloperPrompt(),
    };
  }
}
