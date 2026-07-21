import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  gatewayKeys,
  mappingRoutes,
  mappings,
  modelPresets,
  modelUsageDaily,
  providerConnections,
  requestLogs,
  sessions,
  transformationRules,
  upstreamModels,
  users,
} from '@gateway/db';
import {
  aliases,
  changePasswordSchema,
  credentialsSchema,
  gatewayKeyInputSchema,
  mappingUpdateSchema,
  modelInputSchema,
  presetInputSchema,
  presetLinkSchema,
  providerConnectionInputSchema,
  ruleInputSchema,
} from '@gateway/shared';
import { dashboardAuth } from '../auth.js';
import { encryptCredential, hashSecret, randomToken, validateUpstreamUrl } from '../security.js';

const safeConnection = {
  id: providerConnections.id,
  displayName: providerConnections.displayName,
  baseUrl: providerConnections.baseUrl,
  enabled: providerConnections.enabled,
  createdAt: providerConnections.createdAt,
  updatedAt: providerConnections.updatedAt,
};
const safeModel = {
  id: upstreamModels.id,
  displayName: upstreamModels.displayName,
  gatewayModelId: upstreamModels.gatewayModelId,
  upstreamModelId: upstreamModels.upstreamModelId,
  providerConnectionId: upstreamModels.providerConnectionId,
  providerConnectionName: providerConnections.displayName,
  apiFormat: upstreamModels.apiFormat,
  providerBasePath: upstreamModels.providerBasePath,
  requestPathOverride: upstreamModels.requestPathOverride,
  providerEnabled: providerConnections.enabled,
  contextLength: upstreamModels.contextLength,
  maxOutputTokens: upstreamModels.maxOutputTokens,
  supportsStreaming: upstreamModels.supportsStreaming,
  supportsTools: upstreamModels.supportsTools,
  supportsImages: upstreamModels.supportsImages,
  supportsReasoning: upstreamModels.supportsReasoning,
  enabled: upstreamModels.enabled,
  latestTestStatus: upstreamModels.latestTestStatus,
  latestTestAt: upstreamModels.latestTestAt,
  cooldownUntil: upstreamModels.cooldownUntil,
  latestError: upstreamModels.latestError,
  latestErrorAt: upstreamModels.latestErrorAt,
  createdAt: upstreamModels.createdAt,
  updatedAt: upstreamModels.updatedAt,
};
const slug = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 45) || 'model';
export const generateGatewayModelId = (name: string) =>
  `${slug(name)}-${randomToken()
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 6)}`;

export async function dashboardRoutes(app: FastifyInstance) {
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
  app.get(
    '/api/me',
    { preHandler: (req, reply) => dashboardAuth(app, req, reply) },
    async (req) => req.dashboardUser,
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

  app.get('/api/connections', async (req) =>
    app.db
      .select(safeConnection)
      .from(providerConnections)
      .where(eq(providerConnections.userId, req.dashboardUser!.id))
      .orderBy(desc(providerConnections.createdAt)),
  );
  app.post('/api/connections', async (req, reply) => {
    const input = providerConnectionInputSchema.parse(req.body);
    if (!input.apiKey) return reply.code(400).send({ error: 'Provider API key is required' });
    const baseUrl = await validateUpstreamUrl(
      input.baseUrl,
      app.config.ALLOW_PRIVATE_UPSTREAMS,
      app.config.NODE_ENV === 'production',
    );
    const encrypted = encryptCredential(input.apiKey, app.config.CREDENTIAL_ENCRYPTION_KEY);
    const values = { ...input };
    delete values.apiKey;
    const [connection] = await app.db
      .insert(providerConnections)
      .values({ ...values, baseUrl, userId: req.dashboardUser!.id, ...encrypted })
      .returning(safeConnection);
    return reply.code(201).send(connection);
  });
  app.patch('/api/connections/:id', async (req, reply) => {
    const input = providerConnectionInputSchema.partial().parse(req.body);
    const baseUrl = input.baseUrl
      ? await validateUpstreamUrl(
          input.baseUrl,
          app.config.ALLOW_PRIVATE_UPSTREAMS,
          app.config.NODE_ENV === 'production',
        )
      : undefined;
    const encrypted = input.apiKey
      ? encryptCredential(input.apiKey, app.config.CREDENTIAL_ENCRYPTION_KEY)
      : {};
    const values = { ...input };
    delete values.apiKey;
    const [connection] = await app.db
      .update(providerConnections)
      .set({
        ...values,
        ...(baseUrl ? { baseUrl } : {}),
        ...encrypted,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(providerConnections.id, (req.params as { id: string }).id),
          eq(providerConnections.userId, req.dashboardUser!.id),
        ),
      )
      .returning(safeConnection);
    return connection ?? reply.code(404).send({ error: 'Provider connection not found' });
  });
  app.delete('/api/connections/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [connection] = await app.db
      .delete(providerConnections)
      .where(
        and(eq(providerConnections.id, id), eq(providerConnections.userId, req.dashboardUser!.id)),
      )
      .returning({ id: providerConnections.id });
    return connection
      ? { ok: true }
      : reply.code(404).send({ error: 'Provider connection not found' });
  });

  app.get('/api/models', async (req) => listModels(app, req.dashboardUser!.id));
  app.get('/api/models/usage', async (req) =>
    app.db
      .select({
        gatewayModelId: modelUsageDaily.gatewayModelId,
        requestCount: sql<string>`coalesce(sum(${modelUsageDaily.requestCount}), 0)::text`,
        inputTokens: sql<string>`coalesce(sum(${modelUsageDaily.inputTokens}), 0)::text`,
        outputTokens: sql<string>`coalesce(sum(${modelUsageDaily.outputTokens}), 0)::text`,
        cacheInputTokens: sql<string>`coalesce(sum(${modelUsageDaily.cacheInputTokens}), 0)::text`,
      })
      .from(modelUsageDaily)
      .where(eq(modelUsageDaily.userId, req.dashboardUser!.id))
      .groupBy(modelUsageDaily.gatewayModelId),
  );
  app.post('/api/models', async (req, reply) => {
    const input = modelInputSchema.parse(req.body);
    if (!(await ownsConnection(app, req.dashboardUser!.id, input.providerConnectionId))) {
      return reply.code(403).send({ error: 'Provider connection not found' });
    }
    const [created] = await app.db
      .insert(upstreamModels)
      .values({
        ...input,
        userId: req.dashboardUser!.id,
        gatewayModelId: generateGatewayModelId(input.displayName),
      })
      .returning({ id: upstreamModels.id });
    return reply.code(201).send((await getModel(app, req.dashboardUser!.id, created!.id))!);
  });
  app.patch('/api/models/:id', async (req, reply) => {
    const input = modelInputSchema.partial().parse(req.body);
    if (
      input.providerConnectionId &&
      !(await ownsConnection(app, req.dashboardUser!.id, input.providerConnectionId))
    ) {
      return reply.code(403).send({ error: 'Provider connection not found' });
    }
    const [model] = await app.db
      .update(upstreamModels)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(
          eq(upstreamModels.id, (req.params as { id: string }).id),
          eq(upstreamModels.userId, req.dashboardUser!.id),
        ),
      )
      .returning({ id: upstreamModels.id });
    return model
      ? await getModel(app, req.dashboardUser!.id, model.id)
      : reply.code(404).send({ error: 'Model not found' });
  });
  app.delete('/api/models/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [model] = await app.db
      .delete(upstreamModels)
      .where(and(eq(upstreamModels.id, id), eq(upstreamModels.userId, req.dashboardUser!.id)))
      .returning({ id: upstreamModels.id });
    return model ? { ok: true } : reply.code(404).send({ error: 'Model not found' });
  });

  const safePreset = {
    id: modelPresets.id,
    userId: modelPresets.userId,
    displayName: modelPresets.displayName,
    upstreamModelId: modelPresets.upstreamModelId,
    apiFormat: modelPresets.apiFormat,
    supportsImages: modelPresets.supportsImages,
    supportsReasoning: modelPresets.supportsReasoning,
    maxOutputTokens: modelPresets.maxOutputTokens,
    createdAt: modelPresets.createdAt,
    updatedAt: modelPresets.updatedAt,
  };

  app.get('/api/presets', async (req) =>
    app.db
      .select(safePreset)
      .from(modelPresets)
      .where(or(isNull(modelPresets.userId), eq(modelPresets.userId, req.dashboardUser!.id)))
      .orderBy(
        sql`CASE WHEN ${modelPresets.userId} IS NULL THEN 0 ELSE 1 END`,
        asc(modelPresets.displayName),
      ),
  );
  app.post('/api/presets', async (req, reply) => {
    const input = presetInputSchema.parse(req.body);
    const [preset] = await app.db
      .insert(modelPresets)
      .values({ ...input, userId: req.dashboardUser!.id })
      .returning(safePreset);
    return reply.code(201).send(preset);
  });
  app.delete('/api/presets/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [preset] = await app.db
      .delete(modelPresets)
      .where(and(eq(modelPresets.id, id), eq(modelPresets.userId, req.dashboardUser!.id)))
      .returning({ id: modelPresets.id });
    return preset ? { ok: true } : reply.code(404).send({ error: 'Preset not found' });
  });
  app.post('/api/presets/:presetId/link', async (req, reply) => {
    const presetId = (req.params as { presetId: string }).presetId;
    const input = presetLinkSchema.parse(req.body);
    if (!(await ownsConnection(app, req.dashboardUser!.id, input.providerConnectionId))) {
      return reply.code(403).send({ error: 'Provider connection not found' });
    }
    const [preset] = await app.db
      .select(safePreset)
      .from(modelPresets)
      .where(
        and(
          eq(modelPresets.id, presetId),
          or(isNull(modelPresets.userId), eq(modelPresets.userId, req.dashboardUser!.id)),
        ),
      )
      .limit(1);
    if (!preset) return reply.code(404).send({ error: 'Preset not found' });
    const displayName = input.displayName ?? preset.displayName;
    const [created] = await app.db
      .insert(upstreamModels)
      .values({
        userId: req.dashboardUser!.id,
        displayName,
        gatewayModelId: generateGatewayModelId(displayName),
        upstreamModelId: preset.upstreamModelId,
        providerConnectionId: input.providerConnectionId,
        apiFormat: preset.apiFormat,
        providerBasePath: input.providerBasePath,
        supportsImages: preset.supportsImages as 'yes' | 'no',
        supportsReasoning: preset.supportsReasoning as 'yes' | 'no',
        maxOutputTokens: preset.maxOutputTokens,
      })
      .returning({ id: upstreamModels.id });
    return reply.code(201).send((await getModel(app, req.dashboardUser!.id, created!.id))!);
  });

  app.get('/api/mappings', async (req) => {
    await ensureMappings(app, req.dashboardUser!.id);
    const rows = await app.db
      .select({
        mappingId: mappings.id,
        alias: mappings.alias,
        routeId: mappingRoutes.id,
        modelId: upstreamModels.id,
        enabled: mappingRoutes.enabled,
        position: mappingRoutes.position,
        displayName: upstreamModels.displayName,
        providerConnectionName: providerConnections.displayName,
        gatewayModelId: upstreamModels.gatewayModelId,
        latestTestStatus: upstreamModels.latestTestStatus,
      })
      .from(mappings)
      .leftJoin(mappingRoutes, eq(mappingRoutes.mappingId, mappings.id))
      .leftJoin(upstreamModels, eq(upstreamModels.id, mappingRoutes.upstreamModelId))
      .leftJoin(
        providerConnections,
        eq(providerConnections.id, upstreamModels.providerConnectionId),
      )
      .where(eq(mappings.userId, req.dashboardUser!.id))
      .orderBy(asc(mappingRoutes.position));
    return aliases.map((alias) => ({
      alias,
      routes: rows.filter((r) => r.alias === alias && r.routeId),
    }));
  });
  app.put('/api/mappings/:alias', async (req, reply) => {
    const alias = (req.params as { alias: string }).alias;
    if (!aliases.includes(alias as (typeof aliases)[number]))
      return reply.code(404).send({ error: 'Unknown alias' });
    const input = mappingUpdateSchema.parse(req.body);
    if (new Set(input.routes.map((r) => r.modelId)).size !== input.routes.length)
      return reply.code(400).send({ error: 'Duplicate model in mapping' });
    const owned = input.routes.length
      ? await app.db
          .select({ id: upstreamModels.id })
          .from(upstreamModels)
          .where(
            and(
              eq(upstreamModels.userId, req.dashboardUser!.id),
              inArray(
                upstreamModels.id,
                input.routes.map((r) => r.modelId),
              ),
            ),
          )
      : [];
    if (owned.length !== input.routes.length)
      return reply.code(403).send({ error: 'One or more models are not owned by this account' });
    const mapping = await ensureMapping(app, req.dashboardUser!.id, alias);
    await app.db.transaction(async (tx) => {
      await tx.delete(mappingRoutes).where(eq(mappingRoutes.mappingId, mapping.id));
      if (input.routes.length)
        await tx.insert(mappingRoutes).values(
          input.routes.map((r, position) => ({
            mappingId: mapping.id,
            upstreamModelId: r.modelId,
            enabled: r.enabled,
            position,
          })),
        );
    });
    return { ok: true };
  });

  app.get('/api/models/:id/rules', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await ownsModel(app, req.dashboardUser!.id, id)))
      return reply.code(404).send({ error: 'Model not found' });
    return app.db
      .select()
      .from(transformationRules)
      .where(eq(transformationRules.upstreamModelId, id))
      .orderBy(asc(transformationRules.position));
  });
  app.put('/api/models/:id/rules', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await ownsModel(app, req.dashboardUser!.id, id)))
      return reply.code(404).send({ error: 'Model not found' });
    const rules = ruleInputSchema.array().parse(req.body);
    await app.db.transaction(async (tx) => {
      await tx.delete(transformationRules).where(eq(transformationRules.upstreamModelId, id));
      if (rules.length)
        await tx.insert(transformationRules).values(
          rules.map((r) => ({
            upstreamModelId: id,
            type: r.type,
            position: r.position,
            enabled: r.enabled,
            configJson: r.config,
          })),
        );
    });
    return { ok: true };
  });
  app.get('/api/logs', async (req) => {
    const query = req.query as {
      requestId?: string;
      model?: string;
      status?: string;
      from?: string;
      to?: string;
      cursor?: string;
    };
    const baseConditions = [eq(requestLogs.userId, req.dashboardUser!.id)];
    if (query.requestId) baseConditions.push(eq(requestLogs.requestId, query.requestId));
    if (query.model) baseConditions.push(eq(requestLogs.incomingModel, query.model));
    if (query.status && /^\d{3}$/.test(query.status)) {
      baseConditions.push(eq(requestLogs.status, Number(query.status)));
    }
    if (query.from && !Number.isNaN(Date.parse(query.from))) {
      baseConditions.push(gte(requestLogs.createdAt, new Date(query.from)));
    }
    if (query.to && !Number.isNaN(Date.parse(query.to))) {
      baseConditions.push(lte(requestLogs.createdAt, new Date(query.to)));
    }
    const conditions = [...baseConditions];
    const cursor = decodeLogCursor(query.cursor);
    if (cursor) {
      const cursorCondition = or(
        lt(requestLogs.createdAt, cursor.createdAt),
        and(eq(requestLogs.createdAt, cursor.createdAt), lt(requestLogs.id, cursor.id)),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }
    const pageSize = 50;
    const [totalRow] = await app.db
      .select({ total: sql<number>`count(*)::int` })
      .from(requestLogs)
      .where(and(...baseConditions));
    const total = totalRow?.total ?? 0;
    const pageRows = await app.db
      .select()
      .from(requestLogs)
      .where(and(...conditions))
      .orderBy(desc(requestLogs.createdAt), desc(requestLogs.id))
      .limit(pageSize + 1);
    const items = pageRows.slice(0, pageSize);
    const last = items.at(-1);
    return {
      items,
      pageSize,
      total,
      nextCursor:
        pageRows.length > pageSize && last
          ? encodeLogCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  });
  app.get('/api/setup', async (req) => {
    const mapRows = await app.db
      .select({ alias: mappings.alias, routeId: mappingRoutes.id })
      .from(mappings)
      .leftJoin(
        mappingRoutes,
        and(eq(mappingRoutes.mappingId, mappings.id), eq(mappingRoutes.enabled, true)),
      )
      .where(eq(mappings.userId, req.dashboardUser!.id));
    return {
      baseUrl: app.config.PUBLIC_URL,
      aliases: Object.fromEntries(
        aliases.map((a) => [a, mapRows.some((r) => r.alias === a && r.routeId)]),
      ),
    };
  });
}
function encodeLogCursor(cursor: { createdAt: Date; id: string }) {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
  ).toString('base64url');
}
function decodeLogCursor(value: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    const createdAt = typeof parsed.createdAt === 'string' ? new Date(parsed.createdAt) : undefined;
    if (!createdAt || Number.isNaN(createdAt.getTime()) || typeof parsed.id !== 'string')
      return undefined;
    return { createdAt, id: parsed.id };
  } catch {
    return undefined;
  }
}
async function createSession(
  app: FastifyInstance,
  reply: import('fastify').FastifyReply,
  userId: string,
) {
  const token = randomToken('sess_');
  await app.db.insert(sessions).values({
    userId,
    tokenHash: hashSecret(token),
    expiresAt: new Date(Date.now() + 30 * 86400_000),
  });
  reply.setCookie('gateway_session', token, {
    httpOnly: true,
    secure: app.config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 30 * 86400,
  });
}
async function ownsModel(app: FastifyInstance, userId: string, id: string) {
  return (
    (
      await app.db
        .select({ id: upstreamModels.id })
        .from(upstreamModels)
        .where(and(eq(upstreamModels.id, id), eq(upstreamModels.userId, userId)))
        .limit(1)
    ).length === 1
  );
}
async function ownsConnection(app: FastifyInstance, userId: string, id: string) {
  return (
    (
      await app.db
        .select({ id: providerConnections.id })
        .from(providerConnections)
        .where(and(eq(providerConnections.id, id), eq(providerConnections.userId, userId)))
        .limit(1)
    ).length === 1
  );
}
function listModels(app: FastifyInstance, userId: string) {
  return app.db
    .select(safeModel)
    .from(upstreamModels)
    .innerJoin(providerConnections, eq(providerConnections.id, upstreamModels.providerConnectionId))
    .where(eq(upstreamModels.userId, userId))
    .orderBy(desc(upstreamModels.createdAt));
}
async function getModel(app: FastifyInstance, userId: string, id: string) {
  const [model] = await app.db
    .select(safeModel)
    .from(upstreamModels)
    .innerJoin(providerConnections, eq(providerConnections.id, upstreamModels.providerConnectionId))
    .where(and(eq(upstreamModels.id, id), eq(upstreamModels.userId, userId)))
    .limit(1);
  return model;
}
async function ensureMapping(app: FastifyInstance, userId: string, alias: string) {
  const [existing] = await app.db
    .select()
    .from(mappings)
    .where(and(eq(mappings.userId, userId), eq(mappings.alias, alias)))
    .limit(1);
  if (existing) return existing;
  return (await app.db.insert(mappings).values({ userId, alias }).returning())[0]!;
}
async function ensureMappings(app: FastifyInstance, userId: string) {
  for (const alias of aliases) await ensureMapping(app, userId, alias);
}
