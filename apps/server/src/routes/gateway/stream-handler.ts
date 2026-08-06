import type { StreamUsage } from '@gateway/protocol';

export async function* managedStream(
  source: AsyncIterable<string | Uint8Array>,
  resetTimeout: () => void,
  cleanup: () => void,
) {
  try {
    for await (const chunk of source) {
      resetTimeout();
      yield chunk;
    }
  } finally {
    cleanup();
  }
}

export async function* rawStream(body: ReadableStream<Uint8Array>, usage: StreamUsage) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readUsage = (payload: string) => {
    try {
      const event = JSON.parse(payload) as Record<string, unknown>;
      const message = event.message as Record<string, unknown> | undefined;
      const eventUsage = (message?.usage ?? event.usage) as Record<string, unknown> | undefined;
      if (typeof eventUsage?.input_tokens === 'number') usage.inputTokens = eventUsage.input_tokens;
      if (typeof eventUsage?.output_tokens === 'number')
        usage.outputTokens = eventUsage.output_tokens;
      if (typeof eventUsage?.cache_creation_input_tokens === 'number')
        usage.cacheInputTokens =
          (usage.cacheInputTokens ?? 0) + eventUsage.cache_creation_input_tokens;
      if (typeof eventUsage?.cache_read_input_tokens === 'number')
        usage.cacheInputTokens = (usage.cacheInputTokens ?? 0) + eventUsage.cache_read_input_tokens;
    } catch {
      // Preserve malformed or non-JSON SSE data for the client without logging usage.
    }
  };
  const consume = (text: string) => {
    buffer += text;
    const records = buffer.split(/\r?\n\r?\n/);
    buffer = records.pop() ?? '';
    for (const record of records)
      for (const line of record.split(/\r?\n/))
        if (line.startsWith('data:')) readUsage(line.slice(5).trim());
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
      yield value;
    }
    consume(decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
