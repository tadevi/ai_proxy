import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';

const testConfig: Config = {
  DATABASE_URL: 'postgres://dummy',
  PORT: 3000,
  CLIPROXY_BASE_URL: 'https://api.cliproxy.ai',
  PUBLIC_URL: 'http://localhost:3000',
  SESSION_SECRET: 'test-secret',
  CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ALLOW_PRIVATE_UPSTREAMS: false,
  UPSTREAM_TIMEOUT_MS: 30000,
  LOG_RETENTION_DAYS: 7,
  NODE_ENV: 'test',
};

describe('route registration parity', () => {
  it('builds app successfully and registers key routes', async () => {
    const app = await buildApp(testConfig);

    const expectedRoutes: Array<{ method: string; url: string }> = [
      { method: 'GET', url: '/health' },
      { method: 'GET', url: '/v1/models' },
      { method: 'POST', url: '/v1/messages' },
      { method: 'POST', url: '/anthropic/v1/messages' },
      { method: 'POST', url: '/api/models/:id/test' },
      { method: 'POST', url: '/api/playground/complete' },
      { method: 'POST', url: '/api/auth/register' },
      { method: 'POST', url: '/api/auth/login' },
      { method: 'POST', url: '/api/auth/logout' },
      { method: 'GET', url: '/api/me' },
      { method: 'POST', url: '/api/account/password' },
      { method: 'GET', url: '/api/keys' },
      { method: 'POST', url: '/api/keys' },
      { method: 'PATCH', url: '/api/keys/:id' },
      { method: 'DELETE', url: '/api/keys/:id' },
      { method: 'GET', url: '/api/connections' },
      { method: 'GET', url: '/api/connections/:id/tokens' },
      { method: 'GET', url: '/api/bindings' },
      { method: 'GET', url: '/api/models' },
      { method: 'GET', url: '/api/models/usage' },
      { method: 'GET', url: '/api/models/:id/rules' },
      { method: 'GET', url: '/api/presets' },
      { method: 'GET', url: '/api/mappings' },
      { method: 'GET', url: '/api/logs' },
      { method: 'GET', url: '/api/setup' },
    ];

    for (const route of expectedRoutes) {
      expect(
        app.hasRoute(route),
        `Missing route: ${route.method} ${route.url}`,
      ).toBe(true);
    }

    await app.close();
  });
});
