import { execFileSync } from "node:child_process";
import {
  FEEDBACK_DISCORD_URL,
  FEEDBACK_DISCUSSION_CATEGORY,
  FEEDBACK_GITHUB_REPO,
} from "../constants/feedback";
import { getVersion } from "../version";

const GH_VERSION_TIMEOUT_MS = 5_000;
const GH_AUTH_TIMEOUT_MS = 10_000;
const GH_GRAPHQL_TIMEOUT_MS = 20_000;
const MAX_DISCUSSION_BODY_LENGTH = 65_000;

interface CommandResult {
  ok: boolean;
  output: string;
  error: string;
}

interface GhRunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
}

export type GhCommandRunner = (
  command: string,
  args: string[],
  options?: GhRunOptions,
) => CommandResult;

function decodeCommandStream(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  return "";
}

const defaultGhRunner: GhCommandRunner = (
  command: string,
  args: string[],
  options?: GhRunOptions,
): CommandResult => {
  try {
    const output = execFileSync(command, args, {
      cwd: options?.cwd,
      encoding: "utf8",
      stdio: [options?.input ? "pipe" : "ignore", "pipe", "pipe"],
      timeout: options?.timeoutMs,
      ...(options?.input ? { input: options.input } : {}),
    }).trim();
    return { ok: true, output, error: "" };
  } catch (error) {
    const candidate = error as {
      stderr?: string | Uint8Array;
      stdout?: string | Uint8Array;
      message?: string;
    };
    const stderr = decodeCommandStream(candidate.stderr).trim();
    const stdout = decodeCommandStream(candidate.stdout).trim();
    const message = stderr || stdout || candidate.message || "Unknown error";
    return { ok: false, output: "", error: message };
  }
};

let ghAvailableCache: boolean | null = null;

export function resetGhAvailabilityCache(): void {
  ghAvailableCache = null;
}

export function parseScopesFromGhAuthStatus(rawStatus: string): string[] {
  const lines = rawStatus.split(/\r?\n/);
  const tokenScopeLine = lines.find((line) =>
    line.toLowerCase().includes("token scopes:"),
  );
  if (!tokenScopeLine) {
    return [];
  }

  const [, scopesRaw = ""] = tokenScopeLine.split(/token scopes:/i);
  return scopesRaw
    .split(",")
    .map((scope) => scope.replace(/['"`]/g, "").trim())
    .filter((scope) => scope.length > 0);
}

export interface GitHubAuthStatus {
  ok: boolean;
  scopes: string[];
  hasRepoScope: boolean;
  reason?: string;
  remediation?: string;
}

export function isGhAvailable(
  runner: GhCommandRunner = defaultGhRunner,
): boolean {
  if (runner === defaultGhRunner && ghAvailableCache !== null) {
    return ghAvailableCache;
  }
  const result = runner("gh", ["--version"], {
    timeoutMs: GH_VERSION_TIMEOUT_MS,
  });
  const available = result.ok;
  if (runner === defaultGhRunner) {
    ghAvailableCache = available;
  }
  return available;
}

export function checkGitHubAuthForDiscussionCreation(
  runner: GhCommandRunner = defaultGhRunner,
): GitHubAuthStatus {
  if (!isGhAvailable(runner)) {
    return {
      ok: false,
      scopes: [],
      hasRepoScope: false,
      reason: "GitHub CLI (gh) is not installed or not available in PATH.",
      remediation: "Install GitHub CLI: https://cli.github.com/",
    };
  }

  const status = runner("gh", ["auth", "status", "-h", "github.com"], {
    timeoutMs: GH_AUTH_TIMEOUT_MS,
  });
  if (!status.ok) {
    return {
      ok: false,
      scopes: [],
      hasRepoScope: false,
      reason: "GitHub CLI is not authenticated for github.com.",
      remediation: "Run: gh auth login",
    };
  }

  const scopes = parseScopesFromGhAuthStatus(status.output);
  const hasRepoScope = scopes.length === 0 ? true : scopes.includes("repo");
  const hasWriteDiscussionScope = scopes.includes("write:discussion");
  if (!hasRepoScope && !hasWriteDiscussionScope) {
    return {
      ok: false,
      scopes,
      hasRepoScope,
      reason:
        "GitHub CLI authentication is missing required scope (`repo` or `write:discussion`).",
      remediation:
        "Run: gh auth refresh -h github.com -s repo,write:discussion",
    };
  }

  return {
    ok: true,
    scopes,
    hasRepoScope,
  };
}

function truncateDiscussionBody(body: string): string {
  if (body.length <= MAX_DISCUSSION_BODY_LENGTH) {
    return body;
  }
  return `${body.slice(0, MAX_DISCUSSION_BODY_LENGTH)}\n\n---\n*Body truncated (exceeded 65K characters)*`;
}

function buildIssueTitle(message: string): string {
  const firstLine = message.split(/\r?\n/)[0]?.replace(/\s+/g, " ").trim();
  if (firstLine) {
    return `Feedback: ${firstLine}`.slice(0, 120);
  }
  const dateStamp = new Date().toISOString().slice(0, 10);
  return `Feedback: issue report (${dateStamp})`;
}

interface FeedbackContext {
  source?: "session" | "launcher" | "attach";
  runId?: string;
  runStatus?: string;
  goal?: string;
}

export interface FeedbackCommandContext extends FeedbackContext {
  cwd?: string;
}

export interface SubmitGitHubFeedbackInput {
  message?: string;
  cwd?: string;
  context?: FeedbackContext;
}

export interface SubmitGitHubDiscussionFeedbackSuccess {
  ok: true;
  discussionUrl: string;
  discussionNumber: number | null;
  repo: string;
  category: string;
}

export interface SubmitGitHubFeedbackFailure {
  ok: false;
  reason: string;
  remediation?: string;
}

export type SubmitGitHubDiscussionFeedbackResult =
  | SubmitGitHubDiscussionFeedbackSuccess
  | SubmitGitHubFeedbackFailure;

export type FeedbackCommandResolution =
  | { kind: "not-feedback" }
  | {
      kind: "needs-message";
      prefillCommand: string;
      hint: string;
    }
  | {
      kind: "submitted";
      message: string;
      discussionUrl: string;
    }
  | {
      kind: "submit-failed";
      message: string;
    };

function buildIssueBody(input: SubmitGitHubFeedbackInput): string {
  const message = input.message?.trim() ?? "";
  const context = input.context;
  const details: string[] = [
    `- version: ${getVersion()}`,
    `- submitted_at: ${new Date().toISOString()}`,
  ];
  if (input.cwd) {
    details.push(`- cwd: ${input.cwd}`);
  }
  if (context?.source) {
    details.push(`- source: ${context.source}`);
  }
  if (context?.runId) {
    details.push(`- run_id: ${context.runId}`);
  }
  if (context?.runStatus) {
    details.push(`- run_status: ${context.runStatus}`);
  }
  if (context?.goal) {
    details.push(`- run_goal: ${context.goal}`);
  }

  return [
    "## Feedback",
    message || "_No additional details provided._",
    "",
    "## Environment",
    ...details,
    "",
    "## Repro Steps",
    "1. Please fill in concrete reproduction steps.",
    "2. Include expected behavior.",
    "3. Include actual behavior.",
    "",
  ].join("\n");
}

interface RepoCoordinates {
  owner: string;
  name: string;
}

function parseRepoCoordinates(value: string): RepoCoordinates | null {
  const parts = value.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return {
    owner: parts[0],
    name: parts[1],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function parseGraphQlErrors(payload: Record<string, unknown>): string[] {
  const errors = asArray(payload.errors);
  return errors
    .map((entry) => asString(asRecord(entry)?.message))
    .filter((message): message is string => Boolean(message));
}

export function submitGitHubFeedbackDiscussion(
  input: SubmitGitHubFeedbackInput,
  runner: GhCommandRunner = defaultGhRunner,
): SubmitGitHubDiscussionFeedbackResult {
  const auth = checkGitHubAuthForDiscussionCreation(runner);
  if (!auth.ok) {
    return {
      ok: false,
      reason: auth.reason ?? "GitHub auth is not ready.",
      remediation: auth.remediation,
    };
  }

  const repo = parseRepoCoordinates(FEEDBACK_GITHUB_REPO);
  if (!repo) {
    return {
      ok: false,
      reason: `Invalid FEEDBACK_GITHUB_REPO format: ${FEEDBACK_GITHUB_REPO}`,
    };
  }

  const categoryQuery = [
    "query RollcodeFeedbackRepo($owner: String!, $name: String!) {",
    "  repository(owner: $owner, name: $name) {",
    "    id",
    "    discussionCategories(first: 100) {",
    "      nodes {",
    "        id",
    "        slug",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");

  const categoryLookup = runner(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `query=${categoryQuery}`,
      "-f",
      `owner=${repo.owner}`,
      "-f",
      `name=${repo.name}`,
    ],
    {
      cwd: input.cwd,
      timeoutMs: GH_GRAPHQL_TIMEOUT_MS,
    },
  );

  if (!categoryLookup.ok) {
    return {
      ok: false,
      reason:
        categoryLookup.error ||
        "Failed to query GitHub repository metadata for discussions.",
    };
  }

  const categoryPayload = parseJsonRecord(categoryLookup.output);
  if (!categoryPayload) {
    return {
      ok: false,
      reason: `Failed to parse GitHub GraphQL response: ${categoryLookup.output}`,
    };
  }

  const categoryErrors = parseGraphQlErrors(categoryPayload);
  if (categoryErrors.length > 0) {
    return {
      ok: false,
      reason: `GitHub GraphQL query failed: ${categoryErrors.join(" | ")}`,
    };
  }

  const repository = asRecord(asRecord(categoryPayload.data)?.repository);
  const repositoryId = asString(repository?.id);
  if (!repositoryId) {
    return {
      ok: false,
      reason: "GitHub GraphQL query did not return repository.id.",
    };
  }

  const categoryNodes = asArray(
    asRecord(repository?.discussionCategories)?.nodes,
  ).map((node) => asRecord(node));

  let categoryId: string | null = null;
  const availableCategories: string[] = [];
  for (const node of categoryNodes) {
    if (!node) {
      continue;
    }
    const slug = asString(node.slug);
    const id = asString(node.id);
    if (slug) {
      availableCategories.push(slug);
    }
    if (slug === FEEDBACK_DISCUSSION_CATEGORY && id) {
      categoryId = id;
      break;
    }
  }

  if (!categoryId) {
    return {
      ok: false,
      reason:
        availableCategories.length > 0
          ? `Discussion category '${FEEDBACK_DISCUSSION_CATEGORY}' not found. Available categories: ${availableCategories.join(", ")}`
          : `Discussion category '${FEEDBACK_DISCUSSION_CATEGORY}' not found.`,
    };
  }

  const mutation = [
    "mutation RollcodeCreateDiscussion($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {",
    "  createDiscussion(",
    "    input: {",
    "      repositoryId: $repositoryId",
    "      categoryId: $categoryId",
    "      title: $title",
    "      body: $body",
    "    }",
    "  ) {",
    "    discussion {",
    "      number",
    "      url",
    "    }",
    "  }",
    "}",
  ].join("\n");

  const createDiscussion = runner(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `query=${mutation}`,
      "-f",
      `repositoryId=${repositoryId}`,
      "-f",
      `categoryId=${categoryId}`,
      "-f",
      `title=${buildIssueTitle(input.message?.trim() ?? "")}`,
      "-f",
      `body=${truncateDiscussionBody(buildIssueBody(input))}`,
    ],
    {
      cwd: input.cwd,
      timeoutMs: GH_GRAPHQL_TIMEOUT_MS,
    },
  );

  if (!createDiscussion.ok) {
    return {
      ok: false,
      reason: createDiscussion.error || "Failed to create GitHub discussion.",
    };
  }

  const createPayload = parseJsonRecord(createDiscussion.output);
  if (!createPayload) {
    return {
      ok: false,
      reason: `Failed to parse GitHub GraphQL mutation response: ${createDiscussion.output}`,
    };
  }

  const mutationErrors = parseGraphQlErrors(createPayload);
  if (mutationErrors.length > 0) {
    return {
      ok: false,
      reason: `GitHub GraphQL mutation failed: ${mutationErrors.join(" | ")}`,
    };
  }

  const discussion = asRecord(
    asRecord(asRecord(createPayload.data)?.createDiscussion)?.discussion,
  );
  const discussionUrl = asString(discussion?.url);
  if (!discussionUrl) {
    return {
      ok: false,
      reason: "GitHub GraphQL mutation did not return discussion.url.",
    };
  }

  return {
    ok: true,
    discussionUrl,
    discussionNumber: asNumber(discussion?.number),
    repo: FEEDBACK_GITHUB_REPO,
    category: FEEDBACK_DISCUSSION_CATEGORY,
  };
}

function buildFeedbackSubmittedMessage(): string {
  return `Feedback submitted! To chat with the RollCode dev team live, join our Discord (${FEEDBACK_DISCORD_URL}).`;
}

export function resolveFeedbackCommand(
  command: string,
  context: FeedbackCommandContext,
  runner: GhCommandRunner = defaultGhRunner,
): FeedbackCommandResolution {
  const trimmed = command.trim();
  if (!(trimmed === "/feedback" || trimmed.startsWith("/feedback "))) {
    return { kind: "not-feedback" };
  }

  const message = trimmed.slice("/feedback".length).trim();
  if (!message) {
    return {
      kind: "needs-message",
      prefillCommand: "/feedback ",
      hint: "请输入反馈内容后回车提交（格式：/feedback 具体问题描述）",
    };
  }

  const submitted = submitGitHubFeedbackDiscussion(
    {
      message,
      cwd: context.cwd,
      context: {
        source: context.source,
        runId: context.runId,
        runStatus: context.runStatus,
        goal: context.goal,
      },
    },
    runner,
  );

  if (!submitted.ok) {
    const remediation = submitted.remediation
      ? ` ${submitted.remediation}`
      : "";
    return {
      kind: "submit-failed",
      message: `Failed to submit feedback via gh api graphql: ${submitted.reason}${remediation}`,
    };
  }

  return {
    kind: "submitted",
    message: buildFeedbackSubmittedMessage(),
    discussionUrl: submitted.discussionUrl,
  };
}
