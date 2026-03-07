# ao-bus Agent Toolkit

You are part of a coordinated team of agents working on a shared codebase. Use these commands to communicate with other agents and the phase engine.

## Status Commands

```bash
ao-status done                           # Report your phase work as complete
ao-status working --file src/auth.ts     # Report what you're working on
```

## Message Commands

```bash
ao-msg <to> "<content>"                  # Send a message to another agent
ao-msg reviewer "ready for review"       # Example: notify reviewer
ao-msg driver "fix auth.ts:42" --type revision_request --priority high
ao-inbox                                 # Read messages addressed to you
ao-inbox --from reviewer                 # Filter by sender
ao-inbox --since 5                       # Messages after sequence number 5
```

## Context Commands

```bash
ao-context                               # Your role, phase, file scope
ao-context --files                       # Your assigned files (exclusive write)
ao-context --criteria                    # Acceptance criteria from plan
ao-context --shared                      # Shared files (read-only in implement)
```

## Lock Commands

```bash
ao-lock src/auth.ts                      # Acquire advisory lock on a file
ao-unlock src/auth.ts                    # Release lock
```

## Artifact Commands

```bash
echo "report content" | ao-artifact write review-report.md   # Write artifact (from stdin)
ao-artifact read test-results.json                            # Read artifact (to stdout)
```

## Plan Commands (Planner only)

```bash
ao-plan init "Brief task summary"        # Initialize plan
ao-plan add-unit --id wu-1 \
  --desc "Implement auth middleware" \
  --assigned-to driver \
  --files src/middleware/auth.ts,src/types/auth.ts \
  --criteria "Auth middleware validates JWT tokens"  # Add work unit
ao-plan shared-files src/index.ts        # Declare shared files
ao-plan finalize                         # Validate and write plan.json
ao-plan show                             # Display current plan
```

## Learning Commands

```bash
ao-learn convention "barrel exports required in src/modules/"
ao-learn pitfall "pnpm typecheck fails on direct module imports"
ao-learn decision "Zod over io-ts for runtime validation"
```

## Refine Commands (Refine phase only)

```bash
ao-refine add convention "new pattern to follow"
ao-refine remove pitfall "old entry" --reason "fixed in wu-3"
ao-refine update decision "Zod over io-ts" --append "confirmed in auth module"
ao-refine confirm pitfall "entry to keep"
```

## Important Rules

1. **Only modify your assigned files.** Use `ao-context --files` to check scope.
2. **Shared files are read-only during implement.** Only modify them during integrate.
3. **Always report `ao-status done` when your phase work is complete.**
4. **Check `ao-inbox` for messages from other agents before starting work.**
5. **Use `ao-learn` to record patterns and pitfalls you discover.**
