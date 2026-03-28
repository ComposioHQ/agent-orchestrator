---
"@composio/ao-web": patch
---

Fix runtime terminal websocket connectivity for npm-installed/prebuilt runs and harden spawn project validation.

- add runtime terminal config endpoint (`/api/runtime/terminal`) so the browser can read runtime-selected ports
- make direct terminal client resolve websocket target from runtime config before connect/reconnect
- return deterministic `404 Unknown project` from `/api/spawn` for non-configured project IDs
- normalize dashboard project filter to configured project IDs to prevent invalid query state propagation
