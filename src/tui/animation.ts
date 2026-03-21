function readBooleanEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

// Keep animations on by default. Runtime overflow heuristics in App/Launcher
// can temporarily pause them to avoid repaint flicker.
export const TUI_ANIMATIONS_ENABLED = readBooleanEnv(
  "ROLLCODE_TUI_ANIMATIONS",
  true,
);
