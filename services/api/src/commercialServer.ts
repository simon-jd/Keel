/** Separate bounded commercial executable; the local benchmark executable stays local. */
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createRouter } from 'models/router';
import { bindingHash, createAzureCommercialRoute, readPrivateCredential } from 'models/azureCommercial';
import type { CommercialConfig } from 'models/azureCommercial';
import { configureTracing } from 'tracing/exporter';
import { createAgentApp } from './routes/agent.js';
import { createSpanSpool } from './spool.js';

async function main(): Promise<void> {
  const configPath = process.env.KEEL_COMMERCIAL_CONFIG;
  if (!configPath) throw new Error();
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as CommercialConfig & { tokenFile: string; spanFile: string };
  const token = readPrivateCredential(config.tokenFile);
  const route = await createAzureCommercialRoute(config);
  const tracing = configureTracing({ exporter: createSpanSpool(config.spanFile, 1_000_000) });
  const model = createRouter({ local: route });
  const app = createAgentApp({ model, token, benchmarkUnknownTools: true, maxRequests: 10, benchmarkIdentity: { bindingHash: bindingHash(config.binding), reservationId: config.reservationId } });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 18081 });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; server.close(); await tracing.shutdown(); };
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
}
void main().catch(() => { process.stderr.write('COMMERCIAL_SERVER_DENIED\n'); process.exitCode = 1; });
