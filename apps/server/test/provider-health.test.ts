import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cliproxyModelStates, connectionTokens, upstreamModels } from '@gateway/db';
import { recordCombinationSuccess } from '../src/routes/gateway/provider-health.js';

type UpdateCall = { table: unknown; values: Record<string, unknown> };
type DeleteCall = { table: unknown };

function createApp() {
  const updates: UpdateCall[] = [];
  const deletes: DeleteCall[] = [];
  let selectCount = 0;

  const db = {
    select: () => {
      selectCount += 1;
      return {
        from: () => ({
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
      };
    },
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
    getSelectCount: () => selectCount,
  };
}

describe('recordCombinationSuccess', () => {
  it('clears the exact model, token, and CLIProxy binding snapshot', async () => {
    const { app, updates, deletes, getSelectCount } = createApp();

    await recordCombinationSuccess(app, {
      id: 'model-used-by-request',
      tokenId: 'token-used-by-request',
      bindingId: 'binding-used-by-request',
    });

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
    expect(getSelectCount()).toBe(1);
  });

  it('does not look up mutable model-token associations after success', async () => {
    const { app, updates, deletes, getSelectCount } = createApp();

    await recordCombinationSuccess(app, {
      id: 'model-2',
      tokenId: null,
      bindingId: null,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.table).toBe(upstreamModels);
    expect(deletes).toHaveLength(0);
    expect(getSelectCount()).toBe(0);
  });
});
