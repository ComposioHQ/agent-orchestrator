#!/usr/bin/env bash
#
# scripts/demo-pr-1466.sh
#
# End-to-end demo for PR #1466 (storage redesign + cross-project CLI rework).
# Designed to be run live for a screencast — silent narration via section
# banners, no live typing, deterministic output.
#
# Strict sandbox: redirects $HOME to /tmp/ao-demo-1466 so getAoBaseDir()
# resolves there instead of touching the operator's real ~/.agent-orchestrator.
# After the script exits the original $HOME of the parent shell is unaffected.
#
# Usage:
#   scripts/demo-pr-1466.sh
#
# Re-run is idempotent — wipes and recreates the sandbox each time.
#

set -euo pipefail

# ─── config ────────────────────────────────────────────────────────────────

DEMO_HOME="/tmp/ao-demo-1466"
DEMO_PORT="3947"
AO_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AO_CLI="$AO_REPO/packages/cli/dist/index.js"

# Save the operator's real HOME so we can restore it for sub-commands
# that legitimately need it (running the full test suites — tests read
# getGlobalConfigPath() which honors AO_GLOBAL_CONFIG, and a sandboxed
# global config would break tests that touch the global registry).
REAL_HOME="$HOME"

# Sandbox the entire script under a fake HOME so AO's hardcoded
# ~/.agent-orchestrator path is redirected. Belt-and-suspenders: also
# pin AO_GLOBAL_CONFIG explicitly.
export HOME="$DEMO_HOME"
export AO_GLOBAL_CONFIG="$DEMO_HOME/.agent-orchestrator/config.yaml"

# Local CLI invoker — never use the system `ao`.
ao() {
  node "$AO_CLI" "$@"
}

banner() {
  printf '\n'
  printf '═══════════════════════════════════════════════════════════════════════\n'
  printf '  %s\n' "$1"
  printf '═══════════════════════════════════════════════════════════════════════\n'
  sleep 2
}

step() {
  printf '\n→ %s\n' "$1"
  sleep 1
}

note() {
  printf '   %s\n' "$1"
}

# ─── pre-flight ────────────────────────────────────────────────────────────

banner "Pre-flight: build CLI + reset sandbox"

if [[ ! -f "$AO_CLI" ]]; then
  note "CLI bundle not found, building..."
  (cd "$AO_REPO" && pnpm --filter @aoagents/ao-cli build >/dev/null)
fi

rm -rf "$DEMO_HOME"
mkdir -p "$DEMO_HOME/.agent-orchestrator"

# Minimal git config so worktree operations during the demo don't fail
# from the redirected HOME.
cat >"$DEMO_HOME/.gitconfig" <<'GITCONFIG'
[user]
  name = AO Demo
  email = demo@example.com
[init]
  defaultBranch = main
[advice]
  detachedHead = false
GITCONFIG

note "Repo:    $AO_REPO"
note "CLI:     $AO_CLI"
note "Sandbox: $DEMO_HOME"
note "Port:    $DEMO_PORT (no real ao daemon spawned in this demo)"
sleep 2

# ───────────────────────────────────────────────────────────────────────────
banner "Act 1 — Migration: V1 hash dirs → V2 projects/  (most-reviewed code)"
# ───────────────────────────────────────────────────────────────────────────

step "Seed a real V1 layout (hash-prefixed dir, key=value metadata)"

DEMO_REPO="$DEMO_HOME/myproject"
mkdir -p "$DEMO_REPO"
git -C "$DEMO_REPO" init --quiet -b main
echo "hello" >"$DEMO_REPO/README.md"
git -C "$DEMO_REPO" add . >/dev/null
git -C "$DEMO_REPO" commit -q -m "init"

HASH_DIR="$DEMO_HOME/.agent-orchestrator/aaaaaa000000-myproject"
mkdir -p "$HASH_DIR/sessions" "$HASH_DIR/worktrees"

# Seed a V1 session with a populated agent report + report-watcher state.
# This exercises the @ashish921998 fix (flat keys must survive migration).
LIFECYCLE_PAYLOAD='{"version":2,"session":{"kind":"worker","state":"working"},"runtime":{"state":"missing","reason":"manual_kill_requested"},"pr":{"state":"unknown"}}'
cat >"$HASH_DIR/sessions/ao-1" <<V1META
project=myproject
agent=claude-code
status=working
createdAt=2026-04-21T12:00:00.000Z
agentReportedState=needs_input
agentReportedAt=2026-04-21T12:35:00.000Z
agentReportedNote=please clarify the spec
reportWatcherTriggerCount=2
reportWatcherActiveTrigger=stale_report
reportWatcherLastAuditedAt=2026-04-21T12:34:00.000Z
prAutoDetect=on
dashboardPort=3000
branch=session/ao-1
worktree=$DEMO_REPO/worktrees/ao-1
statePayload=$LIFECYCLE_PAYLOAD
stateVersion=2
V1META

# A second session in V1 archive form, to exercise the archive-flatten path.
mkdir -p "$HASH_DIR/archive/ao-2_20260420T100000Z"
cat >"$HASH_DIR/archive/ao-2_20260420T100000Z/metadata" <<'V1META'
project=myproject
agent=claude-code
status=killed
createdAt=2026-04-20T08:00:00.000Z
branch=session/ao-2
V1META

# Pre-seed the global config the migrator reads.
cat >"$DEMO_HOME/.agent-orchestrator/config.yaml" <<CFG
port: $DEMO_PORT
defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: []
projects:
  myproject:
    projectId: myproject
    path: $DEMO_REPO
    repo:
      owner: demo
      name: myproject
      platform: github
      originUrl: https://github.com/demo/myproject
    defaultBranch: main
    source: ao-project-add
    registeredAt: 1776000000
    displayName: myproject
    sessionPrefix: my
    storageKey: aaaaaa000000
CFG

step "Before — V1 layout on disk"
ls -1 "$DEMO_HOME/.agent-orchestrator/" | sed 's/^/  /'
echo
echo "  Session metadata format (key=value, flat strings):"
sed 's/^/    /' "$HASH_DIR/sessions/ao-1"
sleep 4

step "ao migrate-storage --dry-run  (shows the plan, mutates nothing)"
ao migrate-storage --dry-run --force || true
sleep 3

step "ao migrate-storage  (atomic per-project, with rollback on failure)"
ao migrate-storage --force
sleep 2

step "After — V2 layout (projects/{projectId}/sessions/{sid}.json)"
echo "  Top level:"
ls -1 "$DEMO_HOME/.agent-orchestrator/" | sed 's/^/    /'
echo
MIGRATED_PROJECT=$(ls "$DEMO_HOME/.agent-orchestrator/projects/" | grep -v '\.migrated$' | head -1)
SESSION_JSON="$DEMO_HOME/.agent-orchestrator/projects/$MIGRATED_PROJECT/sessions/ao-1.json"
echo "  projects/$MIGRATED_PROJECT/:"
(cd "$DEMO_HOME/.agent-orchestrator/projects/$MIGRATED_PROJECT" && find . -maxdepth 2 -mindepth 1) \
  | sed 's|^\./|    |'
sleep 3

step "Migrated session JSON (note: typed fields, no key=value soup)"
node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('$SESSION_JSON', 'utf-8'));
const out = {
  branch: d.branch, status: d.status, agent: d.agent, prAutoDetect: d.prAutoDetect,
  dashboard: d.dashboard, lifecycle: d.lifecycle ? '(...)' : undefined,
  agentReportedState: d.agentReportedState,
  agentReportedAt: d.agentReportedAt,
  agentReportedNote: d.agentReportedNote,
  reportWatcherTriggerCount: d.reportWatcherTriggerCount,
  reportWatcherActiveTrigger: d.reportWatcherActiveTrigger,
  agentReport_nested_wrapper: d.agentReport ?? '(undefined — correct)',
  reportWatcher_nested_wrapper: d.reportWatcher ?? '(undefined — correct)',
};
console.log(JSON.stringify(out, null, 2).split('\n').map(l => '    ' + l).join('\n'));
"
sleep 4

step "Verify @ashish921998 fix: agent-report keys stayed FLAT after migration"
note "Live runtime readers (parseExistingAgentReport, lifecycle-manager)"
note "look up flat keys on session.metadata. readMetadataRaw → flattenToStringRecord"
note "does NOT unfold nested objects, so a nested agentReport.* would silently"
note "drop this state. Migration keeps these flat — proven below:"
echo
node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('$SESSION_JSON', 'utf-8'));
const required = [
  'agentReportedState', 'agentReportedAt', 'agentReportedNote',
  'reportWatcherTriggerCount', 'reportWatcherActiveTrigger',
];
let ok = true;
for (const k of required) {
  const present = d[k] !== undefined;
  console.log('    ' + (present ? '✓' : '✗') + ' ' + k + ' = ' + (d[k] ?? 'MISSING'));
  if (!present) ok = false;
}
if (d.agentReport !== undefined || d.reportWatcher !== undefined) {
  console.log('    ✗ nested wrapper present — would shadow flat keys via flattenToStringRecord');
  ok = false;
}
console.log();
console.log('    ' + (ok ? 'PASS' : 'FAIL') + ' — agent-report flat-key contract preserved');
"
sleep 5

step "Rollback safety: re-running migration is a no-op (markers prevent re-process)"
ao migrate-storage --force 2>&1 | tail -5
sleep 3

# ───────────────────────────────────────────────────────────────────────────
banner "Act 2 — Cross-project CLI (the P1 review fix)"
# ───────────────────────────────────────────────────────────────────────────

note "Behavior under test:"
note "  1. ao start (project=A)            → running.json {pid, projects:[A]}"
note "  2. ao stop A                       → projects:[]            (parent alive)"
note "  3. ao start A                      → projects:[A] same pid  (ATTACH, no 2nd daemon)"
note ""
note "Pre-fix: step 3 fell through to runStartup() → spawned a SECOND dashboard"
note "on a new port, clobbered running.json. Reproduced and fixed in commit bfc7f48f."
sleep 3

step "The regression test that asserts no second daemon is registered"
echo
sed -n '/attaches to existing daemon (no second dashboard)/,/^  });$/p' \
  "$AO_REPO/packages/cli/__tests__/commands/start.test.ts" \
  | head -50 | sed 's/^/    /'
sleep 5

step "Run the test live (filtered by test name via vitest -t)"
(cd "$AO_REPO" && pnpm --filter @aoagents/ao-cli test -- start.test.ts -t "attaches to existing daemon" 2>&1 \
  | grep -E "✓|✗|FAIL|Test Files|^\s*Tests " | head -10 | sed 's/^/    /') || true
sleep 3

step "removeProjectFromRunning + addProjectToRunning are the round-trip primitives"
echo
grep -n "export async function \(removeProjectFromRunning\|addProjectToRunning\)" \
  "$AO_REPO/packages/cli/src/lib/running-state.ts" | sed 's/^/    /'
sleep 3

# ───────────────────────────────────────────────────────────────────────────
banner "Act 3 — Dashboard sidebar shows ALL projects regardless of route"
# ───────────────────────────────────────────────────────────────────────────

note "useSessionEvents on the dashboard is now called WITHOUT a project filter."
note "Per-project filtering happens client-side via the projectSessions memo."
sleep 2

step "The fix in Dashboard.tsx"
grep -B 1 -A 7 "No project filter — sidebar needs all sessions" \
  "$AO_REPO/packages/web/src/components/Dashboard.tsx" 2>/dev/null \
  | sed 's/^/    /' || note "(see commit 53e8476f)"
sleep 4

# ───────────────────────────────────────────────────────────────────────────
banner "Act 4 — Restore from ao stop  (last-stop.json round-trip)"
# ───────────────────────────────────────────────────────────────────────────

step "Simulate what ao stop writes to last-stop.json"
cat >"$DEMO_HOME/.agent-orchestrator/last-stop.json" <<JSON
{
  "stoppedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "projectId": "$MIGRATED_PROJECT",
  "sessionIds": ["ao-1"],
  "otherProjects": []
}
JSON
echo
sed 's/^/    /' "$DEMO_HOME/.agent-orchestrator/last-stop.json"
sleep 3

step "What ao start does with it (start.ts)"
echo
grep -n "readLastStop\|Restore .* sessions" \
  "$AO_REPO/packages/cli/src/commands/start.ts" | head -6 | sed 's/^/    /'
sleep 3

step "Cross-project sessions in the prompt — otherProjects field"
echo
grep -n "otherProjects" \
  "$AO_REPO/packages/cli/src/lib/running-state.ts" \
  "$AO_REPO/packages/cli/src/commands/start.ts" | head -6 | sed 's/^/    /'
sleep 3

# ───────────────────────────────────────────────────────────────────────────
banner "Act 5 — Ctrl+C performs a full graceful shutdown (no tmux orphans)"
# ───────────────────────────────────────────────────────────────────────────

note "SIGINT/SIGTERM handler in start.ts mirrors ao stop:"
note "  kill all sessions → write last-stop.json → unregister → process.exit"
note "  10s hard timeout via setTimeout().unref() in case cleanup hangs."
sleep 2

step "The shutdown handler"
echo
grep -n "shutdown.*signal: NodeJS.Signals\|10s hard timeout\|SHUTDOWN_TIMEOUT_MS" \
  "$AO_REPO/packages/cli/src/commands/start.ts" | head -10 | sed 's/^/    /'
sleep 3

# ───────────────────────────────────────────────────────────────────────────
banner "Act 6 — Empty-repo guard for ao start <URL>"
# ───────────────────────────────────────────────────────────────────────────

note "Before fix: empty repos caused 'Unable to resolve base ref' deep inside"
note "the worktree plugin. Now we detect via origin/HEAD and fail early with"
note "a useful message before ensureOrchestrator runs."
sleep 2

step "The detection helper + the early-exit message"
echo
sed -n '/detectClonedRepoDefaultBranch/,/^}/p' \
  "$AO_REPO/packages/cli/src/commands/start.ts" \
  | head -25 | sed 's/^/    /'
echo
grep -B 1 -A 4 "appears to be empty (no commits or refs)" \
  "$AO_REPO/packages/cli/src/commands/start.ts" | head -10 | sed 's/^/    /'
sleep 5

# ───────────────────────────────────────────────────────────────────────────
banner "Test summary: 560 CLI + 981 core (last full run)"
# ───────────────────────────────────────────────────────────────────────────

# Restore the real HOME and unset sandbox env vars when running the full
# test suites — otherwise tests that read getGlobalConfigPath() see the
# demo's sparse config and fail spuriously.
step "pnpm --filter @aoagents/ao-cli test"
(cd "$AO_REPO" && env -u AO_GLOBAL_CONFIG HOME="$REAL_HOME" pnpm --filter @aoagents/ao-cli test 2>&1 \
  | grep -E "^\s*(Tests|Test Files|Duration)" | sed 's/^/    /') || true

step "pnpm --filter @aoagents/ao-core test"
(cd "$AO_REPO" && env -u AO_GLOBAL_CONFIG HOME="$REAL_HOME" pnpm --filter @aoagents/ao-core test 2>&1 \
  | grep -E "^\s*(Tests|Test Files|Duration)" | sed 's/^/    /') || true

# ───────────────────────────────────────────────────────────────────────────
banner "Demo complete — sandbox left in $DEMO_HOME for inspection"
# ───────────────────────────────────────────────────────────────────────────

note "To re-run:    scripts/demo-pr-1466.sh"
note "To clean:     rm -rf $DEMO_HOME"
note ""
note "Reviewer next steps:"
note "  • Inspect $DEMO_HOME/.agent-orchestrator/ to verify V2 shape"
note "  • Diff against base:   git diff origin/main...storage-redesign"
note "  • Visual spec:         pr-1466.html"
note "  • Behavior dashboard:  https://theharshitsingh.com/static/pr-1466.html"
echo
