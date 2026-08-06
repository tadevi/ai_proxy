import type { FastifyInstance } from 'fastify';
import { getTableColumns, desc, eq, sql, and, gte, lte, or, lt } from 'drizzle-orm';
import {
  cliproxyAccounts,
  mappingRoutes,
  mappings,
  modelBindings,
  requestLogs,
  upstreamModels,
} from '@gateway/db';
import { aliases } from '@gateway/shared';
import { decodeLogCursor, encodeLogCursor } from './index.js';

export async function registerLogsRoutes(app: FastifyInstance) {
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
        and(
          eq(requestLogs.createdAt, cursor.createdAt),
          lt(requestLogs.id, cursor.id),
        ),
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
      .select({
        ...getTableColumns(requestLogs),
        cliproxyAccountLabel: cliproxyAccounts.label,
        cliproxyAccountPrefix: cliproxyAccounts.prefix,
      })
      .from(requestLogs)
      .leftJoin(upstreamModels, eq(upstreamModels.id, requestLogs.resolvedUpstreamModelId))
      .leftJoin(modelBindings, eq(modelBindings.id, upstreamModels.bindingId))
      .leftJoin(cliproxyAccounts, eq(cliproxyAccounts.id, modelBindings.cliproxyAccountId))
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
        and(
          eq(mappingRoutes.mappingId, mappings.id),
          eq(mappingRoutes.enabled, true),
        ),
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
