import { Box } from "ink";
import { memo, useEffect, useState } from "react";
import { TUI_ANIMATIONS_ENABLED } from "../animation";
import { useAnimation } from "../contexts/AnimationContext";
import { BlinkDot } from "./BlinkDot";
import {
  CollapsedOutputDisplay,
  shouldCollapseOutput,
} from "./CollapsedOutputDisplay";
import { colors } from "./colors";
import { FlowingRoleLabel } from "./FlowingRoleLabel";
import { expandToolsHint } from "./keybindingHints";
import { MarkdownText } from "./MarkdownText";
import { Text } from "./Text";
import { useAnimationTick } from "./useAnimationTick";

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
    const frameTick = useAnimationTick(line.phase === "streaming");
    const railFrames = ["▏", "▎", "▍", "▎"] as const;
    const railSymbol =
      line.phase === "streaming" && animate
        ? railFrames[frameTick % railFrames.length] ?? "▎"
        : "▏";

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Box width={2} flexShrink={0}>
            {line.phase === "streaming" ? (
              <BlinkDot
                color={colors.event.worker}
                symbol="●"
                shouldAnimate={animate}
              />
            ) : (
              <Text color={colors.event.worker}>▌</Text>
            )}
          </Box>
          <Text color={colors.event.hint} dimColor>
            message
          </Text>
          <Text> </Text>
          <Text color={colors.event.bracket}>[</Text>
          <FlowingRoleLabel
            text="assistant"
            staticColor={colors.event.worker}
            palette={colors.event.roleFlow.worker}
            animate={line.phase === "streaming"}
          />
          <Text color={colors.event.bracket}>]</Text>
          <Text color={colors.event.hint} dimColor>
            {" "}
            ·{" "}
          </Text>
          <Text color={colors.event.hint} dimColor>
            {line.phase === "streaming" ? "streaming" : "final"}
          </Text>
        </Box>
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text color={colors.event.worker} dimColor>
              {railSymbol}
            </Text>
          </Box>
          <Box flexGrow={1}>
            {collapsed ? (
              <CollapsedOutputDisplay
                output={line.text}
                maxLines={maxPreviewLines}
                maxChars={maxPreviewChars}
                hintText={expandToolsHint("expand")}
                firstLinePrefix=""
                restLinePrefix=""
              />
            ) : hasText ? (
              <MarkdownText text={line.text} />
            ) : (
              <Text color={colors.event.hint} dimColor italic>
                {thinkingText}
              </Text>
            )}
          </Box>
        </Box>
        {expanded && canCollapse ? (
          <Box flexDirection="row">
            <Box width={2} flexShrink={0}>
              <Text color={colors.event.worker} dimColor>
                {railSymbol}
              </Text>
            </Box>
            <Text color={colors.customMessage.hint} dimColor>
              ({expandToolsHint("collapse")})
            </Text>
          </Box>
        ) : null}
        {line.phase === "streaming" && cursorVisible && hasText ? (
          <Box flexDirection="row">
            <Box width={2} flexShrink={0}>
              <Text color={colors.event.worker} dimColor>
                {railSymbol}
              </Text>
            </Box>
            <Text color={colors.event.worker}>▋</Text>
          </Box>
        ) : null}
      </Box>
    );
  },
);

AssistantMessage.displayName = "AssistantMessage";
