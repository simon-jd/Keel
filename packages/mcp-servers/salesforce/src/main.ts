import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { OAuthService, PostgresTokenStore, salesforce } from 'oauth';
import { startServer } from 'mcp-common/server';
import { loadDeployment, readSecretFile, installShutdown } from 'mcp-common/config';
import type { ConsentHandler } from 'mcp-common/provider-auth';
import { salesforceTools, salesforceTenantSchema } from './index.js';
const schema = z.object({
    clientId: z.string().min(1), redirectUri: z.string().url(), clientSecretFile: z.string().optional(), loginOrigin: z.string().url(), apiVersion: z.string().regex(/^v[0-9]{2,3}\.0$/).optional(), tenants: z.record(z.string().min(1), salesforceTenantSchema)
}).strict();
export async function launchSalesforce(path: string, host: {
    onConsentRequired?: ConsentHandler;
} = {}) {
    const deployment = await loadDeployment(path, 9104);
    try {
        const config = schema.parse(deployment.provider);
        const service = new OAuthService(new PostgresTokenStore(deployment.pool, deployment.cipher, {
            timeoutMs: 15000
        }), [salesforce({
                clientId: config.clientId, redirectUri: config.redirectUri, loginOrigin: config.loginOrigin, ...(config.clientSecretFile ? {
                    clientSecret: (await readSecretFile(config.clientSecretFile)).toString()
                } : {})
            })]);
        const server = await startServer({
            ...deployment.base, name: 'salesforce', tools: salesforceTools(service, {
                tenants: config.tenants, ...(config.apiVersion ? {
                    apiVersion: config.apiVersion
                } : {}), ...host
            })
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
        const service = await launchSalesforce(path);
        installShutdown(() => service.close());
        console.log(`Salesforce MCP listening at ${service.url}`);
    }
    catch {
        console.error('MCP_START_FAILED');
        process.exitCode = 1;
    }
}
