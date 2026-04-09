#!/bin/bash
# churn-guard.sh — PreToolUse hook: block PR creation when open PRs already touch same files
# 8 PRs for metadata-updater.sh in 1hr on 2026-04-04 — 7 were wasted duplicates.
# Root cause: no file-level coordination gate at PR creation time.
#
# Intercepts: gh pr create, gh api repos/.../pulls --method POST, gh api .../pulls -f ...
# Checks: do any open PRs in the same repo touch files changed in the current branch?
# If overlap found: BLOCK with list of overlapping PRs.
# Override: include "Supersedes #N" in the PR body/command to bypass.
# Fail-open: if checks fail (no git, no gh, no python3, parse error), allow.

set -euo pipefail

# Fail open if python3 is missing
if ! command -v python3 &>/dev/null; then
  exit 0
fi

INPUT=$(cat)

# Only intercept Bash tool calls
TOOL=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_name', ''))
except Exception:
    print('')
" 2>/dev/null) || TOOL=""

if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

CMD=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('command', ''))
except Exception:
    print('')
" 2>/dev/null) || CMD=""

if [ -z "$CMD" ]; then
  exit 0
fi

# Detect PR creation commands
IS_PR_CREATE=$(echo "$CMD" | python3 -c "
import sys, re
cmd = sys.stdin.read()
# gh pr create
if re.search(r'\bgh\s+pr\s+create\b', cmd, re.IGNORECASE):
    print('YES')
    sys.exit(0)
# gh api with pulls collection endpoint (NOT /pulls/N/... nested paths)
has_gh_api = re.search(r'\bgh\s+api\b', cmd, re.IGNORECASE)
has_pulls_collection = re.search(r'repos/[^/]+/[^/]+/pulls(?!\s*/\d)(?:\s|\Z|[\x27\x22])', cmd, re.IGNORECASE)
if has_gh_api and has_pulls_collection:
    # Explicit POST: --method POST, --method=POST, -X POST, -X=POST
    if re.search(r'(?:--method|-X)[=\s]+POST', cmd, re.IGNORECASE):
        print('YES')
        sys.exit(0)
    # Implicit POST via field flags: -f, -F, --field, --raw-field (can appear anywhere)
    if re.search(r'(?:\s|^)(?:-[fF]\s|--field\s|--raw-field\s)', cmd):
        print('YES')
        sys.exit(0)
    # Implicit POST via --input
    if re.search(r'--input\s', cmd, re.IGNORECASE):
        print('YES')
        sys.exit(0)
print('NO')
" 2>/dev/null) || IS_PR_CREATE="NO"

if [ "$IS_PR_CREATE" != "YES" ]; then
  exit 0
fi

# Check for "Supersedes #N" override — only inside --body or -b payload, not the full command
HAS_SUPERSEDES=$(echo "$CMD" | python3 -c "
import sys, re
cmd = sys.stdin.read()
# Extract body content from --body '...' or --body \"...\" or -f body='...' or heredoc body
body = ''
# --body or -b flag with double-quoted value (supports --body=, --body , -b )
m = re.search(r'(?:--body|-b)[=\s]\x22((?:[^\x22\\\\]|\\.)*)\x22', cmd, re.DOTALL)
if m:
    body = m.group(1)
# --body or -b flag with single-quoted value (supports --body=, --body , -b )
if not body:
    m = re.search(r\"(?:--body|-b)[=\s]\x27([^\x27]*)\x27\", cmd, re.DOTALL)
    if m:
        body = m.group(1)
# -f body=... or --field body=... (double-quoted)
if not body:
    m = re.search(r'(?:-[fF]|--field)\s+body=\x22((?:[^\x22\\\\]|\\.)*)\x22', cmd, re.DOTALL)
    if m:
        body = m.group(1)
# -f body=... (single-quoted)
if not body:
    m = re.search(r\"(?:-[fF]|--field)\s+body=\x27([^\x27]*)\x27\", cmd, re.DOTALL)
    if m:
        body = m.group(1)
# heredoc: look for body content in EOF blocks
if not body:
    m = re.search(r'<<[\x27]?EOF[\x27]?\n(.*?)\nEOF', cmd, re.DOTALL)
    if m:
        body = m.group(1)
if re.search(r'supersedes\s*#\s*\d+', body, re.IGNORECASE):
    print('YES')
else:
    print('NO')
" 2>/dev/null) || HAS_SUPERSEDES="NO"

if [ "$HAS_SUPERSEDES" = "YES" ]; then
  exit 0
fi

# --- PR creation detected, no override — check for file overlap ---

# Get the repo (try --repo flag first, then git remote)
REPO=$(echo "$CMD" | python3 -c "
import sys, re
cmd = sys.stdin.read()
# Support: --repo VALUE, --repo=VALUE, -R VALUE
m = re.search(r'(?:--repo[=\s]|-R\s)(\S+)', cmd, re.IGNORECASE)
if m:
    print(m.group(1).rstrip('/'))
    sys.exit(0)
# Try repos/OWNER/REPO/pulls pattern
m = re.search(r'repos/([^/]+/[^/]+)/pulls', cmd)
if m:
    print(m.group(1))
    sys.exit(0)
print('')
" 2>/dev/null) || REPO=""

# Fall back to git remote
if [ -z "$REPO" ]; then
  REPO=$(git remote get-url origin 2>/dev/null | python3 -c "
import sys, re
url = sys.stdin.read().strip()
m = re.search(r'github\.com[/:]([\w-]+/[\w.-]+?)(?:\.git)?$', url)
if m:
    print(m.group(1))
else:
    print('')
" 2>/dev/null) || REPO=""
fi

if [ -z "$REPO" ]; then
  # Can't determine repo — fail open
  exit 0
fi

# Get files changed in current branch vs main
CHANGED_FILES=$(git diff --name-only origin/main...HEAD 2>/dev/null) || CHANGED_FILES=""

if [ -z "$CHANGED_FILES" ]; then
  # No changed files detected (maybe not in a git repo or on main) — fail open
  exit 0
fi

# Check open PRs for file overlap
OVERLAP=$(python3 - "$REPO" "$CHANGED_FILES" <<'PYEOF'
import sys, subprocess, json

repo = sys.argv[1]
my_files = set(sys.argv[2].strip().split('\n'))

try:
    import time
    # Global deadline: 50s total for the entire overlap check (hook timeout is 60s)
    global_deadline = time.monotonic() + 50

    # Get current branch to exclude our own PR
    branch_result = subprocess.run(
        ["git", "branch", "--show-current"],
        capture_output=True, text=True, timeout=5
    )
    my_branch = branch_result.stdout.strip() if branch_result.returncode == 0 else ""

    # Get current remote owner for cross-fork branch dedup
    remote_result = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        capture_output=True, text=True, timeout=5
    )
    import re as _re
    _m = _re.search(r'github\.com[/:]([^/]+)/', remote_result.stdout.strip()) if remote_result.returncode == 0 else None
    my_owner = _m.group(1) if _m else ""

    # List open PRs (with --paginate to get all pages)
    pr_list_timeout = max(5, int(global_deadline - time.monotonic() - 10))
    result = subprocess.run(
        ["gh", "api", f"repos/{repo}/pulls", "--paginate",
         "--jq", "[.[] | {number: .number, title: .title, branch: .head.ref, owner: (.head.repo.owner.login // \"\")}]"],
        capture_output=True, text=True, timeout=pr_list_timeout
    )

    if result.returncode != 0:
        print("OK")
        sys.exit(0)

    # --paginate outputs multiple JSON arrays; merge them
    prs = []
    for line in result.stdout.strip().split('\n'):
        line = line.strip()
        if line:
            try:
                prs.extend(json.loads(line))
            except json.JSONDecodeError:
                continue

    overlapping = []
    for pr in prs:
        # Skip our own branch (match both owner and branch to avoid cross-fork collisions)
        if pr.get("branch") == my_branch and (not my_owner or pr.get("owner") == my_owner):
            continue

        # Bail if approaching global deadline — fail open
        if time.monotonic() > global_deadline:
            break

        # Get files for this PR (with --paginate for PRs with many files)
        remaining = max(5, int(global_deadline - time.monotonic()))
        files_result = subprocess.run(
            ["gh", "api", f"repos/{repo}/pulls/{pr['number']}/files",
             "--paginate", "--jq", ".[].filename"],
            capture_output=True, text=True, timeout=remaining
        )

        if files_result.returncode != 0:
            continue

        pr_files = set(f for f in files_result.stdout.strip().split('\n') if f)
        common = my_files & pr_files

        if common:
            overlapping.append({
                "number": pr["number"],
                "title": pr["title"],
                "files": list(common)
            })

    if overlapping:
        lines = ["OVERLAP"]
        for o in overlapping:
            files_str = ", ".join(o["files"][:3])
            if len(o["files"]) > 3:
                files_str += f" (+{len(o['files'])-3} more)"
            lines.append(f"  PR #{o['number']}: {o['title']} — overlapping: {files_str}")
        print("\n".join(lines))
    else:
        print("OK")

except subprocess.TimeoutExpired:
    print("OK")  # fail open
except Exception:
    print("OK")  # fail open
PYEOF
) || OVERLAP="OK"

if echo "$OVERLAP" | grep -q "^OVERLAP"; then
  echo "" >&2
  echo "============================================" >&2
  echo "BLOCKED: File overlap with existing open PRs" >&2
  echo "" >&2
  echo "Your branch changes files that are already being modified by open PRs:" >&2
  echo "$OVERLAP" | tail -n +2 >&2
  echo "" >&2
  echo "To prevent churn (8 duplicate PRs for metadata-updater.sh on 2026-04-04):" >&2
  echo "  1. Check if the existing PR already covers your fix" >&2
  echo "  2. If yes: post your changes as a review comment on that PR instead" >&2
  echo "  3. If no: coordinate with the existing PR author" >&2
  echo "  4. Only create a new PR if the existing one is abandoned/stale (>24h no activity)" >&2
  echo "" >&2
  echo "To override: add 'Supersedes #<N>' to the PR body (--body flag)." >&2
  echo "============================================" >&2
  exit 2
fi

exit 0
