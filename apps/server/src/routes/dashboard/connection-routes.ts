import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  cliproxyAccounts,
  connectionTokens,
  modelBindingReasoningCodecs,
  modelBindings,
  modelPresets,
  upstreamModels,
  providerConnections,
  type ReasoningCodec,
} from '@gateway/db';
import {
  connectionTokenInputSchema,
  connectionTokenUpdateSchema,
  modelBindingInputSchema,
  presetInputSchema,
  providerConnectionInputSchema,
} from '@gateway/shared';
import {
  encryptCredential,
  isUniqueViolation,
  maskApiKey,
  validateUpstreamUrl,
} from '../../security.js';
import {
  safeConnection,
  isCliproxyConnection,
  getOwnedConnection,
  ownsConnection,
  createUpstreamModelsForToken,
  createUpstreamModelsForBinding,
} from './index.js';

export async function registerConnectionRoutes(app: FastifyInstance) {
  // ── Provider connections ───────────────────────────────────────
  app.get('/api/connections', async (req) => {
    const connections = await app.db
      .select(safeConnection)
      .from(providerConnections)
      .where(eq(providerConnections.userId, req.dashboardUser!.id))
      .orderBy(desc(providerConnections.createdAt));
    return connections.map((connection) => ({
      ...connection,
      isCliproxy: isCliproxyConnection(app, connection.baseUrl),
    }));
  });

  app.post('/api/connections', async (req, reply) => {
    const input = providerConnectionInputSchema.parse(req.body);
    const baseUrl = await validateUpstreamUrl(
      input.baseUrl,
      app.config.ALLOW_PRIVATE_UPSTREAMS,
      app.config.NODE_ENV === 'production',
    );
    const [connection] = await app.db
      .insert(providerConnections)
      .values({ ...input, baseUrl, userId: req.dashboardUser!.id })
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
    const [connection] = await app.db
      .update(providerConnections)
      .set({
        ...input,
        ...(baseUrl ? { baseUrl } : {}),
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
        and(
          eq(providerConnections.id, id),
          eq(providerConnections.userId, req.dashboardUser!.id),
        ),
      )
      .returning({ id: providerConnections.id });
    return connection
      ? { ok: true }
      : reply.code(404).send({ error: 'Provider connection not found' });
  });

  // ── Connection tokens ─────────────────────────────────────────
  const safeToken = {
    id: connectionTokens.id,
    name: connectionTokens.name,
    keyPreview: connectionTokens.keyPreview,
    enabled: connectionTokens.enabled,
    cooldownUntil: connectionTokens.cooldownUntil,
    latestError: connectionTokens.latestError,
    latestErrorAt: connectionTokens.latestErrorAt,
    createdAt: connectionTokens.createdAt,
    updatedAt: connectionTokens.updatedAt,
  };

  app.get('/api/connections/:id/tokens', async (req, reply) => {
    const connectionId = (req.params as { id: string }).id;
    const connection = await getOwnedConnection(app, req.dashboardUser!.id, connectionId);
    if (!connection) return reply.code(404).send({ error: 'Provider connection not found' });
    if (isCliproxyConnection(app, connection.baseUrl))
      return reply.code(403).send({ error: 'CLIProxyAPI credentials are managed by the server' });
    return app.db
      .select(safeToken)
      .from(connectionTokens)
      .where(eq(connectionTokens.connectionId, connectionId))
      .orderBy(desc(connectionTokens.createdAt));
  });

  app.post('/api/connections/:id/tokens', async (req, reply) => {
    const connectionId = (req.params as { id: string }).id;
    const connection = await getOwnedConnection(app, req.dashboardUser!.id, connectionId);
    if (!connection) return reply.code(404).send({ error: 'Provider connection not found' });
    if (isCliproxyConnection(app, connection.baseUrl))
      return reply.code(403).send({ error: 'CLIProxyAPI credentials are managed by the server' });
    const input = connectionTokenInputSchema.parse(req.body);
    const encrypted = encryptCredential(input.apiKey, app.config.CREDENTIAL_ENCRYPTION_KEY);
    const keyPreview = maskApiKey(input.apiKey);
    const { apiKey, ...rest } = input;
    void apiKey;
    try {
      const [token] = await app.db
        .insert(connectionTokens)
        .values({
          ...rest,
          userId: req.dashboardUser!.id,
          connectionId,
          keyPreview,
          ...encrypted,
        })
        .returning(safeToken);
      await createUpstreamModelsForToken(app, req.dashboardUser!.id, connectionId, token!.id);
      return reply.code(201).send(token);
    } catch (error) {
      if (isUniqueViolation(error))
        return reply
          .code(409)
          .send({ error: 'A token with this name already exists on this connection.' });
      throw error;
    }
  });

  app.patch('/api/connections/:id/tokens/:tokenId', async (req, reply) => {
    const connectionId = (req.params as { id: string }).id;
    const tokenId = (req.params as { tokenId: string }).tokenId;
    const connection = await getOwnedConnection(app, req.dashboardUser!.id, connectionId);
    if (!connection) return reply.code(404).send({ error: 'Provider connection not found' });
    if (isCliproxyConnection(app, connection.baseUrl))
      return reply.code(403).send({ error: 'CLIProxyAPI credentials are managed by the server' });
    const input = connectionTokenUpdateSchema.parse(req.body);
    const encrypted = input.apiKey
      ? encryptCredential(input.apiKey, app.config.CREDENTIAL_ENCRYPTION_KEY)
      : {};
    const keyPreview = input.apiKey ? { keyPreview: maskApiKey(input.apiKey) } : {};
    const { apiKey, ...rest } = input;
    void apiKey;
    const [token] = await app.db
      .update(connectionTokens)
      .set({
        ...rest,
        ...encrypted,
        ...keyPreview,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(connectionTokens.id, tokenId),
          eq(connectionTokens.connectionId, connectionId),
          eq(connectionTokens.userId, req.dashboardUser!.id),
        ),
      )
      .returning(safeToken);
    return token ?? reply.code(404).send({ error: 'Token not found' });
  });

  app.delete('/api/connections/:id/tokens/:tokenId', async (req, reply) => {
    const connectionId = (req.params as { id: string }).id;
    const tokenId = (req.params as { tokenId: string }).tokenId;
    const connection = await getOwnedConnection(app, req.dashboardUser!.id, connectionId);
    if (!connection) return reply.code(404).send({ error: 'Provider connection not found' });
    if (isCliproxyConnection(app, connection.baseUrl))
      return reply.code(403).send({ error: 'CLIProxyAPI credentials are managed by the server' });
    await app.db
      .delete(upstreamModels)
      .where(
        and(
          eq(upstreamModels.tokenId, tokenId),
          eq(upstreamModels.userId, req.dashboardUser!.id),
        ),
      );
    const [token] = await app.db
      .delete(connectionTokens)
      .where(
        and(
          eq(connectionTokens.id, tokenId),
          eq(connectionTokens.connectionId, connectionId),
          eq(connectionTokens.userId, req.dashboardUser!.id),
        ),
      )
      .returning({ id: connectionTokens.id });
    return token ? { ok: true } : reply.code(404).send({ error: 'Token not found' });
  });

  // ── Model bindings ────────────────────────────────────────────
  const safeBinding = {
    id: modelBindings.id,
    presetId: modelBindings.presetId,
    presetDisplayName: modelPresets.displayName,
    presetUpstreamModelId: modelPresets.upstreamModelId,
    connectionId: modelBindings.connectionId,
    apiFormat: modelBindings.apiFormat,
    providerBasePath: modelBindings.providerBasePath,
    cliproxyAccountId: modelBindings.cliproxyAccountId,
    cliproxyAccountLabel: cliproxyAccounts.label,
    cliproxyAccountPrefix: cliproxyAccounts.prefix,
    createdAt: modelBindings.createdAt,
    updatedAt: modelBindings.updatedAt,
  };

  app.get('/api/bindings', async (req) =>
    app.db
      .select({
        id: modelBindings.id,
        presetId: modelBindings.presetId,
        presetDisplayName: modelPresets.displayName,
        presetUpstreamModelId: modelPresets.upstreamModelId,
        connectionId: modelBindings.connectionId,
        connectionName: providerConnections.displayName,
        apiFormat: modelBindings.apiFormat,
        providerBasePath: modelBindings.providerBasePath,
        cliproxyAccountId: modelBindings.cliproxyAccountId,
        cliproxyAccountLabel: cliproxyAccounts.label,
        cliproxyAccountPrefix: cliproxyAccounts.prefix,
        createdAt: modelBindings.createdAt,
      })
      .from(modelBindings)
      .innerJoin(modelPresets, eq(modelPresets.id, modelBindings.presetId))
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, modelBindings.connectionId),
      )
      .leftJoin(
        cliproxyAccounts,
        eq(cliproxyAccounts.id, modelBindings.cliproxyAccountId),
      )
      .where(eq(modelBindings.userId, req.dashboardUser!.id))
      .orderBy(desc(modelBindings.createdAt)),
  );

  app.get('/api/connections/:id/bindings', async (req, reply) => {
    const connectionId = (req.params as { id: string }).id;
    if (!(await ownsConnection(app, req.dashboardUser!.id, connectionId)))
      return reply.code(404).send({ error: 'Provider connection not found' });
    return app.db
      .select(safeBinding)
      .from(modelBindings)
      .innerJoin(modelPresets, eq(modelPresets.id, modelBindings.presetId))
      .leftJoin(
        cliproxyAccounts,
        eq(cliproxyAccounts.id, modelBindings.cliproxyAccountId),
      )
      .where(
        and(
          eq(modelBindings.connectionId, connectionId),
          eq(modelBindings.userId, req.dashboardUser!.id),
        ),
      )
      .orderBy(desc(modelBindings.createdAt));
  });

  async function bindOnePreset(
    userId: string,
    connectionId: string,
    presetId: string,
    apiFormatOverride: 'openai_compatible' | 'anthropic_compatible' | undefined,
    providerBasePath: string,
    cliproxyAccountId: string | null | undefined,
    reasoningCodec: ReasoningCodec,
  ) {
    const [preset] = await app.db
      .select()
      .from(modelPresets)
      .where(
        and(
          eq(modelPresets.id, presetId),
          or(isNull(modelPresets.userId), eq(modelPresets.userId, userId)),
        ),
      )
      .limit(1);
    if (!preset) throw new Error('Preset not found');
    const [connection] = await app.db
      .select({ baseUrl: providerConnections.baseUrl })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.id, connectionId),
          eq(providerConnections.userId, userId),
        ),
      )
      .limit(1);
    if (!connection) throw new Error('Provider connection not found');

    const cliproxy = isCliproxyConnection(app, connection.baseUrl);
    if (cliproxy && !cliproxyAccountId)
      throw new Error('Select a CLIProxy account for this binding');
    if (!cliproxy && cliproxyAccountId)
      throw new Error('CLIProxy accounts can only be used with the CLIProxyAPI connection');

    const [cliproxyAccount] = cliproxyAccountId
      ? await app.db
          .select({ id: cliproxyAccounts.id, prefix: cliproxyAccounts.prefix })
          .from(cliproxyAccounts)
          .where(
            and(
              eq(cliproxyAccounts.id, cliproxyAccountId),
              eq(cliproxyAccounts.userId, userId),
            ),
          )
          .limit(1)
      : [];
    if (cliproxyAccountId && !cliproxyAccount) throw new Error('CLIProxy account not found');

    const apiFormat = apiFormatOverride ?? preset.apiFormat;
    if ((cliproxy || apiFormat !== 'openai_compatible') && reasoningCodec !== 'auto')
      throw new Error(
        'Reasoning codec only applies to external OpenAI-compatible bindings',
      );

    let inserted: typeof modelBindings.$inferSelect | undefined;
    try {
      [inserted] = await app.db
        .insert(modelBindings)
        .values({
          userId,
          presetId,
          connectionId,
          apiFormat,
          providerBasePath,
          cliproxyAccountId: cliproxyAccount?.id ?? null,
        })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error))
        throw new Error(
          'This preset is already bound to this connection with the same API format.',
        );
      throw error;
    }

    if (!cliproxy && apiFormat === 'openai_compatible') {
      await app.db.insert(modelBindingReasoningCodecs).values({
        bindingId: inserted!.id,
        codec: reasoningCodec,
      });
    }

    const binding = {
      ...inserted!,
      presetDisplayName: preset.displayName,
      presetUpstreamModelId: preset.upstreamModelId,
    };
    await createUpstreamModelsForBinding(
      app,
      userId,
      connectionId,
      binding.id,
      preset,
      apiFormat,
      providerBasePath,
      cliproxyAccount?.prefix,
    );
    return binding;
  }

  app.post('/api/connections/:id/bindings', async (req, reply) => {
    const connectionId = (req.params as { id: string }).id;
    if (!(await ownsConnection(app, req.dashboardUser!.id, connectionId)))
      return reply.code(404).send({ error: 'Provider connection not found' });
    const input = modelBindingInputSchema.parse(req.body);

    const results = await Promise.allSettled(
      input.presetIds.map((presetId) =>
        bindOnePreset(
          req.dashboardUser!.id,
          connectionId,
          presetId,
          input.apiFormat,
          input.providerBasePath,
          input.cliproxyAccountId,
          input.reasoningCodec,
        ),
      ),
    );
    const bound = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const failed = input.presetIds.flatMap((presetId, i) => {
      const r = results[i]!;
      return r.status === 'rejected'
        ? [{ presetId, error: r.reason instanceof Error ? r.reason.message : 'Bind failed' }]
        : [];
    });
    if (bound.length === 0) return reply.code(409).send({ bound, failed });
    return reply.code(failed.length ? 207 : 201).send({ bound, failed });
  });

  app.delete('/api/connections/:id/bindings/:bindingId', async (req, reply) => {
    const connectionId = (req.params as { id: string }).id;
    const bindingId = (req.params as { bindingId: string }).bindingId;
    if (!(await ownsConnection(app, req.dashboardUser!.id, connectionId)))
      return reply.code(404).send({ error: 'Provider connection not found' });
    const [binding] = await app.db
      .delete(modelBindings)
      .where(
        and(
          eq(modelBindings.id, bindingId),
          eq(modelBindings.connectionId, connectionId),
          eq(modelBindings.userId, req.dashboardUser!.id),
        ),
      )
      .returning({ id: modelBindings.id });
    return binding ? { ok: true } : reply.code(404).send({ error: 'Binding not found' });
  });

  // ── Presets ─────────────────────────────────────────────────
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
      .where(
        or(isNull(modelPresets.userId), eq(modelPresets.userId, req.dashboardUser!.id)),
      )
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
}
