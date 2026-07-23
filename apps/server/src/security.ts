import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');
export function randomToken(prefix = '') {
  return prefix + randomBytes(32).toString('base64url');
}
function encryptionKey(value: string) {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 ? decoded : createHash('sha256').update(value).digest();
}
export function encryptCredential(value: string, keyValue: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    encryptedApiKey: encrypted.toString('base64'),
    encryptionIv: iv.toString('base64'),
    encryptionAuthTag: cipher.getAuthTag().toString('base64'),
    encryptionKeyVersion: 1,
  };
}
export function decryptCredential(
  value: { encryptedApiKey: string; encryptionIv: string; encryptionAuthTag: string },
  keyValue: string,
) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(keyValue),
    Buffer.from(value.encryptionIv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(value.encryptionAuthTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.encryptedApiKey, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
export function maskApiKey(value: string) {
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}
// Drizzle wraps pg errors in DrizzleQueryError, putting the actual pg error (with its
// `code`) on `.cause` rather than in `.message` — `error.message` never contains "23505"
// for a real unique-violation, so that must not be used to detect one.
export function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const causeCode = (error as { cause?: { code?: unknown } })?.cause?.code;
  return code === '23505' || causeCode === '23505';
}
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function privateAddress(address: string) {
  if (
    address === '::1' ||
    address === '::' ||
    address.startsWith('fe80:') ||
    address.startsWith('fc') ||
    address.startsWith('fd')
  )
    return true;
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return false;
}
export async function validateUpstreamUrl(raw: string, allowPrivate: boolean, production: boolean) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Only HTTP(S) upstream endpoints are supported');
  if (production && url.protocol !== 'https:')
    throw new Error('Production upstream endpoints must use HTTPS');
  if (url.username || url.password)
    throw new Error('Credentials must not be embedded in endpoint URLs');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('Upstream hostname did not resolve');
  if (!allowPrivate && addresses.some((a) => privateAddress(a.address)))
    throw new Error('Private, loopback, and link-local upstream endpoints are blocked');
  return url.toString();
}
