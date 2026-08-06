import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  modelBindingReasoningCodecs,
  modelBindings,
  modelPresets,
  providerConnections,
} from '@gateway/db';
import { z } from 'zod';
import { isCliproxyConnection } from './index.js';

const codecSchema = z.enum(['auto', 'reasoning_details', 'reasoning_content']);

export async function registerReasoningCodecRoutes(app: FastifyInstance) {
  app.get('/api/reasoning-bindings', async (req) => {
    const rows = await app.db
      .select({
        id: modelBindings.id,
        connectionId: modelBindings.connectionId,
        connectionName: providerConnections.displayName,
        connectionBaseUrl: providerConnections.baseUrl,
        presetDisplayName: modelPresets.displayName,
        presetUpstreamModelId: modelPresets.upstreamModelId,
        apiFormat: modelBindings.apiFormat,
        cliproxyAccountId: modelBindings.cliproxyAccountId,
        codec: modelBindingReasoningCodecs.codec,
      })
      .from(modelBindings)
      .innerJoin(modelPresets, eq(modelPresets.id, modelBindings.presetId))
      .innerJoin(providerConnections, eq(providerConnections.id, modelBindings.connectionId))
      .leftJoin(
        modelBindingReasoningCodecs,
        eq(modelBindingReasoningCodecs.bindingId, modelBindings.id),
      )
      .where(
        and(
          eq(modelBindings.userId, req.dashboardUser!.id),
          eq(modelBindings.apiFormat, 'openai_compatible'),
          isNull(modelBindings.cliproxyAccountId),
        ),
      )
      .orderBy(desc(modelBindings.createdAt));

    return rows
      .filter((row) => !isCliproxyConnection(app, row.connectionBaseUrl))
      .map(({ connectionBaseUrl: _baseUrl, ...row }) => ({ ...row, codec: row.codec ?? 'auto' }));
  });

  app.patch('/api/reasoning-bindings/:id', async (req, reply) => {
    const bindingId = (req.params as { id: string }).id;
    const { codec } = z.object({ codec: codecSchema }).parse(req.body);
    const [binding] = await app.db
      .select({
        id: modelBindings.id,
        apiFormat: modelBindings.apiFormat,
        cliproxyAccountId: modelBindings.cliproxyAccountId,
        baseUrl: providerConnections.baseUrl,
      })
      .from(modelBindings)
      .innerJoin(providerConnections, eq(providerConnections.id, modelBindings.connectionId))
      .where(
        and(
          eq(modelBindings.id, bindingId),
          eq(modelBindings.userId, req.dashboardUser!.id),
        ),
      )
      .limit(1);
    if (!binding) return reply.code(404).send({ error: 'Model binding not found' });
    if (
      binding.apiFormat !== 'openai_compatible' ||
      binding.cliproxyAccountId ||
      isCliproxyConnection(app, binding.baseUrl)
    )
      return reply.code(400).send({ error: 'Reasoning codec only applies to external OpenAI-compatible bindings' });

    const [saved] = await app.db
      .insert(modelBindingReasoningCodecs)
      .values({ bindingId, codec, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: modelBindingReasoningCodecs.bindingId,
        set: { codec, updatedAt: new Date() },
      })
      .returning();
    return saved;
  });
}
