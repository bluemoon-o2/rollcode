import { Box, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveFeedbackCommand } from "../utils/githubFeedback";
import {
  CodexConfigDialog,
  type CodexConfigDialogResult,
} from "./components/CodexConfigDialog";
import { colors } from "./components/colors";
import { InfoOverlay } from "./components/InfoOverlay";
import { PatchedTextInput } from "./components/PatchedTextInput";
import { SlashCommandAutocomplete } from "./components/SlashCommandAutocomplete";
import { Text } from "./components/Text";
import {
  type LauncherLoadingState,
  WelcomeScreen,
} from "./components/WelcomeScreen";
import { buildHorizontalLine, clearTerminalScreen } from "./terminal";
import {
  buildChangelogMarkdown,
  buildLauncherHotkeysMarkdown,
} from "./helpContent";
import {
  canonicalizeLauncherSubmission,
  normalizeLauncherCommand,
  sanitizeLauncherInput,
} from "./launcherInput";
import {
  buildSlashAutocompleteState,
  formatSlashCommandForInput,
  getLauncherSlashCommands,
  getSelectedSlashCommand,
  resolveSubmittedInput,
  validateSlashCommandInput,
} from "./slashCommands";

export type LauncherResult =
  | { type: "run"; goal: string }
  | { type: "resume" }
  | { type: "exit" };

const LAUNCHER_CONFIG_COMMANDS = new Set(["/codex"]);

const LAUNCHER_EXIT_COMMANDS = new Set(["/exit"]);

const LAUNCHER_SLASH_COMMANDS = getLauncherSlashCommands();

export function Launcher(props: {
  cwd: string;
  releaseNotes?: string | null;
  onComplete: (result: LauncherResult) => void;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [input, setInput] = useState("");
  const [loadingState, setLoadingState] =
    useState<LauncherLoadingState>("loading_history");
  const [currentCursorPosition, setCurrentCursorPosition] = useState(0);
  const [cursorNudge, setCursorNudge] = useState<number | undefined>(undefined);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [overlay, setOverlay] = useState<
    "codex" | "hotkeys" | "changelog" | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef(input);
  const launcherHotkeys = useMemo(() => buildLauncherHotkeysMarkdown(), []);
  const changelog = useMemo(() => buildChangelogMarkdown(), []);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  const closeCodexOverlay = (result?: CodexConfigDialogResult) => {
    setOverlay(null);
    if (result?.message) {
      setNotice(result.message);
    }
  };
  const closeInfoOverlay = () => {
    setOverlay(null);
  };

  const executeLauncherCommand = (command: string) => {
    const trimmed = normalizeLauncherCommand(command);
    if (!trimmed) {
      return;
    }
    if (LAUNCHER_EXIT_COMMANDS.has(trimmed)) {
      clearTerminalScreen(stdout);
      props.onComplete({ type: "exit" });
      exit();
      return;
    }
    const commandToken = trimmed.split(/\s+/u)[0] ?? "";
    if (commandToken === "/resume") {
      clearTerminalScreen(stdout);
      props.onComplete({ type: "resume" });
      exit();
      return;
    }
    const feedback = resolveFeedbackCommand(trimmed, {
      cwd: props.cwd,
      source: "launcher",
    });
    if (feedback.kind !== "not-feedback") {
      if (feedback.kind === "needs-message") {
        setInput(feedback.prefillCommand);
        setCurrentCursorPosition(feedback.prefillCommand.length);
        setCursorNudge(feedback.prefillCommand.length);
        setNotice(feedback.hint);
        return;
      }
      setNotice(feedback.message);
      return;
    }
    if (trimmed === "/hotkeys") {
      setOverlay("hotkeys");
      return;
    }
    if (trimmed === "/changelog") {
      setOverlay("changelog");
      return;
    }
    if (LAUNCHER_CONFIG_COMMANDS.has(trimmed)) {
      setOverlay("codex");
      return;
    }
    if (trimmed === "/new") {
      setNotice("You are already on the new-run page. Enter a goal to start.");
      return;
    }
    if (trimmed.startsWith("/")) {
      setNotice(
        "This command runs in-session. Enter a goal first, then use / in the session.",
      );
      return;
    }
    props.onComplete({ type: "run", goal: trimmed });
    clearTerminalScreen(stdout);
    exit();
  };
  const completeSlashCommand = (
    value: string,
    cursorPosition = currentCursorPosition,
  ): boolean => {
    const state = buildSlashAutocompleteState(
      value,
      LAUNCHER_SLASH_COMMANDS,
      cursorPosition,
    );
    if (!state.active || state.matches.length === 0) {
      return false;
    }
    const command = getSelectedSlashCommand(state, selectedSlashIndex);
    if (!command) {
      return false;
    }
    const completed = formatSlashCommandForInput(
      command,
      LAUNCHER_SLASH_COMMANDS,
    );
    setInput(completed);
    setCurrentCursorPosition(completed.length);
    setCursorNudge(completed.length);
    return true;
  };

  useEffect(() => {
    const timer = setTimeout(() => setLoadingState("ready"), 900);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (cursorNudge === undefined) {
      return;
    }
    const timer = setTimeout(() => setCursorNudge(undefined), 0);
    return () => clearTimeout(timer);
  }, [cursorNudge]);

  useInput((typedInput, key) => {
    const isEscape = key.escape || typedInput === "\u001b";
    if (overlay) {
      return;
    }
    if (isEscape) {
      props.onComplete({ type: "exit" });
      exit();
      return;
    }
    if (typedInput === "\t") {
      if (completeSlashCommand(input)) {
        return;
      }
    }
  });

  const submit = (value: string) => {
    if (overlay) {
      return;
    }
    const normalizedValue = canonicalizeLauncherSubmission(value);
    const autocompleteAtSubmit = buildSlashAutocompleteState(
      normalizedValue,
      LAUNCHER_SLASH_COMMANDS,
      normalizedValue.length,
    );
    const trimmed = resolveSubmittedInput(
      normalizedValue,
      autocompleteAtSubmit,
      selectedSlashIndex,
      LAUNCHER_SLASH_COMMANDS,
    );
    const validation = validateSlashCommandInput(
      trimmed,
      LAUNCHER_SLASH_COMMANDS,
    );
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
    executeLauncherCommand(trimmed);
  };
  const handleInputChange = (nextValue: string) => {
    if (overlay) {
      return;
    }
    const sanitizedValue = sanitizeLauncherInput(nextValue);
    if (sanitizedValue === inputRef.current && sanitizedValue !== nextValue) {
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

  const releaseNotesLines =
    props.releaseNotes?.split("\n").filter(Boolean) ?? [];
  const terminalColumns = Math.max(40, stdout?.columns ?? 80);
  const terminalRows = Math.max(20, stdout?.rows ?? 40);
  const horizontalLine = useMemo(
    () => buildHorizontalLine(terminalColumns, "─"),
    [terminalColumns],
  );
  const visibleCommandRows = Math.max(6, Math.min(14, terminalRows - 20));
  const launcherMenuHints = [
    "Enter start run · Tab complete · ↑↓ navigate",
    "/hotkeys · /changelog · /codex setup · /resume history · /exit",
  ];

  if (overlay === "codex") {
    return <CodexConfigDialog onClose={closeCodexOverlay} />;
  }
  if (overlay === "hotkeys") {
    return (
      <InfoOverlay
        command="/hotkeys"
        title="Keyboard Shortcuts"
        markdown={launcherHotkeys}
        onClose={closeInfoOverlay}
      />
    );
  }
  if (overlay === "changelog") {
    return (
      <InfoOverlay
        command="/changelog"
        title="What's New"
        markdown={changelog}
        onClose={closeInfoOverlay}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <WelcomeScreen cwd={props.cwd} loadingState={loadingState} />

      {releaseNotesLines.length > 0 ? (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor={colors.releaseNotes.border}
          paddingX={1}
        >
          <Text color={colors.releaseNotes.title}>Release Notes</Text>
          {releaseNotesLines.map((line, index) => (
            <Text key={`${index}-${line}`} color={colors.releaseNotes.body}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      <Text color={colors.launcher.hint}>
        Type a goal to start, or use slash commands.
      </Text>
      {notice ? <Text color={colors.codex.subtitle}>{notice}</Text> : null}

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
              onSubmit={submit}
              placeholder="Describe what you want to do..."
              cursorPosition={cursorNudge}
              onCursorMove={setCurrentCursorPosition}
            />
          </Box>
        </Box>
        <Text color={colors.input.divider} dimColor>
          {horizontalLine}
        </Text>

        <SlashCommandAutocomplete
          currentInput={input}
          cursorPosition={currentCursorPosition}
          commands={LAUNCHER_SLASH_COMMANDS}
          visibleCommands={visibleCommandRows}
          onSelect={(command) => {
            const completed = formatSlashCommandForInput(
              command,
              LAUNCHER_SLASH_COMMANDS,
            );
            setInput(completed);
            setCurrentCursorPosition(completed.length);
            setCursorNudge(completed.length);
          }}
          onAutocomplete={(command) => {
            const completed = formatSlashCommandForInput(
              command,
              LAUNCHER_SLASH_COMMANDS,
            );
            setInput(completed);
            setCurrentCursorPosition(completed.length);
            setCursorNudge(completed.length);
          }}
          onSelectedIndexChange={setSelectedSlashIndex}
        />

        <Box marginTop={1} marginLeft={2} flexDirection="column">
          {launcherMenuHints.map((hint) => (
            <Text
              key={hint}
              color={colors.input.hint}
              dimColor
              wrap="truncate-end"
            >
              {hint}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
