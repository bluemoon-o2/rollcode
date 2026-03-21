export type ThreadRole = "worker" | "supervisor";

export type RunStatus =
  | "working"
  | "supervising"
  | "repairing"
  | "blocked"
  | "completed"
  | "interrupted";

export type SkillSource = "bundled" | "global" | "agent" | "project";
export type SkillDiscoveryMode = "auto" | "suggest" | "off";
export type SkillResolutionMethod =
  | "canonical"
  | "alias"
  | "local-first"
  | "shorthand"
  | "ambiguous"
  | "not-found";

export interface WorkerHandoff {
  summary: string;
  evidence: string[];
  unresolved: string[];
  completionClaim: boolean;
}

export interface WorkerTurnOutput {
  userMessage: string;
  handoff: WorkerHandoff;
}

export interface SupervisorDecision {
  action: "continue" | "repair" | "complete" | "blocked";
  rationale: string;
  nextInstruction?: string;
  memoryAction: "none" | "review" | "consolidate";
}

export interface TurnPlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface RunTurnHistoryEntry {
  threadRole: ThreadRole;
  turnId: string;
  payload: WorkerTurnOutput | SupervisorDecision;
  createdAt: string;
}

export interface CommandExecutionRecord {
  id: string;
  command: string;
  output: string;
  phase: "running" | "finished";
  success?: boolean;
  exitCode?: number | null;
}

export interface AgentRecord {
  id: string;
  name: string;
  cwd: string;
  workerThreadId: string | null;
  supervisorThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  agentId: string;
  goal: string;
  status: RunStatus;
  detached: boolean;
  ownerPid: number | null;
  pendingInstruction: string | null;
  workerTurnCount: number;
  latestWorkerTurnId: string | null;
  latestSupervisorTurnId: string | null;
  memoryReminderDue: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface EventRecord {
  runId: string;
  threadRole: ThreadRole | "system";
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface MemoryFileRecord {
  relativePath: string;
  description: string;
  limit: number;
  body: string;
}

export interface SkillRecord {
  id: string;
  name: string;
  localName: string;
  canonicalName: string;
  namespace: string | null;
  description: string;
  source: SkillSource;
  path: string;
  rootPath: string;
  disableModelInvocation: boolean;
  mirroredSkillPath?: string;
}

export interface SkillCollision {
  canonicalName: string;
  winnerPath: string;
  loserPath: string;
  winnerSource: SkillSource;
  loserSource: SkillSource;
}

export interface SkillDiagnostic {
  type: "warning" | "collision";
  message: string;
  path: string;
  collision?: SkillCollision;
}

export interface SkillDiscoveryResult {
  skills: SkillRecord[];
  diagnostics: SkillDiagnostic[];
  fingerprint: string;
}

export interface SkillPreferencesRule {
  when: string;
  use?: string[];
  prefer?: string[];
  avoid?: string[];
}

export interface SkillPreferences {
  always_use_skills: string[];
  prefer_skills: string[];
  avoid_skills: string[];
  skill_rules: SkillPreferencesRule[];
  skill_aliases: Record<string, string>;
  skill_discovery?: SkillDiscoveryMode;
  skill_staleness_days?: number;
}

export interface TurnArtifacts {
  turnId: string;
  finalMessage: string;
  plan: TurnPlanStep[];
  diff: string;
  commandOutput: string;
  commandExecutions?: CommandExecutionRecord[];
  items: unknown[];
}

export interface RunSnapshot {
  agent: AgentRecord;
  run: RunRecord;
  latestWorkerOutput: WorkerTurnOutput | null;
  latestSupervisorDecision: SupervisorDecision | null;
  turnHistory: RunTurnHistoryEntry[];
  logs: string[];
  plan: TurnPlanStep[];
  diff: string;
  commandOutput: string;
  commandExecutions: CommandExecutionRecord[];
  showSupervisor: boolean;
  viewerOnly: boolean;
  activeThreadRole: ThreadRole | null;
}
