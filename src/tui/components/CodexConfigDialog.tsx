import { Box, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import {
  applyCodexPreset,
  type CodexConfigSnapshot,
  detectCodexPresetId,
  getCodexConfigDir,
  readCodexConfigSnapshot,
  resolveCodexPresetDraft,
} from "../../codex/configuration";
import {
  type CodexProviderPreset,
  codexProviderPresets,
} from "../../codex/presets";
import { buildHorizontalLine } from "../terminal";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { PatchedTextInput } from "./PatchedTextInput";
import { Text } from "./Text";

const MAX_VISIBLE_PRESETS = 9;

type DialogStep =
  | "list"
  | "apiKey"
  | "baseUrl"
  | "model"
  | "confirm"
  | "saving";

export interface CodexConfigDialogResult {
  message: string;
  error?: boolean;
}

function truncateEnd(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (text.length <= maxWidth) {
    return text;
  }
  if (maxWidth <= 3) {
    return text.slice(0, maxWidth);
  }
  return `${text.slice(0, maxWidth - 3)}...`;
}

function maskApiKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "(empty)";
  }
  if (trimmed.length <= 6) {
    return `${trimmed.slice(0, 1)}***${trimmed.slice(-1)}`;
  }
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-3)}`;
}

function formatPresetMeta(preset: CodexProviderPreset): string {
  if (preset.isOfficial) {
    return "official";
  }
  return preset.category ?? "third_party";
}

export function CodexConfigDialog(props: {
  onClose: (result?: CodexConfigDialogResult) => void;
}) {
  const terminalWidth = useTerminalWidth();
  const configDir = useMemo(() => getCodexConfigDir(), []);
  const [snapshot, setSnapshot] = useState<CodexConfigSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedPreset, setSelectedPreset] =
    useState<CodexProviderPreset | null>(null);
  const [step, setStep] = useState<DialogStep>("list");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelName, setModelName] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const current = await readCodexConfigSnapshot(configDir);
        if (!mounted) {
          return;
        }
        const detectedId = detectCodexPresetId(current);
        const presetIndex = codexProviderPresets.findIndex(
          (preset) => preset.id === detectedId,
        );
        if (presetIndex >= 0) {
          setSelectedIndex(presetIndex);
        }
        setSnapshot(current);
      } catch (error) {
        if (!mounted) {
          return;
        }
        setErrorMessage(
          error instanceof Error
            ? `Failed to read Codex config: ${error.message}`
            : "Failed to read Codex config",
        );
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [configDir]);

  const visibleWindow = useMemo(() => {
    const total = codexProviderPresets.length;
    const boundedIndex = Math.min(selectedIndex, Math.max(0, total - 1));
    const needsScroll = total > MAX_VISIBLE_PRESETS;
    const start = needsScroll
      ? Math.max(
          0,
          Math.min(
            boundedIndex - Math.floor(MAX_VISIBLE_PRESETS / 2),
            total - MAX_VISIBLE_PRESETS,
          ),
        )
      : 0;
    return {
      total,
      start,
      boundedIndex,
      presets: codexProviderPresets.slice(start, start + MAX_VISIBLE_PRESETS),
      showMore: start + MAX_VISIBLE_PRESETS < total,
    };
  }, [selectedIndex]);

  const activeFieldLabel =
    step === "apiKey"
      ? "API Key"
      : step === "baseUrl"
        ? "Base URL"
        : step === "model"
          ? "Model Name"
          : "";

  const activeFieldValue =
    step === "apiKey" ? apiKey : step === "baseUrl" ? baseUrl : modelName;

  const activeFieldPlaceholder =
    step === "apiKey"
      ? "sk-..."
      : step === "baseUrl"
        ? "https://api.example.com/v1"
        : "gpt-5.4";

  const updateActiveFieldValue = (value: string) => {
    if (step === "apiKey") {
      setApiKey(value);
      return;
    }
    if (step === "baseUrl") {
      setBaseUrl(value);
      return;
    }
    if (step === "model") {
      setModelName(value);
    }
  };

  const openPreset = () => {
    const preset = codexProviderPresets[selectedIndex];
    if (!preset) {
      return;
    }
    const draft = resolveCodexPresetDraft(preset, snapshot);
    setSelectedPreset(preset);
    setApiKey(draft.apiKey);
    setBaseUrl(draft.baseUrl);
    setModelName(draft.modelName);
    setErrorMessage(null);
    setStep(preset.isOfficial ? "confirm" : "apiKey");
  };

  const returnFromInput = () => {
    if (step === "apiKey") {
      setStep("list");
      setSelectedPreset(null);
      return;
    }
    if (step === "baseUrl") {
      setStep("apiKey");
      return;
    }
    if (step === "model") {
      setStep("baseUrl");
      return;
    }
    if (step === "confirm") {
      if (selectedPreset?.isOfficial) {
        setStep("list");
        setSelectedPreset(null);
      } else {
        setStep("model");
      }
      return;
    }
    if (step === "list") {
      props.onClose();
    }
  };

  const savePreset = async () => {
    if (!selectedPreset) {
      return;
    }
    setErrorMessage(null);
    setStep("saving");
    try {
      const result = await applyCodexPreset({
        presetId: selectedPreset.id,
        apiKey,
        baseUrl,
        modelName,
        configDir,
      });
      props.onClose({
        message: `Codex preset saved: ${result.providerName} (${result.configDir})`,
      });
    } catch (error) {
      setStep("confirm");
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to save Codex config",
      );
    }
  };

  const submitField = () => {
    if (step === "apiKey") {
      setStep("baseUrl");
      return;
    }
    if (step === "baseUrl") {
      setStep("model");
      return;
    }
    if (step === "model") {
      setStep("confirm");
    }
  };

  useInput((input, key) => {
    const isEscape = key.escape || input === "\u001b";
    if (key.ctrl && input === "c") {
      props.onClose();
      return;
    }
    if (loading) {
      if (isEscape) {
        props.onClose();
      }
      return;
    }
    if (step === "saving") {
      return;
    }

    if (isEscape) {
      returnFromInput();
      return;
    }

    if (step === "list") {
      if (key.upArrow) {
        setSelectedIndex((current) =>
          current > 0 ? current - 1 : codexProviderPresets.length - 1,
        );
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((current) =>
          current < codexProviderPresets.length - 1 ? current + 1 : 0,
        );
        return;
      }
      if (key.return) {
        openPreset();
      }
      return;
    }

    if (step === "confirm" && key.return) {
      void savePreset();
    }
  });

  const horizontalLine = buildHorizontalLine(Math.max(terminalWidth, 16), "─");
  const bodyWidth = Math.max(24, terminalWidth - 6);

  if (loading) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /codex"}</Text>
        <Text color={colors.codex.line} dimColor>
          {horizontalLine}
        </Text>
        <Box marginTop={1}>
          <Text color={colors.codex.muted}>Loading Codex config...</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>{"> /codex"}</Text>
      <Text color={colors.codex.line} dimColor>
        {horizontalLine}
      </Text>
      <Box marginTop={1}>
        <Text bold color={colors.codex.title}>
          Configure Codex Provider
        </Text>
      </Box>
      <Text color={colors.codex.subtitle}>
        config dir: {truncateEnd(configDir, bodyWidth)}
      </Text>
      <Text color={colors.codex.muted}>
        current: {snapshot?.baseUrl || "official/oAuth"} · model{" "}
        {snapshot?.modelName || "(default)"}
      </Text>
      <Text color={colors.codex.muted}>
        auth: OPENAI_API_KEY {snapshot?.apiKey ? "present" : "missing"}
      </Text>

      {errorMessage ? (
        <Box marginTop={1}>
          <Text color={colors.codex.error}>{errorMessage}</Text>
        </Box>
      ) : null}

      {step === "list" ? (
        <Box flexDirection="column" marginTop={1}>
          {visibleWindow.presets.map((preset, index) => {
            const actualIndex = visibleWindow.start + index;
            const selected = actualIndex === visibleWindow.boundedIndex;
            const current =
              snapshot && detectCodexPresetId(snapshot) === preset.id;
            const line = truncateEnd(
              `${preset.name} · ${formatPresetMeta(preset)}`,
              bodyWidth,
            );
            return (
              <Text
                key={preset.id}
                color={
                  selected
                    ? colors.codex.selected
                    : current
                      ? colors.codex.current
                      : colors.codex.text
                }
                bold={selected}
              >
                {selected ? "> " : "  "}
                {line}
                {current ? " (current)" : ""}
              </Text>
            );
          })}
          {visibleWindow.showMore ? (
            <Text color={colors.codex.muted}>
              {"  "}↓{" "}
              {visibleWindow.total - visibleWindow.start - MAX_VISIBLE_PRESETS}{" "}
              more
            </Text>
          ) : null}
        </Box>
      ) : null}

      {(step === "apiKey" || step === "baseUrl" || step === "model") &&
      selectedPreset ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={colors.codex.subtitle}>
            preset: {selectedPreset.name}
          </Text>
          <Text color={colors.codex.text}>Field: {activeFieldLabel}</Text>
          <Box marginTop={1} flexDirection="row">
            <Text color={colors.input.prompt}>{"> "}</Text>
            <Box flexGrow={1}>
              <PatchedTextInput
                value={activeFieldValue}
                onChange={updateActiveFieldValue}
                onSubmit={submitField}
                placeholder={activeFieldPlaceholder}
              />
            </Box>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={colors.codex.muted}>apiKey: {maskApiKey(apiKey)}</Text>
            <Text color={colors.codex.muted}>
              baseUrl: {truncateEnd(baseUrl || "(empty)", bodyWidth)}
            </Text>
            <Text color={colors.codex.muted}>
              model: {modelName || "(default)"}
            </Text>
          </Box>
        </Box>
      ) : null}

      {step === "confirm" && selectedPreset ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={colors.codex.subtitle}>
            preset: {selectedPreset.name}
          </Text>
          {selectedPreset.isOfficial ? (
            <Text color={colors.codex.text}>
              Apply official mode and keep existing auth.json.
            </Text>
          ) : (
            <>
              <Text color={colors.codex.text}>
                apiKey: {maskApiKey(apiKey)}
              </Text>
              <Text color={colors.codex.text}>
                baseUrl: {truncateEnd(baseUrl || "(empty)", bodyWidth)}
              </Text>
              <Text color={colors.codex.text}>
                model: {modelName || "(default)"}
              </Text>
            </>
          )}
        </Box>
      ) : null}

      {step === "saving" ? (
        <Box marginTop={1}>
          <Text color={colors.codex.subtitle}>Saving Codex config...</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={colors.codex.hint} dimColor>
          {step === "list"
            ? "Enter select · ↑↓ navigate · Esc close"
            : step === "confirm"
              ? "Enter apply · Esc back"
              : "Enter next · Esc back"}
        </Text>
      </Box>
    </Box>
  );
}
