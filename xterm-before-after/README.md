# PR #5105: direct before/after reproduction

Compared parent `09effe55bdc9005ccd317f63cada6c69d7bb49d7` against fixed head `40816926f2bf90b889daa9c86dddb956c02165f4`.

Three normal Chat → Terminal → Chat cycles using daemon mode-change events. Production renderer source and real xterm, served in development mode with React StrictMode. Fake daemon, preload, and terminal PTY; no timer mocking, injected exception, or source patch.

Before: one uncaught `TypeError: Cannot read properties of undefined (reading 'dimensions')` per terminal opening (3 total). Stack: `get dimensions` → `Viewport.syncScrollArea` → queued initialization callback.

After: zero uncaught errors across the same three cycles. Both versions returned to Chat; no visible crash or layout difference reproduced. This evidence does not establish a packaged-app crash.

The fix defers `term.dispose()` with `setTimeout(..., 0)` until after xterm's already queued initialization callback, not until an animation frame. The existing AO listeners are still removed synchronously.

`comparison.png` and `comparison.html` put unmodified screenshots next to labeled QA summaries of real pageerror events. The underlying images, recordings, raw error logs, and exact test are included here.

Reproduction in the existing external fixture:

```sh
python3 /tmp/pr4463-split/prepare-evidence.py sqlc
# sqlc checkout frontend is clean at the parent above.
PATH=/Users/dhruvsharma/.nvm/versions/node/v24.14.0/bin:$PATH AO_SPLIT_CHECKOUT=/tmp/pr4463-split/sqlc AO_CHATUI_E2E_PORT=5465 AO_CHATUI_E2E_ARTIFACT_DIR=/tmp/pr4463-split/evidence/xterm-before AO_XTERM_VARIANT=before AO_XTERM_COMMIT=09effe55bdc9005ccd317f63cada6c69d7bb49d7 node node_modules/@playwright/test/cli.js test --config playwright.chatui.config.ts xterm-before-after.spec.ts
# Repeat with prepare-evidence.py xterm, AO_SPLIT_CHECKOUT=/tmp/pr4463-split/xterm,
# artifact dir xterm-after, variant after, and fixed commit 40816926f2bf90b889daa9c86dddb956c02165f4.
```

Both evidence tests passed. The before test explicitly expects the known three errors; the after test requires none. Both require no console errors or unexpected requests.
