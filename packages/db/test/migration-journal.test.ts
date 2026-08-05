import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type MigrationJournal = {
  entries: Array<{ idx: number; tag: string }>;
};

describe('Drizzle migration metadata', () => {
  it('registers every SQL migration in the journal and has no orphan journal entries', () => {
    const migrationsDir = resolve(process.cwd(), 'packages/db/migrations');
    const journalPath = resolve(migrationsDir, 'meta/_journal.json');
    const sqlTags = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.slice(0, -4))
      .sort();
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as MigrationJournal;
    const journalTags = journal.entries.map((entry) => entry.tag).sort();

    expect(journalTags).toEqual(sqlTags);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
  });
});
