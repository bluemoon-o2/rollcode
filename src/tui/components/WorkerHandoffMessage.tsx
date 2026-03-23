import { Box } from "ink";
import { memo } from "react";
import { TUI_ANIMATIONS_ENABLED } from "../animation";
import { useAnimation } from "../contexts/AnimationContext";
import type { WorkerHandoff } from "../../domain/types";
import { colors } from "./colors";
import { FlowingRoleLabel } from "./FlowingRoleLabel";
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
    const { shouldAnimate } = useAnimation();
    const animate = TUI_ANIMATIONS_ENABLED && shouldAnimate;
    const summary = compactSummary(handoff.summary);
    const completionLabel = handoff.completionClaim ? "yes" : "no";
    const completionColor = handoff.completionClaim
      ? colors.customMessage.success
      : colors.customMessage.warning;

    if (!expanded) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap">
            <Box width={2} flexShrink={0}>
              <Text color={colors.customMessage.label}>▌</Text>
            </Box>
            <Text color={colors.event.hint} dimColor>
              handoff
            </Text>
            <Text> </Text>
            <Text color={colors.event.bracket}>[</Text>
            <FlowingRoleLabel
              text="worker"
              staticColor={colors.customMessage.label}
              palette={colors.event.roleFlow.worker}
              animate={animate}
            />
            <Text color={colors.event.bracket}>]</Text>
            <Text color={colors.event.hint} dimColor>
              {" "}
              ·{" "}
            </Text>
            <Text color={colors.customMessage.text}>{summary}</Text>
            <Text color={colors.event.hint} dimColor>
              {" "}
              · completion:{" "}
            </Text>
            <Text color={completionColor}>{completionLabel}</Text>
            <Text color={colors.customMessage.hint} dimColor>
              {" "}
              ({expandToolsHint("expand")})
            </Text>
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Box width={2} flexShrink={0}>
            <Text color={colors.customMessage.label}>▌</Text>
          </Box>
          <Text color={colors.event.hint} dimColor>
            handoff
          </Text>
          <Text> </Text>
          <Text color={colors.event.bracket}>[</Text>
          <FlowingRoleLabel
            text="worker"
            staticColor={colors.customMessage.label}
            palette={colors.event.roleFlow.worker}
            animate={animate}
          />
          <Text color={colors.event.bracket}>]</Text>
          <Text color={colors.event.hint} dimColor>
            {" "}
            ·{" "}
          </Text>
          <Text color={completionColor}>
            completion claim: {completionLabel}
          </Text>
          <Text color={colors.customMessage.hint} dimColor>
            {" "}
            ({expandToolsHint("collapse")})
          </Text>
        </Box>
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text color={colors.customMessage.label} dimColor>
              ▏
            </Text>
          </Box>
          <Box flexGrow={1}>
            <MarkdownText
              text={formatExpandedBody(handoff)}
              baseColor={colors.customMessage.text}
            />
          </Box>
        </Box>
      </Box>
    );
  },
);

WorkerHandoffMessage.displayName = "WorkerHandoffMessage";
