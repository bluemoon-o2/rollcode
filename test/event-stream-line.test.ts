import { describe, expect, test } from "bun:test";
import { shouldCollapseEventLine } from "../src/tui/components/EventStreamLine";

describe("event stream line collapsing", () => {
  test("does not collapse short single-line entries", () => {
    expect(
      shouldCollapseEventLine("12:00:00 [worker] short update", 40),
    ).toBeFalse();
  });

  test("collapses long single-line entries", () => {
    expect(
      shouldCollapseEventLine(
        "12:00:00 [worker] this is a very long log message that should be truncated",
        24,
      ),
    ).toBeTrue();
  });

  test("collapses multiline entries", () => {
    expect(shouldCollapseEventLine("line1\nline2", 120)).toBeTrue();
  });
});
