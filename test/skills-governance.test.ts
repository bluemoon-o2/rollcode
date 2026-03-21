import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillPreferences, SkillRecord, SkillSource } from "../src/domain/types";
import { buildSkillActivationPlan } from "../src/skills/activation";
import { discoverSkillsDetailed } from "../src/skills/discovery";
import {
  NamespacedSkillRegistry,
  NamespacedSkillResolver,
} from "../src/skills/namespaced";
import { loadSkillPreferences } from "../src/skills/preferences";

function writeSkillFile(args: {
  root: string;
  id: string;
  name: string;
  description: string;
}): string {
  const dir = join(args.root, args.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(
    path,
    `---
name: ${args.name}
description: ${args.description}
---

# ${args.name}
`,
    "utf8",
  );
  return path;
}

function makeSkill(args: {
  canonicalName: string;
  source?: SkillSource;
  description?: string;
  path?: string;
}): SkillRecord {
  const [namespacePart, localPart] = args.canonicalName.includes(":")
    ? args.canonicalName.split(":")
    : [null, args.canonicalName];
  const localName = localPart as string;
  const namespace = namespacePart ?? null;
  return {
    id: args.canonicalName.replace(":", "-"),
    name: args.canonicalName,
    localName,
    canonicalName: args.canonicalName,
    namespace,
    description: args.description ?? `${args.canonicalName} description`,
    source: args.source ?? "project",
    path: args.path ?? `/tmp/${args.canonicalName}/SKILL.md`,
    rootPath: "/tmp",
    disableModelInvocation: false,
  };
}

describe("skill governance alignment", () => {
  const roots: string[] = [];

  afterEach(() => {
    delete process.env.ROLLCODE_HOME;
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps higher-priority source skill and emits canonical collision diagnostics", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "rollcode-governance-proj-"));
    const rollcodeHome = mkdtempSync(join(tmpdir(), "rollcode-governance-home-"));
    roots.push(projectRoot, rollcodeHome);
    process.env.ROLLCODE_HOME = rollcodeHome;

    writeSkillFile({
      root: join(rollcodeHome, "skills"),
      id: "collision-skill",
      name: "collision-skill",
      description: "global version",
    });
    writeSkillFile({
      root: join(projectRoot, ".skills"),
      id: "collision-skill",
      name: "collision-skill",
      description: "project version",
    });

    const result = await discoverSkillsDetailed(projectRoot, "agent-collision");
    const winner = result.skills.find(
      (skill) => skill.canonicalName === "collision-skill",
    );
    expect(winner?.source).toBe("project");
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.type === "collision" &&
          entry.collision?.canonicalName === "collision-skill",
      ),
    ).toBeTrue();
  });

  test("loads project marketplace plugin skills via marketplace.json", async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), "rollcode-marketplace-proj-"),
    );
    const pluginRoot = mkdtempSync(join(tmpdir(), "rollcode-marketplace-plugin-"));
    roots.push(projectRoot, pluginRoot);
    mkdirSync(join(projectRoot, ".skills", ".claude-plugin"), {
      recursive: true,
    });
    writeFileSync(
      join(projectRoot, ".skills", ".claude-plugin", "marketplace.json"),
      JSON.stringify(
        {
          name: "test-marketplace",
          plugins: [
            {
              name: "external-skill-pack",
              source: pluginRoot,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    writeSkillFile({
      root: join(pluginRoot, "skills"),
      id: "market-skill",
      name: "market-skill",
      description: "marketplace skill",
    });

    const result = await discoverSkillsDetailed(projectRoot, "agent-marketplace");
    expect(
      result.skills.some((skill) => skill.canonicalName === "market-skill"),
    ).toBeTrue();
    expect(
      result.skills.find((skill) => skill.canonicalName === "market-skill")
        ?.source,
    ).toBe("project");
  });

  test("resolves canonical, alias, local-first and ambiguous names", () => {
    const registry = new NamespacedSkillRegistry();
    const a = makeSkill({ canonicalName: "plugin-a:review", source: "global" });
    const b = makeSkill({ canonicalName: "plugin-b:review", source: "project" });
    const lint = makeSkill({ canonicalName: "plugin-a:lint", source: "project" });
    registry.register(a);
    registry.register(b);
    registry.register(lint);
    expect(registry.registerAlias("qa", "plugin-a:review").success).toBeTrue();

    const resolver = new NamespacedSkillResolver(registry);
    const alias = resolver.resolve("qa");
    expect(alias.resolution).toBe("alias");
    if (alias.resolution === "alias") {
      expect(alias.canonicalName).toBe("plugin-a:review");
    }

    const localFirst = resolver.resolve("review", {
      callerNamespace: "plugin-b",
    });
    expect(localFirst.resolution).toBe("local-first");
    if (localFirst.resolution === "local-first") {
      expect(localFirst.skill.canonicalName).toBe("plugin-b:review");
    }

    const ambiguous = resolver.resolve("review");
    expect(ambiguous.resolution).toBe("ambiguous");
  });

  test("rejects invalid alias registrations with explicit reasons", () => {
    const registry = new NamespacedSkillRegistry();
    registry.register(makeSkill({ canonicalName: "react" }));
    registry.register(makeSkill({ canonicalName: "legacy" }));

    expect(registry.registerAlias("ui", "missing").success).toBeFalse();
    expect(registry.registerAlias("react", "react").success).toBeFalse();
    expect(registry.registerAlias("ui", "react").success).toBeTrue();
    const duplicate = registry.registerAlias("ui", "legacy");
    expect(duplicate.success).toBeFalse();
    expect(duplicate.reason).toBe("duplicate-alias");
  });

  test("activates skills from preferences and context while honoring avoid rules", () => {
    const skills = [
      makeSkill({
        canonicalName: "react",
        description: "React and frontend component implementation",
      }),
      makeSkill({
        canonicalName: "test",
        description: "Testing and verification workflow",
      }),
      makeSkill({
        canonicalName: "legacy",
        description: "Legacy migration workflow",
      }),
    ];
    const registry = new NamespacedSkillRegistry();
    for (const skill of skills) {
      registry.register(skill);
    }
    const resolver = new NamespacedSkillResolver(registry);
    const preferences: SkillPreferences = {
      always_use_skills: ["test"],
      prefer_skills: ["react"],
      avoid_skills: ["legacy"],
      skill_aliases: {
        ui: "react",
      },
      skill_rules: [
        {
          when: "frontend dashboard",
          use: ["ui"],
        },
      ],
    };

    const activation = buildSkillActivationPlan({
      skills,
      resolver,
      preferences,
      goal: "Build a frontend dashboard",
      pendingInstruction: "Implement React settings panel",
      plan: [{ step: "Build UI components", status: "in_progress" }],
    });
    expect(activation.activatedSkills.map((skill) => skill.canonicalName)).toEqual([
      "react",
      "test",
    ]);
    expect(activation.avoidedSkills).toEqual(["legacy"]);
  });

  test("merges global + project skill preferences", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "rollcode-pref-proj-"));
    const rollcodeHome = mkdtempSync(join(tmpdir(), "rollcode-pref-home-"));
    roots.push(projectRoot, rollcodeHome);
    process.env.ROLLCODE_HOME = rollcodeHome;

    mkdirSync(join(rollcodeHome), { recursive: true });
    mkdirSync(join(projectRoot, ".skills"), { recursive: true });
    writeFileSync(
      join(rollcodeHome, "skill-preferences.json"),
      JSON.stringify(
        {
          always_use_skills: ["test"],
          skill_discovery: "suggest",
          skill_staleness_days: 45,
          skill_aliases: {
            ui: "react",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      join(projectRoot, ".skills", "preferences.json"),
      JSON.stringify(
        {
          prefer_skills: ["react"],
          avoid_skills: ["legacy"],
          skill_discovery: "auto",
          skill_staleness_days: 0,
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = await loadSkillPreferences(projectRoot);
    expect(loaded.preferences.always_use_skills).toEqual(["test"]);
    expect(loaded.preferences.prefer_skills).toEqual(["react"]);
    expect(loaded.preferences.avoid_skills).toEqual(["legacy"]);
    expect(loaded.preferences.skill_aliases.ui).toBe("react");
    expect(loaded.preferences.skill_discovery).toBe("auto");
    expect(loaded.preferences.skill_staleness_days).toBe(0);
    expect(loaded.loadedPaths.length).toBe(2);
  });
});
