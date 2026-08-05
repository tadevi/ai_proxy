# Project Rules

## Production database migrations

- **NEVER run `pnpm db:migrate` locally in this project.**
- The local `.env` may point to the live production database. Running migrations locally can change the production schema before matching application code is deployed and crash the live service.
- For schema changes, only write and review the migration files locally.
- Every new migration SQL file under `packages/db/migrations/` **must** have a matching entry in `packages/db/migrations/meta/_journal.json`. Never add or rename a migration SQL file without updating the Drizzle migration metadata in the same change.
- Prefer generating migrations with Drizzle so the SQL, journal entry, and snapshot metadata stay synchronized. A standalone `.sql` file that is not registered in the journal is not a valid migration and will be ignored by `pnpm db:migrate`.
- Before finishing any schema change, run the migration metadata test and confirm there are no orphan SQL files or journal entries.
- Validate schema-related code with static checks such as:
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm build`
- Production migrations must only run through the Render deployment flow:
  - push code when explicitly requested by the user;
  - Render runs its configured migration command;
  - Render starts the matching application version after migration.
- Do not execute migration scripts, direct schema-changing SQL, or destructive SQL against the database from the local environment unless the user explicitly instructs it for that exact operation and confirms the target database.

## Git pushes

- Do not commit or push changes unless the user explicitly asks.
