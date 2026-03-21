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

    return (
      <Box flexDirection="column">
        {prompt ? <Text color={colors.userMessage.label}>{prompt}</Text> : null}
        {collapsed ? (
          <CollapsedOutputDisplay
            output={normalized}
            maxLines={maxPreviewLines}
            maxChars={maxPreviewChars}
            hintText={expandToolsHint("expand")}
          />
        ) : (
          <>
            {lines.map((entry, index) => (
              <Text
                key={`${line.id}-${index}`}
                color={colors.userMessage.text}
                backgroundColor={colors.userMessage.background}
              >
                {" "}
                {entry || " "}
                {" "}
              </Text>
            ))}
            {expanded && canCollapse ? (
              <Text color={colors.customMessage.hint} dimColor>
                ({expandToolsHint("collapse")})
              </Text>
            ) : null}
          </>
        )}
      </Box>
    );
  },
);

UserMessage.displayName = "UserMessage";
