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

  it('streams delta.reasoning as Anthropic thinking deltas and keeps final usage', async () => {
    async function* source() {
      yield JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '', reasoning: ' Just' },
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
        choices: [],
        usage: { prompt_tokens: 71, completion_tokens: 37, total_tokens: 108 },
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

    expect(output).toContain('thinking_delta');
    expect(output).toContain(' Just');
    expect(output).toContain('text_delta');
    expect(output).toContain('OK');
    expect(usage).toEqual({
      inputTokens: 71,
      outputTokens: 37,
      reasoningDetails: true,
    });
  });
});
