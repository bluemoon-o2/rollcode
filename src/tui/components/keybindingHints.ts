const isMac = process.platform === "darwin";

export const EXPAND_TOOLS_KEY = "ctrl+o";

export function formatKeyForDisplay(key: string): string {
  if (!isMac) {
    return key;
  }
  return key.replace(/\balt\+/gi, "⌥");
}

function keyHint(key: string, description: string): string {
  return `${formatKeyForDisplay(key)} ${description}`;
}

export function expandToolsHint(action: "expand" | "collapse"): string {
  return keyHint(EXPAND_TOOLS_KEY, `to ${action}`);
}
