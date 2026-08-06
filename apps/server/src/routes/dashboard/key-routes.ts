import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { gatewayKeys } from '@gateway/db';
import { gatewayKeyInputSchema } from '@gateway/shared';
import { hashSecret, randomToken } from '../../security.js';

export async function registerKeyRoutes(app: FastifyInstance) {
  app.get('/api/keys', async (req) =>
    app.db
      .select({
        id: gatewayKeys.id,
        name: gatewayKeys.name,
        prefix: gatewayKeys.prefix,
        createdAt: gatewayKeys.createdAt,
        lastUsedAt: gatewayKeys.lastUsedAt,
        revokedAt: gatewayKeys.revokedAt,
      })
      .from(gatewayKeys)
      .where(eq(gatewayKeys.userId, req.dashboardUser!.id))
      .orderBy(desc(gatewayKeys.createdAt)),
  );

  app.post('/api/keys', async (req) => {
    const { name } = gatewayKeyInputSchema.parse(req.body);
    const secret = randomToken('gw_');
    const [key] = await app.db
      .insert(gatewayKeys)
      .values({
        userId: req.dashboardUser!.id,
        name,
        prefix: secret.slice(0, 11),
        keyHash: hashSecret(secret),
      })
      .returning({
        id: gatewayKeys.id,
        name: gatewayKeys.name,
        prefix: gatewayKeys.prefix,
        createdAt: gatewayKeys.createdAt,
      });
    return { ...key, key: secret };
  });

  app.patch('/api/keys/:id', async (req, reply) => {
    const { name } = gatewayKeyInputSchema.parse(req.body);
    const [key] = await app.db
      .update(gatewayKeys)
      .set({ name })
      .where(
        and(
          eq(gatewayKeys.id, (req.params as { id: string }).id),
          eq(gatewayKeys.userId, req.dashboardUser!.id),
        ),
      )
      .returning({ id: gatewayKeys.id, name: gatewayKeys.name });
    return key ?? reply.code(404).send({ error: 'Key not found' });
  });

  app.delete('/api/keys/:id', async (req, reply) => {
    const [key] = await app.db
      .update(gatewayKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(gatewayKeys.id, (req.params as { id: string }).id),
          eq(gatewayKeys.userId, req.dashboardUser!.id),
        ),
      )
      .returning({ id: gatewayKeys.id });
    return key ? { ok: true } : reply.code(404).send({ error: 'Key not found' });
  });
}
