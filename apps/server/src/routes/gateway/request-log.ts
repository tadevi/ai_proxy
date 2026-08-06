import { and, eq, sql } from 'drizzle-orm';
import { bindingRoutes, modelUsageDaily, requestLogs } from '@gateway/db';
import type { FastifyInstance } from 'fastify';
import { logWarn } from '../../log.js';
import { maybePruneRequestLogs } from '../../request-log-retention.js';

export type LogInsert = typeof requestLogs.$inferInsert;

export async function writeLog(app: FastifyInstance, values: LogInsert) {
  const cacheReported = values.cacheInputTokens != null;
  const cacheForAggregate = values.cacheInputTokens ?? 0;
  const bindingId = values.resolvedUpstreamModelId
    ? (
        await app.db
          .select({ bindingId: bindingRoutes.bindingId })
          .from(bindingRoutes)
          .where(
            and(
              eq(bindingRoutes.id, values.resolvedUpstreamModelId),
              eq(bindingRoutes.userId, values.userId),
            ),
          )
          .limit(1)
      )[0]?.bindingId
    : undefined;

  await app.db.transaction(async (tx) => {
    await tx.insert(requestLogs).values(values);
    if (!bindingId) return;
    const usageDate = new Date().toISOString().slice(0, 10);
    await tx
      .insert(modelUsageDaily)
      .values({
        userId: values.userId,
        bindingId,
        usageDate,
        requestCount: 1,
        inputTokens: values.inputTokens ?? 0,
        outputTokens: values.outputTokens ?? 0,
        cacheInputTokens: cacheForAggregate,
        cacheUsageReportedRequestCount: cacheReported ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [modelUsageDaily.userId, modelUsageDaily.bindingId, modelUsageDaily.usageDate],
        set: {
          requestCount: sql`${modelUsageDaily.requestCount} + 1`,
          inputTokens: sql`${modelUsageDaily.inputTokens} + ${values.inputTokens ?? 0}`,
          outputTokens: sql`${modelUsageDaily.outputTokens} + ${values.outputTokens ?? 0}`,
          cacheInputTokens: sql`${modelUsageDaily.cacheInputTokens} + ${cacheForAggregate}`,
          cacheUsageReportedRequestCount: sql`${modelUsageDaily.cacheUsageReportedRequestCount} + ${cacheReported ? 1 : 0}`,
        },
      });
  });

  void maybePruneRequestLogs(app)?.catch((error: unknown) =>
    logWarn('request log cleanup failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    }),
  );
}
