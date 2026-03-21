import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledSkillsDir } from "../src/config";

function makeSkill(root: string, name: string, description: string) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "SKILL.md"),
    `# ${name}\n\n${description}\n`,
    "utf8",
  );
}

describe("skill discovery", () => {
  let rollcodeHome = "";
  let cwd = "";
  let bundledSkillDir = "";

  beforeEach(() => {
    rollcodeHome = mkdtempSync(join(tmpdir(), "rollcode-home-"));
  });

  afterEach(() => {
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
    }
    if (bundledSkillDir) {
      rmSync(bundledSkillDir, { recursive: true, force: true });
    }
    if (rollcodeHome) {
      rmSync(rollcodeHome, { recursive: true, force: true });
    }
    delete process.env.ROLLCODE_HOME;
  });

  test("prefers project over agent over global over bundled", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "rollcode-skills-"));
    cwd = projectRoot;
    process.env.ROLLCODE_HOME = rollcodeHome;
    bundledSkillDir = join(getBundledSkillsDir(), "priority-same");

    makeSkill(bundledSkillDir, "Same", "bundled version");
    makeSkill(join(rollcodeHome, "skills", "priority-same"), "Same", "global");
    makeSkill(
      join(rollcodeHome, "agents", "agent-1", "skills", "priority-same"),
      "Same",
      "agent",
    );
    makeSkill(join(projectRoot, ".skills", "priority-same"), "Same", "project");

    const discovery = await import("../src/skills/discovery");
    const skills = (await discovery.discoverSkillsDetailed(projectRoot, "agent-1"))
      .skills;
    const same = skills.find((skill) => skill.id === "priority-same");
    expect(same?.source).toBe("project");
  });
});
