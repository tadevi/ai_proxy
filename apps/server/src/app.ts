import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ZodError } from 'zod';
import { createDb } from '@gateway/db';
import type { Config } from './config.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { gatewayRoutes } from './routes/gateway.js';
import { dashboardAuth } from './auth.js';
import './types.js';

export async function buildApp(config: Config) {
  const app = Fastify({
    logger: {
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.x-api-key',
          'req.headers.cookie',
          '*.apiKey',
          '*.encryptedApiKey',
          '*.sessionToken',
          'err.params',
          'err.cause',
        ],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 10 * 1024 * 1024,
    requestIdHeader: 'x-request-id',
  });
  const { db, pool } = createDb(config.DATABASE_URL, databaseTls(config));
  app.decorate('db', db);
  app.decorate('config', config);
  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.addHook('onRequest', async (req, reply) => {
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
    req.log.error(
      { requestId: req.id, errorType: error instanceof Error ? error.name : 'unknown' },
      'request failed',
    );
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
  app.addHook('onClose', async () => pool.end());
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
