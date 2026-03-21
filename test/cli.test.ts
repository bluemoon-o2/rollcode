import { describe, expect, test } from "bun:test";
import { parseArgs, renderHelp } from "../src/cli";

describe("cli parsing", () => {
  test("parses resume with run id flag", () => {
    const parsed = parseArgs(["resume", "--run", "run-123"]);
    expect(parsed.command).toBe("resume");
    if (parsed.command !== "resume") {
      throw new Error("expected resume command");
    }
    expect(parsed.runId).toBe("run-123");
  });

  test("parses resume with positional run id", () => {
    const parsed = parseArgs(["resume", "run-456"]);
    expect(parsed.command).toBe("resume");
    if (parsed.command !== "resume") {
      throw new Error("expected resume command");
    }
    expect(parsed.runId).toBe("run-456");
  });

  test("rejects removed threads command", () => {
    expect(() => parseArgs(["threads"])).toThrow("Unknown command: threads");
  });

  test("parses version flag", () => {
    const parsed = parseArgs(["--version"]);
    expect(parsed.command).toBe("version");
  });

  test("parses help flag", () => {
    const parsed = parseArgs(["--help"]);
    expect(parsed.command).toBe("help");
  });

  test("parses info command", () => {
    const parsed = parseArgs(["info"]);
    expect(parsed.command).toBe("info");
  });

  test("parses memory command when only --agent is provided", () => {
    const parsed = parseArgs(["memory", "--agent", "agent-1"]);
    expect(parsed.command).toBe("memory");
    if (parsed.command !== "memory") {
      throw new Error("expected memory command");
    }
    expect(parsed.action).toBe("status");
    expect(parsed.agentId).toBe("agent-1");
  });

  test("parses doctor command and fix flag", () => {
    const plain = parseArgs(["doctor"]);
    expect(plain.command).toBe("doctor");
    if (plain.command !== "doctor") {
      throw new Error("expected doctor command");
    }
    expect(plain.fix).toBeFalse();

    const withFix = parseArgs(["doctor", "--fix"]);
    expect(withFix.command).toBe("doctor");
    if (withFix.command !== "doctor") {
      throw new Error("expected doctor command");
    }
    expect(withFix.fix).toBeTrue();
  });

  test("renders help from command and flag catalogs", () => {
    const help = renderHelp();
    expect(help).toContain("rollcode run <goal> [--detach]");
    expect(help).toContain("rollcode resume [--run <runId>]");
    expect(help).toContain("rollcode memory [status|diff|log] [--agent <id>]");
    expect(help).toContain("rollcode doctor [--fix]");
    expect(help).toContain("-h, --help");
    expect(help).toContain("-v, --version");
    expect(help).not.toContain("internal-run --run-id");
    expect(help).not.toContain("internal-helper-lane --request-path");
  });
});
