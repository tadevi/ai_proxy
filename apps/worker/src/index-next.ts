import { checkDatabase } from './db.js';
import { handleDashboardApiRequest } from './dashboard-api.js';
import { handleDashboardAuthRequest } from './dashboard-auth.js';
import { handleDashboardWriteRequest, type DashboardWriteEnv } from './dashboard-write.js';
import { handleGatewayRequest } from './gateway.js';

interface Env extends DashboardWriteEnv {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const getErrorCode = (error: unknown) => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/__health' || url.pathname === '/health') {
      return json({ runtime: 'cloudflare-worker', status: 'ok' });
    }

    if (url.pathname === '/__db-health') {
      const diagnostics = {
        hyperdriveBound: Boolean(env.HYPERDRIVE?.connectionString),
        databaseUrlBound: Boolean(env.DATABASE_URL),
        selectedConnection: env.HYPERDRIVE?.connectionString ? 'hyperdrive' : env.DATABASE_URL ? 'database_url' : 'none',
      } as const;

      try {
        const result = await checkDatabase(env);
        return json({ ...result, ...diagnostics }, result.status);
      } catch (error) {
        const details = {
          name: error instanceof Error ? error.name : undefined,
          message: error instanceof Error ? error.message : 'Unknown database error',
          code: getErrorCode(error),
          ...diagnostics,
        };
        console.error('Worker database health check failed', details);
        return json(
          {
            ok: false,
            error: 'database_connection_failed',
            ...details,
          },
          503,
        );
      }
    }

    const dashboardAuthResponse = await handleDashboardAuthRequest(request, env);
    if (dashboardAuthResponse) return dashboardAuthResponse;

    const dashboardWriteResponse = await handleDashboardWriteRequest(request, env);
    if (dashboardWriteResponse) return dashboardWriteResponse;

    const dashboardApiResponse = await handleDashboardApiRequest(request, env);
    if (dashboardApiResponse) return dashboardApiResponse;

    const gatewayResponse = await handleGatewayRequest(request, env);
    if (gatewayResponse) return gatewayResponse;

    if (
      url.pathname === '/api' ||
      url.pathname.startsWith('/api/') ||
      url.pathname === '/v1' ||
      url.pathname.startsWith('/v1/') ||
      url.pathname === '/anthropic' ||
      url.pathname.startsWith('/anthropic/')
    ) {
      return json(
        {
          error: 'worker_api_not_ported',
          message: 'Cloudflare Worker API route is not ported yet.',
        },
        501,
      );
    }

    return env.ASSETS.fetch(request);
  },
};
