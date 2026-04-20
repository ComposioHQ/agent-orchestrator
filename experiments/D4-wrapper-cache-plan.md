# D4 Wrapper Cache Implementation Plan

## Scope

Two intercepts only, targeting the two largest agent-side waste buckets from the D4 analysis:

| Pattern | D4 count (10-session run) | % of agent-side traffic |
|---------|--------------------------|------------------------|
| `gh pr list --repo R --head B --json ... --limit 1` | 598 | 65.3% |
| `gh issue view N --json ...` | 75 | 8.2% |

Combined: **673 / 916 = 73.5%** of all agent-side `gh` calls.

Everything else passes through unchanged.

---

## Storage

### Location

```
$AO_DATA_DIR/.ghcache/$AO_SESSION/
```

- `$AO_DATA_DIR` = sessions directory (already available in agent env)
- `$AO_SESSION` = session ID (already available in agent env)
- `.ghcache` is invisible to `listMetadata()` (`metadata.ts:366` filters `name.startsWith(".")`)

### File format

Each cache entry = two files:

```
{key}.stdout   # exact gh stdout (byte-identical to what real gh returned)
{key}.ts       # single line: epoch seconds when entry was written
```

Example:

```
$AO_DATA_DIR/.ghcache/issue-30-fix/
  pr-discovery-feat--issue-30.stdout     # [{"number":57,"url":"...","title":"..."}]
  pr-discovery-feat--issue-30.ts         # 1713567890
  issue-ctx-31.stdout                    # {"number":31,"title":"...","body":"..."}
  issue-ctx-31.ts                        # 1713567850
```

### Why two files instead of embedding timestamp

The `.stdout` file is returned to the agent as-is via `cat`. No parsing, no stripping, no risk of corrupting JSON output. The `.ts` file is a one-line epoch used only by the cache-freshness check.

---

## Intercept 1: PR Discovery

### What agents are doing

From D4 traces, every agent session repeatedly runs:

```
gh pr list --repo iamasx/api-test --head feat/issue-X --json number,url,title,headRefName,baseRefName,isDraft --limit 1
```

The 10-session run showed:

- 75 identical calls for `feat/issue-30`
- 74 identical calls for `feat/issue-27`
- 74 identical calls for `feat/issue-26`
- 73 identical calls for `feat/issue-22`
- ...

Once branch `feat/issue-30` has PR #57, that answer never changes. Yet the agent keeps asking.

### Match conditions

ALL must be true:

- `$1` = `pr`, `$2` = `list`
- `--head <branch>` flag present
- `--limit 1` present
- None of these flags present: `--search`, `--state`, `--assignee`, `--label`, `--jq`, `--template`

If any condition fails → passthrough to real `gh`.

### Cache key

```
pr-discovery-{sanitized_branch}
```

Where `sanitized_branch` = `--head` value with non-alphanumeric chars (except `.`, `_`, `-`) replaced by `-`:

```bash
safe_branch=$(printf '%s' "$head_val" | tr -c 'a-zA-Z0-9._-' '-')
```

### TTL

- **Positive result** (non-empty JSON array, i.e., stdout is not `[]`): **infinite** within session.
- **Negative result** (`[]` or empty): **not cached**. The PR might be created at any moment.

### Cache-read flow

```
1. Parse args, extract --head value and --repo value
2. Compute cache_key = "pr-discovery-{safe_branch}"
3. If cache file exists (positive = infinite TTL):
     cat "$cache_dir/$cache_key.stdout"
     exit 0
4. Else:
     call real gh, capture stdout to tmpfile
     if exit_code == 0 AND stdout is not "[]" and not empty:
       write tmpfile → $cache_dir/$cache_key.stdout
       write epoch  → $cache_dir/$cache_key.ts
     cat tmpfile
     exit $exit_code
```

### Integration with `gh pr create` write intercept

The existing `pr/create` intercept (wrapper lines 212-244) already captures the PR URL and number after a successful `gh pr create`. Extend it to also populate the PR discovery cache:

After the existing metadata writes:

```bash
# Populate PR discovery cache so subsequent gh pr list --head hits cache
_branch="$(read_ao_metadata branch)"
if [[ -n "$_branch" && -n "$pr_url" && -n "$pr_number" ]]; then
  _safe_branch=$(printf '%s' "$_branch" | tr -c 'a-zA-Z0-9._-' '-')
  _cache_key="pr-discovery-${_safe_branch}"
  _cache_dir="$(ao_cache_dir)"
  if [[ -n "$_cache_dir" ]]; then
    # Write a minimal but valid gh pr list JSON response.
    # Contains only the fields we know. If the agent later asks for
    # fields not present here, those fields will be null/missing in
    # the cached response. This is acceptable because:
    # - The most common query shape includes these exact fields
    # - Any missing-field issue self-corrects on the next real call
    #   if the agent retries or asks for different fields
    _draft_val="${report_draft:-false}"
    printf '[{"number":%s,"url":"%s","headRefName":"%s","isDraft":%s}]\n' \
      "$pr_number" "$pr_url" "$_branch" "$_draft_val" \
      > "$_cache_dir/${_cache_key}.stdout.tmp.$$"
    mv "$_cache_dir/${_cache_key}.stdout.tmp.$$" "$_cache_dir/${_cache_key}.stdout"
    date +%s > "$_cache_dir/${_cache_key}.ts"
  fi
fi
```

This means: the moment `gh pr create` succeeds, the very next `gh pr list --head` for that branch hits cache with zero API calls.

### Projected reduction

From D4 10-session data: 598 calls → ~10 (one real call per session, the first discovery). **~588 calls eliminated (98%).**

---

## Intercept 2: Issue Context

### What agents are doing

From D4 traces, agents repeatedly fetch the same issue:

```
gh issue view 31 --json number,title,body,state,labels,assignees
```

- issue 31 viewed 9 times
- issue 30 viewed 9 times
- issue 29 viewed 9 times
- issues 28, 27, 26, 24, 23, 22 viewed 7 times each
- issue 25 viewed 6 times

Issue metadata (title, body, labels) does not change during a typical agent work session. Fetching once is sufficient.

### Match conditions

ALL must be true:

- `$1` = `issue`, `$2` = `view`
- Third positional arg is a number (the issue identifier)
- None of these flags present: `--web`, `--comments`, `--jq`, `--template`

If any condition fails → passthrough.

### Cache key

```
issue-ctx-{issue_id}
```

The issue ID is the numeric identifier extracted from the positional arg. No sanitization needed (it's a number).

### TTL

**300 seconds (5 minutes).** Issue content can change externally (someone edits the title or adds a label), but this is rare during an active agent session. A 5-minute window is conservative enough to avoid serving truly stale data while eliminating most repeated fetches.

### Cache-read flow

```
1. Parse args, extract issue ID (first positional arg after "issue view")
2. Compute cache_key = "issue-ctx-{issue_id}"
3. If cache file exists AND age < 300 seconds:
     cat "$cache_dir/$cache_key.stdout"
     exit 0
4. Else:
     call real gh, capture stdout to tmpfile
     if exit_code == 0:
       write tmpfile → $cache_dir/$cache_key.stdout
       write epoch  → $cache_dir/$cache_key.ts
     cat tmpfile
     exit $exit_code
```

### Age check

```bash
ao_cache_fresh() {
  local cache_key="$1" max_age="$2"
  local cache_dir
  cache_dir="$(ao_cache_dir)" || return 1
  local ts_file="$cache_dir/${cache_key}.ts"
  local stdout_file="$cache_dir/${cache_key}.stdout"

  [[ -f "$stdout_file" && -f "$ts_file" ]] || return 1

  # max_age=0 means infinite TTL
  [[ "$max_age" -eq 0 ]] && return 0

  local cached_ts now
  cached_ts=$(cat "$ts_file" 2>/dev/null) || return 1
  now=$(date +%s)
  (( now - cached_ts < max_age ))
}
```

### Projected reduction

From D4 10-session data: 75 calls → ~20 (one real call per issue per 5-minute window). **~55 calls eliminated (73%).**

---

## Helper Functions

Added to `AO_METADATA_HELPER` (sourced by both `gh` and `git` wrappers):

### `read_ao_metadata()`

```bash
read_ao_metadata() {
  local key="$1"
  local ao_dir="${AO_DATA_DIR:-}"
  local ao_session="${AO_SESSION:-}"

  [[ -z "$ao_dir" || -z "$ao_session" ]] && return 1

  case "$ao_session" in */* | *..*) return 1 ;; esac
  case "$ao_dir" in
    "$HOME"/.ao/* | "$HOME"/.agent-orchestrator/* | /tmp/*) ;;
    *) return 1 ;;
  esac

  local metadata_file="$ao_dir/$ao_session"
  [[ -f "$metadata_file" ]] || return 1
  [[ "$key" =~ ^[a-zA-Z0-9_-]+$ ]] || return 1

  local line
  line=$(grep "^${key}=" "$metadata_file" 2>/dev/null | head -1) || return 1
  printf '%s' "${line#*=}"
}
```

### `ao_cache_dir()`

```bash
ao_cache_dir() {
  local ao_dir="${AO_DATA_DIR:-}"
  local ao_session="${AO_SESSION:-}"

  [[ -z "$ao_dir" || -z "$ao_session" ]] && return 1

  case "$ao_session" in */* | *..*) return 1 ;; esac
  case "$ao_dir" in
    "$HOME"/.ao/* | "$HOME"/.agent-orchestrator/* | /tmp/*) ;;
    *) return 1 ;;
  esac

  local d="$ao_dir/.ghcache/$ao_session"
  mkdir -p "$d" 2>/dev/null || return 1
  printf '%s' "$d"
}
```

### `ao_cache_fresh()`

As defined in the issue-context section above.

### `ao_cache_read()`

```bash
ao_cache_read() {
  local cache_key="$1"
  local cache_dir
  cache_dir="$(ao_cache_dir)" || return 1
  cat "$cache_dir/${cache_key}.stdout"
}
```

### `ao_cache_write()`

```bash
# Stdin is piped in. Writes atomically.
ao_cache_write() {
  local cache_key="$1"
  local cache_dir
  cache_dir="$(ao_cache_dir)" || return 1
  local tmp="$cache_dir/${cache_key}.stdout.tmp.$$"
  cat > "$tmp" && mv "$tmp" "$cache_dir/${cache_key}.stdout"
  date +%s > "$cache_dir/${cache_key}.ts"
}
```

---

## New Wrapper Structure

The `GH_WRAPPER` dispatch changes from:

```bash
# Current:
log_gh_invocation "$@"
case "$1/$2" in
  pr/create) ... ;;
  *) exec "$real_gh" "$@" ;;
esac
```

To:

```bash
log_gh_invocation "$@"

# ── Cacheable reads ──────────────────────────────────────

# 1. PR discovery: gh pr list --head <B> --limit 1
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  <parse args, check match conditions>
  if <matched>; then
    cache_key="pr-discovery-${safe_branch}"
    if ao_cache_fresh "$cache_key" 0; then
      ao_cache_read "$cache_key"
      exit 0
    fi
    <call real gh, capture stdout>
    if [[ $exit_code -eq 0 ]] && <stdout is not empty/[]>; then
      <write to cache>
    fi
    <output stdout>
    exit $exit_code
  fi
fi

# 2. Issue context: gh issue view <N> --json ...
if [[ "$1" == "issue" && "$2" == "view" ]]; then
  <parse args, check match conditions>
  if <matched>; then
    cache_key="issue-ctx-${issue_id}"
    if ao_cache_fresh "$cache_key" 300; then
      ao_cache_read "$cache_key"
      exit 0
    fi
    <call real gh, capture stdout>
    if [[ $exit_code -eq 0 ]]; then
      <write to cache>
    fi
    <output stdout>
    exit $exit_code
  fi
fi

# ── Write intercepts (existing, enhanced) ────────────────

case "$1/$2" in
  pr/create)
    <existing pr create logic>
    <NEW: populate pr-discovery cache after success>
    exit $exit_code
    ;;
  *)
    exec "$real_gh" "$@"
    ;;
esac
```

---

## Session-Manager Changes

### Make PATH wrappers universal for all agents

**`packages/core/src/session-manager.ts`**

At the `setupWorkspaceHooks` call site (~line 1524), add wrapper installation:

```typescript
// Setup agent hooks for automatic metadata updates
try {
  if (plugins.agent.setupWorkspaceHooks) {
    await plugins.agent.setupWorkspaceHooks(workspacePath, { dataDir: sessionsDir });
  }
  // Always install shared wrappers — every agent gets gh/git interception
  await setupPathWrapperWorkspace(workspacePath);
} catch (err) {
  await cleanupWorktreeAndMetadata();
  throw err;
}
```

At all 3 `runtime.create()` sites (lines ~1257, ~1608, ~2697), inject PATH and GH_PATH after the agent environment spread:

```typescript
environment: {
  ...environment,
  PATH: buildAgentPath(environment["PATH"] ?? process.env["PATH"]),
  GH_PATH: PREFERRED_GH_PATH,
  AO_SESSION: sessionId,
  AO_DATA_DIR: sessionsDir,
  // ... rest unchanged
},
```

### Remove per-plugin boilerplate

Remove `buildAgentPath()` and `setupPathWrapperWorkspace()` calls from:

- `packages/plugins/agent-codex/src/index.ts`
- `packages/plugins/agent-aider/src/index.ts`
- `packages/plugins/agent-opencode/src/index.ts`
- `packages/plugins/agent-cursor/src/index.ts`

These plugins no longer need to import or call these functions. The session manager handles it.

### Bump wrapper version

`packages/core/src/agent-workspace-hooks.ts:35`:

```typescript
const WRAPPER_VERSION = "0.4.0";
```

Existing workspaces auto-refresh when the version marker doesn't match.

---

## Cache Cleanup

### On session delete/archive

In `deleteMetadata()` (`metadata.ts:263`), add cleanup of the session's cache directory:

```typescript
// Clean up gh cache for this session
const cachePath = join(dataDir, ".ghcache", sessionId);
try { rmSync(cachePath, { recursive: true, force: true }); } catch { /* best effort */ }
```

### No cross-session leakage

Each session has its own cache subdirectory keyed by `$AO_SESSION`. A restored session gets a fresh directory. No stale data from previous runs.

---

## Safety

| Scenario | Handling |
|----------|---------|
| `$AO_DATA_DIR` or `$AO_SESSION` unset | All cache functions return 1 (failure). Wrapper falls through to real `gh`. Agent sees no difference. |
| Cache directory creation fails (permissions, disk full) | `ao_cache_dir` returns 1. Cache write silently skipped. Real `gh` is called. |
| `gh pr list --head` returns `[]` (no PR yet) | Not cached. Every subsequent call goes to real `gh` until a PR exists. |
| Agent uses `--jq` or `--template` | Match conditions reject these flags. Passthrough to real `gh`. |
| Agent uses different `--json` field sets for the same branch/issue | Cached stdout is the exact response from the first call. If the first call had `--json number,url,title,...` and a later call asks for `--json number,url` only, the cached response has _more_ fields than requested — `gh` clients tolerate this. If the later call asks for fields _not_ in the cached response, it gets a response without those fields. This is a theoretical edge case — the D4 traces show agents use the same `--json` field set consistently. |
| Concurrent cache writes from parallel commands | Atomic write pattern: write to `$file.tmp.$$`, then `mv`. Same pattern used by existing metadata writes. |
| Clock skew (container, VM) | Only affects TTL accuracy. A few seconds of drift on a 300s TTL is negligible. |

---

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/agent-workspace-hooks.ts` | Add cache helpers to `AO_METADATA_HELPER`. Add read intercepts + cache-write-on-create to `GH_WRAPPER`. Bump `WRAPPER_VERSION`. |
| `packages/core/src/session-manager.ts` | Add `setupPathWrapperWorkspace()` call. Add `buildAgentPath()` + `GH_PATH` to all 3 environment sites. |
| `packages/core/src/metadata.ts` | Add `.ghcache` cleanup in `deleteMetadata()`. |
| `packages/plugins/agent-codex/src/index.ts` | Remove `buildAgentPath()`, `setupPathWrapperWorkspace()`, `GH_PATH` from plugin. |
| `packages/plugins/agent-aider/src/index.ts` | Same removal. |
| `packages/plugins/agent-opencode/src/index.ts` | Same removal. |
| `packages/plugins/agent-cursor/src/index.ts` | Same removal. |
| `packages/core/src/__tests__/agent-workspace-hooks.test.ts` | Tests for cache helpers, PR discovery intercept, issue context intercept, `gh pr create` cache population, passthrough on unsupported flags, TTL expiry. |

---

## Projected Impact

From the D4 10-session / 22-minute run (916 agent-side `gh` calls):

| Pattern | Before | After | Saved |
|---------|--------|-------|-------|
| `gh pr list --head` | 598 | ~10 | ~588 (98%) |
| `gh issue view` | 75 | ~20 | ~55 (73%) |
| **Subtotal (in scope)** | **673** | **~30** | **~643 (96%)** |
| Everything else (unchanged) | 243 | 243 | 0 |
| **Total** | **916** | **~273** | **~643 (70%)** |

The two intercepts eliminate ~70% of all agent-side `gh` traffic and ~96% of the traffic they target.
