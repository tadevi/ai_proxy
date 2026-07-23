import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { cliproxyAccounts } from '@gateway/db';
import { isUniqueViolation } from '../security.js';

// CLIProxyAPI's own provider names in the auth file's "type" field — Gemini auth files
// use "antigravity" (its internal name for Gemini/Antigravity), not "gemini".
const KNOWN_PROVIDERS = new Set(['codex', 'claude', 'antigravity']);

type Json = Record<string, unknown>;

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
    const prefix = isReplace ? existing[0]!.prefix : `${provider}-${randomBytes(6).toString('hex')}`;
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

    await app.db.delete(cliproxyAccounts).where(eq(cliproxyAccounts.id, id));
    return { ok: true };
  });
}
