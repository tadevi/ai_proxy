import { describe, expect, it } from 'vitest';
import { openAIToAnthropic } from '@gateway/protocol';
import { extractCacheInputTokens } from '../src/routes/gateway.js';

function upstreamUsage(
  cached_tokens?: number,
  includeDetails = cached_tokens !== undefined,
) {
  const usage: Record<string, unknown> = {
    prompt_tokens: 181,
    completion_tokens: 23,
    total_tokens: 204,
  };
  if (includeDetails) {
    usage.prompt_tokens_details = { cached_tokens: cached_tokens ?? 0 };
  }
  return usage;
}

describe('cache token data path: unknown vs explicit-zero', () => {
  it('unknown (absent prompt_tokens_details) yields undefined → SQL NULL → API null', async () => {
    const body = await openAIToAnthropic(
      {
        id: 'chat-1',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: upstreamUsage(undefined, false),
      },
      'claude-3',
    );
    const extracted = extractCacheInputTokens(body.usage as Record<string, unknown>);
    expect(extracted).toBeUndefined();
    // undefined is what writeLog receives → tx.insert(requestLogs).values({ cacheInputTokens: undefined })
    // → NULL in the database → null in the /api/logs JSON response.
  });

  it('explicit zero cached_tokens yields 0 → SQL integer 0 → API 0', async () => {
    const body = await openAIToAnthropic(
      {
        id: 'chat-2',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: upstreamUsage(0, true),
      },
      'claude-3',
    );
    const extracted = extractCacheInputTokens(body.usage as Record<string, unknown>);
    expect(extracted).toBe(0);
    // 0 is what writeLog receives → NOT null in the database → numeric 0 in /api/logs JSON.
  });

  it('positive cached_tokens yields 120 → SQL integer 120 → API 120', async () => {
    const body = await openAIToAnthropic(
      {
        id: 'chat-3',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: upstreamUsage(120, true),
      },
      'claude-3',
    );
    const extracted = extractCacheInputTokens(body.usage as Record<string, unknown>);
    expect(extracted).toBe(120);
  });

  it('does not derive cache from total_tokens', async () => {
    const body = await openAIToAnthropic(
      {
        id: 'chat-4',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 181, completion_tokens: 23, total_tokens: 204 },
      },
      'claude-3',
    );
    const extracted = extractCacheInputTokens(body.usage as Record<string, unknown>);
    expect(extracted).toBeUndefined();
  });
});
