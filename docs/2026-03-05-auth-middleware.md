# Implementation Plan: Add Authentication to API Routes and WebSocket Endpoints

**Issue:** #1 — Add authentication to API routes and WebSocket endpoints
**Date:** 2026-03-05

## Problem

All Next.js API routes, WebSocket servers, and terminal servers have zero authentication. Any client on the network can perform privileged actions: spawning agents, sending commands, killing sessions, merging PRs, and getting full terminal access.

## Design

### Shared Secret Approach

Generate a random shared secret at startup. Store it in the data directory so all components (Next.js, terminal servers) can read it. Require it via `Authorization: Bearer <token>` header for HTTP routes and via query parameter for WebSocket connections.

### Secret Generation & Storage

1. On first startup (`ao start` or when the web server initializes), generate a 256-bit random token using `node:crypto.randomBytes(32).toString('hex')`.
2. Write it to `<dataDir>/.ao-auth-token` with mode `0600`.
3. If the file already exists, read and reuse it (idempotent restarts).
4. The token persists across restarts but is regenerated on `ao init` or explicit reset.

### Implementation Tasks

#### Task 1: Create auth utility module (`packages/web/src/lib/auth.ts`)

Create a new module that:
- Reads the auth token from `<dataDir>/.ao-auth-token`
- Falls back to `AO_AUTH_TOKEN` environment variable
- Provides `getAuthToken(): string | null` to load the token
- Provides `validateRequest(request: NextRequest): NextResponse | null` that:
  - Returns `null` if auth is valid (caller proceeds normally)
  - Returns a 401 `NextResponse` if auth fails
- If no token file and no env var exist, auth is disabled (open-source default for local dev)
- Caches the token in memory after first read

#### Task 2: Create auth token generation in core (`packages/core/src/auth.ts`)

Create a utility function:
- `ensureAuthToken(dataDir: string): string` — reads existing token or generates and writes a new one
- `getAuthTokenPath(dataDir: string): string` — returns the token file path
- Uses `node:crypto.randomBytes(32).toString('hex')` for generation
- Writes with `0600` permissions
- Exports from `packages/core/src/index.ts`

#### Task 3: Add auth to Next.js API routes via middleware (`packages/web/src/middleware.ts`)

Create Next.js middleware (the standard `middleware.ts` pattern):
- Matches all `/api/*` routes
- Reads the auth token from env or file
- Checks `Authorization: Bearer <token>` header
- Returns 401 for missing/invalid token
- Passes through if no token configured (dev mode)
- Does NOT protect static assets or page routes (dashboard is read-only after auth)

#### Task 4: Add auth to Direct Terminal WebSocket server (`packages/web/server/direct-terminal-ws.ts`)

- Add `verifyClient` callback to `WebSocketServer` constructor
- Check for `token` query parameter: `ws://host/ws?session=X&token=Y`
- Read auth token from same source as middleware
- Reject connection with 401 if token is invalid
- Pass through if no token configured
- Also protect the `/health` endpoint (leaks session IDs)

#### Task 5: Add auth to Terminal WebSocket server (`packages/web/server/terminal-websocket.ts`)

- Check for `Authorization` header or `token` query parameter on HTTP requests
- Reject with 401 if token is invalid
- Pass through if no token configured
- Also protect the `/health` endpoint

#### Task 6: Update frontend to send auth token

- Read token from `NEXT_PUBLIC_AO_AUTH_TOKEN` env var or a server-side API
- Add `Authorization` header to all `fetch()` calls in Dashboard components
- Add `token` query parameter to WebSocket connections in `DirectTerminal.tsx`
- Add token to SSE `EventSource` via custom fetch (EventSource doesn't support headers natively, use polyfill or switch to fetch-based SSE)

Actually, for the frontend: since the dashboard and API are on the same origin, we can use a simpler approach:
- Create a `/api/auth/token` endpoint that serves the token to the page (protected by... itself being an API route, so this is circular)
- Better approach: **inject the token into the page via a server component** or use a **cookie-based session** after initial auth

Simplest viable approach for v1:
- The dashboard serves from the same process as the API
- Set the token as an `httpOnly` cookie on the initial page load
- All `fetch()` and EventSource calls automatically include cookies
- WebSocket connections add the token as a query parameter (read from a non-httpOnly cookie or a `<meta>` tag)

Even simpler: **use a single long-lived cookie set by Next.js middleware**:
1. On first page visit, middleware checks if `ao-auth` cookie exists
2. If not, check `Authorization` header or `token` query param
3. If valid, set `ao-auth` cookie and proceed
4. Subsequent requests (fetch, SSE) include the cookie automatically
5. WebSocket connections read the cookie value and pass as query param

**Revised simplest approach**:
- API routes check `Authorization: Bearer <token>` header
- Dashboard pages are unprotected (they're just static HTML/JS)
- The dashboard reads the token from `NEXT_PUBLIC_AO_AUTH_TOKEN` environment variable
- Dashboard JS adds `Authorization` header to all API calls
- WebSocket connections use `token` query parameter
- For EventSource (no custom headers), switch to fetch-based SSE or pass token as query parameter

This is the most straightforward approach. The token is visible in the browser env, but that's acceptable because:
1. This is a local dev tool, not a production SaaS
2. The token prevents casual LAN attacks, not browser-based attacks
3. If someone has access to the browser, they already have access to everything

#### Task 7: Update `ao start` to generate and display the auth token

- Call `ensureAuthToken(dataDir)` during startup
- Set `AO_AUTH_TOKEN` env var for the web process
- Set `NEXT_PUBLIC_AO_AUTH_TOKEN` env var so Next.js exposes it to the client
- Print the token to the console: "Dashboard auth token: <token>"

#### Task 8: Write tests

- Unit tests for `auth.ts` (token generation, validation)
- Unit tests for middleware (401 on missing/bad token, pass-through with valid token, pass-through when no token configured)
- Integration tests for WebSocket auth rejection
- Update existing API route tests to include auth header

## Files Changed

### New Files
- `packages/core/src/auth.ts` — token generation/management
- `packages/web/src/lib/auth.ts` — token validation helpers for web
- `packages/web/src/middleware.ts` — Next.js auth middleware

### Modified Files
- `packages/core/src/index.ts` — re-export auth functions
- `packages/web/server/direct-terminal-ws.ts` — add `verifyClient` + health auth
- `packages/web/server/terminal-websocket.ts` — add auth check to HTTP handler
- `packages/web/src/components/DirectTerminal.tsx` — add token to WebSocket URL
- `packages/web/src/hooks/useSessionEvents.ts` — add token to EventSource (if feasible)
- `packages/web/src/components/Dashboard.tsx` — add auth headers to fetch calls
- `packages/web/src/__tests__/api-routes.test.ts` — update tests for auth
- `packages/core/src/types.ts` — no changes needed (token is infra, not plugin interface)

## Non-Goals

- Full user management / multi-user auth (out of scope)
- OAuth / SSO (out of scope)
- RBAC / permissions (out of scope)
- Rate limiting (separate issue)
- HTTPS enforcement (separate concern, usually handled by reverse proxy)
