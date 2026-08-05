import { createHash, randomBytes } from 'node:crypto';
import type { ProviderReasoningState, ReasoningStateHandle, ReasoningStateScope } from '@gateway/protocol';
import { logWarn } from './log.js';

const DEFAULT_TTL_MS = 30 * 60 * 1_000; // 30 minutes
const MAX_ENTRIES = 10_000;

function fingerprint(handle: string) {
  return createHash('sha256').update(handle).digest('hex').slice(0, 12);
}

export function createReasoningStateStore(
  ttlMs: number = DEFAULT_TTL_MS,
  maxEntries: number = MAX_ENTRIES,
): ReasoningStateHandle {
  const store = new Map<string, { state: ProviderReasoningState; expiresAt: number }>();

  const evictExpired = () => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) {
        store.delete(key);
        logWarn('reasoning.state.evicted', {
          result: 'expired',
          handleFingerprint: fingerprint(key),
        });
      }
    }
  };

  const enforceLimit = () => {
    if (store.size <= maxEntries) return;
    const excess = store.size - maxEntries;
    const keys = store.keys();
    for (let i = 0; i < excess; i++) {
      const next = keys.next();
      if (next.done) break;
      store.delete(next.value);
      logWarn('reasoning.state.evicted', {
        result: 'capacity',
        handleFingerprint: fingerprint(next.value),
      });
    }
  };

  return {
    async store(state: ProviderReasoningState): Promise<string> {
      evictExpired();
      const handle = `proxy:rs_${randomBytes(16).toString('base64url')}`;
      store.set(handle, { state, expiresAt: Date.now() + ttlMs });
      enforceLimit();
      logWarn('reasoning.state.stored', {
        handleFingerprint: fingerprint(handle),
        provider: state.provider,
        format: state.format,
        payloadBytes: Buffer.byteLength(state.data, 'utf8'),
        ttlMs,
        storeSize: store.size,
      });
      return handle;
    },

    async resolve(
      handle: string,
      scope: ReasoningStateScope,
    ): Promise<ProviderReasoningState | null> {
      if (!handle.startsWith('proxy:rs_')) {
        logWarn('reasoning.state.resolve', {
          result: 'invalid_handle',
          handleFingerprint: fingerprint(handle),
        });
        return null;
      }

      const handleFingerprint = fingerprint(handle);
      const entry = store.get(handle);
      if (!entry) {
        logWarn('reasoning.state.resolve', {
          result: 'not_found',
          handleFingerprint,
        });
        return null;
      }
      if (entry.expiresAt <= Date.now()) {
        store.delete(handle);
        logWarn('reasoning.state.resolve', {
          result: 'expired',
          handleFingerprint,
        });
        return null;
      }
      const { state } = entry;
      if (
        state.userId !== scope.userId ||
        state.connectionId !== scope.connectionId ||
        state.upstreamModelId !== scope.upstreamModelId
      ) {
        logWarn('reasoning.state.resolve', {
          result: 'scope_mismatch',
          handleFingerprint,
        });
        return null;
      }

      logWarn('reasoning.state.resolve', {
        result: 'hit',
        handleFingerprint,
        provider: state.provider,
        format: state.format,
        payloadBytes: Buffer.byteLength(state.data, 'utf8'),
      });
      return state;
    },

    async delete(handle: string): Promise<void> {
      const deleted = store.delete(handle);
      logWarn('reasoning.state.deleted', {
        result: deleted ? 'deleted' : 'not_found',
        handleFingerprint: fingerprint(handle),
      });
    },
  };
}
