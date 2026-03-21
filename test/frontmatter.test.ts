import { describe, expect, test } from "bun:test";
import {
  parseFrontmatter,
  stringifyFrontmatter,
} from "../src/memory/frontmatter";

describe("frontmatter", () => {
  test("parses and stringifies required fields", () => {
    const source = `---
description: example
limit: 123
---
hello
world
`;

    const parsed = parseFrontmatter(source);
    expect(parsed.attributes.description).toBe("example");
    expect(parsed.attributes.limit).toBe(123);
    expect(parsed.body.trim()).toBe("hello\nworld");

    const output = stringifyFrontmatter(parsed);
    expect(output).toContain("description: example");
    expect(output).toContain("limit: 123");
  });

  test("sanitizes multiline string values during stringify", () => {
    const output = stringifyFrontmatter({
      attributes: {
        description: "line-1\nline-2",
        limit: 64,
        updatedAt: "2026-03-20\n10:00:00Z",
      },
      body: "hello",
    });
    expect(output).toContain("description: line-1 line-2");
    expect(output).toContain("updatedAt: 2026-03-20 10:00:00Z");
  });

  test("rejects invalid required fields during stringify", () => {
    expect(() =>
      stringifyFrontmatter({
        attributes: {
          description: "ok",
          limit: 0,
        },
        body: "",
      }),
    ).toThrow("Frontmatter requires a positive numeric limit");
  });

  test("parses CRLF frontmatter documents", () => {
    const source = [
      "---",
      "description: windows-style",
      "limit: 9",
      "---",
      "line-a",
      "line-b",
      "",
    ].join("\r\n");
    const parsed = parseFrontmatter(source);
    expect(parsed.attributes.description).toBe("windows-style");
    expect(parsed.attributes.limit).toBe(9);
    expect(parsed.body).toBe("line-a\nline-b\n");
  });

  test("parses frontmatter with UTF-8 BOM", () => {
    const source = [
      "\uFEFF---",
      "description: bom-file",
      "limit: 5",
      "---",
      "body",
      "",
    ].join("\n");
    const parsed = parseFrontmatter(source);
    expect(parsed.attributes.description).toBe("bom-file");
    expect(parsed.attributes.limit).toBe(5);
    expect(parsed.body).toBe("body\n");
  });
});
