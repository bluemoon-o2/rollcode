import { Box, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkerHandoff,
  RunSnapshot,
  RunStatus,
  SupervisorDecision,
  WorkerTurnOutput,
} from "../domain/types";
import type { SessionController } from "../runtime/service";
import { TUI_ANIMATIONS_ENABLED } from "./animation";
import { AssistantMessage } from "./components/AssistantMessage";
import { BlinkDot } from "./components/BlinkDot";
import {
  COMMAND_PREVIEW_LINES,
  CommandMessage,
} from "./components/CommandMessage";
import {
  CodexConfigDialog,
  type CodexConfigDialogResult,
} from "./components/CodexConfigDialog";
import { shouldCollapseOutput } from "./components/CollapsedOutputDisplay";
import { colors } from "./components/colors";
import {
  EventStreamLine,
  shouldCollapseEventLine,
} from "./components/EventStreamLine";
import { ExpandableDetailsMessage } from "./components/ExpandableDetailsMessage";
import { FlowingRoleLabel } from "./components/FlowingRoleLabel";
import { AnimationProvider } from "./contexts/AnimationContext";
import {
  EXPAND_TOOLS_KEY,
  expandToolsHint,
  formatKeyHint,
  formatKeyForDisplay,
} from "./components/keybindingHints";
import { InfoOverlay } from "./components/InfoOverlay";
import { PatchedTextInput } from "./components/PatchedTextInput";
import { SlashCommandAutocomplete } from "./components/SlashCommandAutocomplete";
import { Text } from "./components/Text";
import { UserMessage } from "./components/UserMessage";
import { WorkerHandoffMessage } from "./components/WorkerHandoffMessage";
import {
  parseCommandOutput,
  summarizeCommandEntries,
} from "./commandOutputParser";
import {
  buildChangelogMarkdown,
  buildSessionHotkeysMarkdown,
} from "./helpContent";
import { sanitizeLauncherInput } from "./launcherInput";
import {
  buildSlashAutocompleteState,
  formatSlashCommandForInput,
  getSelectedSlashCommand,
  getSlashCommands,
  resolveSubmittedInput,
  validateSlashCommandInput,
} from "./slashCommands";
import { buildHorizontalLine } from "./terminal";

const EVENT_STREAM_MAX_LINES = 18;
const DIFF_PREVIEW_COLLAPSED_LINES = 8;
const MIN_EVENT_STREAM_LINES = 6;
const RESIZE_SETTLE_DELAY_MS = 220;
const ANIMATION_RESUME_HYSTERESIS_ROWS = 2;
const CTRL_SHORTCUT_TOGGLE_DEDUPE_MS = 120;
const DENSITY_TOGGLE_KEY = "ctrl+u";
type ConversationDensity = "immersive" | "compact";
const CTRL_SHORTCUT_CHAR_MAP = {
  o: "\u000f",
  u: "\u0015",
} as const;

function matchesCtrlShortcut(
  typedInput: string,
  ctrl: boolean,
  letter: keyof typeof CTRL_SHORTCUT_CHAR_MAP,
): boolean {
  if (typedInput === CTRL_SHORTCUT_CHAR_MAP[letter]) {
    return true;
  }
  if (!ctrl) {
    return false;
  }
  return typedInput.toLowerCase() === letter;
}

function isRawCtrlShortcut(
  typedInput: string,
  letter: keyof typeof CTRL_SHORTCUT_CHAR_MAP,
): boolean {
  return typedInput === CTRL_SHORTCUT_CHAR_MAP[letter];
}

function isRunAnimating(snapshot: RunSnapshot): boolean {
  if (snapshot.activeThreadRole) {
    return true;
  }
  return (
    snapshot.run.status === "working" ||
    snapshot.run.status === "supervising" ||
    snapshot.run.status === "repairing"
  );
}

function getRunPhaseLabel(snapshot: RunSnapshot): string {
  if (snapshot.activeThreadRole === "worker") {
    return "worker executing";
  }
  if (snapshot.activeThreadRole === "supervisor") {
    return "supervisor reviewing";
  }
  switch (snapshot.run.status) {
    case "working":
      return "worker queued";
    case "supervising":
      return "supervisor queued";
    case "repairing":
      return "repair cycle";
    case "blocked":
      return "awaiting operator input";
    case "completed":
      return "goal completed";
    case "interrupted":
      return "interrupted";
    default:
      return snapshot.run.status;
  }
}

function getRunStatusColor(status: RunStatus): string {
  switch (status) {
    case "working":
      return colors.progress.working;
    case "supervising":
      return colors.progress.supervising;
    case "repairing":
      return colors.progress.repairing;
    case "blocked":
      return colors.progress.blocked;
    case "interrupted":
      return colors.progress.interrupted;
    case "completed":
      return colors.progress.completed;
    default:
      return colors.progress.idle;
  }
}

function getRunStatusSymbol(status: RunStatus): string {
  switch (status) {
    case "completed":
      return "●";
    case "blocked":
      return "▲";
    case "interrupted":
      return "■";
    default:
      return "·";
  }
}

function formatPlanOutput(plan: RunSnapshot["plan"]): string {
  if (plan.length === 0) {
    return "";
  }
  return plan
    .map((step) => {
      const marker =
        step.status === "completed"
          ? "✓"
          : step.status === "in_progress"
            ? "…"
            : "·";
      return `${marker} ${step.step}`;
    })
    .join("\n");
}

function formatSupervisorDecision(
  decision: SupervisorDecision | null,
): string {
  if (!decision) {
    return "";
  }
  const { action, rationale, nextInstruction } = decision;
  const next = nextInstruction ? `\nnext: ${nextInstruction}` : "";
  return `${action}: ${rationale}${next}`;
}

function summarizeSupervisorDecision(
  decision: SupervisorDecision | null,
  reviewing: boolean,
): string {
  if (!decision) {
    return "";
  }
  const base = `${decision.action}: ${decision.rationale}`.replace(/\s+/g, " ").trim();
  if (!base) {
    return "supervisor update";
  }
  if (reviewing) {
    return `${base} (reviewing...)`;
  }
  if (base.length <= 96) {
    return base;
  }
  return `${base.slice(0, 93)}...`;
}

function summarizePlan(plan: RunSnapshot["plan"]): string {
  const total = plan.length;
  if (total === 0) {
    return "no plan steps";
  }
  const completed = plan.filter((step) => step.status === "completed").length;
  const inProgress = plan.filter(
    (step) => step.status === "in_progress",
  ).length;
  return `${completed}/${total} completed, ${inProgress} in progress`;
}

function summarizeDiff(diff: string): string {
  const lines = diff.split("\n");
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+++")) {
      continue;
    }
    if (line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      removed += 1;
    }
  }
  if (added === 0 && removed === 0) {
    return "diff preview";
  }
  return `+${added} / -${removed} lines`;
}

function sanitizeSingleLine(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateSingleLine(value: string, maxWidth: number): string {
  const normalized = sanitizeSingleLine(value);
  if (maxWidth <= 0) {
    return "";
  }
  if (normalized.length <= maxWidth) {
    return normalized;
  }
  if (maxWidth <= 1) {
    return normalized.slice(0, 1);
  }
  return `${normalized.slice(0, maxWidth - 1)}…`;
}

function formatCompactCount(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  if (value < 10000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  if (value < 1000000) {
    return `${Math.round(value / 1000)}k`;
  }
  if (value < 10000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  return `${Math.round(value / 1000000)}M`;
}

function buildTwoColumnFooterLine(options: {
  width: number;
  left: string;
  right: string;
  minGap?: number;
}): string {
  const minGap = Math.max(1, options.minGap ?? 2);
  const maxWidth = Math.max(1, options.width);
  let left = sanitizeSingleLine(options.left);
  let right = sanitizeSingleLine(options.right);

  if (!right) {
    return truncateSingleLine(left, maxWidth);
  }
  if (!left) {
    return truncateSingleLine(right, maxWidth);
  }

  if (left.length + minGap + right.length <= maxWidth) {
    return `${left}${" ".repeat(maxWidth - left.length - right.length)}${right}`;
  }

  if (right.length >= maxWidth - minGap) {
    right = truncateSingleLine(right, Math.max(1, maxWidth - minGap));
    return right;
  }

  const availableForLeft = maxWidth - right.length - minGap;
  left = truncateSingleLine(left, Math.max(1, availableForLeft));
  if (left.length + minGap + right.length <= maxWidth) {
    return `${left}${" ".repeat(maxWidth - left.length - right.length)}${right}`;
  }
  return truncateSingleLine(`${left} ${right}`, maxWidth);
}

function shortId(value: string, size = 8): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "-";
  }
  if (trimmed.length <= size) {
    return trimmed;
  }
  return trimmed.slice(0, size);
}

function formatCwdForFooter(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

function countTextLines(value: string): number {
  if (!value) {
    return 0;
  }
  return value.replace(/\r/g, "").split("\n").length;
}

function estimateCollapsedTextLines(options: {
  text: string;
  expanded: boolean;
  maxLines: number;
  maxChars?: number;
}): number {
  const { text, expanded, maxLines, maxChars } = options;
  if (!text) {
    return 0;
  }

  const clippedByChars =
    typeof maxChars === "number" &&
    maxChars > 0 &&
    text.length > maxChars;
  const renderedText = clippedByChars ? `${text.slice(0, maxChars)}…` : text;
  const totalLines = countTextLines(renderedText);

  if (expanded) {
    return totalLines;
  }

  if (totalLines > maxLines) {
    return maxLines + 1;
  }
  if (clippedByChars) {
    return totalLines + 1;
  }
  return totalLines;
}

function estimateHandoffLines(handoff: WorkerHandoff, expanded: boolean): number {
  if (!expanded) {
    return 1;
  }
  const summaryLineCount = Math.max(
    1,
    countTextLines(handoff.summary.trim() || "(missing summary)"),
  );
  const evidenceLineCount = Math.max(1, handoff.evidence.length);
  const unresolvedLineCount = Math.max(1, handoff.unresolved.length);
  // Header row + markdown content rows from formatExpandedBody(...)
  return summaryLineCount + evidenceLineCount + unresolvedLineCount + 9;
}

function normalizeCommandOutput(output: string): string {
  return output
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+$/, "");
}

function estimateCommandMessageLines(options: {
  output: string;
  expanded: boolean;
  maxPreviewLines: number;
  phase?: "running" | "waiting" | "finished";
  success?: boolean;
  exitCode?: number | null;
}): number {
  if (options.phase === "waiting") {
    return 0;
  }
  const normalizedOutput = normalizeCommandOutput(options.output);
  const outputLines = normalizedOutput ? normalizedOutput.split("\n") : [];
  const previewLines = options.expanded
    ? outputLines.length
    : Math.min(outputLines.length, Math.max(1, options.maxPreviewLines));
  const hiddenLineCount = Math.max(0, outputLines.length - previewLines);

  let lines = 3; // top border + input + bottom border
  lines += previewLines;
  if (options.phase === "running") {
    lines += 1;
  }
  if (options.phase !== "running" && hiddenLineCount > 0) {
    lines += 1;
  }
  if (
    options.phase !== "running" &&
    (options.success === false || options.exitCode === null)
  ) {
    lines += 1;
  }
  return lines;
}

const EVENT_PREFIX_PATTERN =
  /^(\d{2}:\d{2}:\d{2}) \[(worker|supervisor|system)\] ?(.*)$/;

function classifyTransientEventGroup(
  role: "worker" | "supervisor" | "system" | null,
  body: string,
): string | null {
  if (role !== "system") {
    return null;
  }
  const normalized = body.trim().toLowerCase();
  if (
    normalized.startsWith("transient upstream error during ") &&
    normalized.includes(" retrying (") &&
    normalized.includes(" in ") &&
    normalized.includes("ms")
  ) {
    return "system:transient-retry";
  }
  if (
    normalized.includes(
      "supervisor strict schema rejected by upstream; retrying once with legacy-compatible schema",
    )
  ) {
    return "system:schema-fallback-retry";
  }
  return null;
}

function extractEventBody(line: string): string {
  const normalized = line.replace(/\r/g, "");
  const parts = normalized.split("\n");
  if (parts.length === 0) {
    return "";
  }
  const [first, ...rest] = parts;
  const parsed = EVENT_PREFIX_PATTERN.exec(first ?? "");
  if (!parsed) {
    return normalized;
  }
  const body = parsed[3] ?? "";
  return [body, ...rest].join("\n").trimEnd();
}

export function App(props: {
  controller: SessionController;
  onExitRequest?: (reason: "exit" | "new") => void;
}) {
  const { exit } = useApp();
  const onExitRequest = props.onExitRequest;
  const { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState<RunSnapshot>(
    props.controller.getSnapshot(),
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [currentCursorPosition, setCurrentCursorPosition] = useState(0);
  const [cursorNudge, setCursorNudge] = useState<number | undefined>(undefined);
  const [isAutocompleteActive, setIsAutocompleteActive] = useState(false);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [conversationDensity, setConversationDensity] =
    useState<ConversationDensity>("immersive");
  const [overlay, setOverlay] = useState<"codex" | "hotkeys" | "changelog" | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [viewportAllowsAnimation, setViewportAllowsAnimation] = useState(
    TUI_ANIMATIONS_ENABLED,
  );
  const inputRef = useRef(input);
  const autocompleteActiveRef = useRef(isAutocompleteActive);
  const lastExpandShortcutAtRef = useRef(0);
  const lastDensityShortcutAtRef = useRef(0);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const closeCodexOverlay = useCallback((result?: CodexConfigDialogResult) => {
    setOverlay(null);
    if (result?.message) {
      setNotice(result.message);
    }
  }, []);

  const slashCommands = useMemo(
    () => getSlashCommands(snapshot.viewerOnly),
    [snapshot.viewerOnly],
  );
  const sessionHotkeys = useMemo(
    () => buildSessionHotkeysMarkdown(snapshot.viewerOnly),
    [snapshot.viewerOnly],
  );
  const changelog = useMemo(() => buildChangelogMarkdown(), []);

  const executeCommand = async (command: string) => {
    if (command === "/exit") {
      onExitRequest?.("exit");
      exit();
      return;
    }
    if (command === "/new") {
      onExitRequest?.("new");
      exit();
      return;
    }
    if (command === "/codex") {
      setOverlay("codex");
      return;
    }
    if (command === "/hotkeys") {
      setOverlay("hotkeys");
      return;
    }
    if (command === "/changelog") {
      setOverlay("changelog");
      return;
    }
    if (!command) {
      return;
    }
    setBusy(true);
    try {
      await props.controller.handleCommand(command);
    } finally {
      setBusy(false);
    }
  };

  const interruptActiveTurn = useCallback(async () => {
    setBusy(true);
    try {
      await props.controller.interruptActiveTurn();
    } finally {
      setBusy(false);
    }
  }, [props.controller]);

  const completeSlashCommand = useCallback(
    (value: string, cursorPosition = currentCursorPosition): boolean => {
      const state = buildSlashAutocompleteState(
        value,
        slashCommands,
        cursorPosition,
      );
      if (!state.active || state.matches.length === 0 || busy) {
        return false;
      }
      const command = getSelectedSlashCommand(state, selectedSlashIndex);
      if (!command) {
        return false;
      }
      const completed = formatSlashCommandForInput(command, slashCommands);
      setInput(completed);
      setCurrentCursorPosition(completed.length);
      setCursorNudge(completed.length);
      return true;
    },
    [busy, currentCursorPosition, selectedSlashIndex, slashCommands],
  );

  const completeSlashCommandRef = useRef(completeSlashCommand);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    autocompleteActiveRef.current = isAutocompleteActive;
  }, [isAutocompleteActive]);

  useEffect(() => {
    completeSlashCommandRef.current = completeSlashCommand;
  }, [completeSlashCommand]);

  const handleGlobalInput = useCallback(
    (
      typedInput: string,
      key: {
        upArrow: boolean;
        downArrow: boolean;
        leftArrow: boolean;
        rightArrow: boolean;
        pageDown: boolean;
        pageUp: boolean;
        return: boolean;
        escape: boolean;
        ctrl: boolean;
        shift: boolean;
        tab: boolean;
        backspace: boolean;
        delete: boolean;
        meta: boolean;
      },
    ) => {
      const isEscape = key.escape || typedInput === "\u001b";
      if (overlay) {
        return;
      }
      const isCtrlOPlain = isRawCtrlShortcut(typedInput, "o");
      const isCtrlOModified = matchesCtrlShortcut(typedInput, key.ctrl, "o");
      if (isCtrlOPlain || isCtrlOModified) {
        const now = Date.now();
        if (
          now - lastExpandShortcutAtRef.current <
          CTRL_SHORTCUT_TOGGLE_DEDUPE_MS
        ) {
          return;
        }
        lastExpandShortcutAtRef.current = now;
        setLogsExpanded((value) => !value);
        return;
      }
      const isCtrlUPlain = isRawCtrlShortcut(typedInput, "u");
      const isCtrlUModified = matchesCtrlShortcut(typedInput, key.ctrl, "u");
      if (isCtrlUPlain || isCtrlUModified) {
        const now = Date.now();
        if (
          now - lastDensityShortcutAtRef.current <
          CTRL_SHORTCUT_TOGGLE_DEDUPE_MS
        ) {
          return;
        }
        lastDensityShortcutAtRef.current = now;
        setConversationDensity((value) =>
          value === "immersive" ? "compact" : "immersive",
        );
        setNotice(
          conversationDensity === "immersive"
            ? "View density: compact"
            : "View density: immersive",
        );
        return;
      }
      if (isEscape) {
        void interruptActiveTurn();
        return;
      }
      if (key.return && !autocompleteActiveRef.current) {
        const trimmed = inputRef.current.trim();
        if (trimmed === "/exit") {
          onExitRequest?.("exit");
          setInput("");
          setCurrentCursorPosition(0);
          setCursorNudge(0);
          exit();
          return;
        }
        if (trimmed === "/new") {
          onExitRequest?.("new");
          setInput("");
          setCurrentCursorPosition(0);
          setCursorNudge(0);
          exit();
          return;
        }
      }
      if (typedInput === "\t") {
        if (completeSlashCommandRef.current(inputRef.current)) {
          return;
        }
      }
    },
    [conversationDensity, exit, interruptActiveTurn, onExitRequest, overlay],
  );

  useInput(handleGlobalInput);

  useEffect(() => {
    if (cursorNudge === undefined) {
      return;
    }
    const timer = setTimeout(() => setCursorNudge(undefined), 0);
    return () => clearTimeout(timer);
  }, [cursorNudge]);

  useEffect(() => {
    let mounted = true;
    void props.controller.start();
    const unsubscribe = props.controller.subscribe((next) => {
      if (mounted) {
        setSnapshot(next);
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
      void props.controller.dispose();
    };
  }, [props.controller]);

  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") {
      return;
    }
    const handleResize = () => {
      setIsResizing(true);
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null;
        setIsResizing(false);
      }, RESIZE_SETTLE_DELAY_MS);
    };
    stdout.on("resize", handleResize);
    return () => {
      if (typeof stdout.off === "function") {
        stdout.off("resize", handleResize);
      } else if (typeof stdout.removeListener === "function") {
        stdout.removeListener("resize", handleResize);
      }
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
    };
  }, [stdout]);

  const handleSubmit = async (value: string) => {
    if (overlay) {
      return;
    }
    const autocompleteAtSubmit = buildSlashAutocompleteState(
      value,
      slashCommands,
      currentCursorPosition,
    );
    const trimmed = resolveSubmittedInput(
      value,
      autocompleteAtSubmit,
      selectedSlashIndex,
      slashCommands,
    );
    const validation = validateSlashCommandInput(trimmed, slashCommands);
    if (validation.kind === "missing-arguments") {
      setInput(validation.prefill);
      setCurrentCursorPosition(validation.prefill.length);
      setCursorNudge(validation.prefill.length);
      setNotice(validation.hint);
      return;
    }
    if (validation.kind === "unexpected-arguments") {
      setNotice(validation.hint);
      return;
    }
    setInput("");
    setCurrentCursorPosition(0);
    setCursorNudge(0);
    if (!trimmed) {
      return;
    }
    await executeCommand(trimmed);
  };

  const handleInputChange = (nextValue: string) => {
    if (overlay) {
      return;
    }
    const sanitizedValue = sanitizeLauncherInput(nextValue);
    if (
      sanitizedValue === inputRef.current &&
      sanitizedValue !== nextValue
    ) {
      return;
    }
    if (sanitizedValue.includes("\t")) {
      const withoutTab = sanitizedValue.replace(/\t+/g, "");
      if (withoutTab.startsWith("/")) {
        if (completeSlashCommand(withoutTab, withoutTab.length)) {
          return;
        }
        setInput(withoutTab);
        setCurrentCursorPosition(withoutTab.length);
        setCursorNudge(withoutTab.length);
        return;
      }
      setInput(withoutTab);
      setCurrentCursorPosition(withoutTab.length);
      setCursorNudge(withoutTab.length);
      return;
    }
    setInput(sanitizedValue);
    setCurrentCursorPosition(sanitizedValue.length);
  };

  const terminalColumns = Math.max(40, stdout?.columns ?? 80);
  const terminalRows = Math.max(20, stdout?.rows ?? 40);
  const compactTimeline = conversationDensity === "compact";
  const sectionGap = compactTimeline ? 0 : 1;
  const minimizeTopChrome =
    snapshot.run.status === "completed" &&
    snapshot.activeThreadRole === null &&
    !logsExpanded;
  const horizontalLine = useMemo(
    () => buildHorizontalLine(terminalColumns, "─"),
    [terminalColumns],
  );
  const runAnimating = isRunAnimating(snapshot);
  const runPhaseLabel = getRunPhaseLabel(snapshot);
  const runStatusColor = getRunStatusColor(snapshot.run.status);
  const statusLineLabel = runAnimating ? `${runPhaseLabel}...` : runPhaseLabel;
  const statusLabelPalette =
    snapshot.activeThreadRole === "worker"
      ? colors.event.roleFlow.worker
      : snapshot.activeThreadRole === "supervisor"
        ? colors.event.roleFlow.supervisor
        : snapshot.run.status === "blocked"
          ? colors.event.roleFlow.supervisor
          : colors.progress.phaseFlow;
  const eventWindowCap = Math.max(
    MIN_EVENT_STREAM_LINES,
    terminalRows - (compactTimeline ? 15 : 18),
  );
  const eventWindowSize = Math.min(EVENT_STREAM_MAX_LINES, eventWindowCap);
  const eventLines = snapshot.logs.slice(-eventWindowSize);
  const keyedEventLines = useMemo(() => {
    const grouped: Array<{
      key: string;
      count: number;
      role: "worker" | "supervisor" | "system" | null;
      stamp: string;
      body: string;
      raw: string;
    }> = [];
    for (const line of eventLines) {
      const normalized = line.replace(/\r/g, "");
      const segments = normalized.split("\n");
      const first = segments[0] ?? "";
      const rest = segments.slice(1);
      const parsed = EVENT_PREFIX_PATTERN.exec(first);
      const role = parsed
        ? (parsed[2] as "worker" | "supervisor" | "system")
        : null;
      const stamp = parsed ? parsed[1] ?? "" : "";
      const body = parsed ? [parsed[3] ?? "", ...rest].join("\n") : normalized;
      const transientGroup = classifyTransientEventGroup(role, body);
      const key = transientGroup ?? (role ? `${role}|${body}` : `raw|${normalized}`);

      const previous = grouped[grouped.length - 1];
      if (previous && previous.key === key) {
        previous.count += 1;
        if (stamp) {
          previous.stamp = stamp;
        }
        previous.body = body;
        previous.raw = normalized;
        continue;
      }
      grouped.push({
        key,
        count: 1,
        role,
        stamp,
        body,
        raw: normalized,
      });
    }
    return grouped.map((entry, index) => {
      if (!entry.role) {
        return {
          line: entry.count > 1 ? `${entry.raw} (x${entry.count})` : entry.raw,
          key: `${entry.key}#${index + 1}`,
        };
      }
      const bodyLines = entry.body.split("\n");
      const firstBody = bodyLines[0] ?? "";
      const firstWithCount =
        entry.count > 1 ? `${firstBody} (x${entry.count})` : firstBody;
      const rebuilt = [
        `${entry.stamp} [${entry.role}] ${firstWithCount}`,
        ...bodyLines.slice(1),
      ].join("\n");
      return {
        line: rebuilt,
        key: `${entry.key}#${index + 1}`,
      };
    });
  }, [eventLines]);
  const eventPreviewChars = Math.max(24, terminalColumns - 34);
  const hasEventLines = keyedEventLines.length > 0;
  const hasCollapsedEventLine = !logsExpanded
    ? hasEventLines
    : keyedEventLines.some((entry) =>
        shouldCollapseEventLine(entry.line, eventPreviewChars),
      );
  const planOutput = formatPlanOutput(snapshot.plan);
  const supervisorOutput = snapshot.showSupervisor
    ? formatSupervisorDecision(snapshot.latestSupervisorDecision)
    : "";
  const commandEntries = useMemo(() => {
    if (snapshot.commandExecutions.length > 0) {
      return snapshot.commandExecutions.map((entry, index) => ({
        id: entry.id || `cmd-${index + 1}`,
        command: entry.command,
        output: entry.output,
        phase: entry.phase,
        success: entry.success,
        exitCode: entry.exitCode,
      }));
    }
    const commandOutput = snapshot.commandOutput.replace(/\s+$/, "");
    return parseCommandOutput(commandOutput);
  }, [snapshot.commandExecutions, snapshot.commandOutput]);
  const showStreamingAssistant =
    snapshot.activeThreadRole === "worker" &&
    (snapshot.run.status === "working" || snapshot.run.status === "repairing");
  const diffPreviewLineBudget = Math.max(
    compactTimeline ? 3 : 4,
    Math.min(DIFF_PREVIEW_COLLAPSED_LINES, terminalRows - (compactTimeline ? 20 : 24)),
  );
  const hasCollapsedSupervisor =
    supervisorOutput.length > 0 &&
    shouldCollapseOutput(supervisorOutput, eventPreviewChars, 3);
  const hasCollapsedDiff =
    snapshot.diff.length > 0 &&
    shouldCollapseOutput(
      snapshot.diff,
      eventPreviewChars,
      diffPreviewLineBudget,
    );
  const hasCollapsedCommandOutput = !logsExpanded
    ? commandEntries.length > 0
    : commandEntries.some(
        (entry) =>
          entry.output.length > 0 &&
          shouldCollapseOutput(
            entry.output,
            undefined,
            COMMAND_PREVIEW_LINES,
          ),
      );
  const hasCollapsedGoal = shouldCollapseOutput(snapshot.run.goal, eventPreviewChars, 3);
  const hasCollapsedAssistantMessage = snapshot.turnHistory.some((entry) => {
    if (entry.threadRole !== "worker") {
      return false;
    }
    const payload = entry.payload as WorkerTurnOutput;
    return shouldCollapseOutput(
      payload.userMessage,
      eventPreviewChars,
      diffPreviewLineBudget,
    );
  });
  const hasCollapsedConversationInfo =
    hasCollapsedGoal ||
    hasCollapsedAssistantMessage ||
    hasCollapsedSupervisor ||
    hasCollapsedDiff ||
    hasCollapsedCommandOutput ||
    hasCollapsedEventLine;
  const sessionMenuHintPrimary = [
    formatKeyHint(EXPAND_TOOLS_KEY, logsExpanded ? "collapse tools" : "expand tools"),
    formatKeyHint(
      DENSITY_TOGGLE_KEY,
      compactTimeline ? "immersive view" : "compact view",
    ),
    formatKeyHint("esc", "interrupt"),
    formatKeyHint("tab", "autocomplete"),
  ].join(" · ");
  const sessionMenuHintSecondary =
    "/supervisor on|off · /memory profile · /hotkeys · /changelog";
  const commandSummary = summarizeCommandEntries(commandEntries);
  const footerPath = buildTwoColumnFooterLine({
    width: Math.max(1, terminalColumns - 1),
    left: formatCwdForFooter(snapshot.agent.cwd),
    right: `agent ${shortId(snapshot.agent.id)} · run ${shortId(snapshot.run.id)}`,
  });
  const footerStats = buildTwoColumnFooterLine({
    width: Math.max(1, terminalColumns - 1),
    left:
      `turns ${formatCompactCount(snapshot.run.workerTurnCount)} · ` +
      `events ${formatCompactCount(snapshot.logs.length)} · ` +
      `${commandSummary}`,
    right:
      `${snapshot.activeThreadRole ? `lane ${snapshot.activeThreadRole}` : snapshot.run.status} · ` +
      `${snapshot.showSupervisor ? "supervisor on" : "supervisor off"} · ` +
      `view ${conversationDensity}`,
  });
  const slashPlaceholder = "Describe what you want to do...";
  const visibleSlashRows = Math.max(8, Math.min(16, terminalRows - 22));
  const slashAutocompleteState = useMemo(
    () => buildSlashAutocompleteState(input, slashCommands, currentCursorPosition),
    [currentCursorPosition, input, slashCommands],
  );

  const estimatedLiveHeight = useMemo(() => {
    // Mirror letta-style strategy: estimate only live/animated area,
    // not the full transcript history.
    let liveItemsHeight = 0;

    if (showStreamingAssistant) {
      liveItemsHeight += 3;
    }

    if (snapshot.activeThreadRole) {
      liveItemsHeight += 2;
    }

    for (const entry of commandEntries) {
      if (entry.phase !== "running") {
        continue;
      }
      const normalized = entry.output
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/\n+$/, "");
      const outputLines = normalized ? normalized.split("\n") : [];
      const previewLines = Math.max(
        1,
        Math.min(COMMAND_PREVIEW_LINES, outputLines.length || 1),
      );
      liveItemsHeight += 2 + previewLines;
    }

    if (notice) {
      liveItemsHeight += 1;
    }

    // Input block: margin + divider/input/divider.
    liveItemsHeight += 4;

    if (input.startsWith("/")) {
      if (slashAutocompleteState.showNoMatches) {
        liveItemsHeight += 2;
      } else if (
        slashAutocompleteState.active &&
        slashAutocompleteState.matches.length > 0
      ) {
        const visibleMatches = Math.min(
          slashAutocompleteState.matches.length,
          visibleSlashRows,
        );
        const hasPositionCounter =
          slashAutocompleteState.matches.length > visibleSlashRows;
        liveItemsHeight += 1 + visibleMatches + (hasPositionCounter ? 1 : 0);
      }
    }

    // Footer block: margin + 2 lines.
    liveItemsHeight += 3;

    // Conservative buffer (same pattern as letta App).
    const fixedBuffer = 20;
    return liveItemsHeight + fixedBuffer;
  }, [
    commandEntries,
    input,
    notice,
    slashAutocompleteState,
    snapshot.activeThreadRole,
    showStreamingAssistant,
    visibleSlashRows,
  ]);

  useEffect(() => {
    if (!TUI_ANIMATIONS_ENABLED || terminalRows <= 0) {
      setViewportAllowsAnimation(false);
      return;
    }

    const disableThreshold = terminalRows;
    const resumeThreshold = Math.max(
      0,
      terminalRows - ANIMATION_RESUME_HYSTERESIS_ROWS,
    );

    setViewportAllowsAnimation((current) => {
      if (current) {
        return estimatedLiveHeight < disableThreshold;
      }
      return estimatedLiveHeight < resumeThreshold;
    });
  }, [estimatedLiveHeight, terminalRows]);

  const shouldAnimate =
    TUI_ANIMATIONS_ENABLED &&
    viewportAllowsAnimation &&
    !isResizing;
  const shouldAnimateStatusLabel =
    shouldAnimate && (runAnimating || snapshot.run.status === "blocked");

  if (overlay === "codex") {
    return <CodexConfigDialog onClose={closeCodexOverlay} />;
  }
  if (overlay === "hotkeys") {
    return (
      <InfoOverlay
        command="/hotkeys"
        title="Keyboard Shortcuts"
        markdown={sessionHotkeys}
        onClose={() => setOverlay(null)}
      />
    );
  }
  if (overlay === "changelog") {
    return (
      <InfoOverlay
        command="/changelog"
        title="What's New"
        markdown={changelog}
        onClose={() => setOverlay(null)}
      />
    );
  }

  return (
    <AnimationProvider shouldAnimate={shouldAnimate}>
      <Box flexDirection="column">
        {!minimizeTopChrome ? (
          <>
            <Box flexDirection="row">
            <Box width={2} flexShrink={0}>
              {runAnimating ? (
                <BlinkDot
                  color={colors.progress.spinner}
                  shouldAnimate={shouldAnimate}
                />
              ) : (
                <Text color={runStatusColor}>
                  {getRunStatusSymbol(snapshot.run.status)}
                </Text>
              )}
            </Box>
            <FlowingRoleLabel
              text={statusLineLabel}
              staticColor={runStatusColor}
              palette={statusLabelPalette}
              animate={shouldAnimateStatusLabel}
            />
            <Text color={colors.event.hint} dimColor>
              {logsExpanded
                ? ` (${expandToolsHint("collapse")})`
                : hasCollapsedConversationInfo
                  ? ` (${expandToolsHint("expand")})`
                : ` (${formatKeyForDisplay(EXPAND_TOOLS_KEY)})`}
            </Text>
            </Box>
            <Box marginLeft={2} flexDirection="column">
            <Text color={colors.event.hint} dimColor wrap="truncate-end">
              {sessionMenuHintPrimary}
            </Text>
            <Text color={colors.event.hint} dimColor wrap="truncate-end">
              {sessionMenuHintSecondary}
            </Text>
            </Box>

            <Box marginTop={sectionGap}>
            <UserMessage
              line={{
                kind: "user",
                id: `goal-${snapshot.run.id}`,
                text: snapshot.run.goal,
              }}
              expanded={logsExpanded}
              maxPreviewChars={eventPreviewChars}
              maxPreviewLines={3}
            />
            </Box>
          </>
        ) : null}

        {notice ? (
          <Box marginTop={1}>
            <Text color={colors.codex.subtitle}>{notice}</Text>
          </Box>
        ) : null}

        {snapshot.turnHistory.map((entry, index) => {
        const historyKey = `${entry.turnId}-${entry.createdAt}-${index + 1}`;
        if (entry.threadRole === "worker") {
          const payload = entry.payload as WorkerTurnOutput;
          return (
            <Box key={`worker-${historyKey}`} marginTop={sectionGap} flexDirection="column">
              <AssistantMessage
                line={{
                  kind: "assistant",
                  id: `assistant-${historyKey}`,
                  text: payload.userMessage,
                  phase: "finished",
                }}
                expanded={logsExpanded}
                maxPreviewChars={eventPreviewChars}
                maxPreviewLines={diffPreviewLineBudget}
              />
              <Box marginTop={sectionGap}>
                <WorkerHandoffMessage
                  handoff={payload.handoff}
                  expanded={logsExpanded}
                />
              </Box>
            </Box>
          );
        }

        if (!snapshot.showSupervisor) {
          return null;
        }
        const payload = entry.payload as SupervisorDecision;
        const renderedDecision = formatSupervisorDecision(payload);
        if (!renderedDecision) {
          return null;
        }
        return (
          <Box key={`supervisor-${historyKey}`} marginTop={sectionGap}>
            <ExpandableDetailsMessage
              label="supervisor"
              summary={summarizeSupervisorDecision(
                payload,
                snapshot.activeThreadRole === "supervisor",
              )}
              content={renderedDecision}
              expanded={logsExpanded}
            />
          </Box>
        );
        })}

        {showStreamingAssistant ? (
          <Box marginTop={sectionGap}>
            <AssistantMessage
              line={{
                kind: "assistant",
                id: `worker-stream-${snapshot.run.id}-${snapshot.run.workerTurnCount}`,
                text: "",
                phase: "streaming",
              }}
              expanded
            />
          </Box>
        ) : null}

        {planOutput ? (
          <Box marginTop={sectionGap}>
            <ExpandableDetailsMessage
              label="plan"
              summary={summarizePlan(snapshot.plan)}
              content={planOutput}
              expanded={logsExpanded}
            />
          </Box>
        ) : null}

        {snapshot.diff ? (
          <Box marginTop={sectionGap}>
            <ExpandableDetailsMessage
              label="diff"
              summary={summarizeDiff(snapshot.diff)}
              content={snapshot.diff}
              expanded={logsExpanded}
            />
          </Box>
        ) : null}

        <Box flexDirection="column">
          {keyedEventLines.map((entry) => (
            <Box key={entry.key} marginTop={sectionGap}>
              <EventStreamLine
                line={entry.line}
                expanded={logsExpanded}
                maxPreviewChars={eventPreviewChars}
                activeThreadRole={snapshot.activeThreadRole}
                animate={shouldAnimate}
              />
            </Box>
          ))}
          {logsExpanded && commandEntries.length > 0 ? (
            <>
              {commandEntries.map((entry) => (
                <Box key={entry.id} marginTop={sectionGap}>
                  <CommandMessage
                    line={{
                      kind: "command",
                      id: entry.id,
                      input: `$ ${entry.command}`,
                      output: entry.output,
                      phase: entry.phase,
                      success: entry.success,
                      exitCode: entry.exitCode,
                      dimOutput: entry.phase === "running",
                      preformatted: true,
                    }}
                    expanded={logsExpanded}
                    maxPreviewLines={COMMAND_PREVIEW_LINES}
                    variant="timeline"
                  />
                </Box>
              ))}
            </>
          ) : null}
          {minimizeTopChrome ? (
            <Box marginTop={sectionGap}>
              <Box flexDirection="row" flexWrap="wrap">
                <Box width={2} flexShrink={0}>
                  <Text color={runStatusColor}>
                    {getRunStatusSymbol(snapshot.run.status)}
                  </Text>
                </Box>
                <Text color={colors.event.hint} dimColor>
                  status
                </Text>
                <Text> </Text>
                <Text color={colors.event.bracket}>[</Text>
                <Text color={runStatusColor}>{statusLineLabel}</Text>
                <Text color={colors.event.bracket}>]</Text>
              </Box>
            </Box>
          ) : null}
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text color={colors.input.divider} dimColor>
            {horizontalLine}
          </Text>
          <Box flexDirection="row">
            <Text color={colors.input.prompt}>{"> "}</Text>
            <Box flexGrow={1}>
              <PatchedTextInput
                value={input}
                onChange={handleInputChange}
                onSubmit={handleSubmit}
                placeholder={slashPlaceholder}
                cursorPosition={cursorNudge}
                onCursorMove={setCurrentCursorPosition}
                focus
              />
            </Box>
          </Box>
          <Text color={colors.input.divider} dimColor>
            {horizontalLine}
          </Text>
        </Box>

        <SlashCommandAutocomplete
          currentInput={input}
          cursorPosition={currentCursorPosition}
          commands={slashCommands}
          visibleCommands={visibleSlashRows}
          onSelect={(command) => {
            const completed = formatSlashCommandForInput(command, slashCommands);
            setInput(completed);
            setCurrentCursorPosition(completed.length);
            setCursorNudge(completed.length);
          }}
          onAutocomplete={(command) => {
            const completed = formatSlashCommandForInput(command, slashCommands);
            setInput(completed);
            setCurrentCursorPosition(completed.length);
            setCursorNudge(completed.length);
          }}
          onActiveChange={setIsAutocompleteActive}
          onSelectedIndexChange={setSelectedSlashIndex}
          disabled={busy}
        />

        <Box marginTop={1} flexDirection="column">
          <Text color={colors.event.hint} dimColor wrap="truncate-end">
            {footerPath}
          </Text>
          <Text color={colors.event.hint} dimColor wrap="truncate-end">
            {footerStats}
          </Text>
        </Box>
      </Box>
    </AnimationProvider>
  );
}
