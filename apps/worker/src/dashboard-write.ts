import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createDbClient } from '../../../packages/db/src/index.js';
import {
  connectionTokenInputSchema,
  connectionTokenUpdateSchema,
  modelBindingInputSchema,
  providerConnectionInputSchema,
} from '../../../packages/shared/src/index.js';
import type { WorkerDbEnv } from './db.js';

export interface DashboardWriteEnv extends WorkerDbEnv {
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CLIPROXY_BASE_URL?: string;
  CLIPROXY_MANAGEMENT_KEY?: string;
}

const KNOWN_PROVIDERS = new Set(['codex', 'claude', 'antigravity']);
const MANAGED_CONNECTION_NAME = 'CLIProxyAPI';
const MANAGED_TOKEN_NAME = 'Gateway-managed CLIProxy credential';

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get('cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

async function withClient<T>(env: WorkerDbEnv, fn: (client: ReturnType<typeof createDbClient>) => Promise<T>) {
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

async function dashboardUser(request: Request, env: WorkerDbEnv) {
  const token = cookieValue(request, 'gateway_session');
  if (!token) return undefined;
  return withClient(env, async (client) => {
    const result = await client.query<{ id: string; username: string }>(
      `SELECT u.id, u.username
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.expires_at > NOW()
        LIMIT 1`,
      [hashSecret(token)],
    );
    return result.rows[0];
  });
}

async function bodyObject(request: Request) {
  try {
    const value = await request.json();
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function encryptionKey(value: string) {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 ? decoded : createHash('sha256').update(value).digest();
}

function encryptCredential(value: string, keyValue: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    encryptedApiKey: encrypted.toString('base64'),
    encryptionIv: iv.toString('base64'),
    encryptionAuthTag: cipher.getAuthTag().toString('base64'),
  };
}

function maskApiKey(value: string) {
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

function normalizedBaseUrl(value: string) {
  return value.replace(/\/$/, '');
}

function validateBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Base URL must use http or https');
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function isCliproxyConnection(env: DashboardWriteEnv, baseUrl: string) {
  return !!env.CLIPROXY_BASE_URL && normalizedBaseUrl(baseUrl) === normalizedBaseUrl(env.CLIPROXY_BASE_URL);
}

function requireEncryptionKey(env: DashboardWriteEnv) {
  if (!env.CREDENTIAL_ENCRYPTION_KEY) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured');
  return env.CREDENTIAL_ENCRYPTION_KEY;
}

function cliproxyConfig(env: DashboardWriteEnv) {
  if (!env.CLIPROXY_BASE_URL || !env.CLIPROXY_MANAGEMENT_KEY) return undefined;
  return { baseUrl: normalizedBaseUrl(env.CLIPROXY_BASE_URL), managementKey: env.CLIPROXY_MANAGEMENT_KEY };
}

async function ownedConnection(env: WorkerDbEnv, userId: string, connectionId: string) {
  return withClient(env, async (client) => {
    const result = await client.query<{ id: string; base_url: string }>(
      'SELECT id, base_url FROM provider_connections WHERE id = $1 AND user_id = $2 LIMIT 1',
      [connectionId, userId],
    );
    return result.rows[0];
  });
}

async function addProxyApiKey(cfg: { baseUrl: string; managementKey: string }, apiKey: string) {
  const response = await fetch(`${cfg.baseUrl}/v0/management/api-keys`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${cfg.managementKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ old: '', new: apiKey }),
  });
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  throw new Error(`CLIProxyAPI API-key provisioning failed: ${text || response.statusText}`);
}

async function removeProxyApiKey(cfg: { baseUrl: string; managementKey: string }, apiKey: string) {
  await fetch(`${cfg.baseUrl}/v0/management/api-keys?value=${encodeURIComponent(apiKey)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${cfg.managementKey}` },
  }).catch(() => undefined);
}

async function ensureManagedConnection(env: DashboardWriteEnv, userId: string, cfg: { baseUrl: string; managementKey: string }) {
  const existing = await withClient(env, async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM provider_connections
        WHERE user_id = $1 AND regexp_replace(base_url, '/$', '') = $2
        LIMIT 1`,
      [userId, cfg.baseUrl],
    );
    return result.rows[0];
  });
  if (existing) return existing;

  const apiKey = `cpx_${randomBytes(32).toString('base64url')}`;
  await addProxyApiKey(cfg, apiKey);
  const encrypted = encryptCredential(apiKey, requireEncryptionKey(env));
  try {
    return await withClient(env, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cliproxy-connection:${userId}`]);
        const again = await client.query<{ id: string }>(
          `SELECT id FROM provider_connections
            WHERE user_id = $1 AND regexp_replace(base_url, '/$', '') = $2
            LIMIT 1`,
          [userId, cfg.baseUrl],
        );
        if (again.rows[0]) {
          await client.query('COMMIT');
          await removeProxyApiKey(cfg, apiKey);
          return again.rows[0];
        }
        const connection = await client.query<{ id: string }>(
          `INSERT INTO provider_connections (user_id, display_name, base_url)
           VALUES ($1, $2, $3) RETURNING id`,
          [userId, MANAGED_CONNECTION_NAME, cfg.baseUrl],
        );
        const connectionId = connection.rows[0]!.id;
        await client.query(
          `INSERT INTO connection_tokens
             (user_id, connection_id, name, key_preview, encrypted_api_key, encryption_iv, encryption_auth_tag, system_managed)
           VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)`,
          [userId, connectionId, MANAGED_TOKEN_NAME, maskApiKey(apiKey), encrypted.encryptedApiKey, encrypted.encryptionIv, encrypted.encryptionAuthTag],
        );
        await client.query('COMMIT');
        return { id: connectionId };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    await removeProxyApiKey(cfg, apiKey);
    throw error;
  }
}

export async function handleDashboardWriteRequest(
  request: Request,
  env: DashboardWriteEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return undefined;

  const relevant =
    url.pathname === '/api/connections' ||
    /^\/api\/connections\/[^/]+(?:\/tokens(?:\/[^/]+)?|\/bindings(?:\/[^/]+)?)?$/.test(url.pathname) ||
    url.pathname === '/api/cliproxy/accounts' ||
    /^\/api\/cliproxy\/accounts\/[^/]+$/.test(url.pathname);
  if (!relevant) return undefined;

  const user = await dashboardUser(request, env);
  if (!user) return json({ error: 'Authentication required' }, 401);

  if (url.pathname === '/api/connections' && request.method === 'POST') {
    const parsed = providerConnectionInputSchema.safeParse(await bodyObject(request));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? 'Invalid connection' }, 400);
    let baseUrl: string;
    try {
      baseUrl = validateBaseUrl(parsed.data.baseUrl);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Invalid base URL' }, 400);
    }
    const result = await withClient(env, (client) => client.query(
      `INSERT INTO provider_connections (user_id, display_name, base_url, enabled)
       VALUES ($1,$2,$3,$4)
       RETURNING id, display_name AS "displayName", base_url AS "baseUrl", enabled,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [user.id, parsed.data.displayName, baseUrl, parsed.data.enabled],
    ));
    return json(result.rows[0], 201);
  }

  const connectionMatch = url.pathname.match(/^\/api\/connections\/([^/]+)$/);
  if (connectionMatch && request.method === 'PATCH') {
    const body = await bodyObject(request);
    const parsed = providerConnectionInputSchema.partial().safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? 'Invalid connection' }, 400);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (parsed.data.displayName !== undefined) { values.push(parsed.data.displayName); sets.push(`display_name = $${values.length}`); }
    if (parsed.data.baseUrl !== undefined) {
      try { values.push(validateBaseUrl(parsed.data.baseUrl)); } catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid base URL' }, 400); }
      sets.push(`base_url = $${values.length}`);
    }
    if (parsed.data.enabled !== undefined) { values.push(parsed.data.enabled); sets.push(`enabled = $${values.length}`); }
    if (!sets.length) return json({ error: 'No changes supplied' }, 400);
    values.push(connectionMatch[1], user.id);
    const result = await withClient(env, (client) => client.query(
      `UPDATE provider_connections SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${values.length - 1} AND user_id = $${values.length}
        RETURNING id, display_name AS "displayName", base_url AS "baseUrl", enabled,
                  created_at AS "createdAt", updated_at AS "updatedAt"`,
      values,
    ));
    return result.rows[0] ? json(result.rows[0]) : json({ error: 'Provider connection not found' }, 404);
  }

  if (connectionMatch && request.method === 'DELETE') {
    const result = await withClient(env, (client) => client.query(
      'DELETE FROM provider_connections WHERE id = $1 AND user_id = $2 RETURNING id',
      [connectionMatch[1], user.id],
    ));
    return result.rows[0] ? json({ ok: true }) : json({ error: 'Provider connection not found' }, 404);
  }

  const tokensMatch = url.pathname.match(/^\/api\/connections\/([^/]+)\/tokens(?:\/([^/]+))?$/);
  if (tokensMatch) {
    const connectionId = tokensMatch[1]!;
    const tokenId = tokensMatch[2];
    const connection = await ownedConnection(env, user.id, connectionId);
    if (!connection) return json({ error: 'Provider connection not found' }, 404);
    if (isCliproxyConnection(env, connection.base_url)) return json({ error: 'CLIProxyAPI credentials are managed by the server' }, 403);

    if (!tokenId && request.method === 'GET') {
      const result = await withClient(env, (client) => client.query(
        `SELECT id, connection_id AS "connectionId", name, key_preview AS "keyPreview", enabled,
                cooldown_until AS "cooldownUntil", latest_error AS "latestError",
                latest_error_at AS "latestErrorAt", created_at AS "createdAt", updated_at AS "updatedAt"
           FROM connection_tokens WHERE connection_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
        [connectionId, user.id],
      ));
      return json(result.rows);
    }

    if (!tokenId && request.method === 'POST') {
      const parsed = connectionTokenInputSchema.safeParse(await bodyObject(request));
      if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? 'Invalid token' }, 400);
      const encrypted = encryptCredential(parsed.data.apiKey, requireEncryptionKey(env));
      try {
        const result = await withClient(env, async (client) => {
          await client.query('BEGIN');
          try {
            const inserted = await client.query<{ id: string } & Record<string, unknown>>(
              `INSERT INTO connection_tokens
                 (user_id, connection_id, name, key_preview, enabled, encrypted_api_key, encryption_iv, encryption_auth_tag)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               RETURNING id, connection_id AS "connectionId", name, key_preview AS "keyPreview", enabled,
                         cooldown_until AS "cooldownUntil", latest_error AS "latestError",
                         latest_error_at AS "latestErrorAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
              [user.id, connectionId, parsed.data.name, maskApiKey(parsed.data.apiKey), parsed.data.enabled, encrypted.encryptedApiKey, encrypted.encryptionIv, encrypted.encryptionAuthTag],
            );
            const id = inserted.rows[0]!.id;
            await client.query(
              `INSERT INTO binding_routes (user_id, binding_id, token_id)
               SELECT $1, mb.id, $2 FROM model_bindings mb
                WHERE mb.user_id = $1 AND mb.connection_id = $3
               ON CONFLICT DO NOTHING`,
              [user.id, id, connectionId],
            );
            await client.query('COMMIT');
            return inserted.rows[0];
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
          }
        });
        return json(result, 201);
      } catch (error) {
        if ((error as { code?: string })?.code === '23505') return json({ error: 'A token with this name already exists on this connection.' }, 409);
        throw error;
      }
    }

    if (tokenId && request.method === 'PATCH') {
      const parsed = connectionTokenUpdateSchema.safeParse(await bodyObject(request));
      if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? 'Invalid token' }, 400);
      const sets: string[] = [];
      const values: unknown[] = [];
      if (parsed.data.name !== undefined) { values.push(parsed.data.name); sets.push(`name = $${values.length}`); }
      if (parsed.data.enabled !== undefined) { values.push(parsed.data.enabled); sets.push(`enabled = $${values.length}`); }
      if (parsed.data.apiKey !== undefined) {
        const encrypted = encryptCredential(parsed.data.apiKey, requireEncryptionKey(env));
        values.push(maskApiKey(parsed.data.apiKey)); sets.push(`key_preview = $${values.length}`);
        values.push(encrypted.encryptedApiKey); sets.push(`encrypted_api_key = $${values.length}`);
        values.push(encrypted.encryptionIv); sets.push(`encryption_iv = $${values.length}`);
        values.push(encrypted.encryptionAuthTag); sets.push(`encryption_auth_tag = $${values.length}`);
      }
      if (!sets.length) return json({ error: 'No changes supplied' }, 400);
      values.push(tokenId, connectionId, user.id);
      const result = await withClient(env, (client) => client.query(
        `UPDATE connection_tokens SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $${values.length - 2} AND connection_id = $${values.length - 1} AND user_id = $${values.length}
          RETURNING id, connection_id AS "connectionId", name, key_preview AS "keyPreview", enabled,
                    cooldown_until AS "cooldownUntil", latest_error AS "latestError",
                    latest_error_at AS "latestErrorAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
        values,
      ));
      return result.rows[0] ? json(result.rows[0]) : json({ error: 'Token not found' }, 404);
    }

    if (tokenId && request.method === 'DELETE') {
      const result = await withClient(env, (client) => client.query(
        'DELETE FROM connection_tokens WHERE id = $1 AND connection_id = $2 AND user_id = $3 RETURNING id',
        [tokenId, connectionId, user.id],
      ));
      return result.rows[0] ? json({ ok: true }) : json({ error: 'Token not found' }, 404);
    }
  }

  const bindingsMatch = url.pathname.match(/^\/api\/connections\/([^/]+)\/bindings(?:\/([^/]+))?$/);
  if (bindingsMatch) {
    const connectionId = bindingsMatch[1]!;
    const bindingId = bindingsMatch[2];
    const connection = await ownedConnection(env, user.id, connectionId);
    if (!connection) return json({ error: 'Provider connection not found' }, 404);

    if (!bindingId && request.method === 'GET') {
      const result = await withClient(env, (client) => client.query(
        `SELECT mb.id, mb.preset_id AS "presetId", mp.display_name AS "presetDisplayName",
                mp.upstream_model_id AS "presetUpstreamModelId", mb.connection_id AS "connectionId",
                mb.api_format AS "apiFormat", mb.provider_base_path AS "providerBasePath",
                mb.cliproxy_account_id AS "cliproxyAccountId", ca.label AS "cliproxyAccountLabel",
                ca.prefix AS "cliproxyAccountPrefix", mb.created_at AS "createdAt", mb.updated_at AS "updatedAt"
           FROM model_bindings mb
           JOIN model_presets mp ON mp.id = mb.preset_id
           LEFT JOIN cliproxy_accounts ca ON ca.id = mb.cliproxy_account_id
          WHERE mb.connection_id = $1 AND mb.user_id = $2
          ORDER BY mb.created_at DESC`,
        [connectionId, user.id],
      ));
      return json(result.rows);
    }

    if (!bindingId && request.method === 'POST') {
      const parsed = modelBindingInputSchema.safeParse(await bodyObject(request));
      if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? 'Invalid binding' }, 400);
      const isCliproxy = isCliproxyConnection(env, connection.base_url);
      if (isCliproxy && !parsed.data.cliproxyAccountId) return json({ error: 'Select a CLIProxy account for this binding' }, 400);
      if (!isCliproxy && parsed.data.cliproxyAccountId) return json({ error: 'CLIProxy accounts can only be used with the CLIProxyAPI connection' }, 400);

      const bound: unknown[] = [];
      const failed: Array<{ presetId: string; error: string }> = [];
      for (const presetId of parsed.data.presetIds) {
        try {
          const binding = await withClient(env, async (client) => {
            await client.query('BEGIN');
            try {
              const presetResult = await client.query<{
                id: string; display_name: string; upstream_model_id: string; api_format: string;
                supports_images: string; supports_reasoning: string; max_output_tokens: number | null;
              }>(
                `SELECT id, display_name, upstream_model_id, api_format, supports_images, supports_reasoning, max_output_tokens
                   FROM model_presets WHERE id = $1 AND (user_id IS NULL OR user_id = $2) LIMIT 1`,
                [presetId, user.id],
              );
              const preset = presetResult.rows[0];
              if (!preset) throw new Error('Preset not found');
              let account: { id: string; prefix: string; label: string | null } | undefined;
              if (parsed.data.cliproxyAccountId) {
                const accountResult = await client.query<{ id: string; prefix: string; label: string | null }>(
                  'SELECT id, prefix, label FROM cliproxy_accounts WHERE id = $1 AND user_id = $2 LIMIT 1',
                  [parsed.data.cliproxyAccountId, user.id],
                );
                account = accountResult.rows[0];
                if (!account) throw new Error('CLIProxy account not found');
              }
              const apiFormat = parsed.data.apiFormat ?? preset.api_format;
              const upstreamModelId = account ? `${account.prefix}/${preset.upstream_model_id}` : preset.upstream_model_id;
              const inserted = await client.query<Record<string, unknown> & { id: string }>(
                `INSERT INTO model_bindings
                   (user_id, preset_id, connection_id, api_format, provider_base_path, cliproxy_account_id,
                    display_name, upstream_model_id, max_output_tokens, supports_streaming, supports_tools, supports_images, supports_reasoning)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unknown','unknown',$10,$11)
                 RETURNING id, preset_id AS "presetId", connection_id AS "connectionId", api_format AS "apiFormat",
                           provider_base_path AS "providerBasePath", cliproxy_account_id AS "cliproxyAccountId",
                           created_at AS "createdAt", updated_at AS "updatedAt"`,
                [user.id, presetId, connectionId, apiFormat, parsed.data.providerBasePath, account?.id ?? null,
                 preset.display_name, upstreamModelId, preset.max_output_tokens, preset.supports_images, preset.supports_reasoning],
              );
              const id = inserted.rows[0]!.id;
              await client.query(
                `INSERT INTO binding_routes (user_id, binding_id, token_id)
                 SELECT $1, $2, ct.id FROM connection_tokens ct
                  WHERE ct.user_id = $1 AND ct.connection_id = $3 AND ct.enabled = TRUE
                 ON CONFLICT DO NOTHING`,
                [user.id, id, connectionId],
              );
              await client.query('COMMIT');
              return {
                ...inserted.rows[0],
                presetDisplayName: preset.display_name,
                presetUpstreamModelId: preset.upstream_model_id,
                cliproxyAccountLabel: account?.label ?? null,
                cliproxyAccountPrefix: account?.prefix ?? null,
              };
            } catch (error) {
              await client.query('ROLLBACK').catch(() => undefined);
              throw error;
            }
          });
          bound.push(binding);
        } catch (error) {
          const message = (error as { code?: string })?.code === '23505'
            ? 'This preset is already bound to this connection with the same API format.'
            : error instanceof Error ? error.message : 'Bind failed';
          failed.push({ presetId, error: message });
        }
      }
      if (!bound.length) return json({ bound, failed }, 409);
      return json({ bound, failed }, failed.length ? 207 : 201);
    }

    if (bindingId && request.method === 'DELETE') {
      const result = await withClient(env, (client) => client.query(
        'DELETE FROM model_bindings WHERE id = $1 AND connection_id = $2 AND user_id = $3 RETURNING id',
        [bindingId, connectionId, user.id],
      ));
      return result.rows[0] ? json({ ok: true }) : json({ error: 'Binding not found' }, 404);
    }
  }

  if (url.pathname === '/api/cliproxy/accounts' && request.method === 'GET') {
    const accounts = await withClient(env, (client) => client.query(
      `SELECT id, provider, prefix, label, created_at AS "createdAt"
         FROM cliproxy_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
      [user.id],
    ));
    if (!accounts.rows.length) return json([]);
    const states = await withClient(env, (client) => client.query(
      `SELECT cms.cliproxy_account_id AS "cliproxyAccountId", cms.upstream_model_id AS "upstreamModelId",
              cms.cooldown_until AS "cooldownUntil", cms.latest_error AS "latestError", cms.latest_error_at AS "latestErrorAt"
         FROM cliproxy_model_states cms
         JOIN cliproxy_accounts ca ON ca.id = cms.cliproxy_account_id
        WHERE ca.user_id = $1 ORDER BY cms.latest_error_at DESC NULLS LAST`,
      [user.id],
    ));
    return json(accounts.rows.map((account: any) => ({
      ...account,
      modelStates: states.rows.filter((state: any) => state.cliproxyAccountId === account.id),
    })));
  }

  if (url.pathname === '/api/cliproxy/accounts' && request.method === 'POST') {
    const cfg = cliproxyConfig(env);
    if (!cfg) return json({ error: 'CLIProxyAPI integration is not configured' }, 503);
    const form = await request.formData().catch(() => undefined);
    const file = form?.get('file');
    if (!(file instanceof File)) return json({ error: 'No file uploaded' }, 400);
    if (!file.name.toLowerCase().endsWith('.json')) return json({ error: 'File must be .json' }, 400);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(await file.text()) as Record<string, unknown>; }
    catch { return json({ error: 'File is not valid JSON' }, 400); }
    const provider = typeof parsed.type === 'string' ? parsed.type : undefined;
    if (!provider || !KNOWN_PROVIDERS.has(provider)) return json({ error: `Could not detect a supported provider from the file's "type" field (got: ${provider ?? 'missing'})` }, 400);
    const label = typeof parsed.email === 'string' ? parsed.email : undefined;

    const existing = label ? await withClient(env, async (client) => {
      const result = await client.query<{ id: string; prefix: string; file_name: string }>(
        'SELECT id, prefix, file_name FROM cliproxy_accounts WHERE user_id = $1 AND provider = $2 AND label = $3 LIMIT 1',
        [user.id, provider, label],
      );
      return result.rows[0];
    }) : undefined;
    const prefix = existing?.prefix ?? `${provider}-${randomBytes(6).toString('hex')}`;
    const fileName = existing?.file_name ?? `${prefix}.json`;
    const upload = new FormData();
    upload.append('file', file, fileName);
    const uploadRes = await fetch(`${cfg.baseUrl}/v0/management/auth-files`, {
      method: 'POST', headers: { authorization: `Bearer ${cfg.managementKey}` }, body: upload,
    });
    if (!uploadRes.ok) return json({ error: `CLIProxyAPI upload failed: ${(await uploadRes.text().catch(() => '')) || uploadRes.statusText}` }, 502);
    const patchRes = await fetch(`${cfg.baseUrl}/v0/management/auth-files/fields`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${cfg.managementKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: fileName, prefix }),
    });
    if (!patchRes.ok) {
      await fetch(`${cfg.baseUrl}/v0/management/auth-files?name=${encodeURIComponent(fileName)}`, { method: 'DELETE', headers: { authorization: `Bearer ${cfg.managementKey}` } }).catch(() => undefined);
      return json({ error: `CLIProxyAPI prefix assignment failed: ${(await patchRes.text().catch(() => '')) || patchRes.statusText}` }, 502);
    }
    try { await ensureManagedConnection(env, user.id, cfg); }
    catch (error) {
      await fetch(`${cfg.baseUrl}/v0/management/auth-files?name=${encodeURIComponent(fileName)}`, { method: 'DELETE', headers: { authorization: `Bearer ${cfg.managementKey}` } }).catch(() => undefined);
      throw error;
    }
    if (existing) return json({ id: existing.id, provider, prefix, fileName, label }, 200);
    try {
      const result = await withClient(env, (client) => client.query(
        `INSERT INTO cliproxy_accounts (user_id, provider, prefix, file_name, label)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, provider, prefix, file_name AS "fileName", label, created_at AS "createdAt"`,
        [user.id, provider, prefix, fileName, label ?? null],
      ));
      return json(result.rows[0], 201);
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') return json({ error: 'Prefix collision — please retry the upload.' }, 409);
      throw error;
    }
  }

  const accountMatch = url.pathname.match(/^\/api\/cliproxy\/accounts\/([^/]+)$/);
  if (accountMatch && request.method === 'DELETE') {
    const cfg = cliproxyConfig(env);
    if (!cfg) return json({ error: 'CLIProxyAPI integration is not configured' }, 503);
    const account = await withClient(env, async (client) => {
      const result = await client.query<{ id: string; file_name: string }>(
        'SELECT id, file_name FROM cliproxy_accounts WHERE id = $1 AND user_id = $2 LIMIT 1',
        [accountMatch[1], user.id],
      );
      return result.rows[0];
    });
    if (!account) return json({ error: 'Account not found' }, 404);
    const deleteRes = await fetch(`${cfg.baseUrl}/v0/management/auth-files?name=${encodeURIComponent(account.file_name)}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${cfg.managementKey}` },
    });
    if (!deleteRes.ok && deleteRes.status !== 404) return json({ error: `CLIProxyAPI delete failed: ${(await deleteRes.text().catch(() => '')) || deleteRes.statusText}` }, 502);
    await withClient(env, (client) => client.query('DELETE FROM cliproxy_accounts WHERE id = $1 AND user_id = $2', [account.id, user.id]));
    return json({ ok: true });
  }

  return undefined;
}
