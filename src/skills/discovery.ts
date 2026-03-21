import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import {
  getAgentSkillsDir,
  getBundledSkillsDir,
  getGlobalSkillsDir,
  PROJECT_SKILLS_DIR_NAME,
} from "../config";
import type {
  SkillDiagnostic,
  SkillDiscoveryResult,
  SkillRecord,
  SkillSource,
} from "../domain/types";
import { listFilesRecursive, pathExists, readTextIfExists } from "../utils/fs";
import { sanitizeSegment } from "../utils/id";
import { discoverMarketplaceSkillRoots } from "./marketplace";
import { NamespacedSkillRegistry } from "./namespaced";
import { parseSkillDocument } from "./parser";

const SOURCE_ORDER: SkillSource[] = ["bundled", "global", "agent", "project"];

const SOURCE_PRIORITY: Record<SkillSource, number> = {
  bundled: 0,
  global: 1,
  agent: 2,
  project: 3,
};

interface RawDiscoveryResult {
  skills: SkillRecord[];
  diagnostics: SkillDiagnostic[];
  fingerprints: string[];
}

function computeFingerprint(input: string[]): string {
  const normalized = [...new Set(input)].sort();
  return createHash("sha256")
    .update(normalized.join("\n"))
    .digest("hex");
}

function inferNamespaceFromRelativePath(
  relativeDir: string,
  localName: string,
): string | null {
  const segments = relativeDir
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  const candidate = segments[0] as string;
  if (!candidate || candidate === localName) {
    return null;
  }
  return sanitizeSegment(candidate);
}

async function discoverSkillsFromRoot(
  rootPath: string,
  source: SkillSource,
): Promise<RawDiscoveryResult> {
  if (!(await pathExists(rootPath))) {
    return {
      skills: [],
      diagnostics: [],
      fingerprints: [],
    };
  }
  const allFiles = await listFilesRecursive(rootPath, {
    ignoreDirectories: ["node_modules"],
    ignoreHiddenDirectories: true,
  });
  const skillFiles = allFiles
    .filter((file) => file.endsWith("SKILL.md"))
    .sort();

  const diagnostics: SkillDiagnostic[] = [];
  const skills: SkillRecord[] = [];
  const fingerprints: string[] = [];

  for (const skillFile of skillFiles) {
    const markdown = (await readTextIfExists(skillFile)) ?? "";
    const parsed = parseSkillDocument({
      filePath: skillFile,
      content: markdown,
    });
    diagnostics.push(...parsed.diagnostics);
    if (!parsed.metadata) {
      continue;
    }
    const skillDir = dirname(skillFile);
    const relativeId = relative(rootPath, skillDir).replace(/\\/g, "/");
    const implicitNamespace =
      parsed.metadata.namespace === null
        ? inferNamespaceFromRelativePath(relativeId, parsed.metadata.localName)
        : null;
    const namespace = parsed.metadata.namespace ?? implicitNamespace;
    const canonicalName = namespace
      ? `${namespace}:${parsed.metadata.localName}`
      : parsed.metadata.localName;

    const skill: SkillRecord = {
      id: sanitizeSegment(relativeId || relative(rootPath, skillFile) || "skill"),
      name: parsed.metadata.name,
      localName: parsed.metadata.localName,
      canonicalName,
      namespace: namespace ?? null,
      description: parsed.metadata.description,
      source,
      path: skillFile,
      rootPath,
      disableModelInvocation: parsed.metadata.disableModelInvocation,
    };
    skills.push(skill);
    fingerprints.push(
      `${skill.source}:${skill.path}:${createHash("sha1").update(markdown).digest("hex")}`,
    );
  }

  return {
    skills,
    diagnostics,
    fingerprints,
  };
}

function sortForRegistryPrecedence(skills: SkillRecord[]): SkillRecord[] {
  return [...skills].sort((left, right) => {
    const priorityDelta = SOURCE_PRIORITY[right.source] - SOURCE_PRIORITY[left.source];
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return left.path.localeCompare(right.path);
  });
}

function applyCanonicalRegistry(skills: SkillRecord[]): {
  skills: SkillRecord[];
  diagnostics: SkillDiagnostic[];
} {
  const registry = new NamespacedSkillRegistry();
  const seenSourcePath = new Set<string>();
  for (const skill of sortForRegistryPrecedence(skills)) {
    const sourcePathKey = `${skill.source}:${skill.path}`;
    if (seenSourcePath.has(sourcePathKey)) {
      continue;
    }
    seenSourcePath.add(sourcePathKey);
    registry.register(skill);
  }
  const deduped = registry.getAll().sort((left, right) => {
    const sourceDelta =
      SOURCE_ORDER.indexOf(right.source) - SOURCE_ORDER.indexOf(left.source);
    if (sourceDelta !== 0) {
      return sourceDelta;
    }
    return left.canonicalName.localeCompare(right.canonicalName);
  });
  return {
    skills: deduped,
    diagnostics: registry.getDiagnostics(),
  };
}

export async function discoverSkillsDetailed(
  cwd: string,
  agentId: string,
): Promise<SkillDiscoveryResult> {
  const roots: Array<{ source: SkillSource; rootPath: string }> = [
    { source: "bundled", rootPath: getBundledSkillsDir() },
    { source: "global", rootPath: getGlobalSkillsDir() },
    { source: "agent", rootPath: getAgentSkillsDir(agentId) },
    { source: "project", rootPath: join(cwd, PROJECT_SKILLS_DIR_NAME) },
  ];

  const allDiagnostics: SkillDiagnostic[] = [];
  const allFingerprints: string[] = [];
  const staged: SkillRecord[] = [];
  const seenRoots = new Set<string>();

  const addRootIfMissing = (source: SkillSource, rootPath: string): boolean => {
    const key = `${source}:${rootPath.replace(/\\/g, "/")}`;
    if (seenRoots.has(key)) {
      return false;
    }
    seenRoots.add(key);
    return true;
  };

  for (const { source, rootPath } of roots) {
    if (!addRootIfMissing(source, rootPath)) {
      continue;
    }
    const discovered = await discoverSkillsFromRoot(rootPath, source);
    allDiagnostics.push(...discovered.diagnostics);
    allFingerprints.push(...discovered.fingerprints);
    staged.push(...discovered.skills);

    const marketplace = await discoverMarketplaceSkillRoots({
      rootPath,
      source,
    });
    allDiagnostics.push(...marketplace.diagnostics);
    allFingerprints.push(...marketplace.fingerprints);

    for (const marketplaceRoot of marketplace.skillRoots) {
      if (!addRootIfMissing(source, marketplaceRoot)) {
        continue;
      }
      const discoveredMarketplaceRoot = await discoverSkillsFromRoot(
        marketplaceRoot,
        source,
      );
      allDiagnostics.push(...discoveredMarketplaceRoot.diagnostics);
      allFingerprints.push(...discoveredMarketplaceRoot.fingerprints);
      staged.push(...discoveredMarketplaceRoot.skills);
    }
  }

  const registryResult = applyCanonicalRegistry(staged);
  return {
    skills: registryResult.skills,
    diagnostics: [...allDiagnostics, ...registryResult.diagnostics],
    fingerprint: computeFingerprint([
      ...allFingerprints,
      ...registryResult.skills.map(
        (skill) => `${skill.canonicalName}|${skill.source}|${skill.path}`,
      ),
    ]),
  };
}
