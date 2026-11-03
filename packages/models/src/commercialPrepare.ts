/** Offline trusted operator CLI: hash exactly the final Azure provider bodies. No network. */
import { readFileSync } from 'node:fs';
import { requestHash } from './azureCommercial.js';
import type { ChatRequest } from './types.js';
try {
  const input = JSON.parse(readFileSync(0, 'utf8')) as { deployment: string; requests: ChatRequest[] };
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.deployment) || !Array.isArray(input.requests) || input.requests.length !== 10) throw new Error();
  process.stdout.write(JSON.stringify(input.requests.map(req => requestHash(req, input.deployment))));
} catch { process.stderr.write('COMMERCIAL_PREPARE_DENIED\n'); process.exitCode = 1; }
