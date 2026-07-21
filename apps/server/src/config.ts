import { z } from 'zod';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL_CA_PATH: z.string().min(1).optional(),
  DATABASE_SSL_CERT_PATH: z.string().min(1).optional(),
  DATABASE_SSL_KEY_PATH: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(32),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(32),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ALLOW_PRIVATE_UPSTREAMS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(60000),
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(7),
});
export type Config = z.infer<typeof schema>;
let loadedEnvDirectory: string | undefined;

export function loadEnvironmentFile(startDirectory = process.cwd()) {
  let directory = resolve(startDirectory);
  let workspaceDirectory: string | undefined;
  while (true) {
    const candidate = resolve(directory, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      loadedEnvDirectory = directory;
      return candidate;
    }
    if (existsSync(resolve(directory, 'pnpm-workspace.yaml'))) workspaceDirectory = directory;
    const parent = dirname(directory);
    if (parent === directory) {
      loadedEnvDirectory = workspaceDirectory ?? resolve(startDirectory);
      return undefined;
    }
    directory = parent;
  }
}

export function readConfig(env = process.env): Config {
  const config = schema.parse(env);
  const baseDirectory = loadedEnvDirectory ?? process.cwd();
  const resolveFile = (value: string | undefined) =>
    value && !isAbsolute(value) ? resolve(baseDirectory, value) : value;
  return {
    ...config,
    DATABASE_SSL_CA_PATH: resolveFile(config.DATABASE_SSL_CA_PATH),
    DATABASE_SSL_CERT_PATH: resolveFile(config.DATABASE_SSL_CERT_PATH),
    DATABASE_SSL_KEY_PATH: resolveFile(config.DATABASE_SSL_KEY_PATH),
  };
}
