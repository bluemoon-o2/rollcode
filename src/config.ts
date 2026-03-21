import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot =
  basename(moduleDir) === "src" ? dirname(moduleDir) : moduleDir;

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

function readNonNegativeIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function readBooleanEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

function readEnumEnv<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  const matched = allowed.find((candidate) => candidate === normalized);
  return matched ?? fallback;
}

export function getRollcodeHome(): string {
  return process.env.ROLLCODE_HOME?.trim() || join(homedir(), ".rollcode");
}

export function getStatePath(): string {
  return join(getRollcodeHome(), "state.json");
}

export function getGlobalSkillsDir(): string {
  return join(getRollcodeHome(), "skills");
}

export function getCodexSkillsMirrorDir(): string {
  return (
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR?.trim() ||
    join(homedir(), ".codex", "skills", "rollcode")
  );
}

export const PROJECT_SKILLS_DIR_NAME = ".skills";
export const DEFAULT_MAX_TURNS_PER_RUN = readPositiveIntEnv(
  "ROLLCODE_MAX_TURNS_PER_RUN",
  24,
);
export const DEFAULT_MEMORY_REMINDER_INTERVAL = readPositiveIntEnv(
  "ROLLCODE_MEMORY_REMINDER_INTERVAL",
  12,
);
export const DEFAULT_AUTO_RETRY_ENABLED = readBooleanEnv(
  "ROLLCODE_AUTO_RETRY_ENABLED",
  true,
);
export const DEFAULT_AUTO_RETRY_MAX_RETRIES = readPositiveIntEnv(
  "ROLLCODE_AUTO_RETRY_MAX_RETRIES",
  3,
);
export const DEFAULT_AUTO_RETRY_BASE_DELAY_MS = readPositiveIntEnv(
  "ROLLCODE_AUTO_RETRY_BASE_DELAY_MS",
  2000,
);
export const DEFAULT_AUTO_RETRY_MAX_DELAY_MS = readPositiveIntEnv(
  "ROLLCODE_AUTO_RETRY_MAX_DELAY_MS",
  60000,
);
export const DEFAULT_PARALLEL_WORKERS_ENABLED = readBooleanEnv(
  "ROLLCODE_PARALLEL_WORKERS_ENABLED",
  true,
);
export const DEFAULT_PARALLEL_WORKER_LANES = readPositiveIntEnv(
  "ROLLCODE_PARALLEL_WORKER_LANES",
  2,
);
export const DEFAULT_PARALLEL_EXECUTION_MODE = readEnumEnv(
  "ROLLCODE_PARALLEL_EXECUTION_MODE",
  ["always", "adaptive"] as const,
  "adaptive",
);
export const DEFAULT_PARALLEL_HELPER_EXECUTOR = readEnumEnv(
  "ROLLCODE_PARALLEL_HELPER_EXECUTOR",
  ["thread", "process"] as const,
  "thread",
);
export const DEFAULT_PARALLEL_HELPER_ERROR_THRESHOLD = readPositiveIntEnv(
  "ROLLCODE_PARALLEL_HELPER_ERROR_THRESHOLD",
  2,
);
export const DEFAULT_PARALLEL_HELPER_CIRCUIT_COOLDOWN_TURNS =
  readPositiveIntEnv("ROLLCODE_PARALLEL_HELPER_CIRCUIT_COOLDOWN_TURNS", 2);
export const DEFAULT_LOOP_STALL_REPEAT_THRESHOLD = readPositiveIntEnv(
  "ROLLCODE_LOOP_STALL_REPEAT_THRESHOLD",
  3,
);
export const DEFAULT_SKILL_DISCOVERY_MODE = readEnumEnv(
  "ROLLCODE_SKILL_DISCOVERY_MODE",
  ["auto", "suggest", "off"] as const,
  "auto",
);
export const DEFAULT_SKILL_STALENESS_DAYS = readNonNegativeIntEnv(
  "ROLLCODE_SKILL_STALENESS_DAYS",
  60,
);
export const DEFAULT_WORKER_COLLABORATION_MODE = readEnumEnv(
  "ROLLCODE_WORKER_COLLABORATION_MODE",
  ["default", "plan"] as const,
  "plan",
);
export const DEFAULT_SUPERVISOR_COLLABORATION_MODE = readEnumEnv(
  "ROLLCODE_SUPERVISOR_COLLABORATION_MODE",
  ["default", "plan"] as const,
  "default",
);
export const DEFAULT_TASK_ISOLATION_MODE = readEnumEnv(
  "ROLLCODE_TASK_ISOLATION_MODE",
  ["none", "worktree"] as const,
  "none",
);

export function getProjectRoot(): string {
  return projectRoot;
}

export function getBundledSkillsDir(): string {
  return join(projectRoot, "skills", "builtin");
}

export function getAgentDir(agentId: string): string {
  return join(getRollcodeHome(), "agents", agentId);
}

export function getAgentEventsDir(agentId: string): string {
  return join(getAgentDir(agentId), "events");
}

export function getAgentMemoryDir(agentId: string): string {
  return join(getAgentDir(agentId), "memory");
}

export function getAgentSkillsDir(agentId: string): string {
  return join(getAgentDir(agentId), "skills");
}

export function getAgentEventLogPath(agentId: string, runId: string): string {
  return join(getAgentEventsDir(agentId), `${runId}.jsonl`);
}

export function getRunCheckpointPath(agentId: string, runId: string): string {
  return join(getAgentEventsDir(agentId), `${runId}.checkpoint.json`);
}

export function getRunSessionStatusPath(
  agentId: string,
  runId: string,
): string {
  return join(getAgentEventsDir(agentId), `${runId}.session.json`);
}

export function getGlobalSkillPreferencesPath(): string {
  return join(getRollcodeHome(), "skill-preferences.json");
}

export function getProjectSkillPreferencesPath(cwd: string): string {
  return join(cwd, PROJECT_SKILLS_DIR_NAME, "preferences.json");
}

export function getAgentSkillTelemetryPath(agentId: string): string {
  return join(getAgentDir(agentId), "skills.telemetry.json");
}
