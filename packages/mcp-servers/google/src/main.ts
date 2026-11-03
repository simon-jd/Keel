import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { OAuthService, PostgresTokenStore, google } from 'oauth';
import { startServer } from 'mcp-common/server';
import { loadDeployment, readSecretFile, installShutdown } from 'mcp-common/config';
import type { ConsentHandler } from 'mcp-common/provider-auth';
import { googleTools } from './index.js';
const schema = z.object({
    clientId: z.string().min(1), redirectUri: z.string().url(), clientType: z.enum(['web', 'desktop']).default('web'), clientSecretFile: z.string().optional()
}).strict();
export async function launchGoogle(path: string, host: {
    onConsentRequired?: ConsentHandler;
} = {}) {
    const deployment = await loadDeployment(path, 9103);
    try {
        const config = schema.parse(deployment.provider);
        const service = new OAuthService(new PostgresTokenStore(deployment.pool, deployment.cipher, {
            timeoutMs: 15000
        }), [google({
                clientId: config.clientId, redirectUri: config.redirectUri, clientType: config.clientType, ...(config.clientSecretFile ? {
                    clientSecret: (await readSecretFile(config.clientSecretFile)).toString()
                } : {})
            })]);
        const server = await startServer({
            ...deployment.base, name: 'google', tools: googleTools(service, host)
        });
        return {
            ...server, async close() {
                await server.close();
                await deployment.pool.end();
            }
        };
    }
    catch {
        await deployment.pool.end();
        throw Error('MCP_START_FAILED');
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const path = process.argv[2];
        if (!path)
            throw Error();
        const service = await launchGoogle(path);
        installShutdown(() => service.close());
        console.log(`Google MCP listening at ${service.url}`);
    }
    catch {
        console.error('MCP_START_FAILED');
        process.exitCode = 1;
    }
}
