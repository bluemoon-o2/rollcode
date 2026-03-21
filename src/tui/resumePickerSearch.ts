import type { ResumePickerOption } from "./ResumePicker";
import { fuzzyMatch } from "./fuzzy";

export type ResumePickerSortMode = "recent" | "relevance";

interface ParsedSearchQuery {
  mode: "tokens" | "regex";
  tokens: { kind: "fuzzy" | "phrase"; value: string }[];
  regex: RegExp | null;
  error?: string;
}

interface MatchResult {
  matches: boolean;
  score: number;
}

function normalizeWhitespaceLower(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseSearchQuery(query: string): ParsedSearchQuery {
  const trimmed = query.trim();
  if (!trimmed) {
    return { mode: "tokens", tokens: [], regex: null };
  }

  if (trimmed.startsWith("re:")) {
    const pattern = trimmed.slice(3).trim();
    if (!pattern) {
      return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
    }
    try {
      return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { mode: "regex", tokens: [], regex: null, error: message };
    }
  }

  const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
  let buffer = "";
  let inQuote = false;
  let hadUnclosedQuote = false;

  const flush = (kind: "fuzzy" | "phrase") => {
    const value = buffer.trim();
    buffer = "";
    if (!value) {
      return;
    }
    tokens.push({ kind, value });
  };

  for (let index = 0; index < trimmed.length; index += 1) {
    const ch = trimmed[index];
    if (ch === "\"") {
      if (inQuote) {
        flush("phrase");
        inQuote = false;
      } else {
        flush("fuzzy");
        inQuote = true;
      }
      continue;
    }

    if (!inQuote && /\s/.test(ch ?? "")) {
      flush("fuzzy");
      continue;
    }

    buffer += ch ?? "";
  }

  if (inQuote) {
    hadUnclosedQuote = true;
  }

  if (hadUnclosedQuote) {
    return {
      mode: "tokens",
      tokens: trimmed
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((value) => ({ kind: "fuzzy" as const, value })),
      regex: null,
    };
  }

  flush(inQuote ? "phrase" : "fuzzy");
  return { mode: "tokens", tokens, regex: null };
}

function getSearchText(option: ResumePickerOption): string {
  const run = option.run;
  return [
    run.id,
    run.goal,
    option.agentName,
    run.status,
    run.updatedAt,
    run.createdAt,
  ]
    .join(" ")
    .toLowerCase();
}

function matchOption(
  option: ResumePickerOption,
  parsed: ParsedSearchQuery,
): MatchResult {
  const text = getSearchText(option);
  if (parsed.mode === "regex") {
    if (!parsed.regex) {
      return { matches: false, score: 0 };
    }
    const index = text.search(parsed.regex);
    if (index < 0) {
      return { matches: false, score: 0 };
    }
    return { matches: true, score: index * 0.1 };
  }

  if (parsed.tokens.length === 0) {
    return { matches: true, score: 0 };
  }

  let totalScore = 0;
  let normalizedText: string | null = null;

  for (const token of parsed.tokens) {
    if (token.kind === "phrase") {
      if (normalizedText === null) {
        normalizedText = normalizeWhitespaceLower(text);
      }
      const phrase = normalizeWhitespaceLower(token.value);
      if (!phrase) {
        continue;
      }
      const index = normalizedText.indexOf(phrase);
      if (index < 0) {
        return { matches: false, score: 0 };
      }
      totalScore += index * 0.1;
      continue;
    }

    const fuzzy = fuzzyMatch(token.value, text);
    if (!fuzzy.matches) {
      return { matches: false, score: 0 };
    }
    totalScore += fuzzy.score;
  }

  return { matches: true, score: totalScore };
}

function sortByRecent(options: ResumePickerOption[]): ResumePickerOption[] {
  return [...options].sort((left, right) =>
    right.run.updatedAt.localeCompare(left.run.updatedAt),
  );
}

export function filterAndSortResumeOptions(
  options: ResumePickerOption[],
  query: string,
  sortMode: ResumePickerSortMode,
): ResumePickerOption[] {
  const base = sortByRecent(options);
  const trimmed = query.trim();
  if (!trimmed) {
    return base;
  }

  const parsed = parseSearchQuery(query);
  if (parsed.error) {
    return [];
  }

  if (sortMode === "recent") {
    return base.filter((option) => matchOption(option, parsed).matches);
  }

  const scored: Array<{ option: ResumePickerOption; score: number }> = [];
  for (const option of base) {
    const result = matchOption(option, parsed);
    if (!result.matches) {
      continue;
    }
    scored.push({ option, score: result.score });
  }
  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return left.score - right.score;
    }
    return right.option.run.updatedAt.localeCompare(left.option.run.updatedAt);
  });
  return scored.map((item) => item.option);
}
