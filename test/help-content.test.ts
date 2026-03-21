import { describe, expect, test } from "bun:test";
import {
  buildChangelogMarkdown,
  buildLauncherHotkeysMarkdown,
  buildSessionHotkeysMarkdown,
} from "../src/tui/helpContent";

describe("tui help content", () => {
  test("changelog markdown renders known versions in descending order", () => {
    const markdown = buildChangelogMarkdown();
    const v2Index = markdown.indexOf("## 0.0.2");
    const v1Index = markdown.indexOf("## 0.0.1");

    expect(v2Index).toBeGreaterThanOrEqual(0);
    expect(v1Index).toBeGreaterThanOrEqual(0);
    expect(v2Index).toBeLessThan(v1Index);
  });

  test("launcher hotkeys includes changelog and hotkeys commands", () => {
    const markdown = buildLauncherHotkeysMarkdown();
    expect(markdown).toContain("`/changelog`");
    expect(markdown).toContain("`/hotkeys`");
  });

  test("session hotkeys respects viewerOnly command set", () => {
    const writable = buildSessionHotkeysMarkdown(false);
    const viewerOnly = buildSessionHotkeysMarkdown(true);

    expect(writable).toContain("`/resume`");
    expect(viewerOnly).not.toContain("`/resume`");
  });
});
