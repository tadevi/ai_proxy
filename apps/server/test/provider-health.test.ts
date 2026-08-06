import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cliproxyModelStates, connectionTokens, upstreamModels } from '@gateway/db';
import { recordModelSuccess } from '../src/routes/gateway/provider-health.js';

type UpdateCall = { table: unknown; values: Record<string, unknown> };
type DeleteCall = { table: unknown };

function createApp(model: { id: string; tokenId: string | null; bindingId: string | null }) {
  const updates: UpdateCall[] = [];
  const deletes: DeleteCall[] = [];
  let selectCount = 0;

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCount += 1;
            if (selectCount === 1) return [model];
            return [
              {
                cliproxyAccountId: 'account-1',
                upstreamModelId: 'claude-sonnet',
              },
            ];
          },
        }),
        innerJoin: () => ({
          where: () => ({
            limit: async () => [
              {
                cliproxyAccountId: 'account-1',
                upstreamModelId: 'claude-sonnet',
              },
            ],
          }),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, values });
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        deletes.push({ table });
      },
    }),
  };

  return {
    app: { db } as unknown as FastifyInstance,
    updates,
    deletes,
  };
}

describe('recordModelSuccess', () => {
  it('clears model, token, and exact CLIProxy model health state', async () => {
    const { app, updates, deletes } = createApp({
      id: 'model-1',
      tokenId: 'token-1',
      bindingId: 'binding-1',
    });

    await recordModelSuccess(app, 'model-1');

    expect(updates).toHaveLength(2);
    expect(updates[0]?.table).toBe(upstreamModels);
    expect(updates[0]?.values).toMatchObject({
      latestTestStatus: 'healthy',
      latestError: null,
      latestErrorAt: null,
      fallbackCooldownUntil: null,
    });
    expect(updates[1]?.table).toBe(connectionTokens);
    expect(updates[1]?.values).toMatchObject({
      cooldownUntil: null,
      latestError: null,
      latestErrorAt: null,
    });
    expect(updates[1]?.values).not.toHaveProperty('enabled');
    expect(deletes).toEqual([{ table: cliproxyModelStates }]);
  });

  it('does not touch token or CLIProxy state when the model has neither', async () => {
    const { app, updates, deletes } = createApp({
      id: 'model-2',
      tokenId: null,
      bindingId: null,
    });

    await recordModelSuccess(app, 'model-2');

    expect(updates).toHaveLength(1);
    expect(updates[0]?.table).toBe(upstreamModels);
    expect(deletes).toHaveLength(0);
  });
});
