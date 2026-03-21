import { describe, expect, test } from "bun:test";
import { formatLocalClock } from "../src/utils/time";

describe("formatLocalClock", () => {
  test("normalizes equivalent instants from different timezone offsets", () => {
    const utc = "2026-03-23T07:34:30.000Z";
    const utcPlusEight = "2026-03-23T15:34:30.000+08:00";

    expect(formatLocalClock(utc)).toBe(formatLocalClock(utcPlusEight));
    expect(formatLocalClock(utc)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("falls back to embedded clock token when date parsing fails", () => {
    expect(formatLocalClock("2026-03-23T19:20:21-invalid")).toBe("19:20:21");
  });

  test("returns zero clock when input has no parseable time", () => {
    expect(formatLocalClock("not-a-time")).toBe("00:00:00");
  });
});
