import { describe, expect, it } from 'vitest';
import { buildReasoningConfig } from '../src/index.js';
import type { AnthropicRequest, ReasoningCapabilities } from '../src/index.js';

const request: AnthropicRequest = {
  model: 'sonnet',
  max_tokens: 100,
  stream: false,
  messages: [{ role: 'user', content: 'hello' }],
};

const effortOnlyCaps: ReasoningCapabilities = {
  supportsReasoning: true,
  supportsReasoningBudget: false,
  supportsReasoningEffort: true,
  supportsAdaptiveReasoning: false,
};

const fullCaps: ReasoningCapabilities = {
  supportsReasoning: true,
  supportsReasoningBudget: true,
  supportsReasoningEffort: true,
  supportsAdaptiveReasoning: true,
};

describe('explicit reasoning effort mapping', () => {
  it('preserves explicit high effort when the provider supports effort', () => {
    expect(
      buildReasoningConfig(
        { enabled: true, effort: 'high' },
        effortOnlyCaps,
        {
          ...request,
          thinking: { type: 'adaptive', effort: 'high', enabled: true },
        },
      ),
    ).toEqual({ effort: 'high' });
  });

  it('maps xhigh to max for upstream compatibility', () => {
    expect(
      buildReasoningConfig(
        { enabled: true, effort: 'xhigh' },
        effortOnlyCaps,
        {
          ...request,
          thinking: { type: 'adaptive', effort: 'xhigh', enabled: true },
        },
      ),
    ).toEqual({ effort: 'max' });
  });

  it('prefers an explicit supported budget over effort', () => {
    const config = buildReasoningConfig(
      { enabled: true, effort: 'high', budgetTokens: 8000 },
      fullCaps,
      {
        ...request,
        thinking: { type: 'enabled', effort: 'high', budget_tokens: 8000 },
      },
    );

    expect(config).toMatchObject({ max_tokens: 8000, summary: 'auto' });
    expect(config).not.toHaveProperty('effort');
  });

  it('uses explicit effort before converting budget when budget is unsupported', () => {
    expect(
      buildReasoningConfig(
        { enabled: true, effort: 'low', budgetTokens: 8000 },
        effortOnlyCaps,
        {
          ...request,
          thinking: { type: 'enabled', effort: 'low', budget_tokens: 8000 },
        },
      ),
    ).toEqual({ effort: 'low', summary: 'auto' });
  });
});
