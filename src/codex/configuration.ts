import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CodexProviderPreset,
  codexProviderPresets,
  generateThirdPartyConfig,
} from "./presets";
import { normalizeTomlText } from "./textNormalization";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
  setCodexBaseUrl,
  setCodexModelName,
} from "./toml";

const DEFAULT_CODEX_MODEL = "gpt-5.4";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export interface CodexConfigSnapshot {
  configDir: string;
  authPath: string;
  configPath: string;
  auth: Record<string, unknown>;
  configToml: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
}

export interface CodexPresetDraft {
  apiKey: string;
  baseUrl: string;
  modelName: string;
}

export interface ApplyCodexPresetInput {
  presetId: string;
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  configDir?: string;
  preserveOfficialAuth?: boolean;
}

export function getCodexConfigDir(): string {
  const override =
    process.env.ROLLCODE_CODEX_CONFIG_DIR?.trim() ||
    process.env.CODEX_HOME?.trim();
  if (override) {
    return override;
  }
  return join(homedir(), ".codex");
}

export function getCodexAuthPath(configDir = getCodexConfigDir()): string {
  return join(configDir, "auth.json");
}

export function getCodexConfigTomlPath(
  configDir = getCodexConfigDir(),
): string {
  return join(configDir, "config.toml");
}

export async function readCodexAuth(
  configDir = getCodexConfigDir(),
): Promise<Record<string, unknown>> {
  const path = getCodexAuthPath(configDir);
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {};
    }
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function readCodexConfigToml(
  configDir = getCodexConfigDir(),
): Promise<string> {
  const path = getCodexConfigTomlPath(configDir);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export async function readCodexConfigSnapshot(
  configDir = getCodexConfigDir(),
): Promise<CodexConfigSnapshot> {
  const [auth, configToml] = await Promise.all([
    readCodexAuth(configDir),
    readCodexConfigToml(configDir),
  ]);
  const apiKey =
    typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : "";
  return {
    configDir,
    authPath: getCodexAuthPath(configDir),
    configPath: getCodexConfigTomlPath(configDir),
    auth,
    configToml,
    apiKey,
    baseUrl: extractCodexBaseUrl(configToml) ?? "",
    modelName: extractCodexModelName(configToml) ?? "",
  };
}

async function ensureCodexConfigDir(configDir: string): Promise<void> {
  await mkdir(configDir, { recursive: true });
}

export async function writeCodexAuth(
  auth: Record<string, unknown>,
  configDir = getCodexConfigDir(),
): Promise<void> {
  await ensureCodexConfigDir(configDir);
  const payload = `${JSON.stringify(auth, null, 2)}\n`;
  await writeFile(getCodexAuthPath(configDir), payload, "utf8");
}

export async function writeCodexConfigToml(
  configToml: string,
  configDir = getCodexConfigDir(),
): Promise<void> {
  await ensureCodexConfigDir(configDir);
  const normalized = normalizeTomlText(configToml ?? "");
  const payload = normalized ? `${normalized.trimEnd()}\n` : "";
  await writeFile(getCodexConfigTomlPath(configDir), payload, "utf8");
}

export function findCodexPresetById(
  presetId: string,
): CodexProviderPreset | null {
  return codexProviderPresets.find((preset) => preset.id === presetId) ?? null;
}

export function detectCodexPresetId(snapshot: { baseUrl?: string }): string {
  const normalizedBaseUrl = snapshot.baseUrl?.trim().toLowerCase();
  if (!normalizedBaseUrl) {
    return "openai-official";
  }

  for (const preset of codexProviderPresets) {
    const endpoints = preset.endpointCandidates ?? [];
    if (
      endpoints.some(
        (url) => url.trim().toLowerCase() === normalizedBaseUrl.toLowerCase(),
      )
    ) {
      return preset.id;
    }
  }
  return "custom";
}

export function resolveCodexPresetDraft(
  preset: CodexProviderPreset,
  snapshot?: Pick<
    CodexConfigSnapshot,
    "apiKey" | "baseUrl" | "modelName"
  > | null,
): CodexPresetDraft {
  if (preset.isOfficial) {
    return {
      apiKey: snapshot?.apiKey ?? "",
      baseUrl: "",
      modelName: snapshot?.modelName ?? "",
    };
  }

  const presetApiKey =
    typeof preset.auth.OPENAI_API_KEY === "string"
      ? preset.auth.OPENAI_API_KEY
      : "";
  const presetBaseUrl =
    extractCodexBaseUrl(preset.config) ?? preset.endpointCandidates?.[0] ?? "";
  const presetModelName =
    extractCodexModelName(preset.config) ?? DEFAULT_CODEX_MODEL;

  if (preset.id === "custom") {
    const hasSnapshot = snapshot !== null && snapshot !== undefined;
    return {
      apiKey: hasSnapshot ? (snapshot.apiKey ?? "") : (presetApiKey || ""),
      baseUrl: hasSnapshot ? (snapshot.baseUrl ?? "") : (presetBaseUrl || ""),
      modelName: hasSnapshot
        ? (snapshot.modelName ?? "")
        : (presetModelName || DEFAULT_CODEX_MODEL),
    };
  }

  return {
    apiKey: presetApiKey || snapshot?.apiKey || "",
    baseUrl: presetBaseUrl || snapshot?.baseUrl || "",
    modelName: presetModelName || snapshot?.modelName || DEFAULT_CODEX_MODEL,
  };
}

function ensureNonEmptyThirdPartyConfig(draft: CodexPresetDraft): void {
  if (!draft.apiKey.trim()) {
    throw new Error("API key is required for third-party Codex providers.");
  }
  if (!draft.baseUrl.trim()) {
    throw new Error("Base URL is required for third-party Codex providers.");
  }
}

export async function applyCodexPreset(
  input: ApplyCodexPresetInput,
): Promise<CodexConfigSnapshot & { providerName: string }> {
  const preset = findCodexPresetById(input.presetId);
  if (!preset) {
    throw new Error(`Unknown Codex preset: ${input.presetId}`);
  }

  const configDir = input.configDir ?? getCodexConfigDir();
  const existing = await readCodexConfigSnapshot(configDir);
  const draft = resolveCodexPresetDraft(preset, existing);

  const nextDraft: CodexPresetDraft = {
    apiKey: input.apiKey ?? draft.apiKey,
    baseUrl: input.baseUrl ?? draft.baseUrl,
    modelName: input.modelName ?? draft.modelName,
  };

  let nextAuth = cloneRecord(preset.auth);
  let nextConfigToml = preset.config;

  if (preset.isOfficial) {
    if (input.preserveOfficialAuth !== false) {
      nextAuth = existing.auth;
    }
    nextConfigToml = preset.config;
  } else {
    ensureNonEmptyThirdPartyConfig(nextDraft);
    nextAuth.OPENAI_API_KEY = nextDraft.apiKey.trim();
    nextConfigToml =
      preset.config.trim() ||
      generateThirdPartyConfig(
        "custom",
        nextDraft.baseUrl,
        nextDraft.modelName,
      );
    nextConfigToml = setCodexBaseUrl(nextConfigToml, nextDraft.baseUrl);
    nextConfigToml = setCodexModelName(
      nextConfigToml,
      nextDraft.modelName || DEFAULT_CODEX_MODEL,
    );
  }

  await writeCodexAuth(nextAuth, configDir);
  await writeCodexConfigToml(nextConfigToml, configDir);

  const snapshot = await readCodexConfigSnapshot(configDir);
  return {
    ...snapshot,
    providerName: preset.name,
  };
}
