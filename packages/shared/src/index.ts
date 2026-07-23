import { z } from 'zod';

export const aliases = ['haiku', 'sonnet', 'opus'] as const;
export const capabilitySchema = z.enum(['yes', 'no', 'unknown']);
export const binaryCapabilitySchema = z.enum(['yes', 'no']);
export const apiFormatSchema = z.enum(['openai_compatible', 'anthropic_compatible']);
export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9_.-]+$/)
  .transform((v) => v.toLowerCase());
export const credentialsSchema = z.object({
  username: usernameSchema,
  password: z.string().min(6).max(200),
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(6).max(200),
});

// ── Connection ──────────────────────────────────────────────
export const providerConnectionInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  baseUrl: z.string().url().max(2048),
  enabled: z.boolean().default(true),
});

// ── Connection token ────────────────────────────────────────
export const connectionTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  apiKey: z.string().min(1).max(4096),
  enabled: z.boolean().default(true),
});
export const connectionTokenUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  apiKey: z.string().min(1).max(4096).optional(),
  enabled: z.boolean().optional(),
});

// ── Model binding ───────────────────────────────────────────
const relativePathSchema = z
  .string()
  .trim()
  .regex(/^\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=%-]*$/, 'Must be a relative path starting with /')
  .max(1024);
export const modelBindingInputSchema = z.object({
  presetIds: z.array(z.string().uuid()).min(1).max(100),
  apiFormat: apiFormatSchema.optional(),
  providerBasePath: relativePathSchema.or(z.literal('')).default(''),
});

// ── Model (manual create/edit, backward compat) ────────────
export const modelInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  upstreamModelId: z.string().trim().min(1).max(200),
  providerConnectionId: z.string().uuid(),
  apiFormat: apiFormatSchema,
  providerBasePath: relativePathSchema.or(z.literal('')).default(''),
  requestPathOverride: relativePathSchema.nullable().optional(),
  contextLength: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  supportsStreaming: capabilitySchema.default('unknown'),
  supportsTools: capabilitySchema.default('unknown'),
  supportsImages: binaryCapabilitySchema.default('no'),
  supportsReasoning: binaryCapabilitySchema.default('yes'),
  enabled: z.boolean().default(true),
});

// ── Preset ──────────────────────────────────────────────────
export const presetInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  upstreamModelId: z.string().trim().min(1).max(200),
  apiFormat: apiFormatSchema,
  supportsImages: binaryCapabilitySchema.default('no'),
  supportsReasoning: binaryCapabilitySchema.default('no'),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
});

// ── Gateway key ─────────────────────────────────────────────
export const gatewayKeyInputSchema = z.object({ name: z.string().trim().min(1).max(100) });

// ── Mapping ─────────────────────────────────────────────────
export const mappingUpdateSchema = z.object({
  routes: z.array(z.object({ bindingId: z.string().uuid(), enabled: z.boolean() })).max(100),
});

// ── Rules ───────────────────────────────────────────────────
export const ruleTypeSchema = z.enum([
  'map_enum',
  'set_field',
  'remove_field',
  'rename_field',
  'cap_number',
  'thinking_effort',
]);
export const ruleInputSchema = z.object({
  type: ruleTypeSchema,
  enabled: z.boolean().default(true),
  position: z.number().int().nonnegative(),
  config: z.record(z.unknown()),
});

// ── Types ───────────────────────────────────────────────────
export type ModelInput = z.infer<typeof modelInputSchema>;
export type ProviderConnectionInput = z.infer<typeof providerConnectionInputSchema>;
export type ConnectionTokenInput = z.infer<typeof connectionTokenInputSchema>;
export type ConnectionTokenUpdate = z.infer<typeof connectionTokenUpdateSchema>;
export type ModelBindingInput = z.infer<typeof modelBindingInputSchema>;
export type RuleInput = z.infer<typeof ruleInputSchema>;
export type PresetInput = z.infer<typeof presetInputSchema>;

export function anthropicError(type: string, message: string, requestId?: string) {
  return {
    type: 'error',
    error: { type, message },
    ...(requestId ? { request_id: requestId } : {}),
  };
}
