import type { SkillRecord } from "../domain/types";
import { readTextIfExists, writeText } from "../utils/fs";
import { nowIso } from "../utils/time";

interface SkillTelemetryEntry {
  lastUsedAt: string;
  totalUses: number;
}

interface SkillTelemetryState {
  version: 1;
  skills: Record<string, SkillTelemetryEntry>;
}

function emptyState(): SkillTelemetryState {
  return {
    version: 1,
    skills: {},
  };
}

function normalizeState(value: unknown): SkillTelemetryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyState();
  }
  const raw = value as Partial<SkillTelemetryState>;
  const skills: Record<string, SkillTelemetryEntry> = {};
  if (raw.skills && typeof raw.skills === "object" && !Array.isArray(raw.skills)) {
    for (const [name, entry] of Object.entries(raw.skills)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const rawEntry = entry as Partial<SkillTelemetryEntry>;
      if (typeof rawEntry.lastUsedAt !== "string") {
        continue;
      }
      const totalUses =
        typeof rawEntry.totalUses === "number" && Number.isFinite(rawEntry.totalUses)
          ? Math.max(0, Math.floor(rawEntry.totalUses))
          : 0;
      skills[name] = {
        lastUsedAt: rawEntry.lastUsedAt,
        totalUses,
      };
    }
  }
  return {
    version: 1,
    skills,
  };
}

export async function loadSkillTelemetry(path: string): Promise<SkillTelemetryState> {
  const content = await readTextIfExists(path);
  if (!content) {
    return emptyState();
  }
  try {
    return normalizeState(JSON.parse(content));
  } catch {
    return emptyState();
  }
}

export async function recordSkillUsage(args: {
  path: string;
  state: SkillTelemetryState;
  canonicalNames: string[];
}): Promise<SkillTelemetryState> {
  const next = normalizeState(args.state);
  const stamp = nowIso();
  for (const canonicalName of args.canonicalNames) {
    const key = canonicalName.trim();
    if (!key) {
      continue;
    }
    const existing = next.skills[key];
    next.skills[key] = {
      lastUsedAt: stamp,
      totalUses: (existing?.totalUses ?? 0) + 1,
    };
  }
  await writeText(args.path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function detectStaleSkills(args: {
  state: SkillTelemetryState;
  skills: SkillRecord[];
  thresholdDays: number;
  nowMs?: number;
}): string[] {
  const thresholdDays = Math.max(0, Math.floor(args.thresholdDays));
  if (thresholdDays === 0) {
    return [];
  }
  const nowMs = args.nowMs ?? Date.now();
  const cutoffMs = nowMs - thresholdDays * 24 * 60 * 60 * 1000;
  const stale: string[] = [];
  for (const skill of args.skills) {
    const entry = args.state.skills[skill.canonicalName];
    if (!entry) {
      stale.push(skill.canonicalName);
      continue;
    }
    const usedAt = Date.parse(entry.lastUsedAt);
    if (!Number.isFinite(usedAt) || usedAt < cutoffMs) {
      stale.push(skill.canonicalName);
    }
  }
  return stale.sort((left, right) => left.localeCompare(right));
}

export type { SkillTelemetryState };
