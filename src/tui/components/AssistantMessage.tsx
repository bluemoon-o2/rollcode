import { Box } from "ink";
import { memo, useEffect, useState } from "react";
import { TUI_ANIMATIONS_ENABLED } from "../animation";
import { useAnimation } from "../contexts/AnimationContext";
import {
  CollapsedOutputDisplay,
  shouldCollapseOutput,
} from "./CollapsedOutputDisplay";
import { colors } from "./colors";
import { expandToolsHint } from "./keybindingHints";
import { MarkdownText } from "./MarkdownText";
import { Text } from "./Text";

type AssistantLine = {
  kind: "assistant";
  id: string;
  text: string;
  phase: "streaming" | "finished";
};

export const AssistantMessage = memo(
  ({
    line,
    expanded = true,
    maxPreviewChars,
    maxPreviewLines = 4,
  }: {
    line: AssistantLine;
    expanded?: boolean;
    maxPreviewChars?: number;
    maxPreviewLines?: number;
  }) => {
    const { shouldAnimate } = useAnimation();
    const animate = TUI_ANIMATIONS_ENABLED && shouldAnimate;
    const [cursorVisible, setCursorVisible] = useState(false);
    const [thinkingFrame, setThinkingFrame] = useState(0);

    useEffect(() => {
      if (
        !animate ||
        line.phase !== "streaming" ||
        line.text.trim().length === 0
      ) {
        setCursorVisible(false);
        return;
      }
      setCursorVisible(true);
      const timer = setInterval(() => {
        setCursorVisible((current) => !current);
      }, 260);
      return () => clearInterval(timer);
    }, [animate, line.id, line.phase]);

    const hasText = line.text.trim().length > 0;
    useEffect(() => {
      if (!animate || line.phase !== "streaming" || hasText) {
        setThinkingFrame(0);
        return;
      }
      const timer = setInterval(() => {
        setThinkingFrame((current) => (current + 1) % 4);
      }, 280);
      return () => clearInterval(timer);
    }, [animate, hasText, line.phase]);

    if (!hasText && line.phase !== "streaming") {
      return null;
    }

    const thinkingDots = animate ? ".".repeat(thinkingFrame + 1) : "...";
    const thinkingText = `Thinking${thinkingDots}`;
    const collapsed =
      line.phase !== "streaming" &&
      !expanded &&
      shouldCollapseOutput(line.text, maxPreviewChars, maxPreviewLines);
    const canCollapse =
      line.phase !== "streaming" &&
      shouldCollapseOutput(line.text, maxPreviewChars, maxPreviewLines);

    return (
      <Box flexDirection="column">
        {collapsed ? (
          <CollapsedOutputDisplay
            output={line.text}
            maxLines={maxPreviewLines}
            maxChars={maxPreviewChars}
            hintText={expandToolsHint("expand")}
          />
        ) : hasText ? (
          <MarkdownText text={line.text} />
        ) : (
          <Text color={colors.event.hint} dimColor italic>
            {thinkingText}
          </Text>
        )}
        {expanded && canCollapse ? (
          <Text color={colors.customMessage.hint} dimColor>
            ({expandToolsHint("collapse")})
          </Text>
        ) : null}
        {line.phase === "streaming" && cursorVisible && hasText ? (
          <Text color={colors.event.worker}>▋</Text>
        ) : null}
      </Box>
    );
  },
);

AssistantMessage.displayName = "AssistantMessage";
