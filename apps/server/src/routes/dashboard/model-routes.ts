import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  bindingTransformationRules,
  cliproxyAccounts,
  mappingRoutes,
  mappings,
  modelBindings,
  modelPresets,
  modelUsageDaily,
  providerConnections,
  runtimeBindingRoutes,
} from '@gateway/db';
import { aliases } from '@gateway/shared';
import { mappingUpdateSchema, ruleInputSchema } from '@gateway/shared';
import { ensureMapping, ensureMappings, listModels } from './index.js';
import { findIneligibleMappingBindings } from './mapping-eligibility.js';

export async function registerModelRoutes(app: FastifyInstance) {
  app.get('/api/models/usage', async (req) =>
    app.db
      .select({
        upstreamModelId: runtimeBindingRoutes.id,
        requestCount: sql<string>`coalesce(sum(${modelUsageDaily.requestCount}), 0)::text`,
        inputTokens: sql<string>`coalesce(sum(${modelUsageDaily.inputTokens}), 0)::text`,
        outputTokens: sql<string>`coalesce(sum(${modelUsageDaily.outputTokens}), 0)::text`,
        cacheInputTokens: sql<string>`coalesce(sum(${modelUsageDaily.cacheInputTokens}), 0)::text`,
        cacheInputTokensReportedRequests: sql<string>`coalesce(sum(${modelUsageDaily.cacheUsageReportedRequestCount}), 0)::text`,
      })
      .from(modelUsageDaily)
      .innerJoin(
        runtimeBindingRoutes,
        eq(runtimeBindingRoutes.bindingId, modelUsageDaily.bindingId),
      )
      .where(
        and(
          eq(modelUsageDaily.userId, req.dashboardUser!.id),
          eq(runtimeBindingRoutes.userId, req.dashboardUser!.id),
        ),
      )
      .groupBy(runtimeBindingRoutes.id),
  );

  app.get('/api/models', async (req) => listModels(app, req.dashboardUser!.id));

  app.post('/api/models', async (_req, reply) =>
    reply.code(410).send({
      error: 'Direct model-instance creation was removed. Bind a preset to a connection instead.',
    }),
  );

  app.patch('/api/models/:id', async (_req, reply) =>
    reply.code(410).send({
      error: 'Direct model-instance editing was removed. Update the binding or credential instead.',
    }),
  );

  app.delete('/api/models/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [model] = await app.db
      .delete(runtimeBindingRoutes)
      .where(
        and(
          eq(runtimeBindingRoutes.id, id),
          eq(runtimeBindingRoutes.userId, req.dashboardUser!.id),
        ),
      )
      .returning({ id: runtimeBindingRoutes.id });
    return model ? { ok: true } : reply.code(404).send({ error: 'Model not found' });
  });

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

    const enabledBindingIds = input.routes
      .filter((route) => route.enabled)
      .map((route) => route.bindingId);
    const ineligibleBindingIds = await findIneligibleMappingBindings(
      app,
      req.dashboardUser!.id,
      enabledBindingIds,
    );
    if (ineligibleBindingIds.length)
      return reply.code(409).send({
        error: 'One or more enabled bindings have no gateway-eligible runtime route. Test or repair them before saving this mapping.',
        ineligibleBindingIds,
      });

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
    .select({ bindingId: runtimeBindingRoutes.bindingId })
    .from(runtimeBindingRoutes)
    .where(
      and(eq(runtimeBindingRoutes.id, routeId), eq(runtimeBindingRoutes.userId, userId)),
    )
    .limit(1);
  return route?.bindingId ?? undefined;
}
