export type CodexProviderCategory =
  | "official"
  | "third_party"
  | "aggregator"
  | "custom";

export interface CodexProviderPreset {
  id: string;
  name: string;
  websiteUrl: string;
  apiKeyUrl?: string;
  auth: Record<string, unknown>;
  config: string;
  isOfficial?: boolean;
  category?: CodexProviderCategory;
  endpointCandidates?: string[];
}

export function generateThirdPartyAuth(
  apiKey: string,
): Record<string, unknown> {
  return {
    OPENAI_API_KEY: apiKey || "",
  };
}

export function generateThirdPartyConfig(
  providerName: string,
  baseUrl: string,
  modelName = "gpt-5.4",
): string {
  const cleanProviderName =
    providerName
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "") || "custom";

  return `model_provider = "${cleanProviderName}"
model = "${modelName}"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.${cleanProviderName}]
name = "${cleanProviderName}"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = true`;
}

export const codexProviderPresets: CodexProviderPreset[] = [
  {
    id: "custom",
    name: "Custom OpenAI-Compatible",
    websiteUrl: "https://platform.openai.com/docs/api-reference/responses",
    category: "custom",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "custom",
      "https://api.openai.com/v1",
      "gpt-5.4",
    ),
    endpointCandidates: ["https://api.openai.com/v1"],
  },
  {
    id: "openai-official",
    name: "OpenAI Official",
    websiteUrl: "https://chatgpt.com/codex",
    isOfficial: true,
    category: "official",
    auth: {},
    config: ``,
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    websiteUrl:
      "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/codex",
    category: "third_party",
    isOfficial: true,
    auth: generateThirdPartyAuth(""),
    config: `model_provider = "azure"
model = "gpt-5.4"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.azure]
name = "Azure OpenAI"
base_url = "https://YOUR_RESOURCE_NAME.openai.azure.com/openai"
env_key = "OPENAI_API_KEY"
query_params = { "api-version" = "2025-04-01-preview" }
wire_api = "responses"
requires_openai_auth = true`,
    endpointCandidates: ["https://YOUR_RESOURCE_NAME.openai.azure.com/openai"],
  },
  {
    id: "aihubmix",
    name: "AiHubMix",
    websiteUrl: "https://aihubmix.com",
    category: "aggregator",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "aihubmix",
      "https://aihubmix.com/v1",
      "gpt-5.4",
    ),
    endpointCandidates: [
      "https://aihubmix.com/v1",
      "https://api.aihubmix.com/v1",
    ],
  },
  {
    id: "dmxapi",
    name: "DMXAPI",
    websiteUrl: "https://www.dmxapi.cn",
    category: "aggregator",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "dmxapi",
      "https://www.dmxapi.cn/v1",
      "gpt-5.4",
    ),
    endpointCandidates: ["https://www.dmxapi.cn/v1"],
  },
  {
    id: "packycode",
    name: "PackyCode",
    websiteUrl: "https://www.packyapi.com",
    apiKeyUrl: "https://www.packyapi.com",
    category: "third_party",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "packycode",
      "https://www.packyapi.com/v1",
      "gpt-5.4",
    ),
    endpointCandidates: [
      "https://www.packyapi.com/v1",
      "https://api-slb.packyapi.com/v1",
    ],
  },
  {
    id: "cubence",
    name: "Cubence",
    websiteUrl: "https://cubence.com",
    apiKeyUrl: "https://cubence.com",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "cubence",
      "https://api.cubence.com/v1",
      "gpt-5.4",
    ),
    endpointCandidates: [
      "https://api.cubence.com/v1",
      "https://api-cf.cubence.com/v1",
      "https://api-dmit.cubence.com/v1",
      "https://api-bwg.cubence.com/v1",
    ],
    category: "third_party",
  },
  {
    id: "aigocode",
    name: "AIGoCode",
    websiteUrl: "https://aigocode.com",
    apiKeyUrl: "https://aigocode.com",
    category: "third_party",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "aigocode",
      "https://api.aigocode.com",
      "gpt-5.4",
    ),
    endpointCandidates: ["https://api.aigocode.com"],
  },
  {
    id: "rightcode",
    name: "RightCode",
    websiteUrl: "https://www.right.codes",
    apiKeyUrl: "https://www.right.codes",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "rightcode",
      "https://right.codes/codex/v1",
      "gpt-5.4",
    ),
    category: "third_party",
  },
  {
    id: "aicodemirror",
    name: "AICodeMirror",
    websiteUrl: "https://www.aicodemirror.com",
    apiKeyUrl: "https://www.aicodemirror.com",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "aicodemirror",
      "https://api.aicodemirror.com/api/codex/backend-api/codex",
      "gpt-5.4",
    ),
    endpointCandidates: [
      "https://api.aicodemirror.com/api/codex/backend-api/codex",
      "https://api.claudecode.net.cn/api/codex/backend-api/codex",
    ],
  },
  {
    id: "aicoding",
    name: "AICoding",
    websiteUrl: "https://aicoding.sh",
    apiKeyUrl: "https://aicoding.sh/i/CCSWITCH",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "aicoding",
      "https://api.aicoding.sh",
      "gpt-5.4",
    ),
    endpointCandidates: ["https://api.aicoding.sh"],
  },
  {
    id: "crazyrouter",
    name: "CrazyRouter",
    websiteUrl: "https://www.crazyrouter.com",
    apiKeyUrl: "https://www.crazyrouter.com",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "crazyrouter",
      "https://crazyrouter.com/v1",
      "gpt-5.4",
    ),
    endpointCandidates: ["https://crazyrouter.com/v1"],
  },
  {
    id: "sssaicode",
    name: "SSSAiCode",
    websiteUrl: "https://www.sssaicode.com",
    apiKeyUrl: "https://www.sssaicode.com",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "sssaicode",
      "https://node-hk.sssaicode.com/api/v1",
      "gpt-5.4",
    ),
    endpointCandidates: [
      "https://node-hk.sssaicode.com/api/v1",
      "https://claude2.sssaicode.com/api/v1",
      "https://anti.sssaicode.com/api/v1",
    ],
    category: "third_party",
  },
  {
    id: "compshare",
    name: "Compshare",
    websiteUrl: "https://www.compshare.cn",
    apiKeyUrl: "https://www.compshare.cn",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "compshare",
      "https://api.modelverse.cn/v1",
      "gpt-5.4",
    ),
    endpointCandidates: ["https://api.modelverse.cn/v1"],
    category: "aggregator",
  },
  {
    id: "micu",
    name: "Micu",
    websiteUrl: "https://www.openclaudecode.cn",
    apiKeyUrl: "https://www.openclaudecode.cn",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "micu",
      "https://www.openclaudecode.cn/v1",
      "gpt-5.4",
    ),
    endpointCandidates: ["https://www.openclaudecode.cn/v1"],
    category: "third_party",
  },
  {
    id: "x-code",
    name: "X-Code API",
    websiteUrl: "https://x-code.cc",
    apiKeyUrl: "https://x-code.cc",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "x-code",
      "https://x-code.cc/v1",
      "gpt-5.4",
    ),
    endpointCandidates: ["https://x-code.cc/v1"],
    category: "third_party",
  },
  {
    id: "ctok",
    name: "CTok.ai",
    websiteUrl: "https://ctok.ai",
    apiKeyUrl: "https://ctok.ai",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "ctok",
      "https://api.ctok.ai/v1",
      "gpt-5.4",
    ),
    endpointCandidates: ["https://api.ctok.ai/v1"],
    category: "third_party",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    websiteUrl: "https://openrouter.ai",
    apiKeyUrl: "https://openrouter.ai/keys",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "openrouter",
      "https://openrouter.ai/api/v1",
      "gpt-5.4",
    ),
    category: "aggregator",
    endpointCandidates: ["https://openrouter.ai/api/v1"],
  },
];
