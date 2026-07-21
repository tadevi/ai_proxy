type Json = Record<string, unknown>;
export type StreamUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

function recordOpenAIUsage(event: Json, usage?: StreamUsage) {
  if (!usage) return;
  const upstreamUsage = event.usage as Json | undefined;
  if (typeof upstreamUsage?.prompt_tokens === 'number')
    usage.inputTokens = upstreamUsage.prompt_tokens;
  if (typeof upstreamUsage?.completion_tokens === 'number')
    usage.outputTokens = upstreamUsage.completion_tokens;
}

const encode = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export async function* openAIStreamToAnthropic(
  source: AsyncIterable<string>,
  model: string,
  id = `msg_${crypto.randomUUID().replaceAll('-', '')}`,
  usage?: StreamUsage,
) {
  yield encode('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  let textStarted = false;
  let nextIndex = 0;
  const toolIndexes = new Map<number, number>();
  for await (const data of source) {
    if (data === '[DONE]') break;
    let event: Json;
    try {
      event = JSON.parse(data) as Json;
    } catch {
      continue;
    }
    recordOpenAIUsage(event, usage);
    const choice = (event.choices as Json[] | undefined)?.[0];
    if (!choice) continue;
    const delta = (choice.delta as Json | undefined) ?? {};
    if (typeof delta.content === 'string') {
      if (!textStarted) {
        textStarted = true;
        yield encode('content_block_start', {
          type: 'content_block_start',
          index: nextIndex,
          content_block: { type: 'text', text: '' },
        });
      }
      yield encode('content_block_delta', {
        type: 'content_block_delta',
        index: nextIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }
    for (const call of (delta.tool_calls as Json[] | undefined) ?? []) {
      const sourceIndex = Number(call.index ?? 0);
      let index = toolIndexes.get(sourceIndex);
      if (index === undefined) {
        if (textStarted) {
          yield encode('content_block_stop', { type: 'content_block_stop', index: nextIndex });
          textStarted = false;
          nextIndex++;
        }
        index = nextIndex++;
        toolIndexes.set(sourceIndex, index);
        const fn = (call.function as Json | undefined) ?? {};
        yield encode('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: call.id, name: fn.name, input: {} },
        });
      }
      const args = (call.function as Json | undefined)?.arguments;
      if (typeof args === 'string')
        yield encode('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: args },
        });
    }
    if (choice.finish_reason) {
      if (textStarted)
        yield encode('content_block_stop', { type: 'content_block_stop', index: nextIndex });
      for (const index of toolIndexes.values())
        yield encode('content_block_stop', { type: 'content_block_stop', index });
      const reason =
        choice.finish_reason === 'tool_calls'
          ? 'tool_use'
          : choice.finish_reason === 'length'
            ? 'max_tokens'
            : 'end_turn';
      yield encode('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: reason, stop_sequence: null },
        usage: { output_tokens: (event.usage as Json | undefined)?.completion_tokens ?? 0 },
      });
    }
  }
  yield encode('message_stop', { type: 'message_stop' });
}

export async function* parseSSE(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() ?? '';
      for (const record of records)
        for (const line of record.split(/\r?\n/))
          if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  } finally {
    reader.releaseLock();
  }
}
