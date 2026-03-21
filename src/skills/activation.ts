import type {
  SkillPreferences,
  SkillRecord,
  TurnPlanStep,
} from "../domain/types";
import type { SkillResolutionContext } from "./namespaced";
import { NamespacedSkillResolver } from "./namespaced";
import { resolveSkillReference } from "./preferences";

export interface SkillActivationPlan {
  activatedSkills: SkillRecord[];
  unresolvedRefs: string[];
  avoidedSkills: string[];
  reason: string;
}

function tokenizeSkillContext(...parts: Array<string | null | undefined>): Set<string> {
  const tokens = new Set<string>();
  const add = (value: string): void => {
    const normalized = value.toLowerCase().trim();
    if (!normalized || normalized.length < 3) {
      return;
    }
    tokens.add(normalized);
    tokens.add(normalized.replace(/[-_]+/g, " "));
    tokens.add(normalized.replace(/\s+/g, ""));
  };

  for (const part of parts) {
    if (!part) {
      continue;
    }
    const text = part.toLowerCase();
    const matches = text.match(/[a-z0-9][a-z0-9+.#/_-]{1,}/g) ?? [];
    for (const match of matches) {
      add(match);
      for (const piece of match.split(/[^a-z0-9+.#]+/g)) {
        add(piece);
      }
    }
  }
  return tokens;
}

function skillMatchesContext(skill: SkillRecord, contextTokens: Set<string>): boolean {
  const haystacks = [
    skill.name.toLowerCase(),
    skill.localName.toLowerCase(),
    skill.canonicalName.toLowerCase(),
    skill.description.toLowerCase(),
  ];
  for (const token of contextTokens) {
    if (token.length < 3) {
      continue;
    }
    if (haystacks.some((haystack) => haystack.includes(token))) {
      return true;
    }
  }
  return false;
}

function ruleMatchesContext(when: string, contextTokens: Set<string>): boolean {
  const whenTokens = tokenizeSkillContext(when);
  for (const token of whenTokens) {
    if (
      contextTokens.has(token) ||
      [...contextTokens].some((contextToken) =>
        contextToken.includes(token) || token.includes(contextToken),
      )
    ) {
      return true;
    }
  }
  return false;
}

function resolveRefBatch(args: {
  refs: string[];
  skills: SkillRecord[];
  resolver: NamespacedSkillResolver;
  context?: SkillResolutionContext;
}): {
  resolved: SkillRecord[];
  unresolved: string[];
} {
  const resolved: SkillRecord[] = [];
  const unresolved: string[] = [];
  for (const ref of args.refs) {
    const resolution = resolveSkillReference({
      ref,
      skills: args.skills,
      resolver: args.resolver,
      context: args.context,
    });
    if (resolution.skill) {
      resolved.push(resolution.skill);
      continue;
    }
    unresolved.push(
      resolution.method === "ambiguous"
        ? `${ref} (ambiguous: ${resolution.candidates
            .map((candidate) => candidate.canonicalName)
            .join(", ")})`
        : ref,
    );
  }
  return { resolved, unresolved };
}

function planContext(plan: TurnPlanStep[]): string {
  if (plan.length === 0) {
    return "";
  }
  return plan
    .map((step) => `${step.status}:${step.step}`)
    .join(" | ");
}

export function buildSkillActivationPlan(args: {
  skills: SkillRecord[];
  resolver: NamespacedSkillResolver;
  preferences: SkillPreferences;
  goal: string;
  pendingInstruction: string | null;
  plan: TurnPlanStep[];
  context?: SkillResolutionContext;
}): SkillActivationPlan {
  const contextTokens = tokenizeSkillContext(
    args.goal,
    args.pendingInstruction,
    planContext(args.plan),
  );
  const unresolvedRefs: string[] = [];

  const includeSet = new Map<string, SkillRecord>();
  const avoidSet = new Map<string, SkillRecord>();

  const resolvedAlways = resolveRefBatch({
    refs: args.preferences.always_use_skills,
    skills: args.skills,
    resolver: args.resolver,
    context: args.context,
  });
  unresolvedRefs.push(...resolvedAlways.unresolved);
  for (const skill of resolvedAlways.resolved) {
    includeSet.set(skill.canonicalName, skill);
  }

  const resolvedAvoid = resolveRefBatch({
    refs: args.preferences.avoid_skills,
    skills: args.skills,
    resolver: args.resolver,
    context: args.context,
  });
  unresolvedRefs.push(...resolvedAvoid.unresolved);
  for (const skill of resolvedAvoid.resolved) {
    avoidSet.set(skill.canonicalName, skill);
  }

  for (const rule of args.preferences.skill_rules) {
    if (!ruleMatchesContext(rule.when, contextTokens)) {
      continue;
    }
    const includeRefs = [...(rule.use ?? []), ...(rule.prefer ?? [])];
    const resolvedInclude = resolveRefBatch({
      refs: includeRefs,
      skills: args.skills,
      resolver: args.resolver,
      context: args.context,
    });
    unresolvedRefs.push(...resolvedInclude.unresolved);
    for (const skill of resolvedInclude.resolved) {
      includeSet.set(skill.canonicalName, skill);
    }

    const resolvedRuleAvoid = resolveRefBatch({
      refs: rule.avoid ?? [],
      skills: args.skills,
      resolver: args.resolver,
      context: args.context,
    });
    unresolvedRefs.push(...resolvedRuleAvoid.unresolved);
    for (const skill of resolvedRuleAvoid.resolved) {
      avoidSet.set(skill.canonicalName, skill);
    }
  }

  const preferred = resolveRefBatch({
    refs: args.preferences.prefer_skills,
    skills: args.skills,
    resolver: args.resolver,
    context: args.context,
  });
  unresolvedRefs.push(...preferred.unresolved);
  for (const skill of preferred.resolved) {
    if (skillMatchesContext(skill, contextTokens)) {
      includeSet.set(skill.canonicalName, skill);
    }
  }

  for (const skill of args.skills) {
    if (skill.disableModelInvocation) {
      continue;
    }
    if (skillMatchesContext(skill, contextTokens)) {
      includeSet.set(skill.canonicalName, skill);
    }
  }

  const activatedSkills = [...includeSet.values()]
    .filter((skill) => !avoidSet.has(skill.canonicalName))
    .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName));
  const avoidedSkills = [...avoidSet.values()]
    .map((skill) => skill.canonicalName)
    .sort((left, right) => left.localeCompare(right));

  let reason = "activation: no relevant skills matched";
  if (activatedSkills.length > 0) {
    reason = `activation: ${activatedSkills.length} skills matched context`;
  } else if (avoidSet.size > 0) {
    reason = "activation: candidates suppressed by avoid rules";
  }
  return {
    activatedSkills,
    unresolvedRefs: [...new Set(unresolvedRefs)],
    avoidedSkills,
    reason,
  };
}

