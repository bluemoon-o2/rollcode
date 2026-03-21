import { describe, expect, test } from "bun:test";
import {
  parseCommandOutput,
  summarizeCommandEntries,
} from "../src/tui/commandOutputParser";

describe("command output parser", () => {
  test("parses a completed command block", () => {
    const entries = parseCommandOutput(
      "$ bun test\npass test A\npass test B\n(exit 0)\n\n",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      command: "bun test",
      output: "pass test A\npass test B",
      phase: "finished",
      success: true,
      exitCode: 0,
    });
  });

  test("parses multiple command blocks and preserves failure", () => {
    const entries = parseCommandOutput(
      "$ ls src\nfile.ts\n(exit 0)\n\n$ rg foo .\nno matches\n(exit 1)\n\n",
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]?.command).toBe("ls src");
    expect(entries[0]?.success).toBeTrue();
    expect(entries[0]?.exitCode).toBe(0);
    expect(entries[1]?.command).toBe("rg foo .");
    expect(entries[1]?.success).toBeFalse();
    expect(entries[1]?.exitCode).toBe(1);
  });

  test("marks unfinished command as running", () => {
    const entries = parseCommandOutput("$ npm run build\nbuilding...\n");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      command: "npm run build",
      output: "building...",
      phase: "running",
      exitCode: undefined,
    });
  });

  test("keeps unknown exit code as null", () => {
    const entries = parseCommandOutput("$ cmd\npartial\n(exit ?)\n");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      command: "cmd",
      output: "partial",
      phase: "finished",
      success: false,
      exitCode: null,
    });
  });

  test("marks previous command running when next command starts without exit", () => {
    const entries = parseCommandOutput(
      "$ first\nline\n$ second\ndone\n(exit 0)\n",
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      command: "first",
      output: "line",
      phase: "running",
      success: undefined,
      exitCode: undefined,
    });
    expect(entries[1]).toMatchObject({
      command: "second",
      output: "done",
      phase: "finished",
      success: true,
      exitCode: 0,
    });
  });

  test("falls back to a single generic entry for legacy output", () => {
    const entries = parseCommandOutput("legacy output only");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      command: "command output",
      output: "legacy output only",
      phase: "finished",
    });
  });

  test("summarizes command entry collection", () => {
    const done = parseCommandOutput("$ echo ok\nok\n(exit 0)\n\n");
    const running = parseCommandOutput("$ sleep 10\n");
    const failed = parseCommandOutput("$ false\n(exit 1)\n");

    expect(summarizeCommandEntries(done)).toBe("1 commands");
    expect(summarizeCommandEntries(running)).toBe("1 commands (1 running)");
    expect(summarizeCommandEntries(failed)).toBe("1 commands (1 failed)");
    expect(summarizeCommandEntries([])).toBe("no tools");
  });
});
