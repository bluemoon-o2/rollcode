import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReleaseNotesRecord,
  compareVersionDesc,
  ensureReleaseEntry,
  parseChangelogMarkdown,
} from "../src/changelog";

function toBaseVersion(version: string): string {
  return version.split("-")[0] ?? version;
}

function escapeTemplateLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

function renderReleaseNotesSource(releaseNotes: Record<string, string>): string {
  const versions = Object.keys(releaseNotes).sort(compareVersionDesc);
  const entries = versions
    .map((version) => {
      const value = releaseNotes[version];
      if (!value) {
        return "";
      }
      return `  "${version}": \`${escapeTemplateLiteral(value)}\`,`;
    })
    .filter(Boolean)
    .join("\n");

  return `import type { StateStore } from "./state/store";
import { getBaseVersion, getVersion } from "./version";

const LAST_SEEN_RELEASE_NOTES_VERSION = "lastSeenReleaseNotesVersion";

export const releaseNotes: Record<string, string> = {
${entries}
};

export function getReleaseNotes(baseVersion: string): string | null {
  return releaseNotes[baseVersion] ?? null;
}

export async function checkReleaseNotes(
  store: StateStore,
): Promise<string | null> {
  if (process.env.ROLLCODE_AGENT_ROLE === "subagent") {
    return null;
  }

  const baseVersion = getBaseVersion(getVersion());
  const notes = getReleaseNotes(baseVersion);
  if (!notes) {
    return null;
  }

  if (process.env.ROLLCODE_SHOW_RELEASE_NOTES === "1") {
    return notes;
  }

  const lastSeen = store.getSetting(LAST_SEEN_RELEASE_NOTES_VERSION);
  if (lastSeen && getBaseVersion(lastSeen) === baseVersion) {
    return null;
  }

  store.setSetting(LAST_SEEN_RELEASE_NOTES_VERSION, baseVersion);
  return notes;
}
`;
}

function getRepoRoot(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(scriptDir, "..");
}

function readCurrentBaseVersion(packageJsonPath: string): string {
  const packageJsonRaw = readFileSync(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageJsonRaw) as { version?: string };
  const version = packageJson.version?.trim() ?? "";
  if (!version) {
    throw new Error("package.json is missing a valid version.");
  }
  return toBaseVersion(version);
}

function syncReleaseNotes(): void {
  const root = getRepoRoot();
  const packageJsonPath = resolve(root, "package.json");
  const changelogPath = resolve(root, "CHANGELOG.md");
  const releaseNotesPath = resolve(root, "src/release-notes.ts");

  const currentBaseVersion = readCurrentBaseVersion(packageJsonPath);
  const changelogMarkdown = readFileSync(changelogPath, "utf8");
  const changelogEntries = parseChangelogMarkdown(changelogMarkdown);

  ensureReleaseEntry(changelogEntries, currentBaseVersion);
  const releaseNotes = buildReleaseNotesRecord(changelogEntries);
  const source = renderReleaseNotesSource(releaseNotes);

  const existing = readFileSync(releaseNotesPath, "utf8");
  if (existing !== source) {
    writeFileSync(releaseNotesPath, source, "utf8");
    console.log(
      `release-notes sync: updated src/release-notes.ts from CHANGELOG.md (current ${currentBaseVersion})`,
    );
    return;
  }

  console.log(
    `release-notes sync: src/release-notes.ts already up to date (current ${currentBaseVersion})`,
  );
}

try {
  syncReleaseNotes();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`release-notes sync failed: ${message}`);
  process.exit(1);
}
