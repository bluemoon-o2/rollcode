import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReleaseNotes, getReleaseNotes } from "../src/release-notes";
import { StateStore } from "../src/state/store";
import { getBaseVersion, getVersion } from "../src/version";

describe("release notes", () => {
  const roots: string[] = [];

  afterEach(() => {
    delete process.env.ROLLCODE_SHOW_RELEASE_NOTES;
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("shows current version notes once", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-release-notes-"));
    roots.push(root);
    const store = new StateStore(join(root, "state.json"));

    const first = await checkReleaseNotes(store);
    expect(first).not.toBeNull();
    expect(first).toContain(`RollCode ${getVersion()}`);

    const second = await checkReleaseNotes(store);
    expect(second).toBeNull();

    store.close();
  });

  test("force flag re-displays notes", async () => {
    const root = mkdtempSync(join(tmpdir(), "rollcode-release-notes-force-"));
    roots.push(root);
    const store = new StateStore(join(root, "state.json"));

    await checkReleaseNotes(store);
    process.env.ROLLCODE_SHOW_RELEASE_NOTES = "1";
    const forced = await checkReleaseNotes(store);

    expect(forced).toContain(`RollCode ${getVersion()}`);
    store.close();
  });

  test("notes map is keyed by base version", () => {
    const baseVersion = getBaseVersion(getVersion());
    expect(getReleaseNotes(baseVersion)).not.toBeNull();
    expect(getReleaseNotes("0.0.0")).toBeNull();
  });
});
