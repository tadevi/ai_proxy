import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { connectionTokens, modelBindings, users } from './schema.js';

/**
 * Runtime-owned view of binding_routes.
 * Stable model/provider configuration belongs to model_bindings and is intentionally absent here.
 */
export const runtimeBindingRoutes = pgTable(
  'binding_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => modelBindings.id, { onDelete: 'cascade' }),
    tokenId: uuid('token_id').references(() => connectionTokens.id, { onDelete: 'set null' }),
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
    index('binding_routes_user_idx').on(t.userId),
    index('binding_routes_binding_idx').on(t.bindingId),
    index('binding_routes_token_idx').on(t.tokenId),
  ],
);
