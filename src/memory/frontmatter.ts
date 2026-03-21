export interface FrontmatterAttributes {
  description: string;
  limit: number;
  [key: string]: string | number | boolean;
}

export interface FrontmatterDocument {
  attributes: FrontmatterAttributes;
  body: string;
}

function parseValue(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function sanitizeFrontmatterString(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function stringifyValue(value: string | number | boolean): string {
  if (typeof value === "string") {
    return sanitizeFrontmatterString(value);
  }
  return String(value);
}

export function parseFrontmatter(input: string): FrontmatterDocument {
  const normalized = input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    if (!normalized.startsWith("---")) {
      throw new Error("Missing frontmatter start marker");
    }
    throw new Error("Missing frontmatter end marker");
  }
  const head = match[1] ?? "";
  const body = match[2] ?? "";
  const attributes = Object.fromEntries(
    head
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf(":");
        if (index === -1) {
          throw new Error(`Invalid frontmatter line: ${line}`);
        }
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1);
        return [key, parseValue(value)];
      }),
  ) as FrontmatterAttributes;

  if (!attributes.description || typeof attributes.description !== "string") {
    throw new Error("Frontmatter requires a description");
  }

  if (typeof attributes.limit !== "number" || attributes.limit <= 0) {
    throw new Error("Frontmatter requires a positive numeric limit");
  }

  return {
    attributes,
    body,
  };
}

export function stringifyFrontmatter(document: FrontmatterDocument): string {
  const description = sanitizeFrontmatterString(
    String(document.attributes.description ?? ""),
  );
  const limit = Number(document.attributes.limit);
  if (!description) {
    throw new Error("Frontmatter requires a description");
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("Frontmatter requires a positive numeric limit");
  }

  const normalizedAttributes: FrontmatterAttributes = {
    ...document.attributes,
    description,
    limit,
  };
  const header = Object.entries(normalizedAttributes)
    .map(([key, value]) => `${key}: ${stringifyValue(value)}`)
    .join("\n");
  return `---\n${header}\n---\n${document.body.replace(/^\n+/, "")}`;
}
