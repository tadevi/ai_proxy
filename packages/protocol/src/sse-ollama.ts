import {
  openAIStreamToAnthropic as baseOpenAIStreamToAnthropic,
  parseSSE,
  type StreamUsage,
} from './sse.js';

type Json = Record<string, unknown>;

function normalizedEvent(event: Json) {
  const choices = event.choices as Json[] | undefined;
  const choice = choices?.[0];
  const delta = choice?.delta as Json | undefined;
  if (!choice || !delta) return event;

  const normalizedDelta: Json = { ...delta };
  if (normalizedDelta.content === '') delete normalizedDelta.content;
  if (
    typeof normalizedDelta.reasoning === 'string' &&
    normalizedDelta.reasoning &&
    normalizedDelta.reasoning_content === undefined
  ) {
    normalizedDelta.reasoning_content = normalizedDelta.reasoning;
  }

  return {
    ...event,
    choices: [
      {
        ...choice,
        delta: normalizedDelta,
      },
      ...(choices?.slice(1) ?? []),
    ],
  };
}

async function* normalizeOllamaReasoning(source: AsyncIterable<string>) {
  let pendingFinish: Json | undefined;

  for await (const data of source) {
    if (data === '[DONE]') {
      if (pendingFinish) yield JSON.stringify(pendingFinish);
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
    if (choice?.finish_reason && event.usage === undefined) {
      pendingFinish = normalizedEvent(event);
      continue;
    }

    if (!choice && event.usage && pendingFinish) {
      yield JSON.stringify({ ...pendingFinish, usage: event.usage });
      pendingFinish = undefined;
      continue;
    }

    yield JSON.stringify(normalizedEvent(event));
  }

  if (pendingFinish) yield JSON.stringify(pendingFinish);
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
