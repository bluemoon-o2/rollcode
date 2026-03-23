import { fuzzyFilter } from "./fuzzy";

export type SlashCommandArgumentMode = "none" | "optional" | "required";

export interface SlashCommandSpec {
  command: string;
  description: string;
  argumentMode?: SlashCommandArgumentMode;
  argumentHint?: string;
}

export interface SlashAutocompleteState {
  active: boolean;
  query: string;
  matches: SlashCommandSpec[];
  showNoMatches: boolean;
}

const FEEDBACK_ARGUMENT_HINT =
  "请输入反馈内容后回车提交（格式：/feedback 具体问题描述）";

const SESSION_COMMANDS: SlashCommandSpec[] = [
  {
    command: "/supervisor",
    description: "Toggle details (/supervisor on|off|status)",
    argumentMode: "optional",
  },
  {
    command: "/memory",
    description: "Memory status/profile/remember",
    argumentMode: "optional",
  },
  {
    command: "/skills",
    description: "Show resolved skills in stream",
    argumentMode: "optional",
  },
  {
    command: "/skills reload",
    description: "Reload current skill catalog",
    argumentMode: "none",
  },
  {
    command: "/codex",
    description: "Configure Codex auth/config files",
    argumentMode: "none",
  },
  {
    command: "/changelog",
    description: "Show changelog entries",
    argumentMode: "none",
  },
  {
    command: "/doctor",
    description: "Run runtime health diagnostics",
    argumentMode: "optional",
  },
  {
    command: "/doctor fix",
    description: "Run diagnostics and auto-fix safe issues",
    argumentMode: "none",
  },
  {
    command: "/hotkeys",
    description: "Show all keyboard shortcuts",
    argumentMode: "none",
  },
  {
    command: "/new",
    description: "Start a new session",
    argumentMode: "none",
  },
  {
    command: "/resume",
    description: "Resume current run",
    argumentMode: "none",
  },
  {
    command: "/feedback",
    description: "Submit feedback: /feedback <message>",
    argumentMode: "required",
    argumentHint: FEEDBACK_ARGUMENT_HINT,
  },
  { command: "/exit", description: "Exit RollCode", argumentMode: "none" },
];

const VIEWER_ONLY_COMMANDS: SlashCommandSpec[] = SESSION_COMMANDS.filter(
  (item) => item.command !== "/resume",
);

const LAUNCHER_COMMANDS: SlashCommandSpec[] = [
  { command: "/new", description: "Start a new session", argumentMode: "none" },
  {
    command: "/resume",
    description: "Resume a different session",
    argumentMode: "none",
  },
  {
    command: "/feedback",
    description: "Submit feedback: /feedback <message>",
    argumentMode: "required",
    argumentHint: FEEDBACK_ARGUMENT_HINT,
  },
  {
    command: "/codex",
    description: "Configure Codex auth/config files",
    argumentMode: "none",
  },
  {
    command: "/changelog",
    description: "Show changelog entries",
    argumentMode: "none",
  },
  {
    command: "/hotkeys",
    description: "Show all keyboard shortcuts",
    argumentMode: "none",
  },
  { command: "/exit", description: "Exit RollCode", argumentMode: "none" },
];

function extractSearchQuery(
  input: string,
  cursorPosition: number,
): { query: string; hasSpaceAfter: boolean } | null {
  if (!input.startsWith("/")) {
    return null;
  }

  const afterSlash = input.slice(1);
  const spaceIndex = afterSlash.indexOf(" ");
  const endPos = spaceIndex === -1 ? input.length : 1 + spaceIndex;
  if (cursorPosition < 0 || cursorPosition > endPos) {
    return null;
  }
  const rawQuery =
    spaceIndex === -1 ? afterSlash : afterSlash.slice(0, spaceIndex);
  const query = rawQuery.trim();
  return {
    query,
    hasSpaceAfter: spaceIndex !== -1,
  };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  if (index < 0) {
    return 0;
  }
  if (index >= length) {
    return length - 1;
  }
  return index;
}

function parseSlashCommandInput(
  input: string,
): { command: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [command = "", ...argParts] = trimmed.split(/\s+/);
  return {
    command,
    args: argParts.join(" ").trim(),
  };
}

function resolveArgumentMode(
  spec: SlashCommandSpec | null,
): SlashCommandArgumentMode {
  return spec?.argumentMode ?? "optional";
}

export function getSlashCommands(viewerOnly: boolean): SlashCommandSpec[] {
  return viewerOnly ? VIEWER_ONLY_COMMANDS : SESSION_COMMANDS;
}

export function getLauncherSlashCommands(): SlashCommandSpec[] {
  return LAUNCHER_COMMANDS;
}

export function buildSlashAutocompleteState(
  input: string,
  commands: SlashCommandSpec[],
  cursorPosition = input.length,
): SlashAutocompleteState {
  const queryInfo = extractSearchQuery(input, cursorPosition);
  if (!queryInfo) {
    return {
      active: false,
      query: "",
      matches: [],
      showNoMatches: false,
    };
  }

  if (queryInfo.hasSpaceAfter) {
    return {
      active: false,
      query: queryInfo.query,
      matches: [],
      showNoMatches: false,
    };
  }

  if (!queryInfo.query) {
    return {
      active: true,
      query: "",
      matches: commands,
      showNoMatches: false,
    };
  }

  const exactCommand = commands.find(
    (item) => item.command === `/${queryInfo.query}`,
  );
  if (exactCommand && resolveArgumentMode(exactCommand) === "none") {
    return {
      active: false,
      query: queryInfo.query,
      matches: [],
      showNoMatches: false,
    };
  }

  const matches = fuzzyFilter(commands, queryInfo.query, (item) =>
    item.command.slice(1),
  );

  return {
    active: true,
    query: queryInfo.query,
    matches,
    showNoMatches: matches.length === 0,
  };
}

export function getSelectedSlashCommand(
  state: SlashAutocompleteState,
  selectedIndex: number,
): string | null {
  if (!state.active || state.matches.length === 0) {
    return null;
  }
  const index = clampIndex(selectedIndex, state.matches.length);
  return state.matches[index]?.command ?? null;
}

export function getSlashCommandSpec(
  commands: SlashCommandSpec[],
  command: string,
): SlashCommandSpec | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  const exact = commands.find((item) => item.command === trimmed);
  if (exact) {
    return exact;
  }

  const token = trimmed.split(/\s+/)[0] ?? "";
  return commands.find((item) => item.command === token) ?? null;
}

export function formatSlashCommandForInput(
  command: string,
  commands: SlashCommandSpec[],
): string {
  const spec = getSlashCommandSpec(commands, command);
  if (!spec) {
    return command.trim();
  }
  const mode = resolveArgumentMode(spec);
  if (mode === "none") {
    return spec.command;
  }
  return `${spec.command} `;
}

export type SlashCommandValidationResult =
  | { kind: "ok" }
  | {
      kind: "missing-arguments";
      command: string;
      hint: string;
      prefill: string;
    }
  | {
      kind: "unexpected-arguments";
      command: string;
      hint: string;
    };

export function validateSlashCommandInput(
  input: string,
  commands: SlashCommandSpec[],
): SlashCommandValidationResult {
  const parsed = parseSlashCommandInput(input);
  if (!parsed) {
    return { kind: "ok" };
  }

  const spec = getSlashCommandSpec(commands, parsed.command);
  if (!spec) {
    return { kind: "ok" };
  }

  const mode = resolveArgumentMode(spec);
  if (mode === "required" && parsed.args.length === 0) {
    return {
      kind: "missing-arguments",
      command: spec.command,
      hint:
        spec.argumentHint ?? `Please provide arguments for ${spec.command}.`,
      prefill: formatSlashCommandForInput(spec.command, commands),
    };
  }

  if (mode === "none" && parsed.args.length > 0) {
    return {
      kind: "unexpected-arguments",
      command: spec.command,
      hint: `${spec.command} does not accept arguments.`,
    };
  }

  return { kind: "ok" };
}

export function resolveSubmittedInput(
  input: string,
  state: SlashAutocompleteState,
  selectedIndex: number,
  commands?: SlashCommandSpec[],
): string {
  const raw = input.trim();
  if (!raw) {
    return "";
  }
  const trimmed = raw;
  if (state.matches.some((item) => item.command === trimmed)) {
    return trimmed;
  }
  if (
    commands &&
    trimmed.startsWith("/") &&
    !trimmed.includes(" ") &&
    trimmed !== "/"
  ) {
    const exact = commands.some((item) => item.command === trimmed);
    if (!exact) {
      const query = trimmed.slice(1).trim();
      if (query.length > 0) {
        const fallbackMatches = fuzzyFilter(commands, query, (item) =>
          item.command.slice(1),
        );
        if (fallbackMatches.length > 0) {
          const index = clampIndex(selectedIndex, fallbackMatches.length);
          return fallbackMatches[index]?.command ?? trimmed;
        }
      }
    }
  }
  if (trimmed === "/" && state.active && state.matches.length > 0) {
    if (selectedIndex > 0) {
      return getSelectedSlashCommand(state, selectedIndex) ?? trimmed;
    }
    return trimmed;
  }
  if (!state.active || !trimmed.startsWith("/") || trimmed.includes(" ")) {
    return trimmed;
  }
  if (!state.query.trim()) {
    return trimmed;
  }
  return getSelectedSlashCommand(state, selectedIndex) ?? trimmed;
}
