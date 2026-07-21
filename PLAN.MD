# Goal: Build a Multi-Provider Anthropic Passthrough Gateway

Implement a production-ready v1 of a multi-user LLM gateway and web dashboard.

The gateway exposes an Anthropic-compatible API for clients such as Claude Code. Each user can configure multiple upstream models from OpenAI-compatible or Anthropic-compatible providers, securely store provider credentials, and map the logical Claude model tiers `haiku`, `sonnet`, and `opus` to ordered fallback lists.

Continue autonomously until the entire Definition of Done is satisfied. Do not stop after scaffolding, partial implementation, or documentation. Make reasonable implementation decisions where details are unspecified. Do not ask for confirmation unless blocked by a missing external secret that cannot be replaced with a development placeholder.

---

# 1. Core user journey

A user must be able to:

1. Register and log in using username and password.
2. Create a gateway API key for Claude Code.
3. Add upstream model configurations.
4. Test each upstream model.
5. Configure priority mappings for:
   - `haiku`
   - `sonnet`
   - `opus`

6. Reorder models using drag and drop.
7. Configure request transformation rules for OpenAI-compatible models.
8. Copy a ready-to-use Claude Code configuration.
9. Send Anthropic-compatible requests through the gateway.
10. Inspect metadata-only request logs.

Example Claude Code configuration:

```bash
export ANTHROPIC_BASE_URL="https://<host>"
export ANTHROPIC_AUTH_TOKEN="<gateway-api-key>"

export ANTHROPIC_DEFAULT_HAIKU_MODEL="haiku"
export ANTHROPIC_DEFAULT_SONNET_MODEL="sonnet"
export ANTHROPIC_DEFAULT_OPUS_MODEL="opus"
```

The provider API key is stored securely in the dashboard. Claude Code sends only the gateway API key.

---

# 2. Technology stack

Use a TypeScript pnpm monorepo.

## Frontend

- React
- Vite
- TypeScript
- Tailwind CSS
- shadcn/ui or equivalent accessible primitives
- TanStack Query
- React Hook Form
- Zod
- dnd-kit

## Backend

- Node.js current LTS
- TypeScript
- Fastify
- Native `fetch` or Undici for upstream requests
- Pino logging
- Zod or TypeBox for runtime validation

## Data

- PostgreSQL
- Drizzle ORM
- Drizzle migrations

## Authentication

- Username/password authentication
- Database-backed dashboard sessions
- Secure HTTP-only cookies
- Gateway API keys for `/v1/messages`
- Use a maintained auth library when it integrates cleanly; otherwise implement a minimal secure session system
- Password hashing must use Argon2id or bcrypt with a strong work factor

## Deployment

- One Render Web Service
- One Render PostgreSQL database
- The Fastify server serves both:
  - dashboard static assets
  - REST API
  - Anthropic-compatible gateway endpoints

Do not add Redis, Memcached, queues, microservices, or separate frontend deployment in v1.

---

# 3. Repository structure

Prefer:

```text
apps/
  web/
  server/

packages/
  db/
  protocol/
  shared/
```

Responsibilities:

```text
apps/web
- Dashboard UI
- Authentication screens
- Model management
- Mapping management
- Setup page
- Logs

apps/server
- Dashboard REST API
- Authentication/session integration
- Gateway API authentication
- Anthropic-compatible endpoints
- Route resolution
- Upstream request execution
- Static frontend serving

packages/db
- Drizzle schema
- Database client
- Migrations
- Repository helpers

packages/protocol
- Anthropic request types
- OpenAI-compatible request types
- Request conversion
- Response conversion
- Streaming SSE conversion
- Transformation rule execution

packages/shared
- Shared validation schemas
- API DTOs
- Error types
- Constants
```

Keep protocol conversion independent from Fastify and database code so it can be unit tested directly.

---

# 4. Domain model

## User

A user owns all credentials, models, mappings, API keys, and logs.

Required fields:

```text
id
username
password_hash
created_at
updated_at
```

Username must be unique and normalized consistently.

## Dashboard session

Required fields:

```text
id
user_id
token_hash
expires_at
created_at
last_used_at
```

Store only a secure hash of the session token when implementing sessions manually.

## Gateway API key

Required fields:

```text
id
user_id
name
prefix
key_hash
created_at
last_used_at
revoked_at
```

Generate a secret such as:

```text
gw_<secure-random-value>
```

Show the complete value only once. Store only a cryptographic hash. Allow creation, rename, and revocation.

## Upstream model

Each upstream model is a complete callable connection configuration.

Required fields:

```text
id
user_id

display_name
gateway_model_id
upstream_model_id

api_format
endpoint

encrypted_api_key
encryption_iv
encryption_auth_tag
encryption_key_version

context_length nullable
max_output_tokens nullable

supports_streaming enum
supports_tools enum
supports_images enum
supports_reasoning enum

enabled
created_at
updated_at
```

`api_format` values:

```text
openai_compatible
anthropic_compatible
```

Capability values should support:

```text
yes
no
unknown
```

Do not include web search support in v1.

### Model identifiers

Keep these identifiers separate:

```text
display_name
- Human-readable dashboard label
- May be duplicated

upstream_model_id
- Exact model ID sent to the provider
- May be duplicated across providers

gateway_model_id
- Unique user-facing ID understood by this gateway
- Immutable after creation
```

Generate `gateway_model_id` automatically:

```text
<slug>-<6-character-random-suffix>
```

Examples:

```text
mimo-2-5-pro-k7m4qd
deepseek-v3-p9r2wf
```

Use a database UUID as the internal primary key.

The generated gateway model ID must be unique at least within a user account. Prefer global uniqueness if this simplifies lookup.

Do not use a four-digit numeric suffix.

## Logical model mapping

Support these aliases in the UI:

```text
haiku
sonnet
opus
```

Use a generic alias representation in the database so additional aliases can be added later.

Required mapping fields:

```text
id
user_id
alias
created_at
updated_at
```

Required route fields:

```text
id
mapping_id
upstream_model_id
position
enabled
created_at
updated_at
```

`position` determines priority. The UI uses drag and drop; users must not manually enter numeric priorities.

A single upstream model may be included in multiple aliases.

## Request transformation rules

Rules belong to an upstream model.

Required fields:

```text
id
upstream_model_id
type
position
enabled
config_json
created_at
updated_at
```

Multiple rules may exist per model and execute in ascending position order.

Do not allow arbitrary JavaScript, expressions, shell commands, or executable user code.

---

# 5. Model creation UX

The add/edit model form must contain:

## Basic

```text
Display name
API format
Endpoint
Provider API key
Upstream model ID
Generated gateway model ID
Enabled
```

API format options:

```text
OpenAI compatible
Anthropic compatible
```

Normalize endpoints carefully, but do not make assumptions that break providers with unusual paths.

Never display a stored provider API key again. Show only a masked state and provide a “Replace key” action.

## Optional metadata

```text
Context length
Maximum output tokens

Supports streaming
Supports tools
Supports images
Supports reasoning
```

Each capability uses:

```text
Yes
No
Unknown
```

Provide sensible defaults:

```text
Streaming: Unknown
Tools: Unknown
Images: Unknown
Reasoning: Unknown
```

## Test model

The form and model detail page need a “Test model” action.

At minimum, test:

- Endpoint reachability
- Authentication
- Model existence through a basic text completion
- Basic non-streaming response conversion

When practical, also test streaming.

Return a clear normalized result instead of exposing only raw provider errors.

Never include provider secrets in the result or logs.

---

# 6. Model mappings UX

Create one page containing three mapping sections:

```text
Haiku
Sonnet
Opus
```

Each section displays an ordered list of upstream models.

Example:

```text
Sonnet

1. MiMo 2.5 Pro
2. DeepSeek V3
3. Kimi K2
```

Required interactions:

- Add an existing model to a mapping
- Remove a model from a mapping without deleting the model
- Enable or disable a route
- Drag and drop to reorder
- Save reordered positions reliably
- Display model health/test status where available
- Prevent accidental duplicate entries in the same mapping

Explain in the UI:

```text
Models are attempted from top to bottom.
```

Do not implement weighted routing, round robin, lowest-cost routing, or latency-based routing.

---

# 7. Gateway model resolution

Expose:

```text
POST /v1/messages
GET /v1/models
GET /health
```

Optionally support the equivalent namespaced route if useful:

```text
POST /anthropic/v1/messages
```

The incoming `model` field can be:

1. A logical alias such as `haiku`, `sonnet`, or `opus`.
2. A generated gateway model ID such as `mimo-2-5-pro-k7m4qd`.

Resolution:

```text
incoming model
→ alias?
   → resolve enabled models in priority order
→ otherwise
   → resolve the exact gateway model ID
```

Direct gateway model IDs call only that model and do not use another alias list.

All model resolution must be scoped to the authenticated user.

---

# 8. Gateway authentication

Authenticate `/v1/messages` using a gateway API key.

Accept:

```http
Authorization: Bearer gw_xxx
```

Optionally accept `x-api-key` as the gateway key for Anthropic SDK compatibility, provided ambiguity is handled safely.

If both supported headers are present and contain conflicting gateway credentials, reject the request.

Never forward the incoming gateway credential to an upstream provider.

Resolve the user from the hashed gateway API key, decrypt the chosen provider credential, and construct fresh upstream authentication headers.

---

# 9. Provider credential security

Provider API keys must be encrypted at rest because they must be decrypted to call upstream APIs.

Use:

```text
AES-256-GCM
```

Environment variable:

```text
CREDENTIAL_ENCRYPTION_KEY
```

The encryption design must include:

```text
ciphertext
initialization vector
authentication tag
key version
```

Requirements:

- Never store provider credentials as plaintext.
- Never log decrypted credentials.
- Redact authorization headers and API-key fields in Pino.
- Do not return stored credentials through REST APIs.
- Decrypt as late as possible.
- Do not maintain a long-lived plaintext credential cache.
- It is acceptable to decrypt on every upstream request.

Gateway API keys and session tokens should be hashed rather than encrypted.

---

# 10. Anthropic-compatible input

Support the subset needed by Claude Code and common Anthropic SDK clients.

Required request support:

```text
model
system
messages
max_tokens
temperature
top_p
stop_sequences
stream
tools
tool_choice
metadata where safely applicable
```

Required content block support:

```text
text
image
tool_use
tool_result
```

Accept both string content and content-block arrays where the Anthropic API permits them.

Validate requests and return Anthropic-shaped error responses.

---

# 11. OpenAI-compatible conversion

For `openai_compatible` models:

```text
Anthropic request
→ normalize request
→ convert to OpenAI-compatible body
→ apply model transformation rules
→ call upstream
→ convert response to Anthropic format
```

Basic mapping includes:

```text
Anthropic system
→ OpenAI system message

Anthropic text blocks
→ OpenAI text content

Anthropic image blocks
→ OpenAI image_url content when supported

Anthropic tool definitions
→ OpenAI function tools

Anthropic tool_use
→ OpenAI assistant tool_calls

Anthropic tool_result
→ OpenAI tool messages

Anthropic stop_sequences
→ OpenAI stop

Anthropic max_tokens
→ provider-compatible output-token field
```

Do not silently send images or tools to a model explicitly marked as unsupported.

When resolving an alias:

- If the request contains images, skip routes explicitly marked `supports_images = no`.
- If the request contains tools, skip routes explicitly marked `supports_tools = no`.
- `unknown` should remain eligible.
- Record skipped-route reasons in request metadata logs.

---

# 12. Anthropic-compatible passthrough

For `anthropic_compatible` models:

- Preserve the Anthropic request body as much as possible.
- Replace the incoming logical/gateway model with the configured upstream model ID.
- Apply only supported declarative rules.
- Build fresh provider authentication headers.
- Forward to the configured endpoint.
- Preserve Anthropic response format.
- Proxy streaming correctly.
- Do not leak incoming gateway authentication.

---

# 13. Thinking-effort compatibility

Thinking effort transformation is the first required predefined rule.

The gateway must normalize incoming thinking configuration into an internal representation such as:

```ts
type NormalizedThinking = {
  enabled: boolean;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  budgetTokens?: number;
};
```

Do not couple per-model rules directly to raw Claude Code request fields. Parse raw Anthropic input once, then run model rules against normalized values.

## Required thinking mapping rule

Provide a dashboard editor with rows similar to:

```text
Incoming effort    Upstream value
Low                high
Medium             high
High               high
XHigh              max
```

The rule must allow configuration of:

```text
Destination field
Disabled behavior
Low mapping
Medium mapping
High mapping
XHigh mapping
```

Common destination example:

```text
reasoning_effort
```

Example outcome:

```text
Claude Code medium
→ reasoning_effort = high
```

Support a predefined “OpenAI reasoning effort” preset and a custom mapping mode.

Do not hardcode vendor-specific model claims unless represented as editable presets.

## Additional declarative rule types

Implement a small, safe rule system that can support:

```text
map_enum
set_field
remove_field
rename_field
cap_number
```

Rules execute sequentially.

Conditions may be limited to safe structured comparisons, for example:

```text
field equals value
field exists
thinking enabled
request contains images
request contains tools
```

Do not implement a generic scripting language.

The UI may prioritize the thinking editor and place other rules under an Advanced section.

---

# 14. Streaming conversion

Streaming is a first-class requirement.

For OpenAI-compatible upstream SSE, convert events into valid Anthropic SSE events.

Support the Anthropic event lifecycle:

```text
message_start
content_block_start
content_block_delta
content_block_stop
message_delta
message_stop
```

Handle:

- Text deltas
- Tool-call deltas
- Incrementally streamed JSON arguments
- Usage where provided
- Stop reasons
- Client disconnect cancellation
- Upstream disconnects
- Malformed upstream chunks
- `[DONE]`

Do not buffer the complete response before returning it.

Use backpressure-aware stream handling where possible.

Once output has been emitted to the client, do not switch to another provider.

---

# 15. Priority fallback

Alias mappings use priority fallback only.

Algorithm:

```text
for each enabled route from top to bottom:
    skip incompatible route
    call upstream
    if successful:
        return response
    if safely fallbackable and no response content was emitted:
        continue
    otherwise:
        return normalized error
```

Fallback by default on:

```text
Network connection failure
Timeout before first response token
HTTP 429
HTTP 500
HTTP 502
HTTP 503
HTTP 504
```

Do not fallback by default on:

```text
Invalid request
Malformed tool schema
Context length exceeded
Unsupported content
Content-policy rejection
Errors after streaming output begins
```

A provider authentication failure should produce a clear dashboard/model health error. Do not endlessly retry it.

Use a reasonable per-route timeout with a server default. A model-specific timeout field may be added if needed, but avoid unnecessary configuration in the first UI.

No Redis-backed health system or circuit breaker is required in v1.

---

# 16. Response conversion

Convert OpenAI-compatible responses to Anthropic-compatible responses.

Handle:

```text
Text content
Tool calls
Stop reason
Input token usage
Output token usage
Model name exposed to the client
Errors
```

Use the incoming alias or gateway model ID consistently in the client-facing response rather than leaking an unrelated provider model name, unless Anthropic compatibility requires otherwise.

Normalize provider errors into Anthropic-shaped errors while preserving a safe diagnostic message and request ID.

Do not expose provider credentials or internal stack traces.

---

# 17. Dashboard pages

Keep navigation compact:

```text
Models
Mappings
Logs
Setup
Account
```

An Overview page is optional. Do not spend significant time on charts.

## Models

- List all upstream models
- Display name
- Generated gateway model ID
- API format
- Upstream model ID
- Capability badges
- Enabled state
- Latest test status
- Add, edit, test, disable, delete

Deletion must warn when a model is currently used in mappings.

## Mappings

- Haiku, Sonnet, and Opus sections
- Drag-and-drop priority
- Add/remove existing models
- Enabled/disabled route state
- Persist order immediately or through an explicit Save action
- Clear success/error feedback

## Logs

Metadata-only logs by default.

Display:

```text
Timestamp
Request ID
Incoming model
Resolved gateway model
API format
Status
Latency
Time to first token
Input tokens
Output tokens
Fallback count
Error category
```

Do not store prompt or response bodies.

Filters:

```text
Time
Model
Status
Request ID
```

## Setup

Display:

- Gateway endpoint
- Copyable Claude Code environment configuration
- Gateway API-key management
- Basic curl example
- `/health` result
- Config validation status for Haiku/Sonnet/Opus

## Account

- Username
- Change password
- Session logout
- Gateway API-key list
- Create/revoke keys

---

# 18. REST API

Implement typed dashboard REST endpoints for:

```text
Authentication
Current user/session
Gateway API keys
Upstream models
Model testing
Transformation rules
Mappings
Route ordering
Request logs
Setup status
```

Every resource query and mutation must enforce user ownership at the database query level.

Do not trust user-provided resource IDs without checking ownership.

Use shared validation schemas between frontend and backend where practical.

---

# 19. Caching

Do not add Redis or Memcached.

PostgreSQL is the source of truth.

A small process-local TTL cache is optional for:

```text
gateway key hash → user
user alias → ordered routes
gateway model ID → model configuration
```

Requirements if caching is implemented:

- Short TTL
- Invalidate after relevant dashboard changes
- Never cache dashboard passwords
- Avoid caching plaintext provider credentials
- Correctness must not depend on cache availability

It is acceptable to skip caching entirely in v1.

---

# 20. Logging and observability

Use Pino.

Redact at least:

```text
authorization
x-api-key
provider API keys
encrypted credential fields
cookies
session tokens
```

Create a request ID for every gateway request.

Log structured metadata:

```text
request_id
user_id
incoming_model
resolved_model
route_index
provider API format
upstream status
duration
time to first token
fallback reason
error category
```

Never log prompts or model responses by default.

The `/health` endpoint should report service and database health without disclosing secrets.

---

# 21. Database migrations and seeds

Provide:

- Initial Drizzle migrations
- A repeatable development setup
- Optional development seed user only when explicitly enabled through environment configuration
- No hardcoded production credentials

Migrations must run safely during Render deployment.

Document the migration command separately from application startup where appropriate. Avoid creating race conditions if multiple instances start simultaneously.

---

# 22. Local development

Provide:

```text
.env.example
docker-compose.yml for PostgreSQL only, if useful
README.md
```

Document commands such as:

```bash
pnpm install
pnpm db:migrate
pnpm dev
pnpm test
pnpm build
pnpm start
```

The project must start locally with one clear workflow.

Provide safe placeholder values for:

```text
DATABASE_URL
SESSION_SECRET
CREDENTIAL_ENCRYPTION_KEY
```

Include a command or script for generating secure random secrets.

---

# 23. Render deployment

Provide either:

```text
render.yaml
```

or complete Render deployment instructions.

The server must listen on:

```text
host: 0.0.0.0
port: process.env.PORT
```

Production build:

```text
Build Vite frontend
Build TypeScript server
Serve frontend static assets from Fastify
```

Use one web service and one PostgreSQL database.

Do not rely on local filesystem persistence.

Ensure streaming is not accidentally buffered by application middleware.

---

# 24. Testing requirements

Implement meaningful automated tests.

## Unit tests

At minimum:

- Gateway model ID generation
- Credential encryption/decryption
- Gateway API-key hashing and verification
- Alias resolution
- Priority ordering
- Capability-based route skipping
- Fallback classification
- Thinking normalization
- Thinking-effort mapping
- Declarative request rules
- Anthropic-to-OpenAI request conversion
- OpenAI-to-Anthropic response conversion
- OpenAI SSE-to-Anthropic SSE conversion
- Tool-call argument streaming

## Integration tests

At minimum:

- Register/login/logout
- User ownership isolation
- Add/edit/delete upstream model
- API key never returned after creation
- Create/revoke gateway API key
- Save and reorder alias mappings
- Direct gateway model lookup
- Alias fallback from failing first route to successful second route
- No fallback after stream output begins
- Metadata request logging
- Provider credential redaction

Use mock upstream HTTP servers for OpenAI-compatible and Anthropic-compatible providers.

## End-to-end smoke test

Exercise:

```text
create user
→ create gateway key
→ add mock OpenAI-compatible model
→ map it to sonnet
→ send Anthropic request to /v1/messages
→ receive Anthropic response
```

Also include a streaming smoke test.

---

# 25. Security requirements

Before declaring completion, verify:

- Passwords are strongly hashed.
- Provider keys are AES-256-GCM encrypted.
- Gateway API keys are stored as hashes.
- Session cookies are HTTP-only and secure in production.
- CSRF protection or same-site protections cover dashboard mutations.
- User ownership is checked for every resource.
- No secret appears in logs, error responses, API payloads, frontend state, or HTML.
- Request-body size limits exist.
- Endpoint validation prevents obvious malformed URLs.
- Server-side request forgery risks are documented and mitigated reasonably.

Because users configure arbitrary upstream endpoints, add SSRF protection.

At minimum:

- Require `https` in production.
- Reject localhost and loopback addresses.
- Reject link-local addresses.
- Reject private-network IP ranges unless an explicit development-only option enables them.
- Revalidate DNS resolution sufficiently to reduce DNS rebinding risk.
- Do not forward arbitrary incoming headers.
- Construct an allowlisted upstream header set.
- Set upstream connection and request timeouts.

Development mode may allow localhost mock providers through a specific environment flag.

---

# 26. Error UX

Dashboard errors must be actionable.

Examples:

```text
Authentication failed
The provider rejected the configured API key.

Model not found
The upstream endpoint did not recognize “mimo-v2.5-pro”.

Unsupported request
This model is configured as not supporting image input.

No eligible Sonnet route
All configured routes are disabled, incompatible, or unavailable.
```

Avoid displaying raw stack traces or giant unformatted JSON responses.

A collapsible sanitized provider error section is acceptable.

---

# 27. Scope exclusions

Do not implement these in v1:

- Billing
- Organizations
- Team roles
- OAuth social login
- Redis
- Memcached
- Background queues
- Weighted routing
- Round robin
- Latency routing
- Cost routing
- Quota-aware routing
- Provider marketplace
- Native web search mapping
- Arbitrary executable rule scripts
- Prompt/response body storage
- Automatic fallback after streamed output starts
- Separate provider and model entities unless clearly required by implementation
- Multi-region deployment
- Kubernetes
- Microservices

Favor a complete, secure, understandable implementation over speculative abstraction.

---

# 28. Implementation order

Execute in this order, adjusting only when dependencies require it.

## Phase 1 — Foundation

- Initialize pnpm workspace
- Configure TypeScript, linting, formatting, testing
- Create Fastify and Vite applications
- Add PostgreSQL and Drizzle
- Add environment validation
- Add basic health endpoint

## Phase 2 — Authentication and security

- User schema
- Registration/login/logout
- Sessions
- Password hashing
- Dashboard route protection
- Gateway API-key creation and verification
- Credential encryption module
- Security and redaction tests

## Phase 3 — Upstream models

- Model schema
- Generated immutable gateway IDs
- Provider key encryption
- Model CRUD API
- Model dashboard
- Optional metadata
- Test model endpoint

## Phase 4 — Mappings

- Generic alias schema
- Seed/create Haiku, Sonnet, Opus aliases
- Ordered route schema
- Mapping API
- Drag-and-drop UI
- Priority persistence
- Direct and alias model resolution

## Phase 5 — Protocol conversion

- Anthropic request parser
- Normalized request representation
- OpenAI-compatible request conversion
- Anthropic-compatible passthrough
- Response conversion
- Normalized errors
- Unit tests

## Phase 6 — Transformation rules

- Declarative rule schema and executor
- Thinking normalization
- Thinking-effort rule
- Rule CRUD
- Thinking editor UI
- Rule preview/tests

## Phase 7 — Streaming

- OpenAI SSE parser
- Anthropic SSE writer
- Text streaming
- Tool-call streaming
- Cancellation and malformed stream handling
- Streaming tests

## Phase 8 — Fallback and capabilities

- Priority executor
- Safe fallback classification
- Image/tool capability skipping
- No fallback after output begins
- Fallback logs
- Integration tests

## Phase 9 — Dashboard completion

- Logs page
- Setup page
- Account/API-key page
- Empty states
- Loading/error states
- Responsive layout
- Copyable configuration

## Phase 10 — Production readiness

- SSRF mitigation
- Rate/body limits
- Security review
- Render configuration
- Migrations
- README
- `.env.example`
- Complete automated test suite
- Production build
- End-to-end smoke test

---

# 29. Definition of Done

Do not declare completion until all of these are true:

- The repository installs successfully from a clean checkout.
- Database migrations run successfully.
- The full project starts locally.
- Registration, login, logout, and session restoration work.
- Gateway API keys can be created and revoked.
- Provider credentials are encrypted and never returned.
- Users can add OpenAI-compatible models.
- Users can add Anthropic-compatible models.
- Gateway model IDs are generated automatically and remain immutable.
- Duplicate upstream model names across providers work without collisions.
- Users can configure Haiku, Sonnet, and Opus priority lists.
- Drag-and-drop ordering persists.
- Direct generated model IDs work.
- Logical aliases work.
- OpenAI-compatible non-streaming conversion works.
- OpenAI-compatible streaming conversion works.
- Anthropic-compatible passthrough works.
- Text, tools, tool results, and supported image input are handled.
- Thinking-effort transformation works.
- Multiple ordered declarative rules work.
- Priority fallback works before stream output begins.
- Fallback does not occur after output begins.
- Unsupported capabilities cause a route to be skipped.
- Request logs contain metadata only.
- Secrets are redacted.
- User data is isolated.
- SSRF protection exists.
- Unit tests pass.
- Integration tests pass.
- End-to-end smoke tests pass.
- Linting and type checking pass.
- Production build passes.
- Render deployment configuration is included.
- README contains complete local and deployment instructions.
- No placeholder TODOs remain in core behavior.
- No mocked implementation is used in production paths.

---

# 30. Autonomous execution rules

During implementation:

1. Inspect the existing repository before changing it.
2. Reuse existing conventions if the repository is already initialized.
3. Keep changes cohesive and compile frequently.
4. Run tests after every major phase.
5. Fix failures before continuing.
6. Do not silence TypeScript errors with broad `any`.
7. Do not skip tests merely to obtain a green build.
8. Do not leave core features as comments or TODOs.
9. Do not expose secrets for debugging.
10. Prefer simple explicit modules over excessive abstraction.
11. Keep the main gateway request flow readable.
12. Add comments only where protocol behavior is non-obvious.
13. Update the README as actual behavior changes.
14. If a planned library creates integration problems, replace it with a simpler maintained alternative while preserving the required behavior.
15. Continue until the Definition of Done is met.

At completion, provide:

- A concise architecture summary
- Important file paths
- Database schema summary
- Environment variables
- Local startup commands
- Render deployment instructions
- Test commands and results
- Any remaining non-blocking limitations

Do not report “done” unless the production build and automated tests pass.
