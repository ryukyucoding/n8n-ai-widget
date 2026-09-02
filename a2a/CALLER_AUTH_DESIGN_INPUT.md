# Caller-auth / credential-enablement — design input

**Status:** design input for brain/Dan. Not code, not an implementation authorization. Builds on R3 (`CONTINUOUS_RESEARCH.md`). **Never send the server's n8n API key — or any master/high-privilege key — to the browser.**
**Author:** executor (2026-09-02, read-only).

## 1. Current trust model (verified from index.js / n8nAgent.js)

```
browser (untrusted, no caller identity, CORS *)
   │   /chat, /generate, /beta/*, /models   ← no auth on this hop
   ▼
server (holds N8N_API_KEY in env; uses X-N8N-API-KEY to n8n; key never sent to browser)
   │   ${N8N_BASE_URL}/api/v1/workflows ...
   ▼
n8n runtime
```

- `N8N_API_KEY` is a server-side secret used for workflow create/read/modify. Whether it can also reach/manage n8n **credentials** depends on the instance's configuration/version and is **NOT verified here** — treat it as an unconfirmed runtime privilege (see unknowns), not an established fact. Either way, the key stays in the server process and is **not** exposed to the browser.
- The browser-facing `/models` (`modelConfig()`) returns only model names/flags — **no keys** (verified; earlier apiKey fields are server-side model-client config, not the browser payload).
- `n8nAgent.js` keeps an in-memory `sessions` Map keyed by a caller-supplied `sessionId` (≥32 chars), but this is a conversation session, **not authenticated identity**.
- **Gap:** there is no caller *identity* on the browser→server hop (wildcard CORS, no auth). Per R3 / COMPILER_EXPANSION §7, this is the prerequisite that must exist before a user can be asked to connect their own credentials.

## 2. Requirement

Establish a verifiable caller identity for browser→server requests, so that (later) a user's own credentials can be collected and bound in n8n on that user's behalf — without ever handing the browser the server's n8n API key or any master key.

## 3. Alternatives (≥2; none send a privileged key to the browser)

### Option A — Server-mediated authenticated session
The browser authenticates to the widget host (session cookie / OAuth / SSO login); the server establishes caller identity and performs all n8n operations server-side with its own `N8N_API_KEY`, scoped to the authenticated user. User-provided credentials are stored in n8n through the server and associated with that user.
- **Trust boundary:** the server. n8n key stays server-only.
- **n8n session/proxy dependency:** none required; the server owns n8n access.
- **Revocation:** invalidate the server session; delete the user's n8n credential.
- **CORS:** restrict to known origins; browser→server carries a session token/cookie.
- **Migration risk:** moderate — add an auth layer + user/session store and require identity on the existing routes; app-level change but no new infra dependency.

### Option B — Reverse-proxy / SSO in front (identity forwarded)
Deploy the widget+server behind an authenticating reverse proxy (or n8n's own auth/SSO); the proxy authenticates the caller and forwards a verified identity header the server trusts. Server still uses its server-side `N8N_API_KEY`.
- **Trust boundary:** the proxy / IdP.
- **n8n session/proxy dependency:** depends on the proxy or n8n SSO config being present and correct.
- **Revocation:** at the proxy / identity provider.
- **CORS:** enforced at the proxy (single trusted origin).
- **Migration risk:** infra-level (stand up/configure the proxy); minimal app code, but couples to the deployment topology (see unknowns).

### Option C — Per-caller short-lived scoped tokens (builds on A or B)
After A or B authenticates the session, the server mints a narrow, short-lived token scoped to that user's workflows/credentials for subsequent calls — **never** the master key.
- **Trust boundary:** server (mint) + whatever authenticated the session.
- **Revocation:** short TTL + a revocation list.
- **CORS:** restricted origins.
- **Migration risk:** adds a token-issuing service on top of A/B.

## 4. Explicitly rejected

- Sending `N8N_API_KEY` (or any master/API key) to the browser — under any option. The browser is untrusted.
- Treating the `n8nAgent` conversation `sessionId` as authentication — it is not identity.

## 5. Unknown runtime facts (Desktop Codex / Dan to confirm — executor cannot reach .44; no network/model calls made)

1. Does the deployed instance already sit behind a reverse proxy (R3 noted an nginx proxy network)? If so, can it authenticate callers?
2. Does the n8n instance have user-management / SSO enabled, or is it single-instance API-key only?
3. Is there an identity provider available for the widget host (org SSO, OAuth app, etc.)?
4. Current CORS / allowed-origin posture on the deployed instance.
5. Dan's decision on the deferred access-control NEEDS_HUMAN item — this is the gate that turns any option above from design into work.
6. **Whether the server's n8n API key can actually reach/manage credentials** on the deployed instance — a runtime privilege claim to confirm against the real n8n auth/credential capabilities, not to assume. Every option above still requires this confirmation before implementation.

## 6. Recommendation (input only; Dan/brain decide)

Option A is the most self-contained (no new infra dependency, revocation and scoping owned by the server) and keeps the n8n key server-side by construction; Option B is attractive if the deployment already has an auth proxy (unknown #1). Either way, credential collection stays gated behind established caller identity, and credential values continue to follow the R3 secret boundary (identities only to planner, values only in n8n). No implementation until Dan reopens the access-control decision.
