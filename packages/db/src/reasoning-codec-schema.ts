import { timestamp, text, uuid, pgTable } from 'drizzle-orm/pg-core';
import { modelBindings } from './schema.js';

export const modelBindingReasoningCodecs = pgTable('model_binding_reasoning_codecs', {
  bindingId: uuid('binding_id')
    .primaryKey()
    .references(() => modelBindings.id, { onDelete: 'cascade' }),
  codec: text('codec')
    .$type<'auto' | 'reasoning_details' | 'reasoning_content'>()
    .default('auto')
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type ReasoningCodec = typeof modelBindingReasoningCodecs.$inferSelect.codec;
