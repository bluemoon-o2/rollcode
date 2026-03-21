import { Box, useStdout } from "ink";
import { useEffect, useMemo } from "react";
import { useAutocompleteNavigation } from "../hooks/useAutocompleteNavigation";
import type { SlashCommandSpec } from "../slashCommands";
import { buildSlashAutocompleteState } from "../slashCommands";
import { colors } from "./colors";
import { Text } from "./Text";

const DEFAULT_VISIBLE_COMMANDS = 7;
const MIN_LAYOUT_WIDTH_WITH_DESCRIPTION = 40;
const MIN_VALUE_WIDTH = 10;
const DESCRIPTION_START_COLUMN = 32;

function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (text.length <= maxWidth) {
    return text;
  }
  return text.slice(0, maxWidth);
}

function normalizeToSingleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

export interface SlashCommandAutocompleteProps {
  currentInput: string;
  cursorPosition: number;
  commands: SlashCommandSpec[];
  visibleCommands?: number;
  onSelect?: (command: string) => void;
  onAutocomplete?: (command: string) => void;
  onActiveChange?: (isActive: boolean) => void;
  onSelectedIndexChange?: (index: number) => void;
  disabled?: boolean;
}

export function SlashCommandAutocomplete({
  currentInput,
  cursorPosition,
  commands,
  visibleCommands = DEFAULT_VISIBLE_COMMANDS,
  onSelect,
  onAutocomplete,
  onActiveChange,
  onSelectedIndexChange,
  disabled = false,
}: SlashCommandAutocompleteProps) {
  const { stdout } = useStdout();
  const state = useMemo(
    () => buildSlashAutocompleteState(currentInput, commands, cursorPosition),
    [currentInput, commands, cursorPosition],
  );
  const matches = state.active ? state.matches : [];
  const { selectedIndex } = useAutocompleteNavigation({
    matches,
    onSelect: onSelect ? (item) => onSelect(item.command) : undefined,
    onAutocomplete: onAutocomplete
      ? (item) => onAutocomplete(item.command)
      : undefined,
    manageActiveState: false,
    disabled,
  });

  useEffect(() => {
    onSelectedIndexChange?.(selectedIndex);
  }, [selectedIndex, onSelectedIndexChange]);

  useEffect(() => {
    // Treat autocomplete as active only when there are selectable matches.
    // This lets Enter submit unknown slash commands to launcher handlers.
    const isActive = state.active && matches.length > 0;
    onActiveChange?.(isActive);
  }, [state.active, matches.length, onActiveChange]);

  if (!currentInput.startsWith("/")) {
    return null;
  }

  if (state.showNoMatches) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={colors.autocomplete.muted}>
          {"  "}No matching commands
        </Text>
      </Box>
    );
  }

  if (!state.active || matches.length === 0) {
    return null;
  }

  const totalMatches = matches.length;
  const needsScrolling = totalMatches > visibleCommands;
  const safeSelectedIndex =
    totalMatches === 0 ? 0 : Math.min(selectedIndex, totalMatches - 1);
  const scrollWindowStart = needsScrolling
    ? Math.max(
        0,
        Math.min(
          safeSelectedIndex - Math.floor(visibleCommands / 2),
          totalMatches - visibleCommands,
        ),
      )
    : 0;
  const visibleMatches = matches.slice(
    scrollWindowStart,
    scrollWindowStart + visibleCommands,
  );
  const endIndex = scrollWindowStart + visibleMatches.length;
  const terminalColumns = Math.max(40, stdout?.columns ?? 80);
  const showDescription = terminalColumns > MIN_LAYOUT_WIDTH_WITH_DESCRIPTION;
  const selectedPosition = safeSelectedIndex + 1;

  return (
    <Box marginTop={1} flexDirection="column">
      {visibleMatches.map((item, index) => {
        const actualIndex = scrollWindowStart + index;
        const selected = actualIndex === safeSelectedIndex;
        const prefix = selected ? "→ " : "  ";
        const prefixWidth = 2;
        const value = item.command;
        const description = normalizeToSingleLine(item.description);
        let displayValue = value;
        let displayDescription = "";
        let spacing = "";

        if (showDescription && description.length > 0) {
          const maxValueWidth = Math.min(
            30,
            Math.max(MIN_VALUE_WIDTH, terminalColumns - prefixWidth - 4),
          );
          displayValue = truncateToWidth(value, maxValueWidth);
          spacing = " ".repeat(
            Math.max(1, DESCRIPTION_START_COLUMN - displayValue.length),
          );
          const descriptionStart =
            prefixWidth + displayValue.length + spacing.length;
          const remainingWidth = terminalColumns - descriptionStart - 2;
          displayDescription =
            remainingWidth > MIN_VALUE_WIDTH
              ? truncateToWidth(description, remainingWidth)
              : "";
        } else {
          displayValue = truncateToWidth(value, terminalColumns - prefixWidth - 2);
        }

        return (
          <Text
            key={item.command}
            color={selected ? colors.autocomplete.selected : undefined}
          >
            {prefix}
            {displayValue}
            {displayDescription && !selected ? (
              <Text color={colors.autocomplete.detail} dimColor={!selected}>
                {spacing}
                {displayDescription}
              </Text>
            ) : displayDescription ? (
              <>
                {spacing}
                {displayDescription}
              </>
            ) : null}
          </Text>
        );
      })}
      {scrollWindowStart > 0 || endIndex < totalMatches ? (
        <Text color={colors.autocomplete.muted}>
          {"  "}({selectedPosition}/{totalMatches})
        </Text>
      ) : null}
    </Box>
  );
}
