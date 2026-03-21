export interface ChangelogEntry {
  version: string;
  baseVersion: string;
  date: string | null;
  body: string;
}

const VERSION_SECTION_RE =
  /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?:\s*-\s*(.+))?\s*$/;

function toBaseVersion(version: string): string {
  return version.split("-")[0] ?? version;
}

function normalizeDate(value: string | undefined): string | null {
  const date = value?.trim() ?? "";
  return date.length > 0 ? date : null;
}

function pushEntry(
  entries: ChangelogEntry[],
  current: Omit<ChangelogEntry, "body">,
  bodyLines: string[],
): void {
  entries.push({
    ...current,
    body: bodyLines.join("\n").trim(),
  });
}

function parseVersion(version: string): [number, number, number] {
  const [major, minor, patch] = version.split(".");
  return [
    Number.parseInt(major ?? "0", 10) || 0,
    Number.parseInt(minor ?? "0", 10) || 0,
    Number.parseInt(patch ?? "0", 10) || 0,
  ];
}

export function compareVersionDesc(left: string, right: string): number {
  const [lMajor, lMinor, lPatch] = parseVersion(left);
  const [rMajor, rMinor, rPatch] = parseVersion(right);
  if (lMajor !== rMajor) {
    return rMajor - lMajor;
  }
  if (lMinor !== rMinor) {
    return rMinor - lMinor;
  }
  return rPatch - lPatch;
}

export function parseChangelogMarkdown(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: Omit<ChangelogEntry, "body"> | null = null;
  let bodyLines: string[] = [];

  for (const line of markdown.replace(/\r/g, "").split("\n")) {
    const match = line.match(VERSION_SECTION_RE);
    if (match) {
      if (current) {
        pushEntry(entries, current, bodyLines);
      }

      const version = match[1] ?? "";
      current = {
        version,
        baseVersion: toBaseVersion(version),
        date: normalizeDate(match[2]),
      };
      bodyLines = [];
      continue;
    }

    if (current) {
      bodyLines.push(line);
    }
  }

  if (current) {
    pushEntry(entries, current, bodyLines);
  }

  if (entries.length === 0) {
    throw new Error(
      "CHANGELOG.md does not contain any version sections. Expected `## [x.y.z] - YYYY-MM-DD`.",
    );
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.baseVersion)) {
      throw new Error(
        `CHANGELOG.md contains duplicate sections for base version ${entry.baseVersion}.`,
      );
    }
    seen.add(entry.baseVersion);
  }

  return entries;
}

export function ensureReleaseEntry(
  entries: ChangelogEntry[],
  currentBaseVersion: string,
): ChangelogEntry {
  const entry = entries.find(
    (candidate) => candidate.baseVersion === currentBaseVersion,
  );
  if (!entry) {
    throw new Error(
      `CHANGELOG.md is missing section for current version ${currentBaseVersion}.`,
    );
  }
  if (!entry.body.trim()) {
    throw new Error(
      `CHANGELOG.md section ${currentBaseVersion} must include at least one change line.`,
    );
  }
  return entry;
}

export function buildReleaseNotesRecord(
  entries: ChangelogEntry[],
): Record<string, string> {
  const releaseNotes: Record<string, string> = {};
  const sortedEntries = [...entries].sort((left, right) =>
    compareVersionDesc(left.baseVersion, right.baseVersion),
  );

  for (const entry of sortedEntries) {
    const lines = [`RollCode ${entry.baseVersion}`];
    if (entry.date) {
      lines.push(`date: ${entry.date}`);
    }
    if (entry.body) {
      lines.push(entry.body);
    }
    releaseNotes[entry.baseVersion] = lines.join("\n");
  }

  return releaseNotes;
}
