import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bindingRoutes, modelBindings } from './schema.js';

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
