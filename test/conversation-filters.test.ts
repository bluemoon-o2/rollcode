import { describe, expect, test } from "bun:test";
import {
  type ConversationFilterMode,
  cycleConversationFilterMode,
  formatConversationFilterLabel,
  getConversationVisibility,
  shouldShowEventLine,
  toggleConversationFilterMode,
} from "../src/tui/conversationFilters";

describe("conversation filter modes", () => {
  test("cycles forward with wraparound", () => {
    const start: ConversationFilterMode = "default";
    expect(cycleConversationFilterMode(start, "forward")).toBe("no-tools");
    expect(cycleConversationFilterMode("all", "forward")).toBe("default");
  });

  test("cycles backward with wraparound", () => {
    expect(cycleConversationFilterMode("default", "backward")).toBe("all");
    expect(cycleConversationFilterMode("user-only", "backward")).toBe(
      "no-tools",
    );
  });

  test("maps visibility rules for each mode", () => {
    expect(getConversationVisibility("default")).toEqual({
      showGoal: true,
      showAssistant: true,
      showLabeledDetails: true,
      showEvents: true,
    });

    expect(getConversationVisibility("no-tools")).toEqual({
      showGoal: true,
      showAssistant: true,
      showLabeledDetails: false,
      showEvents: true,
    });

    expect(getConversationVisibility("user-only")).toEqual({
      showGoal: true,
      showAssistant: false,
      showLabeledDetails: false,
      showEvents: false,
    });

    expect(getConversationVisibility("labeled-only")).toEqual({
      showGoal: false,
      showAssistant: false,
      showLabeledDetails: true,
      showEvents: false,
    });

    expect(getConversationVisibility("all")).toEqual({
      showGoal: true,
      showAssistant: true,
      showLabeledDetails: true,
      showEvents: true,
    });
  });

  test("toggles direct filter modes like tree-selector", () => {
    expect(toggleConversationFilterMode("default", "no-tools")).toBe(
      "no-tools",
    );
    expect(toggleConversationFilterMode("no-tools", "no-tools")).toBe(
      "default",
    );
    expect(toggleConversationFilterMode("all", "default")).toBe("default");
  });

  test("formats compact filter labels", () => {
    expect(formatConversationFilterLabel("default")).toBe("[default]");
    expect(formatConversationFilterLabel("user-only")).toBe("[user]");
    expect(formatConversationFilterLabel("labeled-only")).toBe("[labeled]");
  });

  test("hides command-like events in no-tools mode", () => {
    expect(
      shouldShowEventLine("no-tools", "12:00:00 [worker] ls -la (exit 0)"),
    ).toBeFalse();
    expect(
      shouldShowEventLine(
        "no-tools",
        "12:00:01 [system] Transient upstream error; retrying.",
      ),
    ).toBeTrue();
    expect(
      shouldShowEventLine("default", "12:00:00 [worker] ls -la (exit 0)"),
    ).toBeTrue();
  });
});
