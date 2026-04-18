#!/usr/bin/env bash
# real-benchmark.sh — Run a benchmark with real Claude Code agents.
#
# This script:
#   1. Starts AO with tracing enabled
#   2. Spawns N sessions from open GitHub issues
#   3. Monitors until sessions reach terminal states or time cap
#   4. Produces a trace file and summary
#
# Usage:
#   ./experiments/real-benchmark.sh \
#     --project-dir /path/to/todo-app \
#     --sessions 5 \
#     --timeout 30m
#
# Prerequisites:
#   - AO built (`pnpm build` in the AO repo)
#   - `ao` CLI available in PATH
#   - The project's agent-orchestrator.yaml configured
#   - GitHub issues exist on the repo (use seed-issues.sh first)
#   - `ao start` NOT already running (this script starts it)

set -euo pipefail

PROJECT_DIR=""
SESSIONS=5
TIMEOUT_MIN=30
AO_REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="benchmark"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --sessions)    SESSIONS="$2"; shift 2 ;;
    --timeout)     TIMEOUT_MIN="${2%m}"; shift 2 ;;  # strip trailing 'm' if present
    --label)       LABEL="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$PROJECT_DIR" ]; then
  echo "Usage: $0 --project-dir /path/to/project [--sessions N] [--timeout Nm]" >&2
  exit 1
fi

TIMESTAMP=$(date +%s)
TRACE_FILE="$AO_REPO_DIR/experiments/out/gh-trace-real-$TIMESTAMP.jsonl"
SUMMARY_FILE="$AO_REPO_DIR/experiments/out/real-benchmark-$TIMESTAMP.txt"

mkdir -p "$AO_REPO_DIR/experiments/out"

echo "═══════════════════════════════════════════════════════════"
echo "  Real-Agent Benchmark"
echo "  Project: $PROJECT_DIR"
echo "  Sessions: $SESSIONS"
echo "  Timeout: ${TIMEOUT_MIN}m"
echo "  Trace: $TRACE_FILE"
echo "  Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "═══════════════════════════════════════════════════════════"

# --- Step 1: Find issues to assign ---
echo ""
echo "[1/5] Finding open issues..."

# Extract repo from agent-orchestrator.yaml
REPO=$(grep -A5 'projects:' "$PROJECT_DIR/agent-orchestrator.yaml" | grep 'repo:' | head -1 | awk '{print $2}')
if [ -z "$REPO" ]; then
  echo "ERROR: Could not find repo in $PROJECT_DIR/agent-orchestrator.yaml" >&2
  exit 1
fi

# Get open issue numbers (prefer labeled ones, fall back to all)
ISSUE_NUMBERS=$(gh issue list --repo "$REPO" --state open --label "$LABEL" --json number --jq '.[].number' 2>/dev/null | head -"$SESSIONS")
if [ -z "$ISSUE_NUMBERS" ]; then
  echo "  No issues with label '$LABEL', trying all open issues..."
  ISSUE_NUMBERS=$(gh issue list --repo "$REPO" --state open --json number --jq '.[].number' 2>/dev/null | head -"$SESSIONS")
fi

AVAILABLE=$(echo "$ISSUE_NUMBERS" | wc -l | tr -d ' ')
echo "  Found $AVAILABLE open issues (requested $SESSIONS)"

if [ "$AVAILABLE" -lt "$SESSIONS" ]; then
  echo "  WARNING: Only $AVAILABLE issues available, will spawn $AVAILABLE sessions instead"
  SESSIONS="$AVAILABLE"
fi

if [ "$SESSIONS" -eq 0 ]; then
  echo "ERROR: No issues available to spawn sessions for." >&2
  echo "Run: ./experiments/seed-issues.sh --repo $REPO --count 10" >&2
  exit 1
fi

# --- Step 2: Capture rate limit before ---
echo ""
echo "[2/5] Capturing rate limit snapshot (before)..."

RATE_BEFORE=$(gh api rate_limit 2>/dev/null)
GRAPHQL_BEFORE=$(echo "$RATE_BEFORE" | python3 -c "import sys,json; r=json.load(sys.stdin)['resources']['graphql']; print(f\"remaining={r['remaining']} used={r['used']} limit={r['limit']}\")")
CORE_BEFORE=$(echo "$RATE_BEFORE" | python3 -c "import sys,json; r=json.load(sys.stdin)['resources']['core']; print(f\"remaining={r['remaining']} used={r['used']} limit={r['limit']}\")")
echo "  GraphQL: $GRAPHQL_BEFORE"
echo "  Core:    $CORE_BEFORE"

# --- Step 3: Ensure AO is running with tracing, then spawn sessions ---
echo ""
echo "[3/5] Spawning $SESSIONS sessions..."
echo ""
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │ IMPORTANT: AO must be running WITH tracing enabled.     │"
echo "  │ In another terminal, run:                                │"
echo "  │                                                          │"
echo "  │   cd $PROJECT_DIR"
echo "  │   AO_GH_TRACE_FILE=$TRACE_FILE ao start"
echo "  │                                                          │"
echo "  │ Press Enter here once AO is running...                   │"
echo "  └─────────────────────────────────────────────────────────┘"
read -r

SPAWNED_IDS=()
IDX=0
for ISSUE in $ISSUE_NUMBERS; do
  IDX=$((IDX + 1))
  if [ "$IDX" -gt "$SESSIONS" ]; then break; fi

  echo "  Spawning session for issue #$ISSUE ($IDX/$SESSIONS)..."
  # Run from the project dir so AO auto-detects the project
  SESSION_LINE=$(cd "$PROJECT_DIR" && ao spawn "$ISSUE" 2>&1 | grep "^SESSION=" || true)
  SESSION_ID="${SESSION_LINE#SESSION=}"
  if [ -n "$SESSION_ID" ]; then
    SPAWNED_IDS+=("$SESSION_ID")
    echo "    ✓ $SESSION_ID"
  else
    echo "    ✗ Failed to spawn for issue #$ISSUE"
  fi
  sleep 2  # stagger spawns slightly
done

echo ""
echo "  Spawned ${#SPAWNED_IDS[@]} sessions: ${SPAWNED_IDS[*]}"

# --- Step 4: Monitor until done or timeout ---
echo ""
echo "[4/5] Monitoring sessions (timeout: ${TIMEOUT_MIN}m)..."
echo "  Checking every 30s for terminal states..."

START_TIME=$(date +%s)
END_TIME=$((START_TIME + TIMEOUT_MIN * 60))
CHECK_INTERVAL=30

while true; do
  NOW=$(date +%s)
  ELAPSED=$(( (NOW - START_TIME) / 60 ))

  if [ "$NOW" -ge "$END_TIME" ]; then
    echo ""
    echo "  ⏰ Timeout reached (${TIMEOUT_MIN}m). Stopping monitor."
    break
  fi

  # Check session statuses
  DONE_COUNT=0
  ACTIVE_COUNT=0
  STATUS_SUMMARY=""

  for SID in "${SPAWNED_IDS[@]}"; do
    # Read status from session metadata
    STATUS=$(cd "$PROJECT_DIR" && ao status 2>/dev/null | grep "$SID" | awk '{print $NF}' || echo "unknown")
    STATUS_SUMMARY="$STATUS_SUMMARY $SID=$STATUS"

    case "$STATUS" in
      merged|done|killed|stuck|terminated)
        DONE_COUNT=$((DONE_COUNT + 1))
        ;;
      *)
        ACTIVE_COUNT=$((ACTIVE_COUNT + 1))
        ;;
    esac
  done

  echo "  [${ELAPSED}m] Active: $ACTIVE_COUNT | Done: $DONE_COUNT / ${#SPAWNED_IDS[@]}"

  if [ "$DONE_COUNT" -ge "${#SPAWNED_IDS[@]}" ]; then
    echo ""
    echo "  ✓ All sessions reached terminal state!"
    break
  fi

  sleep "$CHECK_INTERVAL"
done

# --- Step 5: Capture rate limit after + produce summary ---
echo ""
echo "[5/5] Capturing results..."

RATE_AFTER=$(gh api rate_limit 2>/dev/null)
GRAPHQL_AFTER=$(echo "$RATE_AFTER" | python3 -c "import sys,json; r=json.load(sys.stdin)['resources']['graphql']; print(f\"remaining={r['remaining']} used={r['used']} limit={r['limit']}\")")
CORE_AFTER=$(echo "$RATE_AFTER" | python3 -c "import sys,json; r=json.load(sys.stdin)['resources']['core']; print(f\"remaining={r['remaining']} used={r['used']} limit={r['limit']}\")")

TOTAL_TIME=$(( ($(date +%s) - START_TIME) / 60 ))
TRACE_ROWS=0
if [ -f "$TRACE_FILE" ]; then
  TRACE_ROWS=$(wc -l < "$TRACE_FILE" | tr -d ' ')
fi

# Write summary
cat <<SUMMARY | tee "$SUMMARY_FILE"

═══════════════════════════════════════════════════════════
  Real-Agent Benchmark Results
  $(date -u +%Y-%m-%dT%H:%M:%SZ)
═══════════════════════════════════════════════════════════

  Sessions:     $SESSIONS (real Claude Code agents)
  Duration:     ${TOTAL_TIME}m
  Repo:         $REPO

  Rate Limits:
    GraphQL before: $GRAPHQL_BEFORE
    GraphQL after:  $GRAPHQL_AFTER
    Core before:    $CORE_BEFORE
    Core after:     $CORE_AFTER

  Trace:
    File:           $TRACE_FILE
    Rows:           $TRACE_ROWS

  Session IDs:
$(for SID in "${SPAWNED_IDS[@]}"; do echo "    - $SID"; done)

═══════════════════════════════════════════════════════════

Next steps:
  1. Analyze the trace:
     node experiments/benchmark.mjs report \\
       --trace $TRACE_FILE \\
       --scenario real-agents.single-repo.$SESSIONS

  2. Or use Python for detailed analysis:
     python3 -c "
import json
rows = [json.loads(l) for l in open('$TRACE_FILE')]
print(f'Total calls: {len(rows)}')
ops = {}
for r in rows:
    op = r.get('operation','?')
    ops[op] = ops.get(op,0) + 1
for op,n in sorted(ops.items(), key=lambda x:-x[1]):
    print(f'  {op}: {n}')
"
SUMMARY

echo ""
echo "Done!"
