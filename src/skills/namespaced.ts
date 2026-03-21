import type {
  SkillDiagnostic,
  SkillRecord,
  SkillResolutionMethod,
} from "../domain/types";

export interface SkillResolutionContext {
  callerNamespace?: string | null;
}

export interface SkillResolutionResultBase {
  requestedName: string;
  resolution: SkillResolutionMethod;
}

export interface SkillCanonicalResolution extends SkillResolutionResultBase {
  resolution: "canonical";
  skill: SkillRecord;
}

export interface SkillAliasResolution extends SkillResolutionResultBase {
  resolution: "alias";
  skill: SkillRecord;
  alias: string;
  canonicalName: string;
}

export interface SkillLocalFirstResolution extends SkillResolutionResultBase {
  resolution: "local-first";
  skill: SkillRecord;
  matchedNamespace: string;
}

export interface SkillShorthandResolution extends SkillResolutionResultBase {
  resolution: "shorthand";
  skill: SkillRecord;
}

export interface SkillAmbiguousResolution extends SkillResolutionResultBase {
  resolution: "ambiguous";
  candidates: SkillRecord[];
}

export interface SkillNotFoundResolution extends SkillResolutionResultBase {
  resolution: "not-found";
}

export type SkillResolutionResult =
  | SkillCanonicalResolution
  | SkillAliasResolution
  | SkillLocalFirstResolution
  | SkillShorthandResolution
  | SkillAmbiguousResolution
  | SkillNotFoundResolution;

export interface AliasRegistrationResult {
  success: boolean;
  reason?: "canonical-not-found" | "shadows-canonical" | "duplicate-alias";
}

export class NamespacedSkillRegistry {
  private readonly byCanonical = new Map<string, SkillRecord>();
  private readonly aliases = new Map<string, string>();
  private readonly diagnostics: SkillDiagnostic[] = [];

  register(skill: SkillRecord): SkillDiagnostic | null {
    const existing = this.byCanonical.get(skill.canonicalName);
    if (existing) {
      const diagnostic: SkillDiagnostic = {
        type: "collision",
        message: `skill canonical name collision: ${skill.canonicalName}`,
        path: skill.path,
        collision: {
          canonicalName: skill.canonicalName,
          winnerPath: existing.path,
          loserPath: skill.path,
          winnerSource: existing.source,
          loserSource: skill.source,
        },
      };
      this.diagnostics.push(diagnostic);
      return diagnostic;
    }
    this.byCanonical.set(skill.canonicalName, skill);
    return null;
  }

  registerAlias(alias: string, canonicalName: string): AliasRegistrationResult {
    const normalizedAlias = alias.trim();
    if (!normalizedAlias) {
      return { success: false, reason: "canonical-not-found" };
    }
    if (!this.byCanonical.has(canonicalName)) {
      return { success: false, reason: "canonical-not-found" };
    }
    if (this.byCanonical.has(normalizedAlias)) {
      return { success: false, reason: "shadows-canonical" };
    }
    const existing = this.aliases.get(normalizedAlias);
    if (existing && existing !== canonicalName) {
      return { success: false, reason: "duplicate-alias" };
    }
    this.aliases.set(normalizedAlias, canonicalName);
    return { success: true };
  }

  resolveAlias(alias: string): string | null {
    return this.aliases.get(alias) ?? null;
  }

  getByCanonical(canonicalName: string): SkillRecord | null {
    return this.byCanonical.get(canonicalName) ?? null;
  }

  getAll(): SkillRecord[] {
    return [...this.byCanonical.values()];
  }

  getByNamespace(namespace: string): SkillRecord[] {
    return this.getAll().filter((skill) => skill.namespace === namespace);
  }

  getDiagnostics(): SkillDiagnostic[] {
    return [...this.diagnostics];
  }
}

export class NamespacedSkillResolver {
  constructor(private readonly registry: NamespacedSkillRegistry) {}

  resolve(
    name: string,
    context?: SkillResolutionContext,
  ): SkillResolutionResult {
    const requestedName = name;
    const normalized = name.trim();
    if (!normalized) {
      return { requestedName, resolution: "not-found" };
    }

    if (normalized.includes(":")) {
      const skill = this.registry.getByCanonical(normalized);
      if (skill) {
        return { requestedName, resolution: "canonical", skill };
      }
      return { requestedName, resolution: "not-found" };
    }

    const aliasTarget = this.registry.resolveAlias(normalized);
    if (aliasTarget) {
      const skill = this.registry.getByCanonical(aliasTarget);
      if (skill) {
        return {
          requestedName,
          resolution: "alias",
          skill,
          alias: normalized,
          canonicalName: aliasTarget,
        };
      }
    }

    if (context?.callerNamespace) {
      const localCanonical = `${context.callerNamespace}:${normalized}`;
      const local = this.registry.getByCanonical(localCanonical);
      if (local) {
        return {
          requestedName,
          resolution: "local-first",
          skill: local,
          matchedNamespace: context.callerNamespace,
        };
      }
    }

    const candidates = this.registry
      .getAll()
      .filter((skill) => skill.localName === normalized || skill.name === normalized);
    if (candidates.length === 0) {
      return { requestedName, resolution: "not-found" };
    }
    if (candidates.length === 1) {
      return {
        requestedName,
        resolution: "shorthand",
        skill: candidates[0] as SkillRecord,
      };
    }
    return {
      requestedName,
      resolution: "ambiguous",
      candidates,
    };
  }
}

