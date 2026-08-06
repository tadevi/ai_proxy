import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  apiFormat,
  bindingRoutes,
  capability,
  cliproxyAccounts,
  modelBindings,
  modelPresets,
  providerConnections,
  users,
} from './schema.js';

/**
 * Typed binding-owned view of model_bindings used during the staged migration.
 * This can be folded into the primary schema once legacy route columns are removed.
 */
export const bindingModelConfigs = pgTable(
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
    displayName: text('display_name').notNull(),
    upstreamModelId: text('upstream_model_id').notNull(),
    requestPathOverride: text('request_path_override'),
    contextLength: integer('context_length'),
    maxOutputTokens: integer('max_output_tokens'),
    supportsStreaming: capability('supports_streaming').notNull(),
    supportsTools: capability('supports_tools').notNull(),
    supportsImages: capability('supports_images').notNull(),
    supportsReasoning: capability('supports_reasoning').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('bindings_user_idx').on(t.userId),
    index('bindings_connection_idx').on(t.connectionId),
    index('model_bindings_upstream_model_idx').on(t.userId, t.upstreamModelId),
  ],
);

/**
 * Binding-owned view of transformation_rules used during the staged migration.
 * upstreamModelId remains populated temporarily for compatibility with older code paths.
 */
export const bindingTransformationRules = pgTable(
  'transformation_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bindingId: uuid('binding_id').references(() => modelBindings.id, { onDelete: 'cascade' }),
    upstreamModelId: uuid('upstream_model_id')
      .notNull()
      .references(() => bindingRoutes.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    position: integer('position').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    configJson: jsonb('config_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('transformation_rules_binding_idx').on(t.bindingId, t.position)],
);
