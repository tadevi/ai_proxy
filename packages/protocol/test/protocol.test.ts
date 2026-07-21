import { describe, expect, it } from 'vitest';
import {
  anthropicRequestSchema,
  anthropicToOpenAI,
  applyRules,
  eligibleRoutes,
  isFallbackableStatus,
  normalizeThinking,
  normalizeSystemMessages,
  openAIStreamToAnthropic,
  openAIToAnthropic,
} from '../src/index.js';

const request = anthropicRequestSchema.parse({
  model: 'sonnet',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hello' }],
});

describe('protocol conversion', () => {
  it('moves system-role messages into the Anthropic system field', () => {
    const normalized = normalizeSystemMessages({
      ...request,
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ],
    });
    expect(normalized.system).toBe('Be concise.');
    expect(normalized.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('accepts thinking blocks returned in a prior assistant turn', () => {
    const parsed = anthropicRequestSchema.parse({
      model: 'sonnet',
      max_tokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'I should add two numbers.', signature: '' }],
        },
        { role: 'user', content: 'Continue.' },
      ],
    });
    expect(parsed.messages[0]?.content).toEqual([
      { type: 'thinking', thinking: 'I should add two numbers.', signature: '' },
    ]);
  });

  it('converts Anthropic text, limits, and tools to OpenAI', () => {
    const body = anthropicToOpenAI(
      { ...request, tools: [{ name: 'weather', input_schema: { type: 'object' } }] },
      'gpt-test',
    );
    expect(body).toMatchObject({ model: 'gpt-test', max_tokens: 100 });
    expect(body.tools).toHaveLength(1);
  });

  it('converts OpenAI text and usage to Anthropic', () => {
    const body = openAIToAnthropic(
      {
        id: 'chat-1',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      },
      'sonnet',
    );
    expect(body).toMatchObject({
      model: 'sonnet',
      stop_reason: 'end_turn',
      usage: { input_tokens: 2 },
    });
  });

  it('converts tool calls and parses arguments', () => {
    const body = openAIToAnthropic(
      {
        choices: [
          {
            message: { tool_calls: [{ id: 't1', function: { name: 'x', arguments: '{"a":1}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'opus',
    );
    expect(body.content[0]).toMatchObject({ type: 'tool_use', input: { a: 1 } });
  });
});

describe('thinking and declarative rules', () => {
  it('normalizes effort and token budget', () => {
    expect(normalizeThinking({ type: 'enabled', effort: 'high', budget_tokens: 2000 })).toEqual({
      enabled: true,
      effort: 'high',
      budgetTokens: 2000,
    });
  });

  it('maps thinking effort', () => {
    const output = applyRules(
      {},
      [
        {
          type: 'thinking_effort',
          enabled: true,
          position: 0,
          config: { destination: 'reasoning_effort', mapping: { high: 'max' } },
        },
      ],
      { enabled: true, effort: 'high' },
    );
    expect(output.reasoning_effort).toBe('max');
  });

  it('executes ordered set, rename, cap, and remove rules', () => {
    const output = applyRules(
      {},
      [
        { type: 'set_field', enabled: true, position: 0, config: { field: 'tokens', value: 20 } },
        { type: 'cap_number', enabled: true, position: 1, config: { field: 'tokens', max: 10 } },
        {
          type: 'rename_field',
          enabled: true,
          position: 2,
          config: { from: 'tokens', to: 'max_tokens' },
        },
        { type: 'remove_field', enabled: true, position: 3, config: { field: 'unused' } },
      ],
      { enabled: false },
    );
    expect(output).toEqual({ max_tokens: 10 });
  });
});

describe('routing and streaming', () => {
  it('orders eligible routes and skips incompatible routes', () => {
    const result = eligibleRoutes(
      [
        { id: 'b', enabled: true, position: 2, supportsImages: 'unknown', supportsTools: 'yes' },
        { id: 'a', enabled: true, position: 1, supportsImages: 'no', supportsTools: 'yes' },
      ],
      true,
      false,
    );
    expect(result.eligible.map((r) => r.id)).toEqual(['b']);
    expect(result.skipped[0]?.reason).toBe('images_unsupported');
  });

  it('classifies only safe status codes for fallback', () => {
    expect(isFallbackableStatus(429)).toBe(true);
    expect(isFallbackableStatus(401)).toBe(false);
    expect(isFallbackableStatus(400)).toBe(false);
  });

  it('converts text SSE without buffering', async () => {
    async function* source() {
      yield JSON.stringify({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] });
      yield JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      yield '[DONE]';
    }
    const output: string[] = [];
    for await (const chunk of openAIStreamToAnthropic(source(), 'sonnet', 'msg_1'))
      output.push(chunk);
    expect(output.join('')).toContain('text_delta');
    expect(output.join('')).toContain('message_stop');
  });

  it('captures OpenAI streaming usage from the final usage chunk', async () => {
    async function* source() {
      yield JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      });
      yield '[DONE]';
    }
    const usage: { inputTokens?: number; outputTokens?: number } = {};
    for await (const chunk of openAIStreamToAnthropic(source(), 'sonnet', 'msg_1', usage)) {
      void chunk;
    }
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 3 });
  });

  it('streams incremental tool arguments', async () => {
    async function* source() {
      yield JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 't1', function: { name: 'run', arguments: '{"x"' } }],
            },
          },
        ],
      });
      yield JSON.stringify({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      });
    }
    let output = '';
    for await (const chunk of openAIStreamToAnthropic(source(), 'sonnet')) output += chunk;
    expect(output).toContain('input_json_delta');
    expect(output).toContain(':1}');
  });
});
