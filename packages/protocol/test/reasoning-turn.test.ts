import { describe, expect, it } from 'vitest';
import { anthropicToOpenAI } from '../src/index.js';
import type { ReasoningCapabilities } from '../src/index.js';

const capabilities: ReasoningCapabilities = {
  supportsReasoning: true,
  supportsReasoningBudget: true,
  supportsReasoningEffort: true,
  supportsAdaptiveReasoning: true,
};

describe('Anthropic assistant turn mapping', () => {
  it('keeps text, reasoning, and multiple tool calls in one assistant message', async () => {
    const body = await anthropicToOpenAI(
      {
        model: 'sonnet',
        max_tokens: 1024,
        stream: false,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'I need to inspect both files.',
                signature: 'sig_native',
              },
              { type: 'text', text: 'I will inspect the relevant files.' },
              { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: 'a.ts' } },
              { type: 'tool_use', id: 'tool_2', name: 'Read', input: { path: 'b.ts' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool_1', content: 'a' },
              { type: 'tool_result', tool_use_id: 'tool_2', content: 'b' },
            ],
          },
        ],
      },
      'openai/test',
      capabilities,
    );

    const messages = body.messages as Array<Record<string, unknown>>;
    const assistantMessages = messages.filter((message) => message.role === 'assistant');

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'I will inspect the relevant files.' }],
      reasoning_details: [
        {
          type: 'reasoning.text',
          text: 'I need to inspect both files.',
          signature: 'sig_native',
        },
      ],
      tool_calls: [
        {
          id: 'tool_1',
          type: 'function',
          function: { name: 'Read', arguments: '{"path":"a.ts"}' },
        },
        {
          id: 'tool_2',
          type: 'function',
          function: { name: 'Read', arguments: '{"path":"b.ts"}' },
        },
      ],
    });

    expect(messages.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'tool_1', content: 'a' },
      { role: 'tool', tool_call_id: 'tool_2', content: 'b' },
    ]);
  });
});
