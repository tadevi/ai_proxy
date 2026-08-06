import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const apiFormat = pgEnum('api_format', ['openai_compatible', 'anthropic_compatible']);
export const capability = pgEnum('capability', ['yes', 'no', 'unknown']);
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);
export const gatewayKeys = pgTable(
  'gateway_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('gateway_keys_user_idx').on(t.userId)],
);

// ── Connections ──────────────────────────────────────────────
export const providerConnections = pgTable(
  'provider_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    baseUrl: text('base_url').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('provider_connections_user_idx').on(t.userId)],
);

// ── Connection tokens (API keys per connection) ─────────────
export const connectionTokens = pgTable(
  'connection_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyPreview: text('key_preview'),
    encryptedApiKey: text('encrypted_api_key').notNull(),
    encryptionIv: text('encryption_iv').notNull(),
    encryptionAuthTag: text('encryption_auth_tag').notNull(),
    encryptionKeyVersion: integer('encryption_key_version').default(1).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    systemManaged: boolean('system_managed').default(false).notNull(),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    latestError: jsonb('latest_error'),
    latestErrorAt: timestamp('latest_error_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('tokens_user_idx').on(t.userId),
    index('tokens_connection_idx').on(t.connectionId),
    unique('tokens_connection_name_unique').on(t.connectionId, t.name),
  ],
);

// ── Model presets ───────────────────────────────────────────
export const modelPresets = pgTable(
  'model_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    upstreamModelId: text('upstream_model_id').notNull(),
    apiFormat: apiFormat('api_format').notNull(),
    supportsImages: capability('supports_images').default('no').notNull(),
    supportsReasoning: capability('supports_reasoning').default('no').notNull(),
    maxOutputTokens: integer('max_output_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('model_presets_user_idx').on(t.userId)],
);

// ── Model bindings (preset × connection) ────────────────────
export const modelBindings = pgTable(
  'model_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    presetId: uuid('preset_id')
      .notNull()
      .references(() => modelPresets.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' }),
    apiFormat: apiFormat('api_format').notNull(),
    providerBasePath: text('provider_base_path').default('').notNull(),
    cliproxyAccountId: uuid('cliproxy_account_id').references(() => cliproxyAccounts.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('bindings_user_idx').on(t.userId),
    index('bindings_connection_idx').on(t.connectionId),
    uniqueIndex('bindings_connection_preset_format_no_account_unique')
      .on(t.connectionId, t.presetId, t.apiFormat)
      .where(sql`${t.cliproxyAccountId} IS NULL`),
    uniqueIndex('bindings_connection_preset_format_account_unique')
      .on(t.connectionId, t.presetId, t.apiFormat, t.cliproxyAccountId)
      .where(sql`${t.cliproxyAccountId} IS NOT NULL`),
  ],
);

// ── Binding routes (binding × credential runtime instances) ─
export const bindingRoutes = pgTable(
  'binding_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    upstreamModelId: text('upstream_model_id').notNull(),
    providerConnectionId: uuid('provider_connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' }),
    bindingId: uuid('binding_id').references(() => modelBindings.id, { onDelete: 'cascade' }),
    tokenId: uuid('token_id').references(() => connectionTokens.id, { onDelete: 'set null' }),
    apiFormat: apiFormat('api_format').notNull(),
    providerBasePath: text('provider_base_path').default('').notNull(),
    requestPathOverride: text('request_path_override'),
    contextLength: integer('context_length'),
    maxOutputTokens: integer('max_output_tokens'),
    supportsStreaming: capability('supports_streaming').default('unknown').notNull(),
    supportsTools: capability('supports_tools').default('unknown').notNull(),
    supportsImages: capability('supports_images').default('no').notNull(),
    supportsReasoning: capability('supports_reasoning').default('yes').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    latestTestStatus: text('latest_test_status'),
    latestTestAt: timestamp('latest_test_at', { withTimezone: true }),
    latestError: jsonb('latest_error'),
    latestErrorAt: timestamp('latest_error_at', { withTimezone: true }),
    fallbackCooldownUntil: timestamp('fallback_cooldown_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('models_user_idx').on(t.userId),
    uniqueIndex('models_connection_upstream_token_unique')
      .on(t.providerConnectionId, t.upstreamModelId, t.tokenId)
      .where(sql`${t.tokenId} is not null`),
    uniqueIndex('models_connection_upstream_no_token_unique')
      .on(t.providerConnectionId, t.upstreamModelId)
      .where(sql`${t.tokenId} is null`),
  ],
);

/** @deprecated Use bindingRoutes. Kept during the staged migration for source compatibility. */
export const upstreamModels = bindingRoutes;

// ── Mappings ────────────────────────────────────────────────
export const mappings = pgTable(
  'mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique('mappings_user_alias_unique').on(t.userId, t.alias)],
);
export const mappingRoutes = pgTable(
  'mapping_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mappingId: uuid('mapping_id')
      .notNull()
      .references(() => mappings.id, { onDelete: 'cascade' }),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => modelBindings.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique('routes_mapping_binding_unique').on(t.mappingId, t.bindingId)],
);
export const transformationRules = pgTable('transformation_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  upstreamModelId: uuid('upstream_model_id')
    .notNull()
    .references(() => bindingRoutes.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  position: integer('position').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  configJson: jsonb('config_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
export const requestLogs = pgTable(
  'request_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    incomingModel: text('incoming_model').notNull(),
    resolvedUpstreamModel: text('resolved_upstream_model'),
    resolvedUpstreamModelId: uuid('resolved_upstream_model_id'),
    apiFormat: apiFormat('api_format'),
    status: integer('status').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    timeToFirstTokenMs: integer('time_to_first_token_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheInputTokens: integer('cache_input_tokens'),
    thinkingConfig: jsonb('thinking_config'),
    reasoningDetails: boolean('reasoning_details'),
    fallbackCount: integer('fallback_count').default(0).notNull(),
    errorCategory: text('error_category'),
    providerError: jsonb('provider_error'),
    skippedRoutes: jsonb('skipped_routes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('logs_user_created_idx').on(t.userId, t.createdAt),
    index('logs_request_idx').on(t.requestId),
    index('logs_created_idx').on(t.createdAt),
  ],
);
export const modelUsageDaily = pgTable(
  'model_usage_daily',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => modelBindings.id, { onDelete: 'cascade' }),
    usageDate: date('usage_date').notNull(),
    requestCount: bigint('request_count', { mode: 'number' }).default(0).notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).default(0).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).default(0).notNull(),
    cacheInputTokens: bigint('cache_input_tokens', { mode: 'number' }).default(0).notNull(),
    cacheUsageReportedRequestCount: bigint('cache_usage_reported_request_count', {
      mode: 'number',
    })
      .default(0)
      .notNull(),
  },
  (t) => [
    unique('model_usage_daily_unique').on(t.userId, t.bindingId, t.usageDate),
    index('model_usage_daily_user_binding_idx').on(t.userId, t.bindingId),
  ],
);

// Codex/Claude/Gemini OAuth accounts uploaded to a shared CLIProxyAPI instance.
export const cliproxyAccounts = pgTable(
  'cliproxy_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    prefix: text('prefix').notNull(),
    fileName: text('file_name').notNull(),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('cliproxy_accounts_prefix_unique').on(t.prefix),
    index('cliproxy_accounts_user_idx').on(t.userId),
  ],
);

export const cliproxyModelStates = pgTable(
  'cliproxy_model_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cliproxyAccountId: uuid('cliproxy_account_id')
      .notNull()
      .references(() => cliproxyAccounts.id, { onDelete: 'cascade' }),
    upstreamModelId: text('upstream_model_id').notNull(),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    latestError: jsonb('latest_error'),
    latestErrorAt: timestamp('latest_error_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('cliproxy_model_states_account_model_unique').on(t.cliproxyAccountId, t.upstreamModelId),
    index('cliproxy_model_states_cooldown_idx').on(
      t.cliproxyAccountId,
      t.upstreamModelId,
      t.cooldownUntil,
    ),
  ],
);
