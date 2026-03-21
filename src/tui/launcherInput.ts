const FORMAT_NOISE_PATTERN = /[\p{Cf}]/gu;

function stripControlNoise(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // Keep TAB for slash autocomplete, but strip other C0 controls (incl. CR/LF)
    // and DEL.
    if (code === 0x09) {
      result += char;
      continue;
    }
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    result += char;
  }
  return result;
}

export function sanitizeLauncherInput(value: string): string {
  return stripControlNoise(value)
    .replace(FORMAT_NOISE_PATTERN, "")
    .replace(/\u3000/g, " ");
}

export function normalizeLauncherCommand(value: string): string {
  return sanitizeLauncherInput(value).normalize("NFKC").trim();
}

export function canonicalizeLauncherSubmission(value: string): string {
  const normalized = normalizeLauncherCommand(value);
  const token = normalized.split(/\s+/u)[0] ?? "";
  if (token === "/resume") {
    return "/resume";
  }
  return normalized;
}
