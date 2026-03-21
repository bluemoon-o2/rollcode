import { beforeEach, describe, expect, test } from "bun:test";
import {
  checkGitHubAuthForDiscussionCreation,
  parseScopesFromGhAuthStatus,
  resetGhAvailabilityCache,
  resolveFeedbackCommand,
  submitGitHubFeedbackDiscussion,
} from "../src/utils/githubFeedback";

describe("github feedback", () => {
  beforeEach(() => {
    resetGhAvailabilityCache();
  });

  test("parseScopesFromGhAuthStatus extracts token scopes", () => {
    const raw = [
      "github.com",
      "  ✓ Logged in to github.com account test (keyring)",
      "  - Token scopes: 'gist', 'repo', 'workflow'",
    ].join("\n");
    const scopes = parseScopesFromGhAuthStatus(raw);
    expect(scopes).toEqual(["gist", "repo", "workflow"]);
  });

  test("checkGitHubAuthForDiscussionCreation reports missing gh", () => {
    const runner = (_command: string, _args: string[]) => ({
      ok: false,
      output: "",
      error: "not found",
    });

    const result = checkGitHubAuthForDiscussionCreation(runner);
    expect(result.ok).toBeFalse();
    expect(result.remediation).toContain("Install GitHub CLI");
  });

  test("checkGitHubAuthForDiscussionCreation reports unauthenticated gh", () => {
    const runner = (_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { ok: true, output: "gh version 2.0.0", error: "" };
      }
      return { ok: false, output: "", error: "not logged in" };
    };

    const result = checkGitHubAuthForDiscussionCreation(runner);
    expect(result.ok).toBeFalse();
    expect(result.remediation).toContain("gh auth login");
  });

  test("submitGitHubFeedbackDiscussion creates GitHub discussion when auth is ready", () => {
    const calls: string[][] = [];
    const runner = (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "--version") {
        return { ok: true, output: "gh version 2.0.0", error: "" };
      }
      if (args[0] === "auth" && args[1] === "status") {
        return {
          ok: true,
          output: "  - Token scopes: 'repo', 'workflow'",
          error: "",
        };
      }
      if (args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("discussionCategories")) {
          return {
            ok: true,
            output: JSON.stringify({
              data: {
                repository: {
                  id: "R_kgDOExample",
                  discussionCategories: {
                    nodes: [
                      { id: "DIC_kwDOExample_1", slug: "general" },
                      { id: "DIC_kwDOExample_2", slug: "ideas" },
                    ],
                  },
                },
              },
            }),
            error: "",
          };
        }
        if (queryArg.includes("createDiscussion")) {
          return {
            ok: true,
            output: JSON.stringify({
              data: {
                createDiscussion: {
                  discussion: {
                    number: 456,
                    url: "https://github.com/bluemoon-o2/rollcode/discussions/456",
                  },
                },
              },
            }),
            error: "",
          };
        }
      }
      return { ok: false, output: "", error: "unexpected command" };
    };

    const result = submitGitHubFeedbackDiscussion(
      {
        message: "runtime got stuck",
        cwd: "/tmp/project",
      },
      runner,
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) {
      return;
    }
    expect(result.discussionNumber).toBe(456);
    expect(result.discussionUrl).toBe(
      "https://github.com/bluemoon-o2/rollcode/discussions/456",
    );
    expect(
      calls.filter((args) => args[0] === "api" && args[1] === "graphql").length,
    ).toBe(2);
  });

  test("submitGitHubFeedbackDiscussion returns failure when discussion category is missing", () => {
    const runner = (_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { ok: true, output: "gh version 2.0.0", error: "" };
      }
      if (args[0] === "auth" && args[1] === "status") {
        return {
          ok: true,
          output: "  - Token scopes: 'repo', 'workflow'",
          error: "",
        };
      }
      if (args[0] === "api" && args[1] === "graphql") {
        return {
          ok: true,
          output: JSON.stringify({
            data: {
              repository: {
                id: "R_kgDOExample",
                discussionCategories: {
                  nodes: [{ id: "DIC_kwDOExample_2", slug: "ideas" }],
                },
              },
            },
          }),
          error: "",
        };
      }
      return { ok: false, output: "", error: "unexpected command" };
    };

    const result = submitGitHubFeedbackDiscussion(
      {
        message: "runtime got stuck",
      },
      runner,
    );

    expect(result.ok).toBeFalse();
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("Discussion category 'general' not found");
  });

  test("resolveFeedbackCommand requests message for bare command", () => {
    const result = resolveFeedbackCommand("/feedback", {
      cwd: "/tmp/project",
      source: "launcher",
    });
    expect(result.kind).toBe("needs-message");
    if (result.kind !== "needs-message") {
      return;
    }
    expect(result.prefillCommand).toBe("/feedback ");
  });

  test("resolveFeedbackCommand submits discussion for valid message", () => {
    const runner = (_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { ok: true, output: "gh version 2.0.0", error: "" };
      }
      if (args[0] === "auth" && args[1] === "status") {
        return {
          ok: true,
          output: "  - Token scopes: 'repo', 'workflow'",
          error: "",
        };
      }
      if (args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("discussionCategories")) {
          return {
            ok: true,
            output: JSON.stringify({
              data: {
                repository: {
                  id: "R_kgDOExample",
                  discussionCategories: {
                    nodes: [{ id: "DIC_kwDOExample_1", slug: "general" }],
                  },
                },
              },
            }),
            error: "",
          };
        }
        return {
          ok: true,
          output: JSON.stringify({
            data: {
              createDiscussion: {
                discussion: {
                  number: 456,
                  url: "https://github.com/bluemoon-o2/rollcode/discussions/456",
                },
              },
            },
          }),
          error: "",
        };
      }
      return { ok: false, output: "", error: "unexpected command" };
    };

    const result = resolveFeedbackCommand(
      "/feedback test message",
      {
        cwd: "/tmp/project",
        source: "session",
        runId: "run-123",
        runStatus: "blocked",
        goal: "debug feedback flow",
      },
      runner,
    );

    expect(result.kind).toBe("submitted");
    if (result.kind !== "submitted") {
      return;
    }
    expect(result.discussionUrl).toBe(
      "https://github.com/bluemoon-o2/rollcode/discussions/456",
    );
    expect(result.message).toBe(
      "Feedback submitted! To chat with the RollCode dev team live, join our Discord (https://discord.gg/u6T5e2kGJm).",
    );
  });

  test("resolveFeedbackCommand surfaces GraphQL failure", () => {
    const runner = (_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { ok: true, output: "gh version 2.0.0", error: "" };
      }
      if (args[0] === "auth" && args[1] === "status") {
        return {
          ok: true,
          output: "  - Token scopes: 'repo', 'workflow'",
          error: "",
        };
      }
      if (args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((entry) => entry.startsWith("query=")) ?? "";
        if (queryArg.includes("discussionCategories")) {
          return {
            ok: true,
            output: JSON.stringify({
              data: {
                repository: {
                  id: "R_kgDOExample",
                  discussionCategories: {
                    nodes: [{ id: "DIC_kwDOExample_1", slug: "general" }],
                  },
                },
              },
            }),
            error: "",
          };
        }
        return {
          ok: true,
          output: JSON.stringify({
            errors: [{ message: "Resource not accessible by integration" }],
          }),
          error: "",
        };
      }
      return { ok: false, output: "", error: "unexpected command" };
    };

    const result = resolveFeedbackCommand(
      "/feedback test message",
      {
        cwd: "/tmp/project",
        source: "session",
      },
      runner,
    );
    expect(result.kind).toBe("submit-failed");
    if (result.kind !== "submit-failed") {
      return;
    }
    expect(result.message).toContain(
      "Failed to submit feedback via gh api graphql",
    );
    expect(result.message).toContain("Resource not accessible by integration");
  });
});
