import { getVersion } from "./version";

export type ParsedArgs =
  | {
      command: "run";
      goal: string;
      detach: boolean;
      agentId?: string;
    }
  | {
      command: "resume";
      agentId?: string;
      runId?: string;
    }
  | {
      command: "attach";
      runId: string;
    }
  | {
      command: "agents";
    }
  | {
      command: "memory";
      action: "status" | "diff" | "log";
      agentId?: string;
    }
  | {
      command: "doctor";
      fix: boolean;
    }
  | {
      command: "internal-run";
      runId: string;
    }
  | {
      command: "internal-helper-lane";
      requestPath: string;
      responsePath: string;
    }
  | {
      command: "default";
    }
  | {
      command: "help";
    }
  | {
      command: "version";
    }
  | {
      command: "info";
    };

type CommandParser = (args: string[]) => ParsedArgs;

interface CliCommandDefinition {
  synopsis: string;
  description: string;
  parse: CommandParser;
  hidden?: boolean;
}

interface CliFlagDefinition {
  short?: string;
  description: string;
}

const HELP_LABEL_WIDTH = 22;

const GLOBAL_FLAGS = {
  help: {
    short: "h",
    description: "Show this help and exit",
  },
  version: {
    short: "v",
    description: "Print version and exit",
  },
} as const satisfies Record<string, CliFlagDefinition>;

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function firstPositional(
  args: string[],
  valueFlags: string[] = [],
): string | undefined {
  const valueFlagSet = new Set(valueFlags);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      if (valueFlagSet.has(arg)) {
        index += 1;
      }
      continue;
    }
    return arg;
  }
  return undefined;
}

function parseRun(args: string[]): ParsedArgs {
  const goal = firstPositional(args, ["--agent"]);
  if (!goal) {
    throw new Error("rollcode run requires a goal string");
  }
  return {
    command: "run",
    goal,
    detach: args.includes("--detach"),
    agentId: readFlagValue(args, "--agent"),
  };
}

function parseResume(args: string[]): ParsedArgs {
  return {
    command: "resume",
    agentId: readFlagValue(args, "--agent"),
    runId: readFlagValue(args, "--run") ?? firstPositional(args, ["--agent"]),
  };
}

function parseAttach(args: string[]): ParsedArgs {
  const runId = args[0];
  if (!runId) {
    throw new Error("rollcode attach requires a run id");
  }
  return { command: "attach", runId };
}

function parseMemory(args: string[]): ParsedArgs {
  const actionCandidate = firstPositional(args, ["--agent"]);
  const action = (actionCandidate ?? "status") as "status" | "diff" | "log";
  if (!["status", "diff", "log"].includes(action)) {
    throw new Error("memory command must be one of: status, diff, log");
  }
  return {
    command: "memory",
    action,
    agentId: readFlagValue(args, "--agent"),
  };
}

function parseInternalRun(args: string[]): ParsedArgs {
  const runId = readFlagValue(args, "--run-id");
  if (!runId) {
    throw new Error("internal-run requires --run-id <id>");
  }
  return { command: "internal-run", runId };
}

function parseDoctor(args: string[]): ParsedArgs {
  return {
    command: "doctor",
    fix: args.includes("--fix"),
  };
}

function parseInternalHelperLane(args: string[]): ParsedArgs {
  const requestPath = readFlagValue(args, "--request-path");
  const responsePath = readFlagValue(args, "--response-path");
  if (!requestPath || !responsePath) {
    throw new Error(
      "internal-helper-lane requires --request-path <path> --response-path <path>",
    );
  }
  return {
    command: "internal-helper-lane",
    requestPath,
    responsePath,
  };
}

const COMMAND_CATALOG: Record<string, CliCommandDefinition> = {
  run: {
    synopsis: "run <goal> [--detach]",
    description: "Start interactive RollCode session with initial goal",
    parse: parseRun,
  },
  resume: {
    synopsis: "resume [--run <runId>]",
    description: "Open run history picker or resume matching run id/prefix",
    parse: parseResume,
  },
  attach: {
    synopsis: "attach <runId>",
    description: "Attach to an existing run by id/prefix",
    parse: parseAttach,
  },
  agents: {
    synopsis: "agents",
    description: "List persisted agents and latest run status",
    parse: () => ({ command: "agents" }),
  },
  info: {
    synopsis: "info",
    description: "Show local RollCode runtime paths",
    parse: () => ({ command: "info" }),
  },
  memory: {
    synopsis: "memory [status|diff|log] [--agent <id>]",
    description: "Inspect git-backed memory for current or selected agent",
    parse: parseMemory,
  },
  doctor: {
    synopsis: "doctor [--fix]",
    description:
      "Check runtime health (stale owners/sessions/checkpoints/worktrees)",
    parse: parseDoctor,
  },
  "internal-run": {
    synopsis: "internal-run --run-id <id>",
    description: "Internal detached runtime entrypoint",
    parse: parseInternalRun,
    hidden: true,
  },
  "internal-helper-lane": {
    synopsis:
      "internal-helper-lane --request-path <path> --response-path <path>",
    description: "Internal helper lane subprocess entrypoint",
    parse: parseInternalHelperLane,
    hidden: true,
  },
};

function formatFlagLabel(name: string, definition: CliFlagDefinition): string {
  const longName = `--${name}`;
  if (!definition.short) {
    return longName;
  }
  return `-${definition.short}, ${longName}`;
}

function renderFlagsHelp(): string {
  return Object.entries(GLOBAL_FLAGS)
    .map(([name, definition]) => {
      const label = formatFlagLabel(name, definition);
      if (label.length >= HELP_LABEL_WIDTH) {
        return `  ${label}\n  ${"".padEnd(HELP_LABEL_WIDTH)}${definition.description}`;
      }
      return `  ${label}${" ".repeat(HELP_LABEL_WIDTH - label.length)}${definition.description}`;
    })
    .join("\n");
}

function renderCommandsHelp(): string {
  return Object.values(COMMAND_CATALOG)
    .filter((definition) => !definition.hidden)
    .map((definition) => {
      const label = `rollcode ${definition.synopsis}`;
      if (label.length >= HELP_LABEL_WIDTH) {
        return `  ${label}\n  ${"".padEnd(HELP_LABEL_WIDTH)}${definition.description}`;
      }
      return `  ${label}${" ".repeat(HELP_LABEL_WIDTH - label.length)}${definition.description}`;
    })
    .join("\n");
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return { command: "default" };
  }

  const [command, ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  if (command === "version" || command === "--version" || command === "-v") {
    return { command: "version" };
  }

  const definition = COMMAND_CATALOG[command];
  if (!definition) {
    throw new Error(`Unknown command: ${command}`);
  }
  return definition.parse(rest);
}

export function renderHelp(): string {
  return `
RollCode v${getVersion()}

Usage:
  rollcode
${renderCommandsHelp()}

Global options:
${renderFlagsHelp()}
  `.trim();
}
