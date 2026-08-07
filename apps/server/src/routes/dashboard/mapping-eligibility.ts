import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import {
  bindingModelConfigs,
  cliproxyModelStates,
  connectionTokens,
  providerConnections,
  runtimeBindingRoutes,
} from '@gateway/db';

export async function findIneligibleMappingBindings(
  app: FastifyInstance,
  userId: string,
  bindingIds: string[],
) {
  if (!bindingIds.length) return [];

  const now = new Date();
  const eligible = await app.db
    .selectDistinct({ id: bindingModelConfigs.id })
    .from(bindingModelConfigs)
    .innerJoin(
      runtimeBindingRoutes,
      and(
        eq(runtimeBindingRoutes.bindingId, bindingModelConfigs.id),
        eq(runtimeBindingRoutes.enabled, true),
        or(
          isNull(runtimeBindingRoutes.fallbackCooldownUntil),
          lte(runtimeBindingRoutes.fallbackCooldownUntil, now),
        ),
      ),
    )
    .innerJoin(
      providerConnections,
      and(
        eq(providerConnections.id, bindingModelConfigs.connectionId),
        eq(providerConnections.enabled, true),
      ),
    )
    .innerJoin(
      connectionTokens,
      and(
        eq(connectionTokens.id, runtimeBindingRoutes.tokenId),
        eq(connectionTokens.enabled, true),
        or(isNull(connectionTokens.cooldownUntil), lte(connectionTokens.cooldownUntil, now)),
      ),
    )
    .leftJoin(
      cliproxyModelStates,
      and(
        eq(cliproxyModelStates.cliproxyAccountId, bindingModelConfigs.cliproxyAccountId),
        eq(cliproxyModelStates.upstreamModelId, bindingModelConfigs.upstreamModelId),
      ),
    )
    .where(
      and(
        eq(bindingModelConfigs.userId, userId),
        inArray(bindingModelConfigs.id, bindingIds),
        or(
          isNull(cliproxyModelStates.id),
          isNull(cliproxyModelStates.cooldownUntil),
          lte(cliproxyModelStates.cooldownUntil, now),
        ),
      ),
    );

  const eligibleIds = new Set(eligible.map((row) => row.id));
  return bindingIds.filter((id) => !eligibleIds.has(id));
}
