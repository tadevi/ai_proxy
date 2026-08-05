import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { sessions, users } from '@gateway/db';
import {
  changePasswordSchema,
  credentialsSchema,
} from '@gateway/shared';
import { dashboardAuth } from '../../auth.js';
import { hashSecret } from '../../security.js';
import { createSession } from './index.js';

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post('/api/auth/register', async (req, reply) => {
    const input = credentialsSchema.parse(req.body);
    const exists = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, input.username))
      .limit(1);
    if (exists.length) return reply.code(409).send({ error: 'Username already exists' });
    const [user] = await app.db
      .insert(users)
      .values({ username: input.username, passwordHash: await bcrypt.hash(input.password, 12) })
      .returning({ id: users.id, username: users.username });
    await createSession(app, reply, user!.id);
    return user;
  });

  app.post('/api/auth/login', async (req, reply) => {
    const input = credentialsSchema.parse(req.body);
    const [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.username, input.username))
      .limit(1);
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash)))
      return reply.code(401).send({ error: 'Invalid username or password' });
    await createSession(app, reply, user.id);
    return { id: user.id, username: user.username };
  });

  app.post(
    '/api/auth/logout',
    { preHandler: (req, reply) => dashboardAuth(app, req, reply) },
    async (req, reply) => {
      const token = req.cookies.gateway_session;
      if (token) await app.db.delete(sessions).where(eq(sessions.tokenHash, hashSecret(token)));
      reply.clearCookie('gateway_session', { path: '/' });
      return { ok: true };
    },
  );

  app.post('/api/account/password', async (req, reply) => {
    const input = changePasswordSchema.parse(req.body);
    const [user] = await app.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, req.dashboardUser!.id))
      .limit(1);
    if (!user || !(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
      return reply.code(401).send({ error: 'Current password is incorrect' });
    }
    await app.db
      .update(users)
      .set({ passwordHash: await bcrypt.hash(input.newPassword, 12), updatedAt: new Date() })
      .where(eq(users.id, req.dashboardUser!.id));
    const token = req.cookies.gateway_session;
    if (token) {
      await app.db.delete(sessions).where(eq(sessions.tokenHash, hashSecret(token)));
    }
    reply.clearCookie('gateway_session', { path: '/' });
    return { ok: true };
  });
}
