import { createHash, randomBytes } from 'node:crypto';
import bcrypt from '../../server/node_modules/bcryptjs/index.js';
import { credentialsSchema } from '../../../packages/shared/src/index.js';
import { createDbClient } from '../../../packages/db/src/index.js';
import type { WorkerDbEnv } from './db.js';

const sessionCookie = 'gateway_session';
const sessionMaxAgeSeconds = 30 * 86400;
const activityWriteInterval = '5 minutes';

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');
const randomToken = (prefix: string) => prefix + randomBytes(32).toString('base64url');

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get('cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

const sessionSetCookie = (token: string) =>
  `${sessionCookie}=${encodeURIComponent(token)}; Path=/; Max-Age=${sessionMaxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;

const clearSessionCookie = () =>
  `${sessionCookie}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function validationError() {
  return json({ error: 'Invalid username or password format' }, 400);
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

async function createSession(env: WorkerDbEnv, userId: string) {
  const token = randomToken('sess_');
  await withClient(env, async (client) => {
    await client.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [userId, hashSecret(token)],
    );
  });
  return token;
}

async function currentUser(request: Request, env: WorkerDbEnv) {
  const token = cookieValue(request, sessionCookie);
  if (!token) return undefined;
  return withClient(env, async (client) => {
    const result = await client.query<{
      id: string;
      username: string;
      session_id: string;
      last_used_at: Date;
    }>(
      `SELECT u.id, u.username, s.id AS session_id, s.last_used_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.expires_at > NOW()
        LIMIT 1`,
      [hashSecret(token)],
    );
    const user = result.rows[0];
    if (!user) return undefined;
    await client.query(
      `UPDATE sessions
          SET last_used_at = NOW()
        WHERE id = $1
          AND last_used_at < NOW() - INTERVAL '${activityWriteInterval}'`,
      [user.session_id],
    );
    return { id: user.id, username: user.username };
  });
}

export async function handleDashboardAuthRequest(
  request: Request,
  env: WorkerDbEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url);

  if (url.pathname === '/api/auth/login') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { allow: 'POST' });
    const parsed = credentialsSchema.safeParse(await readJson(request));
    if (!parsed.success) return validationError();

    const user = await withClient(env, async (client) => {
      const result = await client.query<{ id: string; username: string; password_hash: string }>(
        `SELECT id, username, password_hash FROM users WHERE username = $1 LIMIT 1`,
        [parsed.data.username],
      );
      return result.rows[0];
    });

    if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
      return json({ error: 'Invalid username or password' }, 401);
    }

    const token = await createSession(env, user.id);
    return json(
      { id: user.id, username: user.username },
      200,
      { 'set-cookie': sessionSetCookie(token) },
    );
  }

  if (url.pathname === '/api/me') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { allow: 'GET' });
    const user = await currentUser(request, env);
    return user ? json(user) : json({ error: 'Authentication required' }, 401);
  }

  if (url.pathname === '/api/auth/logout') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { allow: 'POST' });
    const token = cookieValue(request, sessionCookie);
    if (token) {
      await withClient(env, async (client) => {
        await client.query('DELETE FROM sessions WHERE token_hash = $1', [hashSecret(token)]);
      });
    }
    return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
  }

  return undefined;
}
