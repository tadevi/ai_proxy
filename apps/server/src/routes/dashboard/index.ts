import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import {
  cliproxyAccounts,
  connectionTokens,
  mappings,
  modelBindings,
  modelPresets,
  providerConnections,
  sessions,
  upstreamModels,
} from '@gateway/db';
import { aliases } from '@gateway/shared';
import { hashSecret, isUniqueViolation, randomToken } from '../../security.js';

export const safeConnection = {
  id: providerConnections.id,
  displayName: providerConnections.displayName,
  baseUrl: providerConnections.baseUrl,
  enabled: providerConnections.enabled,
  createdAt: providerConnections.createdAt,
  updatedAt: providerConnections.updatedAt,
};

export function isCliproxyConnection(app: FastifyInstance, baseUrl: string) {
  return (
    !!app.config.CLIPROXY_BASE_URL &&
    baseUrl.replace(/\/$/, '') === app.config.CLIPROXY_BASE_URL.replace(/\/$/, '')
  );
}

export const safeModel = {
  id: upstreamModels.id,
  displayName: upstreamModels.displayName,
  upstreamModelId: upstreamModels.upstreamModelId,
  providerConnectionId: upstreamModels.providerConnectionId,
  providerConnectionName: providerConnections.displayName,
  bindingId: upstreamModels.bindingId,
  tokenId: upstreamModels.tokenId,
  tokenName: connectionTokens.name,
  cliproxyAccountLabel: cliproxyAccounts.label,
  cliproxyAccountPrefix: cliproxyAccounts.prefix,
  tokenEnabled: connectionTokens.enabled,
  tokenCooldownUntil: connectionTokens.cooldownUntil,
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
  latestError: upstreamModels.latestError,
  latestErrorAt: upstreamModels.latestErrorAt,
  createdAt: upstreamModels.createdAt,
  updatedAt: upstreamModels.updatedAt,
};

export function slug(value: string) {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 45) || 'model'
  );
}

export function encodeLogCursor(cursor: { createdAt: Date; id: string }) {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
  ).toString('base64url');
}

export function decodeLogCursor(
  value: string | undefined,
): { createdAt: Date; id: string } | undefined {
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

export async function createSession(
  app: FastifyInstance,
  reply: FastifyReply,
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

export async function ownsModel(app: FastifyInstance, userId: string, id: string) {
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

export async function getOwnedConnection(
  app: FastifyInstance,
  userId: string,
  id: string,
) {
  const [connection] = await app.db
    .select({ id: providerConnections.id, baseUrl: providerConnections.baseUrl })
    .from(providerConnections)
    .where(and(eq(providerConnections.id, id), eq(providerConnections.userId, userId)))
    .limit(1);
  return connection;
}

export async function ownsConnection(app: FastifyInstance, userId: string, id: string) {
  return !!(await getOwnedConnection(app, userId, id));
}

export function listModels(app: FastifyInstance, userId: string) {
  return app.db
    .select(safeModel)
    .from(upstreamModels)
    .innerJoin(
      providerConnections,
      eq(providerConnections.id, upstreamModels.providerConnectionId),
    )
    .leftJoin(connectionTokens, eq(connectionTokens.id, upstreamModels.tokenId))
    .leftJoin(modelBindings, eq(modelBindings.id, upstreamModels.bindingId))
    .leftJoin(cliproxyAccounts, eq(cliproxyAccounts.id, modelBindings.cliproxyAccountId))
    .where(eq(upstreamModels.userId, userId))
    .orderBy(desc(upstreamModels.createdAt));
}

export async function getModel(app: FastifyInstance, userId: string, id: string) {
  const [model] = await app.db
    .select(safeModel)
    .from(upstreamModels)
    .innerJoin(
      providerConnections,
      eq(providerConnections.id, upstreamModels.providerConnectionId),
    )
    .leftJoin(connectionTokens, eq(connectionTokens.id, upstreamModels.tokenId))
    .leftJoin(modelBindings, eq(modelBindings.id, upstreamModels.bindingId))
    .leftJoin(cliproxyAccounts, eq(cliproxyAccounts.id, modelBindings.cliproxyAccountId))
    .where(and(eq(upstreamModels.id, id), eq(upstreamModels.userId, userId)))
    .limit(1);
  return model;
}

export async function createUpstreamModelsForToken(
  app: FastifyInstance,
  userId: string,
  connectionId: string,
  tokenId: string,
) {
  const [token] = await app.db
    .select({ name: connectionTokens.name })
    .from(connectionTokens)
    .where(eq(connectionTokens.id, tokenId))
    .limit(1);
  const [connection] = await app.db
    .select({ displayName: providerConnections.displayName })
    .from(providerConnections)
    .where(eq(providerConnections.id, connectionId))
    .limit(1);
  if (!token || !connection) return;

  const bindings = await app.db
    .select()
    .from(modelBindings)
    .where(eq(modelBindings.connectionId, connectionId));

  for (const binding of bindings) {
    const [preset] = await app.db
      .select()
      .from(modelPresets)
      .where(eq(modelPresets.id, binding.presetId))
      .limit(1);
    if (!preset) continue;
    const [cliproxyAccount] = binding.cliproxyAccountId
      ? await app.db
          .select({ prefix: cliproxyAccounts.prefix })
          .from(cliproxyAccounts)
          .where(eq(cliproxyAccounts.id, binding.cliproxyAccountId))
          .limit(1)
      : [];
    if (binding.cliproxyAccountId && !cliproxyAccount) continue;

    const displayName = `${preset.displayName} (${token.name} @ ${connection.displayName})`;
    try {
      await app.db.insert(upstreamModels).values({
        userId,
        displayName,
        upstreamModelId: cliproxyAccount
          ? `${cliproxyAccount.prefix}/${preset.upstreamModelId}`
          : preset.upstreamModelId,
        providerConnectionId: connectionId,
        bindingId: binding.id,
        tokenId,
        apiFormat: binding.apiFormat,
        providerBasePath: binding.providerBasePath,
        supportsImages: preset.supportsImages as 'yes' | 'no',
        supportsReasoning: preset.supportsReasoning as 'yes' | 'no',
        maxOutputTokens: preset.maxOutputTokens,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
}

export async function createUpstreamModelsForBinding(
  app: FastifyInstance,
  userId: string,
  connectionId: string,
  bindingId: string,
  preset: {
    displayName: string;
    upstreamModelId: string;
    apiFormat: string;
    supportsImages: string;
    supportsReasoning: string;
    maxOutputTokens: number | null;
  },
  apiFormat: string,
  providerBasePath: string,
  cliproxyAccountPrefix: string | undefined,
) {
  const [connection] = await app.db
    .select({ displayName: providerConnections.displayName })
    .from(providerConnections)
    .where(eq(providerConnections.id, connectionId))
    .limit(1);
  if (!connection) return;

  const resolvedModelId = cliproxyAccountPrefix
    ? `${cliproxyAccountPrefix}/${preset.upstreamModelId}`
    : preset.upstreamModelId;

  const tokens = await app.db
    .select({ id: connectionTokens.id, name: connectionTokens.name })
    .from(connectionTokens)
    .where(
      and(
        eq(connectionTokens.connectionId, connectionId),
        eq(connectionTokens.enabled, true),
      ),
    );

  for (const token of tokens) {
    const displayName = `${preset.displayName} (${token.name} @ ${connection.displayName})`;
    try {
      await app.db.insert(upstreamModels).values({
        userId,
        displayName,
        upstreamModelId: resolvedModelId,
        providerConnectionId: connectionId,
        bindingId,
        tokenId: token.id,
        apiFormat: apiFormat as 'openai_compatible' | 'anthropic_compatible',
        providerBasePath,
        supportsImages: preset.supportsImages as 'yes' | 'no',
        supportsReasoning: preset.supportsReasoning as 'yes' | 'no',
        maxOutputTokens: preset.maxOutputTokens,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
}

export async function ensureMapping(app: FastifyInstance, userId: string, alias: string) {
  const [existing] = await app.db
    .select()
    .from(mappings)
    .where(and(eq(mappings.userId, userId), eq(mappings.alias, alias)))
    .limit(1);
  if (existing) return existing;
  return (await app.db.insert(mappings).values({ userId, alias }).returning())[0]!;
}

import { registerAuthRoutes } from './auth-routes.js';
import { registerConnectionRoutes } from './connection-routes.js';
import { registerModelRoutes } from './model-routes.js';
import { registerLogsRoutes } from './logs-routes.js';

export async function dashboardRoutes(app: FastifyInstance) {
  await registerAuthRoutes(app);
  await registerConnectionRoutes(app);
  await registerModelRoutes(app);
  await registerLogsRoutes(app);
}

export async function ensureMappings(app: FastifyInstance, userId: string) {
  for (const alias of aliases) await ensureMapping(app, userId, alias);
}
