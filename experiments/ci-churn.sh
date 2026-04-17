#!/usr/bin/env bash
# ci-churn.sh — Push empty commits to PRs during a benchmark measurement window.
#
# Usage:
#   ./experiments/ci-churn.sh --sessions 10 --interval 60 --duration 900 [--delay 0]
#
# This pushes an empty commit to each of the first N session worktrees,
# one every INTERVAL seconds, cycling through them repeatedly for DURATION seconds.
# Each push invalidates the ETag cache for that PR's commit status,
# forcing a full graphql-batch re-fetch on the next poll cycle.
#
# Run this in PARALLEL with the benchmark's measurement window.
# Use --delay to wait before starting (e.g., to skip warmup).

set -euo pipefail

WORKTREE_BASE="$HOME/.worktrees/todo-app"
SESSIONS=10
INTERVAL=60
DURATION=900
DELAY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sessions)  SESSIONS="$2"; shift 2 ;;
    --interval)  INTERVAL="$2"; shift 2 ;;
    --duration)  DURATION="$2"; shift 2 ;;
    --delay)     DELAY="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

echo "[ci-churn] Config: sessions=$SESSIONS interval=${INTERVAL}s duration=${DURATION}s delay=${DELAY}s"

if [ "$DELAY" -gt 0 ]; then
  echo "[ci-churn] Waiting ${DELAY}s before starting..."
  sleep "$DELAY"
fi

START=$(date +%s)
END=$((START + DURATION))
PUSH_COUNT=0
SESSION_IDX=1

echo "[ci-churn] Started at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

while [ "$(date +%s)" -lt "$END" ]; do
  WORKTREE="$WORKTREE_BASE/ta-$SESSION_IDX"

  if [ -d "$WORKTREE/.git" ] || [ -f "$WORKTREE/.git" ]; then
    echo "[ci-churn] Pushing empty commit to ta-$SESSION_IDX..."
    (
      cd "$WORKTREE"
      git commit --allow-empty -m "bench: ci-churn push $PUSH_COUNT ($(date -u +%H:%M:%S))" 2>/dev/null
      git push origin HEAD 2>/dev/null
    ) && echo "[ci-churn] ✓ ta-$SESSION_IDX pushed" \
      || echo "[ci-churn] ✗ ta-$SESSION_IDX failed"
    PUSH_COUNT=$((PUSH_COUNT + 1))
  else
    echo "[ci-churn] ✗ ta-$SESSION_IDX worktree not found, skipping"
  fi

  # Cycle through sessions
  SESSION_IDX=$((SESSION_IDX + 1))
  if [ "$SESSION_IDX" -gt "$SESSIONS" ]; then
    SESSION_IDX=1
  fi

  # Wait for next interval (but check if we've exceeded duration)
  REMAINING=$((END - $(date +%s)))
  if [ "$REMAINING" -gt "$INTERVAL" ]; then
    sleep "$INTERVAL"
  elif [ "$REMAINING" -gt 0 ]; then
    sleep "$REMAINING"
  fi
done

echo "[ci-churn] Done. Total pushes: $PUSH_COUNT over ${DURATION}s"
