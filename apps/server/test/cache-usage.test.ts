import { describe, expect, it } from 'vitest';
import { extractCacheInputTokens } from '../src/routes/gateway.js';

describe('extractCacheInputTokens', () => {
  it('returns undefined when cache fields are absent', () => {
    expect(extractCacheInputTokens(undefined)).toBeUndefined();
    expect(extractCacheInputTokens({ input_tokens: 10, output_tokens: 5 })).toBeUndefined();
  });

  it('returns 0 when upstream explicitly reports zero cached tokens', () => {
    expect(
      extractCacheInputTokens({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ).toBe(0);
  });

  it('returns the sum when both cache fields are present', () => {
    expect(
      extractCacheInputTokens({ cache_creation_input_tokens: 30, cache_read_input_tokens: 90 }),
    ).toBe(120);
  });

  it('returns the value when only one cache field is present as a number', () => {
    expect(extractCacheInputTokens({ cache_read_input_tokens: 120 })).toBe(120);
    expect(extractCacheInputTokens({ cache_creation_input_tokens: 120 })).toBe(120);
  });

  it('ignores non-numeric cache fields and returns undefined when none are numeric', () => {
    expect(
      extractCacheInputTokens({
        cache_read_input_tokens: '120',
        cache_creation_input_tokens: null,
      }),
    ).toBeUndefined();
  });

  it('treats a non-numeric field as 0 when the other field is a valid number', () => {
    expect(
      extractCacheInputTokens({
        cache_creation_input_tokens: 'abc',
        cache_read_input_tokens: 120,
      }),
    ).toBe(120);
  });
});
