import { describe, expect, it } from 'vitest';
import type { ResolvedModel } from '../src/routes/gateway/schema.js';
import {
  reasoningWireFormat,
  resolvedReasoningWireFormat,
} from '../src/routes/gateway/upstream-client.js';

function resolved(
  baseUrl: string,
  reasoningCodec: ResolvedModel['reasoningCodec'],
): Pick<ResolvedModel, 'connection' | 'reasoningCodec'> {
  return {
    reasoningCodec,
    connection: { baseUrl } as ResolvedModel['connection'],
  };
}

describe('resolvedReasoningWireFormat', () => {
  it('preserves existing URL detection for auto', () => {
    expect(reasoningWireFormat({ baseUrl: 'https://inference.poolside.ai' } as ResolvedModel['connection']))
      .toBe('reasoning_content');
    expect(resolvedReasoningWireFormat(resolved('https://inference.poolside.ai', 'auto')))
      .toBe('reasoning_content');
  });

  it('allows external bindings to override the URL-derived format', () => {
    expect(
      resolvedReasoningWireFormat(
        resolved('https://inference.poolside.ai', 'reasoning_details'),
      ),
    ).toBe('reasoning_details');
    expect(
      resolvedReasoningWireFormat(
        resolved('https://example.com', 'reasoning_content'),
      ),
    ).toBe('reasoning_content');
  });

  it('keeps CLIProxy on legacy auto detection regardless of binding metadata', () => {
    expect(
      resolvedReasoningWireFormat(
        resolved('http://cliproxy.internal', 'reasoning_content'),
        'http://cliproxy.internal/',
      ),
    ).toBe('reasoning_details');
  });
});
