import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeText } from "../src/utils/fs";

describe("fs utils", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writeText performs atomic replace without leftover temp files", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-fs-"));
    roots.push(root);

    const filePath = join(root, "nested", "note.txt");
    await writeText(filePath, "first");
    await writeText(filePath, "second");

    expect(readFileSync(filePath, "utf8")).toBe("second");
    const nestedEntries = readdirSync(join(root, "nested"));
    expect(nestedEntries).toEqual(["note.txt"]);
  });
});
