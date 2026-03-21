import { Box } from "ink";
import { memo } from "react";
import { colors } from "./colors";
import { expandToolsHint } from "./keybindingHints";
import { MarkdownText } from "./MarkdownText";
import { Text } from "./Text";

export const ExpandableDetailsMessage = memo(
  ({
    label,
    summary,
    content,
    expanded,
  }: {
    label: string;
    summary: string;
    content: string;
    expanded: boolean;
  }) => {
    if (!content.trim()) {
      return null;
    }

    if (!expanded) {
      return (
        <Box flexDirection="row" flexWrap="wrap">
          <Text color={colors.customMessage.label}>[{label}]</Text>
          <Text> </Text>
          <Text color={colors.customMessage.text}>{summary}</Text>
          <Text color={colors.customMessage.hint} dimColor>
            {" "}
            ({expandToolsHint("expand")})
          </Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Text color={colors.customMessage.label}>[{label}]</Text>
          <Text color={colors.customMessage.hint} dimColor>
            {" "}
            ({expandToolsHint("collapse")})
          </Text>
        </Box>
        <MarkdownText text={content} baseColor={colors.customMessage.text} />
      </Box>
    );
  },
);

ExpandableDetailsMessage.displayName = "ExpandableDetailsMessage";
