import { describe, expect, test } from "bun:test";
import {
  buildSlashAutocompleteState,
  formatSlashCommandForInput,
  getLauncherSlashCommands,
  getSelectedSlashCommand,
  getSlashCommands,
  resolveSubmittedInput,
  validateSlashCommandInput,
} from "../src/tui/slashCommands";

describe("slash command autocomplete", () => {
  test("omits removed /done and /interrupt commands", () => {
    const commands = getSlashCommands(false).map((item) => item.command);
    expect(commands).not.toContain("/done");
    expect(commands).not.toContain("/interrupt");
    expect(commands).toContain("/feedback");
    expect(commands).toContain("/codex");
  });

  test("shows all commands for bare slash", () => {
    const commands = getSlashCommands(false);
    const state = buildSlashAutocompleteState("/", commands);
    expect(state.active).toBe(true);
    expect(state.matches.length).toBe(commands.length);
    expect(state.showNoMatches).toBe(false);
  });

  test("filters by command name", () => {
    const state = buildSlashAutocompleteState("/mem", getSlashCommands(false));
    expect(state.active).toBe(true);
    expect(state.matches.map((item) => item.command)).toEqual(["/memory"]);
  });

  test("normalizes trailing control/whitespace in slash query", () => {
    const state = buildSlashAutocompleteState("/me\r", getSlashCommands(false));
    expect(state.active).toBe(true);
    expect(state.matches.map((item) => item.command)).toContain("/memory");
  });

  test("hides autocomplete after command arguments begin", () => {
    const state = buildSlashAutocompleteState(
      "/memory status",
      getSlashCommands(false),
    );
    expect(state.active).toBe(false);
    expect(state.matches).toEqual([]);
  });

  test("hides autocomplete for exact no-arg command", () => {
    const state = buildSlashAutocompleteState("/new", getSlashCommands(false));
    expect(state.active).toBe(false);
    expect(state.matches).toEqual([]);
  });

  test("resolves submit to selected command when still typing", () => {
    const commands = getSlashCommands(false);
    const state = buildSlashAutocompleteState("/re", commands);
    expect(getSelectedSlashCommand(state, 0)).toBe("/resume");
    expect(resolveSubmittedInput("/re", state, 0, commands)).toBe("/resume");
  });

  test("resolves feedback command when still typing", () => {
    const commands = getSlashCommands(false);
    const state = buildSlashAutocompleteState("/fee", commands);
    expect(getSelectedSlashCommand(state, 0)).toBe("/feedback");
    expect(resolveSubmittedInput("/fee", state, 0, commands)).toBe("/feedback");
  });

  test("keeps bare slash without forcing the first command", () => {
    const commands = getSlashCommands(false);
    const state = buildSlashAutocompleteState("/", commands);
    expect(resolveSubmittedInput("/", state, 0, commands)).toBe("/");
  });

  test("submits selected command for bare slash after navigation", () => {
    const commands = getSlashCommands(false);
    const state = buildSlashAutocompleteState("/", commands);
    expect(resolveSubmittedInput("/", state, 1, commands)).toBe("/memory");
  });

  test("keeps raw input when autocomplete is inactive", () => {
    const commands = getSlashCommands(false);
    const state = buildSlashAutocompleteState("/memory status", commands);
    expect(resolveSubmittedInput("/memory status", state, 0, commands)).toBe(
      "/memory status",
    );
  });

  test("does not alias /quit to /exit", () => {
    const commands = getSlashCommands(false);
    const state = buildSlashAutocompleteState("/quit", commands);
    expect(resolveSubmittedInput("/quit", state, 0, commands)).toBe("/quit");
  });

  test("falls back to command matching even when autocomplete state is inactive", () => {
    const commands = getLauncherSlashCommands();
    const inactiveState = {
      active: false,
      query: "",
      matches: [],
      showNoMatches: false,
    };
    expect(resolveSubmittedInput("/co", inactiveState, 0, commands)).toBe(
      "/codex",
    );
  });

  test("formats /new completion without trailing space", () => {
    const commands = getSlashCommands(false);
    expect(formatSlashCommandForInput("/new", commands)).toBe("/new");
  });

  test("formats /feedback completion with trailing space", () => {
    const commands = getSlashCommands(false);
    expect(formatSlashCommandForInput("/feedback", commands)).toBe("/feedback ");
  });

  test("/new rejects unexpected arguments", () => {
    const commands = getSlashCommands(false);
    expect(validateSlashCommandInput("/new test", commands)).toEqual({
      kind: "unexpected-arguments",
      command: "/new",
      hint: "/new does not accept arguments.",
    });
  });

  test("/feedback requires a message", () => {
    const commands = getSlashCommands(false);
    expect(validateSlashCommandInput("/feedback", commands)).toEqual({
      kind: "missing-arguments",
      command: "/feedback",
      hint: "请输入反馈内容后回车提交（格式：/feedback 具体问题描述）",
      prefill: "/feedback ",
    });
  });
});
