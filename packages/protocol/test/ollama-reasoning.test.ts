import { describe, expect, it } from 'vitest';
import {
  anthropicRequestSchema,
  anthropicToOpenAI,
  openAIStreamToAnthropic,
  openAIToAnthropic,
  reasoningWireFormatForModel,
} from '../src/index.js';

const request = anthropicRequestSchema.parse({
  model: 'claude-code',
  max_tokens: 100,
  messages: [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'check the result' },
        { type: 'text', text: 'OK' },
      ],
    },
    { role: 'user', content: 'Continue.' },
  ],
});

describe('Ollama reasoning compatibility', () => {
  it('selects the reasoning codec for Ollama-prefixed models', () => {
    expect(reasoningWireFormatForModel('Ollama/minimax-m3')).toBe('reasoning');
    expect(reasoningWireFormatForModel('ollama/gpt-oss:120b')).toBe('reasoning');
    expect(reasoningWireFormatForModel('poolside/laguna-s-2.1', 'reasoning_content')).toBe(
      'reasoning_content',
    );
  });

  it('replays Anthropic thinking history through message.reasoning', async () => {
    const body = await anthropicToOpenAI(request, 'Ollama/minimax-m3');
    const assistant = (body.messages as Array<Record<string, unknown>>).find(
      (message) => message.role === 'assistant',
    );

    expect(assistant).toMatchObject({
      reasoning: 'check the result',
      content: [{ type: 'text', text: 'OK' }],
    });
    expect(assistant).not.toHaveProperty('reasoning_details');
  });

  it('decodes non-streaming message.reasoning before visible content', async () => {
    const body = await openAIToAnthropic(
      {
        id: 'chatcmpl-216',
        choices: [
          {
            message: {
              role: 'assistant',
              reasoning: 'Only output OK.',
              content: 'OK',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 71, completion_tokens: 51, total_tokens: 122 },
      },
      'Ollama/gpt-oss:120b',
    );

    expect(body.content).toEqual([
      { type: 'thinking', thinking: 'Only output OK.' },
      { type: 'text', text: 'OK' },
    ]);
  });

  it('keeps reasoning open across empty content deltas and emits final usage', async () => {
    async function* source() {
      yield JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '', reasoning: 'The user is asking me' },
            finish_reason: null,
          },
        ],
      });
      yield JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '', reasoning: ' to reply exactly.' },
            finish_reason: null,
          },
        ],
      });
      yield JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'OK' },
            finish_reason: null,
          },
        ],
      });
      yield JSON.stringify({
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
      });
      yield JSON.stringify({
        id: 'chatcmpl-381',
        object: 'chat.completion.chunk',
        model: 'minimax-m3',
        choices: [],
        usage: { prompt_tokens: 181, completion_tokens: 35, total_tokens: 0 },
      });
      yield '[DONE]';
    }

    const usage: { inputTokens?: number; outputTokens?: number; reasoningDetails?: boolean } = {};
    let output = '';
    for await (const chunk of openAIStreamToAnthropic(
      source(),
      'Ollama/gpt-oss:120b',
      'msg_ollama',
      usage,
    )) {
      output += chunk;
    }

    const firstThinking = output.indexOf('The user is asking me');
    const secondThinking = output.indexOf(' to reply exactly.');
    const reasoningStop = output.indexOf('content_block_stop', secondThinking);
    const textStart = output.indexOf('"type":"text"');

    expect(firstThinking).toBeGreaterThan(-1);
    expect(secondThinking).toBeGreaterThan(firstThinking);
    expect(reasoningStop).toBeGreaterThan(secondThinking);
    expect(textStart).toBeGreaterThan(reasoningStop);
    expect(output).toContain('"output_tokens":35');
    expect(usage).toEqual({
      inputTokens: 181,
      outputTokens: 35,
      reasoningDetails: true,
    });
  });
});
