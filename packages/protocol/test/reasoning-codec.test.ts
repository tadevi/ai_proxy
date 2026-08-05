import { describe, expect, it, vi } from 'vitest';
import {
  decodeReasoningResponse,
  getReasoningCodec,
  reasoningContentCodec,
  reasoningDetailsCodec,
} from '../src/index.js';

describe('reasoning codecs', () => {
  it('encodes Poolside history as reasoning_content and emits telemetry', async () => {
    const emit = vi.fn();
    const encoded = await reasoningContentCodec.encodeHistory(
      [
        { type: 'thinking', thinking: 'first' },
        { type: 'text', text: 'visible' },
        { type: 'thinking', thinking: 'second' },
      ],
      {
        telemetry: { emit },
        attributes: { toolCallCount: 2 },
      },
    );

    expect(encoded).toEqual({
      field: 'reasoning_content',
      value: 'first\n\nsecond',
    });
    expect(emit).toHaveBeenCalledWith(
      'reasoning.history.replayed',
      expect.objectContaining({
        wireFormat: 'reasoning_content',
        thinkingBlockCount: 2,
        toolCallCount: 2,
      }),
    );
  });

  it('encodes default history as reasoning_details', async () => {
    const encoded = await reasoningDetailsCodec.encodeHistory([
      { type: 'thinking', thinking: 'plan', signature: 'sig' },
    ]);

    expect(encoded).toEqual({
      field: 'reasoning_details',
      value: [
        {
          type: 'reasoning.text',
          text: 'plan',
          signature: 'sig',
        },
      ],
    });
  });

  it('decodes all supported non-streaming response fields', async () => {
    await expect(
      decodeReasoningResponse({
        reasoning_content: 'poolside plan',
        reasoning_details: [{ type: 'reasoning.summary', summary: 'summary' }],
      }),
    ).resolves.toEqual([
      { type: 'thinking', thinking: 'poolside plan' },
      { type: 'thinking', thinking: 'summary' },
    ]);
  });

  it('resolves codecs by wire format', () => {
    expect(getReasoningCodec('reasoning_content')).toBe(reasoningContentCodec);
    expect(getReasoningCodec('reasoning_details')).toBe(reasoningDetailsCodec);
  });
});
