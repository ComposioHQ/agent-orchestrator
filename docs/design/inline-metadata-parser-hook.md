# Inline JavaScript Parser for Metadata Hook

## Problem Statement

The PostToolUse hook (`metadata-updater.sh`) uses regex patterns to detect GitHub and Git commands such as `gh pr create`, `git checkout -b`, etc. This approach fails when commands are prefixed with directory change operations:

```bash
cd /path/to/repo && gh pr create --title "My PR"
cd ~/.worktrees/project; git checkout -b feature-branch
```

The regex `^gh[[:space:]]+pr[[:space:]]+create` only matches commands starting at the beginning of the string, so it doesn't detect these patterns.

## Solution: Inline JavaScript Parser

Replace regex-based command detection with an inline JavaScript parser embedded in the bash script. This approach provides:

1. **Accurate command detection** - handles `&&`, `;`, and `||` command chaining
2. **No external dependencies** - parser is self-contained
3. **No file copying** - everything is in the bash script itself
4. **Maintainable** - structured JavaScript code instead of complex regex

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PostToolUse Hook                              │
│                   (metadata-updater.sh)                          │
│                                                                │
│  1. Receives: tool_name, command, output, exit_code            │
│  2. Validates: Bash tool, exit_code=0, AO_SESSION set        │
└────────────────────┬────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│           Inline JavaScript Parser (node -e)                      │
│                                                                │
│  Parses shell commands via simple tokenizer:                       │
│  - &&, ;, || (command chaining)                               │
│  - " and ' and \` (quotes)                                      │
│  - \\ (escapes)                                                  │
│                                                                │
│  Extracts: PR URLs, branch names, merge actions                    │
│                                                                │
│  Outputs: TYPE:value                                              │
│    - PR_CREATE:https://github.com/.../pull/123                   │
│    - BRANCH:feature-branch                                        │
│    - MERGE:                                                       │
│    - NONE                                                         │
└────────────────────┬────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│              Metadata Update Actions                               │
│                                                                │
│  - PR_CREATE: updates "pr" and "status=pr_open"                │
│  - BRANCH: updates "branch"                                    │
│  - MERGE: updates "status=merged"                               │
└─────────────────────────────────────────────────────────────────────┘
```

### File Structure

```
packages/plugins/agent-claude-code/
├── src/
│   ├── index.ts                    # Hook setup & script template with inline parser
│   └── index.test.ts               # Tests for hook script
├── dist/
│   └── index.js
└── package.json
```

No separate parser file is needed - everything is inline.

## Implementation Details

### Shell Command Tokenizer

The inline JavaScript parser implements a simple shell tokenizer:

```javascript
function parseCommands(str) {
  const commands = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  let i = 0;

  while (i < str.length) {
    const c = str[i];

    if (inQuote) {
      if (c === quoteChar && (i === 0 || str[i - 1] !== "\\")) {
        inQuote = false;
      }
      current += c;
    } else if (c === '"' || c === "'" || c === "`") {
      inQuote = true;
      quoteChar = c;
      current += c;
    } else if (c === "\\") {
      current += c + (str[i + 1] || "");
      i++;
    } else if (c === "&" && i + 1 < str.length && str[i + 1] === "&") {
      if (current.trim()) commands.push(current.trim());
      current = "";
      i++;
    } else if (c === ";" || c === "|" || c === "||") {
      if (current.trim()) commands.push(current.trim());
      current = "";
    } else {
      current += c;
    }
    i++;
  }

  if (current.trim()) commands.push(current.trim());
  return commands.map(cmd => cmd.split(/\s+/).filter(Boolean));
}
```

This correctly handles:
- `cd /path && gh pr create` → 2 separate commands
- `cd /path; gh pr create` → 2 separate commands
- `gh pr create &` → 1 command (background)

### Command Matching

The `matchCommand()` function matches command patterns:

```javascript
function matchCommand(words, output) {
  if (words.length === 0) return null;
  const [cmd, arg1, arg2, arg3] = words;

  if (cmd === "gh" && arg1 === "pr" && arg2 === "create") {
    const prUrl = extractPRUrl(output);
    return prUrl ? `PR_CREATE:${prUrl}` : "NONE";
  }

  if (cmd === "gh" && arg1 === "pr" && arg2 === "merge") {
    return "MERGE:";
  }

  if (cmd === "git" && arg1 === "checkout" && arg2 === "-b") {
    return `BRANCH:${arg3}`;
  }

  // ... more patterns
}
```

## Comparison: Regex vs Inline Parser

| Aspect | Regex Approach | Inline Parser |
|--------|----------------|---------------|
| `cd /path && gh pr create` | ❌ Fails | ✅ Works |
| `cd /path; gh pr create` | ❌ Fails | ✅ Works |
| `gh pr create &` | ⚠️ May work | ✅ Works |
| Paths with special chars | ⚠️ May break | ✅ Safe |
| Dependencies | None | None (inline) |
| File copying | None | None |
| Maintainability | Low (complex regex) | High (structured code) |
| Extensibility | Low (add new regex) | High (add new pattern) |

## Deployment

1. **Build**: TypeScript compiles `index.ts` → `dist/index.js`
2. **Setup**: `setupHookInWorkspace()` writes the script to `.claude/metadata-updater.sh`
3. **Runtime**: Hook script invokes parser via `node -e` with inline JavaScript

## Trade-offs

### Pros
- Robust command detection for common shell chaining patterns
- No external dependencies to manage or copy
- Self-contained - everything in one bash script
- Easy to debug and extend

### Cons
- Simplified tokenizer (doesn't handle all shell edge cases like subshells, pipelines)
- Still relies on Node.js at runtime (already available in AO environment)

## References

- Issue: #324
- PR: https://github.com/ComposioHQ/agent-orchestrator/pull/609
