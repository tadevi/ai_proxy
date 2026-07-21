import { buildApp } from './app.js';
import { loadEnvironmentFile, readConfig } from './config.js';

loadEnvironmentFile();

async function main() {
  const config = readConfig();
  const app = await buildApp(config);
  await app.listen({ host: '0.0.0.0', port: config.PORT });
}

void main();
