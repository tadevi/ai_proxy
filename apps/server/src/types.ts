import type { Database } from '@gateway/db';
import type { Config } from './config.js';
declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    config: Config;
  }
  interface FastifyRequest {
    dashboardUser?: { id: string; username: string };
    gatewayUserId?: string;
  }
}
