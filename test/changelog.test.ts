import { describe, expect, test } from "bun:test";
import {
  buildReleaseNotesRecord,
  ensureReleaseEntry,
  parseChangelogMarkdown,
} from "../src/changelog";

const sampleChangelog = `# Changelog

## [0.0.2] - 2026-03-22

- Added release gating.
- Added changelog sync.

## [0.0.1] - 2026-03-20

- Initial release.
`;

describe("changelog parsing and release-note conversion", () => {
  test("parses markdown sections and builds release note text", () => {
    const entries = parseChangelogMarkdown(sampleChangelog);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.baseVersion).toBe("0.0.2");
    expect(entries[0]?.date).toBe("2026-03-22");

    const releaseNotes = buildReleaseNotesRecord(entries);
    expect(releaseNotes["0.0.2"]).toContain("RollCode 0.0.2");
    expect(releaseNotes["0.0.2"]).toContain("date: 2026-03-22");
    expect(releaseNotes["0.0.2"]).toContain("- Added release gating.");
  });

  test("throws when markdown has no version sections", () => {
    expect(() => parseChangelogMarkdown("# Changelog\n\nNo versions yet.")).toThrow(
      "does not contain any version sections",
    );
  });

  test("throws on duplicate base versions", () => {
    const duplicate = `## [1.2.3-beta.1] - 2026-01-01
- pre

## [1.2.3] - 2026-01-02
- stable
`;
    expect(() => parseChangelogMarkdown(duplicate)).toThrow(
      "duplicate sections for base version 1.2.3",
    );
  });

  test("ensureReleaseEntry fails when current version is missing", () => {
    const entries = parseChangelogMarkdown(sampleChangelog);
    expect(() => ensureReleaseEntry(entries, "9.9.9")).toThrow(
      "missing section for current version 9.9.9",
    );
  });

  test("ensureReleaseEntry fails when current version has empty body", () => {
    const emptyBody = `## [0.0.2] - 2026-03-22

## [0.0.1] - 2026-03-20
- init
`;
    const entries = parseChangelogMarkdown(emptyBody);
    expect(() => ensureReleaseEntry(entries, "0.0.2")).toThrow(
      "must include at least one change line",
    );
  });
});
