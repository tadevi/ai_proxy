import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ZodError } from 'zod';
import { lt, sql } from 'drizzle-orm';
import { createDb, requestLogs } from '@gateway/db';
import type { Config } from './config.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { gatewayRoutes } from './routes/gateway.js';
import { dashboardAuth } from './auth.js';
import { logError, logRequest, logWarn } from './log.js';
import './types.js';

export async function buildApp(config: Config) {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 10 * 1024 * 1024,
    requestIdHeader: 'x-request-id',
  });
  const { db, pool } = createDb(config.DATABASE_URL, databaseTls(config));
  app.decorate('db', db);
  app.decorate('config', config);
  try {
    await db.execute(sql`
      INSERT INTO model_usage_daily (
        user_id, gateway_model_id, usage_date, request_count, input_tokens, output_tokens
      )
      SELECT
        user_id,
        resolved_gateway_model,
        created_at::date,
        count(*)::bigint,
        coalesce(sum(input_tokens), 0)::bigint,
        coalesce(sum(output_tokens), 0)::bigint
      FROM request_logs
      WHERE resolved_gateway_model IS NOT NULL
      GROUP BY user_id, resolved_gateway_model, created_at::date
      ON CONFLICT (user_id, gateway_model_id, usage_date) DO UPDATE SET
        request_count = EXCLUDED.request_count,
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens
    `);
  } catch (error) {
    logWarn('usage summary reconciliation failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
  const pruneLogs = async () => {
    const cutoff = new Date(Date.now() - config.LOG_RETENTION_DAYS * 86_400_000);
    await db.delete(requestLogs).where(lt(requestLogs.createdAt, cutoff));
  };
  void pruneLogs().catch((error: unknown) =>
    logWarn('request log cleanup failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    }),
  );
  const logRetentionTimer = setInterval(
    () =>
      void pruneLogs().catch((error: unknown) =>
        logWarn('request log cleanup failed', {
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
      ),
    6 * 60 * 60_000,
  );
  logRetentionTimer.unref();
  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  const requestStarts = new WeakMap<object, bigint>();
  app.addHook('onRequest', async (req, reply) => {
    requestStarts.set(req, process.hrtime.bigint());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.url.startsWith('/api/')) {
      const origin = req.headers.origin;
      const allowedOrigins = new Set([new URL(config.PUBLIC_URL).origin]);
      if (config.NODE_ENV !== 'production') {
        allowedOrigins.add('http://localhost:5173');
        allowedOrigins.add('http://127.0.0.1:5173');
      }
      if (origin && !allowedOrigins.has(origin))
        return reply.code(403).send({ error: 'Invalid request origin' });
    }
  });
  app.addHook('onResponse', async (req, reply) => {
    const started = requestStarts.get(req);
    const elapsedMs = started ? Number(process.hrtime.bigint() - started) / 1_000_000 : 0;
    logRequest(
      reply.statusCode,
      req.method,
      req.routeOptions.url ?? req.url.split('?')[0]!,
      elapsedMs,
    );
  });
  app.addHook('preHandler', async (req, reply) => {
    const isPublicDashboardRoute =
      req.url.startsWith('/api/auth/') || req.url.startsWith('/api/me');
    if (req.url.startsWith('/api/') && !isPublicDashboardRoute) {
      await dashboardAuth(app, req, reply);
    }
  });
  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('select 1');
      return { status: 'ok', database: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'degraded', database: 'unavailable' });
    }
  });
  await dashboardRoutes(app);
  await gatewayRoutes(app);
  app.setErrorHandler((error, req, reply) => {
    logError('request failed', {
      requestId: req.id,
      errorType: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: 'Validation failed',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    const statusCode =
      error && typeof error === 'object' && 'statusCode' in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    const status = typeof statusCode === 'number' && statusCode < 500 ? statusCode : 500;
    const message = error instanceof Error ? error.message : 'Request failed';
    const databaseUnavailable = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|certificate|self-signed/i.test(
      message,
    );
    return reply.code(databaseUnavailable ? 503 : status).send({
      error: databaseUnavailable
        ? 'Database unavailable. Check DATABASE_URL, DNS, and TLS certificate settings.'
        : status === 500
          ? 'Internal server error'
          : message,
      requestId: req.id,
    });
  });
  app.addHook('onClose', async () => {
    clearInterval(logRetentionTimer);
    await pool.end();
  });
  const webRoot = findWebRoot();
  if (existsSync(webRoot)) {
    await app.register(staticPlugin, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') || req.url.startsWith('/v1/')
        ? reply.code(404).send({ error: 'Not found' })
        : reply.sendFile('index.html'),
    );
  }
  return app;
}

function findWebRoot() {
  let directory = process.cwd();
  while (true) {
    const candidate = join(directory, 'apps/web/dist');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return candidate;
    directory = parent;
  }
}

function databaseTls(config: Config) {
  const certConfigured = Boolean(config.DATABASE_SSL_CERT_PATH);
  const keyConfigured = Boolean(config.DATABASE_SSL_KEY_PATH);
  if (certConfigured !== keyConfigured) {
    throw new Error('DATABASE_SSL_CERT_PATH and DATABASE_SSL_KEY_PATH must be set together');
  }
  if (!config.DATABASE_SSL_CA_PATH && !certConfigured) return undefined;
  return {
    rejectUnauthorized: true,
    ...(config.DATABASE_SSL_CA_PATH
      ? { ca: readFileSync(config.DATABASE_SSL_CA_PATH, 'utf8') }
      : {}),
    ...(certConfigured
      ? {
          cert: readFileSync(config.DATABASE_SSL_CERT_PATH!, 'utf8'),
          key: readFileSync(config.DATABASE_SSL_KEY_PATH!, 'utf8'),
        }
      : {}),
  };
}
