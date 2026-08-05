import { z } from 'zod';

// Content blocks evolve independently from the Messages API.  Keep every field
// (and unfamiliar block type) intact so an Anthropic-compatible upstream, not
// this proxy, decides whether it supports it.
const textBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const imageBlock = z
  .object({
    type: z.literal('image'),
    source: z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }),
  })
  .passthrough();
const thinkingBlock = z
  .object({
    type: z.literal('thinking'),
    thinking: z.string(),
    signature: z.string().optional(),
  })
  .passthrough();
const redactedThinkingBlock = z
  .object({
    type: z.literal('redacted_thinking'),
    data: z.string(),
  })
  .passthrough();
const toolUseBlock = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
  })
  .passthrough();
const toolResultBlock = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(textBlock)]),
    is_error: z.boolean().optional(),
  })
  .passthrough();
const passthroughBlock = z.object({ type: z.string().min(1) }).passthrough();
export const contentBlockSchema = z.union([
  textBlock,
  imageBlock,
  thinkingBlock,
  redactedThinkingBlock,
  toolUseBlock,
  toolResultBlock,
  passthroughBlock,
]);
export const anthropicRequestSchema = z
  .object({
    model: z.string().min(1),
    system: z.union([z.string(), z.array(textBlock)]).optional(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant', 'system']),
            content: z.union([z.string(), z.array(contentBlockSchema)]),
          })
          .passthrough(),
      )
      .min(1),
    max_tokens: z.number().int().positive().max(1_000_000),
    stream: z.boolean().default(false),
    thinking: z.record(z.unknown()).optional(),
    output_config: z.object({ effort: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export type AnthropicRequest = z.infer<typeof anthropicRequestSchema>;
export type NormalizedThinking = {
  enabled: boolean;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  budgetTokens?: number;
};
export type Rule = {
  type: string;
  enabled: boolean;
  position: number;
  config: Record<string, unknown>;
};

// ── Reasoning detail types (OpenRouter / OpenAI reasoning_details) ──
export type ReasoningDetailText = {
  type: 'reasoning.text';
  text: string;
  signature?: string | null;
  id?: string | null;
  format?: string;
  index?: number;
};

export type ReasoningDetailSummary = {
  type: 'reasoning.summary';
  summary: string;
  id?: string | null;
  format?: string;
  index?: number;
};

export type ReasoningDetailEncrypted = {
  type: 'reasoning.encrypted';
  data: string;
  id?: string | null;
  format?: string;
  index?: number;
};

export type ReasoningDetail = ReasoningDetailText | ReasoningDetailSummary | ReasoningDetailEncrypted;

// ── Model capabilities for reasoning ──
export type ReasoningCapabilities = {
  supportsReasoning: boolean;
  supportsReasoningBudget: boolean;
  supportsReasoningEffort: boolean;
  supportsAdaptiveReasoning: boolean;
};

// ── Upstream context passed to conversion functions ──
export type UpstreamContext = {
  upstreamProvider?: string;
};

// ── Opaque reasoning state for round-tripping encrypted blocks ──
export type ProviderReasoningState = {
  data: string;
  format: string;
  userId: string;
  connectionId: string;
  upstreamModelId: string;
  provider?: string;
  signature?: string;
  createdAt: number;
};

export type ReasoningStateScope = {
  userId: string;
  connectionId: string;
  upstreamModelId: string;
};

export type ReasoningStateHandle = {
  store(state: ProviderReasoningState): Promise<string>;
  resolve(handle: string, scope: ReasoningStateScope): Promise<ProviderReasoningState | null>;
  delete(handle: string): Promise<void>;
};
