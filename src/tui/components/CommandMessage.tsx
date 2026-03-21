import { Box } from "ink";
import { memo, useEffect, useMemo, useState } from "react";
import { TUI_ANIMATIONS_ENABLED } from "../animation";
import { useAnimation } from "../contexts/AnimationContext";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { expandToolsHint } from "./keybindingHints";
import { Text } from "./Text";

type CommandLine = {
  kind: "command";
  id: string;
  input: string;
  output: string;
  phase?: "running" | "waiting" | "finished";
  success?: boolean;
  exitCode?: number | null;
  dimOutput?: boolean;
  preformatted?: boolean;
};

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const COMMAND_PREVIEW_LINES = 20;

function normalizeOutput(output: string): string {
  return output.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function getBorderColor(line: CommandLine): string {
  if (line.phase === "running") {
    return colors.command.running;
  }
  if (line.success === false || line.exitCode === null) {
    return colors.command.error;
  }
  return colors.input.divider;
}

function getOutputColor(line: CommandLine): string {
  return line.dimOutput ? colors.event.hint : colors.event.body;
}

function formatExitStatus(exitCode: number | null | undefined): string {
  if (typeof exitCode === "number") {
    return `(exit ${exitCode})`;
  }
  if (exitCode === null) {
    return "(exit ?)";
  }
  return "";
}

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export const CommandMessage = memo(
  ({
    line,
    expanded = false,
    maxPreviewLines = COMMAND_PREVIEW_LINES,
    variant = "card",
  }: {
    line: CommandLine;
    expanded?: boolean;
    maxPreviewChars?: number;
    maxPreviewLines?: number;
    variant?: "card" | "timeline";
  }) => {
    const columns = useTerminalWidth();
    const [runningFrame, setRunningFrame] = useState(0);
    const { shouldAnimate } = useAnimation();
    const animateSpinner = TUI_ANIMATIONS_ENABLED && shouldAnimate;

    useEffect(() => {
      if (line.phase !== "running" || !animateSpinner) {
        setRunningFrame(0);
        return;
      }
      const timer = setInterval(() => {
        setRunningFrame((value) => (value + 1) % RUNNING_FRAMES.length);
      }, 120);
      return () => clearInterval(timer);
    }, [animateSpinner, line.id, line.phase]);

    if (line.phase === "waiting") {
      return null;
    }

    const normalizedOutput = useMemo(
      () => normalizeOutput(line.output),
      [line.output],
    );
    const allLines = useMemo(() => splitLines(normalizedOutput), [normalizedOutput]);
    const previewLines = expanded
      ? allLines
      : allLines.slice(-Math.max(1, maxPreviewLines));
    const hiddenLineCount = Math.max(0, allLines.length - previewLines.length);
    const borderColor = getBorderColor(line);
    const outputColor = getOutputColor(line);
    const spinner = RUNNING_FRAMES[runningFrame] ?? RUNNING_FRAMES[0];
    const hasOutput = previewLines.length > 0;
    const hasCollapsedOutput = hiddenLineCount > 0;
    const statusGlyph =
      line.phase === "running" ? "▸" : line.success === false ? "✗" : "✓";
    const statusColor =
      line.phase === "running"
        ? colors.command.running
        : line.success === false
          ? colors.command.error
          : colors.command.success;

    if (variant === "timeline") {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap">
            <Text color={statusColor}>{statusGlyph}</Text>
            <Text> </Text>
            <Text color={colors.event.hint}>command</Text>
            <Text> </Text>
            <Text color={colors.event.worker} bold>
              {line.input}
            </Text>
          </Box>

          {hasOutput ? (
            <Box marginLeft={2} flexDirection="column">
              {previewLines.map((entry, index) => (
                <Text key={`${line.id}-out-${index}-${entry}`} color={outputColor}>
                  {entry}
                </Text>
              ))}
            </Box>
          ) : null}

          {line.phase === "running" ? (
            <Box marginLeft={2}>
              <Text color={colors.command.running}>
                {animateSpinner
                  ? `${spinner} Running... (Esc to cancel)`
                  : "Running... (Esc to cancel)"}
              </Text>
            </Box>
          ) : null}

          {line.phase !== "running" && hasCollapsedOutput && !expanded ? (
            <Box marginLeft={2}>
              <Text color={colors.event.hint} dimColor>
                ... {hiddenLineCount} more lines ({expandToolsHint("expand")})
              </Text>
            </Box>
          ) : null}

          {line.phase !== "running" && hasCollapsedOutput && expanded ? (
            <Box marginLeft={2}>
              <Text color={colors.event.hint} dimColor>
                ({expandToolsHint("collapse")})
              </Text>
            </Box>
          ) : null}

          {line.phase !== "running" &&
          (line.success === false || line.exitCode === null) ? (
            <Box marginLeft={2}>
              <Text color={colors.command.error}>
                {formatExitStatus(line.exitCode)}
              </Text>
            </Box>
          ) : null}
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Text color={borderColor}>{"─".repeat(Math.max(1, columns))}</Text>

        <Text color={colors.event.worker} bold>
          {line.input}
        </Text>

        {hasOutput ? (
          <Box flexDirection="column">
            {previewLines.map((entry, index) => (
              <Text key={`${line.id}-out-${index}-${entry}`} color={outputColor}>
                {entry}
              </Text>
            ))}
          </Box>
        ) : null}

        {line.phase === "running" ? (
          <Text color={colors.command.running}>
            {animateSpinner ? `${spinner} Running... (Esc to cancel)` : "Running... (Esc to cancel)"}
          </Text>
        ) : null}

        {line.phase !== "running" && hasCollapsedOutput && !expanded ? (
          <Text color={colors.event.hint} dimColor>
            ... {hiddenLineCount} more lines ({expandToolsHint("expand")})
          </Text>
        ) : null}

        {line.phase !== "running" && hasCollapsedOutput && expanded ? (
          <Text color={colors.event.hint} dimColor>
            ({expandToolsHint("collapse")})
          </Text>
        ) : null}

        {line.phase !== "running" && (line.success === false || line.exitCode === null) ? (
          <Text color={colors.command.error}>
            {formatExitStatus(line.exitCode)}
          </Text>
        ) : null}

        <Text color={borderColor}>{"─".repeat(Math.max(1, columns))}</Text>
      </Box>
    );
  },
);

CommandMessage.displayName = "CommandMessage";
