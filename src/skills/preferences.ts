import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  getGlobalSkillPreferencesPath,
  getProjectSkillPreferencesPath,
} from "../config";
import type {
  SkillDiscoveryMode,
  SkillPreferences,
  SkillRecord,
  SkillResolutionMethod,
} from "../domain/types";
import { readTextIfExists } from "../utils/fs";
import type {
  SkillResolutionContext,
  SkillResolutionResult,
} from "./namespaced";
import { NamespacedSkillResolver } from "./namespaced";

interface SkillPreferencesPatch {
  always_use_skills?: unknown;
  prefer_skills?: unknown;
  avoid_skills?: unknown;
  skill_rules?: unknown;
  skill_aliases?: unknown;
  skill_discovery?: unknown;
  skill_staleness_days?: unknown;
}

export interface LoadedSkillPreferences {
  preferences: SkillPreferences;
  warnings: string[];
  loadedPaths: string[];
}

export interface SkillReferenceResolution {
  ref: string;
  method: SkillResolutionMethod;
  skill: SkillRecord | null;
  candidates: SkillRecord[];
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function normalizeSkillRules(value: unknown): SkillPreferences["skill_rules"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rules: SkillPreferences["skill_rules"] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.when !== "string" || !raw.when.trim()) {
      continue;
    }
    rules.push({
      when: raw.when.trim(),
      use: uniqueStrings(raw.use),
      prefer: uniqueStrings(raw.prefer),
      avoid: uniqueStrings(raw.avoid),
    });
  }
  return rules;
}

function normalizeAliasMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const map: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const alias = key.trim();
    const canonical = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!alias || !canonical) {
      continue;
    }
    map[alias] = canonical;
  }
  return map;
}

function normalizePatch(value: unknown): SkillPreferencesPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as SkillPreferencesPatch;
}

function normalizeSkillDiscoveryMode(
  value: unknown,
): SkillDiscoveryMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "suggest" ||
    normalized === "off"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeSkillStalenessDays(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

function emptyPreferences(): SkillPreferences {
  return {
    always_use_skills: [],
    prefer_skills: [],
    avoid_skills: [],
    skill_rules: [],
    skill_aliases: {},
    skill_discovery: undefined,
    skill_staleness_days: undefined,
  };
}

function mergePreferences(
  base: SkillPreferences,
  patch: SkillPreferencesPatch,
): SkillPreferences {
  const merged: SkillPreferences = {
    always_use_skills: [
      ...base.always_use_skills,
      ...uniqueStrings(patch.always_use_skills),
    ],
    prefer_skills: [...base.prefer_skills, ...uniqueStrings(patch.prefer_skills)],
    avoid_skills: [...base.avoid_skills, ...uniqueStrings(patch.avoid_skills)],
    skill_rules: [...base.skill_rules, ...normalizeSkillRules(patch.skill_rules)],
    skill_aliases: {
      ...base.skill_aliases,
      ...normalizeAliasMap(patch.skill_aliases),
    },
    skill_discovery:
      normalizeSkillDiscoveryMode(patch.skill_discovery) ??
      base.skill_discovery,
    skill_staleness_days:
      normalizeSkillStalenessDays(patch.skill_staleness_days) ??
      base.skill_staleness_days,
  };
  return {
    ...merged,
    always_use_skills: uniqueStrings(merged.always_use_skills),
    prefer_skills: uniqueStrings(merged.prefer_skills),
    avoid_skills: uniqueStrings(merged.avoid_skills),
  };
}

async function readPreferencesFile(path: string): Promise<{
  patch: SkillPreferencesPatch;
  warning: string | null;
}> {
  const content = await readTextIfExists(path);
  if (!content) {
    return { patch: {}, warning: null };
  }
  try {
    return {
      patch: normalizePatch(JSON.parse(content)),
      warning: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      patch: {},
      warning: `Failed to parse skill preferences (${path}): ${message}`,
    };
  }
}

function expandPathRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function isAbsoluteRef(ref: string): boolean {
  return isAbsolute(expandPathRef(ref));
}

function resolvePathRef(ref: string): string {
  const expanded = expandPathRef(ref);
  if (expanded.endsWith("/SKILL.md") || expanded.endsWith("\\SKILL.md")) {
    return resolve(expanded);
  }
  return resolve(expanded, "SKILL.md");
}

function matchSkillByPathRef(ref: string, skills: SkillRecord[]): SkillRecord | null {
  const target = resolvePathRef(ref);
  for (const skill of skills) {
    const skillPaths = [skill.path, skill.mirroredSkillPath].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (skillPaths.some((path) => resolve(path) === target)) {
      return skill;
    }
  }
  return null;
}

function resolutionToMethod(result: SkillResolutionResult): SkillResolutionMethod {
  return result.resolution;
}

export async function loadSkillPreferences(
  cwd: string,
): Promise<LoadedSkillPreferences> {
  const warnings: string[] = [];
  const loadedPaths: string[] = [];
  const globalPath = getGlobalSkillPreferencesPath();
  const projectPath = getProjectSkillPreferencesPath(cwd);
  let merged = emptyPreferences();
  for (const path of [globalPath, projectPath]) {
    const { patch, warning } = await readPreferencesFile(path);
    if (warning) {
      warnings.push(warning);
    }
    if (Object.keys(patch).length > 0) {
      loadedPaths.push(path);
      merged = mergePreferences(merged, patch);
    }
  }
  return {
    preferences: merged,
    warnings,
    loadedPaths,
  };
}

export function resolveSkillReference(args: {
  ref: string;
  skills: SkillRecord[];
  resolver: NamespacedSkillResolver;
  context?: SkillResolutionContext;
}): SkillReferenceResolution {
  const ref = args.ref.trim();
  if (!ref) {
    return {
      ref,
      method: "not-found",
      skill: null,
      candidates: [],
    };
  }
  if (isAbsoluteRef(ref)) {
    const skill = matchSkillByPathRef(ref, args.skills);
    return {
      ref,
      method: skill ? "canonical" : "not-found",
      skill,
      candidates: [],
    };
  }

  const result = args.resolver.resolve(ref, args.context);
  if (result.resolution === "ambiguous") {
    return {
      ref,
      method: "ambiguous",
      skill: null,
      candidates: result.candidates,
    };
  }
  if (result.resolution === "not-found") {
    return {
      ref,
      method: "not-found",
      skill: null,
      candidates: [],
    };
  }
  return {
    ref,
    method: resolutionToMethod(result),
    skill: result.skill,
    candidates: [],
  };
}
