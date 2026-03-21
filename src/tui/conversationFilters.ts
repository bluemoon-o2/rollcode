export type ConversationFilterMode =
  | "default"
  | "no-tools"
  | "user-only"
  | "labeled-only"
  | "all";

export const CONVERSATION_FILTER_MODES: readonly ConversationFilterMode[] = [
  "default",
  "no-tools",
  "user-only",
  "labeled-only",
  "all",
] as const;

const EVENT_PREFIX_PATTERN =
  /^\d{2}:\d{2}:\d{2} \[(worker|supervisor|system)\] ?/;
const COMMAND_EVENT_SUFFIX_PATTERN = /\(exit [^)]+\)$/;

export function cycleConversationFilterMode(
  current: ConversationFilterMode,
  direction: "forward" | "backward",
): ConversationFilterMode {
  const index = CONVERSATION_FILTER_MODES.indexOf(current);
  if (index < 0) {
    return "default";
  }
  if (direction === "forward") {
    return CONVERSATION_FILTER_MODES[
      (index + 1) % CONVERSATION_FILTER_MODES.length
    ] as ConversationFilterMode;
  }
  return CONVERSATION_FILTER_MODES[
    (index - 1 + CONVERSATION_FILTER_MODES.length) %
      CONVERSATION_FILTER_MODES.length
  ] as ConversationFilterMode;
}

export function toggleConversationFilterMode(
  current: ConversationFilterMode,
  target:
    | "no-tools"
    | "user-only"
    | "labeled-only"
    | "all"
    | "default",
): ConversationFilterMode {
  if (target === "default") {
    return "default";
  }
  return current === target ? "default" : target;
}

export function formatConversationFilterLabel(
  mode: ConversationFilterMode,
): string {
  switch (mode) {
    case "no-tools":
      return "[no-tools]";
    case "user-only":
      return "[user]";
    case "labeled-only":
      return "[labeled]";
    case "all":
      return "[all]";
    default:
      return "[default]";
  }
}

function extractEventBody(line: string): string {
  const normalized = line.replace(/\r/g, "");
  const lines = normalized.split("\n");
  const firstLine = (lines[0] ?? "").replace(EVENT_PREFIX_PATTERN, "").trim();
  return firstLine;
}

function isToolLikeEventLine(line: string): boolean {
  const body = extractEventBody(line);
  if (!body) {
    return false;
  }
  return COMMAND_EVENT_SUFFIX_PATTERN.test(body);
}

export function shouldShowEventLine(
  mode: ConversationFilterMode,
  line: string,
): boolean {
  switch (mode) {
    case "no-tools":
      return !isToolLikeEventLine(line);
    case "user-only":
    case "labeled-only":
      return false;
    case "default":
    case "all":
    default:
      return true;
  }
}

export interface ConversationVisibility {
  showGoal: boolean;
  showAssistant: boolean;
  showLabeledDetails: boolean;
  showEvents: boolean;
}

export function getConversationVisibility(
  mode: ConversationFilterMode,
): ConversationVisibility {
  return {
    showGoal: mode !== "labeled-only",
    showAssistant: mode === "default" || mode === "no-tools" || mode === "all",
    showLabeledDetails:
      mode === "default" || mode === "labeled-only" || mode === "all",
    showEvents:
      mode === "default" || mode === "no-tools" || mode === "all",
  };
}
