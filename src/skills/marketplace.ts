import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SkillDiagnostic, SkillSource } from "../domain/types";
import { readTextIfExists } from "../utils/fs";

interface MarketplacePluginEntry {
  name?: unknown;
  source?: unknown;
}

interface MarketplaceManifest {
  plugins?: unknown;
}

export interface MarketplaceSkillRootsResult {
  skillRoots: string[];
  diagnostics: SkillDiagnostic[];
  fingerprints: string[];
}

function emptyResult(): MarketplaceSkillRootsResult {
  return {
    skillRoots: [],
    diagnostics: [],
    fingerprints: [],
  };
}

function isExternalSource(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("git@") ||
    normalized.includes("://")
  ) {
    return true;
  }
  if (normalized === "github" || normalized === "git" || normalized === "url") {
    return true;
  }
  return false;
}

function normalizeLocalPluginSource(source: unknown): string | null {
  if (typeof source === "string") {
    if (isExternalSource(source)) {
      return null;
    }
    return source.trim().replace(/^[.][\\/]/, "");
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }
  const record = source as Record<string, unknown>;
  if (typeof record.path === "string" && !isExternalSource(record.path)) {
    return record.path.trim().replace(/^[.][\\/]/, "");
  }
  if (typeof record.source === "string" && !isExternalSource(record.source)) {
    return record.source.trim().replace(/^[.][\\/]/, "");
  }
  return null;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function discoverMarketplaceSkillRoots(args: {
  rootPath: string;
  source: SkillSource;
}): Promise<MarketplaceSkillRootsResult> {
  const manifestPath = join(args.rootPath, ".claude-plugin", "marketplace.json");
  const manifestText = await readTextIfExists(manifestPath);
  if (!manifestText) {
    return emptyResult();
  }

  const diagnostics: SkillDiagnostic[] = [];
  const fingerprints = [
    `marketplace:${manifestPath}:${createHash("sha1").update(manifestText).digest("hex")}`,
  ];
  let manifest: MarketplaceManifest;
  try {
    manifest = JSON.parse(manifestText) as MarketplaceManifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push({
      type: "warning",
      message: `Failed to parse marketplace.json (${args.source}): ${message}`,
      path: manifestPath,
    });
    return {
      skillRoots: [],
      diagnostics,
      fingerprints,
    };
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    diagnostics.push({
      type: "warning",
      message: "Invalid marketplace manifest; expected JSON object.",
      path: manifestPath,
    });
    return {
      skillRoots: [],
      diagnostics,
      fingerprints,
    };
  }

  if (!Array.isArray(manifest.plugins)) {
    diagnostics.push({
      type: "warning",
      message: "Invalid marketplace manifest; missing plugins array.",
      path: manifestPath,
    });
    return {
      skillRoots: [],
      diagnostics,
      fingerprints,
    };
  }

  const roots: string[] = [];
  for (let index = 0; index < manifest.plugins.length; index += 1) {
    const entry = manifest.plugins[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.push({
        type: "warning",
        message: `Invalid marketplace plugin entry at index ${index}.`,
        path: manifestPath,
      });
      continue;
    }
    const plugin = entry as MarketplacePluginEntry;
    const pluginName =
      typeof plugin.name === "string" && plugin.name.trim()
        ? plugin.name.trim()
        : `plugin-${index + 1}`;
    const localSource = normalizeLocalPluginSource(plugin.source);
    if (!localSource) {
      continue;
    }
    const pluginRoot = resolve(args.rootPath, localSource);
    if (!(await isDirectory(pluginRoot))) {
      diagnostics.push({
        type: "warning",
        message: `Marketplace plugin "${pluginName}" source path not found: ${localSource}`,
        path: manifestPath,
      });
      continue;
    }
    const skillsRoot = join(pluginRoot, "skills");
    if (!(await isDirectory(skillsRoot))) {
      continue;
    }
    roots.push(skillsRoot);
    fingerprints.push(`marketplace-plugin:${pluginName}:${skillsRoot}`);
  }

  return {
    skillRoots: [...new Set(roots)].sort((left, right) =>
      left.localeCompare(right),
    ),
    diagnostics,
    fingerprints,
  };
}
