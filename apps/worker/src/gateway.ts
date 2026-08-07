import { createHash, randomUUID } from 'node:crypto';
import { createDbClient } from '../../../packages/db/src/index.js';
import {
  handleMessagesRequest,
  type GatewayMessageEnv,
} from './gateway-messages.js';

const activityWriteInterval = '5 minutes';

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });

const authError = (message: string) =>
  json(
    {
      type: 'error',
      error: { type: 'authentication_error', message },
    },
    401,
  );

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

function gatewayToken(request: Request) {
  const authorization = request.headers.get('authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const xKey = request.headers.get('x-api-key') ?? undefined;
  if (bearer && xKey && bearer !== xKey) return { error: authError('Conflicting gateway credentials') };
  const token = bearer ?? xKey;
  if (!token?.startsWith('gw_')) return { error: authError('Valid gateway API key required') };
  return { token };
}

export async function handleGatewayRequest(
  request: Request,
  env: GatewayMessageEnv,
): Promise<Response | undefined> {
  const messageResponse = await handleMessagesRequest(request, env);
  if (messageResponse) return messageResponse;

  const url = new URL(request.url);
  if (url.pathname !== '/v1/models') return undefined;
  if (request.method !== 'GET') {
    return json({ type: 'error', error: { type: 'invalid_request_error', message: 'Method not allowed' } }, 405, {
      allow: 'GET',
    });
  }

  const credential = gatewayToken(request);
  if ('error' in credential) return credential.error;

  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) {
    return json({ type: 'error', error: { type: 'api_error', message: 'Database is not configured' } }, 503);
  }

  const client = createDbClient(connectionString);
  const requestId = request.headers.get('cf-ray') ?? randomUUID();
  try {
    await client.connect();
    const auth = await client.query<{
      id: string;
      user_id: string;
      last_used_at: Date | null;
    }>(
      `SELECT id, user_id, last_used_at
         FROM gateway_keys
        WHERE key_hash = $1
          AND revoked_at IS NULL
        LIMIT 1`,
      [hashSecret(credential.token)],
    );
    const key = auth.rows[0];
    if (!key) return authError('Invalid or revoked gateway API key');

    await client.query(
      `UPDATE gateway_keys
          SET last_used_at = NOW()
        WHERE id = $1
          AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '${activityWriteInterval}')`,
      [key.id],
    );

    const models = await client.query<{
      id: string;
      created_at: Date;
    }>(
      `SELECT mb.upstream_model_id AS id, MIN(mb.created_at) AS created_at
         FROM model_bindings mb
         JOIN binding_routes br ON br.binding_id = mb.id
         JOIN provider_connections pc ON pc.id = mb.connection_id
        WHERE mb.user_id = $1
          AND br.enabled = TRUE
          AND pc.enabled = TRUE
        GROUP BY mb.upstream_model_id
        ORDER BY mb.upstream_model_id`,
      [key.user_id],
    );

    return json(
      {
        object: 'list',
        data: models.rows.map((model) => ({
          id: model.id,
          type: 'model',
          display_name: model.id,
          created_at: Math.floor(new Date(model.created_at).getTime() / 1000),
        })),
      },
      200,
      { 'x-request-id': requestId },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
