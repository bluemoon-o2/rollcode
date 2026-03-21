import { describe, expect, test } from "bun:test";
import {
  canonicalizeLauncherSubmission,
  normalizeLauncherCommand,
  sanitizeLauncherInput,
} from "../src/tui/launcherInput";

describe("launcher input normalization", () => {
  test("removes known control noise bytes", () => {
    expect(sanitizeLauncherInput("/hot\u000fkeys")).toBe("/hotkeys");
  });

  test("strips newline and carriage-return noise", () => {
    expect(sanitizeLauncherInput("/\n")).toBe("/");
    expect(sanitizeLauncherInput("/\r")).toBe("/");
  });

  test("removes zero-width bytes", () => {
    expect(sanitizeLauncherInput("/resu\u200bme")).toBe("/resume");
  });

  test("normalizes full-width slash at command start", () => {
    expect(normalizeLauncherCommand(" ／resume ")).toBe("/resume");
  });

  test("normalizes full-width command letters to ascii", () => {
    expect(normalizeLauncherCommand("／ｈｏｔｋｅｙｓ")).toBe("/hotkeys");
  });

  test("removes generic unicode format characters", () => {
    expect(sanitizeLauncherInput("/ho\u2060tkeys")).toBe("/hotkeys");
  });

  test("canonicalizes /resume alias with trailing args", () => {
    expect(canonicalizeLauncherSubmission("/resume history")).toBe("/resume");
  });
});
