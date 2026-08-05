import { describe, expect, it } from 'vitest';
import { createReasoningStateStore } from '../src/reasoning-state.js';

describe('reasoning state store', () => {
  it('store and resolve round-trips state', async () => {
    const store = createReasoningStateStore();
    const handle = await store.store({
      data: 'encrypted-payload',
      format: 'openai-v2',
      createdAt: Date.now(),
    });
    expect(handle).toMatch(/^proxy:rs_/);
    const resolved = await store.resolve(handle);
    expect(resolved).toMatchObject({
      data: 'encrypted-payload',
      format: 'openai-v2',
    });
  });

  it('expired handle returns null', async () => {
    const store = createReasoningStateStore(1); // 1ms TTL
    const handle = await store.store({
      data: 'will-expire',
      format: 'test',
      createdAt: Date.now(),
    });
    // Wait for expiry
    await new Promise((r) => setTimeout(r, 10));
    const resolved = await store.resolve(handle);
    expect(resolved).toBeNull();
  });

  it('foreign reasoning handle resolves correctly', async () => {
    const store = createReasoningStateStore();
    const handle = await store.store({
      data: 'foreign-encrypted-data',
      format: 'openai-v2',
      provider: 'openai',
      createdAt: Date.now(),
    });
    const resolved = await store.resolve(handle);
    expect(resolved).toBeDefined();
    expect(resolved!.data).toBe('foreign-encrypted-data');
    expect(resolved!.format).toBe('openai-v2');
  });

  it('delete removes the entry', async () => {
    const store = createReasoningStateStore();
    const handle = await store.store({
      data: 'to-delete',
      format: 'test',
      createdAt: Date.now(),
    });
    await store.delete(handle);
    const resolved = await store.resolve(handle);
    expect(resolved).toBeNull();
  });

  it('tampered handle returns null', async () => {
    const store = createReasoningStateStore();
    await store.store({
      data: 'real-data',
      format: 'test',
      createdAt: Date.now(),
    });
    const resolved = await store.resolve('proxy:rs_tampered_handle');
    expect(resolved).toBeNull();
  });

  it('enforces max entries limit', async () => {
    const store = createReasoningStateStore(60_000, 3);
    const handles: string[] = [];
    for (let i = 0; i < 5; i++) {
      handles.push(
        await store.store({
          data: `data-${i}`,
          format: 'test',
          createdAt: Date.now(),
        }),
      );
    }
    // First entries should have been evicted
    expect(await store.resolve(handles[0]!)).toBeNull();
    expect(await store.resolve(handles[1]!)).toBeNull();
    // Last entries should still be present
    expect(await store.resolve(handles[3]!)).toBeDefined();
    expect(await store.resolve(handles[4]!)).toBeDefined();
  });
});
