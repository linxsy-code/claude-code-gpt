import type { BetaJSONOutputFormat } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  ImageBlockParam,
  TextBlockParam,
  ThinkingBlock,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import {
  complete,
  getModel as getPiAIModel,
  type Context as PiAIContext,
  type Message as PiAIMessage,
  type Model as PiAIModel,
  type ThinkingLevel as PiAIThinkingLevel,
  type Tool as PiAITool,
} from '@mariozechner/pi-ai'
import { randomUUID } from 'crypto'
import {
  getEmptyToolPermissionContext,
  type QueryChainTracking,
  type Tool,
  toolMatchesName,
  type Tools,
} from 'src/Tool.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type {
  AssistantMessage,
  Message,
  SystemAPIErrorMessage,
  UserMessage,
} from 'src/types/message.js'
import { getInitializationStatus } from 'src/services/lsp/manager.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from 'src/utils/context.js'
import { getUserAgent } from 'src/utils/http.js'
import {
  createAssistantMessage,
  ensureToolResultPairing,
  normalizeMessagesForAPI,
} from 'src/utils/messages.js'
import { normalizeModelStringForAPI } from 'src/utils/model/model.js'
import { safeParseJSON } from 'src/utils/json.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type { SystemPrompt } from 'src/utils/systemPromptType.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import {
  getCLISyspromptPrefix,
} from '../../constants/system.js'
import { toolToAPISchema } from '../../utils/api.js'
import {
  convertEffortValueToLevel,
  type EffortValue,
} from '../../utils/effort.js'
import {
  getOpenAICompatibleApiKey,
  getOpenAICompatibleApiKeyEnvVarName,
  getOpenAICompatibleBaseUrl,
  isOpenAICodexProviderEnabled,
} from '../../utils/model/providers.js'
import { resolveOpenAICodexAccessToken } from '../../utils/openaiCodexAuth.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import {
  extractDiscoveredToolNames,
  isToolSearchEnabled,
  isToolReferenceBlock,
} from '../../utils/toolSearch.js'
import {
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../../tools/ToolSearchTool/prompt.js'

type OpenAIQueryOptions = {
  getToolPermissionContext: () => Promise<ReturnType<typeof getEmptyToolPermissionContext>>
  model: string
  toolChoice?: { type?: string; name?: string } | undefined
  isNonInteractiveSession: boolean
  maxOutputTokensOverride?: number
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: typeof fetch
  temperatureOverride?: number
  effortValue?: EffortValue
  thinkingConfig?: ThinkingConfig
  mcpTools: Tools
  queryTracking?: QueryChainTracking
  outputFormat?: BetaJSONOutputFormat
}

type SideQueryLikeOptions = {
  model: string
  system?: string | TextBlockParam[]
  messages: Array<{
    role: string
    content: string | Array<Record<string, unknown>>
  }>
  tools?: Array<Record<string, unknown>>
  tool_choice?: Record<string, unknown>
  output_format?: BetaJSONOutputFormat
  max_tokens?: number
  signal?: AbortSignal
  temperature?: number
  thinking?: number | false
  stop_sequences?: string[]
  querySource: QuerySource
}

type OpenAIChatMessage =
  | {
      role: 'system' | 'assistant' | 'user'
      content: string | Array<Record<string, unknown>> | null
      reasoning_content?: string | Array<Record<string, unknown>>
      tool_calls?: Array<Record<string, unknown>>
    }
  | {
      role: 'tool'
      tool_call_id: string
      content: string
    }

type OpenAIChatCompletionResponse = {
  id?: string
  model?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  choices?: Array<{
    finish_reason?: string | null
    message?: {
      role?: string
      content?: string | Array<Record<string, unknown>> | null
      reasoning_content?: string | Array<Record<string, unknown>> | null
      tool_calls?: Array<{
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
  }>
  error?: {
    message?: string
  }
}

type OpenAIRequestMessagesOptions = {
  requireReasoningContent?: boolean
}

function getOpenAIBaseUrl(): string {
  return getOpenAICompatibleBaseUrl()
}

function getOpenAIApiKey(): string {
  const apiKey = getOpenAICompatibleApiKey()
  if (!apiKey) {
    throw new Error(
      `${getOpenAICompatibleApiKeyEnvVarName()} is required for the configured OpenAI-compatible provider`,
    )
  }
  return apiKey
}

function getSystemPromptText(
  systemPrompt: SystemPrompt,
  isNonInteractiveSession: boolean,
  hasAppendSystemPrompt: boolean,
): string {
  return [
    getCLISyspromptPrefix({
      isNonInteractive: isNonInteractiveSession,
      hasAppendSystemPrompt,
    }),
    ...systemPrompt,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function serializeUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    return jsonStringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function serializeToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return serializeUnknown(content)
  }
  return content
    .map(block => {
      if (!block || typeof block !== 'object') {
        return serializeUnknown(block)
      }
      if ('type' in block && block.type === 'text' && 'text' in block) {
        return typeof block.text === 'string'
          ? block.text
          : serializeUnknown(block.text)
      }
      return serializeUnknown(block)
    })
    .join('\n\n')
}

function flushPendingUserBlocks(
  pendingBlocks: Array<Record<string, unknown>>,
  chatMessages: OpenAIChatMessage[],
): void {
  if (pendingBlocks.length === 0) {
    return
  }
  const hasNonTextBlocks = pendingBlocks.some(block => block.type !== 'text')
  if (!hasNonTextBlocks) {
    chatMessages.push({
      role: 'user',
      content: pendingBlocks
        .map(block => String(block.text ?? ''))
        .join('\n\n')
        .trim(),
    })
    pendingBlocks.length = 0
    return
  }
  chatMessages.push({
    role: 'user',
    content: [...pendingBlocks],
  })
  pendingBlocks.length = 0
}

function appendUserContentBlock(
  pendingBlocks: Array<Record<string, unknown>>,
  block: Record<string, unknown>,
): void {
  if (block.type === 'text') {
    pendingBlocks.push({
      type: 'text',
      text: String(block.text ?? ''),
    })
    return
  }
  if (
    block.type === 'image' &&
    typeof block.source === 'object' &&
    block.source !== null &&
    'data' in block.source &&
    'media_type' in block.source
  ) {
    const mediaType = String(block.source.media_type)
    const data = String(block.source.data)
    pendingBlocks.push({
      type: 'image_url',
      image_url: {
        url: `data:${mediaType};base64,${data}`,
      },
    })
    return
  }
  pendingBlocks.push({
    type: 'text',
    text: serializeUnknown(block),
  })
}

function buildOpenAIChatMessages(
  messages: (UserMessage | AssistantMessage)[],
  options?: OpenAIRequestMessagesOptions,
): OpenAIChatMessage[] {
  const chatMessages: OpenAIChatMessage[] = []

  for (const message of messages) {
    const content = message.message.content

    if (message.type === 'assistant') {
      const assistantText: string[] = []
      const assistantReasoning: string[] = []
      const toolCalls: Array<Record<string, unknown>> = []

      if (typeof content === 'string') {
        if (content.trim()) {
          assistantText.push(content)
        }
      } else {
        for (const block of content) {
          if (block.type === 'thinking' && typeof block.thinking === 'string') {
            if (block.thinking.trim()) {
              assistantReasoning.push(block.thinking)
            }
            continue
          }
          if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
            if (block.data.trim()) {
              assistantReasoning.push(block.data)
            }
            continue
          }
          if (block.type === 'text' && typeof block.text === 'string') {
            if (block.text.trim()) {
              assistantText.push(block.text)
            }
            continue
          }
          if (block.type === 'tool_use') {
            const toolUseBlock = block as ToolUseBlock
            toolCalls.push({
              id: toolUseBlock.id,
              type: 'function',
              function: {
                name: toolUseBlock.name,
                arguments: JSON.stringify(toolUseBlock.input ?? {}),
              },
            })
          }
        }
      }

      if (
        assistantText.length > 0 ||
        assistantReasoning.length > 0 ||
        toolCalls.length > 0
      ) {
        chatMessages.push({
          role: 'assistant',
          content: assistantText.length > 0 ? assistantText.join('\n\n') : null,
          ...(assistantReasoning.length > 0 && {
            reasoning_content: assistantReasoning.join('\n\n'),
          }),
          ...(assistantReasoning.length === 0 &&
            toolCalls.length > 0 &&
            options?.requireReasoningContent && {
              reasoning_content: '',
            }),
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        })
      }
      continue
    }

    if (typeof content === 'string') {
      if (content.trim()) {
        chatMessages.push({
          role: 'user',
          content,
        })
      }
      continue
    }

    const pendingUserBlocks: Array<Record<string, unknown>> = []
    for (const block of content) {
      if (block.type === 'tool_result') {
        flushPendingUserBlocks(pendingUserBlocks, chatMessages)
        const toolBlock = block as ToolResultBlockParam
        chatMessages.push({
          role: 'tool',
          tool_call_id: toolBlock.tool_use_id,
          content: serializeToolResultContent(toolBlock.content),
        })
        continue
      }
      appendUserContentBlock(
        pendingUserBlocks,
        block as unknown as Record<string, unknown>,
      )
    }
    flushPendingUserBlocks(pendingUserBlocks, chatMessages)
  }

  return chatMessages.filter(message => {
    if (message.role === 'tool') {
      return true
    }
    if (typeof message.content === 'string') {
      return message.content.trim().length > 0 || !!message.tool_calls?.length
    }
    return Array.isArray(message.content) ? message.content.length > 0 : true
  })
}

function parseToolArguments(argumentsText: string | undefined): Record<string, unknown> {
  if (!argumentsText) {
    return {}
  }
  const parsed = safeParseJSON(argumentsText)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return {
    value: parsed ?? argumentsText,
  }
}

function extractReasoningText(
  reasoningContent: string | Array<Record<string, unknown>> | null | undefined,
): string {
  if (typeof reasoningContent === 'string') {
    return reasoningContent.trim()
  }
  if (!Array.isArray(reasoningContent)) {
    return ''
  }

  return reasoningContent
    .map(item => {
      if (typeof item !== 'object' || item === null) {
        return ''
      }
      if ('text' in item && typeof item.text === 'string') {
        return item.text
      }
      if ('reasoning_content' in item && typeof item.reasoning_content === 'string') {
        return item.reasoning_content
      }
      return serializeUnknown(item)
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function buildOpenAIAssistantMessage(params: {
  response: OpenAIChatCompletionResponse
  model: string
  requestId?: string
}): AssistantMessage {
  const choice = params.response.choices?.[0]
  const message = choice?.message
  const blocks: Array<Record<string, unknown>> = []

  const reasoningText = extractReasoningText(message?.reasoning_content)
  if (reasoningText) {
    blocks.push({
      type: 'thinking',
      thinking: reasoningText,
    })
  }

  const content = message?.content
  if (typeof content === 'string') {
    if (content.trim()) {
      blocks.push({
        type: 'text',
        text: content,
      })
    }
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text' && typeof item.text === 'string') {
        if (item.text.trim()) {
          blocks.push({
            type: 'text',
            text: item.text,
          })
        }
      }
    }
  }

  for (const toolCall of message?.tool_calls ?? []) {
    if (toolCall.type !== 'function' || !toolCall.function?.name) {
      continue
    }
    blocks.push({
      type: 'tool_use',
      id: toolCall.id || randomUUID(),
      name: toolCall.function.name,
      input: parseToolArguments(toolCall.function.arguments),
    })
  }

  if (blocks.length === 0) {
    blocks.push({
      type: 'text',
      text: '',
    })
  } else {
    const lastBlock = blocks.at(-1)
    if (lastBlock?.type === 'thinking') {
      blocks.push({
        type: 'text',
        text: '',
      })
    }
  }

  const usage = {
    input_tokens: params.response.usage?.prompt_tokens ?? 0,
    output_tokens: params.response.usage?.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: null,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: null,
    iterations: null,
    speed: null,
  }

  const assistant = createAssistantMessage({
    content: blocks as any,
    usage: usage as any,
  })

  assistant.message.model = params.response.model ?? params.model
  assistant.message.id = params.response.id ?? assistant.message.id
  assistant.message.stop_reason =
    message?.tool_calls && message.tool_calls.length > 0
      ? 'tool_use'
      : 'stop_sequence'
  assistant.requestId = params.requestId ?? params.response.id
  return assistant
}

function getCodexApiKey(): Promise<string> {
  return resolveOpenAICodexAccessToken()
}

function isCodexThinkingBlock(
  block: unknown,
): block is ThinkingBlock | ThinkingBlockParam {
  return (
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    block.type === 'thinking' &&
    'thinking' in block &&
    typeof block.thinking === 'string'
  )
}

function convertImageBlockToPiAIContent(
  block: ImageBlockParam,
): { type: 'image'; data: string; mimeType: string } | null {
  if (
    typeof block.source === 'object' &&
    block.source !== null &&
    'data' in block.source &&
    'media_type' in block.source &&
    typeof block.source.data === 'string' &&
    typeof block.source.media_type === 'string'
  ) {
    return {
      type: 'image',
      data: block.source.data,
      mimeType: block.source.media_type,
    }
  }
  return null
}

function flushPendingPiAIUserContent(
  pendingContent: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >,
  output: PiAIMessage[],
): void {
  if (pendingContent.length === 0) {
    return
  }
  const allText = pendingContent.every(block => block.type === 'text')
  output.push({
    role: 'user',
    content: allText
      ? pendingContent.map(block => block.text).join('\n\n')
      : [...pendingContent],
    timestamp: Date.now(),
  } as PiAIMessage)
  pendingContent.length = 0
}

function buildPiAIContext(params: {
  messages: (UserMessage | AssistantMessage)[]
  systemText?: string
  tools?: Array<Record<string, unknown>>
}): PiAIContext {
  const output: PiAIMessage[] = []

  for (const message of params.messages) {
    const content = message.message.content

    if (message.type === 'assistant') {
      const assistantContent: Array<Record<string, unknown>> = []

      if (typeof content === 'string') {
        if (content.trim()) {
          assistantContent.push({ type: 'text', text: content })
        }
      } else {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            if (block.text.trim()) {
              assistantContent.push({
                type: 'text',
                text: block.text,
              })
            }
            continue
          }
          if (isCodexThinkingBlock(block)) {
            assistantContent.push({
              type: 'thinking',
              thinking: block.thinking,
              ...(typeof block.signature === 'string' &&
                block.signature.trim() && {
                  thinkingSignature: block.signature,
                }),
            })
            continue
          }
          if (block.type === 'tool_use') {
            const toolUseBlock = block as ToolUseBlock
            assistantContent.push({
              type: 'toolCall',
              id: toolUseBlock.id,
              name: toolUseBlock.name,
              arguments:
                typeof toolUseBlock.input === 'object' &&
                toolUseBlock.input !== null
                  ? toolUseBlock.input
                  : {},
            })
          }
        }
      }

      if (assistantContent.length > 0) {
        output.push({
          role: 'assistant',
          content: assistantContent as never,
          api: 'openai-codex-responses',
          provider: 'openai-codex',
          model: normalizeModelStringForAPI(message.message.model ?? ''),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'stop',
          responseId:
            typeof message.message.id === 'string' ? message.message.id : undefined,
          timestamp: Date.now(),
        } as PiAIMessage)
      }
      continue
    }

    if (typeof content === 'string') {
      if (content.trim()) {
        output.push({
          role: 'user',
          content,
          timestamp: Date.now(),
        } as PiAIMessage)
      }
      continue
    }

    const pendingUserContent: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
    > = []

    for (const block of content) {
      if (block.type === 'tool_result') {
        flushPendingPiAIUserContent(pendingUserContent, output)
        const toolResult = block as ToolResultBlockParam
        output.push({
          role: 'toolResult',
          toolCallId: toolResult.tool_use_id,
          toolName:
            typeof toolResult.tool_name === 'string'
              ? toolResult.tool_name
              : 'tool',
          content: [
            {
              type: 'text',
              text: serializeToolResultContent(toolResult.content),
            },
          ],
          isError: toolResult.is_error === true,
          timestamp: Date.now(),
        } as PiAIMessage)
        continue
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        pendingUserContent.push({
          type: 'text',
          text: block.text,
        })
        continue
      }
      if (block.type === 'image') {
        const convertedImage = convertImageBlockToPiAIContent(
          block as ImageBlockParam,
        )
        if (convertedImage) {
          pendingUserContent.push(convertedImage)
          continue
        }
      }
      pendingUserContent.push({
        type: 'text',
        text: serializeUnknown(block),
      })
    }

    flushPendingPiAIUserContent(pendingUserContent, output)
  }

  return {
    ...(params.systemText?.trim() && { systemPrompt: params.systemText }),
    messages: output,
    ...(params.tools &&
      params.tools.length > 0 && {
        tools: params.tools
          .filter(tool => tool.name && tool.input_schema)
          .map(tool => ({
            name: String(tool.name),
            description:
              typeof tool.description === 'string' ? tool.description : '',
            parameters: tool.input_schema,
          })) as PiAITool[],
      }),
  }
}

function resolveCodexReasoningEffort(
  effortValue: EffortValue | undefined,
): PiAIThinkingLevel {
  if (effortValue === 'low') {
    return 'low'
  }
  if (effortValue === 'medium') {
    return 'medium'
  }
  if (effortValue === 'high') {
    return 'high'
  }
  if (effortValue === 'max') {
    return 'xhigh'
  }
  return 'medium'
}

function buildCodexModel(model: string): PiAIModel<'openai-codex-responses'> {
  const normalizedModel = normalizeModelStringForAPI(model)
  const builtinModel = getPiAIModel('openai-codex', normalizedModel as never)
  if (builtinModel) {
    return {
      ...builtinModel,
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      baseUrl: getOpenAIBaseUrl(),
    }
  }
  return {
    id: normalizedModel,
    name: normalizedModel,
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: getOpenAIBaseUrl(),
    reasoning: true,
    input: ['text', 'image'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: getContextWindowForModel(normalizedModel),
    maxTokens: getModelMaxOutputTokens(normalizedModel).upperLimit,
  }
}

function buildAssistantStopReason(stopReason: string | undefined): string {
  if (stopReason === 'toolUse') {
    return 'tool_use'
  }
  if (stopReason === 'length') {
    return 'max_tokens'
  }
  return 'stop_sequence'
}

function buildAssistantMessageFromCodexResponse(params: {
  response: Awaited<ReturnType<typeof complete>>
  model: string
}): AssistantMessage {
  const blocks: Array<Record<string, unknown>> = []

  for (const block of params.response.content) {
    if (block.type === 'thinking') {
      blocks.push({
        type: 'thinking',
        thinking: block.thinking,
        ...(typeof block.thinkingSignature === 'string' &&
          block.thinkingSignature.trim() && {
            signature: block.thinkingSignature,
          }),
      })
      continue
    }
    if (block.type === 'text') {
      blocks.push({
        type: 'text',
        text: block.text,
      })
      continue
    }
    if (block.type === 'toolCall') {
      blocks.push({
        type: 'tool_use',
        id: block.id || randomUUID(),
        name: block.name,
        input:
          typeof block.arguments === 'object' && block.arguments !== null
            ? block.arguments
            : {},
      })
    }
  }

  if (blocks.length === 0 || blocks.at(-1)?.type === 'thinking') {
    blocks.push({
      type: 'text',
      text: '',
    })
  }

  const assistant = createAssistantMessage({
    content: blocks as any,
    usage: {
      input_tokens: params.response.usage.input,
      output_tokens: params.response.usage.output,
      cache_creation_input_tokens: params.response.usage.cacheWrite,
      cache_read_input_tokens: params.response.usage.cacheRead,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: null,
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      inference_geo: null,
      iterations: null,
      speed: null,
    } as any,
  })

  assistant.message.model =
    params.response.model ?? normalizeModelStringForAPI(params.model)
  assistant.message.id = params.response.responseId ?? assistant.message.id
  assistant.message.stop_reason = buildAssistantStopReason(
    params.response.stopReason,
  )
  assistant.requestId = params.response.responseId
  return assistant
}

async function createCodexCompletion(params: {
  model: string
  systemText?: string
  messages: (UserMessage | AssistantMessage)[]
  tools?: Array<Record<string, unknown>>
  maxTokens?: number
  signal?: AbortSignal
  effortValue?: EffortValue
  sessionId?: string
  temperature?: number
  outputFormat?: BetaJSONOutputFormat
}): Promise<AssistantMessage> {
  const outputSchema = (params.outputFormat as { schema?: Record<string, unknown> } | undefined)?.schema
  const systemText = outputSchema
    ? [
        params.systemText,
        'Return valid JSON only. The response must strictly match this JSON schema:',
        jsonStringify(outputSchema, null, 2),
      ]
        .filter(Boolean)
        .join('\n\n')
    : params.systemText

  const response = await complete(
    buildCodexModel(params.model),
    buildPiAIContext({
      messages: params.messages,
      systemText,
      tools: params.tools,
    }),
    {
      apiKey: await getCodexApiKey(),
      maxTokens: params.maxTokens,
      signal: params.signal,
      sessionId: params.sessionId,
      transport: 'auto',
      temperature: params.temperature,
      reasoningEffort: resolveCodexReasoningEffort(params.effortValue),
      textVerbosity: 'medium',
    },
  )

  return buildAssistantMessageFromCodexResponse({
    response,
    model: params.model,
  })
}

function convertToolChoice(
  toolChoice: OpenAIQueryOptions['toolChoice'] | SideQueryLikeOptions['tool_choice'],
): Record<string, unknown> | string | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') {
    return undefined
  }
  if ('type' in toolChoice && toolChoice.type === 'tool' && 'name' in toolChoice) {
    return {
      type: 'function',
      function: {
        name: toolChoice.name,
      },
    }
  }
  if ('type' in toolChoice && toolChoice.type === 'auto') {
    return 'auto'
  }
  return undefined
}

function convertResponseFormat(
  outputFormat: BetaJSONOutputFormat | undefined,
): Record<string, unknown> | undefined {
  if (!outputFormat) {
    return undefined
  }
  const schema = (outputFormat as { schema?: Record<string, unknown> }).schema
  if (!schema) {
    return undefined
  }
  return {
    type: 'json_schema',
    json_schema: {
      name:
        (outputFormat as { name?: string }).name ?? 'structured_output',
      schema,
      strict: true,
    },
  }
}

function convertTools(
  tools: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }
  const converted = tools
    .filter(tool => tool.name && tool.input_schema)
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
        ...(tool.strict === true && { strict: true }),
      },
    }))
  return converted.length > 0 ? converted : undefined
}

function shouldDeferLspTool(tool: Tool): boolean {
  if (!('isLsp' in tool) || !tool.isLsp) {
    return false
  }
  const status = getInitializationStatus()
  return status.status === 'pending' || status.status === 'not-started'
}

function isToolReferenceWithName(
  value: unknown,
): value is { type: 'tool_reference'; tool_name: string } {
  return (
    isToolReferenceBlock(value) &&
    'tool_name' in (value as object) &&
    typeof (value as { tool_name: unknown }).tool_name === 'string'
  )
}

function renderExpandedToolFunctions(
  toolNames: string[],
  toolSchemasByName: ReadonlyMap<string, Record<string, unknown>>,
): { functionsText: string; missingToolNames: string[] } {
  const missingToolNames: string[] = []
  const rendered = toolNames.flatMap(toolName => {
    const tool = toolSchemasByName.get(toolName)
    if (!tool?.name || !tool.input_schema) {
      missingToolNames.push(toolName)
      return []
    }
    return [
      `<function>${jsonStringify({
        description:
          typeof tool.description === 'string' ? tool.description : '',
        name: tool.name,
        parameters: tool.input_schema,
      })}</function>`,
    ]
  })

  if (rendered.length === 0) {
    return { functionsText: '', missingToolNames }
  }

  return {
    functionsText: `<functions>\n${rendered.join('\n')}\n</functions>`,
    missingToolNames,
  }
}

function expandToolReferencesInMessages(
  messages: (UserMessage | AssistantMessage)[],
  toolSchemasByName: ReadonlyMap<string, Record<string, unknown>>,
): (UserMessage | AssistantMessage)[] {
  return messages.map(message => {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      return message
    }

    let changed = false
    const content = message.message.content.map(block => {
      if (
        block.type !== 'tool_result' ||
        !Array.isArray(block.content)
      ) {
        return block
      }

      const referencedToolNames: string[] = []
      const fallbackText: string[] = []

      for (const item of block.content) {
        if (isToolReferenceWithName(item)) {
          referencedToolNames.push(item.tool_name)
          continue
        }
        if (
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          item.type === 'text' &&
          'text' in item &&
          typeof item.text === 'string'
        ) {
          fallbackText.push(item.text)
          continue
        }
        fallbackText.push(serializeUnknown(item))
      }

      if (referencedToolNames.length === 0) {
        return block
      }

      changed = true
      const { functionsText, missingToolNames } = renderExpandedToolFunctions(
        referencedToolNames,
        toolSchemasByName,
      )
      for (const toolName of missingToolNames) {
        fallbackText.push(
          `Deferred tool schema for "${toolName}" is unavailable in the current request context.`,
        )
      }

      return {
        ...block,
        content: [functionsText, ...fallbackText]
          .filter(Boolean)
          .join('\n\n')
          .trim(),
      }
    })

    if (!changed) {
      return message
    }

    return {
      ...message,
      message: {
        ...message.message,
        content,
      },
    }
  })
}

async function resolveOpenAIToolContext(params: {
  allMessages: Message[]
  tools: Tools
  options: OpenAIQueryOptions
}): Promise<{
  filteredTools: Tools
  toolSchemas: Array<Record<string, unknown>>
  expandMessages: (
    messages: (UserMessage | AssistantMessage)[],
  ) => (UserMessage | AssistantMessage)[]
}> {
  const deferredToolNames = new Set(
    params.tools.filter(isDeferredTool).map(tool => tool.name),
  )
  const useToolSearch =
    deferredToolNames.size > 0
      ? await isToolSearchEnabled(
          params.options.model,
          params.tools,
          params.options.getToolPermissionContext as any,
          params.options.agents,
          'openai',
        )
      : false

  let filteredTools: Tools
  if (useToolSearch) {
    const discoveredToolNames = extractDiscoveredToolNames(params.allMessages)
    filteredTools = params.tools.filter(tool => {
      if (!deferredToolNames.has(tool.name) && !shouldDeferLspTool(tool)) {
        return true
      }
      if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) {
        return true
      }
      return discoveredToolNames.has(tool.name)
    })
  } else {
    filteredTools = params.tools.filter(
      tool => !toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME),
    )
  }

  const willDeferTool = (tool: Tool): boolean =>
    useToolSearch &&
    (deferredToolNames.has(tool.name) || shouldDeferLspTool(tool))

  const toolSchemas = (await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: params.options.getToolPermissionContext as any,
        tools: params.tools,
        agents: params.options.agents,
        allowedAgentTypes: params.options.allowedAgentTypes,
        model: params.options.model,
        deferLoading: willDeferTool(tool),
      }),
    ),
  )) as Array<Record<string, unknown>>

  const toolSchemasByName = new Map(
    toolSchemas
      .filter(tool => typeof tool.name === 'string')
      .map(tool => [String(tool.name), tool] as const),
  )

  return {
    filteredTools,
    toolSchemas,
    expandMessages: messages =>
      expandToolReferencesInMessages(messages, toolSchemasByName),
  }
}

function resolveOpenAIReasoningEffort(params: {
  effortValue?: EffortValue
  thinkingConfig?: ThinkingConfig
}): 'low' | 'medium' | 'high' | undefined {
  if (params.thinkingConfig?.type === 'disabled' && params.effortValue === undefined) {
    return undefined
  }

  if (params.effortValue !== undefined) {
    const level = convertEffortValueToLevel(params.effortValue)
    return level === 'max' ? 'high' : level
  }

  if (params.thinkingConfig?.type && params.thinkingConfig.type !== 'disabled') {
    return 'medium'
  }

  return undefined
}

async function createChatCompletion(params: {
  model: string
  messages: OpenAIChatMessage[]
  tools?: Array<Record<string, unknown>>
  toolChoice?: Record<string, unknown> | string
  responseFormat?: Record<string, unknown>
  maxTokens?: number
  temperature?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
  stopSequences?: string[]
  signal?: AbortSignal
  fetchOverride?: typeof fetch
}): Promise<{ data: OpenAIChatCompletionResponse; requestId?: string }> {
  const fetchFn = params.fetchOverride ?? fetch
  const headers = {
    Authorization: `Bearer ${getOpenAIApiKey()}`,
    'Content-Type': 'application/json',
    'User-Agent': getUserAgent(),
  }
  const requestBodyBase = {
    model: normalizeModelStringForAPI(params.model),
    messages: params.messages,
    ...(params.tools && { tools: params.tools }),
    ...(params.toolChoice && { tool_choice: params.toolChoice }),
    ...(params.responseFormat && { response_format: params.responseFormat }),
    ...(params.maxTokens && { max_completion_tokens: params.maxTokens }),
    ...(params.temperature !== undefined && {
      temperature: params.temperature,
    }),
    ...(params.stopSequences && params.stopSequences.length > 0 && {
      stop: params.stopSequences,
    }),
  }

  let response = await fetchFn(`${getOpenAIBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...requestBodyBase,
      ...(params.reasoningEffort && {
        reasoning_effort: params.reasoningEffort,
      }),
    }),
    signal: params.signal,
  })

  const requestId =
    response.headers.get('x-request-id') ??
    response.headers.get('openai-request-id') ??
    undefined
  const data = (await response.json()) as OpenAIChatCompletionResponse

  if (
    !response.ok &&
    params.reasoningEffort &&
    response.status >= 400 &&
    response.status < 500
  ) {
    const errorMessage = data.error?.message?.toLowerCase() ?? ''
    const rejectedReasoningField =
      errorMessage.includes('reasoning_effort') ||
      errorMessage.includes('reasoning effort') ||
      errorMessage.includes('unsupported field') ||
      errorMessage.includes('extra inputs are not permitted')

    if (rejectedReasoningField) {
      response = await fetchFn(`${getOpenAIBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBodyBase),
        signal: params.signal,
      })
      const retryRequestId =
        response.headers.get('x-request-id') ??
        response.headers.get('openai-request-id') ??
        requestId
      const retryData = (await response.json()) as OpenAIChatCompletionResponse

      if (!response.ok) {
        throw new Error(
          retryData.error?.message ||
            `OpenAI API request failed with status ${response.status}`,
        )
      }

      return { data: retryData, requestId: retryRequestId }
    }
  }

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
        `OpenAI API request failed with status ${response.status}`,
    )
  }

  return { data, requestId }
}

export async function* queryModelWithOpenAI({
  messages,
  systemPrompt,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  tools: Tools
  signal: AbortSignal
  options: OpenAIQueryOptions
}): AsyncGenerator<
  SystemAPIErrorMessage | AssistantMessage,
  void
> {
  const toolContext = await resolveOpenAIToolContext({
    allMessages: messages,
    tools,
    options,
  })
  const normalizedMessages = toolContext.expandMessages(
    ensureToolResultPairing(
      normalizeMessagesForAPI(messages, toolContext.filteredTools),
    ),
  )

  const systemText = getSystemPromptText(
    systemPrompt,
    options.isNonInteractiveSession,
    options.hasAppendSystemPrompt,
  )

  if (isOpenAICodexProviderEnabled()) {
    yield await createCodexCompletion({
      model: options.model,
      systemText,
      messages: normalizedMessages,
      tools: toolContext.toolSchemas,
      maxTokens:
        options.maxOutputTokensOverride ??
        getModelMaxOutputTokens(options.model).default,
      signal,
      effortValue: options.effortValue,
      sessionId: options.queryTracking?.chainId,
      temperature: options.temperatureOverride,
      outputFormat: options.outputFormat,
    })
    return
  }

  const chatMessages = buildOpenAIChatMessages(normalizedMessages, {
    requireReasoningContent:
      options.thinkingConfig?.type === 'adaptive' ||
      options.thinkingConfig?.type === 'enabled',
  })
  if (systemText.trim()) {
    chatMessages.unshift({
      role: 'system',
      content: systemText,
    })
  }

  const { data, requestId } = await createChatCompletion({
    model: options.model,
    messages: chatMessages,
    tools: convertTools(toolContext.toolSchemas),
    toolChoice: convertToolChoice(options.toolChoice),
    responseFormat: convertResponseFormat(options.outputFormat),
    maxTokens:
      options.maxOutputTokensOverride ??
      getModelMaxOutputTokens(options.model).default,
    temperature: options.temperatureOverride,
    reasoningEffort: resolveOpenAIReasoningEffort({
      effortValue: options.effortValue,
      thinkingConfig: options.thinkingConfig,
    }),
    signal,
    fetchOverride: options.fetchOverride,
  })

  yield buildOpenAIAssistantMessage({
    response: data,
    model: options.model,
    requestId,
  })
}

function convertSideQueryMessages(
  messages: SideQueryLikeOptions['messages'],
  options?: OpenAIRequestMessagesOptions,
): OpenAIChatMessage[] {
  return messages.map(message => {
    if (typeof message.content === 'string') {
      return {
        role: message.role as 'user' | 'assistant' | 'system',
        content: message.content,
      }
    }

    const textParts = message.content
      .map(item => {
        if (item.type === 'text' && typeof item.text === 'string') {
          return item.text
        }
        return serializeUnknown(item)
      })
      .join('\n\n')

    return {
      role: message.role as 'user' | 'assistant' | 'system',
      content: textParts,
      ...(message.role === 'assistant' &&
        options?.requireReasoningContent && {
          reasoning_content: '',
        }),
    }
  })
}

export async function sideQueryWithOpenAI(
  options: SideQueryLikeOptions,
): Promise<Record<string, unknown>> {
  const systemText = Array.isArray(options.system)
    ? options.system
        .map(block =>
          block.type === 'text' && typeof block.text === 'string'
            ? block.text
            : '',
        )
        .filter(Boolean)
        .join('\n\n')
    : (options.system ?? '')

  if (isOpenAICodexProviderEnabled()) {
    const assistantMessage = await createCodexCompletion({
      model: options.model,
      systemText,
      messages: options.messages.map(message => ({
        type: message.role === 'assistant' ? 'assistant' : 'user',
        uuid: randomUUID() as never,
        message: {
          role: message.role,
          content: message.content,
        },
      })) as Array<UserMessage | AssistantMessage>,
      tools: options.tools,
      maxTokens: options.max_tokens ?? 1024,
      signal: options.signal,
      temperature: options.temperature,
      outputFormat: options.output_format,
    })

    return {
      id: assistantMessage.message.id,
      type: 'message',
      role: 'assistant',
      model: assistantMessage.message.model,
      content: assistantMessage.message.content,
      stop_reason: assistantMessage.message.stop_reason,
      usage: assistantMessage.message.usage,
    }
  }

  const chatMessages = convertSideQueryMessages(options.messages, {
    requireReasoningContent: options.thinking !== false && options.thinking !== undefined,
  })
  if (systemText.trim()) {
    chatMessages.unshift({
      role: 'system',
      content: systemText,
    })
  }

  const { data } = await createChatCompletion({
    model: options.model,
    messages: chatMessages,
    tools: convertTools(options.tools),
    toolChoice: convertToolChoice(options.tool_choice),
    responseFormat: convertResponseFormat(options.output_format),
    maxTokens: options.max_tokens ?? 1024,
    temperature: options.temperature,
    reasoningEffort:
      options.thinking === false
        ? undefined
        : options.thinking !== undefined
          ? 'medium'
          : undefined,
    stopSequences: options.stop_sequences,
    signal: options.signal,
  })

  const assistantMessage = buildOpenAIAssistantMessage({
    response: data,
    model: options.model,
  })

  return {
    id: assistantMessage.message.id,
    type: 'message',
    role: 'assistant',
    model: assistantMessage.message.model,
    content: assistantMessage.message.content,
    stop_reason: assistantMessage.message.stop_reason,
    usage: assistantMessage.message.usage,
  }
}
