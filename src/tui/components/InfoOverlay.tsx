import { Box, useInput, useStdout } from "ink";
import { useCallback, useMemo, useRef } from "react";
import { colors } from "./colors";
import { MarkdownText } from "./MarkdownText";
import { Text } from "./Text";
import { buildHorizontalLine, clearTerminalScreen } from "../terminal";

const IGNORE_INITIAL_RETURN_MS = 160;

export function InfoOverlay(props: {
  command: string;
  title: string;
  markdown: string;
  onClose: () => void;
}) {
  const { stdout } = useStdout();
  const openedAtRef = useRef(Date.now());
  const terminalColumns = Math.max(40, stdout?.columns ?? 80);
  const horizontalLine = useMemo(
    () => buildHorizontalLine(terminalColumns, "-"),
    [terminalColumns],
  );
  const closeOverlay = useCallback(() => {
    clearTerminalScreen(stdout);
    props.onClose();
  }, [props.onClose, stdout]);

  useInput((input, key) => {
    const isEscape = key.escape || input === "\u001b";
    const isEnter = key.return || input === "\r" || input === "\n";
    if (
      isEnter &&
      Date.now() - openedAtRef.current < IGNORE_INITIAL_RETURN_MS
    ) {
      return;
    }
    if ((key.ctrl && input === "c") || isEscape || isEnter) {
      closeOverlay();
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>{`> ${props.command}`}</Text>
      <Text color={colors.codex.line} dimColor>
        {horizontalLine}
      </Text>

      <Box marginTop={1}>
        <Text color={colors.codex.title} bold>
          {props.title}
        </Text>
      </Box>

      <Box
        marginTop={1}
        flexDirection="column"
      >
        <Text color={colors.releaseNotes.border} dimColor>
          {horizontalLine}
        </Text>
        <MarkdownText text={props.markdown} baseColor={colors.codex.text} />
        <Text color={colors.releaseNotes.border} dimColor>
          {horizontalLine}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color={colors.codex.hint} dimColor>
          Esc close | Enter close
        </Text>
      </Box>
    </Box>
  );
}
