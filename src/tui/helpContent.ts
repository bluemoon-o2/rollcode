import { releaseNotes } from "../release-notes";
import {
  EXPAND_TOOLS_KEY,
  formatKeyForDisplay,
} from "./components/keybindingHints";
import { getLauncherSlashCommands, getSlashCommands } from "./slashCommands";

interface HotkeyRow {
  key: string;
  action: string;
}

function buildHotkeySection(title: string, rows: HotkeyRow[]): string[] {
  return [
    `## ${title}`,
    "",
    ...rows.map((row) => `- \`${row.key}\`: ${row.action}`),
    "",
  ];
}

function parseVersion(version: string): [number, number, number] {
  const [major, minor, patch] = version.split(".");
  return [
    Number.parseInt(major ?? "0", 10) || 0,
    Number.parseInt(minor ?? "0", 10) || 0,
    Number.parseInt(patch ?? "0", 10) || 0,
  ];
}

function compareVersionDesc(left: string, right: string): number {
  const [lMajor, lMinor, lPatch] = parseVersion(left);
  const [rMajor, rMinor, rPatch] = parseVersion(right);
  if (lMajor !== rMajor) {
    return rMajor - lMajor;
  }
  if (lMinor !== rMinor) {
    return rMinor - lMinor;
  }
  return rPatch - lPatch;
}

function stripTitleLine(content: string, version: string): string {
  const lines = content.replace(/\r/g, "").trim().split("\n");
  if (lines.length === 0) {
    return "";
  }
  const first = (lines[0] ?? "").trim().toLowerCase();
  const expected = `rollcode ${version}`.toLowerCase();
  if (first === expected) {
    return lines.slice(1).join("\n").trim();
  }
  return lines.join("\n").trim();
}

export function buildChangelogMarkdown(): string {
  const entries = Object.entries(releaseNotes).sort(([left], [right]) =>
    compareVersionDesc(left, right),
  );
  if (entries.length === 0) {
    return "No changelog entries found.";
  }

  return entries
    .map(([version, content]) => {
      const cleaned = stripTitleLine(content, version);
      if (!cleaned) {
        return `## ${version}\n- No details provided.`;
      }
      return `## ${version}\n${cleaned}`;
    })
    .join("\n\n");
}

export function buildLauncherHotkeysMarkdown(): string {
  const slashCommands = getLauncherSlashCommands();
  const submitKey = "Enter";
  const autocompleteKey = "Tab";
  const exitKey = "Esc";
  const lines: string[] = [
    ...buildHotkeySection("Navigation", [
      { key: autocompleteKey, action: "Accept slash autocomplete" },
      { key: "↑ / ↓", action: "Move in slash command list" },
    ]),
    ...buildHotkeySection("Input", [
      { key: submitKey, action: "Run command / submit goal" },
      { key: exitKey, action: "Exit launcher" },
    ]),
    "## Launcher Commands",
    ...slashCommands.map(
      (item) => `- \`${item.command}\`: ${item.description}`,
    ),
  ];
  return lines.join("\n");
}

export function buildSessionHotkeysMarkdown(viewerOnly: boolean): string {
  const slashCommands = getSlashCommands(viewerOnly);
  const submitKey = "Enter";
  const interruptKey = "Esc";
  const newLineKey =
    process.platform === "win32" ? "Ctrl+Enter" : "Shift+Enter";
  const lines: string[] = [
    ...buildHotkeySection("Navigation", [
      { key: "Arrow keys", action: "Move cursor / browse slash command list" },
      { key: "Tab", action: "Accept slash autocomplete" },
    ]),
    ...buildHotkeySection("Editing", [
      { key: submitKey, action: "Send message" },
      { key: newLineKey, action: "New line" },
      { key: interruptKey, action: "Interrupt active turn" },
    ]),
    ...buildHotkeySection("Other", [
      {
        key: formatKeyForDisplay(EXPAND_TOOLS_KEY),
        action: "Toggle tool output expansion",
      },
      { key: "/", action: "Slash commands" },
      { key: "/hotkeys", action: "Show keyboard shortcuts" },
      { key: "/changelog", action: "Show changelog entries" },
      { key: "Ctrl+C", action: "Force exit" },
    ]),
    "## Session Commands",
    ...slashCommands.map(
      (item) => `- \`${item.command}\`: ${item.description}`,
    ),
  ];
  return lines.join("\n");
}
