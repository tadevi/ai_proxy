import { describe, expect, it } from 'vitest';
import {
  anthropicRequestSchema,
  anthropicToOpenAI,
  openAIToAnthropic,
  type ReasoningWireFormat,
} from '../src/index.js';

type Json = Record<string, unknown>;

const formats: ReasoningWireFormat[] = [
  'reasoning',
  'reasoning_content',
  'reasoning_details',
];

function reasoningValue(format: ReasoningWireFormat, text: string): string | Json[] {
  return format === 'reasoning_details' ? [{ type: 'reasoning.text', text }] : text;
}

function fakeUpstreamResponse(
  format: ReasoningWireFormat,
  text: string,
  toolCallId: string,
): Json {
  return {
    id: `response-${toolCallId}`,
    choices: [
      {
        message: {
          [format]: reasoningValue(format, text),
          tool_calls: [
            {
              id: toolCallId,
              type: 'function',
              function: { name: 'lookup', arguments: JSON.stringify({ query: toolCallId }) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function assistantMessages(body: Json): Json[] {
  return ((body.messages as Json[] | undefined) ?? []).filter(
    (message) => message.role === 'assistant',
  );
}

function toolMessages(body: Json): Json[] {
  return ((body.messages as Json[] | undefined) ?? []).filter((message) => message.role === 'tool');
}

describe.each(formats)('reasoning tool loop integration: %s', (format) => {
  it('replays one then two reasoning turns with matching tool results', async () => {
    const request1 = anthropicRequestSchema.parse({
      model: 'client-model',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Start the task.' }],
    });

    const upstreamRequest1 = await anthropicToOpenAI(
      request1,
      'upstream-model',
      undefined,
      undefined,
      format,
    );
    expect(assistantMessages(upstreamRequest1)).toHaveLength(0);

    const assistantTurn1 = await openAIToAnthropic(
      fakeUpstreamResponse(format, 'think-one', 'tool-1'),
      'client-model',
    );
    expect(assistantTurn1.stop_reason).toBe('tool_use');
    expect(assistantTurn1.content).toEqual([
      { type: 'thinking', thinking: 'think-one' },
      { type: 'tool_use', id: 'tool-1', name: 'lookup', input: { query: 'tool-1' } },
    ]);

    // Anthropic clients may replay plaintext thinking with an empty signature.
    // The adapter must preserve the reasoning text without treating the empty value as a state handle.
    const turn1WithEmptySignature = assistantTurn1.content.map((block) =>
      block.type === 'thinking' ? { ...block, signature: '' } : block,
    );

    const request2 = anthropicRequestSchema.parse({
      model: 'client-model',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'Start the task.' },
        { role: 'assistant', content: turn1WithEmptySignature },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result-one' }],
        },
      ],
    });

    const upstreamRequest2 = await anthropicToOpenAI(
      request2,
      'upstream-model',
      undefined,
      undefined,
      format,
    );
    expect(assistantMessages(upstreamRequest2)).toHaveLength(1);
    expect(assistantMessages(upstreamRequest2)[0]?.[format]).toEqual(
      reasoningValue(format, 'think-one'),
    );
    expect(toolMessages(upstreamRequest2)).toEqual([
      { role: 'tool', tool_call_id: 'tool-1', content: 'result-one' },
    ]);

    const assistantTurn2 = await openAIToAnthropic(
      fakeUpstreamResponse(format, 'think-two', 'tool-2'),
      'client-model',
    );
    expect(assistantTurn2.content).toEqual([
      { type: 'thinking', thinking: 'think-two' },
      { type: 'tool_use', id: 'tool-2', name: 'lookup', input: { query: 'tool-2' } },
    ]);

    const request3 = anthropicRequestSchema.parse({
      model: 'client-model',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'Start the task.' },
        { role: 'assistant', content: turn1WithEmptySignature },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result-one' }],
        },
        { role: 'assistant', content: assistantTurn2.content },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'result-two' }],
        },
      ],
    });

    const upstreamRequest3 = await anthropicToOpenAI(
      request3,
      'upstream-model',
      undefined,
      undefined,
      format,
    );
    const assistants = assistantMessages(upstreamRequest3);
    expect(assistants).toHaveLength(2);
    expect(assistants.map((message) => message[format])).toEqual([
      reasoningValue(format, 'think-one'),
      reasoningValue(format, 'think-two'),
    ]);
    expect(toolMessages(upstreamRequest3)).toEqual([
      { role: 'tool', tool_call_id: 'tool-1', content: 'result-one' },
      { role: 'tool', tool_call_id: 'tool-2', content: 'result-two' },
    ]);
  });
});
