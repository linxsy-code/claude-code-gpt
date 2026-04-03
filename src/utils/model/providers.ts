import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'
import { getOpenAICodexAccessTokenSync } from '../openaiCodexAuth.js'

export type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'openai'

export type AnthropicGatewayCapability =
  | 'tool_search'
  | 'tool_reference'
  | 'defer_loading'
  | 'structured_outputs'
  | 'prompt_caching_scope'
  | 'context_management'
  | 'redact_thinking'
  | 'task_budgets'
  | 'fine_grained_tool_streaming'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const DEFAULT_MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1'
const DEFAULT_QWEN_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DEFAULT_OPENAI_MODEL = 'gpt-5'
const DEFAULT_OPENAI_SMALL_FAST_MODEL = 'gpt-5-mini'
const DEFAULT_OPENAI_CODEX_MODEL = 'gpt-5.4'
const DEFAULT_OPENAI_CODEX_SMALL_FAST_MODEL = 'gpt-5.4-mini'
const DEFAULT_MOONSHOT_MODEL = 'kimi-k2.5'
const DEFAULT_QWEN_MODEL = 'qwen3-coder-plus'
const DEFAULT_QWEN_SMALL_FAST_MODEL = 'qwen3-coder-flash'
const ALL_ANTHROPIC_GATEWAY_CAPABILITIES: AnthropicGatewayCapability[] = [
  'tool_search',
  'tool_reference',
  'defer_loading',
  'structured_outputs',
  'prompt_caching_scope',
  'context_management',
  'redact_thinking',
  'task_budgets',
  'fine_grained_tool_streaming',
]
const ANTHROPIC_GATEWAY_CAPABILITY_ALIASES: Record<
  string,
  AnthropicGatewayCapability[]
> = {
  all: ALL_ANTHROPIC_GATEWAY_CAPABILITIES,
  full: ALL_ANTHROPIC_GATEWAY_CAPABILITIES,
  translate: ALL_ANTHROPIC_GATEWAY_CAPABILITIES,
  tool_search: ['tool_search', 'tool_reference', 'defer_loading'],
  tool_reference: ['tool_reference'],
  defer_loading: ['defer_loading'],
  strict_tools: ['structured_outputs'],
  structured_outputs: ['structured_outputs'],
  prompt_caching: ['prompt_caching_scope'],
  prompt_caching_scope: ['prompt_caching_scope'],
  context_management: ['context_management'],
  thinking: ['redact_thinking'],
  redact_thinking: ['redact_thinking'],
  task_budgets: ['task_budgets'],
  fgts: ['fine_grained_tool_streaming'],
  fine_grained_tool_streaming: ['fine_grained_tool_streaming'],
}

export function isOpenAICodexProviderEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI_CODEX)
}

export function isMoonshotProviderEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_MOONSHOT)
}

export function isQwenProviderEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_QWEN)
}

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : isOpenAICodexProviderEnabled()
          ? 'openai'
        : isQwenProviderEnabled()
          ? 'openai'
        : isMoonshotProviderEnabled()
          ? 'openai'
        : isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)
          ? 'openai'
        : 'firstParty'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}

export function isCustomAnthropicBaseUrl(): boolean {
  return getAPIProvider() === 'firstParty' && !isFirstPartyAnthropicBaseUrl()
}

function resolveAnthropicGatewayCapabilities():
  | Set<AnthropicGatewayCapability>
  | null {
  if (!isCustomAnthropicBaseUrl()) {
    return null
  }

  const rawValue =
    process.env.CLAUDE_CODE_ANTHROPIC_GATEWAY_CAPABILITIES ||
    process.env.ANTHROPIC_GATEWAY_CAPABILITIES

  // A custom ANTHROPIC_BASE_URL is treated as a full Anthropic-protocol
  // translation gateway by default. Users can still narrow or disable the
  // capability set via *_GATEWAY_CAPABILITIES if their proxy only implements a
  // subset of Anthropic semantics.
  if (!rawValue) {
    return new Set(ALL_ANTHROPIC_GATEWAY_CAPABILITIES)
  }

  const capabilities = new Set<AnthropicGatewayCapability>()
  for (const rawToken of rawValue.split(',')) {
    const token = rawToken.trim().toLowerCase()
    if (!token) continue

    if (token === 'none') {
      capabilities.clear()
      continue
    }

    const isRemoval = token.startsWith('-')
    const key = isRemoval ? token.slice(1) : token
    const resolved = ANTHROPIC_GATEWAY_CAPABILITY_ALIASES[key]
    if (!resolved) {
      continue
    }

    for (const capability of resolved) {
      if (isRemoval) {
        capabilities.delete(capability)
      } else {
        capabilities.add(capability)
      }
    }
  }

  return capabilities
}

export function supportsAnthropicGatewayCapability(
  capability: AnthropicGatewayCapability,
): boolean {
  if (getAPIProvider() !== 'firstParty') {
    return false
  }
  if (isFirstPartyAnthropicBaseUrl()) {
    return true
  }

  return resolveAnthropicGatewayCapabilities()?.has(capability) ?? false
}

export function isOpenAICompatibleProvider(): boolean {
  return getAPIProvider() === 'openai'
}

export function getOpenAICompatibleProviderName(): string {
  if (isOpenAICodexProviderEnabled()) {
    return 'OpenAI Codex'
  }
  if (isQwenProviderEnabled()) {
    return 'Qwen'
  }
  if (isMoonshotProviderEnabled()) {
    return 'Moonshot'
  }
  return 'OpenAI'
}

export function getOpenAICompatibleBaseUrl(): string {
  const baseUrl = isOpenAICodexProviderEnabled()
    ? process.env.OPENAI_CODEX_BASE_URL || DEFAULT_OPENAI_CODEX_BASE_URL
    : isQwenProviderEnabled()
    ? process.env.QWEN_BASE_URL ||
      process.env.DASHSCOPE_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      DEFAULT_QWEN_BASE_URL
    : isMoonshotProviderEnabled()
      ? process.env.MOONSHOT_BASE_URL ||
        process.env.OPENAI_BASE_URL ||
        DEFAULT_MOONSHOT_BASE_URL
      : process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL
  return baseUrl.replace(/\/+$/, '')
}

export function getOpenAICompatibleApiKey(): string | undefined {
  if (isOpenAICodexProviderEnabled()) {
    return getOpenAICodexAccessTokenSync()
  }
  if (isQwenProviderEnabled()) {
    return (
      process.env.QWEN_API_KEY ||
      process.env.DASHSCOPE_API_KEY ||
      process.env.OPENAI_API_KEY
    )
  }
  if (isMoonshotProviderEnabled()) {
    return process.env.MOONSHOT_API_KEY || process.env.OPENAI_API_KEY
  }
  return process.env.OPENAI_API_KEY
}

export function getOpenAICompatibleApiKeyEnvVarName(): string {
  if (isOpenAICodexProviderEnabled()) {
    return 'OPENAI_CODEX_ACCESS_TOKEN'
  }
  if (isQwenProviderEnabled()) {
    return 'QWEN_API_KEY'
  }
  return isMoonshotProviderEnabled() ? 'MOONSHOT_API_KEY' : 'OPENAI_API_KEY'
}

export function getOpenAICompatibleDefaultModel(): string {
  if (isOpenAICodexProviderEnabled()) {
    return (
      process.env.OPENAI_CODEX_MODEL ||
      process.env.OPENAI_MODEL ||
      DEFAULT_OPENAI_CODEX_MODEL
    )
  }
  if (isQwenProviderEnabled()) {
    return (
      process.env.QWEN_MODEL ||
      process.env.OPENAI_MODEL ||
      DEFAULT_QWEN_MODEL
    )
  }
  if (isMoonshotProviderEnabled()) {
    return (
      process.env.MOONSHOT_MODEL ||
      process.env.OPENAI_MODEL ||
      DEFAULT_MOONSHOT_MODEL
    )
  }
  return process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
}

export function getOpenAICompatibleConfiguredModel(): string | undefined {
  if (isOpenAICodexProviderEnabled()) {
    return (
      process.env.OPENAI_CODEX_MODEL || process.env.OPENAI_MODEL || undefined
    )
  }
  if (isQwenProviderEnabled()) {
    return process.env.QWEN_MODEL || process.env.OPENAI_MODEL || undefined
  }
  if (isMoonshotProviderEnabled()) {
    return process.env.MOONSHOT_MODEL || process.env.OPENAI_MODEL || undefined
  }
  return process.env.OPENAI_MODEL || undefined
}

export function getOpenAICompatibleSmallFastModel(): string {
  if (isOpenAICodexProviderEnabled()) {
    return (
      process.env.OPENAI_CODEX_SMALL_FAST_MODEL ||
      process.env.OPENAI_SMALL_FAST_MODEL ||
      DEFAULT_OPENAI_CODEX_SMALL_FAST_MODEL
    )
  }
  if (isQwenProviderEnabled()) {
    return (
      process.env.QWEN_SMALL_FAST_MODEL ||
      process.env.OPENAI_SMALL_FAST_MODEL ||
      DEFAULT_QWEN_SMALL_FAST_MODEL
    )
  }
  if (isMoonshotProviderEnabled()) {
    return (
      process.env.MOONSHOT_SMALL_FAST_MODEL ||
      process.env.OPENAI_SMALL_FAST_MODEL ||
      getOpenAICompatibleDefaultModel()
    )
  }
  return process.env.OPENAI_SMALL_FAST_MODEL || DEFAULT_OPENAI_SMALL_FAST_MODEL
}
