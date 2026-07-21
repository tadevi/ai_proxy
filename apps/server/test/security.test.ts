import { describe, expect, it } from 'vitest';
import { decryptCredential, encryptCredential, hashSecret } from '../src/security.js';
import { requestContainsImages, safeProviderErrorBody } from '../src/routes/gateway.js';
import { anthropicRequestSchema } from '@gateway/protocol';

describe('security primitives', () => {
  it('encrypts credentials with unique AES-GCM nonces', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const first = encryptCredential('provider-secret', key);
    const second = encryptCredential('provider-secret', key);
    expect(first.encryptedApiKey).not.toBe('provider-secret');
    expect(first.encryptionIv).not.toBe(second.encryptionIv);
    expect(decryptCredential(first, key)).toBe('provider-secret');
  });

  it('hashes gateway credentials deterministically without retaining plaintext', () => {
    expect(hashSecret('gw_secret')).toBe(hashSecret('gw_secret'));
    expect(hashSecret('gw_secret')).not.toContain('gw_secret');
  });

  it('detects images in content and tool results, but not arbitrary tool input', () => {
    const withToolResultImage = anthropicRequestSchema.parse({
      model: 'sonnet',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
              ],
            },
          ],
        },
      ],
    });
    const withToolInputMarker = anthropicRequestSchema.parse({
      model: 'sonnet',
      max_tokens: 10,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'save', input: { type: 'image' } }],
        },
      ],
    });
    expect(requestContainsImages(withToolResultImage)).toBe(true);
    expect(requestContainsImages(withToolInputMarker)).toBe(false);
  });

  it('keeps only safe, useful fields from provider errors', () => {
    expect(
      safeProviderErrorBody({
        error: { code: 'InvalidInput', message: 'Invalid image', api_key: 'secret' },
        echoed_request: { messages: ['private prompt'] },
      }),
    ).toEqual({ code: 'InvalidInput', message: 'Invalid image' });
  });
});
