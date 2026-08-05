import type { ReasoningWireFormat, UpstreamContext } from './types.js';
import {
  anthropicHistoryToReasoningDetails,
  reasoningDetailsToAnthropicBlocks,
} from './reasoning.js';

type Json = Record<string, unknown>;

export type ReasoningTelemetry = {
  emit(event: string, details: Record<string, unknown>): void;
};

export const consoleReasoningTelemetry: ReasoningTelemetry = {
  emit(event, details) {
    console.warn(`[warn] ${event} ${JSON.stringify(details)}`);
  },
};

export type ReasoningCodecContext = {
  telemetry?: ReasoningTelemetry;
  attributes?: Record<string, unknown>;
  upstream?: UpstreamContext;
  resolveProxySignature?: (
    signature: string,
  ) => Promise<{ data: string; format: string } | null>;
  onEncryptedForeign?: (detail: {
    data: string;
    format?: string;
    id?: string;
  }) => Promise<string>;
};

export type EncodedReasoning = {
  field: 'reasoning' | 'reasoning_content' | 'reasoning_details';
  value: string | Json[];
};

export interface ReasoningCodec {
  readonly wireFormat: ReasoningWireFormat;
  encodeHistory(
    content: Json[],
    context?: ReasoningCodecContext,
  ): Promise<EncodedReasoning | undefined>;
  decodeResponse(
    message: Json,
    context?: ReasoningCodecContext,
  ): Promise<Json[]>;
}

function utf8Bytes(value: string | Json[]) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return new TextEncoder().encode(serialized).byteLength;
}

function thinkingText(content: Json[]) {
  const parts = content.flatMap((block) =>
    block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking
      ? [block.thinking]
      : [],
  );
  return parts.length ? parts.join('\n\n') : undefined;
}

function emit(
  context: ReasoningCodecContext | undefined,
  event: string,
  details: Record<string, unknown>,
) {
  context?.telemetry?.emit(event, {
    ...context.attributes,
    ...details,
  });
}

function createPlaintextReasoningCodec(
  wireFormat: 'reasoning' | 'reasoning_content',
): ReasoningCodec {
  return {
    wireFormat,

    async encodeHistory(content, context) {
      const value = thinkingText(content);
      if (!value) return undefined;

      emit(context, 'reasoning.history.replayed', {
        wireFormat: this.wireFormat,
        payloadBytes: utf8Bytes(value),
        thinkingBlockCount: content.filter((block) => block.type === 'thinking').length,
      });

      return { field: wireFormat, value };
    },

    async decodeResponse(message, context) {
      const value = message[wireFormat];
      if (typeof value !== 'string' || !value) return [];

      emit(context, 'reasoning.response.detected', {
        wireFormat: this.wireFormat,
        mode: 'non_streaming',
        payloadBytes: utf8Bytes(value),
        toolCallCount: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
      });

      return [{ type: 'thinking', thinking: value }];
    },
  };
}

export const reasoningCodec = createPlaintextReasoningCodec('reasoning');
export const reasoningContentCodec = createPlaintextReasoningCodec('reasoning_content');

export const reasoningDetailsCodec: ReasoningCodec = {
  wireFormat: 'reasoning_details',

  async encodeHistory(content, context) {
    const value = await anthropicHistoryToReasoningDetails(
      content,
      context?.resolveProxySignature,
    );
    if (!value?.length) return undefined;
    return { field: 'reasoning_details', value };
  },

  async decodeResponse(message, context) {
    const value = message.reasoning_details as unknown[] | undefined;
    if (!value?.length) return [];
    return reasoningDetailsToAnthropicBlocks(
      value,
      context?.upstream ?? {},
      context?.onEncryptedForeign,
    );
  },
};

const codecs: Record<ReasoningWireFormat, ReasoningCodec> = {
  reasoning: reasoningCodec,
  reasoning_content: reasoningContentCodec,
  reasoning_details: reasoningDetailsCodec,
};

export function getReasoningCodec(wireFormat: ReasoningWireFormat): ReasoningCodec {
  return codecs[wireFormat];
}

export async function decodeReasoningResponse(
  message: Json,
  context?: ReasoningCodecContext,
): Promise<Json[]> {
  const blocks: Json[] = [];
  for (const codec of [reasoningCodec, reasoningContentCodec, reasoningDetailsCodec]) {
    blocks.push(...(await codec.decodeResponse(message, context)));
  }
  return blocks;
}
