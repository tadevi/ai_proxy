import { randomBytes } from 'node:crypto';
import type { ProviderReasoningState, ReasoningStateHandle } from '@gateway/protocol';

const DEFAULT_TTL_MS = 30 * 60 * 1_000; // 30 minutes
const MAX_ENTRIES = 10_000;

export function createReasoningStateStore(
  ttlMs: number = DEFAULT_TTL_MS,
  maxEntries: number = MAX_ENTRIES,
): ReasoningStateHandle {
  const store = new Map<string, { state: ProviderReasoningState; expiresAt: number }>();

  const evictExpired = () => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) store.delete(key);
    }
  };

  const enforceLimit = () => {
    if (store.size <= maxEntries) return;
    // Remove oldest entries (insertion-ordered Map)
    const excess = store.size - maxEntries;
    const keys = store.keys();
    for (let i = 0; i < excess; i++) {
      const next = keys.next();
      if (next.done) break;
      store.delete(next.value);
    }
  };

  return {
    async store(state: ProviderReasoningState): Promise<string> {
      evictExpired();
      const handle = `proxy:rs_${randomBytes(16).toString('base64url')}`;
      store.set(handle, { state, expiresAt: Date.now() + ttlMs });
      enforceLimit();
      return handle;
    },

    async resolve(handle: string): Promise<ProviderReasoningState | null> {
      const entry = store.get(handle);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        store.delete(handle);
        return null;
      }
      return entry.state;
    },

    async delete(handle: string): Promise<void> {
      store.delete(handle);
    },
  };
}
