import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { gatewayKeys, sessions, users } from '@gateway/db';
import { hashSecret } from './security.js';

export async function dashboardAuth(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const token = req.cookies.gateway_session;
  if (!token) return reply.code(401).send({ error: 'Authentication required' });
  const rows = await app.db
    .select({ id: users.id, username: users.username, sessionId: sessions.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashSecret(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return reply.code(401).send({ error: 'Session expired' });
  req.dashboardUser = { id: row.id, username: row.username };
  await app.db
    .update(sessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(sessions.id, row.sessionId));
}
export async function gatewayAuth(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const xKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined;
  if (bearer && xKey && bearer !== xKey)
    return reply.code(401).send({
      type: 'error',
      error: { type: 'authentication_error', message: 'Conflicting gateway credentials' },
    });
  const token = bearer ?? xKey;
  if (!token?.startsWith('gw_'))
    return reply.code(401).send({
      type: 'error',
      error: { type: 'authentication_error', message: 'Valid gateway API key required' },
    });
  const rows = await app.db
    .select({ id: gatewayKeys.id, userId: gatewayKeys.userId })
    .from(gatewayKeys)
    .where(and(eq(gatewayKeys.keyHash, hashSecret(token)), isNull(gatewayKeys.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row)
    return reply.code(401).send({
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid or revoked gateway API key' },
    });
  req.gatewayUserId = row.userId;
  await app.db
    .update(gatewayKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(gatewayKeys.id, row.id));
}
