type Json = Record<string, unknown>;
export type StreamUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheInputTokens?: number;
  reasoningDetails?: boolean;
};

type ReasoningBlockState = {
  anthropicIndex: number;
  started: boolean;
  stopped: boolean;
  signature?: string;
  encryptedBuffer?: string;
  encryptedFormat?: string;
};

type StreamState = {
  nextAnthropicBlockIndex: number;
  reasoningBlocks: Map<string, ReasoningBlockState>;
  toolCallBlocks: Map<number, number>;
  textBlockIndex?: number;
  textStarted: boolean;
};

function recordOpenAIUsage(event: Json, usage?: StreamUsage) {
  if (!usage) return;
  const upstreamUsage = event.usage as Json | undefined;
  if (typeof upstreamUsage?.prompt_tokens === 'number')
    usage.inputTokens = upstreamUsage.prompt_tokens;
  if (typeof upstreamUsage?.completion_tokens === 'number')
    usage.outputTokens = upstreamUsage.completion_tokens;
  const details = upstreamUsage?.prompt_tokens_details as Json | undefined;
  if (typeof details?.cached_tokens === 'number')
    usage.cacheInputTokens = details.cached_tokens;
}

const encode = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export async function* openAIStreamToAnthropic(
  source: AsyncIterable<string>,
  model: string,
  id = `msg_${crypto.randomUUID().replaceAll('-', '')}`,
  usage?: StreamUsage,
  onEncryptedForeign?: (detail: { data: string; format?: string; id?: string }) => Promise<string>,
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

  const state: StreamState = {
    nextAnthropicBlockIndex: 0,
    reasoningBlocks: new Map(),
    toolCallBlocks: new Map(),
    textStarted: false,
  };

  const finalizeReasoningBlock = async (rb: ReasoningBlockState): Promise<string[]> => {
    const events: string[] = [];
    if (rb.stopped) return events;

    // Foreign encrypted details never become visible thinking text. Persist their
    // opaque payload and emit a proxy signature handle for a later history turn.
    if (rb.encryptedBuffer && onEncryptedForeign) {
      const signature = await onEncryptedForeign({
        data: rb.encryptedBuffer,
        format: rb.encryptedFormat,
      });
      events.push(encode('content_block_start', {
        type: 'content_block_start',
        index: rb.anthropicIndex,
        content_block: { type: 'thinking', thinking: '' },
      }));
      events.push(encode('content_block_delta', {
        type: 'content_block_delta',
        index: rb.anthropicIndex,
        delta: { type: 'signature_delta', signature },
      }));
      events.push(encode('content_block_stop', {
        type: 'content_block_stop',
        index: rb.anthropicIndex,
      }));
      rb.stopped = true;
      return events;
    }

    if (!rb.started) return events;
    if (rb.signature) {
      events.push(encode('content_block_delta', {
        type: 'content_block_delta',
        index: rb.anthropicIndex,
        delta: { type: 'signature_delta', signature: rb.signature },
      }));
    }
    events.push(encode('content_block_stop', {
      type: 'content_block_stop',
      index: rb.anthropicIndex,
    }));
    rb.stopped = true;
    return events;
  };

  const closeActiveBlocks = async (): Promise<string[]> => {
    const events: string[] = [];
    if (state.textStarted && state.textBlockIndex != null) {
      events.push(encode('content_block_stop', {
        type: 'content_block_stop',
        index: state.textBlockIndex,
      }));
      state.textStarted = false;
    }
    for (const rb of state.reasoningBlocks.values()) {
      events.push(...(await finalizeReasoningBlock(rb)));
    }
    for (const index of state.toolCallBlocks.values()) {
      events.push(encode('content_block_stop', { type: 'content_block_stop', index }));
    }
    return events;
  };

  const allocIndex = () => state.nextAnthropicBlockIndex++;

  const getOrCreateReasoningBlock = (detailId: string): ReasoningBlockState => {
    let rb = state.reasoningBlocks.get(detailId);
    if (!rb) {
      rb = { anthropicIndex: allocIndex(), started: false, stopped: false };
      state.reasoningBlocks.set(detailId, rb);
    }
    return rb;
  };

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

    // ── Reasoning deltas ──
    const reasoningParts = delta.reasoning_details as Json[] | undefined;
    if (reasoningParts?.length) {
      if (usage) usage.reasoningDetails = true;
      for (const part of reasoningParts) {
        const partType = typeof part.type === 'string' ? part.type : '';
        const partId =
          typeof part.id === 'string'
            ? part.id
            : `reasoning:${typeof part.index === 'number' ? part.index : 0}`;

        if (partType === 'reasoning.text') {
          const rb = getOrCreateReasoningBlock(partId);
          if (!rb.started) {
            // Close text block if open before starting reasoning
            if (state.textStarted && state.textBlockIndex != null) {
              yield encode('content_block_stop', {
                type: 'content_block_stop',
                index: state.textBlockIndex,
              });
              state.textStarted = false;
            }
            yield encode('content_block_start', {
              type: 'content_block_start',
              index: rb.anthropicIndex,
              content_block: { type: 'thinking', thinking: '' },
            });
            rb.started = true;
          }
          if (typeof part.text === 'string' && part.text) {
            yield encode('content_block_delta', {
              type: 'content_block_delta',
              index: rb.anthropicIndex,
              delta: { type: 'thinking_delta', thinking: part.text },
            });
          }
          if (typeof part.signature === 'string' && part.signature) {
            rb.signature = part.signature;
          }
        } else if (partType === 'reasoning.summary') {
          const rb = getOrCreateReasoningBlock(partId);
          if (!rb.started) {
            if (state.textStarted && state.textBlockIndex != null) {
              yield encode('content_block_stop', {
                type: 'content_block_stop',
                index: state.textBlockIndex,
              });
              state.textStarted = false;
            }
            yield encode('content_block_start', {
              type: 'content_block_start',
              index: rb.anthropicIndex,
              content_block: { type: 'thinking', thinking: '' },
            });
            rb.started = true;
          }
          if (typeof part.summary === 'string' && part.summary) {
            yield encode('content_block_delta', {
              type: 'content_block_delta',
              index: rb.anthropicIndex,
              delta: { type: 'thinking_delta', thinking: part.summary },
            });
          }
        } else if (partType === 'reasoning.encrypted') {
          // Buffer encrypted data; don't emit as thinking_delta
          const rb = getOrCreateReasoningBlock(partId);
          if (typeof part.data === 'string') {
            rb.encryptedBuffer = (rb.encryptedBuffer ?? '') + part.data;
            if (typeof part.format === 'string') rb.encryptedFormat = part.format;
          }
        }
      }
    }

    // Close finished reasoning blocks (when content delta arrives after reasoning)
    if (typeof delta.content === 'string' || delta.tool_calls) {
      for (const rb of state.reasoningBlocks.values()) {
        for (const event of await finalizeReasoningBlock(rb)) yield event;
      }
    }

    // ── Text content deltas ──
    if (typeof delta.content === 'string') {
      if (!state.textStarted) {
        state.textBlockIndex = allocIndex();
        state.textStarted = true;
        yield encode('content_block_start', {
          type: 'content_block_start',
          index: state.textBlockIndex,
          content_block: { type: 'text', text: '' },
        });
      }
      yield encode('content_block_delta', {
        type: 'content_block_delta',
        index: state.textBlockIndex!,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    // ── Tool call deltas ──
    for (const call of (delta.tool_calls as Json[] | undefined) ?? []) {
      const sourceIndex = Number(call.index ?? 0);
      let index = state.toolCallBlocks.get(sourceIndex);
      if (index === undefined) {
        // Close text block if open
        if (state.textStarted && state.textBlockIndex != null) {
          yield encode('content_block_stop', {
            type: 'content_block_stop',
            index: state.textBlockIndex,
          });
          state.textStarted = false;
        }
        index = allocIndex();
        state.toolCallBlocks.set(sourceIndex, index);
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

    // ── Finish ──
    if (choice.finish_reason) {
      for (const event of await closeActiveBlocks()) yield event;
      const hasToolCalls = state.toolCallBlocks.size > 0;
      const reason = mapStreamFinishReason(
        typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        hasToolCalls,
      );
      yield encode('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: reason, stop_sequence: null },
        usage: { output_tokens: (event.usage as Json | undefined)?.completion_tokens ?? 0 },
      });
    }
  }
  yield encode('message_stop', { type: 'message_stop' });
}

function mapStreamFinishReason(reason: string | null, hasToolCalls: boolean): string {
  if (hasToolCalls || reason === 'tool_calls') return 'tool_use';
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
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
