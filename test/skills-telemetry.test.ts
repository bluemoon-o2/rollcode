import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillRecord } from "../src/domain/types";
import {
  detectStaleSkills,
  loadSkillTelemetry,
  recordSkillUsage,
} from "../src/skills/telemetry";

function makeSkill(canonicalName: string): SkillRecord {
  return {
    id: canonicalName,
    name: canonicalName,
    localName: canonicalName,
    canonicalName,
    namespace: null,
    description: `${canonicalName} description`,
    source: "project",
    path: `/tmp/${canonicalName}/SKILL.md`,
    rootPath: "/tmp",
    disableModelInvocation: false,
  };
}

describe("skill telemetry", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records usage and reloads persisted telemetry", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-skill-telemetry-"));
    dirs.push(root);
    const telemetryPath = join(root, "telemetry.json");

    const state = await loadSkillTelemetry(telemetryPath);
    const updated = await recordSkillUsage({
      path: telemetryPath,
      state,
      canonicalNames: ["react", "test", "react"],
    });
    expect(updated.skills.react?.totalUses).toBe(2);
    expect(updated.skills.test?.totalUses).toBe(1);

    const reloaded = await loadSkillTelemetry(telemetryPath);
    expect(reloaded.skills.react?.totalUses).toBe(2);
    expect(reloaded.skills.test?.totalUses).toBe(1);
  });

  test("flags stale skills using threshold days", () => {
    const nowMs = Date.parse("2026-03-22T00:00:00.000Z");
    const stale = detectStaleSkills({
      state: {
        version: 1,
        skills: {
          react: {
            lastUsedAt: "2026-03-20T00:00:00.000Z",
            totalUses: 10,
          },
          old: {
            lastUsedAt: "2025-01-01T00:00:00.000Z",
            totalUses: 2,
          },
        },
      },
      skills: [makeSkill("react"), makeSkill("old"), makeSkill("unused")],
      thresholdDays: 30,
      nowMs,
    });
    expect(stale).toEqual(["old", "unused"]);
  });

  test("disables stale detection when threshold is zero", () => {
    const stale = detectStaleSkills({
      state: {
        version: 1,
        skills: {
          react: {
            lastUsedAt: "2024-01-01T00:00:00.000Z",
            totalUses: 1,
          },
        },
      },
      skills: [makeSkill("react"), makeSkill("unused")],
      thresholdDays: 0,
    });
    expect(stale).toEqual([]);
  });
});
