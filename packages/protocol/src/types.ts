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
