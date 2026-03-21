import { basename, dirname } from "node:path";
import type { SkillDiagnostic } from "../domain/types";

interface ParsedFrontmatter {
  name?: string;
  namespace?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
}

export interface ParsedSkillMetadata {
  name: string;
  localName: string;
  namespace: string | null;
  canonicalName: string;
  description: string;
  disableModelInvocation: boolean;
}

export interface ParsedSkillDocumentResult {
  metadata: ParsedSkillMetadata | null;
  diagnostics: SkillDiagnostic[];
}

function normalizeText(input: string): string {
  return input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function splitFrontmatter(input: string): {
  frontmatter: string | null;
  body: string;
  malformed: boolean;
} {
  const normalized = normalizeText(input);
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: null, body: normalized, malformed: false };
  }
  const closeIndex = normalized.indexOf("\n---", 4);
  if (closeIndex === -1) {
    return { frontmatter: null, body: normalized, malformed: true };
  }
  const frontmatter = normalized.slice(4, closeIndex);
  const bodyStart = closeIndex + "\n---".length + 1;
  return {
    frontmatter,
    body: normalized.slice(bodyStart),
    malformed: false,
  };
}

function parseValue(raw: string): string | boolean {
  const trimmed = raw.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function parseFrontmatterLines(head: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = {};
  for (const line of head.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = parseValue(trimmed.slice(separator + 1));
    if (key === "name" && typeof value === "string" && value.trim()) {
      result.name = value.trim();
      continue;
    }
    if (key === "namespace" && typeof value === "string" && value.trim()) {
      result.namespace = value.trim();
      continue;
    }
    if (
      key === "description" &&
      typeof value === "string" &&
      value.trim().length > 0
    ) {
      result.description = value.trim();
      continue;
    }
    if (key === "disable-model-invocation" && typeof value === "boolean") {
      result["disable-model-invocation"] = value;
    }
  }
  return result;
}

function firstBodyDescription(body: string): string {
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("```")) {
      continue;
    }
    return trimmed;
  }
  return "";
}

function splitCanonicalName(value: string): {
  namespace: string | null;
  localName: string;
} {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(":");
  if (separator === -1) {
    return {
      namespace: null,
      localName: trimmed,
    };
  }
  const namespace = trimmed.slice(0, separator).trim();
  const localName = trimmed.slice(separator + 1).trim();
  return {
    namespace: namespace || null,
    localName,
  };
}

const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;

export function parseSkillDocument(args: {
  filePath: string;
  content: string;
}): ParsedSkillDocumentResult {
  const diagnostics: SkillDiagnostic[] = [];
  const { frontmatter, body, malformed } = splitFrontmatter(args.content);
  if (malformed) {
    diagnostics.push({
      type: "warning",
      message: "Malformed frontmatter; missing closing --- marker.",
      path: args.filePath,
    });
  }
  if (!frontmatter) {
    diagnostics.push({
      type: "warning",
      message: "Skill file missing frontmatter; fallback metadata extraction applied.",
      path: args.filePath,
    });
  }

  const parsed = frontmatter ? parseFrontmatterLines(frontmatter) : {};
  const parentDir = basename(dirname(args.filePath));
  const declaredName = (parsed.name ?? parentDir).trim();
  const explicit = splitCanonicalName(declaredName);
  const namespace = parsed.namespace?.trim() || explicit.namespace;
  const localName = explicit.localName || parentDir;
  const canonicalName = namespace ? `${namespace}:${localName}` : localName;
  const description =
    parsed.description?.trim() || firstBodyDescription(body).trim();

  if (!description) {
    diagnostics.push({
      type: "warning",
      message: "Skill description is missing; skill ignored.",
      path: args.filePath,
    });
    return {
      metadata: null,
      diagnostics,
    };
  }

  if (parentDir !== localName) {
    diagnostics.push({
      type: "warning",
      message: `Skill name "${localName}" does not match parent directory "${parentDir}".`,
      path: args.filePath,
    });
  }
  if (!SKILL_NAME_PATTERN.test(localName)) {
    diagnostics.push({
      type: "warning",
      message:
        "Skill local name should use lowercase letters, numbers, and hyphens only.",
      path: args.filePath,
    });
  }
  if (namespace && !SKILL_NAME_PATTERN.test(namespace)) {
    diagnostics.push({
      type: "warning",
      message:
        "Skill namespace should use lowercase letters, numbers, and hyphens only.",
      path: args.filePath,
    });
  }

  return {
    metadata: {
      name: declaredName,
      localName,
      namespace: namespace || null,
      canonicalName,
      description,
      disableModelInvocation: parsed["disable-model-invocation"] === true,
    },
    diagnostics,
  };
}
