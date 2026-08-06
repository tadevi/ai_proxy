import { describe, expect, it } from 'vitest';
import { reasoningWireFormat } from '../src/routes/gateway/upstream-client.js';
import type { ResolvedModel } from '../src/routes/gateway/schema.js';

describe('reasoning codec fallback', () => {
  it('keeps legacy fallback until a binding is learned from a request', () => {
    expect(
      reasoningWireFormat({ baseUrl: 'https://inference.poolside.ai' } as ResolvedModel['connection']),
    ).toBe('reasoning_content');
    expect(
      reasoningWireFormat({ baseUrl: 'https://example.com' } as ResolvedModel['connection']),
    ).toBe('reasoning_details');
  });
});
