import { Box, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";
import stringWidth from "string-width";
import type { RunRecord } from "../domain/types";
import { colors } from "./components/colors";
import { PatchedTextInput } from "./components/PatchedTextInput";
import { Text } from "./components/Text";
import { sanitizeLauncherInput } from "./launcherInput";
import {
  filterAndSortResumeOptions,
  type ResumePickerSortMode,
} from "./resumePickerSearch";
import { buildHorizontalLine, clearTerminalScreen } from "./terminal";

const MAX_VISIBLE_RUNS = 9;
const ESCAPE_CHAR = "\u001b";

export interface ResumePickerOption {
  run: RunRecord;
  agentName: string;
}

function truncateEnd(text: string, maxWidth: number): string {
  const limit = Math.max(0, Math.floor(maxWidth));
  if (limit <= 0) {
    return "";
  }
  if (stringWidth(text) <= limit) {
    return text;
  }
  if (limit <= 3) {
    let out = "";
    let width = 0;
    for (const char of text) {
      const nextWidth = width + stringWidth(char);
      if (nextWidth > limit) {
        break;
      }
      out += char;
      width = nextWidth;
    }
    return out;
  }
  const headLimit = limit - 3;
  let out = "";
  let width = 0;
  for (const char of text) {
    const nextWidth = width + stringWidth(char);
    if (nextWidth > headLimit) {
      break;
    }
    out += char;
    width = nextWidth;
  }
  return `${out}...`;
}

function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) {
    return iso;
  }
  const deltaMs = Math.max(0, now - at);
  const minutes = Math.floor(deltaMs / 60_000);
  const hours = Math.floor(deltaMs / 3_600_000);
  const days = Math.floor(deltaMs / 86_400_000);

  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function ResumePicker(props: {
  preferredOptions: ResumePickerOption[];
  allOptions: ResumePickerOption[];
  onSelect: (runId: string) => void;
  onCancel: () => void;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [scope, setScope] = useState<"current" | "all">("current");
  const [sortMode, setSortMode] = useState<ResumePickerSortMode>("recent");
  const [showDetails, setShowDetails] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filterInput, setFilterInput] = useState("");

  const sourceOptions = useMemo(
    () => (scope === "current" ? props.preferredOptions : props.allOptions),
    [scope, props.allOptions, props.preferredOptions],
  );

  const filteredOptions = useMemo(
    () => filterAndSortResumeOptions(sourceOptions, filterInput, sortMode),
    [sourceOptions, filterInput, sortMode],
  );

  useEffect(() => {
    if (filteredOptions.length === 0) {
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex((current) => Math.min(current, filteredOptions.length - 1));
  }, [filteredOptions.length]);

  useInput((_input, key) => {
    const isEscape = key.escape || _input === ESCAPE_CHAR;
    if (key.ctrl && _input === "c") {
      clearTerminalScreen(stdout);
      props.onCancel();
      exit();
      return;
    }
    if (_input === "\t" || key.tab) {
      setScope((current) => (current === "current" ? "all" : "current"));
      setSelectedIndex(0);
      return;
    }
    if (key.ctrl && _input.toLowerCase() === "s") {
      setSortMode((current) => (current === "recent" ? "relevance" : "recent"));
      setSelectedIndex(0);
      return;
    }
    if (key.ctrl && _input.toLowerCase() === "p") {
      setShowDetails((current) => !current);
      return;
    }
    if (isEscape) {
      if (filterInput) {
        setFilterInput("");
        return;
      }
      props.onCancel();
      clearTerminalScreen(stdout);
      exit();
      return;
    }
    if (key.upArrow) {
      if (filteredOptions.length === 0) {
        return;
      }
      setSelectedIndex((current) =>
        current > 0 ? current - 1 : filteredOptions.length - 1,
      );
      return;
    }
    if (key.downArrow) {
      if (filteredOptions.length === 0) {
        return;
      }
      setSelectedIndex((current) =>
        current < filteredOptions.length - 1 ? current + 1 : 0,
      );
      return;
    }
    if (key.pageUp) {
      if (filteredOptions.length === 0) {
        return;
      }
      setSelectedIndex((current) =>
        Math.max(0, current - MAX_VISIBLE_RUNS),
      );
      return;
    }
    if (key.pageDown) {
      if (filteredOptions.length === 0) {
        return;
      }
      setSelectedIndex((current) =>
        Math.min(filteredOptions.length - 1, current + MAX_VISIBLE_RUNS),
      );
      return;
    }
    if (key.return) {
      const selected = filteredOptions[selectedIndex];
      if (selected) {
        clearTerminalScreen(stdout);
        props.onSelect(selected.run.id);
        exit();
        return;
      }
      if (props.allOptions.length === 0) {
        clearTerminalScreen(stdout);
        props.onCancel();
        exit();
      }
      return;
    }
  });

  const visible = useMemo(() => {
    const total = filteredOptions.length;
    const boundedIndex = Math.min(selectedIndex, Math.max(0, total - 1));
    const needsScroll = total > MAX_VISIBLE_RUNS;
    const start = needsScroll
      ? Math.max(
          0,
          Math.min(
            boundedIndex - Math.floor(MAX_VISIBLE_RUNS / 2),
            total - MAX_VISIBLE_RUNS,
          ),
        )
      : 0;
    const items = filteredOptions.slice(start, start + MAX_VISIBLE_RUNS);
    return {
      start,
      items,
      showMore: start + MAX_VISIBLE_RUNS < total,
      total,
      boundedIndex,
    };
  }, [filteredOptions, selectedIndex]);
  const terminalColumns = Math.max(40, stdout?.columns ?? 80);
  const horizontalLine = useMemo(
    () => buildHorizontalLine(terminalColumns, "─"),
    [terminalColumns],
  );
  const metaWidth = Math.max(24, terminalColumns - 6);
  const scopeText =
    scope === "current"
      ? "◉ Current Agent | ○ All"
      : `○ Current Agent | ◉ All`;
  const sortLabel = sortMode === "recent" ? "Recent" : "Fuzzy";
  const pathState = showDetails ? "on" : "off";

  return (
    <Box flexDirection="column">
      <Text color={colors.picker.title} bold>
        {scope === "current"
          ? "Resume Session (Current Agent)"
          : "Resume Session (All)"}
      </Text>
      <Text color={colors.picker.subtitle}>
        {scopeText} · Sort: {sortLabel}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.input.divider} dimColor>
          {horizontalLine}
        </Text>
        <Box>
          <PatchedTextInput
            value={filterInput}
            onChange={(value) => {
              setFilterInput(sanitizeLauncherInput(value));
            }}
            onSubmit={() => {}}
            placeholder="Filter by run id / goal / agent / status"
            focus
          />
        </Box>
        <Text color={colors.input.divider} dimColor>
          {horizontalLine}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.input.divider} dimColor>
          {horizontalLine}
        </Text>
        {visible.items.length === 0 ? (
          <Text color={colors.picker.muted}>
            {"  "}
            {scope === "current" && props.preferredOptions.length === 0
              ? "No runs in current agent. Press Tab to view all."
              : "No runs match the current filter."}
          </Text>
        ) : (
          visible.items.map((option, index) => {
            const actualIndex = visible.start + index;
            const selected = actualIndex === visible.boundedIndex;
            const run = option.run;
            const stamp = formatRelativeTime(run.updatedAt);
            const message = (run.goal || run.id)
              .replace(/[\x00-\x1f\x7f]/g, " ")
              .trim();
            const rightMetaParts = showDetails
              ? [option.agentName, run.status, `${run.workerTurnCount}`, stamp]
              : [`${run.workerTurnCount}`, stamp];
            const rightMeta = rightMetaParts.join(" ");
            const rightMetaWidth = stringWidth(rightMeta);
            const maxMain = Math.max(12, metaWidth - rightMetaWidth - 6);
            const mainText = truncateEnd(message, maxMain);
            const mainWidth = stringWidth(mainText);
            const spacing = " ".repeat(
              Math.max(1, metaWidth - mainWidth - rightMetaWidth - 2),
            );
            return (
              <Box key={run.id} flexDirection="column">
                <Text
                  color={selected ? colors.picker.selected : colors.picker.text}
                  bold={selected}
                >
                  {selected ? "> " : "  "}
                  {truncateEnd(
                    `${mainText}${spacing}${rightMeta}`,
                    metaWidth,
                  )}
                </Text>
              </Box>
            );
          })
        )}
        {visible.showMore ? (
          <Text color={colors.picker.muted}>
            {"  "}↓ {visible.total - visible.start - MAX_VISIBLE_RUNS} more
          </Text>
        ) : null}
        <Text color={colors.input.divider} dimColor>
          {horizontalLine}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={colors.picker.hint} dimColor>
          Tab scope · Ctrl+S sort · Ctrl+P details ({pathState}) · re:&lt;pattern&gt; regex ·
          "phrase" exact
        </Text>
      </Box>
      <Box marginTop={0}>
        <Text color={colors.picker.hint} dimColor>
          ↑↓ navigate · PgUp/PgDn page jump · Enter select · Esc clear/cancel
        </Text>
      </Box>
    </Box>
  );
}
