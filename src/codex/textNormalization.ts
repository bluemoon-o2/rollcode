/**
 * Normalize common curly/full-width quotes into ASCII quotes to avoid TOML
 * parser and regex mismatch issues in copied snippets.
 */
export const normalizeQuotes = (text: string): string => {
  if (!text) {
    return text;
  }
  return (
    text
      // Double-quote family -> "
      .replace(/[“”„‟＂]/g, '"')
      // Single-quote family -> '
      .replace(/[‘’＇]/g, "'")
  );
};

/**
 * TOML-focused normalization hook. Kept separate for future extension.
 */
export const normalizeTomlText = (text: string): string =>
  normalizeQuotes(text);
