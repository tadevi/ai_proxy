import { z } from 'zod';

const textBlock = z.object({ type: z.literal('text'), text: z.string() });
const imageBlock = z.object({
  type: z.literal('image'),
  source: z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }),
});
const toolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});
const toolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(textBlock)]),
  is_error: z.boolean().optional(),
});
export const contentBlockSchema = z.discriminatedUnion('type', [
  textBlock,
  imageBlock,
  toolUseBlock,
  toolResultBlock,
]);
export const anthropicRequestSchema = z
  .object({
    model: z.string().min(1),
    system: z.union([z.string(), z.array(textBlock)]).optional(),
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant', 'system']),
          content: z.union([z.string(), z.array(contentBlockSchema)]),
        }),
      )
      .min(1),
    max_tokens: z.number().int().positive().max(1_000_000),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    stop_sequences: z.array(z.string()).optional(),
    stream: z.boolean().default(false),
    tools: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          input_schema: z.record(z.unknown()),
        }),
      )
      .optional(),
    tool_choice: z
      .union([
        z.object({ type: z.literal('auto') }),
        z.object({ type: z.literal('any') }),
        z.object({ type: z.literal('tool'), name: z.string() }),
      ])
      .optional(),
    metadata: z.record(z.unknown()).optional(),
    thinking: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type AnthropicRequest = z.infer<typeof anthropicRequestSchema>;
export type NormalizedThinking = {
  enabled: boolean;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  budgetTokens?: number;
};
export type Rule = {
  type: string;
  enabled: boolean;
  position: number;
  config: Record<string, unknown>;
};
