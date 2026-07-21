import type { AnthropicRequest, NormalizedThinking } from './types.js';

type Json = Record<string, unknown>;
export function normalizeThinking(raw: unknown): NormalizedThinking {
  if (!raw || typeof raw !== 'object') return { enabled: false };
  const v = raw as Json;
  if (v.type === 'disabled' || v.enabled === false) return { enabled: false };
  const effort = ['low', 'medium', 'high', 'xhigh'].includes(String(v.effort))
    ? (v.effort as NormalizedThinking['effort'])
    : undefined;
  const budgetTokens = typeof v.budget_tokens === 'number' ? v.budget_tokens : undefined;
  return {
    enabled: v.type === 'enabled' || v.enabled === true || Boolean(effort || budgetTokens),
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
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
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

export function anthropicToOpenAI(request: AnthropicRequest, upstreamModel: string): Json {
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
    const regular = message.content.filter(
      (b) => b.type === 'text' || b.type === 'image',
    ) as unknown as Json[];
    if (regular.length) messages.push({ role: message.role, content: textContent(regular) });
    for (const block of message.content) {
      if (block.type === 'tool_use')
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input) },
            },
          ],
        });
      if (block.type === 'tool_result')
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content:
            typeof block.content === 'string'
              ? block.content
              : block.content.map((b) => b.text).join('\n'),
        });
    }
  }
  const body: Json = {
    model: upstreamModel,
    messages,
    max_tokens: request.max_tokens,
    stream: request.stream,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.top_p !== undefined) body.top_p = request.top_p;
  if (request.stop_sequences) body.stop = request.stop_sequences;
  if (request.tools)
    body.tools = request.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  if (request.tool_choice)
    body.tool_choice =
      request.tool_choice.type === 'tool'
        ? { type: 'function', function: { name: request.tool_choice.name } }
        : request.tool_choice.type === 'any'
          ? 'required'
          : 'auto';
  return body;
}

export function openAIToAnthropic(response: Json, clientModel: string) {
  const choice = (response.choices as Json[] | undefined)?.[0] ?? {};
  const message = (choice.message as Json | undefined) ?? {};
  const content: Json[] = [];
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
  const finish = choice.finish_reason;
  const stopReason =
    finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn';
  const usage = (response.usage as Json | undefined) ?? {};
  return {
    id: response.id ?? `msg_${crypto.randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model: clientModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 },
  };
}
