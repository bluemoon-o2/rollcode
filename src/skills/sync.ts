import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getCodexSkillsMirrorDir } from "../config";
import type { SkillRecord } from "../domain/types";
import { clearDir, copyDir, ensureDir } from "../utils/fs";
import { sanitizeSegment } from "../utils/id";

const SHARED_MIRROR_DIR = "shared";

async function removeLegacyMirrorEntries(baseDir: string): Promise<void> {
  await ensureDir(baseDir);
  const entries = await readdir(baseDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === SHARED_MIRROR_DIR) {
        return;
      }
      await rm(join(baseDir, entry.name), { recursive: true, force: true });
    }),
  );
}

export async function mirrorSkillsForCodex(
  _agentId: string,
  skills: SkillRecord[],
): Promise<SkillRecord[]> {
  const mirrorBaseDir = getCodexSkillsMirrorDir();
  await removeLegacyMirrorEntries(mirrorBaseDir);
  const mirrorRoot = join(mirrorBaseDir, SHARED_MIRROR_DIR);
  await clearDir(mirrorRoot);
  await ensureDir(mirrorRoot);

  const mirrored = await Promise.all(
    skills.map(async (skill) => {
      const targetDir = join(mirrorRoot, sanitizeSegment(skill.id));
      await copyDir(dirname(skill.path), targetDir);
      return {
        ...skill,
        mirroredSkillPath: join(targetDir, "SKILL.md"),
      } satisfies SkillRecord;
    }),
  );

  return mirrored;
}
