# Task 5 — OAuth persistence and protocol evidence

Date: 2026-10-23. Base: `a51a01c`. Real SaaS round trips remain **unverified**: no accounts, Apps, cloud resources, model APIs or real user data were used.

## Public integration ports

`oauth` exports `OAuthService`, `PostgresTokenStore`, `TokenCipher`, four provider factories, `OAuthError`, and public types. Construct a caller-owned `pg.Pool`, load `TokenCipher.fromKeyFile(path)`, construct the store, then `new OAuthService(store, providers, options)`.

```ts
start(provider, tenantId, scopes): Promise<{ authUrl: string; state: string }>
callback(code, state): Promise<TokenSet>
getAccessToken(tenantId, provider): Promise<string>
revoke(tenantId, provider): Promise<void>
getAuthorizationSnapshot(tenantId, provider, rejectedAccessToken?): Promise<AuthorizationSnapshot>
refreshAfterUnauthorized(tenantId, provider, rejectedAccessToken): Promise<string>
```

`Provider` is `slack | github | google | salesforce`. `TokenSet` contains accessToken, nullable refreshToken, nullable expiresAt, scopes, and identity. The authorization snapshot omits refreshToken and reads/refreshes the access token plus its corresponding scopes/identity under the same database lock. MCP consumers must authorize from this snapshot, not from requested scopes or a separate database read. GitHub App user scope arrays deliberately do not represent App installation permissions.

On a resource 401, pass the actual rejected access token to `getAuthorizationSnapshot` (or `refreshAfterUnauthorized`) and retry the resource operation **at most once**. Ten concurrent stale 401s share the updated token. OAuth does not retry token exchanges automatically. Resource-operation retries and guard enforcement belong to the consuming MCP/API task.

`ClientConfig` accepts clientId, optional clientSecret, redirectUri, optional endpoints `{authorize, token, revoke}`, and timeoutMs (1–10,000 ms, default 10,000). Credentials and endpoint overrides are trusted deployment configuration, never request input. Remote endpoints/redirects require HTTPS; loopback HTTP is allowed. Custom URI redirect schemes are not supported by this package. The calling API must authenticate/authorize tenantId and associate the browser's state with its own session before invoking these ports.

## Persistence and concurrency

- New `0002_oauth.up.sql` / `.down.sql`; `0001` untouched. Tables: `token_store` and `oauth_states`. Tokens are unique by tenant/provider. Identity and client/endpoint/redirect configuration binding prevent accidental use with another registration. States bind tenant/provider/scopes/redirect/client settings inside encrypted payloads.
- AES-256-GCM, independently random 12-byte nonce per encrypted field; AAD binds tenant/provider/field/identity, and state AAD additionally includes the state hash. Key file must be a regular, non-symlink, owner-owned 32-byte file with exact `0600` permissions. The raw key is kept in a private JS field. Tests create/delete keys only under `/tmp`.
- States contain 256-bit random entropy; only their SHA-256 hash is indexed. Verifiers are encrypted and absent from start's return value. Default state TTL is ten minutes, configurable only downward. State is durably deleted before token exchange; expiration, mismatch, replay and configuration changes fail before HTTP. Failed exchanges do not restore state.
- PostgreSQL session advisory locks coordinate all callback, refresh and revoke work across separate stores and connection pools. A single SQL upsert commits rotated access/refresh together. Session locks deliberately permit committed state consumption and committed local revocation before HTTP. Use a direct PostgreSQL connection or session pooling, **not transaction-mode PgBouncer**. Pool lifecycle belongs to the caller; `connectionTimeoutMillis` must be an integer in 1–15,000 ms (the store rejects unset/unbounded values).
- Access tokens refresh when remaining lifetime is strictly `< 60,000 ms`. Null expiry is preserved. Invalid grants and invalid rotation responses persist reconsent; no old access token is subsequently returned. Explicitly reduced scopes replace old scopes. Missing scope follows the OAuth requested-scope/current-grant fallback, without unioning unrelated prior consent. New consent never inherits an old account's refresh token.
- Revocation first cancels pending states and persists local denial. Upstream failure returns `REVOKE_FAILED` while denial remains; encrypted credentials are retained only for a later revoke retry. Success clears ciphertext. In-flight callback/revoke races are serialized.
- HTTP requests disallow redirects, time out across response reading, and bound response bodies to 64 KiB. All database acquisition/query/setup/unlock/reset paths have client deadlines capped at 15 seconds; queries also use PostgreSQL statement_timeout. Timed-out transports are destroyed and removed from the pool. Late acquisitions are destroyed without issuing SQL. Logger receives only operation/outcome/safe code; exceptions have no provider body, cause, token, tenant, client secret or key. This package emits no OAuth spans or HTTP body logs.

## Provider-specific contracts and official sources

**Slack**: default `tokenKind: 'user'` requests `user_scope` and parses the entire `authed_user` credential group. `tokenKind: 'bot'` uses `scope` and the top-level group; identity mismatches fail closed. Refresh replies use the top-level group and validate user/bot token_type. PKCE must be enabled in the App; exchange omits client_secret. Loopback redirects are treated conservatively as desktop, disallow bot mode, and omit refresh secrets. Bot mode requires a web redirect. Rotating responses must supply a new refresh token. `auth.revoke` receives the access token. For rotating Slack installs it revokes that token, **not the entire installation**: remaining upstream tokens/events/installation are outside this operation; local access and stored refresh are disabled. Full uninstall requires a separate explicitly authorized operation. [PKCE](https://docs.slack.dev/authentication/using-pkce/), [OAuth response shapes](https://docs.slack.dev/reference/methods/oauth.v2.access/), [rotation and revoke semantics](https://docs.slack.dev/authentication/using-token-rotation/), [auth.revoke](https://docs.slack.dev/reference/methods/auth.revoke/).

**GitHub**: factory represents only `github-app-user`; clientSecret is required. Accepts either an empty requested-scope list or `offline_access`; no repository/install permissions are inferred. Optional no-expiry/no-refresh tokens are preserved. Rotation requires new refresh credentials. Revoke is authenticated `DELETE /applications/{client_id}/grant` with JSON access_token, HTTP Basic App credentials and API version 2026-03-10. Installation JWT/token identity remains Task 6. [PKCE announcement](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/), [App user refresh](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens), [OAuth grant revocation](https://docs.github.com/en/rest/apps/oauth-applications).

**Google**: default `clientType: 'web'` requires a secret, requests offline access and include_granted_scopes. `clientType: 'desktop'` retains PKCE but does not request incremental authorization, which Google does not support for installed clients. Both honor actually granted response scopes. Web PKCE is also shown in Google's official `keys.web` sample. Refresh may omit a replacement refresh token; only that same grant retains the old value. A new callback lacking refresh does not borrow one from previous consent. Such a connection may require revoking/re-consenting to regain offline access. Revoke submits refresh token when present, otherwise access token. [Web/incremental/refresh/revoke](https://developers.google.com/identity/protocols/oauth2/web-server), [desktop constraints](https://developers.google.com/identity/protocols/oauth2/native-app), [official web PKCE sample](https://github.com/googleapis/google-auth-library-nodejs/blob/main/samples/oauth2-codeVerifier.js).

**Salesforce**: explicit `loginOrigin` accepts login.salesforce.com, test.salesforce.com or a `*.my.salesforce.com` origin, including Developer/MyDomain environments. Authorize/token/revoke paths are `/services/oauth2/{authorize,token,revoke}`. The package does not guess a session expiry from issued_at, and ignores PII identity URLs and signature fields. Session 401 recovery uses the rejected-token port above. Missing refresh/scope in a refresh response preserves the same grant's values; rotated refresh is persisted when supplied. Revoke prefers refresh to invalidate associated access tokens. [PKCE/web flow](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm&language=en_US&type=5), [refresh and rotation](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_refresh_token_flow.htm&language=en_US&type=5), [revocation](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_revoke_token.htm&language=en_US&type=5).

## Dependencies and verification

No new dependency versions or transitive packages were introduced. OAuth reuses exact locked `pg 8.23.1`, `@types/pg 8.23.1` and test-only `@testcontainers/postgresql 10.28.0`; root TypeScript 5.9.3 / Vitest 3.2.6 / Node types 20.19.43 remain unchanged. Actual runtime: Node 20.19.5, pnpm 10.34.8. Official npm registry manifests were fetched on 2026-10-23: pg requires Node >=16, and the two other packages declare no engines constraint. [pg source](https://github.com/brianc/node-postgres), [testcontainers source](https://github.com/testcontainers/testcontainers-node), [Node 20 crypto](https://nodejs.org/docs/latest-v20.x/api/crypto.html), [PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).

Recorded TDD phases:

| Phase | Command (pnpm on project-local PATH) | Observed result |
|---|---|---|
| Crypto RED | `pnpm --filter oauth test -- test/crypto.test.ts` | 3 failures: empty S256 result, cipher/keyfile NOT_IMPLEMENTED |
| Crypto GREEN | `pnpm --filter oauth test` | 3 passed |
| Migration RED | `pnpm --filter db test` | Expected oauth_states/token_store absent; remaining two tests cascaded from unrolled first test |
| Flow RED | `pnpm --filter oauth test` | 12 failed / 3 passed; missing durable flow behavior |
| Providers RED | `pnpm --filter oauth test` | 18 failed / 3 passed; provider protocols absent |
| First GREEN | `pnpm --filter oauth test` | 21 passed |
| Self-review RED | `pnpm --filter oauth exec vitest run test/providers.test.ts` | 4 failed: Slack revoke token, two rotation omissions, changed-client token use |
| Self-review GREEN | `pnpm --filter oauth test` | 31 passed |
| Snapshot RED | `pnpm --filter oauth exec vitest run test/flow.test.ts -t 'authorization snapshot'` | Assertion expected limited token/read scope; placeholder returned empty token/scopes |
| Snapshot GREEN | `pnpm --filter oauth test` | 32 passed |
| Protocol RED | `pnpm --filter oauth exec vitest run test/providers.test.ts` | 3 failed: Slack secret/desktop mode and Google desktop incremental flag |
| Protocol GREEN | `pnpm --filter oauth test` | 34 passed |

Initial implementation checks, 2026-10-23 21:09 PDT (2026-10-24 04:09 UTC):

```text
pnpm install --frozen-lockfile --ignore-scripts
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 456ms using pnpm v10.34.8

pnpm --filter oauth --filter db test
packages/db test: Tests 3 passed (3)
packages/oauth test: Tests 34 passed (34)

pnpm typecheck
packages/db typecheck: Done
packages/oauth typecheck: Done
packages/tracing typecheck: Done
packages/models typecheck: Done
packages/runtime typecheck: Done

git diff --check
[exit 0, no output]
```

Tests use real PostgreSQL 17/pgvector containers and a real loopback HTTP server; no JS Map token store or mocked pg/fetch boundary. Two independent Pool/store/service instances prove refresh single-flight and stale-401 coalescing. Required named tests are present, along with provider-specific and adversarial cases. Migration tests explicitly expect `actions, oauth_states, runs, steps, token_store`, apply every up migration, reverse every down migration and assert no public relations/types/functions remain. Postgres containers carry project=keel and purpose labels, 512 MiB / 1 CPU limits, and stop after testing; final project test-container listing was empty. Working tree was ~928 MiB and existing images/dependencies were reused.

## Remaining boundaries

- SaaS end-to-end consent/refresh/revoke, real account/App settings, deployed PostgreSQL crash/network-partition failover and KMS integration are not verified. Local TCP reply loss against real PostgreSQL is tested in the review fixes below. Tests cover two independent in-process pools, not independently deployed hosts.
- Rotation crosses a remote service and PostgreSQL, so a process crash after remote rotation but before local upsert cannot be made atomic. There is no blind retry loop; the next invalid grant requires reconsent. A timeout releases the lock, but remote completion can remain ambiguous.
- A snapshot already returned to a caller cannot be retroactively recalled by local revoke. Provider-side invalidation and the consumer's bounded request handling remain necessary.
- Operators should remove expired unconsumed state rows periodically using the expiry index, keep the key file backed up securely, and use session-capable PostgreSQL pooling. Key rotation and background cleanup scheduling are outside Task 5.

## Review 1 fixes (base `9a4be65`)

The initial implementation results above remain historical. This review adds six database deadline tests and three GitHub revoke tests, for **43 OAuth tests**. No migration or dependency changes were needed.

**Database assembly and deadlines.** All SQL now passes through `DatabaseSession`, including peekState, statement-timeout setup, ordinary read/write, lock acquisition, unlock, and reset. Local deadline or query failure destroys the underlying socket before removing the client from the pool; a busy client is never returned for reuse. A late pool acquisition is destroyed without executing the abandoned request's SQL. The caller's native Pool connection timeout also bounds pending handshakes/queue entries that cannot be directly cancelled through pg's public acquire API. Cleanup timeout returns a safe STORE_ERROR; a preceding database mutation may already have committed, so it must not be blindly repeated.

```ts
import { Pool } from 'pg';
import { PostgresTokenStore, TokenCipher } from 'oauth';

// databaseUrl and keyPath come from trusted deployment configuration.
const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3_000 });
const cipher = await TokenCipher.fromKeyFile(keyPath);
const store = new PostgresTokenStore(pool, cipher, { timeoutMs: 15_000 });
// Use the store to construct OAuthService; the application owns pool.end() at shutdown.
```

Store timeoutMs defaults to 15,000 and accepts only integer values 1–15,000; it can be shortened for deployments/tests but not enlarged. It applies per acquisition/query stage, not as one aggregate OAuth request budget. Pool connectionTimeoutMillis independently must be an integer in 1–15,000. A shortened store acquire timeout may return before pg finishes its bounded pending acquisition; any late client is discarded, not used.

**GitHub revocation.** For an expired or less-than-60-seconds remaining GitHub access token, revoke first durably denies local access, then performs at most one refresh under the existing lock. The access/refresh rotation is atomically stored with status **revoked**, never active, before grant deletion. If deletion fails, the rotated credentials remain available only for retrying revoke, including after another expiry. Missing refresh credentials cause REVOKE_FAILED instead of a false success. Actual HTTP fixtures enforce valid access-token deletion; a PostgreSQL audit trigger checks every intermediate status write and direct database reads check denial at each HTTP stage. This is an implementation inference from the linked GitHub valid-access-token contract, not a real-account verification.

**Minor corrections.** The GitHub scope wording now explicitly accepts an empty scope list or offline_access. The revoke fixtures assert the offline_access authorization parameter and empty permission scopes. The initial 21:09 timestamp is corrected to PDT / next-day 04:09 UTC; historical raw logs were not rewritten.

**TDD evidence qualification.** The first ACCESS EXCLUSIVE table-lock and saturated-pool RED cases were valid. The first TCP proxy captured a subsequently mutated destination URL and recursively connected to itself; its three timeout results and the following failed warm-up attempt are discarded as evidence. The proxy was corrected to capture immutable upstream host/port, finish a real PostgreSQL handshake, and then suppress replies only after seeing the selected SQL. Tests first assert that this SQL-stage fault occurred. The exact `9a4be65` store was temporarily restored from `git show`, tested, and the current store restored in a Python `finally` block. That clean baseline run failed six assertions: table lookup/queue missed deadlines, SET/SELECT waited for the 1,200 ms test failsafe, and old unlock/reset cleanup incorrectly resolved. Current implementation then passed all six. This is separate from the invalid proxy timing results.

```text
# Corrected proxy, exact 9a4be65 store, 21:24:53 PDT:
pnpm --filter oauth exec vitest run test/db-timeouts.test.ts
Tests 6 failed (6)
  callback state lookup: deadline-missed
  late acquired connections: deadline-missed
  lost SET reply: 1201.10 ms, expected < 800
  lost SELECT reply: 1201.95 ms, expected < 800
  lost unlock/reset reply: resolved, expected STORE_ERROR

# Current store restored, 21:25:23 PDT:
pnpm --filter oauth exec vitest run test/db-timeouts.test.ts
Tests 6 passed (6)

# Revoke implementation absent, then implemented:
pnpm --filter oauth exec vitest run test/revoke.test.ts
RED: Tests 3 failed (3)
  expired token: REVOKE_FAILED instead of successful valid-token deletion
  retry after expiry: 0 refreshes instead of 1
  no refresh: resolved instead of REVOKE_FAILED
GREEN: Tests 3 passed (3)
```

Final review-fix checks started 2026-10-23 21:25:59 PDT (2026-10-24 04:25:59 UTC):

```text
pnpm --filter oauth test
Test Files 5 passed (5)
Tests 43 passed (43)

pnpm typecheck
packages/db, oauth, tracing, models, runtime: Done

git diff --check
[exit 0, no output]
```

The six database regressions check a real blocked SELECT, absence of leftover PostgreSQL lock waiters, late-acquisition SQL suppression and pool removal, and lost replies during SET/SELECT/unlock/reset. Faulted clients close within the bounded query deadline, their pool reaches zero clients, and a separate physical pool can reacquire the same advisory lock. Local socket faults do not establish deployed failover behavior. No real SaaS/API/GPU/cloud actions were performed.
