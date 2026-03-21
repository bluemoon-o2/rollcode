const CLEAR_SCREEN_ANSI = "\u001b[3J\u001b[2J\u001b[H";
const FALLBACK_CLEAR_ROWS = 60;

function hasAnsiScreenControl(
  stream: NodeJS.WriteStream | null | undefined,
): boolean {
  if (!stream?.isTTY) {
    return false;
  }
  const term = process.env.TERM?.toLowerCase() ?? "";
  if (!term || term === "dumb") {
    return false;
  }
  return true;
}

export function safeHorizontalLineWidth(columns: number): number {
  const normalized = Number.isFinite(columns) ? Math.floor(columns) : 0;
  if (normalized <= 1) {
    return 1;
  }
  // Leave the last terminal column unused to avoid soft-wrap artifacts.
  return normalized - 1;
}

export function buildHorizontalLine(columns: number, char = "─"): string {
  return char.repeat(Math.max(1, safeHorizontalLineWidth(columns)));
}

export function clearTerminalScreen(
  stream: NodeJS.WriteStream | null | undefined = process.stdout as
    | NodeJS.WriteStream
    | undefined,
): void {
  if (!stream) {
    return;
  }
  const rows =
    typeof stream.rows === "number" && stream.rows > 0
      ? stream.rows
      : FALLBACK_CLEAR_ROWS;
  const supportsAnsi = hasAnsiScreenControl(stream);

  stream.write(CLEAR_SCREEN_ANSI);
  if (!supportsAnsi) {
    // Fallback for environments that ignore erase-screen control sequences:
    // push old content out of the viewport, then home the cursor.
    stream.write("\n".repeat(rows));
    stream.write("\u001b[H");
  }
}
