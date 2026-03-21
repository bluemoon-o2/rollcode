import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getBundledSkillsDir } from "../src/config";

describe("bundled skills format", () => {
  test("built-in SKILL.md files include YAML frontmatter", () => {
    const files = [
      join(getBundledSkillsDir(), "rollcode-memory", "SKILL.md"),
      join(getBundledSkillsDir(), "rollcode-supervision", "SKILL.md"),
    ];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text.startsWith("---\n")).toBe(true);
      expect(text.indexOf("\n---\n", 4)).toBeGreaterThan(0);
    }
  });
});
