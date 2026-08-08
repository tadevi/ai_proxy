import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('mapping eligibility invariant', () => {
  it('keeps mapping-save eligibility aligned with gateway resolver health gates', () => {
    const guard = readSource('apps/server/src/routes/dashboard/mapping-eligibility.ts');
    const resolver = readSource('apps/server/src/routes/gateway/resolver.ts');

    for (const healthGate of [
      'runtimeBindingRoutes.enabled',
      'providerConnections.enabled',
      'connectionTokens.enabled',
      'connectionTokens.cooldownUntil',
      'runtimeBindingRoutes.fallbackCooldownUntil',
      'cliproxyModelStates.cooldownUntil',
    ]) {
      expect(guard, `mapping guard missing ${healthGate}`).toContain(healthGate);
      expect(resolver, `resolver missing ${healthGate}`).toContain(healthGate);
    }
  });

  it('rejects ineligible enabled bindings before mapping persistence', () => {
    const routes = readSource('apps/server/src/routes/dashboard/model-routes.ts');
    const validation = routes.indexOf('findIneligibleMappingBindings(');
    const persistence = routes.indexOf('app.db.transaction', validation);

    expect(validation).toBeGreaterThan(-1);
    expect(routes).toContain("reply.code(409)");
    expect(routes).toContain('ineligibleBindingIds');
    expect(persistence).toBeGreaterThan(validation);
  });
});
