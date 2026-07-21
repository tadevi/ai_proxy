import { describe, expect, it } from 'vitest';
import { decryptCredential, encryptCredential, hashSecret } from '../src/security.js';
import { generateGatewayModelId } from '../src/routes/dashboard.js';

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

  it('generates slugged model IDs with non-numeric random suffixes', () => {
    const first = generateGatewayModelId('MiMo 2.5 Pro');
    const second = generateGatewayModelId('MiMo 2.5 Pro');
    expect(first).toMatch(/^mimo-2-5-pro-[a-z0-9]{6}$/);
    expect(first).not.toBe(second);
  });
});
