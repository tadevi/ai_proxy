import { describe, expect, it } from 'vitest';
import { cooldownStatuses, fallbackStatuses, isDisableError } from '../src/routes/gateway/schema.js';

describe('gateway health policy', () => {
  it('does not globally cooldown a token on a generic 403', () => {
    expect(cooldownStatuses.has(403)).toBe(false);
    expect(fallbackStatuses.has(403)).toBe(true);
    expect(isDisableError(403)).toBe(false);
  });

  it('still disables explicit credential failures', () => {
    expect(isDisableError(401)).toBe(true);
    expect(isDisableError(402)).toBe(true);
    expect(
      isDisableError(403, {
        upstreamStatus: 403,
        response: { type: 'quota_exceeded' },
      }),
    ).toBe(true);
  });
});
