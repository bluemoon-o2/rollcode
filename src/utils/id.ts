import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function agentIdForCwd(cwd: string): string {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 10);
  const label = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${label || "project"}-${hash}`;
}

export function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
