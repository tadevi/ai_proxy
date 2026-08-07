import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { createDbClient } from '../../../packages/db/src/index.js';
import {
  anthropicToOpenAI,
  applyRules,
  normalizeThinking,
  openAIToAnthropic,
  type AnthropicRequest,
  type Rule,
} from '../../../packages/protocol/src/index.js';
import type { GatewayParityEnv } from './gateway-parity.js';

type Client = ReturnType<typeof createDbClient>;
type Route = {
  id: string;
  binding_id: string;
  token_id: string | null;
  display_name: string;
  upstream_model_id: string;
  api_format: 'openai_compatible' | 'anthropic_compatible';
  provider_base_path: string;
  request_path_override: string | null;
  max_output_tokens: number | null;
  supports_reasoning: 'yes' | 'no' | 'unknown';
  connection_id: string;
  connection_name: string;
  base_url: string;
  encrypted_api_key: string | null;
  encryption_iv: string | null;
  encryption_auth_tag: string | null;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');

function cookieValue(request: Request, name: string) {
  const raw = request.headers.get('cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

async function withClient<T>(env: GatewayParityEnv, fn: (client: Client) => Promise<T>) {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) throw new Error('Database is not configured');
  const client = createDbClient(connectionString);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function dashboardUser(request: Request, env: GatewayParityEnv) {
  const token = cookieValue(request, 'gateway_session');
  if (!token) return undefined;
  return withClient(env, async (client) => {
    const result = await client.query<{ user_id: string }>(
      'SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > NOW() LIMIT 1',
      [hashSecret(token)],
    );
    return result.rows[0]?.user_id;
  });
}

function decrypt(route: Route, keyValue: string) {
  if (!route.encrypted_api_key || !route.encryption_iv || !route.encryption_auth_tag)
    throw new Error('No enabled API token configured for this model.');
  const decoded = Buffer.from(keyValue, 'base64');
  const key = decoded.length === 32 ? decoded : createHash('sha256').update(keyValue).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(route.encryption_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(route.encryption_auth_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(route.encrypted_api_key, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

async function loadRoute(env: GatewayParityEnv, userId: string, routeId: string) {
  return withClient(env, async (client) => {
    const result = await client.query<Route>(
      `SELECT br.id, br.binding_id, br.token_id,
              mb.display_name, mb.upstream_model_id, mb.api_format, mb.provider_base_path,
              mb.request_path_override, mb.max_output_tokens, mb.supports_reasoning,
              pc.id AS connection_id, pc.display_name AS connection_name, pc.base_url,
              ct.encrypted_api_key, ct.encryption_iv, ct.encryption_auth_tag
         FROM binding_routes br
         JOIN model_bindings mb ON mb.id = br.binding_id AND mb.user_id = $2
         JOIN provider_connections pc ON pc.id = mb.connection_id
         LEFT JOIN connection_tokens ct ON ct.id = br.token_id AND ct.enabled = TRUE
        WHERE br.id = $1 AND br.user_id = $2
        LIMIT 1`,
      [routeId, userId],
    );
    return result.rows[0];
  });
}

async function loadRules(env: GatewayParityEnv, bindingId: string) {
  return withClient(env, async (client) => {
    const result = await client.query<{
      type: string;
      enabled: boolean;
      position: number;
      config_json: Record<string, unknown>;
    }>(
      `SELECT type, enabled, position, config_json
         FROM transformation_rules
        WHERE binding_id = $1
        ORDER BY position ASC`,
      [bindingId],
    );
    return result.rows.map((row) => ({
      type: row.type,
      enabled: row.enabled,
      position: row.position,
      config: row.config_json,
    })) as Rule[];
  });
}

function endpoint(route: Route, env: GatewayParityEnv) {
  const base = route.connection_name === 'CLIProxyAPI' && env.CLIPROXY_BASE_URL
    ? env.CLIPROXY_BASE_URL
    : route.base_url;
  const defaultPath = route.api_format === 'openai_compatible' ? '/chat/completions' : '/v1/messages';
  return `${base.replace(/\/+$/, '')}${route.request_path_override ?? `${route.provider_base_path}${defaultPath}`}`;
}

function safeProviderError(response: Response, value: unknown) {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const error = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : root;
  const details: Record<string, unknown> = { upstreamStatus: response.status };
  const requestId = response.headers.get('request-id') ?? response.headers.get('x-request-id') ?? response.headers.get('trace-id');
  if (requestId) details.requestId = requestId.slice(0, 200);
  const safe: Record<string, unknown> = {};
  for (const key of ['code', 'type', 'param', 'message', 'request_id', 'requestId']) {
    const item = error[key] ?? root[key];
    if (typeof item === 'string' || typeof item === 'number') safe[key] = item;
  }
  if (Object.keys(safe).length) details.response = safe;
  return details;
}

async function callSelectedRoute(
  env: GatewayParityEnv,
  route: Route,
  request: AnthropicRequest,
  rules: Rule[],
) {
  if (!env.CREDENTIAL_ENCRYPTION_KEY) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured');
  const key = decrypt(route, env.CREDENTIAL_ENCRYPTION_KEY);
  const adjusted = route.max_output_tokens
    ? { ...request, max_tokens: Math.min(request.max_tokens, route.max_output_tokens) }
    : request;
  let body: Record<string, unknown>;
  let headers: Record<string, string>;

  // model_bindings.upstream_model_id is already the exact provider-facing model id.
  // CLIProxy bindings already include their account prefix, so never prefix it again here.
  if (route.api_format === 'openai_compatible') {
    body = await anthropicToOpenAI(adjusted, route.upstream_model_id, {
      supportsReasoning: route.supports_reasoning === 'yes',
      supportsReasoningBudget: route.supports_reasoning === 'yes',
      supportsReasoningEffort: route.supports_reasoning === 'yes',
      supportsAdaptiveReasoning: route.supports_reasoning === 'yes',
    });
    body = applyRules(body, rules, normalizeThinking(adjusted.thinking, adjusted.output_config));
    headers = {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  } else {
    body = { ...adjusted, model: route.upstream_model_id } as unknown as Record<string, unknown>;
    headers = {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS ?? '60000');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 60000);
  try {
    const response = await fetch(endpoint(route, env), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      // Cloudflare Workers do not implement redirect: 'error'. Manual preserves the
      // no-follow behavior: 3xx responses come back to us and fail response.ok below.
      redirect: 'manual',
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
      return {
        ok: false as const,
        message: response.status === 401 || response.status === 403
          ? 'The provider rejected the configured API key.'
          : response.status === 404
            ? 'The upstream endpoint or model was not found.'
            : `The upstream provider returned HTTP ${response.status}.`,
        providerError: safeProviderError(response, parsed),
      };
    }
    const raw = await response.json() as Record<string, unknown>;
    const converted = route.api_format === 'openai_compatible'
      ? await openAIToAnthropic(raw, route.upstream_model_id)
      : { ...raw, model: route.upstream_model_id };
    return { ok: true as const, body: converted };
  } finally {
    clearTimeout(timer);
  }
}

export async function handlePlaygroundDirectRequest(
  request: Request,
  env: GatewayParityEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/playground/complete') return undefined;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const userId = await dashboardUser(request, env);
  if (!userId) return json({ error: 'Authentication required' }, 401);
  const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
  const modelId = typeof body?.modelId === 'string' ? body.modelId : '';
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!modelId || !prompt) return json({ error: 'modelId and prompt are required' }, 400);

  const route = await loadRoute(env, userId, modelId);
  if (!route) return json({ error: 'Model not found' }, 404);
  const rules = await loadRules(env, route.binding_id);
  const content: Array<Record<string, unknown>> = [];
  if (typeof body?.imageBase64 === 'string' && typeof body?.imageMediaType === 'string') {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: body.imageMediaType, data: body.imageBase64 },
    });
  }
  content.push({ type: 'text', text: prompt });
  const anthropic = {
    model: route.upstream_model_id,
    max_tokens: typeof body?.maxTokens === 'number' && body.maxTokens > 0 ? Math.floor(body.maxTokens) : 1024,
    messages: [{ role: 'user', content }],
    stream: false,
    ...(body?.includeTestTool ? {
      tools: [{
        name: 'web_search',
        description: 'Search the web for up-to-date information on a topic.',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'The search query' } },
          required: ['query'],
        },
      }],
    } : {}),
  } as unknown as AnthropicRequest;

  const requestId = request.headers.get('cf-ray') ?? randomUUID();
  try {
    const result = await callSelectedRoute(env, route, anthropic, rules);
    if (!result.ok) return json({ ok: false, message: result.message, providerError: result.providerError, requestId }, 502);
    await withClient(env, (client) => client.query(
      `UPDATE binding_routes SET latest_test_status = 'healthy', latest_test_at = NOW(), latest_error = NULL,
       latest_error_at = NULL, fallback_cooldown_until = NULL, updated_at = NOW() WHERE id = $1`,
      [route.id],
    )).catch(() => undefined);
    return json({ ok: true, response: result.body });
  } catch (error) {
    return json({
      ok: false,
      message: error instanceof Error && error.name === 'AbortError'
        ? 'The upstream provider timed out.'
        : error instanceof Error ? error.message : 'Playground request failed',
      requestId,
    }, 502);
  }
}
