import type {
  AnthropicRequest,
  NormalizedThinking,
  ReasoningCapabilities,
  ReasoningWireFormat,
  UpstreamContext,
} from './types.js';
import {
  anthropicHistoryToReasoningDetails,
  buildReasoningConfig,
  mapFinishReason,
  reasoningDetailsToAnthropicBlocks,
} from './reasoning.js';

type Json = Record<string, unknown>;

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function logReasoningContent(event: string, details: Record<string, unknown>) {
  console.warn(`[warn] ${event} ${JSON.stringify(details)}`);
}

export function normalizeThinking(raw: unknown, outputConfig?: unknown): NormalizedThinking {
  if (!raw || typeof raw !== 'object') return { enabled: false };
  const v = raw as Json;
  if (v.type === 'disabled' || v.enabled === false) return { enabled: false };
  const oc = outputConfig && typeof outputConfig === 'object' ? (outputConfig as Json) : undefined;
  const rawEffort = oc?.effort ?? v.effort;
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(rawEffort))
    ? (rawEffort as NormalizedThinking['effort'])
    : undefined;
  const budgetTokens = typeof v.budget_tokens === 'number' ? v.budget_tokens : undefined;
  return {
    enabled:
      v.type === 'enabled' ||
      v.type === 'adaptive' ||
      v.enabled === true ||
      Boolean(effort || budgetTokens),
    ...(effort ? { effort } : {}),
    ...(budgetTokens ? { budgetTokens } : {}),
  };
}

export function normalizeSystemMessages(request: AnthropicRequest): AnthropicRequest {
  const systemMessages = request.messages.filter((message) => message.role === 'system');
  if (!systemMessages.length) return request;
  const parts: string[] = [];
  if (request.system) {
    parts.push(
      typeof request.system === 'string'
        ? request.system
        : request.system.map((block) => block.text).join('\n'),
    );
  }
  for (const message of systemMessages) {
    parts.push(
      typeof message.content === 'string'
        ? message.content
        : message.content
            .flatMap((block) =>
              block.type === 'text' && typeof (block as Json).text === 'string'
                ? [(block as Json).text as string]
                : [],
            )
            .join('\n'),
    );
  }
  return {
    ...request,
    ...(parts.filter(Boolean).length ? { system: parts.filter(Boolean).join('\n\n') } : {}),
    messages: request.messages.filter((message) => message.role !== 'system'),
  };
}

function textContent(content: string | Array<Json>): string | Array<Json> {
  if (typeof content === 'string') return content;
  const result: Json[] = [];
  for (const block of content) {
    if (block.type === 'text') result.push({ type: 'text', text: block.text });
    if (block.type === 'image') {
      const source = block.source as Json;
      result.push({
        type: 'image_url',
        image_url: { url: `data:${source.media_type};base64,${source.data}` },
      });
    }
  }
  return result;
}

function anthropicHistoryToReasoningContent(content: Json[]): string | undefined {
  const parts = content.flatMap((block) =>
    block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking
      ? [block.thinking]
      : [],
  );
  return parts.length ? parts.join('\n\n') : undefined;
}

function toolResultContent(resultContent: unknown): string {
  if (typeof resultContent === 'string') return resultContent;
  if (!Array.isArray(resultContent)) return '';
  return resultContent
    .flatMap((item) => {
      const value = item as Json;
      return value.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
    })
    .join('\n');
}

export async function anthropicToOpenAI(
  request: AnthropicRequest,
  upstreamModel: string,
  capabilities?: ReasoningCapabilities,
  resolveProxySignature?: (signature: string) => Promise<{ data: string; format: string } | null>,
  reasoningWireFormat: ReasoningWireFormat = 'reasoning_details',
): Promise<Json> {
  const messages: Json[] = [];
  if (request.system)
    messages.push({
      role: 'system',
      content:
        typeof request.system === 'string'
          ? request.system
          : request.system.map((b) => b.text).join('\n'),
    });

  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      const regular = message.content.filter(
        (block) => block.type === 'text' || block.type === 'image',
      ) as unknown as Json[];
      const toolCalls = message.content.flatMap((block) => {
        if (
          block.type !== 'tool_use' ||
          typeof (block as Json).id !== 'string' ||
          typeof (block as Json).name !== 'string'
        )
          return [];
        const tool = block as Json;
        return [
          {
            id: tool.id,
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.input) },
          },
        ];
      });

      const historyReasoning =
        reasoningWireFormat === 'reasoning_content'
          ? anthropicHistoryToReasoningContent(message.content as unknown as Json[])
          : await anthropicHistoryToReasoningDetails(
              message.content as unknown as Json[],
              resolveProxySignature,
            );

      const assistantMessage: Json = {
        role: 'assistant',
        content: regular.length ? textContent(regular) : null,
      };
      if (toolCalls.length) assistantMessage.tool_calls = toolCalls;
      if (historyReasoning) {
        if (reasoningWireFormat === 'reasoning_content') {
          assistantMessage.reasoning_content = historyReasoning;
          logReasoningContent('reasoning.history.replayed', {
            wireFormat: 'reasoning_content',
            payloadBytes: utf8Bytes(historyReasoning),
            thinkingBlockCount: message.content.filter((block) => block.type === 'thinking').length,
            toolCallCount: toolCalls.length,
          });
        } else assistantMessage.reasoning_details = historyReasoning;
      }
      messages.push(assistantMessage);
      continue;
    }

    const regular = message.content.filter(
      (block) => block.type === 'text' || block.type === 'image',
    ) as unknown as Json[];
    if (regular.length) messages.push({ role: message.role, content: textContent(regular) });

    for (const block of message.content) {
      if (block.type !== 'tool_result' || typeof (block as Json).tool_use_id !== 'string')
        continue;
      const result = block as Json;
      messages.push({
        role: 'tool',
        tool_call_id: result.tool_use_id,
        content: toolResultContent(result.content),
      });
    }
  }

  const raw = request as Record<string, unknown>;
  const body: Json = {
    model: upstreamModel,
    messages,
    max_tokens: request.max_tokens,
    stream: request.stream,
  };
  if (raw.temperature !== undefined) body.temperature = raw.temperature;
  if (raw.top_p !== undefined) body.top_p = raw.top_p;
  if (raw.stop_sequences) body.stop = raw.stop_sequences;
  const tools = raw.tools as Array<Record<string, unknown>> | undefined;
  if (tools)
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  const toolChoice = raw.tool_choice as Record<string, unknown> | undefined;
  if (toolChoice)
    body.tool_choice =
      toolChoice.type === 'tool'
        ? { type: 'function', function: { name: toolChoice.name } }
        : toolChoice.type === 'any'
          ? 'required'
          : 'auto';

  if (capabilities) {
    const thinking = normalizeThinking(request.thinking, request.output_config);
    const reasoningConfig = buildReasoningConfig(thinking, capabilities, request);
    if (reasoningConfig) body.reasoning = reasoningConfig;
  }

  return body;
}

export async function openAIToAnthropic(
  response: Json,
  clientModel: string,
  context?: UpstreamContext,
  onEncryptedForeign?: (detail: { data: string; format?: string; id?: string }) => Promise<string>,
) {
  const choice = (response.choices as Json[] | undefined)?.[0] ?? {};
  const message = (choice.message as Json | undefined) ?? {};
  const content: Json[] = [];

  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    logReasoningContent('reasoning.response.detected', {
      wireFormat: 'reasoning_content',
      mode: 'non_streaming',
      payloadBytes: utf8Bytes(message.reasoning_content),
      toolCallCount: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
    });
    content.push({ type: 'thinking', thinking: message.reasoning_content });
  }

  const reasoningDetails = message.reasoning_details as unknown[] | undefined;
  if (reasoningDetails?.length) {
    const thinkingBlocks = await reasoningDetailsToAnthropicBlocks(
      reasoningDetails,
      context ?? {},
      onEncryptedForeign,
    );
    content.push(...thinkingBlocks);
  }

  if (typeof message.content === 'string' && message.content)
    content.push({ type: 'text', text: message.content });
  for (const call of (message.tool_calls as Json[] | undefined) ?? []) {
    const fn = call.function as Json;
    let input: unknown = {};
    try {
      input = JSON.parse(String(fn.arguments ?? '{}'));
    } catch {
      input = { _raw: fn.arguments };
    }
    content.push({ type: 'tool_use', id: call.id, name: fn.name, input });
  }
  const finish = choice.finish_reason as string | null | undefined;
  const hasToolCalls = Boolean((message.tool_calls as Json[] | undefined)?.length);
  const stopReason = mapFinishReason(finish, hasToolCalls) ?? 'end_turn';
  const usage = (response.usage as Json | undefined) ?? {};
  const details = usage.prompt_tokens_details as Json | undefined;
  return {
    id: response.id ?? `msg_${crypto.randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model: clientModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      cache_read_input_tokens: typeof details?.cached_tokens === 'number' ? details.cached_tokens : undefined,
    },
  };
}
