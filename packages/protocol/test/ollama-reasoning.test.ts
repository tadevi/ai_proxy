import { describe, expect, it, vi } from 'vitest';
import {
  anthropicRequestSchema,
  anthropicToOpenAI,
  openAIStreamToAnthropic,
  openAIToAnthropic,
  reasoningWireFormatForModel,
} from '../src/index.js';
import type { StreamUsage } from '../src/index.js';

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

async function* trailingUsageStream(usage: Record<string, unknown>) {
  yield JSON.stringify({
    choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
  });
  yield JSON.stringify({
    choices: [],
    usage,
  });
  yield '[DONE]';
}

describe('Ollama reasoning compatibility', () => {
  it('selects the reasoning codec for Ollama-prefixed and Cloud model ids', () => {
    expect(reasoningWireFormatForModel('Ollama/minimax-m3')).toBe('reasoning');
    expect(reasoningWireFormatForModel('ollama/gpt-oss:120b')).toBe('reasoning');
    expect(reasoningWireFormatForModel('minimax-m3')).toBe('reasoning');
    expect(reasoningWireFormatForModel('gpt-oss:120b')).toBe('reasoning');
    expect(reasoningWireFormatForModel('poolside/laguna-s-2.1', 'reasoning_content')).toBe(
      'reasoning_content',
    );
  });

  it('replays Anthropic thinking history through message.reasoning', async () => {
    const body = await anthropicToOpenAI(request, 'minimax-m3');
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

  it('keeps reasoning open, logs detection, and persists Ollama Cloud usage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
        choices: [],
        usage: { prompt_tokens: 181, completion_tokens: 35, total_tokens: 0 },
      });
      yield '[DONE]';
    }

    const usage: { inputTokens?: number; outputTokens?: number; reasoningDetails?: boolean } = {};
    let output = '';
    for await (const chunk of openAIStreamToAnthropic(
      source(),
      'Ollama/minimax-m3',
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reasoning.response.detected'));
    warn.mockRestore();
  });

  it('emits trailing usage without cache details as undefined cacheInputTokens', async () => {
    const usage: StreamUsage = {};
    for await (const chunk of openAIStreamToAnthropic(
      trailingUsageStream({
        prompt_tokens: 181,
        completion_tokens: 23,
        total_tokens: 204,
      }),
      'Ollama/minimax-m3',
      'msg_cache',
      usage,
    )) {
      void chunk;
    }

    expect(usage).toEqual({
      inputTokens: 181,
      outputTokens: 23,
    });
    expect(usage.cacheInputTokens).toBeUndefined();
  });

  it('maps explicit zero cached_tokens to cacheInputTokens 0', async () => {
    const usage: StreamUsage = {};
    for await (const chunk of openAIStreamToAnthropic(
      trailingUsageStream({
        prompt_tokens: 181,
        completion_tokens: 23,
        prompt_tokens_details: { cached_tokens: 0 },
      }),
      'Ollama/minimax-m3',
      'msg_zero',
      usage,
    )) {
      void chunk;
    }

    expect(usage.cacheInputTokens).toBe(0);
  });

  it('maps positive cached_tokens to cacheInputTokens', async () => {
    const usage: StreamUsage = {};
    for await (const chunk of openAIStreamToAnthropic(
      trailingUsageStream({
        prompt_tokens: 181,
        completion_tokens: 23,
        prompt_tokens_details: { cached_tokens: 120 },
      }),
      'Ollama/minimax-m3',
      'msg_pos',
      usage,
    )) {
      void chunk;
    }

    expect(usage.cacheInputTokens).toBe(120);
    expect(usage.inputTokens).toBe(181);
    expect(usage.outputTokens).toBe(23);
  });
});
