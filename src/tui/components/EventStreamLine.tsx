import { Box } from "ink";
import { memo } from "react";
import type { ThreadRole } from "../../domain/types";
import { BlinkDot } from "./BlinkDot";
import {
  CollapsedOutputDisplay,
  shouldCollapseOutput,
} from "./CollapsedOutputDisplay";
import { colors } from "./colors";
import { FlowingRoleLabel } from "./FlowingRoleLabel";
import { expandToolsHint } from "./keybindingHints";
import { Text } from "./Text";
import { useAnimationTick } from "./useAnimationTick";

const EVENT_PREFIX_PATTERN =
  /^(\d{2}:\d{2}:\d{2}) \[(worker|supervisor|system)\] ?(.*)$/;

type ParsedEventPrefix = {
  stamp: string;
  role: ThreadRole | "system";
  message: string;
};

function parseEventPrefix(line: string): ParsedEventPrefix | null {
  const match = EVENT_PREFIX_PATTERN.exec(line);
  if (!match) {
    return null;
  }
  const [, stamp, role, message] = match;
  if (role !== "worker" && role !== "supervisor" && role !== "system") {
    return null;
  }
  return {
    stamp,
    role,
    message,
  };
}

function normalizeLines(input: string): string[] {
  const lines = input.replace(/\r/g, "").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function extractEventBody(line: string): string {
  const lines = normalizeLines(line);
  if (lines.length === 0) {
    return "";
  }
  const firstLine = lines[0] ?? "";
  const parsed = parseEventPrefix(firstLine);
  if (!parsed) {
    return lines.join("\n");
  }
  return [parsed.message, ...lines.slice(1)].join("\n");
}

export function shouldCollapseEventLine(
  line: string,
  maxPreviewChars: number,
  maxPreviewLines = 1,
): boolean {
  const body = extractEventBody(line);
  if (!body) {
    return false;
  }
  return shouldCollapseOutput(body, maxPreviewChars, maxPreviewLines);
}

function renderRole(props: {
  role: ThreadRole | "system";
  activeThreadRole: ThreadRole | null;
  animate: boolean;
}) {
  if (props.role === "worker") {
    return (
      <FlowingRoleLabel
        text="worker"
        staticColor={colors.event.worker}
        palette={colors.event.roleFlow.worker}
        animate={props.animate && props.activeThreadRole === "worker"}
      />
    );
  }
  if (props.role === "supervisor") {
    return (
      <FlowingRoleLabel
        text="supervisor"
        staticColor={colors.event.supervisor}
        palette={colors.event.roleFlow.supervisor}
        animate={props.animate && props.activeThreadRole === "supervisor"}
      />
    );
  }
  return <Text color={colors.event.system}>system</Text>;
}

function getRoleColor(role: ThreadRole | "system"): string {
  if (role === "worker") {
    return colors.event.worker;
  }
  if (role === "supervisor") {
    return colors.event.supervisor;
  }
  return colors.event.system;
}

export const EventStreamLine = memo(
  ({
  line,
  expanded,
  maxPreviewChars,
  maxPreviewLines = 1,
  activeThreadRole,
  animate,
  }: {
    line: string;
    expanded: boolean;
    maxPreviewChars: number;
    maxPreviewLines?: number;
    activeThreadRole: ThreadRole | null;
    animate: boolean;
  }) => {
    const lines = normalizeLines(line);
    if (lines.length === 0) {
      return null;
    }

    const firstLine = lines[0] ?? "";
    const parsedFirst = parseEventPrefix(firstLine);
    const role = parsedFirst?.role ?? "system";
    const body = extractEventBody(line);
    const showActiveDot =
      animate &&
      (role === "worker" || role === "supervisor") &&
      activeThreadRole === role;
    const roleColor = getRoleColor(role);
    const bodyCollapsed =
      !expanded && shouldCollapseOutput(body, maxPreviewChars, maxPreviewLines);
    const frameTick = useAnimationTick(showActiveDot);
    const railFrames = ["▏", "▎", "▍", "▎"] as const;
    const railSymbol = showActiveDot
      ? railFrames[frameTick % railFrames.length] ?? "▎"
      : "▏";

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Box width={2} flexShrink={0}>
            {showActiveDot ? (
              <BlinkDot
                color={roleColor}
                shouldAnimate={animate}
              />
            ) : (
              <Text color={roleColor}>
                ▌
              </Text>
            )}
          </Box>
          <Text color={colors.event.hint} dimColor>
            event
          </Text>
          <Text> </Text>
          <Text color={colors.event.bracket}>[</Text>
          {parsedFirst ? (
            renderRole({
              role: parsedFirst.role,
              activeThreadRole,
              animate,
            })
          ) : (
            <Text color={colors.event.system}>system</Text>
          )}
          <Text color={colors.event.bracket}>]</Text>
          {parsedFirst ? (
            <>
              <Text color={colors.event.hint} dimColor>
                {" "}
                ·{" "}
              </Text>
              <Text color={colors.event.timestamp}>{parsedFirst.stamp}</Text>
            </>
          ) : null}
        </Box>
        {body ? (
          <Box flexDirection="row">
            <Box width={2} flexShrink={0}>
              <Text color={roleColor} dimColor>
                {railSymbol}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <CollapsedOutputDisplay
                output={body}
                maxLines={expanded ? Infinity : maxPreviewLines}
                maxChars={expanded ? undefined : maxPreviewChars}
                hintText={bodyCollapsed ? expandToolsHint("expand") : undefined}
                firstLinePrefix=""
                restLinePrefix=""
              />
            </Box>
          </Box>
        ) : null}
      </Box>
    );
  },
);

EventStreamLine.displayName = "EventStreamLine";
