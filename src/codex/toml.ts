import { normalizeTomlText } from "./textNormalization";

const TOML_SECTION_HEADER_PATTERN = /^\s*\[([^\]\r\n]+)\]\s*$/;
const TOML_BASE_URL_PATTERN =
  /^\s*base_url\s*=\s*(["'])([^"'\r\n]+)\1\s*(?:#.*)?$/;
const TOML_MODEL_PATTERN = /^\s*model\s*=\s*(["'])([^"'\r\n]+)\1\s*(?:#.*)?$/;
const TOML_MODEL_PROVIDER_LINE_PATTERN =
  /^\s*model_provider\s*=\s*(["'])([^"'\r\n]+)\1\s*(?:#.*)?$/;
const TOML_MODEL_PROVIDER_PATTERN =
  /^\s*model_provider\s*=\s*(["'])([^"'\r\n]+)\1\s*(?:#.*)?$/m;

interface TomlSectionRange {
  bodyEndIndex: number;
  bodyStartIndex: number;
}

interface TomlAssignmentMatch {
  index: number;
  sectionName?: string;
  value: string;
}

const finalizeTomlText = (lines: string[]): string =>
  lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");

const getTomlSectionRange = (
  lines: string[],
  sectionName: string,
): TomlSectionRange | undefined => {
  let headerLineIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(TOML_SECTION_HEADER_PATTERN);
    if (!match) {
      continue;
    }

    if (headerLineIndex === -1) {
      if (match[1] === sectionName) {
        headerLineIndex = index;
      }
      continue;
    }

    return {
      bodyStartIndex: headerLineIndex + 1,
      bodyEndIndex: index,
    };
  }

  if (headerLineIndex === -1) {
    return undefined;
  }

  return {
    bodyStartIndex: headerLineIndex + 1,
    bodyEndIndex: lines.length,
  };
};

const getTopLevelEndIndex = (lines: string[]): number => {
  const firstSectionIndex = lines.findIndex((line) =>
    TOML_SECTION_HEADER_PATTERN.test(line),
  );
  return firstSectionIndex === -1 ? lines.length : firstSectionIndex;
};

const getTomlSectionInsertIndex = (
  lines: string[],
  sectionRange: TomlSectionRange,
): number => {
  let insertIndex = sectionRange.bodyEndIndex;
  while (
    insertIndex > sectionRange.bodyStartIndex &&
    lines[insertIndex - 1]?.trim() === ""
  ) {
    insertIndex -= 1;
  }
  return insertIndex;
};

const getCodexModelProviderName = (configText: string): string | undefined => {
  const match = configText.match(TOML_MODEL_PROVIDER_PATTERN);
  const providerName = match?.[2]?.trim();
  return providerName || undefined;
};

const getCodexProviderSectionName = (
  configText: string,
): string | undefined => {
  const providerName = getCodexModelProviderName(configText);
  return providerName ? `model_providers.${providerName}` : undefined;
};

const findTomlAssignmentInRange = (
  lines: string[],
  pattern: RegExp,
  startIndex: number,
  endIndex: number,
  sectionName?: string,
): TomlAssignmentMatch | undefined => {
  for (let index = startIndex; index < endIndex; index += 1) {
    const match = lines[index]?.match(pattern);
    if (match?.[2]) {
      return {
        index,
        sectionName,
        value: match[2],
      };
    }
  }
  return undefined;
};

const findTomlAssignments = (
  lines: string[],
  pattern: RegExp,
): TomlAssignmentMatch[] => {
  const assignments: TomlAssignmentMatch[] = [];
  let currentSectionName: string | undefined;

  lines.forEach((line, index) => {
    const sectionMatch = line.match(TOML_SECTION_HEADER_PATTERN);
    if (sectionMatch) {
      currentSectionName = sectionMatch[1];
      return;
    }

    const match = line.match(pattern);
    if (!match?.[2]) {
      return;
    }

    assignments.push({
      index,
      sectionName: currentSectionName,
      value: match[2],
    });
  });

  return assignments;
};

const isMcpServerSection = (sectionName?: string): boolean =>
  sectionName === "mcp_servers" ||
  sectionName?.startsWith("mcp_servers.") === true;

const isOtherProviderSection = (
  sectionName: string | undefined,
  targetSectionName: string | undefined,
): boolean =>
  Boolean(
    sectionName &&
      sectionName !== targetSectionName &&
      (sectionName === "model_providers" ||
        sectionName.startsWith("model_providers.")),
  );

const getRecoverableBaseUrlAssignments = (
  assignments: TomlAssignmentMatch[],
  targetSectionName: string | undefined,
): TomlAssignmentMatch[] =>
  assignments.filter(
    ({ sectionName }) =>
      sectionName !== targetSectionName &&
      !isMcpServerSection(sectionName) &&
      !isOtherProviderSection(sectionName, targetSectionName),
  );

const getTopLevelModelProviderLineIndex = (lines: string[]): number => {
  const topLevelEndIndex = getTopLevelEndIndex(lines);

  for (let index = 0; index < topLevelEndIndex; index += 1) {
    if (TOML_MODEL_PROVIDER_LINE_PATTERN.test(lines[index] ?? "")) {
      return index;
    }
  }

  return -1;
};

export const extractCodexBaseUrl = (
  configText: string | undefined | null,
): string | undefined => {
  try {
    const raw = typeof configText === "string" ? configText : "";
    const text = normalizeTomlText(raw);
    if (!text) {
      return undefined;
    }

    const lines = text.split("\n");
    const targetSectionName = getCodexProviderSectionName(text);

    if (targetSectionName) {
      const sectionRange = getTomlSectionRange(lines, targetSectionName);
      if (sectionRange) {
        const match = findTomlAssignmentInRange(
          lines,
          TOML_BASE_URL_PATTERN,
          sectionRange.bodyStartIndex,
          sectionRange.bodyEndIndex,
          targetSectionName,
        );
        if (match?.value) {
          return match.value;
        }
      }
    }

    const topLevelMatch = findTomlAssignmentInRange(
      lines,
      TOML_BASE_URL_PATTERN,
      0,
      getTopLevelEndIndex(lines),
    );
    if (topLevelMatch?.value) {
      return topLevelMatch.value;
    }

    const fallbackAssignments = getRecoverableBaseUrlAssignments(
      findTomlAssignments(lines, TOML_BASE_URL_PATTERN),
      targetSectionName,
    );
    return fallbackAssignments.length === 1
      ? fallbackAssignments[0]?.value
      : undefined;
  } catch {
    return undefined;
  }
};

export const setCodexBaseUrl = (
  configText: string,
  baseUrl: string,
): string => {
  const trimmed = baseUrl.trim();
  const normalizedText = normalizeTomlText(configText);
  const lines = normalizedText ? normalizedText.split("\n") : [];
  const targetSectionName = getCodexProviderSectionName(normalizedText);
  const allAssignments = findTomlAssignments(lines, TOML_BASE_URL_PATTERN);
  const recoverableAssignments = getRecoverableBaseUrlAssignments(
    allAssignments,
    targetSectionName,
  );

  if (!trimmed) {
    if (!normalizedText) {
      return normalizedText;
    }

    if (targetSectionName) {
      const sectionRange = getTomlSectionRange(lines, targetSectionName);
      const targetMatch = sectionRange
        ? findTomlAssignmentInRange(
            lines,
            TOML_BASE_URL_PATTERN,
            sectionRange.bodyStartIndex,
            sectionRange.bodyEndIndex,
            targetSectionName,
          )
        : undefined;

      if (targetMatch) {
        lines.splice(targetMatch.index, 1);
        return finalizeTomlText(lines);
      }
    }

    if (recoverableAssignments.length === 1) {
      const match = recoverableAssignments[0];
      if (match) {
        lines.splice(match.index, 1);
      }
      return finalizeTomlText(lines);
    }

    return finalizeTomlText(lines);
  }

  const normalizedUrl = trimmed.replace(/\s+/g, "");
  const replacementLine = `base_url = "${normalizedUrl}"`;

  if (targetSectionName) {
    let targetSectionRange = getTomlSectionRange(lines, targetSectionName);
    const targetMatch = targetSectionRange
      ? findTomlAssignmentInRange(
          lines,
          TOML_BASE_URL_PATTERN,
          targetSectionRange.bodyStartIndex,
          targetSectionRange.bodyEndIndex,
          targetSectionName,
        )
      : undefined;

    if (targetMatch) {
      lines[targetMatch.index] = replacementLine;
      return finalizeTomlText(lines);
    }

    if (recoverableAssignments.length === 1) {
      const match = recoverableAssignments[0];
      if (match) {
        lines.splice(match.index, 1);
      }
      targetSectionRange = getTomlSectionRange(lines, targetSectionName);
    }

    if (targetSectionRange) {
      const insertIndex = getTomlSectionInsertIndex(lines, targetSectionRange);
      lines.splice(insertIndex, 0, replacementLine);
      return finalizeTomlText(lines);
    }

    if (lines.length > 0 && lines[lines.length - 1]?.trim() !== "") {
      lines.push("");
    }
    lines.push(`[${targetSectionName}]`, replacementLine);
    return finalizeTomlText(lines);
  }

  const topLevelEndIndex = getTopLevelEndIndex(lines);
  const topLevelMatch = findTomlAssignmentInRange(
    lines,
    TOML_BASE_URL_PATTERN,
    0,
    topLevelEndIndex,
  );
  if (topLevelMatch) {
    lines[topLevelMatch.index] = replacementLine;
    return finalizeTomlText(lines);
  }

  const modelProviderIndex = getTopLevelModelProviderLineIndex(lines);
  if (modelProviderIndex !== -1) {
    lines.splice(modelProviderIndex + 1, 0, replacementLine);
    return finalizeTomlText(lines);
  }

  if (lines.length === 0) {
    return `${replacementLine}\n`;
  }

  const insertIndex = topLevelEndIndex;
  lines.splice(insertIndex, 0, replacementLine);
  return finalizeTomlText(lines);
};

export const extractCodexModelName = (
  configText: string | undefined | null,
): string | undefined => {
  try {
    const raw = typeof configText === "string" ? configText : "";
    const text = normalizeTomlText(raw);
    if (!text) {
      return undefined;
    }
    const lines = text.split("\n");
    const topLevelMatch = findTomlAssignmentInRange(
      lines,
      TOML_MODEL_PATTERN,
      0,
      getTopLevelEndIndex(lines),
    );
    return topLevelMatch?.value;
  } catch {
    return undefined;
  }
};

export const setCodexModelName = (
  configText: string,
  modelName: string,
): string => {
  const trimmed = modelName.trim();
  const normalizedText = normalizeTomlText(configText);
  const lines = normalizedText ? normalizedText.split("\n") : [];
  const topLevelEndIndex = getTopLevelEndIndex(lines);
  const topLevelMatch = findTomlAssignmentInRange(
    lines,
    TOML_MODEL_PATTERN,
    0,
    topLevelEndIndex,
  );

  if (!trimmed) {
    if (!normalizedText) {
      return normalizedText;
    }
    if (topLevelMatch) {
      lines.splice(topLevelMatch.index, 1);
    }
    return finalizeTomlText(lines);
  }

  const replacementLine = `model = "${trimmed}"`;
  if (topLevelMatch) {
    lines[topLevelMatch.index] = replacementLine;
    return finalizeTomlText(lines);
  }

  const modelProviderIndex = getTopLevelModelProviderLineIndex(lines);
  if (modelProviderIndex !== -1) {
    lines.splice(modelProviderIndex + 1, 0, replacementLine);
    return finalizeTomlText(lines);
  }

  if (lines.length === 0) {
    return `${replacementLine}\n`;
  }

  lines.splice(topLevelEndIndex, 0, replacementLine);
  return finalizeTomlText(lines);
};
