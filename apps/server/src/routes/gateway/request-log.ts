import { sql } from 'drizzle-orm';
import { modelUsageDaily, requestLogs } from '@gateway/db';
import type { FastifyInstance } from 'fastify';

export type LogInsert = typeof requestLogs.$inferInsert;

export async function writeLog(app: FastifyInstance, values: LogInsert) {
  const cacheReported = values.cacheInputTokens != null;
  const cacheForAggregate = values.cacheInputTokens ?? 0;
  await app.db.transaction(async (tx) => {
    await tx.insert(requestLogs).values(values);
    if (!values.resolvedUpstreamModelId) return;
    const usageDate = new Date().toISOString().slice(0, 10);
    await tx
      .insert(modelUsageDaily)
      .values({
        userId: values.userId,
        upstreamModelId: values.resolvedUpstreamModelId,
        usageDate,
        requestCount: 1,
        inputTokens: values.inputTokens ?? 0,
        outputTokens: values.outputTokens ?? 0,
        cacheInputTokens: cacheForAggregate,
        cacheUsageReportedRequestCount: cacheReported ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [
          modelUsageDaily.userId,
          modelUsageDaily.upstreamModelId,
          modelUsageDaily.usageDate,
        ],
        set: {
          requestCount: sql`${modelUsageDaily.requestCount} + 1`,
          inputTokens: sql`${modelUsageDaily.inputTokens} + ${values.inputTokens ?? 0}`,
          outputTokens: sql`${modelUsageDaily.outputTokens} + ${values.outputTokens ?? 0}`,
          cacheInputTokens: sql`${modelUsageDaily.cacheInputTokens} + ${cacheForAggregate}`,
          cacheUsageReportedRequestCount: sql`${modelUsageDaily.cacheUsageReportedRequestCount} + ${cacheReported ? 1 : 0}`,
        },
      });
  });
}
