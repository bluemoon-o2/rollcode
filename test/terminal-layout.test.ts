import { describe, expect, test } from "bun:test";
import { buildHorizontalLine, safeHorizontalLineWidth } from "../src/tui/terminal";

describe("terminal layout helpers", () => {
  test("reserves one column to avoid soft wraps", () => {
    expect(safeHorizontalLineWidth(80)).toBe(79);
    expect(safeHorizontalLineWidth(2)).toBe(1);
  });

  test("keeps minimum width of one column", () => {
    expect(safeHorizontalLineWidth(1)).toBe(1);
    expect(safeHorizontalLineWidth(0)).toBe(1);
    expect(safeHorizontalLineWidth(-5)).toBe(1);
  });

  test("buildHorizontalLine respects safe width and character", () => {
    expect(buildHorizontalLine(6, "-")).toBe("-----");
    expect(buildHorizontalLine(1)).toBe("─");
  });
});
