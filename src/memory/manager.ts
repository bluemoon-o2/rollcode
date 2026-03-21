import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { getAgentMemoryDir, getProjectRoot } from "../config";
import type {
  MemoryFileRecord,
  RunRecord,
  SupervisorDecision,
  WorkerHandoff,
} from "../domain/types";
import {
  ensureDir,
  listFilesRecursive,
  pathExists,
  writeText,
} from "../utils/fs";
import { sanitizeSegment } from "../utils/id";
import { nowIso, todayStamp } from "../utils/time";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";

const DEFAULT_LIMIT = 4000;
const DEFAULT_RECALL_RESULTS = 4;
const RECALL_SNIPPET_SOFT_LIMIT = 720;
const RECALL_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "need",
  "next",
  "step",
  "then",
  "when",
  "where",
  "have",
  "has",
  "will",
  "would",
  "should",
  "about",
  "after",
  "before",
  "goal",
  "task",
  "run",
]);

const FRONTMATTER_PRE_COMMIT_HOOK = `#!/usr/bin/env bash
set -euo pipefail

ALLOWED_KEYS="description limit updatedAt read_only"
PROTECTED_KEYS="read_only"
errors=""

get_fm_value() {
  local content="$1"
  local key="$2"
  local closing_line
  closing_line=$(echo "$content" | tail -n +2 | grep -n '^---$' | head -1 | cut -d: -f1 || true)
  if [ -z "$closing_line" ]; then
    return 0
  fi
  echo "$content" | tail -n +2 | head -n $((closing_line - 1)) | grep "^$key:" | cut -d: -f2- | sed 's/^ *//;s/ *$//' | head -1 || true
  return 0
}

while IFS= read -r file; do
  [ -z "$file" ] && continue
  staged=$(git show ":$file")

  first_line=$(echo "$staged" | head -1)
  if [ "$first_line" != "---" ]; then
    errors="$errors\n  $file: missing frontmatter (must start with ---)"
    continue
  fi

  closing_line=$(echo "$staged" | tail -n +2 | grep -n '^---$' | head -1 | cut -d: -f1 || true)
  if [ -z "$closing_line" ]; then
    errors="$errors\n  $file: frontmatter opened but never closed (missing closing ---)"
    continue
  fi

  head_content=$(git show "HEAD:$file" 2>/dev/null || true)
  if [ -n "$head_content" ]; then
    head_ro=$(get_fm_value "$head_content" "read_only")
    if [ "$head_ro" = "true" ]; then
      errors="$errors\n  $file: file is read_only and cannot be modified"
      continue
    fi
  fi

  frontmatter=$(echo "$staged" | tail -n +2 | head -n $((closing_line - 1)))
  has_description=false
  has_limit=false

  while IFS= read -r line; do
    [ -z "$line" ] && continue

    key=$(echo "$line" | cut -d: -f1 | tr -d ' ')
    value=$(echo "$line" | cut -d: -f2- | sed 's/^ *//;s/ *$//')
    [ -z "$key" ] && continue

    known=false
    for k in $ALLOWED_KEYS; do
      if [ "$k" = "$key" ]; then
        known=true
        break
      fi
    done
    if [ "$known" = "false" ]; then
      errors="$errors\n  $file: unknown frontmatter key '$key' (allowed: $ALLOWED_KEYS)"
      continue
    fi

    if [ "$key" = "read_only" ]; then
      if [ -n "$head_content" ]; then
        head_val=$(get_fm_value "$head_content" "$key")
        if [ "$value" != "$head_val" ]; then
          errors="$errors\n  $file: '$key' is protected and cannot be changed"
        fi
      else
        errors="$errors\n  $file: '$key' is protected and cannot be set in new files"
      fi
    fi

    case "$key" in
      description)
        has_description=true
        if [ -z "$value" ]; then
          errors="$errors\n  $file: 'description' must not be empty"
        fi
        ;;
      limit)
        has_limit=true
        if ! echo "$value" | grep -qE '^[0-9]+$' || [ "$value" = "0" ]; then
          errors="$errors\n  $file: 'limit' must be a positive integer, got '$value'"
        fi
        ;;
    esac
  done <<< "$frontmatter"

  if [ "$has_description" = "false" ]; then
    errors="$errors\n  $file: missing required field 'description'"
  fi
  if [ "$has_limit" = "false" ]; then
    errors="$errors\n  $file: missing required field 'limit'"
  fi

  if [ -n "$head_content" ]; then
    for k in $PROTECTED_KEYS; do
      head_val=$(get_fm_value "$head_content" "$k")
      if [ -n "$head_val" ]; then
        staged_val=$(get_fm_value "$staged" "$k")
        if [ -z "$staged_val" ]; then
          errors="$errors\n  $file: '$k' is protected and cannot be removed"
        fi
      fi
    done
  fi
done < <(git diff --cached --name-only --diff-filter=ACM -- '*.md')

if [ -n "$errors" ]; then
  echo "Frontmatter validation failed:"
  echo -e "$errors"
  exit 1
fi
`;

export interface MemoryPromptContext {
  pinnedSections: string;
  memoryTree: string;
  memoryIndex: string;
  recentEpisodes: string;
  retrievedContext: string;
}

export interface TaskMemoryRecallInput {
  goal: string;
  pendingInstruction?: string | null;
  latestDecision?: SupervisorDecision | null;
  latestWorkerSummary?: string | null;
  maxResults?: number;
}

interface RankedMemoryMatch {
  file: MemoryFileRecord;
  score: number;
}

function renderTree(paths: string[]): string {
  const normalized = [...paths].sort();
  if (normalized.length === 0) {
    return "/memory/\n└── system/\n";
  }
  return ["/memory/", ...normalized.map((path) => `- ${path}`)].join("\n");
}

function truncate(input: string, max = 240): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max - 1)}…`;
}

function tokenizeQuery(input: string): string[] {
  const seen = new Set<string>();
  const tokens = input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(
      (token) => token.length >= 3 && token.length <= 48 && !RECALL_STOP_WORDS.has(token),
    );
  for (const token of tokens) {
    seen.add(token);
  }
  return [...seen];
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle || !haystack) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    if (count >= 8) {
      break;
    }
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function applyMemoryLimit(text: string, limit: number): string {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_LIMIT;
  if (normalized.length <= safeLimit) {
    return normalized;
  }
  if (safeLimit <= 24) {
    return `${normalized.slice(0, Math.max(1, safeLimit - 1))}…`;
  }
  return `${normalized.slice(0, safeLimit)}\n...[truncated by memory limit ${safeLimit}]`;
}

export class MemoryManager {
  readonly agentId: string;
  readonly memoryDir: string;

  constructor(agentId: string) {
    this.agentId = agentId;
    this.memoryDir = getAgentMemoryDir(agentId);
  }

  async ensureInitialized(cwd: string): Promise<void> {
    await ensureDir(join(this.memoryDir, "system"));
    await ensureDir(join(this.memoryDir, "project"));
    await ensureDir(join(this.memoryDir, "episodes"));

    await this.ensureFile(
      join(this.memoryDir, "system", "identity.md"),
      {
        description:
          "Pinned identity and operating rules for this RollCode agent.",
        limit: DEFAULT_LIMIT,
      },
      `
# Identity

- You are a persistent RollCode agent bound to this repository and its operator.
- RollCode is an orchestration shell around Codex, not a second coding brain.
- The hidden supervisor thread owns completion approval.
- Keep durable facts here, not transient turn-by-turn chatter.
      `.trim(),
    );

    await this.ensureFile(
      join(this.memoryDir, "system", "project-context.md"),
      {
        description:
          "Pinned durable project context learned across successful runs.",
        limit: DEFAULT_LIMIT,
      },
      `
# Project Context

- Repository root: ${cwd}
- RollCode project root: ${getProjectRoot()}
- Update this file only with durable conventions, architecture, or user preferences.
      `.trim(),
    );

    if (!(await pathExists(join(this.memoryDir, ".git")))) {
      this.runGit(["init"]);
      this.runGit(["config", "user.name", "RollCode"]);
      this.runGit(["config", "user.email", "rollcode@local"]);
      this.runGit(["add", "."]);
      this.runGit(["commit", "-m", "chore: initialize rollcode memory"], true);
    }
    await this.ensureFrontmatterPreCommitHook();
  }

  async buildPromptContext(args?: {
    query?: string;
    maxRetrievedResults?: number;
  }): Promise<MemoryPromptContext> {
    const files = await this.listMemoryFiles();
    const pinned = files
      .filter((file) => file.relativePath.startsWith("system/"))
      .map(
        (file) =>
          `<system/context/${file.relativePath}></system/context/${file.relativePath}>\n${applyMemoryLimit(file.body, file.limit)}`,
      )
      .join("\n\n");
    const recentEpisodes = files
      .filter((file) => file.relativePath.startsWith("episodes/"))
      .slice(-5)
      .map(
        (file) => `- ${file.relativePath}: ${truncate(file.description, 120)}`,
      )
      .join("\n");
    const index = files
      .filter((file) => !file.relativePath.startsWith("system/"))
      .map(
        (file) =>
          `- ${file.relativePath} | description: ${file.description} | limit: ${file.limit}`,
      )
      .join("\n");

    return {
      pinnedSections: pinned || "(no pinned system memory yet)",
      memoryTree: renderTree(files.map((file) => file.relativePath)),
      memoryIndex: index || "- No non-system memory files yet.",
      recentEpisodes: recentEpisodes || "- No episodic memory yet.",
      retrievedContext: this.renderRetrievedContext(
        files,
        args?.query ?? "",
        args?.maxRetrievedResults ?? DEFAULT_RECALL_RESULTS,
      ),
    };
  }

  async buildTaskRecall(input: TaskMemoryRecallInput): Promise<string> {
    const files = await this.listMemoryFiles();
    const query = [
      input.goal,
      input.pendingInstruction ?? "",
      input.latestDecision?.rationale ?? "",
      input.latestDecision?.nextInstruction ?? "",
      input.latestWorkerSummary ?? "",
    ]
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join("\n");
    return this.renderRetrievedContext(
      files,
      query,
      input.maxResults ?? DEFAULT_RECALL_RESULTS,
    );
  }

  async listMemoryFiles(): Promise<MemoryFileRecord[]> {
    const files = await listFilesRecursive(this.memoryDir, {
      ignoreDirectories: [".git"],
      ignoreHiddenDirectories: true,
    });
    const markdownFiles = files
      .filter((file) => file.endsWith(".md"))
      .sort((left, right) => left.localeCompare(right));
    const documents = await Promise.all(
      markdownFiles.map(async (file) => {
        const parsed = parseFrontmatter(await readFile(file, "utf8"));
        return {
          relativePath: relative(this.memoryDir, file).replace(/\\/g, "/"),
          description: parsed.attributes.description,
          limit: parsed.attributes.limit,
          body: parsed.body.trim(),
        };
      }),
    );
    return documents;
  }

  async materializeDecision(
    run: RunRecord,
    handoff: WorkerHandoff,
    decision: SupervisorDecision,
  ): Promise<string | null> {
    if (decision.memoryAction === "none") {
      return null;
    }

    const stamp = `${todayStamp()}-${sanitizeSegment(run.id)}`;
    const episodePath = join(this.memoryDir, "episodes", `${stamp}.md`);
    const episodeBody = `
# Run Summary

- Goal: ${run.goal}
- Worker summary: ${handoff.summary}
- Completion claim: ${handoff.completionClaim}
- Supervisor action: ${decision.action}
- Supervisor rationale: ${decision.rationale}

## Evidence

${handoff.evidence.map((item) => `- ${item}`).join("\n") || "- None recorded."}

## Unresolved

${handoff.unresolved.map((item) => `- ${item}`).join("\n") || "- None."}
    `.trim();

    await writeText(
      episodePath,
      stringifyFrontmatter({
        attributes: {
          description: truncate(handoff.summary || run.goal, 140),
          limit: DEFAULT_LIMIT,
          updatedAt: nowIso(),
        },
        body: `${episodeBody}\n`,
      }),
    );

    if (decision.memoryAction === "consolidate") {
      const projectContextPath = join(
        this.memoryDir,
        "system",
        "project-context.md",
      );
      const existing = parseFrontmatter(
        await readFile(projectContextPath, "utf8"),
      );
      const section = `

## Learned ${todayStamp()} (${run.id})

- Goal: ${run.goal}
- Lesson: ${handoff.summary}
- Supervisor rationale: ${decision.rationale}
      `.trimEnd();
      await writeText(
        projectContextPath,
        stringifyFrontmatter({
          attributes: existing.attributes,
          body: `${existing.body.trimEnd()}\n\n${section}\n`,
        }),
      );
    }

    this.runGit(["add", "."]);
    const status = this.runGit(["status", "--porcelain"], true).trim();
    if (status) {
      this.runGit(
        ["commit", "-m", `memory: ${decision.memoryAction} ${run.id}`],
        true,
      );
    }

    return truncate(handoff.summary || decision.rationale, 200);
  }

  async status(): Promise<string> {
    const context = await this.buildPromptContext();
    const gitStatus =
      this.runGit(["status", "--short"], true).trim() || "(clean)";
    return [
      `Memory directory: ${this.memoryDir}`,
      "",
      context.memoryTree,
      "",
      "Recent episodes:",
      context.recentEpisodes,
      "",
      "Retrieved context preview:",
      context.retrievedContext,
      "",
      "Git status:",
      gitStatus,
    ].join("\n");
  }

  diff(): string {
    return this.runGit(["diff", "--no-ext-diff"], true);
  }

  log(): string {
    return this.runGit(["log", "--oneline", "-n", "20"], true);
  }

  private async ensureFile(
    path: string,
    attributes: Record<string, string | number | boolean>,
    body: string,
  ): Promise<void> {
    if (await pathExists(path)) {
      return;
    }
    await writeText(
      path,
      stringifyFrontmatter({
        attributes: {
          description: String(attributes.description),
          limit: Number(attributes.limit),
        },
        body: `${body}\n`,
      }),
    );
  }

  private runGit(args: string[], allowFailure = false): string {
    const result = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd: this.memoryDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(result.stdout).trimEnd();
    const stderr = new TextDecoder().decode(result.stderr).trimEnd();
    if (result.exitCode !== 0 && !allowFailure) {
      throw new Error(
        stderr ||
          stdout ||
          `git ${args.join(" ")} failed with ${result.exitCode}`,
      );
    }
    return stdout || stderr;
  }

  private async ensureFrontmatterPreCommitHook(): Promise<void> {
    const hookPath = join(this.memoryDir, ".git", "hooks", "pre-commit");
    await writeText(hookPath, FRONTMATTER_PRE_COMMIT_HOOK);
    const chmod = Bun.spawnSync({
      cmd: ["chmod", "+x", hookPath],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (chmod.exitCode !== 0) {
      const stderr = new TextDecoder().decode(chmod.stderr).trimEnd();
      const stdout = new TextDecoder().decode(chmod.stdout).trimEnd();
      throw new Error(stderr || stdout || `chmod +x ${hookPath} failed`);
    }
  }

  private scoreMemoryFile(file: MemoryFileRecord, tokens: string[]): number {
    if (tokens.length === 0) {
      return 0;
    }
    const description = file.description.toLowerCase();
    const body = file.body.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (description.includes(token)) {
        score += 3;
      }
      score += countOccurrences(body, token);
    }
    return score;
  }

  private sliceMatchWindow(
    body: string,
    tokens: string[],
    windowLimit: number,
  ): string {
    const normalized = body.trim();
    if (!normalized) {
      return "(empty)";
    }
    if (tokens.length === 0) {
      return applyMemoryLimit(normalized, windowLimit);
    }
    const lowered = normalized.toLowerCase();
    let firstMatch = -1;
    for (const token of tokens) {
      const index = lowered.indexOf(token);
      if (index !== -1 && (firstMatch === -1 || index < firstMatch)) {
        firstMatch = index;
      }
    }
    if (firstMatch === -1) {
      return applyMemoryLimit(normalized, windowLimit);
    }
    const head = Math.max(0, firstMatch - 120);
    const tail = Math.min(normalized.length, firstMatch + windowLimit);
    const prefix = head > 0 ? "..." : "";
    const suffix = tail < normalized.length ? "..." : "";
    return applyMemoryLimit(
      `${prefix}${normalized.slice(head, tail).trim()}${suffix}`,
      windowLimit,
    );
  }

  private renderRetrievedContext(
    files: MemoryFileRecord[],
    query: string,
    maxResults: number,
  ): string {
    const candidates = files.filter(
      (file) => !file.relativePath.startsWith("system/"),
    );
    if (candidates.length === 0) {
      return "- No non-system memory files available.";
    }

    const safeMaxResults = Math.max(1, Math.min(8, Math.floor(maxResults || 1)));
    const tokens = tokenizeQuery(query);
    let ranked: RankedMemoryMatch[];
    if (tokens.length === 0) {
      ranked = [...candidates]
        .reverse()
        .slice(0, safeMaxResults)
        .map((file) => ({ file, score: 0 }));
    } else {
      ranked = candidates
        .map((file) => ({
          file,
          score: this.scoreMemoryFile(file, tokens),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }
          return right.file.relativePath.localeCompare(left.file.relativePath);
        })
        .slice(0, safeMaxResults);
    }

    if (ranked.length === 0) {
      return "- No relevant memory matches for the current task query.";
    }

    return ranked
      .map((entry) => {
        const snippetLimit = Math.min(
          RECALL_SNIPPET_SOFT_LIMIT,
          Math.max(1, Math.floor(entry.file.limit)),
        );
        const snippet = this.sliceMatchWindow(entry.file.body, tokens, snippetLimit);
        return `- ${entry.file.relativePath} (score: ${entry.score}, limit: ${entry.file.limit})\n  description: ${truncate(entry.file.description, 120)}\n  snippet: ${snippet}`;
      })
      .join("\n");
  }
}
