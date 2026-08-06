import { and, eq, sql } from 'drizzle-orm';
import {
  bindingRoutes,
  cliproxyModelStates,
  connectionTokens,
  modelBindings,
} from '@gateway/db';
import type { FastifyInstance } from 'fastify';
import { logWarn } from '../../log.js';
import { cooldownDurationMs, type Model, type UpstreamFailure } from './schema.js';

export type SuccessfulCombination = Pick<Model, 'id' | 'tokenId' | 'bindingId'>;

export async function recordCombinationSuccess(
  app: FastifyInstance,
  combination: SuccessfulCombination,
) {
  const now = new Date();
  await app.db
    .update(bindingRoutes)
    .set({
      latestTestStatus: 'healthy',
      latestTestAt: now,
      latestError: null,
      latestErrorAt: null,
      fallbackCooldownUntil: null,
      updatedAt: now,
    })
    .where(eq(bindingRoutes.id, combination.id));

  if (combination.tokenId) {
    await app.db
      .update(connectionTokens)
      .set({
        cooldownUntil: null,
        latestError: null,
        latestErrorAt: null,
        updatedAt: now,
      })
      .where(eq(connectionTokens.id, combination.tokenId));
  }

  await clearCliproxyModelCooldown(app, combination);
}

export async function recordModelFailure(
  app: FastifyInstance,
  modelId: string,
  failure: UpstreamFailure,
) {
  await app.db
    .update(bindingRoutes)
    .set({
      latestTestStatus: 'failed',
      latestTestAt: new Date(),
      latestError: failure.providerError ?? {
        upstreamStatus: failure.status,
        errorCategory: failure.category,
        message: failure.message,
      },
      latestErrorAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bindingRoutes.id, modelId));
}

export async function placeTokenInCooldown(
  app: FastifyInstance,
  tokenId: string,
  failure: UpstreamFailure,
) {
  const cooldownUntil = new Date(Date.now() + cooldownDurationMs);
  await app.db
    .update(connectionTokens)
    .set({
      cooldownUntil,
      latestError: failure.providerError ?? null,
      latestErrorAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(connectionTokens.id, tokenId));
  logWarn('token placed in cooldown after upstream quota or access failure', {
    tokenId,
    cooldownUntil: cooldownUntil.toISOString(),
  });
}

export async function disableToken(
  app: FastifyInstance,
  tokenId: string,
  failure: UpstreamFailure,
) {
  await app.db
    .update(connectionTokens)
    .set({
      enabled: false,
      latestError: failure.providerError ?? null,
      latestErrorAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(connectionTokens.id, tokenId));
  logWarn('token auto-disabled after upstream payment or auth failure', {
    tokenId,
    status: failure.status,
  });
}

export async function setModelFallbackCooldown(
  app: FastifyInstance,
  modelId: string,
  durationMs: number,
) {
  const until = new Date(Date.now() + durationMs);
  await app.db
    .update(bindingRoutes)
    .set({ fallbackCooldownUntil: until, updatedAt: new Date() })
    .where(eq(bindingRoutes.id, modelId));
}

async function cliproxyModelKey(app: FastifyInstance, model: Pick<Model, 'bindingId'>) {
  if (!model.bindingId) return undefined;
  const [key] = await app.db
    .select({
      cliproxyAccountId: modelBindings.cliproxyAccountId,
      upstreamModelId: sql<string>`${modelBindings}."upstream_model_id"`,
    })
    .from(modelBindings)
    .where(eq(modelBindings.id, model.bindingId))
    .limit(1);
  return key?.cliproxyAccountId ? key : undefined;
}

export async function cooldownCliproxyModel(
  app: FastifyInstance,
  model: Model,
  failure: UpstreamFailure,
) {
  const key = await cliproxyModelKey(app, model);
  if (!key) return false;

  const now = new Date();
  const cooldownUntil = new Date(now.getTime() + cooldownDurationMs);
  await app.db
    .insert(cliproxyModelStates)
    .values({
      cliproxyAccountId: key.cliproxyAccountId!,
      upstreamModelId: key.upstreamModelId,
      cooldownUntil,
      latestError: failure.providerError ?? null,
      latestErrorAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [cliproxyModelStates.cliproxyAccountId, cliproxyModelStates.upstreamModelId],
      set: {
        cooldownUntil,
        latestError: failure.providerError ?? null,
        latestErrorAt: now,
        updatedAt: now,
      },
    });
  logWarn('CLIProxy model placed in cooldown after upstream credential cooldown', {
    resolvedUpstreamModelId: model.id,
    cliproxyAccountId: key.cliproxyAccountId,
    cliproxyUpstreamModelId: key.upstreamModelId,
    cooldownUntil: cooldownUntil.toISOString(),
  });
  return true;
}

export async function clearCliproxyModelCooldown(
  app: FastifyInstance,
  model: Pick<Model, 'bindingId'>,
) {
  const key = await cliproxyModelKey(app, model);
  if (!key) return false;
  await app.db
    .delete(cliproxyModelStates)
    .where(
      and(
        eq(cliproxyModelStates.cliproxyAccountId, key.cliproxyAccountId!),
        eq(cliproxyModelStates.upstreamModelId, key.upstreamModelId),
      ),
    );
  return true;
}
