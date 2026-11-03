# Slack and GitHub MCP integration evidence

2026-10-23 PDT. **Local protocol/fixture verification only. Real Slack developer workspace, GitHub test organization and external authorization-server acceptance are pending.** No real SaaS writes, messages, issues, account registration, cloud resources, model API calls or GPU work were performed.

## What was actually exercised

The tests run the official MCP SDK client across real loopback TCP/Streamable HTTP to the official SDK server, then across HTTP to explicitly authored, synthetic provider fixtures. They are **not recordings** and are not evidence of a deployed AS or real Slack/GitHub interoperability. Real PostgreSQL 17 stores OAuth credentials and independent MCP action reservations. Containers have `project=keel`, purpose labels, 512 MiB memory and 1 CPU limits, and are stopped after each suite.

Pinned dependencies: `@modelcontextprotocol/server 2.4.0`, `@modelcontextprotocol/client 2.4.0`, `@modelcontextprotocol/node 2.1.2`; runtime Node `20.19.5`. All three SDK packages declare Node >=20. Existing workspace `zod 4.1.12` is retained. The public SDK `fromJsonSchema(z.toJSONSchema(...))` bridge retains strict input validation; a localized type assertion handles the libraries' incompatible unused `$vocabulary` annotation types. No private SDK imports or disabled strict compiler flags are used.

Covered boundaries:

- SDK initialize/list/call, protected resource metadata and bearer challenges; signed external-AS JWT verification, exact audience, issuer, expiry/not-before, trusted subject-to-tenant mapping, provider-token rejection, MCP scope, Host/Origin and body limits.
- Slack Task 5 encrypted OAuth store and actual user-grant snapshots, `search:read`/`chat:write`, one stale-401 refresh and a scope check on the replacement token. Slack also recognizes `invalid_auth`, `token_expired` and `token_revoked` JSON errors. Missing scopes never reach the resource operation.
- GitHub App RSA JWT exchange for installation tokens, actual returned permissions and repository restrictions, tenant allowlists, default-branch failing check pagination (subsequent pages pinned to the first page's commit SHA), and one resource-401 re-exchange. No App user token fallback exists.
- Host guard plus exact human approval, signed short-lived capability carried in MCP `_meta`, tenant/run/tool/actionKey/argsHash binding, concurrent reservation, encrypted reconciliation data, lost-write-response recovery, and no duplicate provider write. Real `runAgent` → `Tool.run` → SDK HTTP → provider fixture → `Tool.lookup` recovery is exercised using a clearly scripted test model.
- Raw-byte Slack v0 HMAC with a bidirectional five-minute timestamp window, GitHub SHA-256 HMAC, signature-before-JSON parsing and duplicate webhook acknowledgements. Webhook routes acknowledge only; they do not dispatch tools or authorize effects.
- Bounded slow/oversized responses and no credential redirects. Transient GET 429/500/502/503/504 responses get at most one bounded backoff retry; writes and token exchanges have no generic retry. A resource 401 gets at most one credential refresh/re-exchange and resource retry.

## Operator entry points and prerequisites

The server binds **127.0.0.1 only**. Defaults: Slack `http://127.0.0.1:9101/mcp`, GitHub `http://127.0.0.1:9102/mcp`. Each exposes `/.well-known/oauth-protected-resource/mcp`, authenticated `POST /actions/lookup`, and signature-only `POST /webhook`. A reverse proxy may publish HTTPS with an explicitly configured `resource`; preserve the configured Host, and do not expose a raw listener. If Origin is present it must exactly equal the configured resource origin. There is no session identifier or cross-request SDK server instance.

Required operator-provided prerequisites:

1. A direct/session-pooled PostgreSQL database with migrations `0001`, `0002`, then new `0003_mcp_actions` applied once. Do not rerun already-applied migrations or use transaction-mode PgBouncer. Run migration files with `psql "$KEEL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/migrations/0003_mcp_actions.up.sql` on an existing Task 5 database. A fresh database needs all three `.up.sql` files in numeric order.
2. A 32-byte AES key file matching Task 5's store, and a separate random 32-byte HMAC approval key shared only with the trusted runtime host. Store configuration and key files as owner-owned regular files, mode `0600`, with no symlinks; never commit them. Public AS PEM and App private PEM are also loaded from owner-only files. Example for a new approval key: `umask 077; openssl rand 32 > /absolute/private/approval.key`.
3. A real external OAuth authorization server configured to issue **RS256 access tokens** with `iss`, exact `aud` (the MCP resource URL), `sub`, `client_id`, `scope: "mcp"`, and numeric `exp`; optional `nbf` is enforced. Its configured RSA public key must be >=2048 bits. Map permitted subjects to tenants in trusted deployment configuration. Metadata advertises the configured issuer; the AS must independently expose its own discovery/authorization/token endpoints. This project does not deploy an AS or obtain MCP tokens. Pin/rotate its key operationally and restart to load changes; local JWT verification cannot provide immediate remote revocation.
4. Slack: developer workspace/App, user PKCE consent through Task 5 using the same client/redirect configuration and AES key. Request `chat:write` and `search:read`, confirm actual consent, and save the callback via `OAuthService.callback`. The MCP process does not implement the consent browser/callback UI. `auth.test` establishes the actual writer user/team for reconciliation. Use only a developer channel.
5. GitHub: test-org App with Checks read and Issues write, installed on explicitly allowlisted repositories. Configure the numeric App ID, installation ID and RSA private PEM. Installation access tokens are exchanged on demand and held only in request-local memory; they are never persisted or logged. Actual returned repository/permission restrictions are checked again after replacement tokens.

Create two JSON config files outside git (all paths absolute). Common shape:

```json
{
  "port": 9101,
  "resource": "http://127.0.0.1:9101/mcp",
  "databaseUrl": "postgresql://OPERATOR_SUPPLIED",
  "encryptionKeyFile": "/absolute/private/oauth.key",
  "approvalKeyFile": "/absolute/private/approval.key",
  "auth": {
    "issuer": "https://YOUR_AUTHORIZATION_SERVER",
    "publicKeyFile": "/absolute/private/as-public.pem",
    "subjects": { "YOUR_RUNTIME_SUBJECT": "YOUR_TEST_TENANT" }
  },
  "provider": {
    "clientId": "YOUR_SLACK_APP_CLIENT_ID",
    "redirectUri": "YOUR_REGISTERED_REDIRECT_URI",
    "signingSecretFile": "/absolute/private/slack-signing-secret"
  }
}
```

For a web Slack registration requiring a client secret on refresh, also set `provider.clientSecretFile`; preserve Task 5's exact consent configuration. For GitHub use port/resource `9102` and replace `provider` with:

```json
{
  "appId": "YOUR_NUMERIC_APP_ID",
  "privateKeyFile": "/absolute/private/github-app.pem",
  "webhookSecretFile": "/absolute/private/github-webhook-secret",
  "tenants": {
    "YOUR_TEST_TENANT": {
      "installationId": 123456,
      "repositories": ["YOUR_TEST_ORG/YOUR_TEST_REPO"]
    }
  }
}
```

From the repository root, after providing those real prerequisites:

```bash
export PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH"
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter mcp-slack exec tsx src/main.ts /absolute/private/slack-mcp.json
# In a separate terminal:
pnpm --filter mcp-github exec tsx src/main.ts /absolute/private/github-mcp.json
```

Both startup entry points were exercised against local configuration/keys and real PostgreSQL. They fail closed on missing configuration. No real provider HTTP request is made merely by starting a server.

## Runtime host wiring and recovery

`mcp-common` exports `startServer`, `JwtVerifier`, `ApprovalAuthority`, `ActionJournal`, `createRuntimeTool`, `ToolSpec` and their types. Provider factories are `slackTools(oauthService, options?)` and `githubTools(config)`. The deployment entry points are `launchSlack(configPath)` and `launchGithub(configPath)` in each package's `main` export. Task 7 can reuse the common HTTP/auth/action code; Google and Salesforce tools were not implemented.

The trusted runtime host constructs `createRuntimeTool` with `tenantId`, `service`, a `{ name, schema, write }` descriptor, `url`, a server-only `token()` accessor for a real AS access token, an `ApprovalAuthority`, `approvals()` and an optional guard. The model sees only the original tool arguments. For example, Slack's write descriptor uses `name: 'post_message'`, `postMessageSchema` and `write: true`; runtime name is `slack.post_message`, while the MCP name remains `post_message`. Use the returned tool in `runAgent` dependencies. Supply the exact `RunResult.approval` only after an actual human review, both in the runtime approvals and the bridge's trusted approval source; configure the guard in both host paths. The fixture test's unconditional allow guard is not a deployed policy.

The authority always checks an exact approved tenant/run/tool/actionKey/argsHash binding, even when guard says allow. Missing guard defaults to needs-approval; missing approvals deny. It signs a 60-second resource-bound HMAC capability. Do not expose `issue`, approval arrays, secrets or the guard to a model, MCP tool, user-controlled configuration or an untrusted HTTP endpoint. Model fields such as `approved: true` cannot mint authorization.

`mcp_actions` is independent from runtime `actions`: dispatch reserves UNKNOWN durably before writing. A concurrent/replayed call cannot reserve again. Payload, writer evidence and results use Task 5's AES-GCM `TokenCipher` with tenant/action/hash AAD. The new journal uses the same bounded `oauth/session` acquisition/query/cleanup implementation; native Pool `connectionTimeoutMillis` must be 1–15,000 ms (deployment uses 3,000), and journal timeout must be <=15,000 ms (default 3,000). The OAuth store remains capped at 15,000 ms.

`Tool.lookup` calls the authenticated lookup endpoint. Only a successful database read proving **no reservation exists** returns absent. A reserved write whose provider lookup fails, finds nothing, encounters ambiguous matches, lacks writer proof or exceeds ten pages stays UNKNOWN. It never causes an automatic retry. An initial write denied before dispatch can therefore require operator investigation instead of automatic reuse of that key. Never delete a reservation to bypass uncertainty.

Correlation is visible by design: Slack appends `\n[keel-action:<hash>]`; GitHub appends `\n<!-- keel-action:<hash> -->`. Approval covers the original arguments and this documented fixed suffix. No tenant text is embedded in the hash. Slack searches the marker then verifies exact channel ID, complete expected text and the original `auth.test` writer user/team; it does not assume `in:channel-id` search syntax. GitHub lists the intended repository's issues and requires exact title/body, Bot identity and `performed_via_github_app.id` matching the original App identity saved in the encrypted action journal before dispatch. GitHub freezes the App ID, installation ID and trusted API base; execution and recovery require the current configuration to match that saved identity. Missing or incompatible evidence stays UNKNOWN, including legacy reservations without writer evidence. Changing deployment configuration cannot change the original attribution criterion. Both require one unambiguous match. Reconciliation is conservative under indexing lag, edits, deletions, oversized responses, permissions changes and pagination limits.

## Pending real sandbox acceptance

**Not performed.** Once the prerequisites are supplied, initialize an official SDK client using an AS-issued bearer token; list both tools and call `search_messages` on a fixture marker in the developer channel and `list_failing_checks` on the test repository. Verify that the returned user/account and repository belong to the intended sandbox. Run the trusted runtime workflow above, review its exact proposed channel/text or repository/title/body and fixed suffix, and approve one Slack message and one GitHub issue. Verify each result in the sandbox and record its non-sensitive ID/time here; repeat the same action key and confirm no extra object is created. Exercise scope reduction and signature rejection with developer-only fixtures/requests. Do not treat the synthetic JWT issuer or test keys as a real authorization service.

Current evidence proves local SDK/HTTP/store behavior and synthetic provider-contract assumptions. Real permission names/installation response details, real Slack search indexing/text fidelity, GitHub App attribution on created issues, external-AS discovery, webhook delivery, deployed proxy TLS, key rotation and independent-process crash/failover remain unverified.

## Official sources

- [MCP authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).
- [Official SDK HTTP guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html), [resource-server authorization guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html), [SDK repository](https://github.com/modelcontextprotocol/typescript-sdk). The guides were fetched as official Markdown after the web renderer could not open them.
- [Slack search.messages](https://docs.slack.dev/reference/methods/search.messages/), [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/), [auth.test](https://docs.slack.dev/reference/methods/auth.test/), [request signing](https://docs.slack.dev/authentication/verifying-requests-from-slack/).
- [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), [App REST token exchange](https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10), [checks REST](https://docs.github.com/en/rest/checks/runs?apiVersion=2026-03-10), [issues REST](https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10), [webhook verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

## Final local verification

2026-10-23 21:51–21:53 PDT: `pnpm --filter mcp-common --filter mcp-slack --filter mcp-github --filter oauth --filter db --filter runtime test` passed 105 tests: db 3, OAuth 43, runtime 28, common 11, Slack 12, GitHub 8. All-workspace `pnpm typecheck` passed. A subsequent self-review regression for 401 during Slack writer revalidation failed first, then the fix passed the complete Slack suite (13 tests) and its strict typecheck. A final official-source check tightened the fixture to require documented POST for Slack auth.test; that regression failed first, then the full Slack suite passed **14 tests** with strict typecheck. A final compatibility test also exercised a real SDK 2025-11-25 initialize handshake alongside the modern client; the common suite passed 12 tests and strict typecheck. Final MCP count is **34** (common 12, Slack 14, GitHub 8), with **108 related tests across the verified suites**. Unaffected suites were not repeated after the Slack-only fixes. `pnpm install --frozen-lockfile --ignore-scripts` and `git diff --check` succeeded. No project test containers remained after verification.

GitHub issue attribution field availability was also checked in the official [REST OpenAPI issue schema](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json) (`performed_via_github_app` references `nullable-integration`); whether the actual sandbox App populates it remains pending.


## Review fix 1 — original GitHub writer identity

The independent review reproduced a recovery bug: App 42 created issue 12 and lost its reply; after configuring App 99, a copied marker in issue 13 from App 99 could be accepted as the original action. The fix freezes trusted App/installation/API identity through `prepare` in the existing encrypted journal payload, checks the identity before dispatch, and uses the saved App ID for issue attribution. A replacement deployment or missing evidence stays UNKNOWN; restoring the original compatible configuration can reconcile the original issue. Operators must investigate legacy UNKNOWN rows with no evidence; do not retrofit identity from current configuration or delete the reservation to retry.

Three new regressions use the actual SDK, Streamable HTTP servers, PostgreSQL and a synthetic GitHub HTTP fixture. All three failed on the original code with assertion failures: replacement lookup returned 200 instead of 409; missing-evidence lookup returned 200 instead of 409; mismatched preparation still caused one write instead of zero. They pass after the fix. The replacement test closes and recreates the MCP server and journal while retaining the database, keeps both original issue 12 and copied issue 13 present, verifies UNKNOWN under App 99, then restores App 42 and verifies stored result `{number:12}` with exactly one provider effect.

2026-10-23 22:09 PDT: `pnpm --filter mcp-common --filter mcp-slack --filter mcp-github test` passed **37 tests** (common 12, Slack 14, GitHub 11). The same three packages passed strict `typecheck` on Node 20.19.5. The common server, GitHub and Slack adapter paths, and Slack integration test were expanded for reviewability; the Slack test AST is unchanged. `git diff --check` passed; no project test containers remained. This round changed no migration or dependency and did not repeat unrelated DB/OAuth/runtime suites or frozen install. This supersedes the earlier final MCP count; it does not claim those unrelated suites were rerun. Real AS and SaaS acceptance remains pending as described above.

## Task 7 — Google and Salesforce (synthetic HTTP fixtures)

2026-10-23 PDT. These are working local MCP adapters, **not real Google/Salesforce sandbox acceptance**. Tests use the official MCP SDK client over TCP, synthetic provider HTTP servers, actual Task 5 OAuth callbacks/encrypted PostgreSQL storage, and the existing runtime approval bridge/journal. No real mail, drafts, calendar events or CRM records were touched. No cloud resources, model calls or GPU work were used.

### Public interfaces and minimum capabilities

Factories are `googleTools(oauthService, options?)` from `mcp-google` and `salesforceTools(oauthService, options)` from `mcp-salesforce`. Their returned `ToolSpec`s work directly with `createRuntimeTool`; use service names `google` and `salesforce`. Exported argument schemas are `searchSchema`, `draftReplySchema`, `findSlotsSchema`, `querySchema`, and `updateCaseStatusSchema`. The first three belong to `mcp-google`; the last two belong to `mcp-salesforce`.

| MCP name | Arguments / result | Required actual provider capability |
| --- | --- | --- |
| Google `search` | `{query}` → `{messageReferences:[{id,threadId}],truncated}` | `https://www.googleapis.com/auth/gmail.readonly` or an already-granted `gmail.modify` / full-mail grant. Metadata alone cannot use `q`. |
| Google `draft_reply` | `{thread_id,body}` → draft `{id,message:{id,threadId}}`; never sends | `gmail.compose` plus `gmail.metadata` (readonly also satisfies header reads), plus `openid` and `email` for stable writer identity. Already-granted broader Gmail scopes are accepted; canonical `https://www.googleapis.com/auth/userinfo.email` also satisfies email. |
| Google `find_slots` | `{attendees:string[],duration:number,window:{start,end}}` → `{slots:[{start,end}]}` | `https://www.googleapis.com/auth/calendar.freebusy`; documented `calendar.events.freebusy`, readonly/full Calendar alternatives also accepted. |
| Salesforce `query` | `{soql}` → `{records,truncated}` | `api` or already-granted `full`; provider object/field/record permissions still apply. |
| Salesforce `update_case_status` | `{case_id,status}` → `{case_id,status}` | `api` plus `id` for original user/org identity; already-granted `full` satisfies both. |

The Gmail shorthand scopes in this table use prefix `https://www.googleapis.com/auth/`. The `openid`/`email` strings are OIDC scopes. Search and Calendar never demand identity grants. The draft identity check reads only `sub` from Google's UserInfo endpoint and the Gmail profile address; it never returns UserInfo claims to the model. Salesforce parses only `user_id` and `organization_id`. These original writer fields are encrypted in the existing journal, never logged or included in tool results.

`find_slots.duration` is an integer number of minutes (1–1440), attendees are 1–50 distinct email calendar IDs, and window timestamps must be ISO-8601 with timezone. Windows must be ordered and no longer than 31 days. Results are maximal common free intervals at least `duration` long, clipped to the window. Missing/error calendars and invalid intervals fail closed; no event is created.

SOQL deliberately supports only one allowlisted object with simple field names, optional scalar comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`) joined by AND/OR, optional ORDER BY simple fields/ASC/DESC, and LIMIT 1–10000. Nested queries, relationship paths, aliases, functions, TYPEOF, grouping, comments, binds, locks, dynamic syntax and trailing statements are rejected before provider traffic. This is a restricted grammar, not a general SOQL implementation. Both read tools cap pagination at ten pages and report truncation. Repeated page tokens fail closed. Salesforce next-record locators must be relative paths under the configured version's `/query/` with an alphanumeric/underscore/hyphen locator; absolute URLs, query strings and other API paths are rejected.

### Incremental consent and host responsibilities

New `mcp-common/provider-auth` exports `ConsentHandler`, `ConsentRequest`, `MissingScopeError`, and the shared `providerAuthorization` capability helper. Actual grants and identity come only from `OAuthService.getAuthorizationSnapshot`; a rejected access token triggers at most one single-flight refresh, followed by fresh capability and writer checks. A scope request never changes stored actual grants.

Factories and launch functions accept an optional **trusted in-process** `onConsentRequired` callback. Only a missing capability/disconnected or reconsent-required account invokes it. It receives `{tenantId,provider,scopes,authUrl,state}` after Task 5 creates a PKCE pending state for just the missing scopes. Deliver that object only through the authenticated host consent UI/control plane. Complete the callback through the same Task 5 provider configuration and key. No consent HTTP endpoint is added here. Repeated missing-scope calls can create new pending states; the host should deduplicate/pace user prompts. Failed control-plane delivery still denies the tool.

The model-facing result is `SCOPE_MISSING` with safe `_meta.requiredScopes`; there is no token, authorization URL, state, identity claim, or model approval field. If no callback is configured (including standalone CLI), missing scopes still fail closed and no pending state is automatically created. The operator must run Task 5 consent through a trusted host. Google web registrations use Task 5's `include_granted_scopes`; callbacks always preserve only provider-reported grants, never a fabricated requested/granted union. For Salesforce background refresh, arrange `refresh_token`/`offline_access` through the trusted host when needed; these tools do not eagerly request it or every tool's scopes at startup.

### Deployment

The common owner-only JSON/key files, AS bearer verification, subject→tenant map, PostgreSQL setup, and reverse-proxy requirements above apply unchanged. No new migration is required: use migrations 0001–0003. Pool connection acquisition remains 3000 ms, OAuth store at most 15000 ms, and the action journal retains existing bounded timeouts. Default loopback resources are `http://127.0.0.1:9103/mcp` (Google) and `http://127.0.0.1:9104/mcp` (Salesforce).

For Google, use port/resource 9103 in the common config and this `provider` object:

```json
{
  "clientId": "YOUR_GOOGLE_TEST_CLIENT_ID",
  "clientType": "web",
  "clientSecretFile": "/absolute/private/google-client-secret",
  "redirectUri": "YOUR_EXACT_REGISTERED_REDIRECT_URI"
}
```

A genuinely registered desktop client can set `clientType: "desktop"` and omit the secret. Match Task 5's exact registration/binding. For Salesforce, use port/resource 9104 and:

```json
{
  "clientId": "YOUR_SALESFORCE_TEST_CLIENT_ID",
  "clientSecretFile": "/absolute/private/salesforce-client-secret",
  "redirectUri": "YOUR_EXACT_REGISTERED_REDIRECT_URI",
  "loginOrigin": "https://test.salesforce.com",
  "apiVersion": "v66.0",
  "tenants": {
    "YOUR_TEST_TENANT": {
      "instanceUrl": "https://YOUR_SANDBOX_MY_DOMAIN.my.salesforce.com",
      "objects": ["Case", "Account"],
      "caseStatuses": ["New", "Closed"]
    }
  }
}
```

Choose the actual developer org login origin (`login.salesforce.com`, `test.salesforce.com` or its trusted My Domain as supported by Task 5), instance, API version, object allowlist and valid Case statuses. The example names are placeholders. Runtime routing uses only this trusted per-tenant instance, never model input or token-response `instance_url`. HTTPS Salesforce instances must use a `.my.salesforce.com` hostname with no path/query; HTTP loopback is allowed for fixtures. Provider factory endpoint overrides are trusted test/embedding inputs, not model tool arguments; CLI configurations expose no Google endpoint override.

```bash
export PATH="$PWD/.tools/pnpm/node_modules/.bin:$PATH"
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter mcp-google exec tsx src/main.ts /absolute/private/google-mcp.json
# Separate terminal:
pnpm --filter mcp-salesforce exec tsx src/main.ts /absolute/private/salesforce-mcp.json
```

Embedding entry points are `launchGoogle(configPath, {onConsentRequired?})` and `launchSalesforce(configPath, {onConsentRequired?})` from the respective `main` exports. Both return `{origin,url,close}`. Startup was tested with real PostgreSQL and private fixture config files, without real provider calls. Use the existing runtime bridge with the returned write descriptor, actual AS bearer source, shared approval authority, trusted approvals and guard. Model arguments remain exactly the interfaces above. The host must approve the real runtime binding, including tenant/run/tool/action key/argument hash; merely setting a model field never authorizes a write.

### Write evidence and recovery boundaries

Gmail prepares and encrypts the original Google subject, mailbox address, Gmail/identity endpoints, thread ID, recipient, original reply headers, subject and body before dispatch. It revalidates identity with the same bearer used for the next provider operation. Safe MIME contains base64 UTF-8 body, encoded/folded subject, In-Reply-To/References and a deterministic `<keel-ACTION_KEY@keel.invalid>` Message-ID. The supported recipient syntax is one plain mailbox or display-name mailbox; ambiguous lists/groups and header control characters are rejected. The reply uses the latest message's headers, without attachments/reply-all. Only `drafts.create` is called; no send API exists in this adapter.

After a lost response, recovery enumerates draft references, fetches raw details, and requires exactly one match for complete saved raw MIME and original thread under the same subject/mailbox/endpoints. Current thread headers/configuration cannot replace original evidence. Missing legacy evidence, changed identity/endpoints, copies with changed contents, ambiguous matches, missing results or provider failures remain UNKNOWN. Exact raw comparison is deliberately conservative: provider MIME normalization, edits/deletions, index/list delay or ten-page/time bounds can leave an actual draft UNKNOWN. Real Gmail preservation of the submitted MIME/Message-ID and raw representation still needs sandbox verification.

Salesforce freezes the original user/org, instance/version, Case ID and desired status before dispatch, then verifies that writer again after any refresh. It issues one PATCH of exactly `{Status: ...}` to an allowed `Case` ID and expects HTTP 204 with no body. An uncertain write **always stays UNKNOWN**, even if the current Case status equals the target. No audit correlation or provider idempotency guarantee is claimed, and there is no automatic repeat PATCH. Operators must reconcile uncertain effects manually, including possible workflow execution; never delete the journal reservation just to retry.

Shared HTTP handling accepts only an actually empty 204 as `null`. JSON-requiring callers still validate their response schemas and fail closed. GET retry remains bounded to one transient retry with capped Retry-After delay and cancellation/deadline support. POST/PATCH effects are not retried for disconnects, 429 or 5xx. Explicit 401 rejection can refresh once; every replacement token is checked again before dispatch. Raw provider error bodies never reach tool errors/logs/traces.

### Validation and remaining sandbox work

Commands actually run locally:

```bash
pnpm --no-bail --filter mcp-common --filter mcp-slack --filter mcp-github \
  --filter mcp-google --filter mcp-salesforce --filter oauth --filter db --filter runtime test
pnpm --filter mcp-google --filter mcp-salesforce test
pnpm typecheck
pnpm install --frozen-lockfile --ignore-scripts
```

The full related run passed 133 tests (db 3, OAuth 43, runtime 28, common 14, Slack 14, GitHub 11, Google 12, Salesforce 8) before adapter-only self-review additions. The final Google/Salesforce suites include response validation and immutable Google subject/email-grant regressions; see the final count below. TDD logs are in ignored `.superpowers/sdd/3-keel-agent-plan/logs/task7-*.log`, and the implementer report gives exact RED→GREEN sequences. All fixtures are synthetic, not recordings. The database helper labels containers `project=keel`, caps each at 512 MiB / 1 CPU and stops them afterward.

Pending real acceptance: register Google test OAuth app/users and Salesforce Developer Edition/sandbox; verify API availability, exact returned/refresh scopes and UserInfo identity endpoints/claims; use the trusted consent flow and real independent AS tokens; run read tools against developer-only fixtures; approve one draft and one test Case status update through `runAgent`; verify actual recipients/thread/MIME/status and no send; repeat action keys; inspect actual provider behavior after a lost response and scope reduction. No claim is made for deployed TLS/AS, provider rate limits, real consent screens, MIME fidelity, Salesforce workflow/audit behavior or live account permissions until those steps are performed.

Official references checked for this task: [Gmail messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [threads.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get), [drafts.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/get), [draft guide](https://developers.google.com/workspace/gmail/api/guides/drafts), [thread reply requirements](https://developers.google.com/workspace/gmail/api/guides/threads), [Google OIDC scopes, stable sub and UserInfo endpoint](https://developers.google.com/identity/openid-connect/openid-connect), [Calendar freeBusy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query), [Salesforce query pagination](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-query.html), [Salesforce record PATCH](https://developer.salesforce.com/docs/platform/api-rest/guide/dome-update-fields.html), and [Salesforce UserInfo claims/identity grants](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_using_userinfo_endpoint.htm&language=en_US&type=5). These references establish protocol expectations, not real sandbox acceptance.

Final Task 7 verification: Google **17/17**, Salesforce **10/10**; common/Slack/GitHub **39/39** and db/OAuth/runtime **74/74** passed in the preceding full related run. The resulting verified suite coverage is **140 tests**, without claiming that unchanged suites were rerun after Google/Salesforce-only additions. Final identity-response regressions prove that unexpected UserInfo/profile 2xx cannot masquerade as a write acknowledgement: these identity operations require HTTP 200, and only an explicit 401 can initiate refresh. All-workspace strict `pnpm typecheck` passed; Both adapter strict typechecks were repeated after the final identity-status tests. Frozen install and `git diff --check` passed. The final consent test inspects the real Task 5 authorization URL (`scope=openid email`, OpenID first), verifies the original actual grant set is unchanged before callback, accepts the provider's canonical email-scope alias, and confirms only safe draft IDs reach the model. No Keel test containers remained.

### Task 7 review fix 1 — restricted SOQL literals and evidence maintenance

M1 addressed: unary minus is now accepted only before a numeric literal. Four actual SDK → TCP MCP → synthetic HTTP provider regressions reject negative strings, TRUE, FALSE and NULL with **zero provider queries**; a positive control preserves `-1` and `-0.25`. The focused RED command `pnpm --filter mcp-salesforce exec vitest run test/integration.test.ts -t 'SOQL unary minus'` produced four failures and one passing numeric control before the fix (`task7-fix1-red.log`). After the fix, `pnpm --filter mcp-salesforce test` passed **15/15**, and `pnpm --filter mcp-salesforce typecheck` passed, with clean logs (`task7-fix1-green.log`, `task7-fix1-typecheck.log`). No common library, dependency or migration changed; unrelated suites and frozen installation were not rerun. Combined recorded coverage is now 145 tests across the previously verified suites, not one new 145-test run.

M2 addressed as documentation: the original offline install log `task7-install.log:3` contains inherited test-tooling subdependency deprecation warnings for `glob@10.5.0` and `uuid@10.0.0`. These remain a dependency-maintenance item; this task neither upgrades them nor hides the original log. The later frozen-install log and final test/typecheck logs are clean, as previously reported. Real provider/AS/TLS acceptance remains unperformed.

The final review-fix check retains actual UTC timestamps, commands, output and exit codes for `git diff --check` and the empty `docker ps --all --filter label=project=keel` inventory in `.superpowers/sdd/3-keel-agent-plan/logs/task7-fix1-final-checks.log`. This supplies raw terminal evidence missing from the first review's log set. All review-requested code and evidence changes are addressed; inherited dependency maintenance and real-account acceptance remain open outside this fix's scope.
