import type {
  AnthropicRequest,
  NormalizedThinking,
  ReasoningCapabilities,
  ReasoningDetail,
  UpstreamContext,
} from './types.js';

type Json = Record<string, unknown>;

// ── Anthropic thinking → OpenRouter reasoning object ──────────────

export function shouldRequestReasoningSummary(
  request: AnthropicRequest,
  _capabilities: ReasoningCapabilities,
): boolean {
  // Only request summary when the Anthropic request explicitly sets output_config.effort
  // or includes a thinking block that signals detailed reasoning is desired.
  const raw = request as Record<string, unknown>;
  const outputConfig = raw.output_config as Record<string, unknown> | undefined;
  if (typeof outputConfig?.effort === 'string' && outputConfig.effort !== 'none') return true;
  // Adaptive thinking with explicit budget suggests the caller wants visible reasoning.
  const thinking = raw.thinking as Record<string, unknown> | undefined;
  if (typeof thinking?.budget_tokens === 'number' && thinking.budget_tokens > 0) return true;
  return false;
}

export function buildReasoningConfig(
  thinking: NormalizedThinking,
  capabilities: ReasoningCapabilities,
  request: AnthropicRequest,
): Json | undefined {
  if (!thinking.enabled) return undefined;

  const reasoning: Json = {};
  const budgetTokens = thinking.budgetTokens;

  if (capabilities.supportsReasoningBudget && budgetTokens != null) {
    reasoning.max_tokens = budgetTokens;
  } else if (capabilities.supportsReasoningEffort && thinking.effort) {
    reasoning.effort = normalizeUpstreamEffort(thinking.effort);
  } else if (capabilities.supportsReasoningEffort && budgetTokens != null) {
    reasoning.effort = budgetToEffort(budgetTokens);
  } else if (capabilities.supportsAdaptiveReasoning) {
    reasoning.enabled = true;
  } else {
    return undefined;
  }

  if (shouldRequestReasoningSummary(request, capabilities)) {
    reasoning.summary = 'auto';
  }

  return Object.keys(reasoning).length > 0 ? reasoning : undefined;
}

function normalizeUpstreamEffort(
  effort: NonNullable<NormalizedThinking['effort']>,
): 'low' | 'medium' | 'high' | 'max' {
  return effort === 'xhigh' ? 'max' : effort;
}

function budgetToEffort(budgetTokens: number): string {
  if (budgetTokens <= 1024) return 'low';
  if (budgetTokens <= 4096) return 'medium';
  if (budgetTokens <= 16384) return 'high';
  return 'max';
}

// ── Anthropic history blocks → OpenRouter reasoning_details ───────

export async function anthropicHistoryToReasoningDetails(
  content: Json[],
  resolveProxySignature?: (signature: string) => Promise<{ data: string; format: string } | null>,
): Promise<Json[] | undefined> {
  const details: Json[] = [];
  for (const block of content) {
    if (block.type === 'thinking') {
      const signature = typeof block.signature === 'string' ? block.signature : undefined;
      if (signature?.startsWith('proxy:rs_')) {
        const state = await resolveProxySignature?.(signature);
        // Never forward a proxy handle to an upstream as if it were a provider signature.
        if (state)
          details.push({ type: 'reasoning.encrypted', data: state.data, format: state.format });
      } else {
        details.push({
          type: 'reasoning.text',
          text: block.thinking,
          ...(signature ? { signature } : {}),
        });
      }
    } else if (block.type === 'redacted_thinking') {
      details.push({
        type: 'reasoning.encrypted',
        data: block.data,
        format: 'anthropic-claude-v1',
      });
    }
  }
  return details.length > 0 ? details : undefined;
}

// ── OpenRouter reasoning_details → Anthropic content blocks ───────

export function isAnthropicNativeEncrypted(
  detail: { format?: string },
  context: UpstreamContext,
): boolean {
  return detail.format === 'anthropic-claude-v1' && context.upstreamProvider === 'anthropic';
}

export async function reasoningDetailsToAnthropicBlocks(
  details: unknown[],
  context: UpstreamContext,
  onEncryptedForeign?: (detail: { data: string; format?: string; id?: string }) => Promise<string>,
): Promise<Json[]> {
  const blocks: Json[] = [];
  for (const raw of details) {
    if (!raw || typeof raw !== 'object') continue;
    const detail = raw as Record<string, unknown>;
    const type = typeof detail.type === 'string' ? detail.type : '';

    if (type === 'reasoning.text') {
      const text = typeof detail.text === 'string' ? detail.text : '';
      if (!text) continue;
      const block: Json = { type: 'thinking', thinking: text };
      if (typeof detail.signature === 'string' && detail.signature) {
        block.signature = detail.signature;
      }
      blocks.push(block);
    } else if (type === 'reasoning.summary') {
      const summary = typeof detail.summary === 'string' ? detail.summary : '';
      if (!summary) continue;
      blocks.push({ type: 'thinking', thinking: summary });
    } else if (type === 'reasoning.encrypted') {
      const data = typeof detail.data === 'string' ? detail.data : '';
      if (!data) continue;
      if (isAnthropicNativeEncrypted(detail as { format?: string }, context)) {
        blocks.push({
          type: 'redacted_thinking',
          data,
          ...(typeof detail.signature === 'string' && detail.signature ? { signature: detail.signature } : {}),
        });
      } else if (onEncryptedForeign) {
        const signature = await onEncryptedForeign({
          data,
          format: typeof detail.format === 'string' ? detail.format : undefined,
          id: typeof detail.id === 'string' ? detail.id : undefined,
        });
        // The opaque data stays server-side. The signature is a scoped proxy handle for
        // restoring it on a later assistant-history turn.
        blocks.push({ type: 'thinking', thinking: '', signature });
      }
    }
  }
  return blocks;
}

// ── Stop reason mapping ───────────────────────────────────────────

export function mapFinishReason(
  reason: string | null | undefined,
  hasToolCalls: boolean,
): string | null {
  if (hasToolCalls || reason === 'tool_calls') return 'tool_use';
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case null:
    case undefined:
      return null;
    default:
      return 'end_turn';
  }
}
