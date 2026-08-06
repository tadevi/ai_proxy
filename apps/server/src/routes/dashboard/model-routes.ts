import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  bindingRoutes,
  bindingTransformationRules,
  cliproxyAccounts,
  connectionTokens,
  mappingRoutes,
  mappings,
  modelBindings,
  modelPresets,
  modelUsageDaily,
  providerConnections,
} from '@gateway/db';
import { aliases } from '@gateway/shared';
import {
  modelInputSchema,
  mappingUpdateSchema,
  ruleInputSchema,
} from '@gateway/shared';
import { isUniqueViolation } from '../../security.js';
import {
  safeModel,
  ownsModel,
  getModel,
  ensureMapping,
  ensureMappings,
} from './index.js';

export async function registerModelRoutes(app: FastifyInstance) {
  app.get('/api/models/usage', async (req) =>
    app.db
      .select({
        upstreamModelId: bindingRoutes.id,
        requestCount: sql<string>`coalesce(sum(${modelUsageDaily.requestCount}), 0)::text`,
        inputTokens: sql<string>`coalesce(sum(${modelUsageDaily.inputTokens}), 0)::text`,
        outputTokens: sql<string>`coalesce(sum(${modelUsageDaily.outputTokens}), 0)::text`,
        cacheInputTokens: sql<string>`coalesce(sum(${modelUsageDaily.cacheInputTokens}), 0)::text`,
        cacheInputTokensReportedRequests: sql<string>`coalesce(sum(${modelUsageDaily.cacheUsageReportedRequestCount}), 0)::text`,
      })
      .from(modelUsageDaily)
      .innerJoin(bindingRoutes, eq(bindingRoutes.bindingId, modelUsageDaily.bindingId))
      .where(
        and(
          eq(modelUsageDaily.userId, req.dashboardUser!.id),
          eq(bindingRoutes.userId, req.dashboardUser!.id),
        ),
      )
      .groupBy(bindingRoutes.id),
  );

  app.get('/api/models', async (req) => getModelList(app, req.dashboardUser!.id));

  app.post('/api/models', async (req, reply) => {
    const input = modelInputSchema.parse(req.body);
    if (!(await ownsConnection(app, req.dashboardUser!.id, input.providerConnectionId))) {
      return reply.code(403).send({ error: 'Provider connection not found' });
    }
    try {
      const [created] = await app.db
        .insert(bindingRoutes)
        .values({
          ...input,
          userId: req.dashboardUser!.id,
        })
        .returning({ id: bindingRoutes.id });
      return reply.code(201).send((await getModel(app, req.dashboardUser!.id, created!.id))!);
    } catch (error) {
      if (isUniqueViolation(error))
        return reply
          .code(409)
          .send({ error: 'This upstream model ID already exists on this connection.' });
      throw error;
    }
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
      .update(bindingRoutes)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(
          eq(bindingRoutes.id, (req.params as { id: string }).id),
          eq(bindingRoutes.userId, req.dashboardUser!.id),
        ),
      )
      .returning({ id: bindingRoutes.id });
    return model
      ? await getModel(app, req.dashboardUser!.id, model.id)
      : reply.code(404).send({ error: 'Model not found' });
  });

  app.delete('/api/models/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [model] = await app.db
      .delete(bindingRoutes)
      .where(
        and(eq(bindingRoutes.id, id), eq(bindingRoutes.userId, req.dashboardUser!.id)),
      )
      .returning({ id: bindingRoutes.id });
    return model ? { ok: true } : reply.code(404).send({ error: 'Model not found' });
  });

  // ── Binding-owned transformation rules ───────────────────────
  app.get('/api/models/:id/rules', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const bindingId = await ownedBindingIdForRoute(app, req.dashboardUser!.id, id);
    if (!bindingId) return reply.code(404).send({ error: 'Model binding not found' });
    return app.db
      .select()
      .from(bindingTransformationRules)
      .where(eq(bindingTransformationRules.bindingId, bindingId))
      .orderBy(asc(bindingTransformationRules.position));
  });

  app.put('/api/models/:id/rules', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const bindingId = await ownedBindingIdForRoute(app, req.dashboardUser!.id, id);
    if (!bindingId) return reply.code(404).send({ error: 'Model binding not found' });
    const rules = ruleInputSchema.array().parse(req.body);
    await app.db.transaction(async (tx) => {
      await tx
        .delete(bindingTransformationRules)
        .where(eq(bindingTransformationRules.bindingId, bindingId));
      if (rules.length)
        await tx.insert(bindingTransformationRules).values(
          rules.map((rule) => ({
            bindingId,
            upstreamModelId: id,
            type: rule.type,
            position: rule.position,
            enabled: rule.enabled,
            configJson: rule.config,
          })),
        );
    });
    return { ok: true };
  });

  // ── Mappings ──────────────────────────────────────────────────
  app.get('/api/mappings', async (req) => {
    await ensureMappings(app, req.dashboardUser!.id);
    const rows = await app.db
      .select({
        mappingId: mappings.id,
        alias: mappings.alias,
        routeId: mappingRoutes.id,
        bindingId: modelBindings.id,
        enabled: mappingRoutes.enabled,
        position: mappingRoutes.position,
        presetDisplayName: modelPresets.displayName,
        presetUpstreamModelId: modelPresets.upstreamModelId,
        providerConnectionName: providerConnections.displayName,
        cliproxyAccountLabel: cliproxyAccounts.label,
        cliproxyAccountPrefix: cliproxyAccounts.prefix,
        apiFormat: modelBindings.apiFormat,
      })
      .from(mappings)
      .leftJoin(mappingRoutes, eq(mappingRoutes.mappingId, mappings.id))
      .leftJoin(modelBindings, eq(modelBindings.id, mappingRoutes.bindingId))
      .leftJoin(modelPresets, eq(modelPresets.id, modelBindings.presetId))
      .leftJoin(
        providerConnections,
        eq(providerConnections.id, modelBindings.connectionId),
      )
      .leftJoin(
        cliproxyAccounts,
        eq(cliproxyAccounts.id, modelBindings.cliproxyAccountId),
      )
      .where(eq(mappings.userId, req.dashboardUser!.id))
      .orderBy(asc(mappingRoutes.position));
    return aliases.map((alias) => ({
      alias,
      routes: rows.filter((row) => row.alias === alias && row.routeId),
    }));
  });

  app.put('/api/mappings/:alias', async (req, reply) => {
    const alias = (req.params as { alias: string }).alias;
    if (!aliases.includes(alias as (typeof aliases)[number]))
      return reply.code(404).send({ error: 'Unknown alias' });
    const input = mappingUpdateSchema.parse(req.body);
    if (new Set(input.routes.map((route) => route.bindingId)).size !== input.routes.length)
      return reply.code(400).send({ error: 'Duplicate binding in mapping' });
    const owned = input.routes.length
      ? await app.db
          .select({ id: modelBindings.id })
          .from(modelBindings)
          .where(
            and(
              eq(modelBindings.userId, req.dashboardUser!.id),
              inArray(
                modelBindings.id,
                input.routes.map((route) => route.bindingId),
              ),
            ),
          )
      : [];
    if (owned.length !== input.routes.length)
      return reply.code(403).send({ error: 'One or more bindings are not owned by this account' });
    const mapping = await ensureMapping(app, req.dashboardUser!.id, alias);
    await app.db.transaction(async (tx) => {
      await tx.delete(mappingRoutes).where(eq(mappingRoutes.mappingId, mapping.id));
      if (input.routes.length)
        await tx.insert(mappingRoutes).values(
          input.routes.map((route, position) => ({
            mappingId: mapping.id,
            bindingId: route.bindingId,
            enabled: route.enabled,
            position,
          })),
        );
    });
    return { ok: true };
  });
}

async function ownedBindingIdForRoute(app: FastifyInstance, userId: string, routeId: string) {
  const [route] = await app.db
    .select({ bindingId: bindingRoutes.bindingId })
    .from(bindingRoutes)
    .where(and(eq(bindingRoutes.id, routeId), eq(bindingRoutes.userId, userId)))
    .limit(1);
  return route?.bindingId ?? undefined;
}

async function getModelList(app: FastifyInstance, userId: string) {
  return app.db
    .select(safeModel)
    .from(bindingRoutes)
    .innerJoin(
      providerConnections,
      eq(providerConnections.id, bindingRoutes.providerConnectionId),
    )
    .leftJoin(connectionTokens, eq(connectionTokens.id, bindingRoutes.tokenId))
    .leftJoin(modelBindings, eq(modelBindings.id, bindingRoutes.bindingId))
    .leftJoin(cliproxyAccounts, eq(cliproxyAccounts.id, modelBindings.cliproxyAccountId))
    .where(eq(bindingRoutes.userId, userId))
    .orderBy(desc(bindingRoutes.createdAt));
}

async function ownsConnection(app: FastifyInstance, userId: string, id: string) {
  return !!(
    await app.db
      .select({ id: providerConnections.id })
      .from(providerConnections)
      .where(
        and(eq(providerConnections.id, id), eq(providerConnections.userId, userId)),
      )
      .limit(1)
  ).length;
}
