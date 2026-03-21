import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillRecord } from "../src/domain/types";
import { mirrorSkillsForCodex } from "../src/skills/sync";

function createSkillFixture(
  root: string,
  id: string,
  title: string,
): SkillRecord {
  const skillDir = join(root, id);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(
    skillPath,
    `---
name: ${id}
description: ${title}
---

# ${title}

Fixture skill for sync tests.
`,
  );
  return {
    id,
    name: title,
    localName: id,
    canonicalName: id,
    namespace: null,
    description: `${title} description`,
    source: "bundled",
    path: skillPath,
    rootPath: root,
    disableModelInvocation: false,
  };
}

describe("skills mirror", () => {
  const roots: string[] = [];

  afterEach(() => {
    delete process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR;
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses one shared mirror dir and cleans legacy per-agent dirs", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-sync-"));
    roots.push(root);

    const mirrorDir = join(root, "codex-skills-rollcode");
    process.env.ROLLCODE_CODEX_SKILLS_MIRROR_DIR = mirrorDir;

    mkdirSync(join(mirrorDir, "flybird-d8a5094700"), { recursive: true });
    mkdirSync(join(mirrorDir, "rollcode-runtime-abc123"), { recursive: true });

    const fixturesRoot = join(root, "fixtures");
    const alpha = createSkillFixture(fixturesRoot, "alpha", "Alpha Skill");
    const beta = createSkillFixture(fixturesRoot, "beta", "Beta Skill");

    const firstMirror = await mirrorSkillsForCodex("agent-a", [alpha]);
    expect(readdirSync(mirrorDir).sort()).toEqual(["shared"]);
    expect(firstMirror[0]?.mirroredSkillPath).toContain(
      "/shared/alpha/SKILL.md",
    );
    expect(
      existsSync(join(mirrorDir, "shared", "alpha", "SKILL.md")),
    ).toBeTrue();

    const secondMirror = await mirrorSkillsForCodex("agent-b", [beta]);
    expect(readdirSync(mirrorDir).sort()).toEqual(["shared"]);
    expect(secondMirror[0]?.mirroredSkillPath).toContain(
      "/shared/beta/SKILL.md",
    );
    expect(
      existsSync(join(mirrorDir, "shared", "alpha", "SKILL.md")),
    ).toBeFalse();
    expect(
      existsSync(join(mirrorDir, "shared", "beta", "SKILL.md")),
    ).toBeTrue();
  });
});
