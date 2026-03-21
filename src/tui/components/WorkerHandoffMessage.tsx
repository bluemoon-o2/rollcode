import { Box } from "ink";
import { memo } from "react";
import type { WorkerHandoff } from "../../domain/types";
import { colors } from "./colors";
import { expandToolsHint } from "./keybindingHints";
import { MarkdownText } from "./MarkdownText";
import { Text } from "./Text";

function formatList(title: string, entries: string[]): string {
  if (entries.length === 0) {
    return `${title}:\n- none`;
  }
  return `${title}:\n${entries.map((entry) => `- ${entry}`).join("\n")}`;
}

function formatExpandedBody(handoff: WorkerHandoff): string {
  return [
    `summary: ${handoff.summary.trim() || "(missing summary)"}`,
    `completion claim: ${handoff.completionClaim ? "yes" : "no"}`,
    formatList("evidence", handoff.evidence),
    formatList("unresolved", handoff.unresolved),
  ].join("\n\n");
}

function compactSummary(summary: string): string {
  const compact = summary.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "(missing summary)";
  }
  if (compact.length <= 96) {
    return compact;
  }
  return `${compact.slice(0, 93)}...`;
}

export const WorkerHandoffMessage = memo(
  ({ handoff, expanded }: { handoff: WorkerHandoff; expanded: boolean }) => {
    const summary = compactSummary(handoff.summary);
    const completionLabel = handoff.completionClaim ? "yes" : "no";

    if (!expanded) {
      return (
        <Box flexDirection="row" flexWrap="wrap">
          <Text color={colors.customMessage.label}>[handoff]</Text>
          <Text> </Text>
          <Text color={colors.customMessage.text}>{summary}</Text>
          <Text> </Text>
          <Text
            color={
              handoff.completionClaim
                ? colors.customMessage.success
                : colors.customMessage.warning
            }
          >
            completion: {completionLabel}
          </Text>
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
          <Text color={colors.customMessage.label}>[handoff]</Text>
          <Text> </Text>
          <Text
            color={
              handoff.completionClaim
                ? colors.customMessage.success
                : colors.customMessage.warning
            }
          >
            completion claim: {completionLabel}
          </Text>
          <Text color={colors.customMessage.hint} dimColor>
            {" "}
            ({expandToolsHint("collapse")})
          </Text>
        </Box>
        <MarkdownText
          text={formatExpandedBody(handoff)}
          baseColor={colors.customMessage.text}
        />
      </Box>
    );
  },
);

WorkerHandoffMessage.displayName = "WorkerHandoffMessage";
