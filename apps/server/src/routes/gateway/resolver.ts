import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  bindingRoutes,
  bindingTransformationRules,
  cliproxyModelStates,
  connectionTokens,
  mappingRoutes,
  mappings,
  modelBindings,
  modelPresets,
  providerConnections,
} from '@gateway/db';
import { requestContainsImages, type ResolvedModel, type ResolvedModelBase, type Attempt, type Model, type ProviderConnection } from './schema.js';
import type { Rule } from '@gateway/protocol';

const tokenHealthOrder = [
  sql`case ${bindingRoutes.latestTestStatus} when 'healthy' then 0 when 'failed' then 2 else 1 end`,
  asc(bindingRoutes.createdAt),
  asc(bindingRoutes.id),
];

type RuleRow = Pick<
  typeof bindingTransformationRules.$inferSelect,
  'type' | 'enabled' | 'position' | 'configJson'
>;

export function toRule(row: RuleRow): Rule {
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
  const tokens = tokenIds.length
    ? await app.db.select().from(connectionTokens).where(inArray(connectionTokens.id, tokenIds))
    : [];
  const tokenMap = new Map(tokens.map((t) => [t.id, t]));
  return rows.map((row) => ({
    ...row,
    token: row.model.tokenId ? (tokenMap.get(row.model.tokenId) ?? null) : null,
  }));
}

async function attachRules<T extends { resolved: ResolvedModelBase }>(
  app: FastifyInstance,
  entries: T[],
): Promise<Array<Omit<T, 'resolved'> & { resolved: ResolvedModel }>> {
  const bindingIds = [
    ...new Set(
      entries
        .map((entry) => entry.resolved.model.bindingId)
        .filter((id): id is string => id != null),
    ),
  ];
  const ruleRows = bindingIds.length
    ? await app.db
        .select()
        .from(bindingTransformationRules)
        .where(inArray(bindingTransformationRules.bindingId, bindingIds))
        .orderBy(asc(bindingTransformationRules.position))
    : [];
  const rulesByBinding = new Map<string, Rule[]>();
  for (const row of ruleRows) {
    if (!row.bindingId) continue;
    const list = rulesByBinding.get(row.bindingId) ?? [];
    list.push(toRule(row));
    rulesByBinding.set(row.bindingId, list);
  }
  return entries.map((entry) => ({
    ...entry,
    resolved: {
      ...entry.resolved,
      rules: entry.resolved.model.bindingId
        ? (rulesByBinding.get(entry.resolved.model.bindingId) ?? [])
        : [],
    },
  }));
}

export async function resolve(
  app: FastifyInstance,
  userId: string,
  incoming: string,
  request: { messages: unknown[] },
): Promise<{ attempts: Attempt[]; skipped: object[] }> {
  const hasImages = requestContainsImages(request as unknown as Parameters<typeof requestContainsImages>[0]);
  const [mapping] = await app.db
    .select({ id: mappings.id })
    .from(mappings)
    .where(and(eq(mappings.userId, userId), eq(mappings.alias, incoming)))
    .limit(1);
  let models: Array<{ resolved: ResolvedModelBase; position: number }>;
  if (mapping) {
    const rows = await app.db
      .select({ model: bindingRoutes, connection: providerConnections })
      .from(mappingRoutes)
      .innerJoin(modelBindings, eq(modelBindings.id, mappingRoutes.bindingId))
      .innerJoin(modelPresets, eq(modelPresets.id, modelBindings.presetId))
      .innerJoin(bindingRoutes, eq(bindingRoutes.bindingId, modelBindings.id))
      .leftJoin(
        cliproxyModelStates,
        and(
          eq(cliproxyModelStates.cliproxyAccountId, modelBindings.cliproxyAccountId),
          eq(cliproxyModelStates.upstreamModelId, modelPresets.upstreamModelId),
        ),
      )
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, bindingRoutes.providerConnectionId),
      )
      .innerJoin(
        connectionTokens,
        and(
          eq(connectionTokens.id, bindingRoutes.tokenId),
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
            isNull(bindingRoutes.fallbackCooldownUntil),
            lte(bindingRoutes.fallbackCooldownUntil, new Date()),
          ),
          eq(bindingRoutes.enabled, true),
          eq(providerConnections.enabled, true),
        ),
      )
      .orderBy(asc(mappingRoutes.position), ...tokenHealthOrder);
    const resolved = await attachTokens(app, rows);
    models = resolved.map((r, position) => ({ resolved: r, position }));
  } else {
    const rows = await app.db
      .select({ model: bindingRoutes, connection: providerConnections })
      .from(bindingRoutes)
      .leftJoin(modelBindings, eq(modelBindings.id, bindingRoutes.bindingId))
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
        eq(providerConnections.id, bindingRoutes.providerConnectionId),
      )
      .innerJoin(
        connectionTokens,
        and(
          eq(connectionTokens.id, bindingRoutes.tokenId),
          eq(connectionTokens.enabled, true),
          or(
            isNull(connectionTokens.cooldownUntil),
            lte(connectionTokens.cooldownUntil, new Date()),
          ),
        ),
      )
      .where(
        and(
          eq(bindingRoutes.userId, userId),
          eq(bindingRoutes.upstreamModelId, incoming),
          or(
            isNull(cliproxyModelStates.id),
            isNull(cliproxyModelStates.cooldownUntil),
            lte(cliproxyModelStates.cooldownUntil, new Date()),
          ),
          or(
            isNull(bindingRoutes.fallbackCooldownUntil),
            lte(bindingRoutes.fallbackCooldownUntil, new Date()),
          ),
          eq(bindingRoutes.enabled, true),
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
