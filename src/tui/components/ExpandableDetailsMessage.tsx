import { Box } from "ink";
import { memo } from "react";
import { TUI_ANIMATIONS_ENABLED } from "../animation";
import { useAnimation } from "../contexts/AnimationContext";
import { colors } from "./colors";
import { FlowingRoleLabel } from "./FlowingRoleLabel";
import { expandToolsHint } from "./keybindingHints";
import { MarkdownText } from "./MarkdownText";
import { Text } from "./Text";

function getLabelColor(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (normalized === "supervisor") {
    return colors.event.supervisor;
  }
  if (normalized === "plan") {
    return colors.plan.inProgress;
  }
  if (normalized === "diff") {
    return colors.event.worker;
  }
  return colors.customMessage.label;
}

function getLabelPalette(label: string): readonly string[] {
  const normalized = label.trim().toLowerCase();
  if (normalized === "supervisor") {
    return colors.event.roleFlow.supervisor;
  }
  return colors.event.roleFlow.worker;
}

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
    const { shouldAnimate } = useAnimation();
    const animate = TUI_ANIMATIONS_ENABLED && shouldAnimate;
    const labelColor = getLabelColor(label);
    const labelPalette = getLabelPalette(label);
    if (!content.trim()) {
      return null;
    }

    if (!expanded) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap">
            <Box width={2} flexShrink={0}>
              <Text color={labelColor}>▌</Text>
            </Box>
            <Text color={colors.event.hint} dimColor>
              detail
            </Text>
            <Text> </Text>
            <Text color={colors.event.bracket}>[</Text>
            <FlowingRoleLabel
              text={label}
              staticColor={labelColor}
              palette={labelPalette}
              animate={animate}
            />
            <Text color={colors.event.bracket}>]</Text>
            <Text color={colors.event.hint} dimColor>
              {" "}
              ·{" "}
            </Text>
            <Text color={colors.customMessage.text}>{summary}</Text>
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
            <Text color={labelColor}>▌</Text>
          </Box>
          <Text color={colors.event.hint} dimColor>
            detail
          </Text>
          <Text> </Text>
          <Text color={colors.event.bracket}>[</Text>
          <FlowingRoleLabel
            text={label}
            staticColor={labelColor}
            palette={labelPalette}
            animate={animate}
          />
          <Text color={colors.event.bracket}>]</Text>
          <Text color={colors.customMessage.hint} dimColor>
            {" "}
            ({expandToolsHint("collapse")})
          </Text>
        </Box>
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text color={labelColor} dimColor>
              ▏
            </Text>
          </Box>
          <Box flexGrow={1}>
            <MarkdownText text={content} baseColor={colors.customMessage.text} />
          </Box>
        </Box>
      </Box>
    );
  },
);

ExpandableDetailsMessage.displayName = "ExpandableDetailsMessage";
