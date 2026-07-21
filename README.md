# Anthropic Passthrough Gateway

A single-service, multi-user Anthropic-compatible gateway. Users configure encrypted OpenAI- or Anthropic-compatible provider connections, map `haiku`, `sonnet`, and `opus` to priority fallback routes, and use a gateway API key with Claude Code.

## Architecture

- `apps/web`: React/Vite/Tailwind dashboard using TanStack Query, React Hook Form, and dnd-kit.
- `apps/server`: Fastify dashboard API, session and gateway authentication, upstream executor, fallback, logging, and static web serving.
- `packages/db`: PostgreSQL schema and Drizzle migrations.
- `packages/protocol`: framework-independent request/response conversion, rules, routing, and SSE conversion.
- `packages/shared`: shared Zod validation and DTO constants.

The server is intentionally stateless. PostgreSQL is the source of truth and no prompt or response body is persisted.

## Requirements

- Node.js 22 or newer (current LTS recommended)
- pnpm 10
- PostgreSQL 16 or newer

## Local development

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm secrets # run twice for SESSION_SECRET and CREDENTIAL_ENCRYPTION_KEY
pnpm db:migrate
pnpm dev
```

Put the two generated values in `.env`. The dashboard is at `http://localhost:5173`; Vite proxies API requests to Fastify on port 3000. `ALLOW_PRIVATE_UPSTREAMS=true` is needed only for local mock providers. Never enable it in production.

Production-style local operation:

```bash
pnpm build
pnpm start
```

Fastify then serves `apps/web/dist` at `PUBLIC_URL`.

## Environment variables

| Variable                                           | Purpose                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `DATABASE_URL`                                     | PostgreSQL connection URL                                                    |
| `DATABASE_SSL_CA_PATH`                             | Optional CA PEM path used to validate the PostgreSQL TLS certificate         |
| `DATABASE_SSL_CERT_PATH` / `DATABASE_SSL_KEY_PATH` | Optional client certificate/key pair for mutual TLS; configure both together |
| `SESSION_SECRET`                                   | At least 32 random characters; signs cookie data                             |
| `CREDENTIAL_ENCRYPTION_KEY`                        | 32 random bytes in base64; AES-256-GCM root key                              |
| `PUBLIC_URL`                                       | Public origin used in setup snippets and Origin validation                   |
| `PORT`                                             | HTTP port (default `3000`)                                                   |
| `NODE_ENV`                                         | `development`, `test`, or `production`                                       |
| `ALLOW_PRIVATE_UPSTREAMS`                          | Development-only opt-in for localhost/private mock providers                 |
| `UPSTREAM_TIMEOUT_MS`                              | Per-route timeout before an upstream response                                |

Back up `CREDENTIAL_ENCRYPTION_KEY` securely. Losing it makes stored provider credentials unrecoverable. Version fields exist for a future controlled key-rotation migration.

## Gateway use

Create a key on Account, add a Provider connection, add and test models that use that connection, then configure Mappings. Claude Code can use:

```bash
export ANTHROPIC_BASE_URL="https://your-service.example"
export ANTHROPIC_AUTH_TOKEN="gw_your-one-time-key"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="haiku"
export ANTHROPIC_DEFAULT_SONNET_MODEL="sonnet"
export ANTHROPIC_DEFAULT_OPUS_MODEL="opus"
```

Provider connections contain only a Base URL plus an encrypted API key. Each model selects its API format and a relative provider base path: for example `/compatible-mode/v1` for an OpenAI-compatible DashScope model or `/apps/anthropic` for an Anthropic-compatible one. The gateway then appends `/chat/completions` or `/v1/messages`; unusual providers can use a relative request-path override on the model. The gateway constructs an allowlisted header set and never forwards incoming authorization headers.

## Security behavior

- Passwords use bcrypt with cost 12 and require at least 6 characters.
- Provider credentials use AES-256-GCM with a unique nonce and authentication tag.
- Session tokens and gateway keys are stored only as SHA-256 hashes; full gateway keys are displayed once.
- Dashboard cookies are HTTP-only, SameSite Strict, and Secure in production. Mutations also validate the request Origin.
- DNS and resolved addresses are checked when an endpoint is saved and again before every request. Production requires HTTPS and rejects redirects, embedded credentials, loopback, link-local, and private-network addresses.
- Pino redacts authorization, API key, cookie, session, and encrypted-credential fields. Request logs contain metadata only.
- Request bodies are limited to 2 MiB and per-process rate limiting is enabled.

User-configured public endpoints still carry inherent third-party risk. Operators should also apply outbound firewall policy where available.

## Commands

```bash
pnpm db:generate   # create a migration after schema changes
pnpm db:migrate    # apply committed migrations
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Protocol tests cover conversion, thinking/rules, capability routing, fallback classification, text streaming, and incremental tool arguments. Server tests cover credential encryption, API-key hashing, and gateway model IDs.

## Render deployment

1. Create a Blueprint from this repository using `render.yaml`.
2. Set `CREDENTIAL_ENCRYPTION_KEY` to 32 random bytes in base64 and `PUBLIC_URL` to the web service URL.
3. Deploy. Render runs the migration as a pre-deploy command, avoiding migration races between web instances.

The web service listens on `0.0.0.0:$PORT`, serves the built dashboard, and exposes `/health` for database-aware health checks. Streaming responses use `text/event-stream` and `no-transform` to discourage proxy buffering.

## API summary

- `POST /v1/messages` and `POST /anthropic/v1/messages`
- `GET /v1/models`
- `GET /health`
- `/api/auth/*`, `/api/connections/*`, `/api/models/*`, `/api/mappings/*`, `/api/keys/*`, `/api/logs`, `/api/setup`

Gateway requests accept either `Authorization: Bearer gw_...` or `x-api-key`. Conflicting values are rejected. Alias requests may fall back on network errors, pre-response timeouts, 429, 500, 502, 503, or 504; direct gateway model IDs never fall back. Streaming never switches providers after output begins.
