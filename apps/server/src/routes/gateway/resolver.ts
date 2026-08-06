import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  cliproxyModelStates,
  connectionTokens,
  mappingRoutes,
  mappings,
  modelBindingReasoningCodecs,
  modelBindings,
  modelPresets,
  providerConnections,
  transformationRules,
  upstreamModels,
} from '@gateway/db';
import {
  requestContainsImages,
  type ResolvedModel,
  type ResolvedModelBase,
  type Attempt,
  type Model,
  type ProviderConnection,
} from './schema.js';
import type { Rule } from '@gateway/protocol';

const tokenHealthOrder = [
  sql`case ${upstreamModels.latestTestStatus} when 'healthy' then 0 when 'failed' then 2 else 1 end`,
  asc(upstreamModels.createdAt),
  asc(upstreamModels.id),
];

export function toRule(row: typeof transformationRules.$inferSelect): Rule {
  return {
    type: row.type,
    enabled: row.enabled,
    position: row.position,
    config: row.configJson as Record<string, unknown>,
  };
}

async function attachTokens(
  app: FastifyInstance,
  rows: Array<{ model: Model; connection: ProviderConnection }>,
): Promise<ResolvedModelBase[]> {
  const tokenIds = [
    ...new Set(rows.map((r) => r.model.tokenId).filter((id): id is string => id != null)),
  ];
  const bindingIds = [
    ...new Set(rows.map((r) => r.model.bindingId).filter((id): id is string => id != null)),
  ];
  const [tokens, codecRows] = await Promise.all([
    tokenIds.length
      ? app.db.select().from(connectionTokens).where(inArray(connectionTokens.id, tokenIds))
      : [],
    bindingIds.length
      ? app.db
          .select()
          .from(modelBindingReasoningCodecs)
          .where(inArray(modelBindingReasoningCodecs.bindingId, bindingIds))
      : [],
  ]);
  const tokenMap = new Map(tokens.map((t) => [t.id, t]));
  const codecMap = new Map(codecRows.map((row) => [row.bindingId, row.codec]));
  return rows.map((row) => ({
    ...row,
    token: row.model.tokenId ? (tokenMap.get(row.model.tokenId) ?? null) : null,
    reasoningCodec: row.model.bindingId ? (codecMap.get(row.model.bindingId) ?? 'auto') : 'auto',
  }));
}

async function attachRules<T extends { resolved: ResolvedModelBase }>(
  app: FastifyInstance,
  entries: T[],
): Promise<Array<Omit<T, 'resolved'> & { resolved: ResolvedModel }>> {
  const modelIds = [...new Set(entries.map((e) => e.resolved.model.id))];
  const ruleRows = modelIds.length
    ? await app.db
        .select()
        .from(transformationRules)
        .where(inArray(transformationRules.upstreamModelId, modelIds))
        .orderBy(asc(transformationRules.position))
    : [];
  const rulesByModel = new Map<string, Rule[]>();
  for (const row of ruleRows) {
    const list = rulesByModel.get(row.upstreamModelId) ?? [];
    list.push(toRule(row));
    rulesByModel.set(row.upstreamModelId, list);
  }
  return entries.map((e) => ({
    ...e,
    resolved: { ...e.resolved, rules: rulesByModel.get(e.resolved.model.id) ?? [] },
  }));
}

export async function resolve(
  app: FastifyInstance,
  userId: string,
  incoming: string,
  request: { messages: unknown[] },
): Promise<{ attempts: Attempt[]; skipped: object[] }> {
  const hasImages = requestContainsImages(
    request as unknown as Parameters<typeof requestContainsImages>[0],
  );
  const [mapping] = await app.db
    .select({ id: mappings.id })
    .from(mappings)
    .where(and(eq(mappings.userId, userId), eq(mappings.alias, incoming)))
    .limit(1);
  let models: Array<{ resolved: ResolvedModelBase; position: number }>;
  if (mapping) {
    const rows = await app.db
      .select({ model: upstreamModels, connection: providerConnections })
      .from(mappingRoutes)
      .innerJoin(modelBindings, eq(modelBindings.id, mappingRoutes.bindingId))
      .innerJoin(modelPresets, eq(modelPresets.id, modelBindings.presetId))
      .innerJoin(upstreamModels, eq(upstreamModels.bindingId, modelBindings.id))
      .leftJoin(
        cliproxyModelStates,
        and(
          eq(cliproxyModelStates.cliproxyAccountId, modelBindings.cliproxyAccountId),
          eq(cliproxyModelStates.upstreamModelId, modelPresets.upstreamModelId),
        ),
      )
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, upstreamModels.providerConnectionId),
      )
      .innerJoin(
        connectionTokens,
        and(
          eq(connectionTokens.id, upstreamModels.tokenId),
          eq(connectionTokens.enabled, true),
          or(
            isNull(connectionTokens.cooldownUntil),
            lte(connectionTokens.cooldownUntil, new Date()),
          ),
        ),
      )
      .where(
        and(
          eq(mappingRoutes.mappingId, mapping.id),
          eq(mappingRoutes.enabled, true),
          or(
            isNull(cliproxyModelStates.id),
            isNull(cliproxyModelStates.cooldownUntil),
            lte(cliproxyModelStates.cooldownUntil, new Date()),
          ),
          or(
            isNull(upstreamModels.fallbackCooldownUntil),
            lte(upstreamModels.fallbackCooldownUntil, new Date()),
          ),
          eq(upstreamModels.enabled, true),
          eq(providerConnections.enabled, true),
        ),
      )
      .orderBy(asc(mappingRoutes.position), ...tokenHealthOrder);
    const resolved = await attachTokens(app, rows);
    models = resolved.map((r, position) => ({ resolved: r, position }));
  } else {
    const rows = await app.db
      .select({ model: upstreamModels, connection: providerConnections })
      .from(upstreamModels)
      .leftJoin(modelBindings, eq(modelBindings.id, upstreamModels.bindingId))
      .leftJoin(modelPresets, eq(modelPresets.id, modelBindings.presetId))
      .leftJoin(
        cliproxyModelStates,
        and(
          eq(cliproxyModelStates.cliproxyAccountId, modelBindings.cliproxyAccountId),
          eq(cliproxyModelStates.upstreamModelId, modelPresets.upstreamModelId),
        ),
      )
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, upstreamModels.providerConnectionId),
      )
      .innerJoin(
        connectionTokens,
        and(
          eq(connectionTokens.id, upstreamModels.tokenId),
          eq(connectionTokens.enabled, true),
          or(
            isNull(connectionTokens.cooldownUntil),
            lte(connectionTokens.cooldownUntil, new Date()),
          ),
        ),
      )
      .where(
        and(
          eq(upstreamModels.userId, userId),
          eq(upstreamModels.upstreamModelId, incoming),
          or(
            isNull(cliproxyModelStates.id),
            isNull(cliproxyModelStates.cooldownUntil),
            lte(cliproxyModelStates.cooldownUntil, new Date()),
          ),
          or(
            isNull(upstreamModels.fallbackCooldownUntil),
            lte(upstreamModels.fallbackCooldownUntil, new Date()),
          ),
          eq(upstreamModels.enabled, true),
          eq(providerConnections.enabled, true),
        ),
      )
      .orderBy(...tokenHealthOrder);
    const resolved = await attachTokens(app, rows);
    models = resolved.map((r, position) => ({ resolved: r, position }));
  }
  const withRules = await attachRules(app, models);
  const skipped: object[] = [];
  const attempts: Attempt[] = [];
  for (const row of withRules) {
    const reason =
      hasImages && row.resolved.model.supportsImages !== 'yes'
        ? row.resolved.model.supportsImages === 'no'
          ? 'images_unsupported'
          : 'images_capability_unknown'
        : null;
    if (reason) skipped.push({ upstreamModelId: row.resolved.model.upstreamModelId, reason });
    else attempts.push({ resolved: row.resolved, routeIndex: row.position });
  }
  return { attempts, skipped };
}
