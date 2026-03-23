const isMac = process.platform === "darwin";

export const EXPAND_TOOLS_KEY = "ctrl+o";

export function formatKeyForDisplay(key: string): string {
  if (!isMac) {
    return key;
  }
  const segments = key
    .split("+")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const lower = segment.toLowerCase();
      switch (lower) {
        case "ctrl":
        case "control":
          return "⌃";
        case "alt":
        case "option":
          return "⌥";
        case "shift":
          return "⇧";
        case "cmd":
        case "command":
        case "meta":
          return "⌘";
        case "enter":
        case "return":
          return "↵";
        case "esc":
        case "escape":
          return "⎋";
        case "tab":
          return "⇥";
        case "up":
          return "↑";
        case "down":
          return "↓";
        case "left":
          return "←";
        case "right":
          return "→";
        case "space":
          return "␠";
        default:
          return lower;
      }
    });
  if (segments.length === 0) {
    return key;
  }
  const symbols = new Set([
    "⌃",
    "⌥",
    "⇧",
    "⌘",
    "↵",
    "⎋",
    "⇥",
    "↑",
    "↓",
    "←",
    "→",
    "␠",
  ]);
  const onlySymbols = segments.every((segment) => symbols.has(segment));
  if (onlySymbols) {
    return segments.join("");
  }
  const modifiers = segments.filter((segment) =>
    ["⌃", "⌥", "⇧", "⌘"].includes(segment),
  );
  const keys = segments.filter((segment) => !modifiers.includes(segment));
  if (keys.length === 0) {
    return modifiers.join("");
  }
  return `${modifiers.join("")}${keys.join("+")}`;
}

export function formatKeyHint(key: string, description: string): string {
  return `${formatKeyForDisplay(key)} ${description}`;
}

export function expandToolsHint(action: "expand" | "collapse"): string {
  return formatKeyHint(EXPAND_TOOLS_KEY, `to ${action}`);
}
