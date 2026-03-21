import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCodexPreset,
  findCodexPresetById,
  readCodexConfigSnapshot,
  resolveCodexPresetDraft,
} from "../src/codex/configuration";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
  setCodexBaseUrl,
  setCodexModelName,
} from "../src/codex/toml";

describe("codex config helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("updates base_url/model in codex TOML text", () => {
    const input = [
      'model_provider = "custom"',
      'model = "gpt-5.4"',
      "",
      "[model_providers.custom]",
      'name = "custom"',
      'wire_api = "responses"',
      "",
    ].join("\n");

    const withBaseUrl = setCodexBaseUrl(input, "https://api.example.com/v1");
    const withModel = setCodexModelName(withBaseUrl, "gpt-5.3-codex");

    expect(extractCodexBaseUrl(withModel)).toBe("https://api.example.com/v1");
    expect(extractCodexModelName(withModel)).toBe("gpt-5.3-codex");
  });

  test("applies custom preset into auth.json + config.toml", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "rollcode-codex-config-"));
    tempDirs.push(configDir);

    const saved = await applyCodexPreset({
      presetId: "custom",
      apiKey: "sk-test-123",
      baseUrl: "https://api.example.com/v1",
      modelName: "gpt-5.4",
      configDir,
    });

    const authContent = await readFile(saved.authPath, "utf8");
    const configContent = await readFile(saved.configPath, "utf8");
    const authJson = JSON.parse(authContent) as Record<string, unknown>;

    expect(authJson.OPENAI_API_KEY).toBe("sk-test-123");
    expect(configContent).toContain('base_url = "https://api.example.com/v1"');
    expect(configContent).toContain('model = "gpt-5.4"');
  });

  test("official preset preserves existing auth by default", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "rollcode-codex-official-"));
    tempDirs.push(configDir);

    await applyCodexPreset({
      presetId: "custom",
      apiKey: "sk-existing",
      baseUrl: "https://api.example.com/v1",
      modelName: "gpt-5.4",
      configDir,
    });

    await applyCodexPreset({
      presetId: "openai-official",
      configDir,
    });

    const snapshot = await readCodexConfigSnapshot(configDir);
    expect(snapshot.apiKey).toBe("sk-existing");
    expect(snapshot.configToml).toBe("");
  });

  test("custom preset draft prefers current codex snapshot values", () => {
    const customPreset = findCodexPresetById("custom");
    if (!customPreset) {
      throw new Error("expected custom preset");
    }

    const draft = resolveCodexPresetDraft(customPreset, {
      apiKey: "sk-current",
      baseUrl: "https://mirror.example/v1",
      modelName: "gpt-5.2-codex",
    });

    expect(draft.apiKey).toBe("sk-current");
    expect(draft.baseUrl).toBe("https://mirror.example/v1");
    expect(draft.modelName).toBe("gpt-5.2-codex");
  });

  test("custom preset draft keeps empty snapshot fields without preset fallback", () => {
    const customPreset = findCodexPresetById("custom");
    if (!customPreset) {
      throw new Error("expected custom preset");
    }

    const draft = resolveCodexPresetDraft(customPreset, {
      apiKey: "",
      baseUrl: "",
      modelName: "",
    });

    expect(draft.apiKey).toBe("");
    expect(draft.baseUrl).toBe("");
    expect(draft.modelName).toBe("");
  });
});
