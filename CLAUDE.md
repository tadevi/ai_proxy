# Project Rules

## Production database migrations

- **NEVER run `pnpm db:migrate` locally in this project.**
- The local `.env` may point to the live production database. Running migrations locally can change the production schema before matching application code is deployed and crash the live service.
- For schema changes, only write and review the migration files locally.
- Validate schema-related code with static checks such as:
  - `pnpm typecheck`
  - `pnpm build`
- Production migrations must only run through the Render deployment flow:
  - push code when explicitly requested by the user;
  - Render runs its configured migration command;
  - Render starts the matching application version after migration.
- Do not execute migration scripts, direct schema-changing SQL, or destructive SQL against the database from the local environment unless the user explicitly instructs it for that exact operation and confirms the target database.

## Git pushes

- Do not commit or push changes unless the user explicitly asks.
