# Validation record

All five feature slices and the xterm prerequisite passed the complete renderer smoke suite (58 tests per slice), frontend typechecking and E2E typechecking under Node 24.14.0 on macOS. The final renderer run includes the native pinned browser compatibility test; it was separately checked for the earlier slices (23 tests passed). Skipped tests are platform/fixture exclusions already in the suite.

| Slice | PR | Full frontend Vitest passed | Renderer smoke passed |
| --- | --- | --- | --- |
| Xterm prerequisite | #5105 | 4,002 / 7 skipped | 58 |
| text | #5106 | 4,081 / 6 skipped | 58 |
| attachments | #5107 | 4,083 / 7 skipped | 58 |
| queue | #5109 | 4,092 / 7 skipped | 58 |
| inline | #5110 | 4,128 / 7 skipped | 58 |
| steer | #5111 | 4,138 / 6 skipped | 58 |

Shared Cloud client and product UI generation/typecheck/test/build checks and pack dry runs passed. API/SQLC regeneration drift checks passed for each backend slice. Full backend build/vet and pinned golangci-lint v2.12.2 passed; native macOS CLI E2E passed for queue, inline, and steer. Focused service/storage/controller suites passed on each backend slice.

The full local `go test -race -p 1 -timeout=15m ./...` attempt on the final stack passed the Chat service package (243.537s), but later exhausted disk space while creating temporary repositories and linking test binaries. It is **not** a full local pass. Additional race runs were stopped to avoid further disk exhaustion. The queue slice's full non-race Go suite passed earlier. Docker did not answer `docker info` within 15 seconds; container and native Windows/Linux coverage therefore requires CI. The signed packaged-app pod gate was not run or claimed; the native screenshots are an Electron development build.

The first queue macOS CI attempt failed before tests because `proxy.golang.org` timed out downloading `github.com/Microsoft/go-winio@v0.6.2`; only that failed job was rerun. This was not an assertion failure.

Reproduce the ordinary local checks from a checked-out PR branch:

```sh
cd frontend
npm run typecheck
npm run typecheck:e2e
npm run browser-runtime:prepare -- --quiet
AO_AGENT_BROWSER_TEST_BINARY="$PWD/agent-browser/agent-browser" npx vitest run --config vite.renderer.config.ts --maxWorkers=3
CI=true npm run test:e2e:renderer -- --workers=1
cd ../backend
go build ./...
go vet ./...
go test -race -timeout=15m ./...
go test -tags e2e -v ./internal/cli/...
go test -tags chatui_regression -run TestChatUIRegressionDraftDeliveryRecoveryIsAtMostOnce -v ./internal/service/chat
```

The last tagged receipt test exists in the final steer slice and selects counted service/SQLite cases for both steer and inline-edit recovery. It uses injected providers; it does not claim an external provider was invoked.

Native screenshots show the cumulative feature stack with the real daemon, native preload and a real Codex scratch session in an isolated AO data/profile directory. The native run checked reload/restoration, independent composer and inline edit state, actual daemon attachment staging, accepted send clearing, Chat/TUI roundtrip, and shell PTY input. All task-owned Electron, daemon, chat-host and PTY-host processes were stopped afterwards.
