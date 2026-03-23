import { Box } from "ink";
import { memo } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

const DEFAULT_COLLAPSED_LINES = 3;
const DEFAULT_FIRST_PREFIX = "  ⎿  ";
const DEFAULT_REST_PREFIX = "     ";

function splitOutputLines(output: string): string[] {
  const lines = output.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function clipOutputByChars(
  output: string,
  maxChars?: number,
): { displayOutput: string; clippedByChars: boolean } {
  if (
    typeof maxChars !== "number" ||
    maxChars <= 0 ||
    output.length <= maxChars
  ) {
    return {
      displayOutput: output,
      clippedByChars: false,
    };
  }
  return {
    displayOutput: `${output.slice(0, maxChars)}…`,
    clippedByChars: true,
  };
}

export function shouldCollapseOutput(
  output: string,
  maxChars?: number,
  maxLines = DEFAULT_COLLAPSED_LINES,
): boolean {
  const clipped = clipOutputByChars(output, maxChars);
  const lines = splitOutputLines(clipped.displayOutput);
  return clipped.clippedByChars || lines.length > maxLines;
}

interface CollapsedOutputDisplayProps {
  output: string;
  maxLines?: number; // Infinity = show all lines
  maxChars?: number;
  hintText?: string;
  firstLinePrefix?: string;
  restLinePrefix?: string;
}

export const CollapsedOutputDisplay = memo(
  ({
    output,
    maxLines = DEFAULT_COLLAPSED_LINES,
    maxChars,
    hintText,
    firstLinePrefix = DEFAULT_FIRST_PREFIX,
    restLinePrefix = DEFAULT_REST_PREFIX,
  }: CollapsedOutputDisplayProps) => {
    const clipped = clipOutputByChars(output, maxChars);
    const lines = splitOutputLines(clipped.displayOutput);
    if (lines.length === 0) {
      return null;
    }

    const showAll = maxLines === Infinity || maxLines >= lines.length;
    const visibleLines = showAll ? lines : lines.slice(0, maxLines);
    const hiddenCount = showAll ? 0 : Math.max(0, lines.length - maxLines);
    const hintSuffix = hintText ? `, ${hintText}` : "";
    const prefixWidth = Math.max(firstLinePrefix.length, restLinePrefix.length);

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {prefixWidth > 0 ? (
            <Box width={prefixWidth} flexShrink={0}>
              <Text>{firstLinePrefix}</Text>
            </Box>
          ) : null}
          <Box flexGrow={1}>
            <Text color={colors.event.body}>{visibleLines[0] ?? ""}</Text>
          </Box>
        </Box>
        {visibleLines.slice(1).map((line, index) => (
          <Box key={`${index}-${line}`} flexDirection="row">
            {prefixWidth > 0 ? (
              <Box width={prefixWidth} flexShrink={0}>
                <Text>{restLinePrefix}</Text>
              </Box>
            ) : null}
            <Box flexGrow={1}>
              <Text color={colors.event.body}>{line}</Text>
            </Box>
          </Box>
        ))}
        {hiddenCount > 0 ? (
          <Box flexDirection="row">
            {prefixWidth > 0 ? (
              <Box width={prefixWidth} flexShrink={0}>
                <Text>{restLinePrefix}</Text>
              </Box>
            ) : null}
            <Box flexGrow={1}>
              <Text color={colors.event.hint} dimColor>
                ... ({hiddenCount} more lines{hintSuffix})
              </Text>
            </Box>
          </Box>
        ) : clipped.clippedByChars ? (
          <Box flexDirection="row">
            {prefixWidth > 0 ? (
              <Box width={prefixWidth} flexShrink={0}>
                <Text>{restLinePrefix}</Text>
              </Box>
            ) : null}
            <Box flexGrow={1}>
              <Text color={colors.event.hint} dimColor>
                ... (output clipped{hintSuffix})
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>
    );
  },
);

CollapsedOutputDisplay.displayName = "CollapsedOutputDisplay";
