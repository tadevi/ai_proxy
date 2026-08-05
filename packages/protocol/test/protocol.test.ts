import { describe, expect, it } from 'vitest';
import {
  anthropicRequestSchema,
  anthropicToOpenAI,
  applyRules,
  buildReasoningConfig,
  isFallbackableStatus,
  mapFinishReason,
  normalizeThinking,
  normalizeSystemMessages,
  openAIStreamToAnthropic,
  openAIToAnthropic,
  reasoningDetailsToAnthropicBlocks,
} from '../src/index.js';
import type { ReasoningCapabilities } from '../src/index.js';

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

  it('preserves unfamiliar content blocks for Anthropic-compatible upstreams', () => {
    const block = {
      type: 'server_tool_use',
      id: 'srv_1',
      name: 'web_search',
      input: { query: 'Figma design' },
      caller_supplied_field: true,
    };
    const parsed = anthropicRequestSchema.parse({
      model: 'sonnet',
      max_tokens: 100,
      messages: [{ role: 'assistant', content: [block] }],
    });
    expect(parsed.messages[0]?.content).toEqual([block]);
  });

  it('converts Anthropic text, limits, and tools to OpenAI', async () => {
    const body = await anthropicToOpenAI(
      { ...request, tools: [{ name: 'weather', input_schema: { type: 'object' } }] },
      'gpt-test',
    );
    expect(body).toMatchObject({ model: 'gpt-test', max_tokens: 100 });
    expect(body.tools).toHaveLength(1);
  });

  it('converts OpenAI text and usage to Anthropic', async () => {
    const body = await openAIToAnthropic(
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

  it('converts Poolside reasoning_content before visible text', async () => {
    const body = await openAIToAnthropic(
      {
        choices: [
          {
            message: { reasoning_content: 'private calculation', content: '391' },
            finish_reason: 'stop',
          },
        ],
      },
      'sonnet',
    );
    expect(body.content).toEqual([
      { type: 'thinking', thinking: 'private calculation' },
      { type: 'text', text: '391' },
    ]);
  });

  it('converts tool calls and parses arguments', async () => {
    const body = await openAIToAnthropic(
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

  it('treats adaptive thinking as enabled', () => {
    expect(normalizeThinking({ type: 'adaptive' })).toEqual({ enabled: true });
  });

  it('reads effort from output_config for adaptive thinking', () => {
    expect(normalizeThinking({ type: 'adaptive' }, { effort: 'xhigh' })).toEqual({
      enabled: true,
      effort: 'xhigh',
    });
  });

  it('prefers output_config effort over a thinking-block effort', () => {
    expect(normalizeThinking({ type: 'enabled', effort: 'low' }, { effort: 'max' })).toEqual({
      enabled: true,
      effort: 'max',
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

const fullCaps: ReasoningCapabilities = {
  supportsReasoning: true,
  supportsReasoningBudget: true,
  supportsReasoningEffort: true,
  supportsAdaptiveReasoning: true,
};
const effortOnlyCaps: ReasoningCapabilities = {
  supportsReasoning: true,
  supportsReasoningBudget: false,
  supportsReasoningEffort: true,
  supportsAdaptiveReasoning: false,
};
const adaptiveOnlyCaps: ReasoningCapabilities = {
  supportsReasoning: true,
  supportsReasoningBudget: false,
  supportsReasoningEffort: false,
  supportsAdaptiveReasoning: true,
};
const noCaps: ReasoningCapabilities = {
  supportsReasoning: false,
  supportsReasoningBudget: false,
  supportsReasoningEffort: false,
  supportsAdaptiveReasoning: false,
};

describe('reasoning mapping', () => {
  it('Anthropic enabled + budget → OpenRouter max_tokens', () => {
    const thinking = normalizeThinking({ type: 'enabled', budget_tokens: 8000 });
    const config = buildReasoningConfig(thinking, fullCaps, {
      ...request,
      thinking: { type: 'enabled', budget_tokens: 8000 },
    });
    expect(config).toMatchObject({ max_tokens: 8000 });
    expect(config).not.toHaveProperty('enabled');
  });

  it('Anthropic disabled/omitted → no reasoning config', () => {
    const thinking = normalizeThinking({ type: 'disabled' });
    const config = buildReasoningConfig(thinking, fullCaps, request);
    expect(config).toBeUndefined();
  });

  it('budget falls back to effort when budget not supported', () => {
    const thinking = normalizeThinking({ type: 'enabled', budget_tokens: 4096 });
    const config = buildReasoningConfig(thinking, effortOnlyCaps, {
      ...request,
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });
    expect(config).toMatchObject({ effort: 'medium' });
  });

  it('adaptive reasoning when neither budget nor effort supported', () => {
    const thinking = normalizeThinking({ type: 'adaptive' });
    const config = buildReasoningConfig(thinking, adaptiveOnlyCaps, {
      ...request,
      thinking: { type: 'adaptive' },
    });
    expect(config).toMatchObject({ enabled: true });
  });

  it('unsupported model returns undefined', () => {
    const thinking = normalizeThinking({ type: 'enabled', budget_tokens: 8000 });
    const config = buildReasoningConfig(thinking, noCaps, request);
    expect(config).toBeUndefined();
  });

  it('thinking + tool_use history → reasoning.text + tool_calls', async () => {
    const body = await anthropicToOpenAI(
      {
        ...request,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Let me check the weather.' },
              { type: 'tool_use', id: 'tu_1', name: 'weather', input: { city: 'Hanoi' } },
            ],
          },
          { role: 'user', content: 'Thanks' },
        ],
      },
      'gpt-test',
      fullCaps,
    );
    const assistantMsg = (body.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === 'assistant',
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.reasoning_details).toEqual([
      { type: 'reasoning.text', text: 'Let me check the weather.' },
    ]);
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: expect.arrayContaining([
            expect.objectContaining({ id: 'tu_1' }),
          ]),
        }),
      ]),
    );
  });

  it('maps assistant thinking history to Poolside reasoning_content', async () => {
    const body = await anthropicToOpenAI(
      {
        ...request,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'calculate carefully' },
              { type: 'text', text: '391' },
            ],
          },
          { role: 'user', content: 'Verify.' },
        ],
      },
      'poolside/laguna-s-2.1',
      fullCaps,
      undefined,
      'reasoning_content',
    );
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: [{ type: 'text', text: '391' }],
          reasoning_content: 'calculate carefully',
        }),
      ]),
    );
  });

  it('keeps thinking-only assistant history as a reasoning_details message', async () => {
    const body = await anthropicToOpenAI(
      {
        ...request,
        messages: [
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'private thought' }] },
          { role: 'user', content: 'Continue.' },
        ],
      },
      'gpt-test',
      fullCaps,
    );
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: null,
          reasoning_details: [{ type: 'reasoning.text', text: 'private thought' }],
        }),
      ]),
    );
  });

  it('resolves a proxy signature into encrypted upstream reasoning', async () => {
    const body = await anthropicToOpenAI(
      {
        ...request,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '', signature: 'proxy:rs_abc' }],
          },
          { role: 'user', content: 'Continue.' },
        ],
      },
      'gpt-test',
      fullCaps,
      async (signature) =>
        signature === 'proxy:rs_abc' ? { data: 'encrypted-state', format: 'openai-v2' } : null,
    );
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          reasoning_details: [{ type: 'reasoning.encrypted', data: 'encrypted-state', format: 'openai-v2' }],
        }),
      ]),
    );
  });

  it('redacted_thinking native → reasoning.encrypted passthrough', async () => {
    const blocks = await reasoningDetailsToAnthropicBlocks(
      [
        {
          type: 'reasoning.encrypted',
          data: 'opaque-data',
          format: 'anthropic-claude-v1',
        },
      ],
      { upstreamProvider: 'anthropic' },
    );
    expect(blocks).toEqual([
      { type: 'redacted_thinking', data: 'opaque-data' },
    ]);
  });

  it('OpenAI encrypted detail → returns proxy handle in a thinking block', async () => {
    const captured: Array<{ data: string; format?: string }> = [];
    const blocks = await reasoningDetailsToAnthropicBlocks(
      [
        {
          type: 'reasoning.encrypted',
          data: 'openai-encrypted',
          format: 'openai-v2',
        },
      ],
      { upstreamProvider: 'openai' },
      async (detail) => {
        captured.push(detail);
        return 'proxy:rs_test';
      },
    );
    expect(blocks).toEqual([{ type: 'thinking', thinking: '', signature: 'proxy:rs_test' }]);
    expect(captured).toEqual([{ data: 'openai-encrypted', format: 'openai-v2' }]);
  });

  it('multiple reasoning_details → preserve ordering', async () => {
    const blocks = await reasoningDetailsToAnthropicBlocks(
      [
        { type: 'reasoning.text', text: 'first thought' },
        { type: 'reasoning.summary', summary: 'summary here' },
        { type: 'reasoning.text', text: 'second thought', signature: 'sig_abc' },
      ],
      {},
    );
    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'first thought' },
      { type: 'thinking', thinking: 'summary here' },
      { type: 'thinking', thinking: 'second thought', signature: 'sig_abc' },
    ]);
  });

  it('mapFinishReason covers all cases', () => {
    expect(mapFinishReason('tool_calls', false)).toBe('tool_use');
    expect(mapFinishReason('stop', false)).toBe('end_turn');
    expect(mapFinishReason('length', false)).toBe('max_tokens');
    expect(mapFinishReason('content_filter', false)).toBe('refusal');
    expect(mapFinishReason(null, false)).toBeNull();
    expect(mapFinishReason('unknown_reason', false)).toBe('end_turn');
    expect(mapFinishReason('stop', true)).toBe('tool_use');
  });

  it('stream thinking → text', async () => {
    async function* source() {
      yield JSON.stringify({
        choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'thinking...' }] } }],
      });
      yield JSON.stringify({
        choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }],
      });
      yield '[DONE]';
    }
    const output: string[] = [];
    for await (const chunk of openAIStreamToAnthropic(source(), 'sonnet', 'msg_1'))
      output.push(chunk);
    const joined = output.join('');
    expect(joined).toContain('thinking_delta');
    expect(joined).toContain('thinking...');
    expect(joined).toContain('text_delta');
    expect(joined).toContain('Hello');
  });

  it('stream thinking → tool call', async () => {
    async function* source() {
      yield JSON.stringify({
        choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'deciding...' }] } }],
      });
      yield JSON.stringify({
        choices: [{
          delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: 'search', arguments: '{"q"' } }] },
        }],
      });
      yield JSON.stringify({
        choices: [{
          delta: { tool_calls: [{ index: 0, function: { arguments: ':"test"}' } }] },
          finish_reason: 'tool_calls',
        }],
      });
      yield '[DONE]';
    }
    const output: string[] = [];
    for await (const chunk of openAIStreamToAnthropic(source(), 'sonnet', 'msg_1'))
      output.push(chunk);
    const joined = output.join('');
    expect(joined).toContain('thinking_delta');
    expect(joined).toContain('tool_use');
    expect(joined).toContain('input_json_delta');
  });

  it('streams Poolside reasoning_content before text and captures reasoning usage', async () => {
    async function* source() {
      yield JSON.stringify({
        choices: [{ delta: { reasoning_content: 'calculate' } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 15 },
        },
      });
      yield JSON.stringify({ choices: [{ delta: { content: '391' }, finish_reason: 'stop' }] });
      yield '[DONE]';
    }
    const usage: { reasoningTokens?: number } = {};
    let output = '';
    for await (const chunk of openAIStreamToAnthropic(source(), 'sonnet', 'msg_1', usage))
      output += chunk;
    expect(output).toContain('thinking_delta');
    expect(output).toContain('calculate');
    expect(output).toContain('text_delta');
    expect(output).toContain('391');
    expect(usage.reasoningTokens).toBe(15);
  });

  it('streams foreign encrypted reasoning as an opaque proxy signature', async () => {
    async function* source() {
      yield JSON.stringify({
        choices: [{ delta: { reasoning_details: [{ id: 'r1', type: 'reasoning.encrypted', data: 'opaque', format: 'openai-v2' }] } }],
      });
      yield JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      yield '[DONE]';
    }
    let stored: { data: string; format?: string } | undefined;
    let output = '';
    for await (const chunk of openAIStreamToAnthropic(
      source(),
      'sonnet',
      'msg_1',
      undefined,
      async (detail) => {
        stored = detail;
        return 'proxy:rs_stream';
      },
    )) output += chunk;
    expect(stored).toEqual({ data: 'opaque', format: 'openai-v2' });
    expect(output).toContain('proxy:rs_stream');
    expect(output).not.toContain('opaque');
  });

  it('stream multiple tool calls', async () => {
    async function* source() {
      yield JSON.stringify({
        choices: [{
          delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'fn_a', arguments: '{}' } }] },
        }],
      });
      yield JSON.stringify({
        choices: [{
          delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'fn_b', arguments: '{}' } }] },
          finish_reason: 'tool_calls',
        }],
      });
      yield '[DONE]';
    }
    const output: string[] = [];
    for await (const chunk of openAIStreamToAnthropic(source(), 'sonnet', 'msg_1'))
      output.push(chunk);
    const joined = output.join('');
    expect(joined).toContain('fn_a');
    expect(joined).toContain('fn_b');
  });
});
