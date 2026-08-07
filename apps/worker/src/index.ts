import { checkDatabase, type WorkerDbEnv } from './db.js';

interface Env extends WorkerDbEnv {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/__health' || url.pathname === '/health') {
      return json({ runtime: 'cloudflare-worker', status: 'ok' });
    }

    if (url.pathname === '/__db-health') {
      try {
        const result = await checkDatabase(env);
        return json(result, result.status);
      } catch (error) {
        console.error('Worker database health check failed', error);
        return json(
          {
            ok: false,
            error: 'database_connection_failed',
            message: error instanceof Error ? error.message : 'Unknown database error',
          },
          503,
        );
      }
    }

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
          message: 'Cloudflare Worker API routes are not ported yet.',
        },
        501,
      );
    }

    return env.ASSETS.fetch(request);
  },
};
