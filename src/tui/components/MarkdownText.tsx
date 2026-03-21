import { Box } from "ink";
import { Fragment, memo } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

const CODE_FENCE_PATTERN = /^```([A-Za-z0-9_+.-]+)?\s*$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const BLOCKQUOTE_PATTERN = /^>\s?(.*)$/;
const LIST_PATTERN = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const HR_PATTERN = /^(\*{3,}|-{3,}|_{3,})\s*$/;

function renderInlineSegments(text: string, baseColor: string, key: string) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <Text color={baseColor}>
      {parts.map((part, index) => {
        const segmentKey = `${key}-${index}`;
        if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
          return (
            <Text key={segmentKey} color={colors.markdown.inlineCode}>
              {part.slice(1, -1)}
            </Text>
          );
        }
        return <Fragment key={segmentKey}>{part}</Fragment>;
      })}
    </Text>
  );
}

function normalizeLines(input: string): string[] {
  const lines = input.replace(/\r/g, "").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export const MarkdownText = memo(
  ({ text, baseColor = colors.event.body }: { text: string; baseColor?: string }) => {
    const lines = normalizeLines(text);
    if (lines.length === 0) {
      return null;
    }

    const nodes: JSX.Element[] = [];
    let inCodeBlock = false;
    let codeLanguage = "";

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const codeFence = CODE_FENCE_PATTERN.exec(line.trim());
      if (codeFence) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeLanguage = codeFence[1] ?? "";
          const languageLabel = codeLanguage ? ` (${codeLanguage})` : "";
          nodes.push(
            <Text key={`code-start-${index}`} color={colors.markdown.codeBorder}>
              +-- code{languageLabel}
            </Text>,
          );
        } else {
          inCodeBlock = false;
          nodes.push(
            <Text key={`code-end-${index}`} color={colors.markdown.codeBorder}>
              +--
            </Text>,
          );
        }
        continue;
      }

      if (inCodeBlock) {
        nodes.push(
          <Box key={`code-line-${index}`} flexDirection="row">
            <Text color={colors.markdown.codeBorder}>| </Text>
            <Text color={colors.markdown.codeBlock}>{line || " "}</Text>
          </Box>,
        );
        continue;
      }

      if (HR_PATTERN.test(line.trim())) {
        nodes.push(
          <Text key={`hr-${index}`} color={colors.markdown.hr}>
            ----------
          </Text>,
        );
        continue;
      }

      const heading = HEADING_PATTERN.exec(line);
      if (heading) {
        nodes.push(
          <Text key={`heading-${index}`} color={colors.markdown.heading} bold>
            {heading[2]}
          </Text>,
        );
        continue;
      }

      const quote = BLOCKQUOTE_PATTERN.exec(line);
      if (quote) {
        nodes.push(
          <Box key={`quote-${index}`} flexDirection="row">
            <Text color={colors.markdown.quoteBorder}>| </Text>
            {renderInlineSegments(
              quote[1] ?? "",
              colors.markdown.quote,
              `quote-inline-${index}`,
            )}
          </Box>,
        );
        continue;
      }

      const list = LIST_PATTERN.exec(line);
      if (list) {
        const indent = list[1] ?? "";
        const marker = list[2] ?? "-";
        const content = list[3] ?? "";
        nodes.push(
          <Box key={`list-${index}`} flexDirection="row">
            <Text>{indent}</Text>
            <Text color={colors.markdown.listBullet}>
              {marker === "-" || marker === "*" ? "-" : marker}
            </Text>
            <Text> </Text>
            {renderInlineSegments(content, baseColor, `list-inline-${index}`)}
          </Box>,
        );
        continue;
      }

      nodes.push(
        <Box key={`line-${index}`} flexDirection="row">
          {renderInlineSegments(line, baseColor, `inline-${index}`)}
        </Box>,
      );
    }

    return <Box flexDirection="column">{nodes}</Box>;
  },
);

MarkdownText.displayName = "MarkdownText";
