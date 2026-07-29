import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  cliproxyAccounts,
  connectionTokens,
  modelBindings,
  providerConnections,
  upstreamModels,
} from '@gateway/db';
import { encryptCredential, isUniqueViolation, maskApiKey } from '../security.js';

// CLIProxyAPI's own provider names in the auth file's "type" field — Gemini auth files
// use "antigravity" (its internal name for Gemini/Antigravity), not "gemini".
const KNOWN_PROVIDERS = new Set(['codex', 'claude', 'antigravity']);
const MANAGED_CONNECTION_NAME = 'CLIProxyAPI';
const MANAGED_TOKEN_NAME = 'Gateway-managed CLIProxy credential';

type Json = Record<string, unknown>;

type CliproxyConfig = { baseUrl: string; managementKey: string };

function normalizedBaseUrl(value: string) {
  return value.replace(/\/$/, '');
}

async function addProxyApiKey(cfg: CliproxyConfig, apiKey: string) {
  // PATCH appends when its `old` value is not in CLIProxyAPI's current api-keys list.
  // It avoids a read/replace race with management-panel edits or another provision request.
  const response = await fetch(`${normalizedBaseUrl(cfg.baseUrl)}/v0/management/api-keys`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${cfg.managementKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ old: '', new: apiKey }),
  });
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  throw new Error(`CLIProxyAPI API-key provisioning failed: ${text || response.statusText}`);
}

async function removeProxyApiKey(cfg: CliproxyConfig, apiKey: string) {
  await fetch(
    `${normalizedBaseUrl(cfg.baseUrl)}/v0/management/api-keys?value=${encodeURIComponent(apiKey)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${cfg.managementKey}` } },
  ).catch(() => {});
}

async function ensureManagedConnection(app: FastifyInstance, userId: string, cfg: CliproxyConfig) {
  return app.db.transaction(async (tx) => {
    // A user can upload two auth files concurrently. Serialize provisioning per user so
    // that both uploads share one CLIProxy connection and inference credential.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`cliproxy-connection:${userId}`}))`,
    );

    const connections = await tx
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.userId, userId));
    const existing = connections.find(
      (connection) => normalizedBaseUrl(connection.baseUrl) === normalizedBaseUrl(cfg.baseUrl),
    );
    if (existing) return existing;

    const apiKey = `cpx_${randomBytes(32).toString('base64url')}`;
    await addProxyApiKey(cfg, apiKey);
    try {
      const [connection] = await tx
        .insert(providerConnections)
        .values({
          userId,
          displayName: MANAGED_CONNECTION_NAME,
          baseUrl: normalizedBaseUrl(cfg.baseUrl),
        })
        .returning();
      const encrypted = encryptCredential(apiKey, app.config.CREDENTIAL_ENCRYPTION_KEY);
      await tx.insert(connectionTokens).values({
        userId,
        connectionId: connection!.id,
        name: MANAGED_TOKEN_NAME,
        keyPreview: maskApiKey(apiKey),
        systemManaged: true,
        ...encrypted,
      });
      return connection!;
    } catch (error) {
      // The API key was written remotely before the local transaction could fail.
      // Remove it best-effort so it cannot become an orphaned inference credential.
      await removeProxyApiKey(cfg, apiKey);
      throw error;
    }
  });
}

// Codex/Claude/Gemini OAuth account management for a private CLIProxyAPI instance
// (see internal/api/handlers/management/auth_files.go). Every account we register gets
// a unique `prefix` — CLIProxyAPI hard-filters credential selection by prefix, so
// `<prefix>/<model>` can only ever resolve to the account it was assigned to.
export async function cliproxyRoutes(app: FastifyInstance) {
  function requireConfig(reply: FastifyReply) {
    const baseUrl = app.config.CLIPROXY_BASE_URL;
    const managementKey = app.config.CLIPROXY_MANAGEMENT_KEY;
    if (!baseUrl || !managementKey) {
      reply.code(503).send({ error: 'CLIProxyAPI integration is not configured' });
      return undefined;
    }
    return { baseUrl, managementKey };
  }

  app.get('/api/cliproxy/accounts', async (req) => {
    return app.db
      .select({
        id: cliproxyAccounts.id,
        provider: cliproxyAccounts.provider,
        prefix: cliproxyAccounts.prefix,
        label: cliproxyAccounts.label,
        createdAt: cliproxyAccounts.createdAt,
      })
      .from(cliproxyAccounts)
      .where(eq(cliproxyAccounts.userId, req.dashboardUser!.id))
      .orderBy(desc(cliproxyAccounts.createdAt));
  });

  app.post('/api/cliproxy/accounts', async (req, reply) => {
    const cfg = requireConfig(reply);
    if (!cfg) return;

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'No file uploaded' });
    if (!file.filename.toLowerCase().endsWith('.json'))
      return reply.code(400).send({ error: 'File must be .json' });

    const buffer = await file.toBuffer();
    let parsed: Json;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'File is not valid JSON' });
    }

    const provider = typeof parsed.type === 'string' ? parsed.type : undefined;
    if (!provider || !KNOWN_PROVIDERS.has(provider))
      return reply.code(400).send({
        error: `Could not detect a supported provider from the file's "type" field (got: ${provider ?? 'missing'})`,
      });

    const label = typeof parsed.email === 'string' ? parsed.email : undefined;

    // Re-uploading the same provider+email (e.g. re-authing after token expiry) replaces
    // the existing credential in place — same prefix, same file name — so any bindings
    // already pointing at `<prefix>/<model>` keep working with the refreshed token instead
    // of silently going stale while a new, unbound duplicate account is created.
    const existing = label
      ? await app.db
          .select()
          .from(cliproxyAccounts)
          .where(
            and(
              eq(cliproxyAccounts.userId, req.dashboardUser!.id),
              eq(cliproxyAccounts.provider, provider),
              eq(cliproxyAccounts.label, label),
            ),
          )
          .limit(1)
      : [];
    const isReplace = existing.length > 0;
    const prefix = isReplace
      ? existing[0]!.prefix
      : `${provider}-${randomBytes(6).toString('hex')}`;
    const fileName = isReplace ? existing[0]!.fileName : `${prefix}.json`;

    const uploadForm = new FormData();
    uploadForm.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: 'application/json' }),
      fileName,
    );
    const uploadRes = await fetch(`${cfg.baseUrl}/v0/management/auth-files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.managementKey}` },
      body: uploadForm,
    });
    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => '');
      return reply
        .code(502)
        .send({ error: `CLIProxyAPI upload failed: ${text || uploadRes.statusText}` });
    }

    const patchRes = await fetch(`${cfg.baseUrl}/v0/management/auth-files/fields`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${cfg.managementKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: fileName, prefix }),
    });
    if (!patchRes.ok) {
      // Upload succeeded but binding the prefix failed — remove the now-unaddressable
      // orphan file rather than leaving it stranded on the CLIProxyAPI instance.
      await fetch(`${cfg.baseUrl}/v0/management/auth-files?name=${encodeURIComponent(fileName)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${cfg.managementKey}` },
      }).catch(() => {});
      const text = await patchRes.text().catch(() => '');
      return reply
        .code(502)
        .send({ error: `CLIProxyAPI prefix assignment failed: ${text || patchRes.statusText}` });
    }

    try {
      // The first successful auth upload provisions one private inference credential for
      // this user. It is random, registered with CLIProxyAPI through the management API,
      // encrypted in the database, and never returned to dashboard clients.
      await ensureManagedConnection(app, req.dashboardUser!.id, cfg);
    } catch (error) {
      // Do not leave a remote auth file behind when its local account cannot be provisioned.
      await fetch(`${cfg.baseUrl}/v0/management/auth-files?name=${encodeURIComponent(fileName)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${cfg.managementKey}` },
      }).catch(() => {});
      throw error;
    }

    if (isReplace) {
      // Nothing about the DB row changes (same prefix/fileName/label) — the credential
      // itself was already replaced on CLIProxyAPI above via the upload+patch calls.
      return reply.code(200).send(existing[0]);
    }
    try {
      const [account] = await app.db
        .insert(cliproxyAccounts)
        .values({ userId: req.dashboardUser!.id, provider, prefix, fileName, label })
        .returning();
      return reply.code(201).send(account);
    } catch (error) {
      if (isUniqueViolation(error))
        return reply.code(409).send({ error: 'Prefix collision — please retry the upload.' });
      throw error;
    }
  });

  app.delete('/api/cliproxy/accounts/:id', async (req, reply) => {
    const cfg = requireConfig(reply);
    if (!cfg) return;

    const id = (req.params as { id: string }).id;
    const [account] = await app.db
      .select()
      .from(cliproxyAccounts)
      .where(and(eq(cliproxyAccounts.id, id), eq(cliproxyAccounts.userId, req.dashboardUser!.id)))
      .limit(1);
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const deleteRes = await fetch(
      `${cfg.baseUrl}/v0/management/auth-files?name=${encodeURIComponent(account.fileName)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${cfg.managementKey}` } },
    );
    if (!deleteRes.ok && deleteRes.status !== 404) {
      const text = await deleteRes.text().catch(() => '');
      return reply
        .code(502)
        .send({ error: `CLIProxyAPI delete failed: ${text || deleteRes.statusText}` });
    }

    // Delete model instances for only the exact account's bindings. The account FK then
    // cascades its bindings and mapping routes without affecting another Codex account.
    const affectedBindings = await app.db
      .select({ id: modelBindings.id })
      .from(modelBindings)
      .where(eq(modelBindings.cliproxyAccountId, account.id));
    if (affectedBindings.length) {
      await app.db.delete(upstreamModels).where(
        inArray(
          upstreamModels.bindingId,
          affectedBindings.map((binding) => binding.id),
        ),
      );
    }

    await app.db.delete(cliproxyAccounts).where(eq(cliproxyAccounts.id, id));
    return { ok: true };
  });
}
