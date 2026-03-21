export interface ParsedCommandOutputEntry {
  id: string;
  command: string;
  output: string;
  phase: "running" | "finished";
  success?: boolean;
  exitCode?: number | null;
}

const EXIT_LINE_PATTERN = /^\(exit (-?\d+|\?)\)$/;

function finalizeEntry(
  entries: ParsedCommandOutputEntry[],
  command: string,
  outputLines: string[],
  exitCode: number | null | undefined,
): void {
  const output = outputLines.join("\n").replace(/\n+$/, "");
  const phase = exitCode === undefined ? "running" : "finished";
  entries.push({
    id: `cmd-${entries.length + 1}`,
    command,
    output,
    phase,
    success: phase === "running" ? undefined : exitCode === 0,
    exitCode: phase === "running" ? undefined : exitCode,
  });
}

export function parseCommandOutput(
  rawOutput: string,
): ParsedCommandOutputEntry[] {
  const normalized = rawOutput.replace(/\r/g, "");
  const trimmed = normalized.trim();
  if (!trimmed) {
    return [];
  }

  const entries: ParsedCommandOutputEntry[] = [];
  const lines = normalized.split("\n");
  let currentCommand: string | null = null;
  let currentOutput: string[] = [];

  for (const line of lines) {
    if (line.startsWith("$ ")) {
      if (currentCommand !== null) {
        finalizeEntry(entries, currentCommand, currentOutput, undefined);
      }
      currentCommand = line.slice(2).trim();
      currentOutput = [];
      continue;
    }

    const exitMatch = EXIT_LINE_PATTERN.exec(line.trim());
    if (exitMatch && currentCommand !== null) {
      const rawCode = exitMatch[1];
      const exitCode =
        rawCode === "?" ? null : Number.parseInt(rawCode, 10);
      finalizeEntry(entries, currentCommand, currentOutput, exitCode);
      currentCommand = null;
      currentOutput = [];
      continue;
    }

    if (currentCommand !== null) {
      currentOutput.push(line);
    }
  }

  if (currentCommand !== null) {
    finalizeEntry(entries, currentCommand, currentOutput, undefined);
  }

  if (entries.length > 0) {
    return entries;
  }

  return [
    {
      id: "cmd-1",
      command: "command output",
      output: trimmed,
      phase: "finished",
    },
  ];
}

export function summarizeCommandEntries(
  entries: ParsedCommandOutputEntry[],
): string {
  if (entries.length === 0) {
    return "no tools";
  }
  const running = entries.filter((entry) => entry.phase === "running").length;
  const failed = entries.filter(
    (entry) => entry.phase === "finished" && entry.success === false,
  ).length;
  const suffixParts: string[] = [];
  if (running > 0) {
    suffixParts.push(`${running} running`);
  }
  if (failed > 0) {
    suffixParts.push(`${failed} failed`);
  }
  if (suffixParts.length > 0) {
    return `${entries.length} commands (${suffixParts.join(", ")})`;
  }
  return `${entries.length} commands`;
}
