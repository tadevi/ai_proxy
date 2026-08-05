import {
  openAIStreamToAnthropic as baseOpenAIStreamToAnthropic,
  parseSSE,
  type StreamUsage,
} from './sse.js';

type Json = Record<string, unknown>;

async function* normalizeOllamaReasoning(source: AsyncIterable<string>) {
  for await (const data of source) {
    if (data === '[DONE]') {
      yield data;
      continue;
    }

    let event: Json;
    try {
      event = JSON.parse(data) as Json;
    } catch {
      yield data;
      continue;
    }

    const choices = event.choices as Json[] | undefined;
    const choice = choices?.[0];
    const delta = choice?.delta as Json | undefined;
    if (
      delta &&
      typeof delta.reasoning === 'string' &&
      delta.reasoning &&
      delta.reasoning_content === undefined
    ) {
      yield JSON.stringify({
        ...event,
        choices: [
          {
            ...choice,
            delta: {
              ...delta,
              reasoning_content: delta.reasoning,
            },
          },
          ...(choices?.slice(1) ?? []),
        ],
      });
      continue;
    }

    yield data;
  }
}

export function openAIStreamToAnthropic(
  source: AsyncIterable<string>,
  model: string,
  id?: string,
  usage?: StreamUsage,
  onEncryptedForeign?: (detail: { data: string; format?: string; id?: string }) => Promise<string>,
) {
  return baseOpenAIStreamToAnthropic(
    normalizeOllamaReasoning(source),
    model,
    id,
    usage,
    onEncryptedForeign,
  );
}

export { parseSSE };
export type { StreamUsage };
