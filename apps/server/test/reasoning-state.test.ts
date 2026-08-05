import { describe, expect, it } from 'vitest';
import {
  createReasoningStateStore,
  reasoningPayloadFingerprint,
} from '../src/reasoning-state.js';

const scope = { userId: 'user-a', connectionId: 'connection-a', upstreamModelId: 'model-a' };
const stateScope = { ...scope };

function state(data: string, format = 'test') {
  return { data, format, ...scope, createdAt: Date.now() };
}

describe('reasoning state store', () => {
  it('creates stable fingerprints without exposing payloads', () => {
    expect(reasoningPayloadFingerprint(state('encrypted-payload', 'openai-v2'))).toBe(
      reasoningPayloadFingerprint(state('encrypted-payload', 'openai-v2')),
    );
    expect(reasoningPayloadFingerprint(state('encrypted-payload', 'openai-v2'))).not.toBe(
      reasoningPayloadFingerprint(state('encrypted-payload', 'poolside-v1')),
    );
    expect(reasoningPayloadFingerprint(state('encrypted-payload', 'openai-v2'))).not.toContain(
      'encrypted-payload',
    );
  });

  it('store and resolve round-trips scoped state', async () => {
    const store = createReasoningStateStore();
    const handle = await store.store(state('encrypted-payload', 'openai-v2'));
    expect(handle).toMatch(/^proxy:rs_/);
    const resolved = await store.resolve(handle, stateScope);
    expect(resolved).toMatchObject({ data: 'encrypted-payload', format: 'openai-v2' });
  });

  it('refuses a handle outside its user, connection, or upstream-model scope', async () => {
    const store = createReasoningStateStore();
    const handle = await store.store(state('encrypted-payload'));
    expect(await store.resolve(handle, { ...scope, userId: 'user-b' })).toBeNull();
    expect(await store.resolve(handle, { ...scope, connectionId: 'connection-b' })).toBeNull();
    expect(await store.resolve(handle, { ...scope, upstreamModelId: 'model-b' })).toBeNull();
  });

  it('expired handle returns null', async () => {
    const store = createReasoningStateStore(1);
    const handle = await store.store(state('will-expire'));
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.resolve(handle, stateScope)).toBeNull();
  });

  it('delete removes the entry', async () => {
    const store = createReasoningStateStore();
    const handle = await store.store(state('to-delete'));
    await store.delete(handle);
    expect(await store.resolve(handle, stateScope)).toBeNull();
  });

  it('tampered handle returns null', async () => {
    const store = createReasoningStateStore();
    await store.store(state('real-data'));
    expect(await store.resolve('proxy:rs_tampered_handle', stateScope)).toBeNull();
  });

  it('enforces max entries limit', async () => {
    const store = createReasoningStateStore(60_000, 3);
    const handles: string[] = [];
    for (let i = 0; i < 5; i++) handles.push(await store.store(state(`data-${i}`)));
    expect(await store.resolve(handles[0]!, stateScope)).toBeNull();
    expect(await store.resolve(handles[1]!, stateScope)).toBeNull();
    expect(await store.resolve(handles[3]!, stateScope)).toBeDefined();
    expect(await store.resolve(handles[4]!, stateScope)).toBeDefined();
  });
});
