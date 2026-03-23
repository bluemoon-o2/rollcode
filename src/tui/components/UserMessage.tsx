import { Box } from "ink";
import { memo } from "react";
import {
  CollapsedOutputDisplay,
  shouldCollapseOutput,
} from "./CollapsedOutputDisplay";
import { colors } from "./colors";
import { expandToolsHint } from "./keybindingHints";
import { Text } from "./Text";

type UserLine = {
  kind: "user";
  id: string;
  text: string;
};

export const UserMessage = memo(
  ({
    line,
    prompt,
    expanded = true,
    maxPreviewChars,
    maxPreviewLines = 3,
  }: {
    line: UserLine;
    prompt?: string;
    expanded?: boolean;
    maxPreviewChars?: number;
    maxPreviewLines?: number;
  }) => {
    const normalized = line.text.replace(/\r/g, "");
    const collapsed =
      !expanded &&
      shouldCollapseOutput(normalized, maxPreviewChars, maxPreviewLines);
    const lines = normalized.split("\n");
    const canCollapse = shouldCollapseOutput(
      normalized,
      maxPreviewChars,
      maxPreviewLines,
    );
    const title = prompt || (line.id.startsWith("goal-") ? "goal" : "user");

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Box width={2} flexShrink={0}>
            <Text color={colors.userMessage.label}>▌</Text>
          </Box>
          <Text color={colors.event.hint} dimColor>
            message
          </Text>
          <Text> </Text>
          <Text color={colors.event.bracket}>[</Text>
          <Text color={colors.userMessage.label}>{title}</Text>
          <Text color={colors.event.bracket}>]</Text>
        </Box>
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text color={colors.userMessage.label} dimColor>
              ▏
            </Text>
          </Box>
          <Box flexGrow={1}>
            {collapsed ? (
              <CollapsedOutputDisplay
                output={normalized}
                maxLines={maxPreviewLines}
                maxChars={maxPreviewChars}
                hintText={expandToolsHint("expand")}
                firstLinePrefix=""
                restLinePrefix=""
              />
            ) : (
              <Box flexDirection="column">
                {lines.map((entry, index) => (
                  <Text
                    key={`${line.id}-${index}`}
                    color={colors.userMessage.text}
                  >
                    {entry || " "}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        </Box>
        {expanded && canCollapse ? (
          <Box flexDirection="row">
            <Box width={2} flexShrink={0}>
              <Text color={colors.userMessage.label} dimColor>
                ▏
              </Text>
            </Box>
            <Text color={colors.customMessage.hint} dimColor>
              ({expandToolsHint("collapse")})
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  },
);

UserMessage.displayName = "UserMessage";
